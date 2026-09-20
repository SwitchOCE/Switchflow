import {escapeHTML as e, filterTasks} from './tasks-model.js';
import {taskEditor} from './tasks-editor.js';

export function mountTasks(container,{api,projectId,canWrite = () => true,onChange = () => {},onNavigate = () => {}}) {
  let mode = 'tasks', layout = 'board', tasks = [], statuses = [], types = [], milestones = [], generation = 0, editorGeneration = 0, destroyed = false, editor, review, dragging, pending = false;
  const events = new AbortController();
  const listen = (type, handler) => container.addEventListener(type, handler, {signal:events.signal});
  const filters = {search:'',status:'',assignee:'',labels:'',priority:'',type:'',milestone:''};
  const storageKey = `switchflow:task-edits:${projectId}`;
  let lastLoaded = '', hideEmptyColumns = false, defaultStatus;
  const plural = {status:'statuses',assignee:'owners',labels:'labels',priority:'priorities',type:'types',milestone:'milestones'};
  container.classList.add('sf-tasks');
  container.innerHTML = `<header class="sf-tasks-heading"><div><p class="eyebrow">Work management</p><h1 data-title>Tasks</h1><p class="muted" data-subtitle>Plan, assign and track work across your project.</p></div><div class="sf-task-actions"><button class="button quiet" data-refresh>Refresh</button><button class="button primary" data-create>Create task</button></div></header><div class="sf-task-toolbar"><label class="sf-task-search">Search tasks<input type="search" data-search placeholder="Search ID, title or description"></label><div class="sf-task-actions" role="group" aria-label="Task layout"><button class="button quiet" data-layout="board" aria-pressed="true">Board</button><button class="button quiet" data-layout="list" aria-pressed="false">List</button></div><details class="sf-maintenance"><summary>Maintenance</summary><button class="button quiet" data-maintenance="duplicates">Review duplicate IDs</button><button class="button quiet" data-maintenance="cleanup">Review completed cleanup</button></details></div><div class="sf-task-filters"></div><p class="sf-task-notice" role="status"></p><div class="sf-task-results"></div>`;
  const find = selector => container.querySelector(selector), notice = find('.sf-task-notice'), results = find('.sf-task-results');
  function locked() { if (!canWrite()) { notice.textContent = 'Changes are paused while an agent is active or queued.'; return true; } return false; }
  function filterControls() {
    const options = {status:statuses,assignee:[...new Set(tasks.flatMap(x => x.assignee || []))],labels:[...new Set(tasks.flatMap(x => x.labels || []))],priority:['high','medium','low'],type:[...new Set([...types,...tasks.map(x => x.type).filter(Boolean)])],milestone:[...new Set([...milestones.map(x => x.id),...tasks.map(x => x.milestone).filter(Boolean)])]};
    const names = {status:'Status',assignee:'Owner',labels:'Label',priority:'Priority',type:'Type',milestone:'Milestone'};
    find('.sf-task-filters').innerHTML = Object.entries(options).map(([key,items]) => `<label>${names[key]}<select data-filter="${key}"><option value="">All ${plural[key]}</option>${items.map(value => `<option value="${e(value)}" ${filters[key] === value ? 'selected' : ''}>${e(key === 'milestone' ? milestones.find(x => x.id === value)?.title || value : value)}</option>`).join('')}</select></label>`).join('') + '<button class="button quiet" data-clear>Clear filters</button>';
  }
  const editable = task => !['remote','local-branch','completed'].includes(task.source);
  function card(task) {
    return `<article class="sf-task-card" data-id="${e(task.id)}" draggable="${mode === 'tasks' && canWrite() && editable(task)}"><button class="sf-task-open" data-open="${e(task.id)}"><span class="card-meta"><span class="card-id">${e(task.id)}</span><span class="badge">${e(task.priority || task.type || 'Task')}</span></span><span class="card-title">${e(task.title)}</span><span class="sf-task-card-status">${e(task.status)}</span>${task.blockReason ? `<span class="task-block-reason">${e(task.blockReason)}</span>` : ''}<span class="sf-task-metadata">${e(task.assignee?.join(', ') || 'Unassigned')} · ${e(milestones.find(x => x.id === task.milestone)?.title || task.milestone || 'No milestone')}</span><span class="sf-task-labels">${(task.labels || []).map(x => `<span class="badge">${e(x)}</span>`).join('')}</span></button><div class="sf-task-card-actions"><button class="button quiet" data-open="${e(task.id)}">${editable(task) ? 'Open / move' : 'View'}</button>${mode === 'drafts' ? `<button class="button quiet" data-action="promote" data-id="${e(task.id)}" ${!canWrite() ? 'disabled' : ''}>Promote</button>` : editable(task) ? `<button class="sf-task-more button quiet" data-actions="${e(task.id)}" aria-label="Actions for ${e(task.id)}">Actions</button>` : ''}</div></article>`;
  }
  function render() {
    if (destroyed) return;
    const shown = filterTasks(tasks,filters);
    find('[data-create]').disabled = !canWrite();
    if (!shown.length) { results.innerHTML = `<div class="sf-task-empty"><h2>${tasks.length ? 'No matching tasks' : mode === 'drafts' ? 'No drafts yet' : 'No tasks yet'}</h2><p>${tasks.length ? 'Adjust the filters to see more work.' : `Create a ${mode === 'drafts' ? 'draft to shape an idea before promoting it.' : 'task to start tracking work.'}`}</p></div>`; return; }
    if (layout === 'list' || mode === 'drafts') results.innerHTML = `<div class="sf-task-list">${shown.map(card).join('')}</div>`;
    else results.innerHTML = `<div class="sf-task-board">${[...new Set([...statuses,...tasks.map(x => x.status)])].filter(status => !hideEmptyColumns || dragging || shown.some(task => task.status === status)).map(status => `<section class="sf-task-column" data-status="${e(status)}"><h2>${e(status)} <span class="count">${shown.filter(x => x.status === status).length}</span></h2><div class="sf-task-stack">${shown.filter(x => x.status === status).sort((a,b) => (a.ordinal || 0)-(b.ordinal || 0)).map(card).join('') || '<p class="column-empty">No tasks</p>'}</div></section>`).join('')}</div>`;
  }
  async function refresh() {
    const current = ++generation;
    if (!tasks.length) notice.textContent = 'Loading tasks…';
    try {
      const response = await Promise.all([api(mode === 'drafts' ? '/drafts' : '/tasks'),api('/statuses'),api('/config'),api('/milestones')]);
      if (destroyed || current !== generation) return;
      const signature = JSON.stringify([response,canWrite()]);
      [tasks,statuses] = response; types = response[2].types || []; milestones = response[3]; hideEmptyColumns = response[2].hideEmptyColumns === true; defaultStatus = response[2].defaultStatus || statuses[0];
      notice.textContent = canWrite() ? `${tasks.length} ${mode === 'drafts' ? 'drafts' : 'tasks'}` : 'Changes are paused while an agent is active or queued.';
      if (signature !== lastLoaded) { lastLoaded = signature; filterControls(); render(); }
    } catch(error) { if (!destroyed && current === generation) notice.textContent = `Unable to load ${mode}: ${error.message}. Use Refresh to retry.`; }
  }
  async function openTask(id) {
    const current = ++editorGeneration;
    try {
      const task = mode === 'drafts' ? tasks.find(x => x.id === id) : await api(`/task/${encodeURIComponent(id)}`);
      if (destroyed || current !== editorGeneration) return;
      if (!task) throw new Error('Task is no longer available. Refresh the list.');
      editor?.destroy();
      editor = taskEditor({task,draft:mode === 'drafts',statuses,types,milestones,storageKey,api,canWrite,saved:changed,navigate:onNavigate});
      if (mode === 'tasks') onNavigate({view:'tasks',task:id});
    } catch(error) { if (!destroyed && current === editorGeneration) notice.textContent = error.message; }
  }
  function changed() { if (destroyed) return; onChange(); refresh(); }
  function showReview(title,content,confirmLabel,action) {
    review?.close(); review = document.createElement('dialog'); review.className = 'sf-task-review';
    const active = review;
    active.innerHTML = `<div class="dialog-heading"><h2>${e(title)}</h2><button class="icon-button" data-close aria-label="Close review">×</button></div><div class="sf-review-content">${content}</div><p class="sf-review-message" role="status"></p><div class="dialog-footer"><button class="button quiet" data-close>Cancel</button>${action ? `<button class="button danger" data-confirm>${e(confirmLabel)}</button>` : ''}</div>`;
    document.body.append(active); active.showModal();
    active.querySelectorAll('[data-close]').forEach(x => x.onclick = () => active.close());
    active.addEventListener('close',() => active.remove());
    if (action) active.querySelector('[data-confirm]').onclick = async () => {
      if (pending || locked()) { active.querySelector('.sf-review-message').textContent = 'Changes are paused while an agent is active or queued.'; return; }
      pending = true; active.querySelector('[data-confirm]').disabled = true;
      try { const response = await action(); if (destroyed) return; active.close(); changed(); notice.textContent = response?.message || 'Change saved.'; }
      catch(error) { if (!destroyed) active.querySelector('.sf-review-message').textContent = error.message; }
      finally { pending = false; if (active.isConnected) active.querySelector('[data-confirm]').disabled = false; }
    };
    return active;
  }
  function taskAction(id,action) {
    if (locked()) return;
    const task = tasks.find(x => x.id === id); if (!task) return;
    const title = action === 'promote' ? 'Promote draft to task' : action === 'complete' ? 'Move task to completed archive' : 'Archive task';
    showReview(title,`<p><strong>${e(task.id)} — ${e(task.title)}</strong></p><p>${action === 'promote' ? 'The draft will become a task with a new task ID.' : action === 'complete' ? 'This moves the task file out of the active board. Use the editor to change status without moving the file.' : 'This removes the task from the active board and stores it in the archive.'}</p>`,title,() => api(action === 'promote' ? `/drafts/${encodeURIComponent(id)}/promote` : `/tasks/${encodeURIComponent(id)}${action === 'complete' ? '/complete' : ''}`,{method:action === 'archive' ? 'DELETE' : 'POST'}));
  }
  async function maintenance(kind) {
    const current = ++editorGeneration;
    try {
      if (kind === 'duplicates') {
        const plan = await api('/tasks/duplicates'); if (destroyed || current !== editorGeneration) return;
        showReview('Review duplicate task IDs',`<p>${plan.changes.length} files will receive a new ID. References require separate review.</p><ul>${plan.changes.map(x => `<li>${e(x.oldId)} → ${e(x.newId)}: ${e(x.title)}<br><small>${e(x.sourcePath)} → ${e(x.targetPath)}</small></li>`).join('')}</ul><p>${e(plan.blockedReasons.join('\n'))}</p><details><summary>References and cross-branch findings</summary><pre>${e(JSON.stringify({references:plan.references,crossBranchFindings:plan.crossBranchFindings},null,2))}</pre></details>`, 'Apply reviewed ID repair',plan.repairable && plan.changes.length ? () => api('/tasks/duplicates',{method:'POST',body:{fingerprint:plan.fingerprint}}) : null);
      } else {
        const chooser = showReview('Review completed cleanup','<p>Move Done tasks older than the chosen age to the completed archive. Review the task list before applying.</p><label>Minimum age in days<input type="number" min="0" value="30" data-age></label><button class="button quiet" data-preview>Preview eligible tasks</button>');
        chooser.querySelector('[data-preview]').onclick = async () => {
          const age = Number(chooser.querySelector('[data-age]').value); if (!Number.isInteger(age) || age < 0) return;
          const button = chooser.querySelector('[data-preview]'); button.disabled = true;
          try { const preview = await api(`/tasks/cleanup?age=${age}`); if (destroyed || !chooser.isConnected) return;
            showReview('Confirm completed cleanup',`<p>${preview.count} Done tasks at least ${age} days old will move to the completed archive.</p><ul>${preview.tasks.map(x => `<li>${e(x.id)} — ${e(x.title)}</li>`).join('')}</ul><p>Cleanup applies this age rule when you confirm. Any other Done tasks that become eligible before then are included.</p>`,'Apply cleanup age rule',preview.count ? () => api('/tasks/cleanup/execute',{method:'POST',body:{age}}) : null);
          } catch(error) { chooser.querySelector('.sf-review-message').textContent = error.message; } finally { button.disabled = false; }
        };
      }
    } catch(error) { if (!destroyed) notice.textContent = error.message; }
  }
  listen('input',event => { if (event.target.matches('[data-search]')) { filters.search = event.target.value; render(); } });
  listen('change',event => { const key = event.target.dataset.filter; if (key) {filters[key] = event.target.value; render();} });
  const click = event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-refresh')) refresh();
    if (button.dataset.open) openTask(button.dataset.open);
    if (button.hasAttribute('data-create') && !locked()) { editorGeneration++; editor?.destroy(); editor = taskEditor({task:{status:defaultStatus},draft:mode === 'drafts',statuses,types,milestones,storageKey,api,canWrite,saved:changed}); }
    if (button.dataset.layout) { layout = button.dataset.layout; container.querySelectorAll('[data-layout]').forEach(x => x.setAttribute('aria-pressed',String(x.dataset.layout === layout))); render(); }
    if (button.hasAttribute('data-clear')) { Object.keys(filters).forEach(x => filters[x] = ''); find('[data-search]').value = ''; filterControls(); render(); }
    if (button.dataset.maintenance) maintenance(button.dataset.maintenance);
    if (button.dataset.action) taskAction(button.dataset.id,button.dataset.action);
    if (button.dataset.actions) {
      const id = button.dataset.actions;
      const actions = showReview(`Actions for ${id}`,'<p>Change status or milestone using Open / move. Archive actions move files out of the active board.</p><div class="sf-task-actions"><button class="button quiet" data-complete>Move to completed archive</button><button class="button danger" data-archive>Archive task</button></div>');
      actions.querySelector('[data-complete]').onclick = () => taskAction(id,'complete'); actions.querySelector('[data-archive]').onclick = () => taskAction(id,'archive');
    }
  };
  listen('click',click);
  listen('dragstart',event => { const card = event.target.closest('[draggable=true]'); if (!card || locked()) { event.preventDefault(); return; } dragging = card.dataset.id; event.dataTransfer.setData('text/plain',dragging); });
  listen('dragover',event => { if (dragging && event.target.closest('[data-status]')) event.preventDefault(); });
  listen('dragend',() => {dragging = null;});
  listen('drop',async event => {
    const column = event.target.closest('[data-status]'); if (!column || !dragging || locked() || pending) return;
    event.preventDefault(); const id = dragging; dragging = null; const targetStatus = column.dataset.status;
    const orderedTaskIds = tasks.filter(x => x.status === targetStatus && x.id !== id).sort((a,b) => (a.ordinal || 0)-(b.ordinal || 0)).map(x => x.id);
    const before = event.target.closest('[data-id]')?.dataset.id; const at = orderedTaskIds.indexOf(before); orderedTaskIds.splice(at < 0 ? orderedTaskIds.length : at,0,id);
    pending = true;
    try { await api('/tasks/reorder',{method:'POST',body:{taskId:id,targetStatus,orderedTaskIds}}); changed(); } catch(error) { if (!destroyed) notice.textContent = error.message; } finally { pending = false; }
  });
  return {refresh,openTask,setMode(value) { lastLoaded = ''; mode = value === 'drafts' ? 'drafts' : 'tasks'; generation++; editorGeneration++; editor?.destroy(); tasks = []; find('[data-title]').textContent = mode === 'drafts' ? 'Drafts' : 'Tasks'; find('[data-create]').textContent = mode === 'drafts' ? 'Create draft' : 'Create task'; find('[data-subtitle]').textContent = mode === 'drafts' ? 'Shape ideas here, then promote them into project work.' : 'Plan, assign and track work across your project.'; refresh(); },destroy() {destroyed = true; events.abort(); generation++; editorGeneration++; editor?.destroy(); review?.close(); container.replaceChildren(); }};
}
