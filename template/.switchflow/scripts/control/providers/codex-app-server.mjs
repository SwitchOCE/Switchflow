import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TurnInterruptedError,
  childEnvironment,
  emptyUsage,
  oneLine,
  openRawLog,
  readLines,
  stopTree,
  stripAnsi,
  validatePolicy,
  validatePrompt,
} from './process.mjs';

const CLIENT = { name: 'switchflow', title: 'Switchflow', version: '1' };
// Notifications the host never shows. Fewer messages, same protocol.
const QUIET = [
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'remoteControl/status/changed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/plan/delta',
];
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Raised when app-server cannot complete its initialize handshake; callers may fall back to exec. */
export class HandshakeError extends Error {
  constructor(message) {
    super(message);
    this.handshake = true;
  }
}

/**
 * Process-wide overrides. They repeat codexArguments() so the user's config.toml cannot
 * loosen approval, sandbox, writable roots, temp access or the notify hook.
 */
export function codexAppServerArguments({ sandbox = 'workspace-write', writableRoots = [], temporaryRoot } = {}) {
  const roots = validatePolicy({ sandbox, writableRoots, temporaryRoot });
  const args = ['app-server', '-c', 'notify=[]', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandbox}"`];
  args.push(
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
  );
  if (temporaryRoot)
    for (const name of ['TMP', 'TEMP', 'TMPDIR'])
      args.push('-c', `shell_environment_policy.set.${name}=${JSON.stringify(temporaryRoot)}`);
  return args;
}

export function sandboxPolicy({ sandbox, writableRoots = [], temporaryRoot }) {
  const roots = validatePolicy({ sandbox, writableRoots, temporaryRoot });
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  return {
    type: 'workspaceWrite',
    writableRoots: roots,
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

/** Explicit per-thread policy. approvalsReviewer "user" keeps a user default of auto_review from applying. */
export function threadStartParams({
  cwd,
  sandbox,
  writableRoots = [],
  temporaryRoot,
  model,
  effort,
  instructions,
  mcpServers = {},
  disabledMcpServers = [],
}) {
  const roots = validatePolicy({ sandbox, writableRoots, temporaryRoot });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Session working directory must be absolute');
  const servers = {};
  for (const name of disabledMcpServers) if (SAFE_NAME.test(name)) servers[name] = { enabled: false };
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!SAFE_NAME.test(name)) throw new Error('Invalid MCP server name');
    servers[name] = {
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      enabled: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    };
  }
  const config = {
    notify: [],
    sandbox_workspace_write: {
      writable_roots: roots,
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    },
    ...(effort ? { model_reasoning_effort: effort } : {}),
    ...(Object.keys(servers).length ? { mcp_servers: servers } : {}),
  };
  return {
    cwd,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox,
    ...(model ? { model } : {}),
    ...(instructions ? { developerInstructions: instructions } : {}),
    config,
    serviceName: 'switchflow',
  };
}

const textInput = text => [{ type: 'text', text, text_elements: [] }];
function usageFrom(total) {
  if (!total) return emptyUsage();
  return {
    inputTokens: total.inputTokens ?? 0,
    cachedInputTokens: total.cachedInputTokens ?? 0,
    outputTokens: total.outputTokens ?? 0,
    reasoningOutputTokens: total.reasoningOutputTokens ?? 0,
    totalTokens: total.totalTokens ?? 0,
    costUsd: null,
  };
}

/**
 * Opens one Codex thread over `codex app-server` (JSON-RPC over stdio, no "jsonrpc" field).
 * Events are normalized; see docs/browser-control.md "Agents API".
 */
export async function openCodexSession({
  id = randomUUID(),
  cwd,
  sandbox = 'workspace-write',
  writableRoots = [],
  temporaryRoot,
  instructions,
  model,
  effort,
  limits = {},
  onEvent = () => {},
  signal,
  mcpServers = {},
  rawLogPath,
  executable = 'codex',
  spawnProcess = spawn,
  handshakeTimeoutMs = 30000,
  isolateUserMcp = true,
}) {
  const timeoutMs = limits.timeoutMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000)
    throw new Error('Invalid run timeout');
  if (signal?.aborted) throw new Error('Agent session cancelled');
  const args = codexAppServerArguments({ sandbox, writableRoots, temporaryRoot });
  const policy = sandboxPolicy({ sandbox, writableRoots, temporaryRoot });
  const raw = await openRawLog(rawLogPath);
  const child = spawnProcess(executable, args, {
    cwd: path.resolve(cwd),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(temporaryRoot),
  });
  let nextId = 0;
  const pending = new Map();
  let closed = false;
  let exitError = null;
  let threadId = null;
  let active = null; // { id, finals: [], messages: [], resolve, reject, interrupting }
  const early = new Map(); // turn/completed that raced the turn/start response
  let usage = emptyUsage();
  let timer;
  let events = Promise.resolve();
  const emit = event => {
    // A host that cannot record events must not keep an unobserved agent running.
    events = events
      .then(() => onEvent(event))
      .catch(error => {
        failAll(error);
        void close();
      });
    return events;
  };
  const send = message => {
    if (closed || !child.stdin.writable) throw new Error('Codex session is closed');
    void raw.write('>', message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params, timeout = 0) =>
    new Promise((resolve, reject) => {
      const requestId = ++nextId;
      let timer;
      pending.set(requestId, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (timeout)
        timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Codex ${method} timed out`));
        }, timeout);
      try {
        send(params === undefined ? { method, id: requestId } : { method, id: requestId, params });
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  const failAll = error => {
    exitError ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    if (active) {
      const turn = active;
      active = null;
      void emit({ kind: 'turn.failed', turnId: turn.id, error: error.message });
      turn.reject(error);
    }
  };
  const finishTurn = turn => {
    const status = turn.status;
    if (active?.id === turn.id) active = null;
    const pendingTurn = turn.waiter;
    if (!pendingTurn) return;
    if (status === 'completed') {
      const final = pendingTurn.finals.at(-1) ?? pendingTurn.messages.at(-1) ?? '';
      void emit({ kind: 'turn.completed', turnId: turn.id, status, usage });
      pendingTurn.resolve({ turnId: turn.id, text: final, usage });
    } else if (status === 'interrupted') {
      void emit({ kind: 'turn.completed', turnId: turn.id, status, usage });
      pendingTurn.reject(new TurnInterruptedError());
    } else {
      const message = turn.error?.message || `Codex turn ${status}`;
      void emit({ kind: 'turn.failed', turnId: turn.id, error: message });
      pendingTurn.reject(new Error(`Codex reported turn.failed: ${message}`));
    }
  };
  const onItem = async (item, completed) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'agentMessage' && completed && typeof item.text === 'string' && item.text) {
      const final = item.phase === 'final_answer';
      if (active) (final ? active.finals : active.messages).push(item.text);
      await emit({ kind: 'message', text: item.text, final, phase: item.phase ?? null });
    } else if (item.type === 'commandExecution') {
      await emit({
        kind: 'command',
        command: oneLine(item.command, 2000),
        status: completed ? item.status : 'started',
        exitCode: completed ? (item.exitCode ?? null) : null,
      });
    } else if (item.type === 'fileChange' && completed) {
      await emit({
        kind: 'file_change',
        paths: (item.changes || []).map(change => change.path).slice(0, 200),
        status: item.status ?? null,
      });
    } else if (item.type === 'mcpToolCall' && completed) {
      await emit({ kind: 'tool', name: `${item.server}/${item.tool}`, summary: oneLine(item.arguments) });
    } else if (['webSearch', 'dynamicToolCall'].includes(item.type) && completed) {
      await emit({ kind: 'tool', name: item.type, summary: oneLine(item.query ?? item.tool ?? '') });
    }
  };
  const onNotification = async ({ method, params = {} }) => {
    if (params.threadId && threadId && params.threadId !== threadId) return;
    switch (method) {
      case 'turn/started':
        return emit({ kind: 'turn.started', turnId: params.turn?.id });
      case 'item/started':
        return onItem(params.item, false);
      case 'item/completed':
        return onItem(params.item, true);
      case 'thread/tokenUsage/updated':
        usage = usageFrom(params.tokenUsage?.total);
        return;
      case 'turn/completed': {
        const turn = params.turn || {};
        if (active?.id === turn.id) finishTurn({ ...turn, waiter: active });
        else early.set(turn.id, turn);
        return;
      }
      case 'error':
        if (!params.willRetry)
          return emit({ kind: 'notice', level: 'error', text: oneLine(params.error?.message || 'Codex error', 2000) });
        return;
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
        return emit({
          kind: 'notice',
          level: 'warning',
          text: oneLine(params.message || params.summary || method, 2000),
        });
      default:
    }
  };
  const onServerRequest = message => {
    // approval_policy=never means approvals should never arrive. If one does, decline it.
    const method = String(message.method);
    if (/requestApproval$/.test(method) && method !== 'item/permissions/requestApproval') {
      send({ id: message.id, result: { decision: 'decline' } });
    } else send({ id: message.id, error: { code: -32000, message: 'Switchflow declines interactive requests.' } });
    void emit({ kind: 'notice', level: 'warning', text: `Declined ${method}.` });
  };
  const closedPromise = new Promise(resolve => {
    child.once('error', error => failAll(error));
    child.once('close', code => {
      closed = true;
      failAll(new Error(`Codex app-server exited with code ${code}`));
      resolve(code);
    });
  });
  child.stdin.on('error', error => failAll(error));
  const stdout = readLines(child.stdout, async line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      void raw.write('<!', line);
      return;
    }
    if (!(message.method && /Delta$/.test(message.method))) void raw.write('<', message);
    if (message.id !== undefined && message.method) return onServerRequest(message);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || 'Codex request failed');
        error.code = message.error.code;
        entry.reject(error);
      } else entry.resolve(message.result);
      return;
    }
    if (message.method) await onNotification(message);
  }).catch(error => {
    failAll(error);
    void stopTree(child);
  });
  const stderr = readLines(child.stderr, line => {
    const text = stripAnsi(line).trim();
    if (text) void emit({ kind: 'stderr', text: oneLine(text, 2000) });
  }).catch(() => {});

  let closing;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        if (!closed) child.stdin.end();
      } catch {}
      await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
      if (!closed) await stopTree(child);
      await closedPromise;
      await Promise.allSettled([stdout, stderr]);
      await emit({ kind: 'session.closed' });
      await events;
      await raw.close();
    })();
    return closing;
  };
  const abort = () => {
    failAll(new Error('Agent session cancelled'));
    void close();
  };
  timer = setTimeout(() => {
    failAll(new Error('Agent session timed out'));
    void close();
  }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await request(
      'initialize',
      {
        clientInfo: CLIENT,
        capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: QUIET },
      },
      handshakeTimeoutMs,
    );
    send({ method: 'initialized' });
  } catch (error) {
    await close();
    throw new HandshakeError(`Codex app-server handshake failed: ${error.message}`);
  }
  try {
    let disabledMcpServers = [];
    if (isolateUserMcp) {
      // User MCP servers can reach live services; runs get only the servers Switchflow supplies.
      try {
        const { config } = await request('config/read', { includeLayers: false, cwd }, 15000);
        disabledMcpServers = Object.keys(config?.mcp_servers || {}).filter(name => !(name in mcpServers));
      } catch (error) {
        await emit({ kind: 'notice', level: 'warning', text: `Could not list user MCP servers: ${error.message}` });
      }
    }
    const started = await request(
      'thread/start',
      threadStartParams({
        cwd,
        sandbox,
        writableRoots,
        temporaryRoot,
        model,
        effort,
        instructions,
        mcpServers,
        disabledMcpServers,
      }),
      60000,
    );
    threadId = started?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex did not return a thread ID');
    if (started.approvalPolicy !== 'never' || started.sandbox?.type === 'dangerFullAccess')
      throw new Error('Codex did not accept the Switchflow sandbox policy');
    await emit({
      kind: 'session.started',
      provider: 'codex',
      transport: 'app-server',
      threadId,
      pid: child.pid ?? null,
      model: started.model ?? model ?? null,
    });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    id,
    provider: 'codex',
    transport: 'app-server',
    pid: child.pid ?? null,
    get threadId() {
      return threadId;
    },
    get activeTurnId() {
      return active?.id ?? null;
    },
    get closed() {
      return closed || Boolean(closing);
    },
    async startTurn(text, { outputSchema } = {}) {
      validatePrompt(text);
      if (exitError) throw exitError;
      if (active) throw new Error('A turn is already running in this session');
      const waiter = { finals: [], messages: [] };
      const done = new Promise((resolve, reject) => Object.assign(waiter, { resolve, reject }));
      // Reserve the slot before awaiting so a concurrent call cannot start a second turn.
      active = Object.assign(waiter, { id: null });
      let response;
      try {
        response = await request('turn/start', {
          threadId,
          input: textInput(text),
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandboxPolicy: policy,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(outputSchema ? { outputSchema } : {}),
        });
      } catch (error) {
        if (active === waiter) active = null;
        throw error;
      }
      const turnId = response?.turn?.id;
      if (!turnId) {
        if (active === waiter) active = null;
        throw new Error('Codex did not return a turn ID');
      }
      waiter.id = turnId;
      if (early.has(turnId)) {
        finishTurn({ ...early.get(turnId), waiter });
        early.delete(turnId);
      }
      const outcome = await done;
      let result = null;
      if (outputSchema) {
        try {
          result = JSON.parse(outcome.text);
        } catch {
          throw new Error('Codex returned malformed structured output');
        }
      }
      return { ...outcome, result };
    },
    async steer(text, { expectedTurnId, by = 'owner' } = {}) {
      validatePrompt(text);
      const turnId = expectedTurnId ?? active?.id;
      if (!active?.id || turnId !== active.id) throw Object.assign(new Error('No active turn to steer'), { code: 409 });
      await request('turn/steer', { threadId, expectedTurnId: turnId, input: textInput(text) }, 30000);
      await emit({ kind: 'steer', text, by, turnId });
      return { turnId };
    },
    async interrupt({ by = 'owner' } = {}) {
      if (!active?.id) return false;
      active.interrupting = true;
      await emit({ kind: 'interrupt', by, turnId: active.id });
      try {
        await request('turn/interrupt', { threadId, turnId: active.id }, 30000);
      } catch (error) {
        // The turn may have completed in the meantime; that is not an error.
        if (!/no active turn/i.test(error.message)) throw error;
      }
      return true;
    },
    close,
  };
}
