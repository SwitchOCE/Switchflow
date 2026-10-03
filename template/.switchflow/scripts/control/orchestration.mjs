import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafePath, readState } from '../operations/storage.mjs';
import { ControlError } from './lifecycle.mjs';
import { resolveProvider } from './agent-settings.mjs';
import { LEASE_TOOLS, TOOL_NAMES } from './orchestration-mcp.mjs';
import { recordDelegation, updateDelegation } from './worker-ledger.mjs';
import { DEFAULT_MAX_WORKERS as DEFAULT_BOX_WORKERS } from './environments/ssh.mjs';

const WORKER_TOOL_NAMES = LEASE_TOOLS.map(tool => tool.name);
/** A worker in one of these states has not finished its current step. */
const BUSY = new Set(['queued', 'starting', 'working']);
const MAX_INSTRUCTIONS = 50000;
/** The admission lane of an environment: "local" for this PC, otherwise the environment's id. */
const laneOf = environment => (!environment || environment.kind === 'local' ? 'local' : environment.id);
const SUITE_TTL_MINUTES = 30;

/** Instructions for a worker re-delegated after a service restart. */
export function resumeInstructions(entry) {
  const was =
    entry.status === 'queued'
      ? 'was still queued'
      : `had started${entry.approval ? ` (approach ${entry.approval})` : ''}`;
  const note = [
    `Resumed after the Switchflow service stopped. The previous ${entry.kind} worker for ${entry.task} (${entry.provider ?? 'provider unknown'}) ${was} and cannot be continued; this is a new session with the same instructions.`,
    'Before changing anything, inspect the worktree: keep committed work, check uncommitted edits and any half-finished rebase or merge, and do not redo steps that are already done.',
    "The orchestrator's original instructions follow.",
    '',
  ].join('\n');
  return note + String(entry.instructions ?? '').slice(0, MAX_INSTRUCTIONS - note.length);
}

const MCP_SCRIPT = fileURLToPath(new URL('./orchestration-mcp.mjs', import.meta.url));
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const samePath = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : a === b;

const text = { type: 'string' };
const strings = { type: 'array', items: { type: 'string' } };
/** Worker results. Every property is required so both providers can enforce the schema strictly. */
export const WORKER_SCHEMAS = Object.freeze({
  deliver: {
    type: 'object',
    properties: {
      task: text,
      outcome: { type: 'string', enum: ['approach', 'handoff', 'blocked'] },
      approach: text,
      head: text,
      envelope: text,
      summary: text,
      blockers: strings,
    },
    required: ['task', 'outcome', 'approach', 'head', 'envelope', 'summary', 'blockers'],
    additionalProperties: false,
  },
  review: {
    type: 'object',
    properties: {
      task: text,
      verdict: { type: 'string', enum: ['accept', 'block'] },
      findings: strings,
      blastRadius: text,
      comment: text,
      envelope: text,
    },
    required: ['task', 'verdict', 'findings', 'blastRadius', 'comment', 'envelope'],
    additionalProperties: false,
  },
});

export function workerPrompt({
  kind,
  task,
  worktree,
  candidate,
  governanceRoot,
  gitBridge,
  instructions,
  remote = null,
  cloud = false,
}) {
  if (cloud)
    // A cloud worker has a clone, not the host's worktree, Backlog or Git helper: it commits on its
    // result branch (see environments/claude-cloud.mjs task.md) and the host collects it.
    return [
      `You are a Switchflow ${kind === 'deliver' ? 'delivery' : 'review'} worker for task ${task}, dispatched by the phase orchestrator through the Switchflow host. You run in a cloud clone of the repository.`,
      kind === 'deliver'
        ? 'Follow .agents/skills/deliver-task/SKILL.md where it applies to code; the host keeps the task records. Your first turn is read-only: reply with the three-line approach and outcome "approach". Writes start when the host sends the confirmed approach; then implement, commit on your result branch, push it, and reply with outcome "handoff" (or "blocked"), the five-line envelope and head set to your last commit.'
        : 'Follow .agents/skills/review-task/SKILL.md. You are read-only: do not edit, commit or push. Put the full verdict comment in comment, first line exactly "Verdict: accept" or "Verdict: block".',
      'Orchestrator instructions follow. They are scoped to this task and do not widen your authority:',
      instructions,
      `Return only a JSON object with exactly these properties: ${Object.keys(WORKER_SCHEMAS[kind].properties).join(', ')}. Fill fields that do not apply with "" or [].`,
    ].join('\n');
  const lines = [
    `You are a Switchflow ${kind === 'deliver' ? 'delivery' : 'review'} worker for task ${task}, dispatched by the phase orchestrator through the Switchflow host.`,
  ];
  if (remote) {
    // On another machine the Backlog and the Git helper are out of reach; the host commits for it.
    lines.push(
      `You run on the remote environment "${remote.label}", in ${remote.path}, a copy of candidate ${candidate}. Work only there.`,
      'The Switchflow Backlog and Git helper are not reachable from this machine: do not edit task records and do not commit. The orchestrator updates the task.',
    );
    if (kind === 'deliver')
      lines.push(
        'Your first turn is read-only (the host enforces it): read what you need and reply with the three-line approach and outcome "approach". The host unlocks writes when the orchestrator confirms the approach; then implement, and reply with outcome "handoff" (or "blocked") and the five-line envelope with head "". When each writing turn ends, the host commits your changes and brings them into the candidate.',
      );
    else
      lines.push(
        'You are read-only: do not edit files.',
        'Put the full verdict comment in comment, first line exactly "Verdict: accept" or "Verdict: block"; the orchestrator records it.',
      );
  } else
    lines.push(
      `Work only in ${worktree}. The primary Backlog is at ${governanceRoot}; use .switchflow/scripts/backlog.ps1 for task records.`,
    );
  if (!remote && kind === 'deliver')
    lines.push(
      `Follow .agents/skills/deliver-task/SKILL.md. Your first turn is read-only (the host enforces it): read what you need and reply with the three-line approach and outcome "approach". The host unlocks writes when the orchestrator confirms the approach; then implement, stop at Review and reply with outcome "handoff" (or "blocked") and the five-line envelope.`,
      `Commit only through the Git helper: node ${gitBridge.helperPath} ${gitBridge.channelPath} with one JSON request, using candidate name "${candidate}".`,
    );
  else if (!remote)
    lines.push(
      'Follow .agents/skills/review-task/SKILL.md. You are read-only: do not edit files or task records.',
      'Put the full verdict comment in comment, first line exactly "Verdict: accept" or "Verdict: block"; the orchestrator records it.',
    );
  lines.push(
    'Orchestrator instructions follow. They are scoped to this task and do not widen your authority:',
    instructions,
    'Fill fields that do not apply with "" or []. Return only the requested JSON.',
  );
  return lines.join('\n');
}

const FINISHED = new Set(['completed', 'failed', 'cancelled']);
/**
 * A delivery worker's approach gate. Its turns run read-only until the orchestrator or the owner
 * confirms a returned approach (send_to_worker with confirm: true); only then can it write.
 */
export const APPROVAL = Object.freeze({
  drafting: 'drafting',
  awaiting: 'awaiting-confirmation',
  confirmed: 'confirmed',
});
const AWAITING_NOTE =
  'Approach ready. Writes stay locked: confirm it with send_to_worker confirm:true, or reply without confirm to correct it.';

/** Why a confirmation cannot start the delivery turn now, or null when it can. */
export function confirmRefusal(approval, busy) {
  if (!approval) return 'Only a delegated delivery worker has an approach to confirm.';
  if (approval === APPROVAL.confirmed) return 'This approach is already confirmed. Send the message without confirm.';
  if (approval !== APPROVAL.awaiting)
    return 'This worker has not returned an approach yet. Wait for its approach turn, then confirm.';
  if (busy) return 'Wait for the current turn to finish, then confirm the approach.';
  return null;
}

/** Host-side worker management for one execution run. Tools arrive through the MCP helper over HTTP. */
export class Orchestration {
  constructor({
    host,
    runId,
    initiativeId,
    runDirectory,
    gitBridge,
    signal,
    orchestratorProvider,
    serviceUrl,
    projectId,
    taskExists,
  }) {
    Object.assign(this, { host, runId, initiativeId, runDirectory, gitBridge, signal, orchestratorProvider });
    this.context = host.context;
    this.token = randomBytes(32).toString('hex');
    this.endpoint = `${serviceUrl}/api/projects/${projectId}/orchestration/${runId}`;
    this.taskExists = taskExists;
    this.workers = new Map();
    this.authors = new Map(); // task -> provider of the latest delivery worker
    this.reviewRounds = new Map();
    this.orchestratorId = null;
    this.workerTokens = new Map(); // token -> worker session ID (lease tools only)
    this.closed = false;
  }
  /** Returns "orchestrator", a worker session ID, or null. */
  authorize(token) {
    if (this.closed || typeof token !== 'string' || token.length !== this.token.length) return null;
    if (timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) return 'orchestrator';
    for (const [candidate, workerId] of this.workerTokens)
      if (timingSafeEqual(Buffer.from(token), Buffer.from(candidate))) return workerId;
    return null;
  }
  serverFor(token, tools) {
    return {
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: {
        SWITCHFLOW_ORCHESTRATION_URL: this.endpoint,
        SWITCHFLOW_ORCHESTRATION_TOKEN: token,
        ...(tools ? { SWITCHFLOW_ORCHESTRATION_TOOLS: tools } : {}),
      },
    };
  }
  async writeMcpConfig(file, server) {
    await fs.writeFile(file, JSON.stringify({ mcpServers: { switchflow: { type: 'stdio', ...server } } }), {
      flag: 'wx',
    });
  }
  setOrchestrator(sessionId) {
    this.orchestratorId = sessionId;
  }
  async prepare() {
    this.directory = await this.host.ensureDirectory(this.runDirectory, 'orchestration');
    const server = this.serverFor(this.token);
    this.mcpServers = { switchflow: server };
    this.mcpConfigPath = path.join(this.directory, 'mcp.json');
    await this.writeMcpConfig(this.mcpConfigPath, server);
    for (const kind of ['deliver', 'review'])
      await fs.writeFile(path.join(this.directory, `${kind}-schema.json`), JSON.stringify(WORKER_SCHEMAS[kind]));
    this.host.orchestrations.set(this.runId, this);
    return this;
  }
  /** Extra session options so either provider can orchestrate. */
  sessionOptions(provider) {
    return provider === 'claude' ? { mcpConfigPath: this.mcpConfigPath } : { mcpServers: this.mcpServers };
  }

  async call(tool, args, principal = 'orchestrator') {
    if (this.closed || this.signal?.aborted) throw new ControlError('This run has ended.', 409);
    if (!TOOL_NAMES.includes(tool)) throw new ControlError('Unknown orchestration tool.', 404);
    // Workers hold only leases; delegation stays with the orchestrator.
    if (principal !== 'orchestrator' && !WORKER_TOOL_NAMES.includes(tool))
      throw new ControlError('Workers may only use leases.', 403);
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new ControlError('Arguments must be an object.');
    return this[tool](args, principal);
  }
  fields(args, required, optional = []) {
    const extra = Object.keys(args).filter(key => ![...required, ...optional].includes(key));
    if (extra.length) throw new ControlError(`Unsupported fields: ${extra.join(', ')}.`);
    for (const key of required) if (args[key] === undefined) throw new ControlError(`${key} is required.`);
  }
  worker(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new ControlError('Unknown worker for this run.', 404);
    return worker;
  }
  /**
   * Workers starting or in a turn on one lane: this PC (counted against limits.maxWorkers) or an
   * SSH box (counted against its own maxWorkers). Idle, queued and cloud workers are not counted.
   */
  liveCount(lane = 'local') {
    return [...this.workers.values()].filter(
      worker =>
        !worker.remote && laneOf(worker.environment) === lane && ['starting', 'working'].includes(worker.status),
    ).length;
  }

  /** The worktree must be a candidate the Git helper registered for this exact plan grant. */
  async candidate(worktree) {
    if (typeof worktree !== 'string' || !worktree.trim() || worktree.length > 4096)
      throw new ControlError('worktree must name a managed candidate.');
    const { initiativeId, planHash } = this.gitBridge;
    const registry = await readState(this.context, `git-bridge-${initiativeId}-${planHash}`, { entries: [] });
    const entry = (registry.entries || []).find(
      item => item.name === worktree || (path.isAbsolute(worktree) && samePath(item.path, worktree)),
    );
    if (!entry) throw new ControlError('worktree must be a candidate the Git helper created for this plan grant.', 409);
    const managedRoot = this.gitBridge.managedRoot;
    await assertSafePath(managedRoot, entry.path);
    if (!samePath(await fs.realpath(entry.path), entry.path))
      throw new ControlError('Managed candidate path changed.', 409);
    return entry;
  }

  /**
   * Delegates one task. The worker is admitted at once when a worker slot and memory are free;
   * otherwise it is queued (status "queued") and starts by itself, first in first out.
   */
  async delegate_task(args, principal = 'orchestrator', { resumedFrom = null } = {}) {
    this.fields(args, ['task', 'kind', 'instructions', 'worktree'], ['provider', 'environment']);
    const { task, kind, instructions, provider: requested, environment: requestedEnvironment } = args;
    if (
      requestedEnvironment !== undefined &&
      (typeof requestedEnvironment !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(requestedEnvironment))
    )
      throw new ControlError('environment must be an environment ID such as local, claude-cloud or an SSH box.');
    if (typeof task !== 'string' || !TASK_ID.test(task)) throw new ControlError('task must be a Backlog task ID.');
    if (!['deliver', 'review'].includes(kind)) throw new ControlError('kind must be deliver or review.');
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > MAX_INSTRUCTIONS)
      throw new ControlError(`instructions must contain 1–${MAX_INSTRUCTIONS} characters.`);
    if (requested !== undefined && !['claude', 'codex'].includes(requested))
      throw new ControlError('provider must be claude or codex.');
    const settings = await this.host.settings();
    if (this.taskExists) {
      try {
        await this.taskExists(task);
      } catch {
        throw new ControlError(`Backlog task ${task} was not found.`, 404);
      }
    }
    const entry = await this.candidate(args.worktree);
    // Where: the owner's placement for the role, or another environment the owner enabled. An
    // unavailable environment is refused with its reason; it never silently becomes this PC.
    const role = kind === 'deliver' ? 'delivery' : 'review';
    const environmentId = requestedEnvironment ?? settings.placement?.[role] ?? 'local';
    // A missing, disabled or unconfigured environment refuses (409); it never falls back to local.
    const environment = (await this.host.environment(environmentId, settings)) ?? this.host.environments.local;
    // Cloud kinds run their own agent (Claude or Codex) with no process here; process kinds run our CLIs.
    const remote = typeof environment.openSession === 'function';
    const cloudProvider = remote ? (environment.provider ?? 'claude') : null;
    if (remote && requested && requested !== cloudProvider)
      throw new ControlError(`Environment ${environment.id} runs ${cloudProvider} workers only.`, 409);
    // Every delivery worker has the approach gate; a kind with no read-only first turn cannot deliver.
    if (kind === 'deliver' && environment.capabilities?.approachGate === false)
      throw new ControlError(
        `Environment ${environment.id} runs one fire-and-forget task with no approach turn, and delivery workers need the approach gate. Place delivery locally, on an SSH box or on Claude cloud; ${environment.id} takes reviews only.`,
        409,
      );
    let capabilities = this.host.capabilities;
    if (!remote && environment.kind !== 'local') {
      if (typeof environment.spawnFor !== 'function')
        throw new ControlError(`Environment ${environment.id} cannot run delegated workers yet.`, 409);
      const health = await environment.health().catch(error => ({ ok: false, reason: error.message }));
      if (!health.ok)
        throw new ControlError(
          `Environment ${environment.id} is unavailable: ${health.reason} The task waits: delegate it again once the environment is healthy, or ask the owner to change its placement. Switchflow does not fall back to this PC.`,
          409,
        );
      capabilities = health.providers ?? capabilities;
    }
    let routed;
    let reviewRound = null;
    if (kind === 'review') {
      const author = this.authors.get(task) ?? this.orchestratorProvider;
      reviewRound = (this.reviewRounds.get(task) ?? 0) + 1;
      if (reviewRound > settings.limits.maxReviewRounds)
        throw new ControlError(
          `Review round limit (${settings.limits.maxReviewRounds}) reached for ${task}. Escalate to the owner.`,
          409,
        );
      routed = resolveProvider({
        role: 'review',
        settings,
        capabilities,
        author,
        requested: requested ?? null,
      });
    } else
      routed = resolveProvider({
        role: 'delivery',
        settings,
        capabilities,
        requested: remote ? cloudProvider : (requested ?? null),
      });
    if (remote && routed.provider !== cloudProvider)
      throw new ControlError(
        `Environment ${environment.id} runs ${cloudProvider} workers only; route this review elsewhere.`,
        409,
      );
    if (kind === 'review') this.reviewRounds.set(task, reviewRound);
    const write = kind === 'deliver';
    const worker = {
      id: randomUUID(),
      task,
      kind,
      provider: routed.provider,
      worktree: entry.path,
      candidate: entry.name,
      reviewRound,
      meta: null,
      handle: null,
      status: 'queued',
      result: null,
      error: null,
      reported: true,
      queue: [],
      token: null,
      schemaPath: path.join(this.directory, `${kind}-schema.json`),
      approval: write ? APPROVAL.drafting : null,
      instructions,
      resumedFrom,
      environment,
      workspace: null,
      collected: null,
      remote,
    };
    this.workers.set(worker.id, worker);
    if (write) this.authors.set(task, routed.provider);
    let admission;
    try {
      // Durable before anything starts, so a crash can still name and resume this delegation.
      await recordDelegation(this.context, {
        runId: this.runId,
        initiativeId: this.initiativeId,
        workerId: worker.id,
        task,
        kind,
        worktree: entry.name,
        provider: routed.provider,
        environment: environment.id,
        instructions,
        status: 'queued',
        approval: worker.approval,
        resumedFrom,
      });
      // Cloud workers use no local memory or worker slot, so they start at once.
      if (remote) {
        worker.launching = this.launch(worker, routed, entry).catch(error => this.launchFailed(worker, error));
        admission = {};
      } else {
        // Workers on an SSH box use none of this PC's memory and queue against the box's own limit.
        const lane = laneOf(environment);
        const limit = lane === 'local' ? settings.limits.maxWorkers : (environment.maxWorkers ?? DEFAULT_BOX_WORKERS);
        admission = await this.host.capacity.request({
          id: worker.id,
          runId: this.runId,
          task,
          kind,
          maxWorkers: limit,
          slotFree: () => this.liveCount(lane) < limit,
          start: () => (worker.launching = this.launch(worker, routed, entry)),
          onFailure: error => this.launchFailed(worker, error),
          ...(lane === 'local'
            ? {}
            : {
                lane,
                memory: false,
                limitReason: `${limit} worker${limit === 1 ? ' is' : 's are'} running on ${environment.label ?? lane}, its limit (maxWorkers)`,
              }),
        });
      }
    } catch (error) {
      // A worker that could not start at once leaves no record behind, as before queuing existed.
      this.workers.delete(worker.id);
      this.host.capacity.cancel(worker.id);
      await updateDelegation(this.context, worker.id, { status: 'finished', outcome: 'failed' }).catch(() => {});
      throw error;
    }
    return {
      ...this.summary(worker),
      fallback: routed.fallback,
      ...(admission.note ? { capacityNote: admission.note } : {}),
    };
  }

  /** Opens an admitted worker's session and starts its first turn. */
  async launch(worker, routed, entry) {
    // Before the first await: the worker now counts against limits.maxWorkers.
    worker.status = 'starting';
    let workerToken;
    try {
      if (this.closed || this.signal?.aborted) throw new ControlError('This run has ended.', 409);
      const { task, kind, reviewRound } = worker;
      const workerDirectory = await this.host.ensureDirectory(
        this.directory,
        'workers',
        `${task}-${kind}-${Date.now()}`,
      );
      const stateDir = this.context.stateDir;
      const temporaryRoot = await this.host.ensureDirectory(workerDirectory, 'tmp');
      const write = kind === 'deliver';
      // Each worker gets its own token, valid only for the lease tools while it runs.
      workerToken = randomBytes(32).toString('hex');
      const leaseServer = this.serverFor(workerToken, 'suite');
      const leaseConfigPath = path.join(workerDirectory, 'mcp.json');
      await this.writeMcpConfig(leaseConfigPath, leaseServer);
      this.workerTokens.set(workerToken, worker.id);
      // An SSH box runs our CLIs in a workspace prepared there; cloud kinds open their own session.
      const onBox = worker.environment.kind !== 'local' && !worker.remote;
      if (onBox)
        worker.workspace = await worker.environment.prepareWorkspace({
          repo: entry.path,
          name: `${task}-${kind}-${worker.id.slice(0, 8)}`,
        });
      const localRoots = write
        ? [
            entry.path,
            this.context.governanceRoot,
            ...['operations', 'scratch', 'governance'].map(name => path.join(stateDir, name)),
            path.join(this.gitBridge.channelPath, 'requests'),
          ]
        : [];
      const writableRoots = onBox ? (write ? worker.workspace.writableRoots : []) : localRoots;
      const opened = await this.host.openSession({
        id: worker.id,
        provider: routed.provider,
        fallback: routed.fallback,
        role: write ? 'delivery' : 'review',
        kind,
        runId: this.runId,
        initiativeId: this.initiativeId,
        parentId: this.orchestratorId,
        task,
        worktree: entry.path,
        reviewRound,
        cwd: onBox ? worker.workspace.path : entry.path,
        sandbox: write ? 'workspace-write' : 'read-only',
        writableRoots,
        temporaryRoot: onBox ? worker.workspace.temporaryRoot : temporaryRoot,
        runDirectory: workerDirectory,
        signal: this.signal,
        // Remote workers reach neither the Git helper nor the loopback lease server: the host
        // commits for them (collectRemote), and leases describe this PC's resources.
        gitHelperPath: write && !onBox ? this.gitBridge.helperPath : undefined,
        ...(onBox ? {} : { mcpServers: { switchflow: leaseServer }, mcpConfigPath: leaseConfigPath }),
        environment: worker.environment,
        workspace: worker.workspace,
        approval: worker.approval,
        forward: async () => {},
      });
      // Cancelled while it was starting: close what just opened.
      if (this.closed || worker.status !== 'starting') {
        await this.host.closeSession(opened.meta, opened.handle, { status: 'cancelled' }).catch(() => {});
        throw new ControlError('This worker was cancelled while it started.', 409);
      }
      Object.assign(worker, { meta: opened.meta, handle: opened.handle, token: workerToken, status: 'working' });
      opened.handle.followUp = (message, { confirm = false, by = 'orchestrator' } = {}) =>
        this.startTurn(worker, message, { confirm, by });
      opened.handle.enqueue = message => worker.queue.push(message);
      // The host reads the gate when a message asks to confirm.
      Object.defineProperty(opened.handle, 'approval', { get: () => worker.approval, configurable: true });
      await updateDelegation(this.context, worker.id, { status: 'open' }).catch(() => {});
      await this.startTurn(
        worker,
        workerPrompt({
          kind,
          task,
          worktree: entry.path,
          candidate: entry.name,
          governanceRoot: this.context.governanceRoot,
          gitBridge: this.gitBridge,
          instructions: worker.instructions,
          remote: onBox ? { label: worker.environment.label, path: worker.workspace.path } : null,
          cloud: worker.remote,
        }),
      );
    } catch (error) {
      // A worker that never opened must not leave a usable token behind.
      if (workerToken && !worker.handle) this.workerTokens.delete(workerToken);
      if (!worker.handle) await this.cleanupRemote(worker);
      throw error;
    }
  }
  /** A queued worker that failed to start once admitted. Its orchestrator sees it as failed. */
  async launchFailed(worker, error) {
    if (FINISHED.has(worker.status)) return;
    Object.assign(worker, { status: 'failed', closedStatus: 'failed', error: error.message, reported: false });
    await updateDelegation(this.context, worker.id, { status: 'finished', outcome: 'failed' }).catch(() => {});
    this.host.registry.wake();
  }
  /** Re-delegates workers held by a service restart, deliveries before reviews. */
  async resume(entries) {
    const ordered = [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'deliver' ? -1 : 1));
    const resumed = [];
    const failed = [];
    for (const entry of ordered) {
      try {
        const summary = await this.delegate_task(
          {
            task: entry.task,
            kind: entry.kind,
            worktree: entry.worktree,
            instructions: resumeInstructions(entry),
            // A reviewer is routed afresh so it still differs from the author.
            ...(entry.kind === 'deliver' && entry.provider ? { provider: entry.provider } : {}),
            // Same environment as before; a removed or unhealthy one is refused with its reason.
            ...(entry.environment && entry.environment !== 'local' ? { environment: entry.environment } : {}),
          },
          'orchestrator',
          { resumedFrom: entry.workerId },
        );
        resumed.push(`${entry.task} ${entry.kind} (${summary.status})`);
      } catch (error) {
        failed.push(`${entry.task} ${entry.kind}: ${error.message}`);
      }
    }
    if (this.orchestratorId)
      await this.host.registry.record(this.orchestratorId, {
        kind: 'notice',
        level: failed.length ? 'warning' : 'info',
        text: [
          resumed.length ? `Resumed held workers: ${resumed.join('; ')}.` : '',
          failed.length ? `Could not resume: ${failed.join('; ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
    return { resumed, failed };
  }

  /**
   * Starts a turn without waiting for it; its outcome lands on the worker record. An unconfirmed
   * delivery worker's turn is read-only; confirm unlocks writes from this turn on.
   */
  async startTurn(worker, message, { confirm = false, by = 'orchestrator' } = {}) {
    if (FINISHED.has(worker.status)) throw new ControlError('This worker has finished.', 409);
    if (confirm) {
      const refusal = confirmRefusal(worker.approval, worker.status === 'working');
      if (refusal) throw new ControlError(refusal, 409);
      worker.approval = APPROVAL.confirmed;
      await this.host.registry.update(worker.id, { approval: worker.approval });
      await this.host.registry.record(worker.id, {
        kind: 'notice',
        level: 'info',
        text: `Approach confirmed by ${by}. Writes are unlocked for this worker.`,
      });
    }
    worker.status = 'working';
    worker.reported = false;
    const gated = worker.kind === 'deliver' && worker.approval !== APPROVAL.confirmed;
    const turn = worker.handle.startTurn(message, {
      outputSchema: WORKER_SCHEMAS[worker.kind],
      schemaPath: worker.schemaPath,
      ...(gated ? { sandbox: 'read-only' } : {}),
    });
    worker.turn = turn
      .then(async outcome => {
        worker.result = outcome.result;
        worker.error = null;
        // An unconfirmed turn that returns an approach waits for confirmation; anything else keeps drafting.
        if (gated) {
          worker.approval = outcome.result?.outcome === 'approach' ? APPROVAL.awaiting : APPROVAL.drafting;
          await this.host.registry.update(worker.id, { approval: worker.approval });
        } else await this.collectRemote(worker);
        if (await this.flushQueue(worker)) return;
        // A reviewer goes straight from working to completed, so a waiter never sees it idle.
        if (worker.kind === 'review') {
          await this.finishWorker(worker, 'completed');
          // An accepted task needs no more corrections from its author.
          if (outcome.result?.verdict === 'accept')
            for (const other of this.workers.values())
              if (other.task === worker.task && other.kind === 'deliver' && other.status === 'idle')
                await this.finishWorker(other, 'completed');
          return;
        }
        worker.status = 'idle';
        await this.host.registry.update(worker.id, { result: outcome.result, status: 'idle' });
      })
      .catch(async error => {
        worker.error = error.message;
        if (error.interrupted && !this.closed) {
          if (!gated) await this.collectRemote(worker);
          worker.status = 'idle';
          await this.host.registry.update(worker.id, { status: 'idle' });
          await this.flushQueue(worker);
        } else await this.finishWorker(worker, this.signal?.aborted || this.closed ? 'cancelled' : 'failed');
      })
      .finally(() => this.host.registry.wake());
  }
  /**
   * A remote delivery worker's writing turn ended: commit its changes on the box and fast-forward
   * the local candidate, so review, gates and merge see them exactly like local work.
   */
  async collectRemote(worker) {
    if (!worker.workspace || worker.kind !== 'deliver') return;
    try {
      const collected = await worker.environment.collect(worker.workspace, {
        into: worker.worktree,
        message: `${worker.task}: work from ${worker.environment.label}`,
      });
      worker.collected = { ...collected, at: new Date().toISOString(), error: null };
      await this.host.registry.record(worker.id, {
        kind: 'notice',
        level: 'info',
        text: collected.changed
          ? `Collected the remote work into ${worker.candidate} at ${collected.head.slice(0, 12)}.`
          : `No new remote changes to collect into ${worker.candidate}.`,
      });
    } catch (error) {
      worker.collected = { changed: false, head: null, at: new Date().toISOString(), error: error.message };
      await this.host.registry.record(worker.id, {
        kind: 'notice',
        level: 'warning',
        text: `Could not collect the remote work: ${error.message}`,
      });
    }
  }
  async cleanupRemote(worker) {
    const workspace = worker.workspace;
    if (!workspace) return;
    worker.workspace = null;
    await worker.environment.cleanup(workspace).catch(() => {});
  }
  /** Messages queued during a turn become the next turn, in order. */
  async flushQueue(worker) {
    if (!worker.queue.length || this.closed) return false;
    const message = worker.queue.splice(0).join('\n\n');
    await this.startTurn(worker, message);
    return true;
  }
  async finishWorker(worker, status) {
    if (FINISHED.has(worker.status) && worker.closedStatus) return;
    const opened = Boolean(worker.meta);
    worker.status = status;
    worker.closedStatus = status;
    worker.queue = [];
    if (worker.token) this.workerTokens.delete(worker.token);
    await updateDelegation(this.context, worker.id, { status: 'finished', outcome: status }).catch(() => {});
    if (!opened) {
      // Queued, or still starting: launch() sees the status and closes what it opens.
      this.host.capacity.cancel(worker.id);
      this.host.registry.wake();
      return;
    }
    // Closing the session also releases its leases, memory reservation and leftover processes.
    try {
      await this.host.closeSession(worker.meta, worker.handle, {
        status,
        error: status === 'completed' ? null : worker.error,
        result: worker.result,
      });
    } finally {
      // The result already lives in the local candidate; the remote worktree can go.
      await this.cleanupRemote(worker);
    }
  }
  summary(worker) {
    const meta = this.host.registry.get(worker.id)?.meta ?? worker.meta ?? {};
    const queue = worker.status === 'queued' ? this.host.capacity.queueInfo(worker.id) : null;
    return {
      workerId: worker.id,
      task: worker.task,
      kind: worker.kind,
      provider: worker.provider,
      environment: worker.environment.id,
      ...(worker.handle?.cloud?.url ? { sessionUrl: worker.handle.cloud.url } : {}),
      worktree: worker.worktree,
      ...(worker.collected ? { collected: worker.collected } : {}),
      reviewRound: worker.reviewRound,
      status: worker.status,
      ...(queue ? { queue } : {}),
      approval: worker.approval,
      writable: worker.kind === 'deliver' && worker.approval === APPROVAL.confirmed,
      ...(worker.approval === APPROVAL.awaiting && worker.status === 'idle' ? { note: AWAITING_NOTE } : {}),
      ...(worker.resumedFrom ? { resumedFrom: worker.resumedFrom } : {}),
      lastTurn: meta.lastTurn ?? null,
      lastMessage: meta.lastMessage ?? null,
      usage: meta.usage ?? null,
      result: worker.result,
      error: worker.error,
    };
  }
  realWorkers() {
    return [...this.workers.values()];
  }

  async worker_status(args) {
    this.fields(args, [], ['workerId']);
    const workers = args.workerId ? [this.worker(args.workerId)] : this.realWorkers();
    for (const worker of workers) if (!BUSY.has(worker.status)) worker.reported = true;
    return { workers: workers.map(worker => this.summary(worker)) };
  }
  async send_to_worker(args) {
    this.fields(args, ['workerId', 'message'], ['mode', 'confirm']);
    const worker = this.worker(args.workerId);
    if (FINISHED.has(worker.status)) throw new ControlError('This worker has finished. Delegate again.', 409);
    if (worker.status === 'queued') {
      const queue = this.host.capacity.queueInfo(worker.id);
      throw new ControlError(
        `This worker is queued (position ${queue?.position ?? '?'}: ${queue?.reason ?? 'waiting for capacity'}). Send the message after it starts, or interrupt it to cancel.`,
        409,
      );
    }
    if (worker.status === 'starting')
      throw new ControlError('This worker is starting. Send the message after its first turn begins.', 409);
    return this.host.deliver(worker.id, args.message, 'orchestrator', args.mode ?? 'steer', {
      confirm: args.confirm,
    });
  }

  waitMs(value) {
    const seconds = value ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 50)
      throw new ControlError('timeoutSeconds must be 1–50. Call again to keep waiting.');
    return seconds * 1000;
  }
  /** Leases are held by sessions: a worker's own, or the orchestrator's. */
  leaseHolder(principal) {
    if (principal !== 'orchestrator') {
      const worker = this.worker(principal);
      return { holder: worker.id, kind: worker.kind, task: worker.task };
    }
    return { holder: this.orchestratorId || `orchestrator:${this.runId}`, kind: 'orchestrator', task: null };
  }
  async acquire_lease(args, principal) {
    this.fields(args, ['name'], ['ttlMinutes', 'timeoutSeconds']);
    const timeoutMs = this.waitMs(args.timeoutSeconds);
    if (args.ttlMinutes !== undefined && !Number.isInteger(args.ttlMinutes))
      throw new ControlError('ttlMinutes must be a whole number of minutes.');
    return this.host.capacity.acquireLease({
      name: args.name,
      ...this.leaseHolder(principal),
      runId: this.runId,
      ttlMinutes: args.ttlMinutes,
      timeoutMs,
      signal: this.signal,
    });
  }
  async release_lease(args, principal) {
    this.fields(args, ['id']);
    if (typeof args.id !== 'string' || args.id.length > 64) throw new ControlError('id must be a lease ID.');
    // The orchestrator may release any lease of its run, for example one a stuck worker holds.
    return this.host.capacity.releaseLease(args.id, {
      holder: this.leaseHolder(principal).holder,
      runId: principal === 'orchestrator' ? this.runId : null,
    });
  }
  async list_leases(args) {
    this.fields(args, []);
    return this.host.capacity.listLeases();
  }
  /** Compatibility: the suite lock is the lease "suite". */
  async acquire_suite_lock(args, principal) {
    this.fields(args, [], ['timeoutSeconds']);
    const timeoutMs = this.waitMs(args.timeoutSeconds);
    const result = await this.host.capacity.acquireLease({
      name: 'suite',
      ...this.leaseHolder(principal),
      runId: this.runId,
      timeoutMs,
      signal: this.signal,
      ttlMinutes: SUITE_TTL_MINUTES,
    });
    if (result.acquired) return { acquired: true, expiresAt: result.expiresAt };
    const holder = (await this.host.capacity.listLeases()).leases.find(lease => lease.name === 'suite');
    return { acquired: false, heldBy: holder?.holder ?? null, reason: result.reason };
  }
  async release_suite_lock(args, principal) {
    this.fields(args, []);
    const released = await this.host.capacity.releaseHolder(this.leaseHolder(principal).holder, 'suite');
    return { released: released.length > 0 };
  }
  async interrupt_worker(args) {
    this.fields(args, ['workerId']);
    const worker = this.worker(args.workerId);
    // A queued worker has no turn to stop; interrupting it cancels the delegation.
    if (worker.status === 'queued') {
      await this.finishWorker(worker, 'cancelled');
      return { workerId: worker.id, interrupted: true, cancelled: true };
    }
    const interrupted = worker.status === 'working' && (await worker.handle.interrupt({ by: 'orchestrator' }));
    return { workerId: worker.id, interrupted: Boolean(interrupted) };
  }
  /** Returns when a listed worker finishes a turn not yet reported, or none is still busy (queued, starting, working). */
  async wait_for_workers(args) {
    this.fields(args, [], ['workerIds', 'timeoutSeconds']);
    const ids = args.workerIds ?? this.realWorkers().map(worker => worker.id);
    if (!Array.isArray(ids) || ids.length > 50) throw new ControlError('workerIds must be a list.');
    const workers = ids.map(id => this.worker(id));
    const timeoutMs = this.waitMs(args.timeoutSeconds);
    const ready = () =>
      workers.some(worker => !BUSY.has(worker.status) && !worker.reported) ||
      workers.every(worker => !BUSY.has(worker.status));
    const done = await this.host.registry.waitFor(ready, timeoutMs, this.signal);
    for (const worker of workers) if (!BUSY.has(worker.status)) worker.reported = true;
    return { timedOut: !done, workers: workers.map(worker => this.summary(worker)) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.host.orchestrations.delete(this.runId);
    await this.host.capacity.releaseHolder(this.orchestratorId || `orchestrator:${this.runId}`).catch(() => {});
    await Promise.allSettled(
      this.realWorkers().map(worker => this.finishWorker(worker, BUSY.has(worker.status) ? 'cancelled' : 'completed')),
    );
    await Promise.allSettled(this.realWorkers().map(worker => worker.launching));
    await Promise.allSettled(this.realWorkers().map(worker => worker.turn));
  }
}

/** Server-side factory. Without a reachable HTTP service, runs proceed without delegation tools. */
export function createOrchestrationFactory({ serviceUrl, projectId, adapter }) {
  return async options => {
    const url = serviceUrl();
    if (!url) return null;
    const orchestration = new Orchestration({
      ...options,
      serviceUrl: url,
      projectId,
      taskExists: adapter?.view ? task => adapter.view(task) : null,
    });
    return orchestration.prepare();
  };
}
