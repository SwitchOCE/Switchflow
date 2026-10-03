import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from '../operations/storage.mjs';
import { ControlError, event, now } from './lifecycle.mjs';
import { startCodexRun } from './codex-runner.mjs';
import { openCodexSession } from './providers/codex-app-server.mjs';
import { openClaudeSession } from './providers/claude-cli.mjs';
import { oneLine, turnSandbox } from './providers/process.mjs';
import { AgentSessionRegistry } from './agent-sessions.mjs';
import { confirmRefusal } from './orchestration.mjs';
import { CapacityManager } from './capacity.mjs';
import { ProcessTracker } from './process-tree.mjs';
import { defaultEnvironmentRegistry } from './environments/index.mjs';
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
  onProcess = async () => {},
  signal,
  runDirectory,
  execRunner,
  executable,
  env = {},
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
    /** Each turn is its own process, so a read-only approach turn is just a read-only run. */
    async startTurn(text, { schemaPath, sandbox: requested }) {
      if (active) throw new Error('A turn is already running in this session');
      const mode = turnSandbox(sandbox, requested);
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      active = controller;
      const directory = turns++ === 0 ? runDirectory : path.join(runDirectory, `turn-${turns}`);
      try {
        await onEvent({ kind: 'turn.started', turnId: null });
        // Each turn is a new process; the previous PID no longer identifies this session.
        await onProcess(null);
        const result = await execRunner({
          projectRoot: cwd,
          runDirectory: directory,
          prompt: text,
          schemaPath,
          signal: controller.signal,
          resumeThreadId: threadId ?? undefined,
          sandboxMode: mode,
          additionalWritableRoots: mode === 'read-only' ? [] : writableRoots,
          temporaryRoot,
          timeoutMs: limits.timeoutMs,
          env,
          ...(executable ? { executable } : {}),
          onEvent: async entry => {
            if (entry.type === 'thread.started') threadId = entry.thread_id;
            if (entry.type === 'runner.started') await onProcess(entry.pid ?? null);
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
      capacity = {},
      processes = {},
      environments = null,
    } = {},
  ) {
    // Remote environments (environments/index.mjs): a registry, or an async function returning one.
    this.environments = environments;
    this.context = context;
    this.capabilities = normalizeCapabilities(capabilities);
    this.providers = providers;
    this.execRunner = execRunner;
    this.executables = executables;
    this.orchestrationFactory = orchestrationFactory;
    this.registry = new AgentSessionRegistry(context);
    this.orchestrations = new Map();
    this.engine = null;
    // Memory admission, leases and worker caps (capacity.mjs); leftover-process cleanup (process-tree.mjs).
    this.capacity = new CapacityManager(this, capacity);
    this.processes = processes instanceof ProcessTracker ? processes : new ProcessTracker(processes);
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
  /** The configured environment, or a 409 naming why it cannot take workers. Never falls back to local. */
  async environment(id) {
    if (!id || id === 'local') return null;
    const registry =
      typeof this.environments === 'function'
        ? await this.environments()
        : (this.environments ?? (await defaultEnvironmentRegistry(this.context)));
    const entry = registry?.get(id);
    if (!entry || typeof entry.openSession !== 'function')
      throw new ControlError(`Environment ${id} is not configured for this project.`, 409);
    return entry;
  }
  limitsFor(settings) {
    return { timeoutMs: settings.limits.timeoutMinutes * 60 * 1000, maxTurns: settings.limits.maxTurns };
  }

  /**
   * Opens and registers one provider session. Codex falls back to `codex exec` when app-server
   * fails its handshake; that fallback is recorded as a visible notice on the session.
   */
  async openSession({
    id,
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
    approval = null,
    environment = 'local',
    forward = async () => {},
  }) {
    const remote = await this.environment(environment);
    if (remote)
      return this.openRemoteSession(remote, {
        id,
        role,
        kind,
        runId,
        initiativeId,
        parentId,
        task,
        worktree,
        reviewRound,
        cwd,
        sandbox,
        signal,
        approval,
        forward,
      });
    const settings = await this.settings();
    const model = settings.models[provider] ?? undefined;
    const effort = settings.efforts[provider] ?? undefined;
    const limits = this.limitsFor(settings);
    // The capacity profile's caps (VITEST_MAX_WORKERS, NODE_OPTIONS heap size, ...) reach every agent process.
    const { workerEnv: env } = await this.capacity.profile();
    const meta = await this.registry.create({
      id,
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
      approval,
    });
    const onEvent = async entry => {
      await this.registry.record(meta.id, entry);
      await forward(entry, meta);
    };
    this.processes.begin(meta.id);
    // Workers are fenced across restarts like the stage agent. The record exists before the
    // process does, so a crash before its PID is known still leaves an unidentified entry.
    const tracked = kind !== 'stage' && Boolean(this.engine);
    const onProcess = async pid => {
      this.processes.track(meta.id, pid);
      if (tracked) await this.engine.trackProcess(runId, meta.id, { pid });
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
      onProcess,
      signal,
      rawLogPath: this.registry.rawLogPath(meta),
      env,
    };
    let handle;
    try {
      if (tracked) await this.engine.trackProcess(runId, meta.id, { kind, role, provider, task, pid: null });
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
      // Providers stop their own process when opening fails, so the fence entry can go.
      this.processes.untrack(meta.id);
      if (tracked) await this.engine.untrackProcess(runId, meta.id).catch(() => {});
      await this.registry.finish(meta.id, { status: signal?.aborted ? 'cancelled' : 'failed', error: error.message });
      throw error;
    }
    this.registry.attach(meta.id, handle);
    return { meta, handle };
  }

  /**
   * A worker in a remote environment. No local process exists, so there is no PID to fence and no
   * memory to admit; the environment's handle speaks the same session interface.
   */
  async openRemoteSession(remote, fields) {
    const settings = await this.settings();
    const meta = await this.registry.create({
      ...fields,
      provider: 'claude',
      transport: remote.kind,
      environment: remote.id,
      model: remote.config?.model ?? null,
      sandbox: fields.sandbox,
    });
    const onEvent = async entry => {
      await this.registry.record(meta.id, entry);
      await fields.forward(entry, meta);
    };
    let handle;
    try {
      handle = await remote.openSession({
        task: fields.task ?? 'worker',
        cwd: fields.cwd,
        limits: this.limitsFor(settings),
        onEvent,
        signal: fields.signal,
      });
    } catch (error) {
      await this.registry.finish(meta.id, { status: 'failed', error: error.message });
      throw error;
    }
    this.registry.attach(meta.id, handle);
    return { meta, handle };
  }

  /**
   * Ends a session: its agent process, then whatever that process left running (dev servers,
   * browsers), then its leases and memory reservation. Every close reason goes through here.
   */
  async closeSession(meta, handle, { status, error = null, result = null }) {
    try {
      if (meta.environment && meta.environment !== 'local') {
        // Remote: no local processes; closing disables the routine and removes its branches.
        await handle?.close();
        return;
      }
      // Snapshot while the agent still runs: an orphan has no parent left to find it by.
      await this.processes.sample(meta.id).catch(() => {});
      await handle?.close();
      await this.stopLeftovers(meta);
      // Only a close that completed proves the process ended; otherwise the fence entry stays.
      if (meta.kind !== 'stage' && this.engine) await this.engine.untrackProcess(meta.runId, meta.id);
    } finally {
      this.processes.untrack(meta.id);
      this.capacity.releaseWorker(meta.id);
      await this.capacity.releaseHolder(meta.id).catch(() => {});
      await this.registry.finish(meta.id, { status, error, ...(result ? { result } : {}) });
    }
  }
  async stopLeftovers(meta) {
    let stopped;
    try {
      stopped = await this.processes.cleanup(meta.id);
    } catch (failure) {
      await this.registry.record(meta.id, {
        kind: 'notice',
        level: 'warning',
        text: `Could not check for processes this session left running: ${failure.message}`,
      });
      return;
    }
    if (!stopped.length) return;
    const names = stopped.map(entry => `${entry.name || 'process'} ${entry.pid}`).join(', ');
    await this.registry.record(meta.id, {
      kind: 'notice',
      level: 'warning',
      text: `Stopped ${stopped.length} process${stopped.length === 1 ? '' : 'es'} this session left running: ${names}.`,
      processes: stopped,
    });
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
    resumeWorkers = [],
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
      // Workers the owner chose to resume start (or queue) before the orchestrator's first turn.
      if (orchestration && resumeWorkers.length) await orchestration.resume(resumeWorkers);
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
    const capacity = await this.capacity
      .status({ maxWorkers: settings.limits.maxWorkers })
      .catch(error => ({ error: error.message }));
    return {
      providers: this.capabilities,
      settings,
      routing: this.routing(settings),
      capacity,
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

  /**
   * Delivers a message to a live session. mode "steer" reaches a running turn mid-turn; "queue"
   * holds it until that turn ends and sends it as the next turn's input. An idle worker gets a
   * follow-up turn either way. Returns the effective mode: steer, queue or followup.
   *
   * confirm: true approves a delivery worker's returned approach and starts its first writable
   * turn; it needs an idle worker whose approach is waiting. A delivery worker's reply also says
   * whether this message confirmed (confirmed) and whether the worker may now write (writable).
   */
  async deliver(sessionId, message, by, mode = 'steer', { confirm = false } = {}) {
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_STEER)
      throw new ControlError(`message must contain 1–${MAX_STEER} characters.`);
    if (!['steer', 'queue'].includes(mode)) throw new ControlError('mode must be steer or queue.');
    if (typeof confirm !== 'boolean') throw new ControlError('confirm must be true or false.');
    const text = message.trim();
    const entry = await this.liveEntry(sessionId);
    const { handle, meta } = entry;
    const gate = () => (handle.approval ? { confirmed: confirm, writable: handle.approval === 'confirmed' } : {});
    if (confirm) {
      // Writes unlock only on an explicit confirmation of a finished approach turn.
      const refusal = confirmRefusal(handle.approval, Boolean(handle.activeTurnId) || meta.status !== 'idle');
      if (refusal) throw new ControlError(refusal, 409);
      await this.registry.record(sessionId, { kind: 'steer', text, by, mode: 'followup', turnId: null, confirm: true });
      await handle.followUp(text, { by, confirm: true });
      return { ok: true, sessionId, mode: 'followup', turnId: null, ...gate() };
    }
    // A turn that has just started may not have its provider turn ID yet.
    for (let waited = 0; !handle.activeTurnId && meta.status === 'working' && !handle.closed && waited < 10000;) {
      await new Promise(resolve => setTimeout(resolve, 50));
      waited += 50;
    }
    const turnId = handle.activeTurnId;
    const locked =
      handle.approval && handle.approval !== 'confirmed'
        ? { note: 'Writes stay locked until you confirm the approach (confirm: true).' }
        : {};
    if (turnId && mode === 'queue') {
      // Workers run the queue as their next turn; a stage agent's next turn is the next checkpoint.
      if (typeof handle.enqueue === 'function') handle.enqueue(text);
      else if (meta.kind !== 'stage') throw new ControlError('This session cannot queue messages.', 409);
      await this.registry.record(sessionId, { kind: 'steer', text, by, mode: 'queue', turnId });
      return { ok: true, sessionId, mode: 'queue', turnId, ...gate(), ...locked };
    }
    if (turnId) {
      if (handle.canSteer === false)
        throw new ControlError('This session cannot be steered. Queue the message or interrupt it.', 409);
      try {
        const steered = await handle.steer(text, { expectedTurnId: turnId, by });
        return { ok: true, sessionId, mode: 'steer', turnId: steered?.turnId ?? turnId, ...gate(), ...locked };
      } catch (error) {
        if (error instanceof ControlError) throw error;
        throw new ControlError(`The agent did not accept the message: ${error.message}`, 409);
      }
    }
    if (meta.status === 'idle' && typeof handle.followUp === 'function') {
      await this.registry.record(sessionId, { kind: 'steer', text, by, mode: 'followup', turnId: null });
      await handle.followUp(text, { by });
      return { ok: true, sessionId, mode: 'followup', turnId: null, ...gate(), ...locked };
    }
    throw new ControlError('This agent has no running turn to steer.', 409);
  }

  /** Owner steering from the browser. The text is kept in the initiative's owner history. */
  async steer(sessionId, input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some(key => !['message', 'mode', 'confirm'].includes(key))
    )
      throw new ControlError('Only message, mode and confirm can be supplied.');
    const delivered = await this.deliver(sessionId, input.message, 'owner', input.mode ?? 'steer', {
      confirm: input.confirm ?? false,
    });
    const meta = this.registry.get(sessionId)?.meta ?? (await this.registry.find(sessionId));
    if (this.engine && meta?.initiativeId)
      await this.engine.mutate(state => {
        const item = state.initiatives.find(i => i.id === meta.initiativeId);
        if (!item) return;
        // A message queued to a stage agent is ordinary owner input for the next checkpoint.
        const forNextRun = delivered.mode === 'queue' && meta.kind === 'stage';
        item.messages.push({
          type: forNextRun ? 'update' : 'steer',
          message: input.message.trim(),
          sessionId,
          runId: meta.runId,
          role: meta.role,
          provider: meta.provider,
          mode: delivered.mode,
          ...(delivered.confirmed ? { confirm: true } : {}),
          at: now(),
        });
        event(
          item,
          'steer',
          forNextRun
            ? `Human queued a message for the next ${meta.role} checkpoint.`
            : delivered.confirmed
              ? `Human confirmed the ${meta.role} agent's approach (${meta.provider}); it may now write.`
              : `Human steered the ${meta.role} agent (${meta.provider}).`,
        );
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

  /** Orchestrator and worker tool calls arrive over loopback HTTP with a per-run or per-worker token. */
  async orchestrationCall(runId, token, tool, args) {
    const orchestration = this.orchestrations.get(runId);
    const principal = orchestration?.authorize(token);
    if (!principal) throw new ControlError('Unknown or expired orchestration run.', 403);
    return orchestration.call(tool, args, principal);
  }

  async close() {
    for (const orchestration of this.orchestrations.values()) await orchestration.close().catch(() => {});
    for (const [, entry] of this.registry.live)
      await this.closeSession(entry.meta, entry.handle, { status: 'cancelled', error: 'The service stopped.' }).catch(
        () => {},
      );
    this.capacity.close();
    this.processes.close();
  }

  async ensureDirectory(...parts) {
    const directory = await assertSafePath(this.context.stateDir, path.join(...parts));
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }
}
