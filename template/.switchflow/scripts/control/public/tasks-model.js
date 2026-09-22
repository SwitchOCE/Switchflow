export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const splitValues = value => String(value || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
// A save may finish after navigation opened another editor for the same task.
// Only remove the exact recovery snapshot that this save submitted.
export function clearSavedDraft(storage, key, snapshot) {
  if (snapshot !== null && storage.getItem(key) === snapshot) storage.removeItem(key);
}
export function checklist(text) {
  return String(text || '').split('\n').map(line => ({text:line.replace(/^\s*(?:-\s*)?\[[ xX]\]\s*/, '').trim(),checked:/^\s*(?:-\s*)?\[[xX]\]/.test(line)})).filter(x => x.text).map((x,i) => ({...x,index:i+1}));
}
export const checklistText = items => (items || []).map(x => `[${x.checked ? 'x' : ' '}] ${x.text}`).join('\n');
export function filterTasks(tasks, filters) {
  return tasks.filter(task => Object.entries(filters).every(([key,value]) => {
    if (!value) return true;
    if (key === 'search') return `${task.id} ${task.title} ${task.description || ''}`.toLowerCase().includes(value.toLowerCase());
    return Array.isArray(task[key]) ? task[key].includes(value) : String(task[key] || '') === value;
  }));
}
export function taskPayload(values, original = {}) {
  const result = {};
  for (const key of ['title','description','status','priority','type','blockReason','implementationPlan','implementationNotes','finalSummary']) result[key] = values[key] || '';
  result.milestone = values.milestone || null;
  for (const key of ['assignee','labels','dependencies']) result[key] = splitValues(values[key]);
  for (const key of ['references','modifiedFiles']) result[key] = String(values[key] || '').split('\n').map(x => x.trim()).filter(Boolean);
  result.acceptanceCriteriaItems = checklist(values.acceptanceCriteriaItems);
  // Native DoD updates are indexed operations: keep existing indices and checked states.
  const old = original.definitionOfDoneItems || [];
  result.definitionOfDoneRemove = old.filter(x => !values[`dodKeep${x.index}`]).map(x => x.index);
  result.definitionOfDoneCheck = old.filter(x => values[`dodKeep${x.index}`] && values[`dodCheck${x.index}`] && !x.checked).map(x => x.index);
  result.definitionOfDoneUncheck = old.filter(x => values[`dodKeep${x.index}`] && !values[`dodCheck${x.index}`] && x.checked).map(x => x.index);
  result.definitionOfDoneAdd = String(values.definitionOfDoneAdd || '').split('\n').map(x => x.trim()).filter(Boolean);
  if (original.id && !original.localDraft) result.expectedRevision = original.revision;
  if (values.comment?.trim()) { result.commentsAppend = [values.comment.trim()]; result.commentAuthor = values.commentAuthor || ''; }
  return result;
}

// All tasks in the destination participate, including records hidden by filters.
// A no-op produces no request, avoiding unintended ordinal churn.
export function moveTaskOrder(tasks, taskId, targetStatus, referenceId, position = 'bottom') {
  const task = tasks.find(x => x.id === taskId);
  if (!task || taskId === referenceId) return null;
  const current = tasks.filter(x => x.status === targetStatus).sort((a,b) => (a.ordinal || 0)-(b.ordinal || 0)).map(x => x.id);
  const orderedTaskIds = current.filter(id => id !== taskId);
  const at = orderedTaskIds.indexOf(referenceId);
  const index = position === 'top' ? 0 : position === 'bottom' || at < 0 ? orderedTaskIds.length : at + (position === 'after' ? 1 : 0);
  orderedTaskIds.splice(index,0,taskId);
  if (task.status === targetStatus && JSON.stringify(current) === JSON.stringify(orderedTaskIds)) return null;
  return {taskId,targetStatus,orderedTaskIds};
}

export function taskBlockerText(task, tasks = []) {
  const reason = String(task.blockReason || '').trim();
  if (reason.toLowerCase() !== 'dependent') return reason || (task.status === 'Blocked' ? 'Blocked, but no reason is recorded.' : '');
  const prerequisites = (task.dependencies || []).map(id => {
    const item = tasks.find(candidate => candidate.id === id);
    return item ? `${item.title || id} (${item.status || 'status unavailable'})` : `${id} (status unavailable)`;
  });
  return prerequisites.length ? `Waiting for ${prerequisites.join('; ')}.` : 'Waiting for a prerequisite; no prerequisite is recorded.';
}
