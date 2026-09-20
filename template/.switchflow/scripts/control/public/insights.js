const settingsDrafts = new Map();
function storeDraft(project, draft) {
  settingsDrafts.set(String(project),draft);
  try { sessionStorage.setItem('switchflow:settings:'+project,JSON.stringify({values:draft.values,dirtyFields:[...draft.dirtyFields]})); } catch {}
}
function clearDraft(project) { settingsDrafts.delete(project); try {sessionStorage.removeItem('switchflow:settings:'+project);} catch {} }


const editableFields = [
  'projectName', 'dateFormat', 'autoCommit', 'remoteOperations', 'defaultStatus',
  'defaultEditor', 'definitionOfDone', 'defaultPort', 'autoOpenBrowser',
  'hideEmptyColumns', 'maxColumnWidth', 'taskResolutionStrategy', 'zeroPaddedIds',
];

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const count = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const text = value => value === null || value === undefined ? '' : String(value);

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = text(content);
  return element;
}

function action(label, className = 'button quiet') {
  const button = node('button', className, label);
  button.type = 'button';
  return button;
}

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

function isWritable(canWrite) {
  return typeof canWrite === 'function' ? Boolean(canWrite()) : Boolean(canWrite);
}

function editableValues(config) {
  const result = {};
  for (const field of editableFields) result[field] = clone(config?.[field]);
  return result;
}

function normalizeList(items) {
  const values = Array.isArray(items) ? items.map(item => text(item).trim()).filter(Boolean) : [];
  return values.length ? values : undefined;
}

export function mergeSettingsConfig(latest, values, dirtyFields) {
  const merged = clone(latest) || {};
  for (const field of dirtyFields) {
    if (!editableFields.includes(field)) continue;
    let value = clone(values[field]);
    if (field === 'definitionOfDone') value = normalizeList(value);
    if (['defaultPort', 'maxColumnWidth', 'zeroPaddedIds'].includes(field)) {
      value = value === '' || value === null || value === undefined ? undefined : Number(value);
    }
    if (value === undefined) delete merged[field];
    else merged[field] = value;
  }
  return merged;
}

export function validateSettingsDraft(values, statuses = []) {
  const errors = {};
  if (!text(values.projectName).trim()) errors.projectName = 'Enter a project name.';
  if (!['yyyy-mm-dd', 'dd/mm/yyyy', 'mm/dd/yyyy'].includes(values.dateFormat || 'yyyy-mm-dd')) errors.dateFormat = 'Choose a supported date format.';
  if (values.defaultStatus && !statuses.includes(values.defaultStatus)) errors.defaultStatus = 'Choose a status that exists in this project.';
  const integer = (field, label, minimum, maximum, optional = false) => {
    const value = values[field];
    if (optional && (value === '' || value === undefined || value === null)) return;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) errors[field] = `${label} must be a whole number from ${minimum} to ${maximum}.`;
  };
  integer('defaultPort', 'Port', 1, 65535, true);
  integer('maxColumnWidth', 'Column width', 20, 200, true);
  integer('zeroPaddedIds', 'ID padding', 0, 10, true);
  if (values.taskResolutionStrategy && !['most_recent', 'most_progressed'].includes(values.taskResolutionStrategy)) errors.taskResolutionStrategy = 'Choose a task resolution strategy.';
  return errors;
}

export function buildStatisticsModel(statistics = {}, taskResult = []) {
  const tasks = Array.isArray(taskResult) ? taskResult : Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];
  const totalTasks = count(statistics.totalTasks);
  const status = Object.entries(statistics.statusCounts || {}).map(([label, value]) => ({ label, count: count(value) }));
  const priority = Object.entries(statistics.priorityCounts || {}).map(([label, value]) => ({ label, count: count(value) }));
  const noPriority = count(statistics.noPriorityCount);
  if (noPriority || !priority.length) priority.push({ label: 'No priority', count: noPriority });

  const countedTasks = tasks.filter(task => text(task?.status).trim());
  const corpusMatches = countedTasks.length === totalTasks;
  const milestones = new Map();
  const completed = [];
  if (corpusMatches) {
    for (const task of countedTasks) {
      const milestone = text(task.milestone).trim() || 'No milestone';
      milestones.set(milestone, (milestones.get(milestone) || 0) + 1);
      if (text(task.status).toLocaleLowerCase() === 'done') completed.push(task);
    }
    completed.sort((a, b) => Date.parse(b.updatedDate || b.createdDate || 0) - Date.parse(a.updatedDate || a.createdDate || 0));
  }
  return {
    totalTasks,
    completedTasks: count(statistics.completedTasks),
    completionPercentage: Math.min(100, count(statistics.completionPercentage)),
    draftCount: count(statistics.draftCount),
    status,
    priority,
    milestones: [...milestones].map(([label, value]) => ({ label, count: value })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    completionHistory: completed,
    corpusMatches,
    corpusCount: countedTasks.length,
  };
}

function renderDistribution(title, rows, total, emptyMessage) {
  const card = node('section', 'insights-card insights-distribution');
  card.append(node('h2', '', title));
  if (!rows.length) {
    card.append(node('p', 'muted', emptyMessage));
    return card;
  }
  const list = node('div', 'insights-bars');
  for (const row of rows) {
    const item = node('div', 'insights-bar-row');
    const heading = node('div', 'insights-bar-heading');
    heading.append(node('span', '', row.label), node('strong', '', row.count));
    const progress = node('progress');
    progress.max = Math.max(total, 1);
    progress.value = Math.min(row.count, progress.max);
    progress.setAttribute('aria-label', `${row.label}: ${row.count} of ${total}`);
    item.append(heading, progress);
    list.append(item);
  }
  card.append(list);
  return card;
}

function formatDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function renderStatistics(container, model, refresh) {
  container.replaceChildren();
  const header = node('div', 'insights-heading');
  const copy = node('div');
  copy.append(node('p', 'eyebrow', 'PROJECT INSIGHTS'), node('h1', '', 'Statistics'), node('p', 'muted', 'Current task distribution and progress for this project.'));
  const reload = action('Refresh statistics');
  reload.addEventListener('click', refresh);
  header.append(copy, reload);

  const metrics = node('div', 'insights-metrics');
  for (const [label, value, detail] of [
    ['Total tasks', model.totalTasks, 'Tracked across the project'],
    ['Completed', model.completedTasks, `${model.totalTasks - model.completedTasks} remaining`],
    ['Completion', `${model.completionPercentage}%`, 'Share marked Done'],
    ['Drafts', model.draftCount, 'Not yet active tasks'],
  ]) {
    const card = node('article', 'insights-card insights-metric');
    card.append(node('span', 'insights-metric-label', label), node('strong', 'insights-metric-value', value), node('span', 'muted', detail));
    metrics.append(card);
  }

  const overall = node('section', 'insights-card insights-overall');
  const overallHeading = node('div', 'insights-bar-heading');
  overallHeading.append(node('h2', '', 'Overall progress'), node('strong', '', `${model.completionPercentage}%`));
  const overallProgress = node('progress');
  overallProgress.max = 100;
  overallProgress.value = model.completionPercentage;
  overallProgress.setAttribute('aria-label', `Overall completion: ${model.completionPercentage}%`);
  overall.append(overallHeading, overallProgress);

  const distributions = node('div', 'insights-grid');
  distributions.append(
    renderDistribution('Status distribution', model.status, model.totalTasks, 'No task statuses were returned.'),
    renderDistribution('Priority distribution', model.priority, model.totalTasks, 'No task priorities were returned.'),
  );
  if (model.corpusMatches) distributions.append(renderDistribution('Milestone distribution', model.milestones, model.totalTasks, 'No milestone assignments were returned.'));
  else {
    const unavailable = node('section', 'insights-card');
    unavailable.append(node('h2', '', 'Milestone distribution'), node('p', 'insights-inline-warning', `The native task corpus returned ${model.corpusCount} counted tasks while statistics returned ${model.totalTasks}. Refresh before using this breakdown.`));
    distributions.append(unavailable);
  }

  const history = node('section', 'insights-card insights-history');
  history.append(node('h2', '', 'Done tasks'));
  if (!model.corpusMatches) history.append(node('p', 'muted', 'Completion rows are withheld until the native task corpus matches the statistics total.'));
  else if (!model.completionHistory.length) history.append(node('p', 'muted', 'No completed tasks yet.'));
  else {
    const scroll = node('div', 'insights-table-scroll');
    const table = node('table', 'insights-table');
    const head = node('thead');
    const headRow = node('tr');
    for (const label of ['Task', 'Milestone', 'Last updated']) headRow.append(node('th', '', label));
    head.append(headRow);
    const body = node('tbody');
    for (const task of model.completionHistory) {
      const row = node('tr');
      const taskCell = node('td');
      taskCell.append(node('strong', '', task.title || task.id || 'Untitled task'), node('span', 'muted insights-task-id', task.id || ''));
      row.append(taskCell, node('td', '', task.milestone || 'No milestone'), node('td', '', formatDate(task.updatedDate || task.createdDate)));
      body.append(row);
    }
    table.append(head, body); scroll.append(table); history.append(scroll);
  }
  container.append(header, metrics, overall, distributions, history);
}

function appendHelp(label, message) {
  const help = node('span', 'insights-field-help', message);
  help.id = `${label.htmlFor}-help`;
  label.append(help);
  return help.id;
}

function fieldId(projectId, name) {
  return `insights-${String(projectId).slice(0, 12).replace(/[^a-z0-9-]/gi, '-')}-${name}`;
}

function setFieldError(form, name, message) {
  const target = form.querySelector(`[data-error-for="${name}"]`);
  const input = form.elements.namedItem(name);
  if (target) { target.textContent = message || ''; target.hidden = !message; }
  if (input instanceof HTMLElement) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function renderSettings(container, context) {
  const { projectId, canWrite, refresh, save, discard, latestConfig, draft } = context;
  const writable = isWritable(canWrite);
  container.replaceChildren();
  const header = node('div', 'insights-heading');
  const copy = node('div');
  copy.append(node('p', 'eyebrow', 'PROJECT CONFIGURATION'), node('h1', '', 'Settings'), node('p', 'muted', 'Manage project defaults and task behavior. Other configuration stays intact.'));
  const reload = action('Refresh saved settings'); reload.addEventListener('click', refresh); header.append(copy, reload); container.append(header);
  if (!writable) container.append(node('p', 'insights-readonly', 'Settings are read-only while project delivery is active or your access does not allow changes.'));

  const form = node('form', 'insights-settings');
  form.noValidate = true;
  const status = node('p', 'insights-form-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const values = draft.values;
  const mark = (field, value) => {
    draft.values[field] = value;
    draft.dirtyFields.add(field);
    storeDraft(projectId,draft);
    status.textContent = 'Unsaved changes';
    status.className = 'insights-form-status is-dirty';
    setFieldError(form, field, '');
    controls.querySelector('[data-save]').disabled = !writable;
    controls.querySelector('[data-discard]').disabled = false;
  };
  const section = (title, description) => {
    const card = node('section', 'insights-card insights-settings-section');
    card.append(node('h2', '', title), node('p', 'muted', description));
    const grid = node('div', 'insights-fields'); card.append(grid); form.append(card); return grid;
  };
  const inputField = (grid, name, labelText, help, options = {}) => {
    const wrap = node('div', 'insights-field');
    const label = node('label', '', labelText); const id = fieldId(projectId, name); label.htmlFor = id;
    const helpId = appendHelp(label, help);
    const input = node(options.select ? 'select' : 'input'); input.id = id; input.name = name; input.disabled = !writable || Boolean(options.disabled); input.setAttribute('aria-describedby', helpId);
    if (options.type) input.type = options.type;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.step !== undefined) input.step = String(options.step);
    if (options.required) input.required = true;
    if (options.select) for (const [value, labelText] of options.select) { const option = node('option', '', labelText); option.value = value; input.append(option); }
    input.value = values[name] ?? options.fallback ?? '';
    input.addEventListener('input', () => mark(name, options.number ? input.value : input.value));
    const error = node('span', 'insights-field-error'); error.dataset.errorFor = name; error.hidden = true;
    wrap.append(label, input, error); grid.append(wrap); return input;
  };
  const toggle = (grid, name, labelText, help) => {
    const label = node('label', 'insights-toggle');
    const input = node('input'); input.type = 'checkbox'; input.name = name; input.checked = Boolean(values[name]); input.disabled = !writable;
    const description = node('span'); description.append(node('strong', '', labelText), node('small', '', help));
    input.addEventListener('change', () => mark(name, input.checked)); label.append(input, description); grid.append(label);
  };

  const project = section('Project', 'Naming and display defaults for project work.');
  inputField(project, 'projectName', 'Project name', 'Shown in the board and generated project views.', { required: true });
  inputField(project, 'dateFormat', 'Date format', 'Changes display only; task files keep their native stored format.', { select: [['yyyy-mm-dd', 'YYYY-MM-DD'], ['dd/mm/yyyy', 'DD/MM/YYYY'], ['mm/dd/yyyy', 'MM/DD/YYYY']], fallback: 'yyyy-mm-dd' });
  const statuses = Array.isArray(latestConfig.statuses) ? latestConfig.statuses : [];
  inputField(project, 'defaultStatus', 'Default task status', 'Applied to newly created tasks.', { select: statuses.map(value => [value, value]), fallback: statuses[0] || '' });

  const workflow = section('Workflow', 'Native Git and task defaults.');
  toggle(workflow, 'autoCommit', 'Automatically commit task changes', 'Creates a Git commit after supported task operations.');
  toggle(workflow, 'remoteOperations', 'Read active branches', 'Includes task information from active Git branches.');
  inputField(workflow, 'defaultEditor', 'Editor command', 'Overrides the EDITOR environment variable for task editing.', { placeholder: 'For example: code --wait' });
  const prefix = inputField(workflow, 'taskPrefix', 'Task prefix', 'Set during initialization and read-only to protect existing task IDs.', { disabled: true });
  prefix.value = text(latestConfig.prefixes?.task || 'task').toLocaleUpperCase();

  const doneCard = section('Definition of Done defaults', 'Each non-empty item is added to new tasks.');
  doneCard.classList.add('insights-list-field');
  const list = node('div', 'insights-list'); doneCard.append(list);
  const renderDone = () => {
    list.replaceChildren();
    const items = Array.isArray(values.definitionOfDone) ? values.definitionOfDone : [];
    items.forEach((item, index) => {
      const row = node('div', 'insights-list-row');
      const label = node('label', 'sr-only', `Definition of Done item ${index + 1}`); const input = node('input'); input.value = item; input.disabled = !writable; input.maxLength = 500;
      label.htmlFor = input.id = fieldId(projectId, `done-${index}`);
      input.addEventListener('input', () => { const next = [...values.definitionOfDone]; next[index] = input.value; mark('definitionOfDone', next); });
      const remove = action('Remove', 'button quiet'); remove.disabled = !writable; remove.addEventListener('click', () => { mark('definitionOfDone', values.definitionOfDone.filter((_, itemIndex) => itemIndex !== index)); renderDone(); });
      row.append(label, input, remove); list.append(row);
    });
  };
  renderDone();
  const add = action('Add checklist item', 'button quiet'); add.disabled = !writable; add.addEventListener('click', () => { mark('definitionOfDone', [...(values.definitionOfDone || []), '']); renderDone(); list.querySelector('input:last-of-type')?.focus(); }); doneCard.append(add);

  const web = section('Web interface', 'Defaults used when the native Backlog browser starts.');
  inputField(web, 'defaultPort', 'Default port', 'Port used when no command-line port is provided.', { type: 'number', number: true, min: 1, max: 65535, fallback: 6420 });
  toggle(web, 'autoOpenBrowser', 'Open browser automatically', 'Opens the native board after its local server starts.');
  toggle(web, 'hideEmptyColumns', 'Hide empty board columns', 'Hide empty columns in Tasks. Use Open / move to select any status.');

  const advanced = section('Advanced', 'Task selection and command-line presentation.');
  inputField(advanced, 'maxColumnWidth', 'Maximum CLI column width', 'Limits text column width in terminal output.', { type: 'number', number: true, min: 20, max: 200, fallback: 80 });
  inputField(advanced, 'taskResolutionStrategy', 'Cross-branch task resolution', 'Chooses which copy wins when a task exists on more than one branch.', { select: [['most_recent', 'Most recently updated'], ['most_progressed', 'Most progressed status']], fallback: 'most_recent' });
  inputField(advanced, 'zeroPaddedIds', 'Task ID padding', 'Use 0 to disable; 3 produces task-001.', { type: 'number', number: true, min: 0, max: 10, fallback: 0 });

  const controls = node('div', 'insights-form-actions');
  const discardButton = action('Discard changes'); discardButton.dataset.discard = ''; discardButton.disabled = !draft.dirtyFields.size; discardButton.addEventListener('click', discard);
  const saveButton = action('Save settings', 'button primary'); saveButton.dataset.save = ''; saveButton.type = 'submit'; saveButton.disabled = !writable || !draft.dirtyFields.size;
  controls.append(status, discardButton, saveButton); form.append(controls);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const errors = validateSettingsDraft(values, statuses);
    for (const field of editableFields) setFieldError(form, field, errors[field]);
    if (Object.keys(errors).length) { status.textContent = 'Fix the highlighted settings before saving.'; status.className = 'insights-form-status is-error'; form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    await save({ status, saveButton, discardButton });
  });
  container.append(form);
}

export function mountInsights(container, { api, projectId, canWrite = false, onChange = async () => {}, kind } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('mountInsights requires an HTML container.');
  if (typeof api !== 'function') throw new TypeError('mountInsights requires an api function.');
  if (!projectId) throw new TypeError('mountInsights requires an explicit projectId.');
  if (!['statistics', 'settings'].includes(kind)) throw new TypeError("kind must be 'statistics' or 'settings'.");
  let destroyed = false, saving = false;
  let generation = 0;
  let latestConfig = null;
  const projectKey = String(projectId);
  if (!settingsDrafts.has(projectKey)) { try { const stored = JSON.parse(sessionStorage.getItem('switchflow:settings:'+projectKey) || 'null'); if (stored?.values && Array.isArray(stored.dirtyFields)) settingsDrafts.set(projectKey,{values:stored.values,dirtyFields:new Set(stored.dirtyFields)}); } catch {} }
  let statisticsSignature = '';

  container.classList.add('insights-panel');
  container.dataset.insightsKind = kind;

  const loading = message => {
    if (destroyed) return;
    container.replaceChildren();
    const state = node('div', 'insights-state'); state.setAttribute('role', 'status'); state.append(node('strong', '', message), node('p', 'muted', 'Reading the connected project.')); container.append(state);
  };
  const failure = (error, retry) => {
    if (destroyed) return;
    container.replaceChildren();
    const state = node('div', 'insights-state insights-state-error'); state.setAttribute('role', 'alert');
    state.append(node('strong', '', errorMessage(error, `Unable to load ${kind}.`)), node('p', 'muted', 'Your saved project data was not changed.'));
    const button = action('Try again'); button.addEventListener('click', retry); state.append(button); container.append(state);
  };

  async function refreshStatistics() {
    const ticket = ++generation; if (!container.querySelector('.insights-metrics')) loading('Loading project statistics…');
    const [statistics, tasks] = await Promise.allSettled([api('/statistics'), api('/tasks')]);
    if (destroyed || ticket !== generation) return;
    if (statistics.status === 'rejected') { failure(statistics.reason, refreshStatistics); return; }
    const taskResult = tasks.status === 'fulfilled' ? tasks.value : [];
    const model = buildStatisticsModel(statistics.value, taskResult);
    if (tasks.status === 'rejected') { model.corpusMatches = false; model.corpusCount = 0; }
    const signature = JSON.stringify(model); if (signature !== statisticsSignature) { statisticsSignature = signature; renderStatistics(container, model, refreshStatistics); }
  }

  async function saveSettings({ status, saveButton, discardButton }) {
    if (saving) return;
    if (!isWritable(canWrite)) { status.textContent = 'Settings are read-only right now.'; status.className = 'insights-form-status is-error'; return; }
    const draft = settingsDrafts.get(projectKey);
    if (!draft?.dirtyFields.size) return;
    saving = true;
    const controls = [...container.querySelectorAll('input,select,button')].map(field => [field,field.disabled]);
    for (const [field] of controls) field.disabled = true;
    status.textContent = 'Saving settings…'; status.className = 'insights-form-status';
    try {
      const current = await api('/config');
      const payload = mergeSettingsConfig(current, draft.values, draft.dirtyFields);
      const saved = await api('/config', { method: 'PUT', body: payload });
      latestConfig = saved && typeof saved === 'object' ? saved : payload;
      clearDraft(projectKey);
      if (!destroyed) renderSettings(container, settingsContext());
      try { await onChange({ kind: 'settings', projectId, config: latestConfig }); }
      catch (error) {
        const currentStatus = container.querySelector('.insights-form-status');
        if (currentStatus) { currentStatus.textContent = `Settings saved. ${errorMessage(error, 'The workspace could not refresh.')}`; currentStatus.className = 'insights-form-status is-error'; }
      }
      const currentStatus = container.querySelector('.insights-form-status');
      if (currentStatus && !currentStatus.textContent) currentStatus.textContent = 'Settings saved.';
    } catch (error) {
      if (destroyed) return;
      status.textContent = `${errorMessage(error, 'Unable to save settings.')} Your changes are still here.`;
      status.className = 'insights-form-status is-error';
      saveButton.disabled = false; discardButton.disabled = false;
    } finally { saving = false; for (const [field,disabled] of controls) if (field.isConnected) field.disabled = disabled; }
  }

  function discardSettings() {
    clearDraft(projectKey);
    renderSettings(container, settingsContext());
    container.querySelector('input,select,button')?.focus();
  }

  function settingsContext() {
    let draft = settingsDrafts.get(projectKey);
    if (!draft) draft = { values: editableValues(latestConfig), dirtyFields: new Set() };
    return { projectId, canWrite, refresh: refreshSettings, save: saveSettings, discard: discardSettings, latestConfig, draft };
  }

  async function refreshSettings() {
    if (saving) return;
    const ticket = ++generation;
    const draft = settingsDrafts.get(projectKey);
    if (!container.querySelector('.insights-settings')) loading('Loading project settings…');
    try {
      const config = await api('/config');
      if (destroyed || ticket !== generation) return;
      const changed = JSON.stringify(latestConfig) !== JSON.stringify(config); latestConfig = config;
      if (draft?.dirtyFields.size) {
        if (!container.querySelector('.insights-settings')) renderSettings(container, settingsContext());
        const status = container.querySelector('.insights-form-status');
        if (status) { status.textContent = 'Saved settings refreshed; your unsaved changes are unchanged.'; status.className = 'insights-form-status is-dirty'; }
      } else if (changed || !container.querySelector('.insights-settings')) renderSettings(container, settingsContext());
    } catch (error) {
      if (destroyed || ticket !== generation) return;
      if (draft?.dirtyFields.size) {
        const status = container.querySelector('.insights-form-status');
        if (status) { status.textContent = `${errorMessage(error, 'Unable to refresh settings.')} Your changes are still here.`; status.className = 'insights-form-status is-error'; }
      } else failure(error, refreshSettings);
    }
  }

  const refresh = kind === 'statistics' ? refreshStatistics : refreshSettings;
  void refresh();
  return {
    refresh,
    destroy() {
      destroyed = true; generation++;
      container.classList.remove('insights-panel'); delete container.dataset.insightsKind; container.replaceChildren();
    },
  };
}
