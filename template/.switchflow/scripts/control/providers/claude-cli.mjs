import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const READ_ONLY_GIT = [
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'branch --show-current',
  'worktree list',
];
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;
const SAFE_EFFORT = /^[a-z]{2,10}$/;

/**
 * The npm shim (claude.cmd) cannot be spawned without a shell on Windows (EINVAL), and a shell
 * would re-quote JSON arguments. Spawn the native executable it wraps instead.
 */
export function claudeExecutable({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'win32') {
    const candidates = [
      env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      env.USERPROFILE && path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'),
    ].filter(Boolean);
    return candidates.find(candidate => exists(candidate)) || null;
  }
  return 'claude';
}

/** Bash patterns a role may run without a prompt. Everything else is denied (no prompt host). */
export function bashAllowlist({ write, gitHelperPath }) {
  const rules = [];
  for (const command of READ_ONLY_GIT) rules.push(`Bash(git ${command})`, `Bash(git ${command} *)`);
  // Switchflow wrappers. Reviewers may only read through them.
  const wrappers = write
    ? ['.switchflow/scripts/*']
    : ['.switchflow/scripts/backlog.ps1 task view *', '.switchflow/scripts/backlog.ps1 doc view *'];
  for (const wrapper of wrappers)
    for (const shell of ['powershell -NoProfile -ExecutionPolicy Bypass -File', 'pwsh -NoProfile -File'])
      rules.push(`Bash(${shell} ${wrapper})`, `Bash(${shell} ./${wrapper})`);
  if (write) rules.push('Bash(node .switchflow/scripts/*)', 'Bash(node ./.switchflow/scripts/*)');
  if (write && gitHelperPath) rules.push(`Bash(node ${gitHelperPath.replaceAll('\\', '/')} *)`);
  return rules;
}

export function claudeArguments({
  sessionId,
  sandbox,
  writableRoots = [],
  temporaryRoot,
  model,
  effort,
  maxTurns,
  outputSchema,
  instructions,
  mcpConfigPath,
  gitHelperPath,
}) {
  const roots = validatePolicy({ sandbox, writableRoots, temporaryRoot });
  const write = sandbox === 'workspace-write';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new Error('Invalid Claude session ID');
  if (model && !SAFE_MODEL.test(model)) throw new Error('Invalid Claude model name');
  if (effort && !SAFE_EFFORT.test(effort)) throw new Error('Invalid Claude effort');
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) throw new Error('Invalid Claude turn limit');
  const tools = [...READ_TOOLS, ...(write ? WRITE_TOOLS : []), 'Bash'];
  const allowed = [...READ_TOOLS, ...bashAllowlist({ write, gitHelperPath })];
  if (mcpConfigPath) allowed.push('mcp__switchflow');
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    // Ignores user/project/local settings, confines file tools to the working directories,
    // refuses bypassPermissions and drops command tools unless --tools names them.
    '--restricted',
    '--strict-mcp-config',
    // Nobody answers prompts: anything not pre-approved below is denied.
    '--permission-prompts',
    'none',
    '--permission-mode',
    write ? 'acceptEdits' : 'dontAsk',
    '--tools',
    tools.join(','),
    '--allowedTools',
    ...allowed,
    '--disallowedTools',
    'WebFetch',
    'WebSearch',
    '--session-id',
    sessionId,
    '--no-session-persistence',
    '--max-turns',
    String(maxTurns),
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (outputSchema) args.push('--json-schema', JSON.stringify(outputSchema));
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (instructions) args.push('--append-system-prompt', instructions);
  for (const root of roots) args.push('--add-dir', root);
  if (args.some(arg => /bypassPermissions|dangerously/i.test(arg))) throw new Error('Unsafe Claude permission flag');
  return args;
}

function usageFrom(previous, result) {
  const u = result?.usage || {};
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const next = {
    inputTokens: previous.inputTokens + input,
    cachedInputTokens: previous.cachedInputTokens + (u.cache_read_input_tokens ?? 0),
    outputTokens: previous.outputTokens + (u.output_tokens ?? 0),
    reasoningOutputTokens: 0,
    totalTokens: previous.totalTokens + input + (u.output_tokens ?? 0),
    costUsd:
      typeof result?.total_cost_usd === 'number' ? (previous.costUsd ?? 0) + result.total_cost_usd : previous.costUsd,
  };
  return next;
}

function toolEvent(block) {
  const input = block.input || {};
  if (block.name === 'Bash') return { kind: 'command', command: oneLine(input.command, 2000), status: 'started' };
  if (WRITE_TOOLS.includes(block.name) && (input.file_path || input.notebook_path))
    return { kind: 'file_change', paths: [input.file_path || input.notebook_path], status: 'requested' };
  return { kind: 'tool', name: block.name, summary: oneLine(input.file_path || input.pattern || input.path || input) };
}

/**
 * Drives the installed Claude Code CLI in stream-json mode. The process starts with the first
 * turn because --json-schema is fixed per process; later turns must use the same schema.
 */
export async function openClaudeSession({
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
  onProcess = async () => {},
  signal,
  mcpConfigPath,
  gitHelperPath,
  rawLogPath,
  executable = claudeExecutable(),
  spawnProcess = spawn,
  settleMs = 3000,
}) {
  const timeoutMs = limits.timeoutMs ?? 60 * 60 * 1000;
  const maxTurns = limits.maxTurns ?? 200;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000)
    throw new Error('Invalid run timeout');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Session working directory must be absolute');
  if (!executable) throw new Error('Claude Code is not installed');
  if (signal?.aborted) throw new Error('Agent session cancelled');
  validatePolicy({ sandbox, writableRoots, temporaryRoot });
  const sessionId = randomUUID();
  const raw = await openRawLog(rawLogPath);
  let child = null;
  let schemaKey;
  let closed = false;
  let failure = null;
  let active = null; // { id, unreplayed, resolve, reject, interrupting, lastText, settleTimer }
  let usage = emptyUsage();
  let heldMessage = null;
  let events = Promise.resolve();
  let closedPromise = Promise.resolve();
  let readers = [];
  let timer;
  const emit = event => {
    // A host that cannot record events must not keep an unobserved agent running.
    events = events
      .then(() => onEvent(event))
      .catch(error => {
        fail(error);
        void close();
      });
    return events;
  };
  const flushMessage = final => {
    if (!heldMessage) return;
    const text = heldMessage;
    heldMessage = null;
    void emit({ kind: 'message', text, final });
  };
  const write = message => {
    if (!child || closed || !child.stdin.writable) throw new Error('Claude session is closed');
    void raw.write('>', message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const userMessage = (text, priority) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    ...(priority ? { priority } : {}),
  });
  const fail = error => {
    failure ??= error;
    if (active) {
      const turn = active;
      active = null;
      clearTimeout(turn.settleTimer);
      flushMessage(false);
      void emit({ kind: 'turn.failed', turnId: turn.id, error: error.message });
      turn.reject(error);
    }
  };
  const completeTurn = result => {
    const turn = active;
    if (!turn) return;
    active = null;
    clearTimeout(turn.settleTimer);
    if (turn.interrupting) {
      flushMessage(false);
      void emit({ kind: 'turn.completed', turnId: turn.id, status: 'interrupted', usage });
      turn.reject(new TurnInterruptedError());
      return;
    }
    if (result.is_error || result.subtype !== 'success') {
      flushMessage(false);
      const reason = result.terminal_reason || result.subtype || 'error';
      const message = `Claude reported ${reason}: ${oneLine(result.result ?? result.errors ?? '', 500)}`;
      void emit({ kind: 'turn.failed', turnId: turn.id, error: message });
      turn.reject(new Error(message));
      return;
    }
    const text = typeof result.result === 'string' ? result.result : '';
    if (heldMessage) flushMessage(true);
    else if (text) void emit({ kind: 'message', text, final: true });
    void emit({ kind: 'turn.completed', turnId: turn.id, status: 'completed', usage });
    let structured = null;
    if (turn.outputSchema) {
      structured = result.structured_output ?? null;
      if (structured === null) {
        try {
          structured = JSON.parse(text);
        } catch {
          turn.reject(new Error('Claude returned no structured output'));
          return;
        }
      }
    }
    turn.resolve({ turnId: turn.id, text, result: structured, usage });
  };
  const onLine = async line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      void raw.write('<!', line);
      return;
    }
    if (message.type !== 'stream_event') void raw.write('<', message);
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init')
          await emit({
            kind: 'session.started',
            provider: 'claude',
            transport: 'cli',
            threadId: message.session_id ?? sessionId,
            pid: child?.pid ?? null,
            model: message.model ?? model ?? null,
          });
        return;
      case 'assistant': {
        if (message.error) await emit({ kind: 'notice', level: 'error', text: oneLine(message.error) });
        for (const block of message.message?.content || []) {
          if (block.type === 'text' && block.text) {
            flushMessage(false);
            heldMessage = block.text;
          } else if (block.type === 'tool_use') {
            flushMessage(false);
            await emit(toolEvent(block));
          }
        }
        return;
      }
      case 'user':
        if (message.isReplay && active && active.unreplayed > 0) active.unreplayed--;
        return;
      case 'result':
        usage = usageFrom(usage, message);
        if (!active) return;
        if (Array.isArray(message.permission_denials) && message.permission_denials.length)
          await emit({
            kind: 'notice',
            level: 'warning',
            text: `Denied: ${oneLine(message.permission_denials.map(d => d.tool_name).join(', '))}`,
          });
        clearTimeout(active.settleTimer);
        // A steer queued behind this reply produces its own result. Wait for it.
        if (active.unreplayed > 0 && !active.interrupting && !message.is_error) {
          const turn = active;
          turn.settleTimer = setTimeout(() => {
            if (active === turn) completeTurn(message);
          }, settleMs);
          return;
        }
        completeTurn(message);
        return;
      case 'control_request':
        // --permission-prompts none should prevent these. Deny anything that still arrives.
        write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: { behavior: 'deny', message: 'Switchflow denies tools outside the role allowlist.' },
          },
        });
        await emit({ kind: 'notice', level: 'warning', text: `Denied ${message.request?.tool_name || 'request'}.` });
        return;
      default:
    }
  };
  const start = outputSchema => {
    schemaKey = JSON.stringify(outputSchema ?? null);
    const args = claudeArguments({
      sessionId,
      sandbox,
      writableRoots,
      temporaryRoot,
      model,
      effort,
      maxTurns,
      outputSchema,
      instructions,
      mcpConfigPath,
      gitHelperPath,
    });
    child = spawnProcess(executable, args, {
      cwd: path.resolve(cwd),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment(temporaryRoot, { CLAUDE_CODE_ENTRYPOINT: 'switchflow' }),
    });
    closedPromise = new Promise(resolve => {
      child.once('error', error => fail(error));
      child.once('close', code => {
        closed = true;
        fail(new Error(`Claude exited with code ${code}`));
        resolve(code);
      });
    });
    child.stdin.on('error', error => fail(error));
    readers = [
      readLines(child.stdout, onLine).catch(error => {
        fail(error);
        void stopTree(child);
      }),
      readLines(child.stderr, text => {
        const clean = stripAnsi(text).trim();
        if (clean) void emit({ kind: 'stderr', text: oneLine(clean, 2000) });
      }).catch(() => {}),
    ];
  };
  let closing;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (child && !closed) {
        try {
          child.stdin.end();
        } catch {}
        await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
        if (!closed) await stopTree(child);
      }
      await closedPromise;
      await Promise.allSettled(readers);
      fail(new Error('Agent session closed'));
      await emit({ kind: 'session.closed' });
      await events;
      await raw.close();
    })();
    return closing;
  };
  const abort = () => {
    fail(new Error('Agent session cancelled'));
    void close();
  };
  timer = setTimeout(() => {
    fail(new Error('Agent session timed out'));
    void close();
  }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });

  return {
    id,
    provider: 'claude',
    transport: 'cli',
    get pid() {
      return child?.pid ?? null;
    },
    threadId: sessionId,
    get activeTurnId() {
      return active?.id ?? null;
    },
    get closed() {
      return closed || Boolean(closing);
    },
    async startTurn(text, { outputSchema } = {}) {
      validatePrompt(text);
      if (failure && child) throw failure;
      if (closing) throw new Error('Claude session is closed');
      if (active) throw new Error('A turn is already running in this session');
      if (!child) {
        start(outputSchema);
        // The host records the PID before any input reaches the process.
        try {
          await onProcess(child.pid ?? null);
        } catch (error) {
          fail(error);
          await close();
          throw error;
        }
      } else if (JSON.stringify(outputSchema ?? null) !== schemaKey)
        throw new Error('A Claude session keeps the output schema of its first turn');
      const turnId = randomUUID();
      const done = new Promise((resolve, reject) => {
        active = { id: turnId, unreplayed: 1, resolve, reject, outputSchema };
      });
      await emit({ kind: 'turn.started', turnId });
      write(userMessage(text));
      return done;
    },
    async steer(text, { expectedTurnId, by = 'owner' } = {}) {
      validatePrompt(text);
      if (!active || (expectedTurnId && expectedTurnId !== active.id))
        throw Object.assign(new Error('No active turn to steer'), { code: 409 });
      active.unreplayed++;
      // "next": read inside the running turn once its current tools finish (Agent SDK semantics).
      write(userMessage(text, 'next'));
      await emit({ kind: 'steer', text, by, mode: 'steer', turnId: active.id });
      return { turnId: active.id };
    },
    async interrupt({ by = 'owner' } = {}) {
      if (!active) return false;
      const turn = active;
      turn.interrupting = true;
      await emit({ kind: 'interrupt', by, turnId: turn.id });
      write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
      // If no result follows, end the process: an unacknowledged interrupt must still stop work.
      setTimeout(() => {
        if (active === turn) {
          fail(new TurnInterruptedError());
          void close();
        }
      }, 15000).unref?.();
      return true;
    },
    close,
  };
}
