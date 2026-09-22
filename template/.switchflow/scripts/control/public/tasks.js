import {escapeHTML as e, filterTasks, moveTaskOrder, taskBlockerText} from './tasks-model.js';
import {taskEditor} from './tasks-editor.js';

export function mountTasks(container,{api,projectId,canWrite = () => true,writeBlockedReason = () => '',onChange = () => {},onNavigate = () => {},onClose = () => {},onOpenRecord = async () => {}}) {
  let mode = 'tasks', layout = 'board', tasks = [], statuses = [], types = [], milestones = [], generation = 0, editorGeneration = 0, destroyed = false, editor, review, dragging, pending = false;
  const events = new AbortController();
  const listen = (type, handler) => container.addEventListener(type, handler, {signal:events.signal});
  const filters = {search:'',status:'',assignee:'',labels:'',priority:'',type:'',milestone:''};
  const storageKey = `switchflow:task-edits:${projectId}`;
  let activeTaskId = null, detailViews = {};
  try {detailViews = JSON.parse(sessionStorage.getItem(`${storageKey}:views`)) || {};} catch {}
  function rememberEditor() {if (!editor || !activeTaskId) return; detailViews[activeTaskId] = editor.snapshot(); const entries = Object.entries(detailViews); if (entries.length > 40) detailViews = Object.fromEntries(entries.slice(-40)); try {sessionStorage.setItem(`${storageKey}:views`,JSON.stringify(detailViews));} catch {}}
  function closeEditor() {rememberEditor(); editor?.destroy(); editor = null; activeTaskId = null;}
  let lastLoaded = '', hideEmptyColumns = false, defaultStatus, page = 1, sort = 'ordinal', density = 'comfortable', laneScroll = {}, boardScroll = 0, loadFeedback = '';
  const viewKey = `switchflow:task-view:${projectId}`;
  try {const state = JSON.parse(sessionStorage.getItem(viewKey)); if (state) {Object.assign(filters,state.filters); layout = state.layout || layout; sort = state.sort || sort; density = state.density || density; page = state.page || 1; laneScroll = state.laneScroll || {}; boardScroll = state.boardScroll || 0;}} catch {}
  const persist = () => {try {sessionStorage.setItem(viewKey,JSON.stringify({filters,layout,sort,density,page,laneScroll,boardScroll}));} catch {}};
  const plural = {status:'statuses',assignee:'owners',labels:'labels',priority:'priorities',type:'types',milestone:'milestones'};
  container.classList.add('sf-tasks');
  container.innerHTML = `<header class="sf-tasks-heading"><div><p class="eyebrow">Work management</p><h1 data-title>Tasks</h1><p class="muted" data-subtitle>Plan, assign and track work across your project.</p></div><div class="sf-task-actions"><button class="button primary" data-create>Create task</button></div></header><div class="sf-task-toolbar"><label class="sf-task-search">Search tasks<input type="search" data-search placeholder="Search ID, title or description"></label><div class="sf-task-actions" role="group" aria-label="Task layout"><button class="button quiet" data-layout="board" aria-pressed="true">Board</button><button class="button quiet" data-layout="list" aria-pressed="false">List</button></div><button class="button quiet" data-refresh>Refresh</button></div><details class="sf-filter-panel"><summary>Filters and view</summary><div class="sf-task-filters"></div><details class="sf-maintenance"><summary>Maintenance</summary><button class="button quiet" data-maintenance="duplicates">Review duplicate IDs</button><button class="button quiet" data-maintenance="cleanup">Review completed cleanup</button></details><div class="sf-task-view-options"><label>Sort<select data-sort><option value="ordinal">Board order</option><option value="title">Title</option><option value="status">Status</option><option value="priority">Priority</option></select></label><label>Density<select data-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div></details><p class="sf-task-count" aria-live="polite"></p><p class="sf-task-notice" role="status"></p><div class="sf-task-results"></div>`;
  const find = selector => container.querySelector(selector), notice = find('.sf-task-notice'), results = find('.sf-task-results');
  const blockedReason = () => writeBlockedReason() || 'Changes are temporarily unavailable.';
  function updateAccess() {updateCount(); find('[data-create]').disabled = !canWrite(); container.querySelectorAll('.sf-task-card').forEach(card => {const task = tasks.find(item => item.id === card.dataset.id); card.draggable = mode === 'tasks' && canWrite() && Boolean(task && editable(task));}); container.querySelectorAll('[data-action=promote]').forEach(button => button.disabled = !canWrite()); editor?.updateAccess(); if (review?.isConnected) {const confirm = review.querySelector('[data-confirm]'), message = review.querySelector('.sf-review-message'); if (confirm) confirm.disabled = pending || !canWrite() || review.dataset.uncertain === 'true'; if (!canWrite()) {review.dataset.accessReason = blockedReason(); message.textContent = review.dataset.accessReason;} else if (message.textContent === review.dataset.accessReason) {message.textContent = ''; delete review.dataset.accessReason;}} if (!canWrite() && dragging) clearDrag();}
  function updateCount() {find('.sf-task-count').textContent = `${filterTasks(tasks,filters).length} of ${tasks.length} ${mode === 'drafts' ? 'draft tasks' : 'tasks'}${!canWrite() ? ` · ${blockedReason()}` : ''}`;}
  function locked() { if (!canWrite()) { notice.textContent = blockedReason(); return true; } return false; }
  function filterControls() {
    const options = {status:statuses,assignee:[...new Set(tasks.flatMap(x => x.assignee || []))],labels:[...new Set(tasks.flatMap(x => x.labels || []))],priority:['high','medium','low'],type:[...new Set([...types,...tasks.map(x => x.type).filter(Boolean)])],milestone:[...new Set([...milestones.map(x => x.id),...tasks.map(x => x.milestone).filter(Boolean)])]};
    const names = {status:'Status',assignee:'Owner',labels:'Label',priority:'Priority',type:'Type',milestone:'Milestone'};
    find('.sf-task-filters').innerHTML = Object.entries(options).map(([key,items]) => `<label>${names[key]}<select data-filter="${key}"><option value="">All ${plural[key]}</option>${items.map(value => `<option value="${e(value)}" ${filters[key] === value ? 'selected' : ''}>${e(key === 'milestone' ? milestones.find(x => x.id === value)?.title || value : value)}</option>`).join('')}</select></label>`).join('') + '<button class="button quiet" data-clear>Clear filters</button>';
  }
  container.addEventListener('scroll',event => {if (event.target.matches?.('.sf-task-board')) boardScroll = event.target.scrollLeft; if (event.target.matches?.('.sf-task-stack')) laneScroll[event.target.closest('[data-status]').dataset.status] = event.target.scrollTop; persist();},{capture:true,signal:events.signal});
  const editable = task => !['remote','local-branch','completed'].includes(task.source);
  function card(task) {
    const blocker = taskBlockerText(task,tasks);
    return `<article class="sf-task-card" data-id="${e(task.id)}" draggable="${mode === 'tasks' && canWrite() && editable(task)}"><button class="sf-task-open" data-open="${e(task.id)}"><span class="card-meta"><span class="card-id">${e(task.id)}</span><span class="badge">${e(task.priority || task.type || 'Task')}</span></span><span class="card-title">${e(task.title)}</span><span class="sf-task-card-status">${e(task.status)}</span>${blocker ? `<span class="task-block-reason">${e(blocker)}</span>` : ''}<span class="sf-task-metadata">${e(task.assignee?.join(', ') || 'Unassigned')} · ${e(milestones.find(x => x.id === task.milestone)?.title || task.milestone || 'No milestone')}</span><span class="sf-task-labels">${(task.labels || []).map(x => `<span class="badge">${e(x)}</span>`).join('')}</span></button><div class="sf-task-card-actions"><button class="button quiet" data-open="${e(task.id)}">${editable(task) ? 'Open / move' : 'View'}</button>${mode === 'drafts' ? `<button class="button quiet" data-action="promote" data-id="${e(task.id)}" ${!canWrite() ? 'disabled' : ''}>Promote</button>` : editable(task) ? `<button class="sf-task-more button quiet" data-actions="${e(task.id)}" aria-label="Actions for ${e(task.id)}">Actions</button>` : ''}</div></article>`;
  }
  function render() {
    if (destroyed) return;
    const shown = filterTasks(tasks,filters).sort((a,b) => sort === 'ordinal' ? (a.ordinal || 0)-(b.ordinal || 0) : sort === 'priority' ? ['high','medium','low',''].indexOf(a.priority || '')-['high','medium','low',''].indexOf(b.priority || '') : String(a[sort] || '').localeCompare(String(b[sort] || '')));
    persist(); container.dataset.density = density; find('[data-search]').value = filters.search; find('[data-sort]').value = sort; find('[data-density]').value = density; container.querySelectorAll('[data-layout]').forEach(x => x.setAttribute('aria-pressed',String(x.dataset.layout === layout)));
    find('.sf-filter-panel summary').textContent = `Filters${Object.values(filters).filter(Boolean).length ? ` (${Object.values(filters).filter(Boolean).length} active)` : ''} · ${sort === 'ordinal' ? 'Board order' : sort[0].toUpperCase()+sort.slice(1)} · ${density}`;
    updateCount();
    find('[data-create]').disabled = !canWrite();
    if (!shown.length) { results.innerHTML = `<div class="sf-task-empty"><h2>${tasks.length ? 'No matching tasks' : mode === 'drafts' ? 'No drafts yet' : 'No tasks yet'}</h2><p>${tasks.length ? 'Adjust the filters to see more work.' : `Create a ${mode === 'drafts' ? 'draft to shape an idea before promoting it.' : 'task to start tracking work.'}`}</p></div>`; return; }
    if (layout === 'list' || mode === 'drafts') {page = Math.min(page,Math.max(1,Math.ceil(shown.length/30))); const start = (page-1)*30; results.innerHTML = `<div class="sf-task-list">${shown.slice(start,start+30).map(card).join('')}</div><div class="sf-task-pagination"><button class="button quiet" data-page="previous" ${page === 1 ? 'disabled' : ''}>Previous</button><span>${start+1}–${Math.min(start+30,shown.length)} of ${shown.length} matching tasks</span><button class="button quiet" data-page="next" ${start+30 >= shown.length ? 'disabled' : ''}>Next</button></div>`;}
    else results.innerHTML = `<div class="sf-task-board">${[...new Set([...statuses,...tasks.map(x => x.status)])].map(status => `<section class="sf-task-column" data-status="${e(status)}" ${((hideEmptyColumns || Object.values(filters).some(Boolean)) && !shown.some(task => task.status === status)) ? 'data-empty-hidden hidden' : ''}><h2>${e(status)} <span class="count">${shown.filter(x => x.status === status).length}</span></h2><div class="sf-task-stack">${shown.filter(x => x.status === status).sort((a,b) => (a.ordinal || 0)-(b.ordinal || 0)).map(card).join('') || '<p class="column-empty">No tasks</p>'}</div></section>`).join('')}</div>`;
    const board = find('.sf-task-board'); if (board) {board.scrollLeft = boardScroll; board.querySelectorAll('.sf-task-stack').forEach(stack => {stack.scrollTop = laneScroll[stack.closest('[data-status]').dataset.status] || 0;});}
  }
  async function refresh() {
    const current = ++generation;
    if (!lastLoaded && !tasks.length && !notice.textContent) {loadFeedback = 'Loading tasks…'; notice.textContent = loadFeedback;}
    try {
      const response = await Promise.all([api(mode === 'drafts' ? '/drafts' : '/tasks'),api('/statuses'),api('/config'),api('/milestones')]);
      if (destroyed || current !== generation) return;
      const signature = JSON.stringify([response,canWrite()]);
      [tasks,statuses] = response; types = response[2].types || []; milestones = response[3]; hideEmptyColumns = response[2].hideEmptyColumns === true; defaultStatus = response[2].defaultStatus || statuses[0];
      updateCount(); if (notice.textContent === loadFeedback) notice.textContent = ''; loadFeedback = '';
      if (dragging) return;
      if (signature !== lastLoaded) { lastLoaded = signature; filterControls(); render(); }
    } catch(error) { if (!destroyed && current === generation) {loadFeedback = `Unable to load ${mode}: ${error.message}. Use Refresh to retry.`; notice.textContent = loadFeedback;} }
  }
  async function openTask(id) {
    const current = ++editorGeneration;
    try {
      const task = mode === 'drafts' ? tasks.find(x => x.id === id) : await api(`/task/${encodeURIComponent(id)}`);
      if (destroyed || current !== editorGeneration) return;
      if (!task) throw new Error('Task is no longer available. Refresh the list.');
      closeEditor(); activeTaskId = id;
      editor = taskEditor({task,draft:mode === 'drafts',statuses,types,milestones,storageKey,api,canWrite,writeBlockedReason,saved:changed,navigate:route => openTask(route.task),closed:() => {rememberEditor(); editor = null; activeTaskId = null; onClose();},tasks,viewState:detailViews[id],onOpenRecord:async target => {closeEditor(); try {await onOpenRecord(target);} catch(error) {await openTask(id); notice.textContent = `Unable to open linked record: ${error.message}. Your task reading position and edits are retained.`;}}});
      if (mode === 'tasks') onNavigate({view:'tasks',task:id});
    } catch(error) { if (!destroyed && current === editorGeneration) notice.textContent = error.message; }
  }
  function changed() { if (destroyed) return; onChange(); refresh(); }
  function showReview(title,content,confirmLabel,action) {
    review?.close(); review = document.createElement('dialog'); review.className = 'sf-task-review'; review.setAttribute('aria-label',title); const opener = document.activeElement;
    const active = review;
    active.innerHTML = `<div class="dialog-heading"><h2>${e(title)}</h2><button class="icon-button" data-close aria-label="Close review">×</button></div><div class="sf-review-content">${content}</div><p class="sf-review-message" role="status"></p><div class="dialog-footer"><button class="button quiet" data-close>Cancel</button>${action ? `<button class="button danger" data-confirm>${e(confirmLabel)}</button>` : ''}</div>`;
    document.body.append(active); active.showModal();
    active.querySelectorAll('[data-close]').forEach(x => x.onclick = () => active.close());
    active.addEventListener('close',() => {active.remove(); if (opener?.isConnected) opener.focus();});
    if (action) active.querySelector('[data-confirm]').onclick = async () => {
      if (pending || locked()) { active.querySelector('.sf-review-message').textContent = pending ? 'A change is being saved. Please wait.' : blockedReason(); return; }
      pending = true; active.querySelector('[data-confirm]').disabled = true;
      try { const response = await action(); if (destroyed) return; active.close(); changed(); notice.textContent = response?.message || 'Change saved.'; }
      catch(error) { if (!destroyed) {active.querySelector('.sf-review-message').textContent = error.outcome === 'unknown' ? `${error.message} Close this review and Refresh to inspect the saved records before retrying.` : error.message; if (error.outcome === 'unknown') active.dataset.uncertain = 'true';} }
      finally { pending = false; if (active.isConnected) active.querySelector('[data-confirm]').disabled = active.dataset.uncertain === 'true'; }
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
  listen('input',event => { if (event.target.matches('[data-search]')) { filters.search = event.target.value; boardScroll = 0; laneScroll = {}; page = 1; render(); } });
  listen('change',event => { const key = event.target.dataset.filter; if (key) {filters[key] = event.target.value; boardScroll = 0; laneScroll = {}; page = 1; render();} if (event.target.matches('[data-sort]')) {sort = event.target.value; render();} if (event.target.matches('[data-density]')) {density = event.target.value; render();} });
  const click = event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.page) {page += button.dataset.page === 'next' ? 1 : -1; render();}
    if (button.hasAttribute('data-refresh')) refresh();
    if (button.dataset.open) openTask(button.dataset.open);
    if (button.hasAttribute('data-create') && !locked()) { editorGeneration++; closeEditor(); editor = taskEditor({task:{status:defaultStatus},draft:mode === 'drafts',statuses,types,milestones,storageKey,api,canWrite,writeBlockedReason,saved:changed,closed:onClose,tasks}); }
    if (button.dataset.layout) { layout = button.dataset.layout; container.querySelectorAll('[data-layout]').forEach(x => x.setAttribute('aria-pressed',String(x.dataset.layout === layout))); render(); }
    if (button.hasAttribute('data-clear')) { page = 1; Object.keys(filters).forEach(x => filters[x] = ''); find('[data-search]').value = ''; filterControls(); render(); }
    if (button.dataset.maintenance) maintenance(button.dataset.maintenance);
    if (button.dataset.action) taskAction(button.dataset.id,button.dataset.action);
    if (button.dataset.actions) {
      const id = button.dataset.actions;
      const task = tasks.find(x => x.id === id); const actions = showReview(`Actions for ${id}`,`<p>Move changes visual order and status; it does not approve work for execution.</p><label>Destination status<select data-move-status>${statuses.map(status => `<option ${status === task.status ? 'selected' : ''}>${e(status)}</option>`).join('')}</select></label><label>Position<select data-move-position><option value="top">Top</option><option value="bottom">Bottom</option><option value="before">Before task</option><option value="after">After task</option></select></label><label>Reference task<select data-move-reference></select></label><button class="button primary" data-move>Move task</button><p>Archive actions move files out of the active board.</p><div class="sf-task-actions"><button class="button quiet" data-complete>Move to completed archive</button><button class="button danger" data-archive>Archive task</button></div>`);
      const destination = actions.querySelector('[data-move-status]'), reference = actions.querySelector('[data-move-reference]'); const choices = () => {reference.innerHTML = tasks.filter(x => x.id !== id && x.status === destination.value).sort((a,b) => (a.ordinal || 0)-(b.ordinal || 0)).map(x => `<option value="${e(x.id)}">${e(x.title)}</option>`).join('');}; destination.onchange = choices; choices(); actions.querySelector('[data-move]').onclick = async () => {if (locked() || pending) return; pending = true; try {const position = actions.querySelector('[data-move-position]').value; if (['before','after'].includes(position) && !reference.value) throw new Error('Choose a reference task, or use Top or Bottom.'); const body = moveTaskOrder(tasks,id,destination.value,reference.value,position); if (body) await api('/tasks/reorder',{method:'POST',body}); actions.close(); changed(); notice.textContent = body ? 'Moved ' + id + ' to ' + body.targetStatus + '.' : 'Task position unchanged.';} catch(error) {actions.querySelector('.sf-review-message').textContent = error.message;} finally {pending = false;}};
      actions.querySelector('[data-complete]').onclick = () => taskAction(id,'complete'); actions.querySelector('[data-archive]').onclick = () => taskAction(id,'archive');
    }
  };
  listen('click',click);
  const clearDrag = () => {dragging = null; container.querySelectorAll('[data-empty-hidden]').forEach(x => x.hidden = true); container.querySelectorAll('[data-drop-position]').forEach(x => delete x.dataset.dropPosition); container.querySelectorAll('.sf-drop-column').forEach(x => x.classList.remove('sf-drop-column'));};
  listen('dragstart',event => {const card = event.target.closest('[draggable=true]'); if (!card || locked()) {event.preventDefault(); return;} dragging = card.dataset.id; event.dataTransfer.setData('text/plain',dragging); event.dataTransfer.effectAllowed = 'move'; setTimeout(() => {if (dragging) container.querySelectorAll('[data-empty-hidden]').forEach(x => x.hidden = false);},0);});
  listen('dragover',event => {const column = event.target.closest('[data-status]'); if (!dragging || !column) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; container.querySelectorAll('[data-drop-position]').forEach(x => delete x.dataset.dropPosition); container.querySelectorAll('.sf-drop-column').forEach(x => x.classList.remove('sf-drop-column')); const card = event.target.closest('.sf-task-card'); if (card && card.dataset.id !== dragging) card.dataset.dropPosition = event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height/2 ? 'before' : 'after'; else if (!card) column.classList.add('sf-drop-column'); const stack = column.querySelector('.sf-task-stack'), rect = stack.getBoundingClientRect(); if (event.clientY < rect.top+45) stack.scrollTop -= 14; else if (event.clientY > rect.bottom-45) stack.scrollTop += 14; const board = column.closest('.sf-task-board'), bounds = board.getBoundingClientRect(); if (event.clientX < bounds.left+45) board.scrollLeft -= 14; else if (event.clientX > bounds.right-45) board.scrollLeft += 14;});
  listen('dragend',clearDrag);
  listen('drop',async event => {const column = event.target.closest('[data-status]'); if (!column || !dragging || locked() || pending) {clearDrag(); return;} event.preventDefault(); const id = dragging, card = event.target.closest('.sf-task-card'), position = card ? (event.clientY < card.getBoundingClientRect().top+card.getBoundingClientRect().height/2 ? 'before' : 'after') : 'bottom'; const body = moveTaskOrder(tasks,id,column.dataset.status,card?.dataset.id,position); clearDrag(); if (!body) {notice.textContent = 'Task position unchanged.'; return;} pending = true; try {await api('/tasks/reorder',{method:'POST',body}); changed(); notice.textContent = `Moved ${id} to ${body.targetStatus}.`; } catch(error) {if (!destroyed) notice.textContent = error.message;} finally {pending = false;}});
  return {refresh,openTask,updateAccess,closeTask({navigate = false} = {}) {editorGeneration++; closeEditor(); if (navigate) onClose();},setMode(value) { lastLoaded = ''; notice.textContent = ''; loadFeedback = ''; mode = value === 'drafts' ? 'drafts' : 'tasks'; generation++; editorGeneration++; closeEditor(); tasks = []; find('[data-title]').textContent = mode === 'drafts' ? 'Draft tasks' : 'Tasks'; find('[data-create]').textContent = mode === 'drafts' ? 'Create draft' : 'Create task'; find('[data-subtitle]').textContent = mode === 'drafts' ? 'Shape ideas here, then promote them into project work.' : 'Plan, assign and track work across your project.'; refresh(); },destroy() {destroyed = true; events.abort(); generation++; editorGeneration++; closeEditor(); review?.close(); container.replaceChildren(); }};
}
