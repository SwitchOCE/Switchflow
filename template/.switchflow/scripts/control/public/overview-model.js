import { initiativeTasks } from './initiative-tasks.js';
// Presentation only. These reasons never grant execution authority.
export function runPresentation(item, activeRun) {
  const run = activeRun?.initiativeId === item.id ? activeRun : null;
  if (run?.status === 'interrupted')
    return { label: 'Recovery hold', reason: 'The last run stopped unexpectedly. Check it before retrying.' };
  if (run?.status === 'running') return { label: 'Agent working', reason: 'Running now.' };
  if (item.pending) return { label: 'Queued', reason: 'Queued behind the current run.' };
  if (item.status === 'running')
    return {
      label: 'Run state unresolved',
      reason: 'Marked running, but no agent run is active.',
    };
  return {
    label:
      {
        'awaiting-human': 'Your review',
        idle: 'Ready',
        blocked: 'Blocked',
        failed: 'Run failed',
        cancelled: 'Cancelled',
        complete: 'Accepted',
      }[item.status] || item.status,
    reason: '',
  };
}
function taskRow(task, reason) {
  return { id: task.id, title: task.title, kind: 'task', reason };
}
function dependencyReason(task, tasks) {
  const ids = Array.isArray(task.dependencies) ? task.dependencies : [];
  const unmet = ids
    .map(
      id =>
        tasks.find(t => t.id?.toUpperCase() === String(id).toUpperCase()) || {
          id,
          title: 'Unavailable prerequisite',
          status: 'Unknown',
        },
    )
    .filter(t => String(t.status).toLowerCase() !== 'done');
  return unmet.length
    ? `Waiting for ${unmet.map(t => `${t.title} (${t.id}, ${t.status || 'Unknown'})`).join('; ')}.`
    : '';
}
export function approvedNextWork(initiatives, tasks) {
  const eligible = [],
    waiting = [];
  for (const item of initiatives.filter(i => i.stage === 'delivery' && i.approvedPlan)) {
    const unresolved = reason => waiting.push({ id: item.id, title: item.title, kind: 'initiative', reason });
    const plan = item.approvedPlan;
    if (!item.approvedScope?.hash || !plan.hash || plan.scopeHash !== item.approvedScope.hash) {
      unresolved('The approved plan no longer matches the approved scope. Re-approve the plan to continue.');
      continue;
    }
    const entries = Array.isArray(plan.tasks) ? plan.tasks : [];
    const ids = entries.map(entry => (typeof entry?.task === 'string' ? entry.task.trim().toUpperCase() : ''));
    if (!ids.length || ids.some(id => !/^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/.test(id)) || new Set(ids).size !== ids.length) {
      unresolved("The approved plan doesn't list exact task IDs in order, so the next task can't be picked.");
      continue;
    }
    const associated = initiativeTasks(item, tasks);
    const ordered = ids.map(id => associated.find(t => t.id?.toUpperCase() === id));
    if (ordered.some(t => !t)) {
      unresolved('A task named in the approved plan no longer exists.');
      continue;
    }
    const index = ordered.findIndex(t => String(t.status).toLowerCase() !== 'done');
    if (index < 0) continue;
    const task = ordered[index],
      dependency = dependencyReason(task, tasks);
    if (dependency) {
      waiting.push(taskRow(task, dependency));
      continue;
    }
    if (String(task.status).toLowerCase() !== 'ready' || task.blockReason) {
      waiting.push(
        taskRow(
          task,
          `Next in ${item.title}'s plan, but ${task.status || 'has no status'}${task.blockReason ? ` (${task.blockReason === 'dependent' ? 'waiting on a dependency' : task.blockReason})` : ''}. Later tasks wait for it.`,
        ),
      );
      continue;
    }
    eligible.push(
      taskRow(task, `Step ${index + 1} of ${item.title}'s approved plan. Earlier steps and prerequisites are done.`),
    );
  }
  return { eligible, waiting };
}
export function overviewGroups(state) {
  const initiatives = state?.initiatives || [],
    tasks = state?.tasks || [];
  const humanTasks = tasks.filter(
    t =>
      String(t.status).toLowerCase() === 'ready' &&
      (Array.isArray(t.assignee) ? t.assignee : [t.assignee]).some(a => String(a).toLowerCase() === 'human'),
  );
  const decisions = initiatives.filter(
    i =>
      !i.pending &&
      !['Agent working', 'Recovery hold'].includes(runPresentation(i, state.activeRun).label) &&
      ['awaiting-human', 'failed', 'blocked', 'cancelled'].includes(i.status),
  );
  const next = approvedNextWork(initiatives, tasks);
  const row = (i, reason) => ({ id: i.id, title: i.title, kind: 'initiative', reason });
  return {
    humanTasks,
    decisions,
    groups: [
      {
        title: 'Needs you',
        empty: 'Nothing needs you right now.',
        items: [
          ...decisions.map(i =>
            row(
              i,
              i.questions?.length
                ? 'Answer the outstanding questions.'
                : i.status === 'awaiting-human'
                  ? `Review the ${i.stage === 'uat' ? 'delivered candidate and acceptance checks' : i.stage === 'planning' ? 'proposed plan' : 'proposed scope'}.`
                  : `Review ${i.status} work before any retry.`,
            ),
          ),
          ...humanTasks.map(t => ({
            id: t.id,
            title: t.title,
            kind: 'task',
            reason: 'Your task, ready to start.',
          })),
        ],
      },
      {
        title: 'Running now',
        empty: 'No agent is running.',
        items: initiatives
          .filter(i => runPresentation(i, state.activeRun).label === 'Agent working')
          .map(i => row(i, 'Agent working on it now.')),
      },
      ...(tasks.some(t => String(t.status).toLowerCase() === 'in progress')
        ? [
            {
              title: 'Marked in progress',
              empty: '',
              items: tasks
                .filter(t => String(t.status).toLowerCase() === 'in progress')
                .map(t => taskRow(t, 'Status says In Progress, but no agent run is attached.')),
            },
          ]
        : []),
      {
        title: 'Up next',
        empty: 'No approved plan has a task ready to start.',
        items: next.eligible,
      },
      {
        title: 'Waiting',
        empty: 'Nothing is blocked.',
        items: [
          ...next.waiting,
          ...initiatives
            .filter(
              i =>
                i.pending ||
                ['Recovery hold', 'Run state unresolved'].includes(runPresentation(i, state.activeRun).label),
            )
            .map(i => row(i, runPresentation(i, state.activeRun).reason)),
          ...tasks
            .filter(
              t =>
                String(t.status).toLowerCase() === 'blocked' &&
                !next.waiting.some(r => r.kind === 'task' && r.id === t.id),
            )
            .map(t =>
              taskRow(
                t,
                dependencyReason(t, tasks) ||
                  (t.blockReason === 'dependent'
                    ? "Blocked by a dependency that can't be found."
                    : t.blockReason
                      ? `Blocked: ${t.blockReason}`
                      : 'Blocked, reason missing.'),
              ),
            ),
        ],
      },
    ],
  };
}
export function historyPage(records, page = 0, size = 10) {
  const total = records.length,
    pages = Math.max(1, Math.ceil(total / size));
  const index = Math.max(0, Math.min(page, pages - 1));
  return {
    items: [...records].reverse().slice(index * size, (index + 1) * size),
    index,
    pages,
    total,
    start: total ? index * size + 1 : 0,
    end: Math.min(total, (index + 1) * size),
  };
}

export function milestoneOrderSummary(milestones) {
  const unsequenced = milestones.filter(
    m =>
      m.executionOrder === null ||
      m.executionOrder === undefined ||
      m.executionOrder === '' ||
      !Number.isSafeInteger(Number(m.executionOrder)) ||
      Number(m.executionOrder) < 0,
  ).length;
  const orders = milestones
    .filter(m => m.executionOrder !== null && m.executionOrder !== undefined && m.executionOrder !== '')
    .map(m => Number(m.executionOrder));
  const tied = new Set(orders).size !== orders.length;
  if (!milestones.length) return 'No milestones yet.';
  if (unsequenced)
    return `${unsequenced} of ${milestones.length} milestones have no order yet, so they're listed alphabetically.`;
  if (tied) return 'Some milestones share an order number (ties). Planning decides which comes first.';
  return `${milestones.length} milestones are in planned order.`;
}

export function reworkReviewSummary(review) {
  const checks = Array.isArray(review.results) ? review.results : [];
  const observed = checks.filter(check => check.status !== 'pending' || !!check.notes?.trim());
  const unchecked = checks.filter(check => check.status === 'pending' && !check.notes?.trim());
  return {
    observed,
    unchecked,
    checked: checks.filter(check => ['passed', 'failed'].includes(check.status)).length,
    failed: checks.filter(check => check.status === 'failed').length,
    total: checks.length,
  };
}
