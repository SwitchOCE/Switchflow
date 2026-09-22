import { initiativeTasks } from './initiative-tasks.js';
// Presentation only. These reasons never grant execution authority.
export function runPresentation(item, activeRun) {
  const run = activeRun?.initiativeId === item.id ? activeRun : null;
  if (run?.status === 'interrupted') return { label: 'Recovery hold', reason: 'A prior process needs recovery checks.' };
  if (run?.status === 'running') return { label: 'Agent working', reason: 'The runtime records an active run.' };
  if (item.pending) return { label: 'Queued', reason: 'Waiting for agent admission.' };
  if (item.status === 'running') return { label: 'Run state unresolved', reason: 'The initiative says running, but no active runtime run is recorded.' };
  return { label: ({'awaiting-human':'Your review',idle:'Ready',blocked:'Blocked',failed:'Run failed',cancelled:'Cancelled',complete:'Accepted'})[item.status] || item.status, reason: '' };
}
function taskRow(task,reason) { return {id:task.id,title:task.title,kind:'task',reason}; }
function dependencyReason(task,tasks) {
  const ids = Array.isArray(task.dependencies) ? task.dependencies : [];
  const unmet = ids.map(id => tasks.find(t => t.id?.toUpperCase() === String(id).toUpperCase()) || {id,title:'Unavailable prerequisite',status:'Unknown'}).filter(t => String(t.status).toLowerCase() !== 'done');
  return unmet.length ? `Waiting for ${unmet.map(t => `${t.title} (${t.id}, ${t.status || 'Unknown'})`).join('; ')}.` : '';
}
export function approvedNextWork(initiatives,tasks) {
  const eligible = [], waiting = [];
  for (const item of initiatives.filter(i => i.stage === 'delivery' && i.approvedPlan)) {
    const unresolved = reason => waiting.push({id:item.id,title:item.title,kind:'initiative',reason});
    const plan = item.approvedPlan;
    if (!item.approvedScope?.hash || !plan.hash || plan.scopeHash !== item.approvedScope.hash) {unresolved('Plan authority is unresolved: the approved plan must reference the current approved scope.');continue;}
    const entries = Array.isArray(plan.tasks) ? plan.tasks : [];
    const ids = entries.map(entry => typeof entry?.task === 'string' ? entry.task.trim().toUpperCase() : '');
    if (!ids.length || ids.some(id => !/^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/.test(id)) || new Set(ids).size !== ids.length) {unresolved('Next task is unresolved: the approved plan does not provide a unique ordered list of exact task IDs. Prose and display order are not execution evidence.');continue;}
    const associated = initiativeTasks(item,tasks);
    const ordered = ids.map(id => associated.find(t => t.id?.toUpperCase() === id));
    if (ordered.some(t => !t)) {unresolved('Next task is unresolved: an exact task named in the approved plan is unavailable.');continue;}
    const index = ordered.findIndex(t => String(t.status).toLowerCase() !== 'done');
    if (index < 0) continue;
    const task = ordered[index], dependency = dependencyReason(task,tasks);
    if (dependency) {waiting.push(taskRow(task,dependency));continue;}
    if (String(task.status).toLowerCase() !== 'ready' || task.blockReason) {waiting.push(taskRow(task,`First unfinished task in ${item.title}'s approved plan is ${task.status || 'Unspecified'}${task.blockReason ? `: ${task.blockReason === 'dependent' ? 'dependency clearance is not confirmed' : task.blockReason}` : ''}. Later tasks are not selected ahead of it.`));continue;}
    eligible.push(taskRow(task,`Ready task ${index + 1} in ${item.title}'s approved plan; current scope matches, earlier plan tasks and recorded prerequisites are Done. This identifies eligibility, not a new execution grant or priority over other plans.`));
  }
  return {eligible,waiting};
}
export function overviewGroups(state) {
  const initiatives = state?.initiatives || [], tasks = state?.tasks || [];
  const humanTasks = tasks.filter(t => String(t.status).toLowerCase() === 'ready' && (Array.isArray(t.assignee) ? t.assignee : [t.assignee]).some(a => String(a).toLowerCase() === 'human'));
  const decisions = initiatives.filter(i => !i.pending && !['Agent working','Recovery hold'].includes(runPresentation(i,state.activeRun).label) && ['awaiting-human','failed','blocked','cancelled'].includes(i.status));
  const next = approvedNextWork(initiatives,tasks);
  const row = (i,reason) => ({id:i.id,title:i.title,kind:'initiative',reason});
  return { humanTasks, decisions, groups: [
    {title:'Needs you',empty:'No pending initiative decisions or Ready Human tasks.',items:[...decisions.map(i => row(i, i.questions?.length ? 'Answer the outstanding questions.' : i.status === 'awaiting-human' ? `Review the ${i.stage === 'uat' ? 'delivered candidate and acceptance checks' : i.stage === 'planning' ? 'proposed plan' : 'proposed scope'}.` : `Review ${i.status} work before any retry.`)),...humanTasks.map(t => ({id:t.id,title:t.title,kind:'task',reason:'Assigned to Human and Ready. Review its scope and authority before acting.'}))]},
    {title:'Agent working',empty:'No active runtime run is recorded.',items:initiatives.filter(i => runPresentation(i,state.activeRun).label === 'Agent working').map(i => row(i,'The runtime records an active run.'))},
    ...(tasks.some(t => String(t.status).toLowerCase() === 'in progress') ? [{title:'Recorded task state',empty:'',items:tasks.filter(t => String(t.status).toLowerCase() === 'in progress').map(t => taskRow(t,'Recorded In Progress; execution is unverified. Task status alone does not confirm an active agent run.'))}] : []),
    {title:'Next eligible',empty:'No task has a confirmed next position in a current approved plan. Ready status and display order alone do not establish authority or sequence.',items:next.eligible},
    {title:'Waiting',empty:'No blocked, queued, or unresolved work is recorded.',items:[...next.waiting,...initiatives.filter(i => i.pending || ['Recovery hold','Run state unresolved'].includes(runPresentation(i,state.activeRun).label)).map(i => row(i,runPresentation(i,state.activeRun).reason)),...tasks.filter(t => String(t.status).toLowerCase() === 'blocked' && !next.waiting.some(r => r.kind === 'task' && r.id === t.id)).map(t => taskRow(t,dependencyReason(t,tasks) || (t.blockReason === 'dependent' ? 'Dependency clearance is not confirmed; prerequisite records are missing or inconsistent.' : t.blockReason ? `Blocked: ${t.blockReason}` : 'Blocked; no reason recorded.')))]}
  ]};
}
export function historyPage(records, page = 0, size = 10) {
  const total = records.length, pages = Math.max(1,Math.ceil(total / size));
  const index = Math.max(0,Math.min(page,pages - 1));
  return {items:[...records].reverse().slice(index * size,(index + 1) * size),index,pages,total,start:total ? index * size + 1 : 0,end:Math.min(total,(index + 1) * size)};
}

export function milestoneOrderSummary(milestones) {
  const unsequenced = milestones.filter(m => m.executionOrder === null || m.executionOrder === undefined || m.executionOrder === '' || !Number.isSafeInteger(Number(m.executionOrder)) || Number(m.executionOrder) < 0).length;
  const orders = milestones.filter(m => m.executionOrder !== null && m.executionOrder !== undefined && m.executionOrder !== '').map(m => Number(m.executionOrder));
  const tied = new Set(orders).size !== orders.length;
  if (!milestones.length) return 'No milestone order is recorded because no milestones are available.';
  if (unsequenced) return `Milestone order is not established: ${unsequenced} of ${milestones.length} milestones are unsequenced. Alphabetical display is not execution priority.`;
  if (tied) return 'Milestone order has ties; parallel work or priority needs planning context. Display order does not grant execution authority.';
  return `${milestones.length} milestones have recorded planning order. This is display context; approved plans and dependencies determine task eligibility.`;
}

export function reworkReviewSummary(review) {
  const checks = Array.isArray(review.results) ? review.results : [];
  const observed = checks.filter(check => check.status !== 'pending' || !!check.notes?.trim());
  const unchecked = checks.filter(check => check.status === 'pending' && !check.notes?.trim());
  return {observed,unchecked,checked:checks.filter(check => ['passed','failed'].includes(check.status)).length,failed:checks.filter(check => check.status === 'failed').length,total:checks.length};
}
