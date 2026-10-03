import { formatProjectDate, normalizeDateFormat } from './ui-date.js';
import { createRefreshControl } from './refresh-control.js';

const settingsDrafts = new Map();
function storeDraft(project, draft) {
  settingsDrafts.set(String(project), draft);
  try {
    sessionStorage.setItem(
      'switchflow:settings:' + project,
      JSON.stringify({ values: draft.values, dirtyFields: [...draft.dirtyFields] }),
    );
  } catch {}
}
function clearDraft(project) {
  settingsDrafts.delete(project);
  try {
    sessionStorage.removeItem('switchflow:settings:' + project);
  } catch {}
}

const editableFields = [
  'projectName',
  'dateFormat',
  'autoCommit',
  'remoteOperations',
  'defaultStatus',
  'defaultEditor',
  'definitionOfDone',
  'defaultPort',
  'autoOpenBrowser',
  'hideEmptyColumns',
  'maxColumnWidth',
  'taskResolutionStrategy',
  'zeroPaddedIds',
];

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const count = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const text = value => (value === null || value === undefined ? '' : String(value));
const percent = (value, total) => (total ? Math.round((100 * value) / total) : 0);
const SVG = 'http://www.w3.org/2000/svg';

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = text(content);
  return element;
}

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
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

/** Maps a project status name to the shared status token key used by `data-status`. */
export function statusKey(label) {
  const value = text(label).toLocaleLowerCase().trim().replace(/[-_]+/g, ' ');
  if (['done', 'complete', 'completed'].includes(value)) return 'done';
  if (value === 'blocked') return 'blocked';
  if (value.includes('review')) return 'review';
  if (['in progress', 'doing', 'running', 'active'].includes(value)) return 'in progress';
  if (value === 'ready') return 'ready';
  return 'backlog';
}

const priorityOrder = ['critical', 'urgent', 'highest', 'high', 'medium', 'normal', 'low', 'lowest'];

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
  if (!['yyyy-mm-dd', 'dd/mm/yyyy', 'mm/dd/yyyy'].includes(values.dateFormat || 'yyyy-mm-dd'))
    errors.dateFormat = 'Choose a supported date format.';
  if (values.defaultStatus && !statuses.includes(values.defaultStatus))
    errors.defaultStatus = 'Choose a status that exists in this project.';
  const integer = (field, label, minimum, maximum, optional = false) => {
    const value = values[field];
    if (optional && (value === '' || value === undefined || value === null)) return;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
      errors[field] = `${label} must be a whole number from ${minimum} to ${maximum}.`;
  };
  integer('defaultPort', 'Port', 1, 65535, true);
  integer('maxColumnWidth', 'Column width', 20, 200, true);
  integer('zeroPaddedIds', 'ID padding', 0, 10, true);
  if (values.taskResolutionStrategy && !['most_recent', 'most_progressed'].includes(values.taskResolutionStrategy))
    errors.taskResolutionStrategy = 'Choose a task resolution strategy.';
  return errors;
}

export function buildStatisticsModel(statistics = {}, taskResult = [], milestoneResult) {
  const tasks = Array.isArray(taskResult) ? taskResult : Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];
  const milestoneLookupAvailable = Array.isArray(milestoneResult);
  const milestoneTitles = new Map(
    (milestoneLookupAvailable ? milestoneResult : []).map(item => [
      text(item.id).trim(),
      text(item.title || item.name || item.id).trim(),
    ]),
  );
  const milestoneTitle = value => {
    const id = text(value).trim();
    if (!id) return 'No milestone';
    if (!milestoneLookupAvailable) return 'Milestone title unavailable';
    return milestoneTitles.get(id) || 'Unknown milestone';
  };
  const totalTasks = count(statistics.totalTasks);
  const status = Object.entries(statistics.statusCounts || {}).map(([label, value]) => ({
    label,
    count: count(value),
  }));
  const priority = Object.entries(statistics.priorityCounts || {}).map(([label, value]) => ({
    label,
    count: count(value),
  }));
  const noPriority = count(statistics.noPriorityCount);
  if (noPriority || !priority.length) priority.push({ label: 'No priority', count: noPriority });

  const countedTasks = tasks.filter(task => text(task?.status).trim());
  const corpusMatches = countedTasks.length === totalTasks;
  const milestones = new Map();
  const completed = [];
  if (corpusMatches) {
    for (const task of countedTasks) {
      const milestone = milestoneTitle(task.milestone);
      milestones.set(milestone, (milestones.get(milestone) || 0) + 1);
      if (text(task.status).toLocaleLowerCase() === 'done') completed.push({ ...task, milestoneTitle: milestone });
    }
    completed.sort(
      (a, b) => Date.parse(b.updatedDate || b.createdDate || 0) - Date.parse(a.updatedDate || a.createdDate || 0),
    );
  }
  return {
    totalTasks,
    completedTasks: count(statistics.completedTasks),
    completionPercentage: Math.min(100, count(statistics.completionPercentage)),
    draftCount: count(statistics.draftCount),
    status,
    priority,
    milestones: [...milestones]
      .map(([label, value]) => ({ label, count: value }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    completionHistory: completed,
    corpusMatches,
    corpusCount: countedTasks.length,
    milestoneLookupAvailable,
  };
}

export function completionPage(items, requestedPage = 0, pageSize = 20) {
  const total = Array.isArray(items) ? items.length : 0;
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 20;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, pages - 1));
  const startIndex = page * size;
  return {
    items: (items || []).slice(startIndex, startIndex + size),
    page,
    pages,
    total,
    start: total ? startIndex + 1 : 0,
    end: Math.min(total, startIndex + size),
  };
}

/** Keeps the largest rows and folds the rest into one "Other" row so a breakdown never grows unbounded. */
export function foldRows(rows, limit = 7) {
  if (rows.length <= limit + 1) return rows;
  const kept = rows.slice(0, limit);
  const rest = rows.slice(limit);
  return [
    ...kept,
    { label: `Other (${rest.length})`, count: rest.reduce((sum, row) => sum + row.count, 0), other: true },
  ];
}

/* Insights ------------------------------------------------------------------------------------ */

function panel(title, className, meta) {
  const section = node('section', `panel insights-panel-block ${className || ''}`.trim());
  const header = node('header', 'panel-header');
  const heading = node('h2', '', title);
  header.append(heading);
  if (meta !== undefined) header.append(node('span', 'insights-panel-meta', meta));
  const body = node('div', 'panel-body');
  section.append(header, body);
  return { section, header, body };
}

function tile(label, value, detail, status) {
  const card = node('article', 'panel insights-tile');
  const heading = node('span', 'insights-tile-label');
  if (status) {
    const dot = node('span', 'status-dot');
    dot.dataset.status = status;
    dot.setAttribute('aria-hidden', 'true');
    heading.append(dot);
  }
  heading.append(document.createTextNode(label));
  card.append(heading, node('strong', 'insights-tile-value', value));
  if (detail) card.append(node('span', 'insights-tile-detail', detail));
  return card;
}

function renderStatusChart(rows, total) {
  const block = panel('Status', 'insights-status', `${total} tasks`);
  if (!rows.length || !total) {
    block.body.append(node('p', 'empty', 'No task statuses yet.'));
    return block.section;
  }
  const chart = svg('svg', {
    class: 'insights-stack',
    width: '100%',
    height: 16,
    role: 'img',
    'aria-label': rows.map(row => `${row.label} ${row.count}`).join(', '),
  });
  const legend = node('ul', 'insights-legend');
  const segments = [];
  let offset = 0;
  rows.forEach((row, index) => {
    const share = (100 * row.count) / total;
    const key = statusKey(row.label);
    if (row.count) {
      const rect = svg('rect', { x: `${offset}%`, y: 0, width: `${share}%`, height: 16 });
      rect.classList.add('insights-segment');
      rect.dataset.status = key;
      rect.dataset.index = String(index);
      const title = svg('title');
      title.textContent = `${row.label}: ${row.count} (${percent(row.count, total)}%)`;
      rect.append(title);
      chart.append(rect);
      segments.push(rect);
    }
    offset += share;
    const item = node('li', 'insights-legend-row');
    item.dataset.index = String(index);
    const dot = node('span', 'status-dot');
    dot.dataset.status = key;
    dot.setAttribute('aria-hidden', 'true');
    item.append(
      dot,
      node('span', 'insights-legend-label', row.label),
      node('span', 'insights-legend-count', row.count),
      node('span', 'insights-legend-share', `${percent(row.count, total)}%`),
    );
    legend.append(item);
  });
  const highlight = index => {
    for (const element of [...segments, ...legend.children])
      element.classList.toggle('is-dim', index !== null && element.dataset.index !== index);
  };
  for (const target of [chart, legend]) {
    target.addEventListener('pointerover', event => {
      const index = event.target.closest?.('[data-index]')?.dataset.index;
      if (index !== undefined) highlight(index);
    });
    target.addEventListener('pointerleave', () => highlight(null));
  }
  block.body.append(chart, legend);
  return block.section;
}

function renderBars(title, rows, total, emptyMessage, className) {
  const block = panel(title, `insights-bars ${className || ''}`);
  if (!rows.length) {
    block.body.append(node('p', 'empty', emptyMessage));
    return block.section;
  }
  const list = node('ul', 'insights-bar-list');
  for (const row of rows) {
    const item = node('li', 'insights-bar-row');
    if (row.other) item.classList.add('is-other');
    const share = percent(row.count, total);
    const bar = svg('svg', { class: 'insights-bar', width: '100%', height: 8, 'aria-hidden': 'true' });
    const track = svg('rect', { width: '100%', height: 8, rx: 4 });
    track.classList.add('insights-bar-track');
    bar.append(track);
    if (row.count) {
      const fill = svg('rect', { width: `${Math.max(share, 1)}%`, height: 8, rx: 4 });
      fill.classList.add('insights-bar-fill');
      bar.append(fill);
    }
    const label = node('span', 'insights-bar-label', row.label);
    label.title = row.label;
    item.append(label, bar, node('span', 'insights-bar-value', row.count));
    item.setAttribute('aria-label', `${row.label}: ${row.count} of ${total} (${share}%)`);
    list.append(item);
  }
  block.body.append(list);
  return block.section;
}

function sortPriority(rows) {
  const rank = label => {
    const index = priorityOrder.indexOf(text(label).toLocaleLowerCase());
    return index < 0 ? priorityOrder.length : index;
  };
  return [...rows].sort((a, b) => {
    if (a.label === 'No priority') return 1;
    if (b.label === 'No priority') return -1;
    return rank(a.label) - rank(b.label) || a.label.localeCompare(b.label);
  });
}

function capitalise(value) {
  const label = text(value);
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

function renderHistory(model, { onOpenTask, dateFormat, historyState }) {
  const block = panel('Completed tasks', 'insights-history');
  const total = model.completionHistory.length;
  if (!model.corpusMatches) {
    block.body.append(
      node(
        'p',
        'insights-note',
        `The task list (${model.corpusCount}) and totals (${model.totalTasks}) disagree. Refresh to load completed tasks.`,
      ),
    );
    return block.section;
  }
  if (!total) {
    const empty = node('div', 'empty');
    empty.append(node('strong', '', 'Nothing completed yet'), node('span', '', 'Tasks marked Done appear here.'));
    block.body.append(empty);
    return block.section;
  }
  block.header.querySelector('h2').append(' ', node('span', 'count', total));
  const pager = node('div', 'insights-pager');
  const range = node('span', 'insights-pager-range');
  const previous = action('Newer', 'button quiet button-small');
  const next = action('Older', 'button quiet button-small');
  previous.setAttribute('aria-label', 'Newer completed tasks');
  next.setAttribute('aria-label', 'Older completed tasks');
  pager.append(range, previous, next);
  block.header.append(pager);

  const listStatus = node('p', 'sr-only');
  listStatus.setAttribute('role', 'status');
  listStatus.setAttribute('aria-live', 'polite');
  const scroll = node('div', 'insights-table-scroll');
  const table = node('table', 'data-table insights-table');
  const caption = node('caption', 'sr-only', 'Completed tasks, most recently updated first');
  const head = node('thead');
  const headRow = node('tr');
  for (const label of ['Task', 'Milestone', 'Last updated']) {
    const cell = node('th', '', label);
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  const body = node('tbody');
  table.append(caption, head, body);
  scroll.append(table);
  block.body.classList.add('insights-history-body');
  block.body.append(listStatus, scroll);

  const draw = focus => {
    const page = completionPage(model.completionHistory, historyState.page);
    historyState.page = page.page;
    body.replaceChildren();
    for (const task of page.items) {
      const row = node('tr');
      const taskCell = node('td', 'insights-task-cell');
      const status = node('span', 'status-dot');
      status.dataset.status = 'done';
      status.setAttribute('aria-hidden', 'true');
      taskCell.append(status);
      if (typeof onOpenTask === 'function' && task.id) {
        const link = action(task.title || task.id || 'Untitled task', 'insights-task-link');
        link.addEventListener('click', () =>
          Promise.resolve(onOpenTask(task.id, link)).catch(error => {
            listStatus.textContent = `${errorMessage(error, 'Unable to open task.')} This page is unchanged.`;
          }),
        );
        taskCell.append(link);
      } else taskCell.append(node('span', 'insights-task-title', task.title || task.id || 'Untitled task'));
      taskCell.append(node('span', 'insights-task-id', task.id || ''));
      row.append(
        taskCell,
        node('td', 'insights-milestone-cell', task.milestoneTitle || 'No milestone'),
        node('td', 'insights-date-cell', formatProjectDate(task.updatedDate || task.createdDate, dateFormat)),
      );
      body.append(row);
    }
    range.textContent = `${page.start}–${page.end} of ${page.total}`;
    listStatus.textContent = `Showing completed tasks ${page.start} to ${page.end} of ${page.total}.`;
    previous.disabled = page.page === 0;
    next.disabled = page.page + 1 >= page.pages;
    if (focus) (focus.disabled ? (focus === previous ? next : previous) : focus).focus();
  };
  previous.addEventListener('click', () => {
    historyState.page--;
    draw(previous);
  });
  next.addEventListener('click', () => {
    historyState.page++;
    draw(next);
  });
  draw();
  return block.section;
}

function renderStatistics(
  container,
  model,
  { refreshControl, onOpenTask, dateFormat, historyState, dateFormatAvailable = true },
) {
  container.replaceChildren();
  const header = node('header', 'page-header');
  const copy = node('div');
  copy.append(
    node('h1', '', 'Insights'),
    node('p', '', model.totalTasks ? 'Where the work stands and what has been completed.' : 'No tasks yet.'),
  );
  const actions = node('div', 'page-actions');
  actions.append(refreshControl.create());
  header.append(copy, actions);

  const statusTotal = key =>
    model.status.filter(row => statusKey(row.label) === key).reduce((sum, row) => sum + row.count, 0);
  const hasStatus = key => model.status.some(row => statusKey(row.label) === key);
  const tiles = node('div', 'insights-tiles');
  tiles.append(
    tile('Total tasks', model.totalTasks, model.draftCount ? `${model.draftCount} drafts not counted` : 'Active tasks'),
  );
  const done = tile(
    'Done',
    `${model.completionPercentage.toFixed(0)}%`,
    `${model.completedTasks} of ${model.totalTasks} marked Done`,
    'done',
  );
  const meter = node('progress');
  meter.className = 'insights-meter';
  meter.max = 100;
  meter.value = model.completionPercentage;
  meter.setAttribute('aria-label', `Done: ${model.completionPercentage.toFixed(0)}%`);
  done.append(meter);
  tiles.append(done);
  for (const [key, label, detail] of [
    ['in progress', 'In progress', 'Being worked on'],
    ['review', 'In review', 'Waiting for review'],
    ['blocked', 'Blocked', 'Need a decision or fix'],
  ])
    if (hasStatus(key)) {
      const value = statusTotal(key);
      const card = tile(label, value, detail, key);
      if (key === 'blocked' && value) card.classList.add('is-alert');
      tiles.append(card);
    }

  const charts = node('div', 'insights-charts');
  charts.append(
    renderStatusChart(model.status, model.totalTasks),
    renderBars(
      'Priority',
      sortPriority(model.priority).map(row => ({ ...row, label: capitalise(row.label) })),
      model.totalTasks,
      'No priorities set.',
      'insights-priority',
    ),
  );
  if (model.corpusMatches && model.milestoneLookupAvailable)
    charts.append(
      renderBars(
        'Milestones',
        foldRows(model.milestones),
        model.totalTasks,
        'No tasks are in a milestone.',
        'insights-milestones',
      ),
    );
  else {
    const unavailable = panel('Milestones', 'insights-bars insights-milestones');
    unavailable.body.append(
      node(
        'p',
        'insights-note',
        model.corpusMatches
          ? 'Milestone names are unavailable. Refresh to try again.'
          : `The task list (${model.corpusCount}) and totals (${model.totalTasks}) disagree. Refresh to try again.`,
      ),
    );
    charts.append(unavailable.section);
  }

  const history = renderHistory(model, { onOpenTask, dateFormat, historyState });
  if (!dateFormatAvailable)
    history.append(
      node('p', 'insights-note insights-history-note', "Couldn't read the date setting. Showing YYYY-MM-DD."),
    );
  container.append(header, tiles, charts, history);
}

/* Settings ------------------------------------------------------------------------------------ */

function fieldId(projectId, name) {
  return `insights-${String(projectId)
    .slice(0, 12)
    .replace(/[^a-z0-9-]/gi, '-')}-${name}`;
}

function setFieldError(form, name, message) {
  const target = form.querySelector(`[data-error-for="${name}"]`);
  const input = form.elements.namedItem(name);
  if (target) {
    target.textContent = message || '';
    target.hidden = !message;
  }
  if (input instanceof HTMLElement) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  form.querySelector(`[data-row-for="${name}"]`)?.classList.toggle('is-invalid', Boolean(message));
}

/** Writes a message into the sticky save bar; the bar shows while there is something to say. */
function setSaveState(container, message, tone = '') {
  const bar = container.querySelector('.settings-savebar');
  const status = container.querySelector('.settings-save-status');
  if (!bar || !status) return;
  status.textContent = message;
  bar.dataset.tone = tone;
  bar.hidden = !message;
}

const settingsSections = [
  ['project', 'Project'],
  ['workflow', 'Workflow'],
  ['done', 'Definition of done'],
  ['board', 'Board'],
  ['browser', 'Backlog browser'],
  ['cli', 'Backlog CLI'],
];

function renderSettings(container, context) {
  const { projectId, canWrite, writeBlockedReason, refreshControl, save, discard, latestConfig, draft } = context;
  const writable = isWritable(canWrite);
  container.replaceChildren();
  const header = node('header', 'page-header');
  const copy = node('div');
  copy.append(node('h1', '', 'Settings'), node('p', '', 'Project configuration stored in Backlog.'));
  const actions = node('div', 'page-actions');
  actions.append(refreshControl.create());
  header.append(copy, actions);
  container.append(header);
  if (!writable) {
    const reason = (typeof writeBlockedReason === 'function' && writeBlockedReason()) || '';
    const banner = node('div', 'banner settings-readonly');
    banner.setAttribute('role', 'note');
    banner.append(
      node('strong', '', 'Read only. '),
      document.createTextNode(reason || 'Settings are locked while an agent is active or queued.'),
    );
    container.append(banner);
  }

  const layout = node('div', 'settings-layout');
  const index = node('nav', 'settings-index');
  index.setAttribute('aria-label', 'Settings sections');
  const indexList = node('ul');
  index.append(indexList);
  const form = node('form', 'insights-settings settings-sections');
  form.noValidate = true;
  layout.append(index, form);

  const values = draft.values;
  const idFor = name => fieldId(projectId, name);
  let saveButton, discardButton;
  const mark = (field, value) => {
    draft.values[field] = value;
    draft.dirtyFields.add(field);
    storeDraft(projectId, draft);
    setFieldError(form, field, '');
    setSaveState(container, 'Unsaved changes', 'dirty');
    saveButton.disabled = !writable;
    discardButton.disabled = false;
  };

  const section = (key, title, description) => {
    const card = node('section', 'panel settings-section');
    card.id = idFor(`section-${key}`);
    card.setAttribute('aria-labelledby', `${card.id}-title`);
    const head = node('header', 'panel-header settings-section-header');
    const headCopy = node('div');
    const heading = node('h2', '', title);
    heading.id = `${card.id}-title`;
    headCopy.append(heading, node('p', '', description));
    head.append(headCopy);
    const body = node('div', 'settings-rows');
    card.append(head, body);
    form.append(card);
    const item = node('li');
    const link = node('a', '', title);
    link.href = `#${card.id}`;
    link.dataset.section = card.id;
    item.append(link);
    indexList.append(item);
    return body;
  };

  const row = (grid, name, labelText, help, control, { labelFor = true } = {}) => {
    const wrap = node('div', 'settings-row');
    wrap.dataset.rowFor = name;
    const copyCell = node('div', 'settings-row-copy');
    const label = node(labelFor ? 'label' : 'span', 'settings-row-label', labelText);
    const id = idFor(name);
    if (labelFor) label.htmlFor = id;
    else label.id = `${id}-label`;
    const helpText = node('p', 'settings-row-help', help);
    helpText.id = `${id}-help`;
    copyCell.append(label, helpText);
    const controlCell = node('div', 'settings-row-control');
    const error = node('p', 'settings-field-error');
    error.id = `${id}-error`;
    error.dataset.errorFor = name;
    error.hidden = true;
    controlCell.append(control, error);
    wrap.append(copyCell, controlCell);
    grid.append(wrap);
    return { id, helpId: helpText.id, errorId: error.id };
  };

  const inputField = (grid, name, labelText, help, options = {}) => {
    const input = node(options.select ? 'select' : 'input', 'settings-input');
    const ids = row(grid, name, labelText, help, input);
    input.id = ids.id;
    input.name = name;
    input.disabled = !writable || Boolean(options.disabled);
    input.setAttribute('aria-describedby', `${ids.helpId} ${ids.errorId}`);
    if (options.type) input.type = options.type;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.step !== undefined) input.step = String(options.step);
    if (options.required) input.required = true;
    if (options.narrow) input.classList.add('is-narrow');
    if (options.select)
      for (const [value, optionText] of options.select) {
        const option = node('option', '', optionText);
        option.value = value;
        input.append(option);
      }
    input.value = values[name] ?? options.fallback ?? '';
    input.addEventListener('input', () => mark(name, input.value));
    return input;
  };

  const toggle = (grid, name, labelText, help) => {
    const input = node('input', 'settings-switch');
    input.type = 'checkbox';
    const ids = row(grid, name, labelText, help, input);
    input.id = ids.id;
    input.name = name;
    input.checked = Boolean(values[name]);
    input.disabled = !writable;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-describedby', ids.helpId);
    input.addEventListener('change', () => mark(name, input.checked));
    return input;
  };

  const project = section('project', 'Project', 'Name, dates and defaults for new tasks.');
  inputField(project, 'projectName', 'Project name', 'Shown in the sidebar and on the board.', { required: true });
  inputField(project, 'dateFormat', 'Date format', 'Used for dates in Insights and the workspace.', {
    select: [
      ['yyyy-mm-dd', 'YYYY-MM-DD'],
      ['dd/mm/yyyy', 'DD/MM/YYYY'],
      ['mm/dd/yyyy', 'MM/DD/YYYY'],
    ],
    fallback: 'yyyy-mm-dd',
  });
  const statuses = Array.isArray(latestConfig.statuses) ? latestConfig.statuses : [];
  inputField(project, 'defaultStatus', 'Default status', 'Status given to new tasks.', {
    select: statuses.map(value => [value, value]),
    fallback: statuses[0] || '',
  });

  const workflow = section('workflow', 'Workflow', 'How task changes reach Git.');
  toggle(workflow, 'autoCommit', 'Commit task changes', 'Create a Git commit after each task change.');
  toggle(workflow, 'remoteOperations', 'Read active branches', 'Include tasks from other active Git branches.');
  inputField(workflow, 'defaultEditor', 'Editor command', 'Overrides EDITOR when editing a task.', {
    placeholder: 'code --wait',
  });
  const prefix = inputField(workflow, 'taskPrefix', 'Task prefix', 'Set at setup. Fixed so task IDs stay stable.', {
    disabled: true,
    narrow: true,
  });
  prefix.value = text(latestConfig.prefixes?.task || 'task').toLocaleUpperCase();

  const doneSection = section('done', 'Definition of done', 'Checklist added to every new task.');
  const doneWrap = node('div', 'settings-list-field');
  const list = node('ol', 'insights-list settings-list');
  list.setAttribute('aria-label', 'Definition of done items');
  const emptyList = node('p', 'settings-list-empty', 'No items. New tasks start without a checklist.');
  const add = action('Add item', 'button quiet button-small settings-list-add');
  add.disabled = !writable;
  doneWrap.append(list, emptyList, add);
  doneSection.append(doneWrap);
  const renderDone = () => {
    list.replaceChildren();
    const items = Array.isArray(values.definitionOfDone) ? values.definitionOfDone : [];
    emptyList.hidden = items.length > 0;
    items.forEach((item, itemIndex) => {
      const entry = node('li', 'insights-list-row settings-list-row');
      const label = node('label', 'sr-only', `Definition of done item ${itemIndex + 1}`);
      const input = node('input', 'settings-input');
      input.value = item;
      input.disabled = !writable;
      input.maxLength = 500;
      label.htmlFor = input.id = idFor(`done-${itemIndex}`);
      input.addEventListener('input', () => {
        const nextItems = [...values.definitionOfDone];
        nextItems[itemIndex] = input.value;
        mark('definitionOfDone', nextItems);
      });
      const remove = action('×', 'icon-button settings-list-remove');
      remove.setAttribute('aria-label', `Remove item ${itemIndex + 1}`);
      remove.title = 'Remove';
      remove.disabled = !writable;
      remove.addEventListener('click', () => {
        mark(
          'definitionOfDone',
          values.definitionOfDone.filter((_, position) => position !== itemIndex),
        );
        renderDone();
        const inputs = list.querySelectorAll('input');
        (inputs[Math.min(itemIndex, inputs.length - 1)] || add).focus();
      });
      entry.append(node('span', 'settings-list-index', `${itemIndex + 1}`), label, input, remove);
      list.append(entry);
    });
  };
  renderDone();
  add.addEventListener('click', () => {
    mark('definitionOfDone', [...(values.definitionOfDone || []), '']);
    renderDone();
    list.lastElementChild?.querySelector('input')?.focus();
  });

  const board = section('board', 'Board', 'How the Tasks board looks.');
  toggle(board, 'hideEmptyColumns', 'Hide empty columns', 'Empty columns still appear while you drag a card.');

  const browser = section('browser', 'Backlog browser', 'The separate Backlog web board, not this workspace.');
  inputField(browser, 'defaultPort', 'Port', 'Used when no port is given on the command line.', {
    type: 'number',
    number: true,
    min: 1,
    max: 65535,
    fallback: 6420,
    narrow: true,
  });
  toggle(browser, 'autoOpenBrowser', 'Open on start', 'Open the board in a browser when its server starts.');

  const cli = section('cli', 'Backlog CLI', 'Terminal output and tasks on several branches.');
  inputField(cli, 'maxColumnWidth', 'Column width', 'Maximum width of text columns in the terminal.', {
    type: 'number',
    number: true,
    min: 20,
    max: 200,
    fallback: 80,
    narrow: true,
  });
  inputField(
    cli,
    'taskResolutionStrategy',
    'Branch conflicts',
    'Which copy wins when a task exists on several branches.',
    {
      select: [
        ['most_recent', 'Most recently updated'],
        ['most_progressed', 'Furthest along'],
      ],
      fallback: 'most_recent',
    },
  );
  inputField(cli, 'zeroPaddedIds', 'ID padding', '0 turns it off. 3 gives task-001.', {
    type: 'number',
    number: true,
    min: 0,
    max: 10,
    fallback: 0,
    narrow: true,
  });

  const bar = node('div', 'settings-savebar');
  const status = node('p', 'insights-form-status settings-save-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  discardButton = action('Discard');
  discardButton.dataset.discard = '';
  discardButton.disabled = !draft.dirtyFields.size;
  discardButton.addEventListener('click', discard);
  saveButton = action('Save changes', 'button primary');
  saveButton.dataset.save = '';
  saveButton.type = 'submit';
  saveButton.disabled = !writable || !draft.dirtyFields.size;
  const barActions = node('div', 'settings-savebar-actions');
  barActions.append(discardButton, saveButton);
  bar.append(status, barActions);
  form.append(bar);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const errors = validateSettingsDraft(values, statuses);
    for (const field of editableFields) setFieldError(form, field, errors[field]);
    if (Object.keys(errors).length) {
      setSaveState(container, 'Fix the highlighted settings.', 'error');
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    await save({ saveButton, discardButton });
  });
  container.append(layout);
  setSaveState(container, draft.dirtyFields.size ? 'Unsaved changes' : '', draft.dirtyFields.size ? 'dirty' : '');

  // Section index: jump without changing the URL, and track the section in view.
  const links = [...indexList.querySelectorAll('a')];
  const current = id => {
    for (const link of links)
      if (link.dataset.section === id) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
  };
  current(links[0]?.dataset.section);
  index.addEventListener('click', event => {
    const link = event.target.closest('a[data-section]');
    if (!link) return;
    event.preventDefault();
    const target = container.querySelector(`#${CSS.escape(link.dataset.section)}`);
    target?.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    target?.querySelector('h2')?.setAttribute('tabindex', '-1');
    target?.querySelector('h2')?.focus({ preventScroll: true });
    current(link.dataset.section);
  });
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(entry => entry.isIntersecting);
        if (visible.length) current(visible[0].target.id);
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    for (const card of form.querySelectorAll('.settings-section')) observer.observe(card);
    container.settingsObserver?.disconnect();
    container.settingsObserver = observer;
  }
}

export function mountInsights(
  container,
  { api, projectId, canWrite = false, writeBlockedReason, onChange = async () => {}, onOpenTask, kind } = {},
) {
  if (!(container instanceof HTMLElement)) throw new TypeError('mountInsights requires an HTML container.');
  if (typeof api !== 'function') throw new TypeError('mountInsights requires an api function.');
  if (!projectId) throw new TypeError('mountInsights requires an explicit projectId.');
  if (!['statistics', 'settings'].includes(kind)) throw new TypeError("kind must be 'statistics' or 'settings'.");
  let destroyed = false,
    saving = false;
  let generation = 0;
  let latestConfig = null;
  let renderedWritable = null;
  let savedTimer = 0;
  const projectKey = String(projectId);
  if (!settingsDrafts.has(projectKey)) {
    try {
      const stored = JSON.parse(sessionStorage.getItem('switchflow:settings:' + projectKey) || 'null');
      if (stored?.values && Array.isArray(stored.dirtyFields))
        settingsDrafts.set(projectKey, { values: stored.values, dirtyFields: new Set(stored.dirtyFields) });
    } catch {}
  }
  let statisticsSignature = '';
  // Each render rebuilds the page header; the same control is moved into the new one.
  const refreshControl = createRefreshControl(() => refresh());
  const historyState = { page: 0 };

  container.classList.add('insights-view');
  container.dataset.insightsKind = kind;

  const loading = message => {
    if (destroyed) return;
    container.replaceChildren();
    container.setAttribute('aria-busy', 'true');
    const state = node('div', 'insights-state');
    state.setAttribute('role', 'status');
    state.append(node('strong', '', message));
    container.append(state);
  };
  const failure = (error, retry, preserve = false) => {
    if (destroyed) return;
    container.removeAttribute('aria-busy');
    container.querySelector('[data-refresh-error]')?.remove();
    if (!preserve) container.replaceChildren();
    const state = node('div', 'insights-state insights-state-error');
    state.setAttribute('role', 'alert');
    state.dataset.refreshError = '';
    const copy = node('div');
    copy.append(
      node('strong', '', errorMessage(error, `Unable to load ${kind === 'settings' ? 'settings' : 'insights'}.`)),
      node('p', '', 'Nothing in the project was changed.'),
    );
    const button = action('Try again');
    button.addEventListener('click', retry);
    state.append(copy, button);
    const pageHeader = preserve ? container.querySelector('.page-header') : null;
    if (pageHeader) pageHeader.after(state);
    else if (preserve) container.prepend(state);
    else container.append(state);
  };

  async function refreshStatistics() {
    const ticket = ++generation,
      hadContent = Boolean(container.querySelector('.insights-tiles'));
    if (!hadContent) loading('Loading insights…');
    else container.setAttribute('aria-busy', 'true');
    const [statistics, tasks, milestones, config] = await Promise.allSettled([
      api('/statistics'),
      api('/tasks'),
      api('/milestones'),
      api('/config'),
    ]);
    if (destroyed || ticket !== generation) return;
    if (statistics.status === 'rejected') {
      failure(statistics.reason, refreshStatistics, hadContent);
      refreshControl.failed(statistics.reason);
      return;
    }
    container.querySelector('[data-refresh-error]')?.remove();
    const taskResult = tasks.status === 'fulfilled' ? tasks.value : [];
    const milestoneResult = milestones.status === 'fulfilled' ? milestones.value : undefined;
    const model = buildStatisticsModel(statistics.value, taskResult, milestoneResult);
    if (tasks.status === 'rejected') {
      model.corpusMatches = false;
      model.corpusCount = 0;
    }
    const dateFormat = normalizeDateFormat(config.status === 'fulfilled' ? config.value?.dateFormat : undefined);
    const signature = JSON.stringify([model, dateFormat, config.status]);
    if (signature !== statisticsSignature || !container.querySelector('.insights-tiles')) {
      statisticsSignature = signature;
      renderStatistics(container, model, {
        refreshControl,
        onOpenTask,
        dateFormat,
        historyState,
        dateFormatAvailable: config.status === 'fulfilled',
      });
    }
    container.removeAttribute('aria-busy');
    refreshControl.loaded();
  }

  async function saveSettings({ saveButton, discardButton }) {
    if (saving) return;
    if (!isWritable(canWrite)) {
      setSaveState(container, 'Settings are read-only right now. Your changes are kept.', 'error');
      return;
    }
    const draft = settingsDrafts.get(projectKey);
    if (!draft?.dirtyFields.size) return;
    saving = true;
    const controls = [...container.querySelectorAll('input,select,button')].map(field => [field, field.disabled]);
    for (const [field] of controls) field.disabled = true;
    setSaveState(container, 'Saving…', 'dirty');
    try {
      const current = await api('/config');
      const payload = mergeSettingsConfig(current, draft.values, draft.dirtyFields);
      const saved = await api('/config', { method: 'PUT', body: payload });
      latestConfig = saved && typeof saved === 'object' ? saved : payload;
      clearDraft(projectKey);
      if (!destroyed) renderSettings(container, settingsContext());
      let message = 'Settings saved.',
        tone = 'saved';
      try {
        await onChange({ kind: 'settings', projectId, config: latestConfig });
      } catch (error) {
        message = `Settings saved. ${errorMessage(error, 'The workspace could not refresh.')}`;
        tone = 'error';
      }
      if (!destroyed) {
        setSaveState(container, message, tone);
        clearTimeout(savedTimer);
        if (tone === 'saved')
          savedTimer = setTimeout(() => {
            const bar = container.querySelector('.settings-savebar');
            if (bar?.dataset.tone === 'saved') setSaveState(container, '', '');
          }, 4000);
      }
    } catch (error) {
      if (destroyed) return;
      setSaveState(container, `${errorMessage(error, 'Unable to save settings.')} Your changes are kept.`, 'error');
      saveButton.disabled = false;
      discardButton.disabled = false;
    } finally {
      saving = false;
      for (const [field, disabled] of controls) if (field.isConnected) field.disabled = disabled;
    }
  }

  function discardSettings() {
    clearDraft(projectKey);
    renderSettings(container, settingsContext());
    container
      .querySelector('.settings-sections input:not(:disabled),.settings-sections select:not(:disabled)')
      ?.focus();
  }

  function settingsContext() {
    let draft = settingsDrafts.get(projectKey);
    if (!draft) draft = { values: editableValues(latestConfig), dirtyFields: new Set() };
    renderedWritable = isWritable(canWrite);
    return {
      projectId,
      canWrite,
      writeBlockedReason,
      refreshControl,
      save: saveSettings,
      discard: discardSettings,
      latestConfig,
      draft,
    };
  }

  async function refreshSettings() {
    if (saving) return;
    const ticket = ++generation;
    const draft = settingsDrafts.get(projectKey);
    if (!container.querySelector('.insights-settings')) loading('Loading settings…');
    else container.setAttribute('aria-busy', 'true');
    try {
      const config = await api('/config');
      if (destroyed || ticket !== generation) return;
      const changed = JSON.stringify(latestConfig) !== JSON.stringify(config);
      latestConfig = config;
      const rendered = Boolean(container.querySelector('.insights-settings'));
      // Re-render when write access changes so the read-only fence and its reason stay current.
      const fenceChanged = rendered && renderedWritable !== isWritable(canWrite);
      if (draft?.dirtyFields.size) {
        if (!rendered || fenceChanged) renderSettings(container, settingsContext());
        if (changed) setSaveState(container, 'Saved settings reloaded. Your unsaved changes are kept.', 'dirty');
      } else if (changed || !rendered || fenceChanged) renderSettings(container, settingsContext());
      container.querySelector('[data-refresh-error]')?.remove();
      refreshControl.loaded();
    } catch (error) {
      if (destroyed || ticket !== generation) return;
      if (draft?.dirtyFields.size && container.querySelector('.insights-settings'))
        setSaveState(container, `${errorMessage(error, 'Unable to reload settings.')} Your changes are kept.`, 'error');
      // A failed reload keeps the settings already on screen, as Insights does.
      else failure(error, refreshSettings, Boolean(container.querySelector('.insights-settings')));
      refreshControl.failed(error);
    } finally {
      if (!destroyed && ticket === generation) container.removeAttribute('aria-busy');
    }
  }

  const refresh = kind === 'statistics' ? refreshStatistics : refreshSettings;
  void refresh();
  return {
    refresh,
    destroy() {
      destroyed = true;
      generation++;
      clearTimeout(savedTimer);
      refreshControl.destroy();
      container.settingsObserver?.disconnect();
      delete container.settingsObserver;
      container.classList.remove('insights-view');
      delete container.dataset.insightsKind;
      container.replaceChildren();
    },
  };
}
