// Plan task fields historically contain either IDs or human-readable titles.
// Only exact IDs establish an association; prose and coincident titles do not.
export function initiativeTasks(item, tasks) {
  const plan = item.approvedPlan ? item.approvedPlan.tasks : item.plan;
  const references = [...(Array.isArray(item.taskIds) ? item.taskIds : []),
    ...(Array.isArray(plan) ? plan.map(entry => entry?.task) : [])];
  const ids = new Set(references.filter(value => typeof value === 'string')
    .map(value => value.trim().toUpperCase()).filter(value => /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/.test(value)));
  return tasks.filter(task => (item.id && task.initiativeId === item.id) ||
    (typeof task.id === 'string' && ids.has(task.id.toUpperCase())));
}
