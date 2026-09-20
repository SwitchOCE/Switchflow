export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const splitValues = value => String(value || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
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
