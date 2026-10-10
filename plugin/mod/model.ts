// Pure functions over the service's data: what the snapshot holds, what the status line
// says, which buttons the owner gets and which changes deserve a toast. No `$` here.
import type {
  SwitchflowAction,
  SwitchflowCapacity,
  SwitchflowEnvironment,
  SwitchflowFeedEvent,
  SwitchflowInitiative,
  SwitchflowNeed,
  SwitchflowSnapshot,
  SwitchflowWorker,
} from './types';

type Json = Record<string, any>;

export const STAGES: readonly [string, string][] = [
  ['intake', 'Intake'],
  ['planning', 'Planning'],
  ['delivery', 'Delivery'],
  ['uat', 'UAT'],
  ['complete', 'Complete'],
];
const stageLabel = (stage: string | null) => STAGES.find(([id]) => id === stage)?.[1] ?? stage ?? '';

// The open session states agents.js treats as live.
const LIVE = new Set(['starting', 'working', 'idle', 'running', 'waiting', 'queued']);
const DONE = new Set(['completed', 'complete']);
const STOPPED = new Set(['failed', 'interrupted', 'cancelled']);

export const statusLabel = (worker: SwitchflowWorker) =>
  worker.awaitingApproach
    ? 'approach ready'
    : ({
        starting: 'starting',
        working: 'working',
        idle: 'waiting',
        running: 'working',
        waiting: 'waiting',
        queued: 'queued',
        completed: 'done',
        complete: 'done',
        failed: 'failed',
        interrupted: 'stopped',
        cancelled: 'cancelled',
      }[worker.status] ?? worker.status);

export function emptySnapshot(service: 'down' | 'unregistered', reason: string): SwitchflowSnapshot {
  return {
    service,
    reason,
    projectId: null,
    projectName: null,
    stage: null,
    initiatives: [],
    runStatus: null,
    workers: [],
    environments: [],
    capacity: null,
    needs: [],
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Builds the snapshot from today's endpoints: GET /state and GET /agents. */
export function fromState(project: Json, state: Json, agents: Json | null): SwitchflowSnapshot {
  const run = state?.activeRun ?? null;
  const initiatives: SwitchflowInitiative[] = (Array.isArray(state?.initiatives) ? state.initiatives : []).map(
    (item: Json) => ({
      id: item.id,
      title: item.title || item.request || 'Untitled initiative',
      stage: item.stage,
      status: item.status,
      revision: Number.isInteger(item.revision) ? item.revision : null,
      isRunning: item.status === 'running' || item.pending === true || run?.initiativeId === item.id,
    }),
  );
  const settings = agents?.settings ?? {};
  const environmentsRaw: Json[] = Array.isArray(agents?.environments) ? agents.environments : [];
  const labelOf = (id: string) =>
    !id || id === 'local' ? 'This PC' : environmentsRaw.find(entry => entry.id === id)?.label || id;

  // Workers held by a recovery hold or a stopped delivery, by task and kind.
  const held = new Set<string>();
  for (const item of state?.initiatives ?? [])
    for (const worker of item.heldWorkers?.workers ?? []) held.add(`${worker.task}:${worker.kind}`);
  for (const entry of run?.held ?? []) if (entry.task) held.add(`${entry.task}:${entry.kind}`);

  const workers: SwitchflowWorker[] = (Array.isArray(agents?.sessions) ? agents.sessions : []).map((session: Json) => {
    const task = session.task || session.taskId || null;
    const kind = session.kind ?? 'stage';
    const title =
      session.title ||
      (kind === 'deliver'
        ? `Deliver ${task}`
        : kind === 'review'
          ? `Review ${task}`
          : `${stageLabel(session.role) || session.role || 'Agent'} agent`);
    const environment = session.environment || 'local';
    return {
      id: session.id,
      title,
      status: session.status,
      provider: session.provider ?? '',
      kind,
      task,
      environment,
      environmentLabel: labelOf(environment),
      initiativeId: session.initiativeId ?? null,
      isLive: LIVE.has(session.status),
      isHeld: Boolean(task) && held.has(`${task}:${kind === 'review' ? 'review' : kind}`),
      awaitingApproach: session.approval === 'awaiting-confirmation' && session.status === 'idle',
      canSteer: session.canSteer ?? LIVE.has(session.status),
      canInterrupt: session.canInterrupt ?? LIVE.has(session.status),
    };
  });

  const holds = new Map<string, string>();
  for (const item of state?.initiatives ?? [])
    if (item.stage === 'delivery' && item.status === 'blocked')
      for (const entry of item.environmentHold?.environments ?? []) holds.set(entry.id, entry.reason || 'Not ready.');
  const environments: SwitchflowEnvironment[] = environmentsRaw.map(entry => ({
    id: entry.id,
    label: entry.id === 'local' ? 'This PC' : entry.label || entry.id,
    kind: entry.kind ?? 'local',
    holdReason: holds.get(entry.id) ?? null,
  }));

  const capacityRaw = agents?.capacity;
  const capacity: SwitchflowCapacity | null =
    capacityRaw && !capacityRaw.error
      ? {
          running: capacityRaw.workers?.admitted ?? 0,
          queued: capacityRaw.workers?.queued ?? 0,
          maxWorkers: capacityRaw.workers?.maxWorkers ?? null,
          freeGB: capacityRaw.memory?.freeGB ?? null,
          totalGB: capacityRaw.memory?.totalGB ?? null,
          isPaused: settings.pauseLocalWorkers === true,
          settingsRevision: Number.isInteger(settings.revision) ? settings.revision : null,
        }
      : null;

  const open = initiatives.filter(item => item.stage !== 'complete');
  const stage = run
    ? (initiatives.find(item => item.id === run.initiativeId)?.stage ?? run.stage ?? null)
    : (open.at(-1)?.stage ?? null);

  return {
    service: 'up',
    reason: null,
    projectId: project.id,
    projectName: project.name ?? null,
    stage,
    initiatives,
    runStatus: run ? (run.status ?? 'running') : null,
    workers,
    environments,
    capacity,
    needs: [...ownerNeeds(state), ...approachNeeds(workers)],
  };
}

/** The decisions the browser's detail sheet offers, initiative by initiative (app.js renderDetail). */
export function ownerNeeds(state: Json): SwitchflowNeed[] {
  const needs: SwitchflowNeed[] = [];
  const run = state?.activeRun ?? null;
  for (const item of state?.initiatives ?? []) {
    const title = item.title || item.request || 'Untitled initiative';
    const running = item.status === 'running' || item.pending === true || run?.initiativeId === item.id;
    const action = (name: string, label: string, extra: Partial<SwitchflowAction> = {}): SwitchflowAction => ({
      key: `${item.id}:${name}`,
      label,
      target: 'initiative',
      action: name,
      initiativeId: item.id,
      ...extra,
    });
    const recoveryHold = run?.status === 'interrupted' && run?.initiativeId === item.id;
    const heldWorkers: Json[] = Array.isArray(item.heldWorkers?.workers) ? item.heldWorkers.workers : [];
    if (recoveryHold) {
      // Older state has no list; its hold is one unidentified stage process.
      const held: Json[] = run.held || [{ kind: 'stage', role: item.stage, pid: null, state: 'unknown' }];
      const live = held.filter(entry => entry.state === 'running').length;
      const actions: SwitchflowAction[] = [];
      if (live)
        actions.push(
          action('stop-processes', `Stop ${live === 1 ? 'the running process' : `the ${live} running processes`}`, {
            primary: true,
          }),
        );
      // The browser keeps Release disabled until nothing is running.
      else
        actions.push(
          action('recover-run', 'Release recovery hold', {
            payload: { confirmedStopped: true },
            confirm: 'I have checked that the unconfirmed processes have stopped.',
            primary: true,
          }),
        );
      needs.push({
        key: `${item.id}:recovery`,
        kind: 'recovery',
        title,
        context: `Run held: ${plural(held.length, 'agent process', 'agent processes')} left open when the service stopped.`,
        actions,
      });
      continue;
    }
    if (heldWorkers.length && item.stage === 'delivery' && ['failed', 'cancelled', 'blocked'].includes(item.status)) {
      const count = heldWorkers.length;
      needs.push({
        key: `${item.id}:held-workers`,
        kind: 'held-workers',
        title,
        context: `${count === 1 ? 'One worker was' : `${count} workers were`} in flight when the service stopped.`,
        actions: [action('resume-workers', `Resume ${count === 1 ? 'held worker' : `${count} held workers`}`)],
      });
    }
    const environmentHold =
      item.stage === 'delivery' && item.status === 'blocked' && item.environmentHold?.environments?.length
        ? item.environmentHold
        : null;
    if (environmentHold) {
      const names = environmentHold.environments.map((entry: Json) => entry.label || entry.id).join(', ');
      needs.push({
        key: `${item.id}:environment`,
        kind: 'environment',
        title,
        context: `Delivery held: ${names} not ready. ${environmentHold.environments[0]?.reason || ''}`.trim(),
        actions: [action('retry', 'Test again', { primary: true })],
      });
    }
    const normalGate = !running && !['failed', 'cancelled', 'blocked', 'complete'].includes(item.status);
    const hasQuestions = Boolean(item.questions?.length);
    if (normalGate && hasQuestions && item.status === 'awaiting-human')
      needs.push({
        key: `${item.id}:questions`,
        kind: 'questions',
        title,
        context: `${plural(item.questions.length, 'question')} to answer. Open the board to reply.`,
        actions: [],
      });
    if (normalGate && item.stage === 'intake' && item.status === 'awaiting-human' && item.scope && !hasQuestions)
      needs.push({
        key: `${item.id}:scope`,
        kind: 'scope',
        title,
        context: 'Scope ready for your approval. Approving prepares a plan.',
        actions: [
          action('approve-scope', 'Approve scope', { primary: true }),
          action('request-changes', 'Request changes', {
            input: { payloadKey: 'message', label: 'What should change in this scope?' },
          }),
        ],
      });
    const plan = item.plan;
    if (
      normalGate &&
      item.stage === 'planning' &&
      item.status === 'awaiting-human' &&
      !hasQuestions &&
      plan &&
      (!Array.isArray(plan) || plan.length)
    )
      needs.push({
        key: `${item.id}:plan`,
        kind: 'plan',
        title,
        context: 'Plan ready for your approval. Approving starts delivery.',
        actions: [
          action('approve-plan', 'Approve plan', { primary: true }),
          action('request-changes', 'Request changes', {
            input: { payloadKey: 'message', label: 'What should change in this plan?' },
          }),
        ],
      });
    if (item.stage === 'uat' && normalGate && !item.approvedUat) {
      const checks = (Array.isArray(item.uat) ? item.uat : []).map((entry: Json | string, index: number) =>
        typeof entry === 'string' ? { id: `uat-${index + 1}` } : entry,
      );
      const actions: SwitchflowAction[] = [];
      // Accepting needs every guided check passed (app.js renderUat); with none, only rework is offered.
      if (checks.length)
        actions.push(
          action('accept-uat', 'Accept UAT', {
            payload: { results: checks.map((check: Json) => ({ id: check.id, status: 'passed', notes: '' })) },
            confirm: `I tried ${checks.length === 1 ? 'the check' : `all ${checks.length} checks`} and ${checks.length === 1 ? 'it passed' : 'they passed'}.`,
            primary: true,
          }),
        );
      actions.push(
        action('request-rework', 'Request rework', {
          input: { payloadKey: 'feedback', label: 'What should change?' },
        }),
      );
      needs.push({
        key: `${item.id}:uat`,
        kind: 'uat',
        title,
        context: checks.length
          ? `Ready for acceptance: ${plural(checks.length, 'check')} to try.`
          : 'Ready for acceptance, but no guided checks yet. Request rework for an update.',
        actions,
      });
    }
  }
  return needs;
}

/** Delivery workers whose approach waits on the owner (agents.js composer's confirm box). */
export function approachNeeds(workers: SwitchflowWorker[]): SwitchflowNeed[] {
  return workers
    .filter(worker => worker.awaitingApproach)
    .map(worker => ({
      key: `${worker.id}:approach`,
      kind: 'approach' as const,
      title: worker.title,
      context: 'Approach ready. Confirming lets the worker edit.',
      actions: [
        {
          key: `${worker.id}:confirm`,
          label: 'Confirm approach',
          target: 'steer' as const,
          action: 'confirm',
          sessionId: worker.id,
          payload: { message: 'Approach confirmed. Go ahead.', confirm: true },
          primary: true,
        },
      ],
    }));
}

export function statusText(snapshot: SwitchflowSnapshot | null): string {
  if (!snapshot) return 'SF ▸ connecting…';
  if (snapshot.service === 'down') return 'SF ▸ service not running';
  if (snapshot.service === 'unregistered') return 'SF ▸ project not registered';
  const parts = [snapshot.stage ? stageLabel(snapshot.stage) : 'Idle'];
  const live = snapshot.workers.filter(worker => worker.isLive).length;
  if (live) parts.push(plural(live, 'worker'));
  if (snapshot.runStatus === 'interrupted') parts.push('run held');
  const owner = snapshot.needs.filter(need => need.kind !== 'questions' || need.actions.length).length;
  const questions = snapshot.needs.length - owner;
  if (owner) parts.push(`${owner} needs you`);
  if (questions) parts.push(plural(questions, 'question'));
  return `SF ▸ ${parts.join(' · ')}`;
}

/** What changed between two polls that the owner would want to hear about. */
export function transitions(previous: SwitchflowSnapshot | null, next: SwitchflowSnapshot): string[] {
  if (!previous) return [];
  const toasts: string[] = [];
  if (previous.service === 'up' && next.service === 'down') toasts.push('Switchflow: the service stopped responding.');
  if (next.service !== 'up' || previous.service !== 'up') return toasts;
  const before = new Map(previous.workers.map(worker => [worker.id, worker]));
  for (const worker of next.workers) {
    const was = before.get(worker.id);
    if (!was || !was.isLive) continue;
    if (DONE.has(worker.status)) toasts.push(`Switchflow: ${worker.title} finished.`);
    else if (STOPPED.has(worker.status)) toasts.push(`Switchflow: ${worker.title} ${statusLabel(worker)}.`);
  }
  if (previous.runStatus !== 'interrupted' && next.runStatus === 'interrupted')
    toasts.push('Switchflow: the run is held. Release the recovery hold to continue.');
  const heldBefore = new Set(previous.environments.filter(env => env.holdReason).map(env => env.id));
  for (const env of next.environments)
    if (env.holdReason && !heldBefore.has(env.id))
      toasts.push(`Switchflow: ${env.label} is not ready. ${env.holdReason}`);
  const needsBefore = new Set(previous.needs.map(need => need.key));
  for (const need of next.needs) {
    // Recovery and environment holds have their own toasts above.
    if (needsBefore.has(need.key) || need.kind === 'recovery' || need.kind === 'environment') continue;
    if (need.kind === 'scope' || need.kind === 'plan' || need.kind === 'uat')
      toasts.push(`Switchflow: review ready. ${need.title}: ${need.context}`);
    else toasts.push(`Switchflow: needs you. ${need.title}: ${need.context}`);
  }
  return toasts;
}

/** Workers grouped by where they run, This PC first, each group newest-live first. */
export function workersByEnvironment(workers: SwitchflowWorker[]): [string, SwitchflowWorker[]][] {
  const groups = new Map<string, SwitchflowWorker[]>();
  for (const worker of workers) {
    const list = groups.get(worker.environmentLabel) ?? [];
    list.push(worker);
    groups.set(worker.environmentLabel, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'This PC' ? -1 : b === 'This PC' ? 1 : a.localeCompare(b)))
    .map(([label, list]) => [label, [...list].sort((a, b) => Number(b.isLive) - Number(a.isLive))]);
}

/** One line of the stage track: done stages ticked, the current one bracketed. */
export function stageTrack(stage: string): string {
  const index = STAGES.findIndex(([id]) => id === stage);
  return STAGES.map(([, label], at) => (at < index ? `${label} ✓` : at === index ? `[${label}]` : label)).join(' › ');
}

export function feedEvent(event: Json): SwitchflowFeedEvent {
  const kind = event.kind || event.type || 'note';
  const by = event.by || event.source || (kind === 'steer' ? 'owner' : null);
  let text: string;
  if (kind === 'message' || kind === 'steer') text = String(event.text || '');
  else if (kind === 'command') text = `\`$ ${event.command || event.text || ''}\``;
  else if (kind === 'file_change') text = `\`± ${(event.paths || []).join(', ') || event.text || ''}\``;
  else if (kind === 'tool')
    text = `\`⚙ ${[event.name, event.summary].filter(Boolean).join(' · ') || event.text || kind}\``;
  else
    text =
      event.text ||
      {
        'session.started': 'Session started',
        'turn.started': 'Turn started',
        'turn.completed': 'Turn finished',
        'turn.failed': `Turn failed${event.error ? `: ${event.error}` : ''}`,
        interrupt: 'Stopped',
        'session.closed': 'Session closed',
      }[kind as string] ||
      kind;
  return { seq: Number(event.seq) || 0, kind, text, by };
}

/** The feed as one Markdown text, newest last. */
export function feedMarkdown(events: SwitchflowFeedEvent[]): string {
  if (!events.length) return '_No events yet._';
  return events
    .map(event =>
      event.kind === 'message' || event.kind === 'steer'
        ? `**${event.by === 'owner' ? 'You' : event.by === 'orchestrator' ? 'Orchestrator' : 'Agent'}:** ${event.text}`
        : ['command', 'file_change', 'tool'].includes(event.kind)
          ? event.text
          : `_${event.text}_`,
    )
    .join('\n\n');
}
