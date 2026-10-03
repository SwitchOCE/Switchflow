import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from '../operations/storage.mjs';
import { ControlError, event, now } from './lifecycle.mjs';
import { startCodexRun } from './codex-runner.mjs';
import { openCodexSession } from './providers/codex-app-server.mjs';
import { openClaudeSession } from './providers/claude-cli.mjs';
import { oneLine } from './providers/process.mjs';
import { AgentSessionRegistry } from './agent-sessions.mjs';
import {
  ROLES,
  normalizeCapabilities,
  readAgentSettings,
  resolveProvider,
  writeAgentSettings,
} from './agent-settings.mjs';

export const defaultProviders = Object.freeze({ codex: openCodexSession, claude: openClaudeSession });
const MAX_STEER = 20000;

/** Maps `codex exec --json` events into the normalized session vocabulary. */
export function normalizeExecEvent(entry) {
  const item = entry.item || {};
  switch (entry.type) {
    case 'runner.started':
      return { kind: 'session.started', provider: 'codex', transport: 'exec', pid: entry.pid ?? null, threadId: null };
    case 'thread.started':
      return { kind: 'session.started', provider: 'codex', transport: 'exec', threadId: entry.thread_id ?? null };
    case 'turn.started':
      return { kind: 'turn.started', turnId: null };
    case 'turn.completed': {
      const u = entry.usage || {};
      return {
        kind: 'turn.completed',
        turnId: null,
        status: 'completed',
        usage: {
          inputTokens: u.input_tokens ?? 0,
          cachedInputTokens: u.cached_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          reasoningOutputTokens: 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          costUsd: null,
        },
      };
    }
    case 'turn.failed':
    case 'error':
      return { kind: 'turn.failed', turnId: null, error: oneLine(entry.error ?? entry.message ?? entry.type, 2000) };
    case 'runner.stderr':
      return { kind: 'stderr', text: oneLine(entry.text, 2000) };
    case 'item.started':
    case 'item.completed':
      if (item.type === 'agent_message' && entry.type === 'item.completed' && item.text)
        return { kind: 'message', text: item.text, final: false };
      if (item.type === 'command_execution')
        return {
          kind: 'command',
          command: oneLine(item.command, 2000),
          status: entry.type === 'item.started' ? 'started' : (item.status ?? 'completed'),
          exitCode: item.exit_code ?? null,
        };
      if (item.type === 'file_change' && entry.type === 'item.completed')
        return { kind: 'file_change', paths: (item.changes || []).map(c => c.path), status: item.status ?? null };
      if (item.type === 'mcp_tool_call' && entry.type === 'item.completed')
        return { kind: 'tool', name: `${item.server}/${item.tool}`, summary: oneLine(item.arguments ?? '') };
      return null;
    default:
      return null;
  }
}

/**
 * `codex exec` behind the session interface: one process per turn, resumed by thread ID for
 * follow-ups. It cannot steer, so the registry reports canSteer:false.
 */
function openExecSession({
  cwd,
  sandbox,
  writableRoots,
  temporaryRoot,
  limits,
  onEvent,
  signal,
  runDirectory,
  execRunner,
  executable,
}) {
  let threadId = null;
  let active = null;
  let turns = 0;
  let closed = false;
  return {
    provider: 'codex',
    transport: 'exec',
    canSteer: false,
    get threadId() {
      return threadId;
    },
    get activeTurnId() {
      return active ? 'exec' : null;
    },
    get closed() {
      return closed;
    },
    async startTurn(text, { schemaPath }) {
      if (active) throw new Error('A turn is already running in this session');
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      active = controller;
      const directory = turns++ === 0 ? runDirectory : path.join(runDirectory, `turn-${turns}`);
      try {
        await onEvent({ kind: 'turn.started', turnId: null });
        const result = await execRunner({
          projectRoot: cwd,
          runDirectory: directory,
          prompt: text,
          schemaPath,
          signal: controller.signal,
          resumeThreadId: threadId ?? undefined,
          sandboxMode: sandbox,
          additionalWritableRoots: sandbox === 'read-only' ? [] : writableRoots,
          temporaryRoot,
          timeoutMs: limits.timeoutMs,
          ...(executable ? { executable } : {}),
          onEvent: async entry => {
            if (entry.type === 'thread.started') threadId = entry.thread_id;
            const normalized = normalizeExecEvent(entry);
            if (normalized) await onEvent(normalized);
          },
        });
        threadId = result.threadId;
        return { turnId: null, result: result.result, text: '', exitCode: result.exitCode };
      } catch (error) {
        if (controller.signal.aborted && active?.interrupting && !signal?.aborted)
          throw Object.assign(new Error('The turn was interrupted.'), { interrupted: true });
        throw error;
      } finally {
        signal?.removeEventListener('abort', stop);
        active = null;
      }
    },
    async steer() {
      throw new ControlError('This Codex session runs through `codex exec`, which cannot be steered.', 409);
    },
    async interrupt() {
      if (!active) return false;
      active.interrupting = true;
      await onEvent({ kind: 'interrupt', by: 'owner', turnId: null });
      active.abort();
      return true;
    },
    async close() {
      closed = true;
      active?.abort();
      await onEvent({ kind: 'session.closed' });
    },
  };
}

/**
 * Provider-neutral agent host for one project: role routing, the session registry, owner
 * steering, and the stage runner the engine calls. Workers (orchestration) attach through
 * `orchestrationFactory` so the stage runner stays the same with or without them.
 */
export class AgentHost {
  constructor(
    context,
    {
      capabilities,
      providers = defaultProviders,
      execRunner = startCodexRun,
      executables = {},
      orchestrationFactory = null,
    } = {},
  ) {
    this.context = context;
    this.capabilities = normalizeCapabilities(capabilities);
    this.providers = providers;
    this.execRunner = execRunner;
    this.executables = executables;
    this.orchestrationFactory = orchestrationFactory;
    this.registry = new AgentSessionRegistry(context);
    this.orchestrations = new Map();
    this.engine = null;
    this.run = this.run.bind(this);
  }
  async init() {
    await this.registry.init();
  }
  bind(engine) {
    this.engine = engine;
  }
  settings() {
    return readAgentSettings(this.context);
  }
  limitsFor(settings) {
    return { timeoutMs: settings.limits.timeoutMinutes * 60 * 1000, maxTurns: settings.limits.maxTurns };
  }

  /**
   * Opens and registers one provider session. Codex falls back to `codex exec` when app-server
   * fails its handshake; that fallback is recorded as a visible notice on the session.
   */
  async openSession({
    provider,
    fallback = null,
    role,
    kind = 'stage',
    runId,
    initiativeId,
    parentId = null,
    task = null,
    worktree = null,
    reviewRound = null,
    cwd,
    sandbox,
    writableRoots = [],
    temporaryRoot,
    instructions,
    runDirectory,
    signal,
    mcpServers,
    mcpConfigPath,
    gitHelperPath,
    forward = async () => {},
  }) {
    const settings = await this.settings();
    const model = settings.models[provider] ?? undefined;
    const effort = settings.efforts[provider] ?? undefined;
    const limits = this.limitsFor(settings);
    const meta = await this.registry.create({
      runId,
      initiativeId,
      parentId,
      role,
      kind,
      provider,
      model: model ?? null,
      task,
      worktree,
      sandbox,
      reviewRound,
      fallback,
    });
    const onEvent = async entry => {
      await this.registry.record(meta.id, entry);
      await forward(entry, meta);
    };
    if (fallback)
      await onEvent({
        kind: 'notice',
        level: 'warning',
        text: `Using ${fallback.to} for ${role}: ${fallback.reason}.`,
      });
    const common = {
      id: meta.id,
      cwd,
      sandbox,
      writableRoots,
      temporaryRoot,
      instructions,
      model,
      effort,
      limits,
      onEvent,
      signal,
      rawLogPath: this.registry.rawLogPath(meta),
    };
    let handle;
    try {
      if (provider === 'claude')
        handle = await this.providers.claude({
          ...common,
          mcpConfigPath,
          gitHelperPath,
          ...(this.executables.claude ? { executable: this.executables.claude } : {}),
        });
      else {
        try {
          handle = await this.providers.codex({
            ...common,
            mcpServers,
            ...(this.executables.codex ? { executable: this.executables.codex } : {}),
          });
        } catch (error) {
          if (!error.handshake || signal?.aborted) throw error;
          await onEvent({
            kind: 'notice',
            level: 'warning',
            text: `Codex app-server is unavailable (${error.message}); using codex exec, which cannot be steered.`,
          });
          handle = openExecSession({
            ...common,
            runDirectory,
            execRunner: this.execRunner,
            executable: this.executables.codex,
          });
          await this.registry.update(meta.id, { transport: 'exec' });
        }
      }
    } catch (error) {
      await this.registry.finish(meta.id, { status: signal?.aborted ? 'cancelled' : 'failed', error: error.message });
      throw error;
    }
    this.registry.attach(meta.id, handle);
    return { meta, handle };
  }

  async closeSession(meta, handle, { status, error = null, result = null }) {
    try {
      await handle?.close();
    } finally {
      await this.registry.finish(meta.id, { status, error, ...(result ? { result } : {}) });
    }
  }

  /** The engine's runner: one stage, one session, one structured result. */
  async run({
    projectRoot,
    runDirectory,
    temporaryRoot,
    additionalWritableRoots = [],
    prompt,
    schemaPath,
    signal,
    onEvent = async () => {},
    stage,
    runId,
    initiativeId,
    gitBridge = null,
  }) {
    if (!ROLES.includes(stage)) throw new Error(`Unknown agent stage: ${stage}`);
    const settings = await this.settings();
    const { provider, fallback } = resolveProvider({ role: stage, settings, capabilities: this.capabilities });
    const outputSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
    let orchestration = null;
    let opened;
    try {
      if (stage === 'execution' && gitBridge && this.orchestrationFactory)
        orchestration = await this.orchestrationFactory({
          host: this,
          runId,
          initiativeId,
          runDirectory,
          temporaryRoot,
          gitBridge,
          signal,
          orchestratorProvider: provider,
        });
      opened = await this.openSession({
        provider,
        fallback,
        role: stage,
        kind: 'stage',
        runId,
        initiativeId,
        cwd: projectRoot,
        sandbox: 'workspace-write',
        writableRoots: additionalWritableRoots,
        temporaryRoot,
        runDirectory,
        signal,
        gitHelperPath: gitBridge?.helperPath,
        ...(orchestration ? orchestration.sessionOptions(provider) : {}),
        forward: entry => onEvent(entry),
      });
      orchestration?.setOrchestrator(opened.meta.id);
      const outcome = await opened.handle.startTurn(prompt, { outputSchema, schemaPath });
      await this.closeSession(opened.meta, opened.handle, { status: 'completed', result: outcome.result });
      return { threadId: opened.handle.threadId, result: outcome.result, exitCode: outcome.exitCode ?? 0 };
    } catch (error) {
      if (error.interrupted) error.message = 'The owner interrupted this agent. Add an update or retry.';
      error.threadId ??= opened?.handle.threadId ?? null;
      if (opened)
        await this.closeSession(opened.meta, opened.handle, {
          status: signal?.aborted ? 'cancelled' : 'failed',
          error: error.message,
        }).catch(() => {});
      throw error;
    } finally {
      await orchestration?.close();
    }
  }

  routing(settings) {
    const routes = {};
    for (const role of ROLES.filter(role => role !== 'review')) {
      try {
        routes[role] = resolveProvider({ role, settings, capabilities: this.capabilities });
      } catch (error) {
        routes[role] = { provider: null, fallback: null, error: error.message };
      }
    }
    try {
      routes.review = resolveProvider({
        role: 'review',
        settings,
        capabilities: this.capabilities,
        author: routes.delivery.provider ?? 'codex',
      });
    } catch (error) {
      routes.review = { provider: null, fallback: null, error: error.message };
    }
    return routes;
  }

  async list() {
    const [settings, sessions, state] = await Promise.all([
      this.settings(),
      this.registry.list(),
      this.engine ? this.engine.read() : null,
    ]);
    const run = state?.activeRun;
    return {
      providers: this.capabilities,
      settings,
      routing: this.routing(settings),
      activeRun: run
        ? { id: run.id, initiativeId: run.initiativeId, stage: run.stage, status: run.status ?? 'running' }
        : null,
      sessions,
    };
  }

  async events(sessionId, after, limit) {
    const page = await this.registry.events(sessionId, after, limit);
    if (!page) throw new ControlError('Agent session not found.', 404);
    return page;
  }

  async liveEntry(sessionId) {
    const entry = this.registry.get(sessionId);
    if (entry?.handle) return entry;
    if (await this.registry.find(sessionId)) throw new ControlError('This agent session has finished.', 409);
    throw new ControlError('Agent session not found.', 404);
  }

  /** Delivers a message to a live session: mid-turn steer, or a follow-up turn for an idle worker. */
  async deliver(sessionId, message, by) {
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_STEER)
      throw new ControlError(`message must contain 1–${MAX_STEER} characters.`);
    const entry = await this.liveEntry(sessionId);
    const { handle, meta } = entry;
    if (handle.activeTurnId) {
      if (handle.canSteer === false)
        throw new ControlError('This session cannot be steered. Interrupt it or wait for it to finish.', 409);
      try {
        const steered = await handle.steer(message.trim(), { expectedTurnId: handle.activeTurnId, by });
        return { sessionId, delivered: 'steer', turnId: steered?.turnId ?? null };
      } catch (error) {
        if (error instanceof ControlError) throw error;
        throw new ControlError(`The agent did not accept the message: ${error.message}`, 409);
      }
    }
    if (meta.status === 'idle' && typeof handle.followUp === 'function') {
      await handle.followUp(message.trim(), { by });
      return { sessionId, delivered: 'follow-up', turnId: null };
    }
    throw new ControlError('This agent has no running turn to steer.', 409);
  }

  /** Owner steering from the browser. The text is kept in the initiative's owner history. */
  async steer(sessionId, input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'message'))
      throw new ControlError('Only message can be supplied.');
    const delivered = await this.deliver(sessionId, input.message, 'owner');
    const meta = this.registry.get(sessionId)?.meta ?? (await this.registry.find(sessionId));
    if (this.engine && meta?.initiativeId)
      await this.engine.mutate(state => {
        const item = state.initiatives.find(i => i.id === meta.initiativeId);
        if (!item) return;
        item.messages.push({
          type: 'steer',
          message: input.message.trim(),
          sessionId,
          runId: meta.runId,
          role: meta.role,
          provider: meta.provider,
          delivered: delivered.delivered,
          at: now(),
        });
        event(item, 'steer', `Human steered the ${meta.role} agent (${meta.provider}).`);
        item.revision++;
        item.updatedAt = now();
      });
    return delivered;
  }

  async interrupt(sessionId, input = {}) {
    if (!input || typeof input !== 'object' || Object.keys(input).length)
      throw new ControlError('The interrupt request takes no fields.');
    const { handle, meta } = await this.liveEntry(sessionId);
    if (!(await handle.interrupt({ by: 'owner' })))
      throw new ControlError('This agent has no running turn to interrupt.', 409);
    if (this.engine && meta.initiativeId)
      await this.engine.mutate(state => {
        const item = state.initiatives.find(i => i.id === meta.initiativeId);
        if (!item) return;
        event(item, 'interrupt', `Human interrupted the ${meta.role} agent (${meta.provider}).`);
        item.revision++;
        item.updatedAt = now();
      });
    return { sessionId, interrupted: true };
  }

  /** Routing changes are refused while a run holds admission, under the same lock. */
  async updateSettings(input) {
    let saved;
    const write = async () => {
      saved = await writeAgentSettings(this.context, input);
    };
    if (!this.engine) await write();
    else
      await this.engine.mutate(async state => {
        if (state.activeRun)
          throw new ControlError('Wait for the current run to finish before changing agent settings.', 409);
        await write();
      });
    return { settings: saved, routing: this.routing(saved) };
  }

  /** Orchestrator tool calls arrive over loopback HTTP with the per-run token. */
  async orchestrationCall(runId, token, tool, args) {
    const orchestration = this.orchestrations.get(runId);
    if (!orchestration || !orchestration.authorize(token))
      throw new ControlError('Unknown or expired orchestration run.', 403);
    return orchestration.call(tool, args);
  }

  async close() {
    for (const orchestration of this.orchestrations.values()) await orchestration.close().catch(() => {});
    for (const [id, entry] of this.registry.live)
      await this.closeSession(entry.meta, entry.handle, { status: 'cancelled', error: 'The service stopped.' }).catch(
        () => {},
      );
  }

  async ensureDirectory(...parts) {
    const directory = await assertSafePath(this.context.stateDir, path.join(...parts));
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }
}
