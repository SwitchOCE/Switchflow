import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const statuses = ['Backlog', 'Blocked', 'Ready', 'In Progress', 'Review', 'Done'];

export function buildFlowSnapshot(tasks, blockedViews = new Map()) {
  const parentIds = new Set(tasks.map(task => task.parentTaskId).filter(Boolean));
  const isParent = task => parentIds.has(task.id) || (task.labels ?? []).includes('coordination');
  const isDiscovery = task => (task.labels ?? []).includes('discovery');
  const summarize = task => ({
    id: task.id, title: task.title, status: task.status,
    assignees: task.assignees ?? [], updatedAt: task.updatedAt ?? null,
  });
  const workers = tasks.filter(task => !isParent(task) && !isDiscovery(task));
  return {
    queues: Object.fromEntries(statuses.map(status => [status, workers.filter(task => task.status === status).map(summarize)])),
    coordination: tasks.filter(task => isParent(task) && !isDiscovery(task)).map(summarize),
    discovery: tasks.filter(isDiscovery).map(summarize),
    blocked: workers.filter(task => task.status === 'Blocked').map(task => {
      const view = blockedViews.get(task.id);
      return { ...summarize(task), dependencies: view?.dependencies ?? [], waitingNotes: view?.implementationNotes ?? null };
    }),
    recent: [...tasks].filter(task => task.updatedAt).sort((a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)
    ).slice(0, 10).map(summarize),
  };
}

export function renderFlow(snapshot) {
  const lines = ['Worker queues (recorded status; not a readiness verdict)'];
  for (const [status, tasks] of Object.entries(snapshot.queues)) {
    lines.push(`\n${status}: ${tasks.length}`);
    if (status !== 'Done') for (const task of tasks) lines.push(`- ${task.title} [${task.id}]${task.assignees.length ? ` — ${task.assignees.join(', ')}` : ''}`);
  }
  lines.push('\nBlocked details');
  for (const task of snapshot.blocked) {
    lines.push(`- ${task.title} [${task.id}]`);
    if (task.dependencies.length) lines.push(`  Dependencies: ${task.dependencies.join(', ')}`);
    lines.push(task.waitingNotes ? `  ${task.waitingNotes.replace(/\n/g, '\n  ')}` : '  Waiting reason, unblock owner and resume condition not recorded in implementation notes; inspect task comments.');
  }
  lines.push(`\nCoordination parents: ${snapshot.coordination.length}`);
  for (const task of snapshot.coordination) lines.push(`- ${task.title}: ${task.status} [${task.id}]`);
  lines.push(`\nDiscovery records (not delivery): ${snapshot.discovery.length}`);
  for (const task of snapshot.discovery) lines.push(`- ${task.title}: ${task.status} [${task.id}]`);
  lines.push('\nRecently updated records (not a transition log)');
  for (const task of snapshot.recent) lines.push(`- ${task.updatedAt} — ${task.title}: ${task.status} [${task.id}]`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cliPath, root, ...args] = process.argv.slice(2);
  if (!cliPath || !root || args.some(arg => arg !== '--json') || args.length > 1) {
    console.error('Usage: backlog.ps1 flow [--json]');
    process.exitCode = 1;
  } else {
    const read = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }));
    const { tasks } = read(['task', 'list', '--json']);
    const blockedViews = new Map(tasks.filter(task => task.status === 'Blocked').map(task =>
      [task.id, read(['task', 'view', task.id, '--json']).task]
    ));
    const snapshot = buildFlowSnapshot(tasks, blockedViews);
    console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : renderFlow(snapshot));
  }
}
