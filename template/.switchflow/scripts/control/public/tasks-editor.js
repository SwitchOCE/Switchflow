import {escapeHTML as e, checklistText, taskPayload} from './tasks-model.js';

export function taskEditor({task, draft, statuses, types, milestones, storageKey, api, canWrite, saved, navigate}) {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', task.id ? `Task ${task.id}` : draft ? 'Create draft' : 'Create task');
  dialog.className = 'sf-task-editor';
  const key = `${storageKey}:${task.id || (draft ? 'new-draft' : 'new')}`;
  let original = structuredClone(task), busy = false, alive = true, conflict = false;
  let baselineDoD = JSON.stringify(task.definitionOfDoneItems || []);
  const field = (name,label,value='',area=false) => `<label>${label}${area ? `<textarea rows="4" name="${name}">${e(value)}</textarea>` : `<input name="${name}" value="${e(value)}">`}</label>`;
  const select = (name,label,value,options) => `<label>${label}<select name="${name}">${options.map(x => { const [v,t] = Array.isArray(x) ? x : [x,x]; return `<option value="${e(v)}" ${v === value ? 'selected' : ''}>${e(t)}</option>`; }).join('')}</select></label>`;
  const details = (label,html) => `<details><summary>${label}</summary>${html}</details>`;
  dialog.innerHTML = `<form><div class="dialog-heading"><div><p class="eyebrow">${draft ? 'Draft' : 'Task'} ${e(task.id || '')}</p><h2>${task.id ? 'Task details' : `Create ${draft ? 'draft' : 'task'}`}</h2></div><button type="button" class="icon-button" data-close aria-label="Close task">×</button></div><div class="sf-editor-message" role="status"></div><div class="sf-conflict" hidden></div><fieldset><label>Title<input required name="title" value="${e(task.title || '')}"></label><div class="sf-form-grid">${select('status','Status',task.status || statuses[0], draft ? ['Draft'] : [...new Set([...statuses,task.status].filter(Boolean))])}${select('priority','Priority',task.priority || '',[...new Set(['','low','medium','high',task.priority].filter(x => x !== undefined))])}${select('type','Type',task.type || '',[...new Set(['',...types,task.type].filter(x => x !== undefined))])}${select('milestone','Milestone',task.milestone || '',[['','No milestone'],...milestones.map(x => [x.id,x.title || x.name || x.id]),...(task.milestone && !milestones.some(x => x.id === task.milestone) ? [[task.milestone,task.milestone]] : [])])}${field('assignee','Owners (comma separated)',task.assignee?.join(', '))}${field('labels','Labels (comma separated)',task.labels?.join(', '))}</div>${field('description','Description',task.description,true)}${field('blockReason','Block reason',task.blockReason,true)}${details('Acceptance criteria & definition of done',`${field('acceptanceCriteriaItems','Acceptance criteria — one per line; use [x] for checked',checklistText(task.acceptanceCriteriaItems),true)}<p class="muted">Definition of done — clear Keep to remove a criterion.</p>${(task.definitionOfDoneItems || []).map(x => `<div class="sf-dod"><label class="checkbox-label"><input type="checkbox" name="dodKeep${x.index}" checked>Keep</label><label class="checkbox-label"><input type="checkbox" name="dodCheck${x.index}" ${x.checked ? 'checked' : ''}>${e(x.text)}</label></div>`).join('')}${field('definitionOfDoneAdd','Add definition of done criteria (one per line)','',true)}`)}${details('Dependencies, references & changed files',field('dependencies','Dependencies (IDs, comma separated)',task.dependencies?.join(', ')) + field('references','References (one per line)',task.references?.join('\n'),true) + field('modifiedFiles','Modified files (one per line)',task.modifiedFiles?.join('\n'),true))}${details('Implementation & final summary',field('implementationPlan','Implementation plan',task.implementationPlan,true)+field('implementationNotes','Implementation notes',task.implementationNotes,true)+field('finalSummary','Final summary',task.finalSummary,true))}${details('Comments',`<div class="sf-comments">${(task.comments || []).map(c => `<article><strong>${e(c.author || 'Unattributed')}</strong> <time>${e(c.createdDate)}</time><p>${e(c.body)}</p></article>`).join('') || '<p class="muted">No comments yet.</p>'}</div>${task.id ? field('commentAuthor','Your name') + field('comment','Append a comment','',true) : '<p class="muted">Save the task before adding comments.</p>'}`)}</fieldset><p class="sf-editor-policy muted"></p><div class="dialog-footer"><button type="button" class="button quiet" data-close>Close</button><button type="submit" class="button primary">${task.id ? 'Save changes' : `Create ${draft ? 'draft' : 'task'}`}</button></div></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), message = dialog.querySelector('.sf-editor-message'), comparison = dialog.querySelector('.sf-conflict');
  // Disabled editors still contain recoverable drafts when an agent starts.
  const values = () => Object.fromEntries([...form.elements].filter(field => field.name && (field.type !== 'checkbox' || field.checked)).map(field => [field.name,field.value]));
  const stash = () => { try { sessionStorage.setItem(key, JSON.stringify({values:values(),revision:original.revision,baselineDoD})); } catch { message.textContent = 'Browser draft storage is unavailable. Keep this editor open until saved.'; } };
  const local = (() => {try {return JSON.parse(sessionStorage.getItem(key));} catch{return null;}})();
  if (local?.values) {
    baselineDoD = local.baselineDoD || baselineDoD;
    for (const [name,value] of Object.entries(local.values)) { const el = form.elements.namedItem(name); if (el) { if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value; } }
    // Restore unchecked checkboxes as well as checked ones.
    for (const el of form.querySelectorAll('input[type=checkbox]')) el.checked = Boolean(local.values[el.name]);
    if (task.id && local.revision && local.revision !== original.revision) { original.revision = local.revision; conflict = true; }
    message.textContent = 'Restored your unsaved edits for this project.';
  }
  const writable = () => canWrite() && !['remote','local-branch','completed'].includes(task.source);
  function sync() {
    form.querySelector('fieldset').disabled = busy || !writable();
    form.querySelector('[type=submit]').disabled = busy || !writable() || conflict || Boolean(task.id && !original.revision);
    dialog.querySelector('.sf-editor-policy').textContent = !canWrite() ? 'Editing is paused while an agent is active or queued.' : task.source === 'completed' ? 'Completed archive tasks are read-only.' : !writable() ? 'Tasks from another branch are read-only.' : task.id && !original.revision ? 'This record has no revision. Reload it before editing.' : 'Unsaved edits are kept in this browser tab for this project.';
  }
  async function showConflict() {
    conflict = true; sync(); comparison.hidden = false;
    comparison.replaceChildren();
    const note = document.createElement('p'); note.textContent = 'The saved record changed. Your edits are retained. Load the latest version to compare before choosing how to continue.'; comparison.append(note);
    const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'button quiet'; discard.textContent = 'Discard my edits and close'; comparison.append(discard);
    discard.onclick = () => { try {sessionStorage.removeItem(key);} catch {} dialog.close(); };
    const load = document.createElement('button'); load.type = 'button'; load.className = 'button quiet'; load.textContent = 'Load latest for comparison'; comparison.append(load);
    load.onclick = async () => {
      load.disabled = true;
      try {
        const latest = draft ? (await api('/drafts')).find(x => x.id === task.id) : await api(`/task/${encodeURIComponent(task.id)}`);
        if (!alive) return;
        if (!latest?.revision) throw new Error('Latest record has no revision; safe editing is unavailable.');
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(latest,null,2); comparison.append(pre);
        const use = document.createElement('button'); use.type = 'button'; use.className = 'button quiet'; use.textContent = 'Keep my edits against this version'; comparison.append(use);
        use.onclick = () => { original = {...latest,definitionOfDoneItems:task.definitionOfDoneItems}; original.revision = latest.revision; conflict = false; comparison.hidden = true; stash(); sync(); message.textContent = 'Latest revision selected. Review your edits, then save.'; };
        // DoD indices may have changed; never reuse them against a newer revision.
        if (JSON.stringify(latest.definitionOfDoneItems || []) !== baselineDoD) { use.disabled = true; note.textContent = 'Definition of done changed. Close and reopen the task after copying your edits; index-based checklist changes cannot safely be rebased.'; }
      } catch (error) { if (alive) message.textContent = error.message; } finally { load.disabled = false; }
    };
  }
  if (conflict) showConflict();
  form.addEventListener('input',stash);
  form.addEventListener('submit',async event => {
    event.preventDefault(); if (busy || !writable() || conflict) return;
    const submitted = values();
    busy = true; stash(); sync(); message.textContent = 'Saving…';
    try {
      const body = taskPayload(submitted,original); if (draft) body.status = 'Draft';
      const result = await api(task.id ? `/tasks/${encodeURIComponent(task.id)}` : '/tasks',{method:task.id ? 'PUT' : 'POST',body});
      try { sessionStorage.removeItem(key); } catch {}
      if (!alive) return; saved(result); dialog.close();
    } catch (error) { if (alive) { message.textContent = error.message; if (error.status === 409 && task.id) showConflict(); } }
    finally { busy = false; if (alive) sync(); }
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.onclick = () => dialog.close();
  const timer = setInterval(sync,1000);
  dialog.addEventListener('close',() => { alive = false; clearInterval(timer); dialog.remove(); });
  sync(); dialog.showModal();
  return {destroy:() => { if (alive) { if (!busy) stash(); dialog.close(); } }};
}
