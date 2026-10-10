// One compact read for the native UI (status line, approval band, pane): initiatives with the
// owner decision each one waits on, the active run's workers, capacity, environments and holds.
// Presentation only, like overview-model.js: these entries never grant execution authority.
import { createHash } from 'node:crypto';
import { runPresentation } from './public/overview-model.js';

const CACHE_MS = 1000;
// Coarse enough that the version does not move with every page of memory the machine frees.
const MEMORY_STEP_GB = 0.5;
const LINE = 200;
const health = new WeakMap();
const summaryCache = new WeakMap();

const isRunning = (item, activeRun) =>
  item.status === 'running' || item.pending === true || activeRun?.initiativeId === item.id;
const plural = (count, one, many) => (count === 1 ? one : many);

/**
 * The owner decision an initiative waits on, from the same rules app.js renderDetail uses to draw
 * its action buttons. Returns null while nothing is the owner's to do (for example while an agent
 * is working). actions[].needs names the payload field the action requires, if any.
 */
export function needsOwner(item, activeRun) {
  const recoveryHold = activeRun?.status === 'interrupted' && activeRun?.initiativeId === item.id;
  const running = isRunning(item, activeRun);
  const actions = [];
  let kind = null;
  let label = '';
  const set = (nextKind, nextLabel) => {
    if (kind) return;
    kind = nextKind;
    label = nextLabel;
  };
  if (recoveryHold) {
    // Older state has no list; its hold is one unidentified stage process.
    const held = activeRun.held || [{ kind: 'stage', role: item.stage, pid: null, state: 'unknown' }];
    const live = held.filter(entry => entry.state === 'running').length;
    set('recovery', 'Stop or confirm the agent processes left by the interrupted run.');
    if (live)
      actions.push({
        action: 'stop-processes',
        label: `Stop ${live === 1 ? 'the running process' : `the ${live} running processes`}`,
      });
    // The browser shows Release disabled until the running processes have stopped.
    else if (held.length)
      actions.push({ action: 'recover-run', label: 'Release recovery hold', needs: 'confirmedStopped' });
  }
  if (!running && item.questions?.length) {
    set(
      'questions',
      `Answer ${item.questions.length === 1 ? 'the outstanding question' : `the ${item.questions.length} outstanding questions`}.`,
    );
    actions.push({ action: 'answer', label: 'Send answers', needs: 'answers' });
  }
  const heldWorkers = Array.isArray(item.heldWorkers?.workers) ? item.heldWorkers.workers : [];
  if (
    !recoveryHold &&
    heldWorkers.length &&
    item.stage === 'delivery' &&
    ['failed', 'cancelled', 'blocked'].includes(item.status)
  ) {
    const count = heldWorkers.length;
    set(
      'held-workers',
      `${count === 1 ? 'One worker was' : `${count} workers were`} in flight when the service stopped.`,
    );
    actions.push({
      action: 'resume-workers',
      label: `Resume ${count === 1 ? 'held worker' : `${count} held workers`}`,
    });
  }
  const environmentHold =
    !recoveryHold &&
    item.stage === 'delivery' &&
    item.status === 'blocked' &&
    Array.isArray(item.environmentHold?.environments) &&
    item.environmentHold.environments.length > 0;
  if (environmentHold) {
    set(
      'environment',
      `Delivery is waiting for ${item.environmentHold.environments.map(entry => entry.label || entry.id).join(', ')}.`,
    );
    actions.push({ action: 'retry', label: 'Test again' });
  }
  const normalGate = !running && !['failed', 'cancelled', 'blocked', 'complete'].includes(item.status);
  if (
    normalGate &&
    item.stage === 'intake' &&
    item.status === 'awaiting-human' &&
    item.scope &&
    !item.questions?.length
  ) {
    set('scope', 'Review the proposed scope.');
    actions.push(
      { action: 'request-changes', label: 'Request changes', needs: 'message' },
      { action: 'approve-scope', label: 'Approve scope & prepare plan' },
    );
  }
  if (
    normalGate &&
    item.stage === 'planning' &&
    item.status === 'awaiting-human' &&
    !item.questions?.length &&
    item.plan &&
    (!Array.isArray(item.plan) || item.plan.length)
  ) {
    set('plan', 'Review the proposed plan.');
    actions.push(
      { action: 'request-changes', label: 'Request changes', needs: 'message' },
      { action: 'approve-plan', label: 'Approve plan & start delivery' },
    );
  }
  if (item.status === 'idle' && !running && item.stage === 'intake' && !item.scope && !item.questions?.length) {
    set('start', 'Start intake.');
    actions.push({ action: 'start', label: 'Start intake' });
  }
  if (!recoveryHold && !environmentHold && ['failed', 'cancelled', 'blocked'].includes(item.status)) {
    set('retry', `Review ${item.status} work before any retry.`);
    actions.push({ action: 'retry', label: 'Retry from the current checkpoint' });
  }
  if (item.stage === 'uat' && normalGate && !item.approvedUat) {
    set('uat', 'Try the delivered candidate and record your acceptance checks.');
    actions.push({ action: 'request-rework', label: 'Request rework', needs: 'feedback' });
    // Without guided checks the browser offers rework only.
    if (Array.isArray(item.uat) && item.uat.length)
      actions.push({ action: 'accept-uat', label: 'Accept delivered outcome', needs: 'results' });
  }
  return kind ? { kind, label, actions } : null;
}

/** One line for a worker's latest event, worded like the Agents view feed. */
export function eventLine(event) {
  if (!event) return null;
  const kind = event.kind || event.type;
  const text =
    kind === 'command'
      ? `$ ${event.command || event.text || ''}`
      : kind === 'tool'
        ? [event.name, event.summary].filter(Boolean).join(' · ') || event.text || kind
        : event.text ||
          {
            'session.started': 'Session started',
            'turn.started': 'Turn started',
            'turn.completed': 'Turn finished',
            'turn.failed': `Turn failed${event.error ? `: ${event.error}` : ''}`,
            interrupt: event.by === 'orchestrator' ? 'Stopped by the orchestrator' : 'Stopped',
            'session.closed': 'Session closed',
          }[kind] ||
          kind;
  const line =
    String(text)
      .split(/\r?\n/)
      .find(part => part.trim()) || '';
  return line.length > LINE ? `${line.slice(0, LINE - 1)}…` : line;
}

/** Records the result of an environment test (POST /api/agents/environments/<id>/test). */
export function rememberHealth(session, result) {
  if (!result?.id) return;
  if (!health.has(session)) health.set(session, new Map());
  health.get(session).set(result.id, {
    ok: result.ok === true,
    reason: result.ok ? null : result.reason || 'Not ready.',
    checkedAt: result.checkedAt,
  });
  summaryCache.delete(session);
}

function lastHealth(session, state) {
  const known = new Map(health.get(session) || []);
  // A delivery held for its environments is a health check too; keep whichever is newer.
  for (const item of state.initiatives)
    for (const entry of item.environmentHold?.environments || []) {
      const checkedAt = item.environmentHold.checkedAt;
      const previous = known.get(entry.id);
      if (!previous || Date.parse(previous.checkedAt) < Date.parse(checkedAt))
        known.set(entry.id, { ok: false, reason: entry.reason || 'Not ready.', checkedAt });
    }
  return known;
}

const round = value =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value / MEMORY_STEP_GB) * MEMORY_STEP_GB : null;

function holdsOf(state, settings) {
  const holds = [];
  const run = state.activeRun;
  if (run?.status === 'interrupted') {
    const held = run.held || [];
    holds.push({
      kind: 'recovery',
      initiativeId: run.initiativeId,
      reason: `The service stopped while ${held.length ? `${held.length} agent ${plural(held.length, 'process was', 'processes were')}` : 'an agent process was'} open. No new work starts until they have stopped.`,
      processes: held.map(entry => ({
        kind: entry.kind,
        role: entry.role,
        task: entry.task ?? null,
        sessionId: entry.sessionId ?? null,
        state: entry.state,
      })),
    });
  }
  for (const item of state.initiatives) {
    const workers = Array.isArray(item.heldWorkers?.workers) ? item.heldWorkers.workers : [];
    if (workers.length)
      holds.push({
        kind: 'held-workers',
        initiativeId: item.id,
        reason:
          item.heldWorkers.blocked ||
          `${workers.length === 1 ? 'One worker was' : `${workers.length} workers were`} in flight when the service stopped: ${workers.map(worker => `${worker.task} ${worker.kind === 'review' ? 'review' : 'delivery'}`).join(', ')}.`,
        workers: workers.map(worker => worker.workerId),
      });
    if (item.status === 'blocked' && item.environmentHold?.environments?.length)
      holds.push({
        kind: 'environment',
        initiativeId: item.id,
        reason: item.environmentHold.environments
          .map(entry => `${entry.label || entry.id} is not ready (${entry.reason || 'Not ready.'})`)
          .join('; '),
        environments: item.environmentHold.environments.map(entry => entry.id),
      });
  }
  if (settings?.pauseLocalWorkers === true)
    holds.push({
      kind: 'paused',
      reason: 'Local workers are paused. Running ones continue; new ones wait until you resume.',
    });
  return holds;
}

export const versionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The whole summary of one project session (see server.mjs createControlServer). */
export async function buildSummary(session, state) {
  const { engine, agents, project } = session;
  const listed = await agents.list();
  state ??= await engine.read();
  const run = state.activeRun;
  const settings = listed.settings || {};
  const heldIds = new Set([
    ...(run?.held || []).map(entry => entry.sessionId).filter(Boolean),
    ...state.initiatives.flatMap(item => (item.heldWorkers?.workers || []).map(worker => worker.workerId)),
  ]);
  const initiatives = state.initiatives.map(item => ({
    id: item.id,
    title: item.title,
    stage: item.stage,
    status: item.status,
    label: runPresentation(item, run).label,
    revision: item.revision,
    ...(item.questions?.length ? { questions: item.questions.map(q => ({ id: q.id, prompt: q.prompt })) } : {}),
    needsOwner: needsOwner(item, run),
  }));
  const workers = run
    ? listed.sessions
        .filter(entry => entry.runId === run.id)
        .map(entry => ({
          id: entry.id,
          role: entry.role,
          kind: entry.kind,
          task: entry.task ?? null,
          provider: entry.provider,
          environment: entry.environment ?? 'local',
          status: entry.status,
          approval: entry.approval ?? null,
          lastEvent:
            eventLine(agents.registry?.get(entry.id)?.events?.at(-1)) ??
            eventLine(entry.error ? { kind: 'turn.failed', error: entry.error } : null) ??
            eventLine(entry.lastMessage ? { kind: 'message', text: entry.lastMessage } : null),
          held: heldIds.has(entry.id),
        }))
    : [];
  const capacity = listed.capacity || {};
  const healthById = lastHealth(session, state);
  return {
    projectId: project.id,
    project: { id: project.id, name: project.name },
    activeRun: run
      ? { id: run.id, initiativeId: run.initiativeId, stage: run.stage, status: run.status ?? 'running' }
      : null,
    initiatives,
    needsOwner: initiatives.filter(item => item.needsOwner).length,
    workers,
    capacity: {
      ...(capacity.error ? { error: capacity.error } : {}),
      memory: capacity.memory
        ? {
            admission: capacity.memory.admission,
            freeGB: round(capacity.memory.freeGB),
            totalGB: round(capacity.memory.totalGB),
            availableGB: round(Math.max(0, capacity.memory.availableGB ?? 0)),
          }
        : null,
      workers: capacity.workers || { admitted: 0, queued: 0, maxWorkers: null },
      queue: (capacity.queue || []).map(entry => ({
        workerId: entry.workerId,
        task: entry.task,
        kind: entry.kind,
        position: entry.position,
        reason: entry.reason,
      })),
      leases: (capacity.leases || []).length,
      pauseLocalWorkers: settings.pauseLocalWorkers === true,
    },
    environments: (listed.environments || []).map(environment => ({
      id: environment.id,
      kind: environment.kind,
      label: environment.label ?? environment.id,
      enabled: environment.enabled !== false,
      lastHealth: healthById.get(environment.id) ?? null,
    })),
    holds: holdsOf(state, settings),
    serviceError: engine.lastError || null,
  };
}

/**
 * The summary with its version. Pollers share one computation a second per project; a change to
 * the control state always computes afresh, so an owner action is never hidden by the cache.
 */
export async function projectSummary(session) {
  const state = await session.engine.read();
  const cached = summaryCache.get(session);
  if (cached && cached.revision === state.revision && Date.now() - cached.at < CACHE_MS) return cached.value;
  const summary = await buildSummary(session, state);
  const value = { version: versionOf(summary), ...summary };
  summaryCache.set(session, { at: Date.now(), revision: state.revision, value });
  return value;
}

/** Forget the cached summary, for example after a write that changes what it shows. */
export function invalidateSummary(session) {
  summaryCache.delete(session);
}

/** The headline stage of a project: what the active run works on, else the first decision waiting. */
function headline(state) {
  const run = state.activeRun;
  const item =
    (run && state.initiatives.find(entry => entry.id === run.initiativeId)) ||
    state.initiatives.find(entry => needsOwner(entry, run)) ||
    [...state.initiatives].reverse().find(entry => entry.stage !== 'complete');
  return item?.stage ?? null;
}

/** The all-projects roll-up for the status line: cheap, no capacity probe. */
export async function rollup(sessions, unavailable = []) {
  const projects = await Promise.all(
    sessions.map(async session => {
      try {
        const state = await session.engine.read();
        const live = [...(session.agents.registry?.live?.values() || [])];
        return {
          id: session.project.id,
          name: session.project.name,
          available: true,
          stage: headline(state),
          needsOwner: state.initiatives.filter(item => needsOwner(item, state.activeRun)).length,
          workers: live.filter(entry => ['deliver', 'review'].includes(entry.meta.kind)).length,
          activeRun: Boolean(state.activeRun),
        };
      } catch (error) {
        return { id: session.project.id, name: session.project.name, available: false, error: error.message };
      }
    }),
  );
  for (const entry of unavailable)
    projects.push({ id: entry.id, name: entry.name, available: false, error: entry.error });
  const body = {
    projects,
    needsOwner: projects.reduce((total, entry) => total + (entry.needsOwner || 0), 0),
    workers: projects.reduce((total, entry) => total + (entry.workers || 0), 0),
  };
  return { version: versionOf(body), ...body };
}
