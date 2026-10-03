import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafePath, readState } from '../operations/storage.mjs';
import { ControlError } from './lifecycle.mjs';
import { resolveProvider } from './agent-settings.mjs';
import { SUITE_TOOLS, TOOL_NAMES } from './orchestration-mcp.mjs';

const SUITE_TOOL_NAMES = SUITE_TOOLS.map(tool => tool.name);

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

export function workerPrompt({ kind, task, worktree, candidate, governanceRoot, gitBridge, instructions }) {
  const lines = [
    `You are a Switchflow ${kind === 'deliver' ? 'delivery' : 'review'} worker for task ${task}, dispatched by the phase orchestrator through the Switchflow host.`,
    `Work only in ${worktree}. The primary Backlog is at ${governanceRoot}; use .switchflow/scripts/backlog.ps1 for task records.`,
  ];
  if (kind === 'deliver')
    lines.push(
      `Follow .agents/skills/deliver-task/SKILL.md. Your first turn is read-only (the host enforces it): read what you need and reply with the three-line approach and outcome "approach". The host unlocks writes when the orchestrator confirms the approach; then implement, stop at Review and reply with outcome "handoff" (or "blocked") and the five-line envelope.`,
      `Commit only through the Git helper: node ${gitBridge.helperPath} ${gitBridge.channelPath} with one JSON request, using candidate name "${candidate}".`,
    );
  else
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
    this.workerTokens = new Map(); // token -> worker session ID (suite lock only)
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
    // Workers hold only the suite lock; delegation stays with the orchestrator.
    if (principal !== 'orchestrator' && !SUITE_TOOL_NAMES.includes(tool))
      throw new ControlError('Workers may only use the suite lock.', 403);
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
  liveCount() {
    return [...this.workers.values()].filter(worker => ['starting', 'working'].includes(worker.status)).length;
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

  async delegate_task(args) {
    this.fields(args, ['task', 'kind', 'instructions', 'worktree'], ['provider']);
    const { task, kind, instructions, provider: requested } = args;
    if (typeof task !== 'string' || !TASK_ID.test(task)) throw new ControlError('task must be a Backlog task ID.');
    if (!['deliver', 'review'].includes(kind)) throw new ControlError('kind must be deliver or review.');
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 50000)
      throw new ControlError('instructions must contain 1–50000 characters.');
    if (requested !== undefined && !['claude', 'codex'].includes(requested))
      throw new ControlError('provider must be claude or codex.');
    const settings = await this.host.settings();
    if (this.liveCount() >= settings.limits.maxWorkers)
      throw new ControlError(
        `At most ${settings.limits.maxWorkers} workers may run at once. Wait for one to finish.`,
        409,
      );
    if (this.taskExists) {
      try {
        await this.taskExists(task);
      } catch {
        throw new ControlError(`Backlog task ${task} was not found.`, 404);
      }
    }
    const entry = await this.candidate(args.worktree);
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
        capabilities: this.host.capabilities,
        author,
        requested: requested ?? null,
      });
    } else
      routed = resolveProvider({
        role: 'delivery',
        settings,
        capabilities: this.host.capabilities,
        requested: requested ?? null,
      });
    // Reserve the slot before any await that could let a second delegation pass the limit check.
    const placeholder = { status: 'starting' };
    const key = Symbol('pending');
    this.workers.set(key, placeholder);
    let pendingToken;
    try {
      if (kind === 'review') this.reviewRounds.set(task, reviewRound);
      const workerDirectory = await this.host.ensureDirectory(
        this.directory,
        'workers',
        `${task}-${kind}-${Date.now()}`,
      );
      const stateDir = this.context.stateDir;
      const temporaryRoot = await this.host.ensureDirectory(workerDirectory, 'tmp');
      const write = kind === 'deliver';
      // Each worker gets its own token, valid only for the suite lock while it runs.
      const workerId = randomUUID();
      const workerToken = randomBytes(32).toString('hex');
      const suiteServer = this.serverFor(workerToken, 'suite');
      const suiteConfigPath = path.join(workerDirectory, 'mcp.json');
      await this.writeMcpConfig(suiteConfigPath, suiteServer);
      this.workerTokens.set(workerToken, workerId);
      pendingToken = workerToken;
      const writableRoots = write
        ? [
            entry.path,
            this.context.governanceRoot,
            ...['operations', 'scratch', 'governance'].map(name => path.join(stateDir, name)),
            path.join(this.gitBridge.channelPath, 'requests'),
          ]
        : [];
      const opened = await this.host.openSession({
        id: workerId,
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
        cwd: entry.path,
        sandbox: write ? 'workspace-write' : 'read-only',
        writableRoots,
        temporaryRoot,
        runDirectory: workerDirectory,
        signal: this.signal,
        gitHelperPath: write ? this.gitBridge.helperPath : undefined,
        mcpServers: { switchflow: suiteServer },
        mcpConfigPath: suiteConfigPath,
        approval: write ? APPROVAL.drafting : null,
        forward: async () => {},
      });
      const worker = {
        id: opened.meta.id,
        task,
        kind,
        provider: routed.provider,
        worktree: entry.path,
        reviewRound,
        meta: opened.meta,
        handle: opened.handle,
        status: 'working',
        result: null,
        error: null,
        reported: true,
        queue: [],
        token: workerToken,
        schemaPath: path.join(this.directory, `${kind}-schema.json`),
        approval: write ? APPROVAL.drafting : null,
      };
      opened.handle.followUp = (message, { confirm = false, by = 'orchestrator' } = {}) =>
        this.startTurn(worker, message, { confirm, by });
      opened.handle.enqueue = message => worker.queue.push(message);
      // The host reads the gate when a message asks to confirm.
      Object.defineProperty(opened.handle, 'approval', { get: () => worker.approval, configurable: true });
      this.workers.delete(key);
      this.workers.set(worker.id, worker);
      if (write) this.authors.set(task, routed.provider);
      await this.startTurn(
        worker,
        workerPrompt({
          kind,
          task,
          worktree: entry.path,
          candidate: entry.name,
          governanceRoot: this.context.governanceRoot,
          gitBridge: this.gitBridge,
          instructions,
        }),
      );
      return { ...this.summary(worker), fallback: routed.fallback };
    } finally {
      this.workers.delete(key);
      // A worker that never opened must not leave a usable token behind.
      if (pendingToken && !this.workers.has(this.workerTokens.get(pendingToken)))
        this.workerTokens.delete(pendingToken);
    }
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
        }
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
          worker.status = 'idle';
          await this.host.registry.update(worker.id, { status: 'idle' });
          await this.flushQueue(worker);
        } else await this.finishWorker(worker, this.signal?.aborted || this.closed ? 'cancelled' : 'failed');
      })
      .finally(() => this.host.registry.wake());
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
    worker.status = status;
    worker.closedStatus = status;
    worker.queue = [];
    this.workerTokens.delete(worker.token);
    this.host.releaseSuiteLock(worker.id);
    await this.host.closeSession(worker.meta, worker.handle, {
      status,
      error: status === 'completed' ? null : worker.error,
      result: worker.result,
    });
  }
  summary(worker) {
    const meta = this.host.registry.get(worker.id)?.meta ?? worker.meta;
    return {
      workerId: worker.id,
      task: worker.task,
      kind: worker.kind,
      provider: worker.provider,
      worktree: worker.worktree,
      reviewRound: worker.reviewRound,
      status: worker.status,
      approval: worker.approval,
      writable: worker.kind === 'deliver' && worker.approval === APPROVAL.confirmed,
      ...(worker.approval === APPROVAL.awaiting && worker.status === 'idle' ? { note: AWAITING_NOTE } : {}),
      lastTurn: meta.lastTurn ?? null,
      lastMessage: meta.lastMessage ?? null,
      usage: meta.usage ?? null,
      result: worker.result,
      error: worker.error,
    };
  }
  realWorkers() {
    return [...this.workers.values()].filter(worker => worker.id);
  }

  async worker_status(args) {
    this.fields(args, [], ['workerId']);
    const workers = args.workerId ? [this.worker(args.workerId)] : this.realWorkers();
    for (const worker of workers) if (worker.status !== 'working') worker.reported = true;
    return { workers: workers.map(worker => this.summary(worker)) };
  }
  async send_to_worker(args) {
    this.fields(args, ['workerId', 'message'], ['mode', 'confirm']);
    const worker = this.worker(args.workerId);
    if (FINISHED.has(worker.status)) throw new ControlError('This worker has finished. Delegate again.', 409);
    return this.host.deliver(worker.id, args.message, 'orchestrator', args.mode ?? 'steer', {
      confirm: args.confirm,
    });
  }
  async acquire_suite_lock(args, principal) {
    this.fields(args, [], ['timeoutSeconds']);
    const seconds = args.timeoutSeconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 50)
      throw new ControlError('timeoutSeconds must be 1–50. Call again to keep waiting.');
    const holder = principal === 'orchestrator' ? this.orchestratorId || 'orchestrator' : principal;
    return this.host.acquireSuiteLock(holder, seconds * 1000, this.signal);
  }
  async release_suite_lock(args, principal) {
    this.fields(args, []);
    return this.host.releaseSuiteLock(principal === 'orchestrator' ? this.orchestratorId || 'orchestrator' : principal);
  }
  async interrupt_worker(args) {
    this.fields(args, ['workerId']);
    const worker = this.worker(args.workerId);
    const interrupted = worker.status === 'working' && (await worker.handle.interrupt({ by: 'orchestrator' }));
    return { workerId: worker.id, interrupted: Boolean(interrupted) };
  }
  /** Returns when a listed worker finishes a turn not yet reported, or none is still working. */
  async wait_for_workers(args) {
    this.fields(args, [], ['workerIds', 'timeoutSeconds']);
    const ids = args.workerIds ?? this.realWorkers().map(worker => worker.id);
    if (!Array.isArray(ids) || ids.length > 50) throw new ControlError('workerIds must be a list.');
    const workers = ids.map(id => this.worker(id));
    const seconds = args.timeoutSeconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 50)
      throw new ControlError('timeoutSeconds must be 1–50. Call again to keep waiting.');
    const ready = () =>
      workers.some(worker => worker.status !== 'working' && !worker.reported) ||
      workers.every(worker => worker.status !== 'working');
    const done = await this.host.registry.waitFor(ready, seconds * 1000, this.signal);
    for (const worker of workers) if (worker.status !== 'working') worker.reported = true;
    return { timedOut: !done, workers: workers.map(worker => this.summary(worker)) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.host.orchestrations.delete(this.runId);
    this.host.releaseSuiteLock(this.orchestratorId || 'orchestrator');
    await Promise.allSettled(
      this.realWorkers().map(worker =>
        this.finishWorker(worker, worker.status === 'working' ? 'cancelled' : 'completed'),
      ),
    );
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
