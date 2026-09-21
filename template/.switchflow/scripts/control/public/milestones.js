// Host callbacks supply project-scoped APIs and CSRF; drafts never cross project keys.
export const sortMilestones = values => [...values].sort((a, b) => (a.executionOrder ?? Infinity) - (b.executionOrder ?? Infinity) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
export function milestoneMatches(value, milestone) {
  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/^(?:m-)?0*(\d+)$/, 'm-$1');
  return !!value && [milestone.id, milestone.title].some(alias => normalize(alias) === normalize(value));
}
export function parseMilestoneOrder(value) {
  if (value === '' || value == null) return null;
  const order = Number(value);
  if (!Number.isSafeInteger(order) || order < 0) throw new Error('Execution order must be a non-negative whole number.');
  return order;
}
export function createMilestonePanel({ container, read, write, api, canWrite = () => true, onTask, projectKey, onSaved = async () => {}, drafts = new Map() }) {
  let generation = 0, request = 0, editorRequest = 0, selected = null, destroyed = false, milestones = [], tasks = [], archived = [], showArchived = false, busy = false;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const button = (text, action) => { const el = node('button', text, 'button quiet'); el.type = 'button'; el.addEventListener('click', action); return el; };
  const key = id => `${projectKey()}:${id}`;
  const current = (ticket, project) => !destroyed && ticket === generation && project === projectKey();
  const route = id => `/milestones/${encodeURIComponent(id)}`;
  const load = id => api ? api(route(id)) : read(`/api${route(id)}`);
  const unwrap = value => value.milestone || value;
  const errorText = error => error?.message || 'The milestone operation failed.';
  const assertWritable = () => { if (!canWrite()) throw new Error('Stop the active agent before changing milestones or assignments.'); };
  const heading = node('h2', 'Milestones');
  const help = node('p', 'IDs identify records. Execution order is optional and independent of the ID.', 'muted');
  const message = node('p'); message.setAttribute('role', 'status');
  const toolbar = node('div', undefined, 'milestone-actions');
  const search = node('input'); search.type = 'search'; search.placeholder = 'Search milestones'; search.setAttribute('aria-label', 'Search milestones'); search.addEventListener('input', renderList);
  const create = button('New milestone', () => { if (busy) return; editorRequest++; renderEditor({ id: '@new' }, drafts.get(key('@new')) || { title: '', description: '', labels: [], executionOrder: '' }); });
  const toggle = button('Show archived', async () => { if (busy) return; editorRequest++; showArchived = !showArchived; toggle.textContent = showArchived ? 'Show active' : 'Show archived'; selected = null; detail.replaceChildren(); await refresh(); });
  if (api) toolbar.append(create, toggle); toolbar.append(search);
  const list = node('div', undefined, 'milestone-list');
  const detail = node('div', undefined, 'milestone-editor');
  container.classList.add('milestone-panel'); container.append(heading, help, toolbar, message, list, detail);
  const assigned = milestone => tasks.filter(task => milestoneMatches(task.milestone, milestone));
  function renderList() {
    create.disabled = busy || !canWrite();
    list.replaceChildren();
    const values = sortMilestones(showArchived ? archived : milestones).filter(m => `${m.id} ${m.title} ${m.description || ''} ${(m.labels || []).join(' ')}`.toLowerCase().includes(search.value.toLowerCase()));
    if (!values.length) list.append(node('p', showArchived ? 'No archived milestones match.' : 'No milestones match.', 'muted'));
    for (const milestone of values) {
      const card = node('article', undefined, 'milestone-card');
      card.append(node('span', `${milestone.id} · ${milestone.executionOrder == null ? 'Unsequenced' : `Order ${milestone.executionOrder}`}`, 'muted'), node('h3', milestone.title));
      if (milestone.description) card.append(node('p', milestone.description, 'milestone-description'));
      if (milestone.labels?.length) card.append(node('p', milestone.labels.join(' · '), 'milestone-labels'));
      if (api) {
        const linked = assigned(milestone), done = linked.filter(t => String(t.status).toLowerCase() === 'done').length;
        card.append(node('p', `${done} / ${linked.length} tasks done`, 'muted'));
        const progress = node('progress'); progress.max = linked.length || 1; progress.value = done; progress.setAttribute('aria-label', `${milestone.title}: ${done} of ${linked.length} tasks done`); card.append(progress);
      }
      if (showArchived) card.append(node('p', 'Archived. Restoration is not supported by this server.', 'muted'));
      else card.append(button(`Edit ${milestone.id}`, () => open(milestone.id)));
      list.append(card);
    }
  }
  async function saved(messageText, ticket, project) {
    if (!current(ticket, project)) return;
    selected = null; detail.replaceChildren(); message.textContent = messageText;
    try { await onSaved(); if (current(ticket, project)) await refresh(); }
    catch (error) { if (current(ticket, project)) message.textContent = `${messageText} Refresh failed: ${errorText(error)}`; }
  }
  function renderEditor(milestone, draft, latest = null) {
    const isNew = milestone.id === '@new', editorProject = projectKey(), editorTicket = generation;
    selected = milestone.id; detail.replaceChildren();
    const title = node('h3', isNew ? 'Create milestone' : `Edit ${milestone.id}`); title.tabIndex = -1;
    const form = node('form'), notice = node('p'); notice.setAttribute('role', 'alert');
    const input = (name, label, value, multiline = false) => { const wrap = node('label', label), field = node(multiline ? 'textarea' : 'input'); field.name = name; field.value = value ?? ''; wrap.append(field); form.append(wrap); return field; };
    const titleField = input('title', 'Title', draft.title); titleField.required = true; titleField.maxLength = 100;
    const description = input('description', 'Description', draft.description, true); description.maxLength = 120000; description.rows = 5;
    const labels = input('labels', 'Labels (comma separated)', (draft.labels || []).join(', '));
    const order = input('executionOrder', 'Execution order (optional)', draft.executionOrder); order.type = 'number'; order.min = '0'; order.step = '1';
    const preserve = () => {
      const value = { ...draft, title: titleField.value, description: description.value, labels: labels.value.split(',').map(v => v.trim()).filter(Boolean), executionOrder: order.value };
      if (current(editorTicket, editorProject)) drafts.set(`${editorProject}:${milestone.id}`, value); return value;
    };
    form.addEventListener('input', preserve);
    const controls = node('div', undefined, 'milestone-actions');
    const save = node('button', isNew ? 'Create milestone' : 'Save milestone', 'button primary'); save.type = 'submit';
    const editable = isNew || !!(milestone.revision && (api || milestone.atomicRevision));
    save.disabled = !editable || !canWrite() || busy;
    const reload = button('Load latest; keep my draft', async () => {
      const loadRequest = ++editorRequest; preserve(); reload.disabled = true;
      try {
        const fresh = unwrap(await load(milestone.id));
        if (!current(editorTicket, editorProject) || selected !== milestone.id || loadRequest !== editorRequest) return;
        const updated = { ...preserve(), expectedRevision: fresh.revision };
        drafts.set(key(milestone.id), updated); renderEditor(fresh, updated, fresh);
      } catch (error) { if (current(editorTicket, editorProject)) notice.textContent = errorText(error); }
      finally { reload.disabled = false; }
    });
    controls.append(save); if (!isNew) controls.append(reload);
    controls.append(button('Close editor', () => { if (busy) return; preserve(); editorRequest++; selected = null; detail.replaceChildren(); list.querySelector('button')?.focus(); })); form.append(notice, controls);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !current(editorTicket, editorProject)) return;
      const retained = preserve(); let created;
      try {
        assertWritable(); if (!editable) throw new Error('A revision-aware server is required for editing.');
        const body = { ...retained, title: retained.title.trim(), executionOrder: parseMilestoneOrder(retained.executionOrder) };
        if (!body.title) throw new Error('Title is required.');
        busy = true; editorRequest++;
        for (const field of form.querySelectorAll('input,textarea,select,button')) field.disabled = true;
        if (isNew) {
          created = unwrap(await api('/milestones', { method: 'POST', body: { title: body.title, description: body.description, labels: body.labels, executionOrder: body.executionOrder } }));
          if (!current(editorTicket, editorProject)) return;
          drafts.delete(key('@new'));
        } else if (api) await api(route(milestone.id), { method: 'PUT', body });
        else await write(`/api${route(milestone.id)}`, body);
        if (!current(editorTicket, editorProject)) return;
        drafts.delete(key(created?.id || milestone.id)); await saved(`${created?.id || milestone.id} saved.`, editorTicket, editorProject);
      } catch (error) {
        if (!current(editorTicket, editorProject)) return;
        notice.textContent = `${errorText(error)} Your draft is preserved.`;
      } finally { if (current(editorTicket, editorProject)) { busy = false; for (const field of form.querySelectorAll('input,textarea,select,button')) field.disabled = false; save.disabled = !editable || !canWrite(); reload.disabled = false; renderList(); } }
    });
    detail.append(title);
    if (latest) {
      const comparison = node('details'); comparison.append(node('summary', 'Latest saved version — compare before saving'), node('pre', JSON.stringify({ title: latest.title, description: latest.description || '', labels: latest.labels || [], executionOrder: latest.executionOrder ?? null }, null, 2))); detail.append(comparison);
      notice.textContent = 'Latest revision loaded. Your draft is unchanged; review the saved version before saving.';
    }
    if (!editable) notice.textContent = 'Editing requires the updated Backlog fork. Restart after installing it.';
    if (!canWrite()) notice.textContent = 'Stop the active agent before changing milestones or assignments.';
    detail.append(form);
    if (!isNew && api) { renderTasks(milestone); renderRemoval(milestone, preserve); }
    title.focus();
  }
  function renderTasks(milestone) {
    const section = node('section', undefined, 'milestone-tasks'); section.append(node('h4', 'Task assignments'));
    const filter = node('input'); filter.type = 'search'; filter.placeholder = 'Search task ID, title, or status'; filter.setAttribute('aria-label', 'Search milestone tasks');
    const mode = node('select'); mode.setAttribute('aria-label', 'Task assignment filter');
    for (const [value, label] of [['assigned', 'Assigned tasks'], ['unassigned', 'Unassigned tasks'], ['all', 'All tasks']]) { const option = node('option', label); option.value = value; mode.append(option); }
    const rows = node('div', undefined, 'milestone-task-list'), status = node('p'); status.setAttribute('role', 'status');
    section.append(filter, mode, status, rows); detail.append(section);
    const render = () => {
      rows.replaceChildren();
      const matches = tasks.filter(t => (mode.value === 'all' || (mode.value === 'assigned' ? milestoneMatches(t.milestone, milestone) : !t.milestone)) && `${t.id} ${t.title} ${t.status}`.toLowerCase().includes(filter.value.toLowerCase()));
      status.textContent = `${assigned(milestone).length} assigned · ${matches.length} shown`;
      for (const task of matches) {
        const row = node('div', undefined, 'milestone-task-row'), isAssigned = milestoneMatches(task.milestone, milestone);
        const label = onTask ? button(`${task.id} · ${task.title}`, () => onTask(task.id)) : node('span', `${task.id} · ${task.title}`);
        row.append(label, node('span', `${task.status || 'No status'}${task.milestone ? ` · ${task.milestone}` : ''}`, 'muted'));
        const action = button(isAssigned ? 'Unassign' : 'Assign here', async () => {
          const ticket = generation, project = projectKey();
          if (busy) return;
          try {
            assertWritable(); if (!task.revision) throw new Error('Reload tasks before assigning: the task has no revision.');
            if (!isAssigned && task.milestone && !window.confirm(`Move ${task.id} from ${task.milestone} to ${milestone.id}?`)) return;
            busy = true; editorRequest++; action.disabled = true;
            await api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', body: { milestone: isAssigned ? null : milestone.id, expectedRevision: task.revision } });
            if (!current(ticket, project)) return;
            await onSaved(); if (!current(ticket, project)) return;
            await refresh(); if (!current(ticket, project) || selected !== milestone.id) return;
            render(); status.textContent += ` · ${task.id} ${isAssigned ? 'unassigned' : 'assigned'}.`;
          } catch (error) { if (current(ticket, project)) status.textContent = `${errorText(error)} No retry was made. Refresh tasks and try again.`; }
          finally { if (current(ticket, project)) { busy = false; action.disabled = !canWrite(); } }
        });
        action.disabled = !canWrite() || !task.revision; row.append(action); rows.append(row);
      }
      if (!matches.length) rows.append(node('p', 'No tasks match this filter.', 'muted'));
    };
    filter.addEventListener('input', render); mode.addEventListener('change', render);
    section.append(button('Refresh tasks', async () => { const ticket = generation, project = projectKey(); await refresh(); if (current(ticket, project)) render(); })); render();
  }
  function renderRemoval(milestone, preserve) {
    const section = node('details', undefined, 'milestone-removal'); section.append(node('summary', 'Archive or remove milestone'));
    section.append(node('p', 'Archive hides this milestone and preserves task links. Remove also archives it, with the task-link handling chosen below. No tasks are deleted. These operations apply to the current server state.'));
    const handling = node('select'); handling.setAttribute('aria-label', 'Task handling on milestone removal');
    for (const [value, label] of [['clear', 'Clear milestone links from matching tasks'], ['keep', 'Keep existing task milestone links'], ['reassign', 'Reassign matching tasks to another milestone']]) { const option = node('option', label); option.value = value; handling.append(option); }
    const target = node('select'); target.setAttribute('aria-label', 'Replacement milestone'); target.hidden = true;
    for (const other of sortMilestones(milestones).filter(m => m.id !== milestone.id)) { const option = node('option', `${other.id} · ${other.title}`); option.value = other.id; target.append(option); }
    handling.addEventListener('change', () => { target.hidden = handling.value !== 'reassign'; });
    const status = node('p'); status.setAttribute('role', 'alert');
    const mutate = async archiveOnly => {
      const ticket = generation, project = projectKey();
      if (busy) return;
      try {
        assertWritable(); if (!archiveOnly && handling.value === 'reassign' && !target.value) throw new Error('Choose an active replacement milestone.');
        const outcome = archiveOnly || handling.value === 'keep' ? 'Keep task milestone links unchanged.' : handling.value === 'clear' ? 'Clear the milestone link on all matching local tasks.' : `Move all matching local tasks to ${target.value}.`;
        if (!window.confirm(`${archiveOnly ? 'Archive' : 'Remove'} ${milestone.id}: ${milestone.title}?\n\nArchive this milestone record and hide it from active milestones. ${outcome}\nNo tasks are deleted. Unsaved edits will not be applied. This server has no restore action.`)) return;
        preserve(); busy = true; editorRequest++;
        await api(`${route(milestone.id)}${archiveOnly ? '/archive' : ''}`, { method: archiveOnly ? 'POST' : 'DELETE', ...(!archiveOnly ? { body: { taskHandling: handling.value, ...(handling.value === 'reassign' ? { reassignTo: target.value } : {}) } } : {}) });
        await saved(`${milestone.id} archived. ${outcome}`, ticket, project);
      } catch (error) { if (current(ticket, project)) status.textContent = errorText(error); }
      finally { if (current(ticket, project)) { busy = false; renderList(); } }
    };
    const archiveButton = button('Archive milestone', () => mutate(true)), removeButton = button('Remove milestone', () => mutate(false));
    archiveButton.disabled = removeButton.disabled = !canWrite();
    section.append(archiveButton, handling, target, removeButton, status); detail.append(section);
  }
  async function open(id) {
    if (busy) return;
    const ticket = generation, project = projectKey(), loadRequest = ++editorRequest; selected = id;
    try {
      const milestone = unwrap(await load(id));
      if (!current(ticket, project) || selected !== id || loadRequest !== editorRequest) return;
      renderEditor(milestone, drafts.get(key(id)) || { expectedRevision: milestone.revision, title: milestone.title, description: milestone.description || '', labels: milestone.labels || [], executionOrder: milestone.executionOrder ?? '' });
    } catch (error) { if (current(ticket, project)) message.textContent = errorText(error); }
  }
  async function refresh() {
    const ticket = generation, project = projectKey(), requestId = ++request;
    try {
      const value = await (api ? api('/milestones') : read('/api/milestones'));
      if (!current(ticket, project) || requestId !== request) return;
      const taskValue = api ? await api('/tasks?crossBranch=false') : [];
      if (!current(ticket, project) || requestId !== request) return;
      const archiveValue = api && showArchived ? await api('/milestones/archived') : [];
      if (!current(ticket, project) || requestId !== request) return;
      milestones = Array.isArray(value) ? value : value.milestones || [];
      tasks = Array.isArray(taskValue) ? taskValue : taskValue.tasks || [];
      archived = Array.isArray(archiveValue) ? archiveValue : archiveValue.milestones || [];
      renderList();
    } catch (error) { if (current(ticket, project) && requestId === request) message.textContent = errorText(error); }
  }
  function reset() { generation++; request++; editorRequest++; busy = false; selected = null; milestones = []; tasks = []; archived = []; showArchived = false; search.value = ''; toggle.textContent = 'Show archived'; list.replaceChildren(); detail.replaceChildren(); message.textContent = ''; }
  return { refresh, reset, open, destroy() { reset(); destroyed = true; container.replaceChildren(); } };
}
