import { renderMarkdown, bindProseInteractions } from './documents.js';
import { taskRank } from './overview-model.js';
// Host callbacks supply project-scoped APIs and CSRF; drafts never cross project keys.
export const sortMilestones = values =>
  [...values].sort(
    (a, b) =>
      (a.executionOrder ?? Infinity) - (b.executionOrder ?? Infinity) ||
      String(a.title).localeCompare(String(b.title), undefined, { numeric: true }) ||
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
  );
export function milestoneMatches(value, milestone) {
  const normalize = value =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^(?:m-)?0*(\d+)$/, 'm-$1');
  return !!value && [milestone.id, milestone.title].some(alias => normalize(alias) === normalize(value));
}
export function milestoneState(milestone, tasks) {
  const linked = tasks.filter(task => milestoneMatches(task.milestone, milestone));
  const done = linked.filter(task => String(task.status).toLowerCase() === 'done').length;
  const blocked = linked.filter(task => String(task.status).toLowerCase() === 'blocked').length;
  const active = linked.some(task =>
    ['in progress', 'doing', 'review', 'blocked'].includes(String(task.status).toLowerCase()),
  );
  return {
    linked,
    done,
    blocked,
    group:
      linked.length && done === linked.length
        ? 'Delivery tasks complete'
        : active
          ? 'Active work'
          : milestone.executionOrder == null
            ? 'Order not established'
            : 'Ordered upcoming work',
  };
}
export function milestoneSummary(description = '') {
  const paragraph =
    description.split(/\r?\n\s*\r?\n/).find(part => part.trim() && !/^#{1,6}\s+[^\n]+$/.test(part.trim())) || '';
  const summary = paragraph
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return summary.length > 220 ? `${summary.slice(0, 217)}…` : summary;
}
export function parseMilestoneOrder(value) {
  if (value === '' || value == null) return null;
  const order = Number(value);
  if (!Number.isSafeInteger(order) || order < 0)
    throw new Error('Execution order must be a non-negative whole number.');
  return order;
}

// Task status buckets, in the order the progress bar draws them.
const STATUSES = [
  { key: 'done', label: 'Done', status: 'done' },
  { key: 'review', label: 'Review', status: 'review' },
  { key: 'progress', label: 'In progress', status: 'in progress' },
  { key: 'ready', label: 'Ready', status: 'ready' },
  { key: 'blocked', label: 'Blocked', status: 'blocked' },
  { key: 'backlog', label: 'Backlog', status: 'backlog' },
];
// Linked tasks list active work first and finished work last.
const TASK_ORDER = ['progress', 'review', 'ready', 'blocked', 'backlog', 'done'];
export function taskBucket(status) {
  const value = String(status ?? '')
    .trim()
    .toLowerCase();
  if (['done', 'complete', 'completed'].includes(value)) return 'done';
  if (value === 'review' || value === 'in review') return 'review';
  if (['in progress', 'in-progress', 'doing'].includes(value)) return 'progress';
  if (value === 'ready') return 'ready';
  if (value === 'blocked') return 'blocked';
  return 'backlog';
}
export function statusCounts(linked) {
  const counts = Object.fromEntries(STATUSES.map(s => [s.key, 0]));
  for (const task of linked) counts[taskBucket(task.status)]++;
  return counts;
}
// The first unfinished Ready task, or why nothing is ready.
// Ranks like the Overview (taskRank): within one milestone, priority, then ordinal, then numeric ID.
export function nextUp(linked, allTasks = [], milestones = []) {
  const ordered = [...linked].sort(taskRank(milestones));
  const ready = ordered.find(task => taskBucket(task.status) === 'ready');
  if (ready) return { task: ready };
  if (!linked.length) return { reason: 'Link tasks to this milestone to see what comes next.' };
  const open = ordered.filter(task => taskBucket(task.status) !== 'done');
  if (!open.length) return { reason: 'All linked tasks are done.' };
  const counts = statusCounts(open);
  const parts = [];
  if (counts.progress) parts.push(`${counts.progress} in progress`);
  if (counts.review) parts.push(`${counts.review} in review`);
  const blockers = new Map();
  const reasons = new Set();
  for (const task of open.filter(t => taskBucket(t.status) === 'blocked')) {
    const pending = (task.dependencies || []).filter(id => {
      const dependency = allTasks.find(t => t.id === id);
      return !dependency || taskBucket(dependency.status) !== 'done';
    });
    for (const id of pending) blockers.set(id, allTasks.find(t => t.id === id) || { id });
    if (!pending.length && task.blockReason && task.blockReason !== 'dependent') reasons.add(task.blockReason);
  }
  if (counts.blocked) parts.push(`${counts.blocked} blocked`);
  if (counts.backlog) parts.push(`${counts.backlog} in backlog`);
  return {
    reason: `Nothing is ready. ${parts.join(', ')}.`,
    blockers: [...blockers.values()].slice(0, 3),
    moreBlockers: Math.max(0, blockers.size - 3),
    notes: [...reasons].slice(0, 2),
  };
}

// Visible labels for the grouping keys milestoneState returns.
const GROUPS = [
  { key: 'Active work', label: 'In progress', status: 'in progress', filter: 'active' },
  { key: 'Ordered upcoming work', label: 'Up next', status: 'ready', filter: 'upcoming' },
  { key: 'Order not established', label: 'Not yet ordered', status: 'backlog', filter: 'upcoming' },
  { key: 'Delivery tasks complete', label: 'Done', status: 'done', filter: 'done' },
];
const FILTERS = [
  ['active', 'In progress'],
  ['upcoming', 'Upcoming'],
  ['done', 'Done'],
  ['all', 'All'],
];
const PAGE = 25,
  DONE_PAGE = 10,
  TASK_PAGE = 20;

// Moves milestones within the execution order and returns only the records whose order changes.
// Numbering stays contiguous from the lowest existing order (or 1), so a move writes as few records as possible.
export function planMilestoneOrder(values, movedIds, targetId = null, position = 'after') {
  const moving = [movedIds].flat();
  const ordered = sortMilestones(values.filter(m => m.executionOrder != null));
  const start = ordered.length ? Math.min(...ordered.map(m => Number(m.executionOrder))) : 1;
  const ids = ordered.map(m => m.id).filter(id => !moving.includes(id));
  let index = targetId == null ? ids.length : ids.indexOf(targetId);
  if (index < 0) index = ids.length;
  else if (targetId != null && position === 'after') index++;
  ids.splice(index, 0, ...moving);
  return ids
    .map((id, i) => ({ id, executionOrder: start + i }))
    .filter(change => values.find(m => m.id === change.id)?.executionOrder !== change.executionOrder);
}
export function createMilestonePanel({
  container,
  read,
  write,
  api,
  canWrite = () => true,
  writeBlockedReason = () => '',
  onTask,
  onOpenRecord = async () => {},
  onNavigate = () => {},
  projectKey,
  onSaved = async () => {},
  drafts = new Map(),
}) {
  let origin = null,
    cleanupProse = () => {},
    updateReader = null,
    generation = 0,
    request = 0,
    editorRequest = 0,
    selected = null,
    destroyed = false,
    milestones = [],
    tasks = [],
    archived = [],
    showArchived = false,
    filter = 'all',
    doneOpen = false,
    pages = {},
    listSignature = '',
    rows = [],
    drag = null,
    refreshFailed = false,
    busy = false;
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const button = (text, action, className = 'button quiet') => {
    const el = node('button', text, className);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  };
  const wide = () => !!globalThis.window?.matchMedia?.('(min-width: 1100px)').matches;
  const key = id => `${projectKey()}:${id}`;
  const current = (ticket, project) => !destroyed && ticket === generation && project === projectKey();
  const route = id => `/milestones/${encodeURIComponent(id)}`;
  const load = id => (api ? api(route(id)) : read(`/api${route(id)}`));
  const unwrap = value => value.milestone || value;
  const errorText = error => error?.message || 'The milestone operation failed.';
  const blockedText = () => writeBlockedReason() || 'Stop the active agent before changing milestones or assignments.';
  const assertWritable = () => {
    if (!canWrite()) throw new Error(blockedText());
  };
  const assigned = milestone => tasks.filter(task => milestoneMatches(task.milestone, milestone));
  const groupOf = milestone => GROUPS.find(g => g.key === milestoneState(milestone, tasks).group) || GROUPS[2];
  const fence = el => {
    el.disabled = busy || !canWrite();
    el.title = canWrite() ? '' : blockedText();
    return el;
  };
  const progressBar = (counts, total, className) => {
    const bar = node('div', undefined, `progress ${className}`);
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      total
        ? `${counts.done} of ${total} done${counts.blocked ? `, ${counts.blocked} blocked` : ''}`
        : 'No linked tasks',
    );
    if (total)
      for (const status of STATUSES) {
        if (!counts[status.key]) continue;
        const segment = node('span');
        // CSP blocks style attributes; CSSOM and data attributes are allowed.
        segment.dataset.status = status.key;
        if (segment.style) segment.style.width = `${(100 * counts[status.key]) / total}%`;
        bar.append(segment);
      }
    return bar;
  };

  // Header and toolbar --------------------------------------------------------
  const header = node('header', undefined, 'page-header');
  const titles = node('div');
  titles.append(node('h1', 'Milestones'), node('p', 'Outcomes in delivery order, with progress from their tasks.'));
  const actions = node('div', undefined, 'page-actions');
  header.append(titles, actions);
  const create = button(
    'New milestone',
    () => {
      if (busy) return;
      editorRequest++;
      origin = { id: selected, y: globalThis.window?.scrollY };
      renderEditor(
        { id: '@new' },
        drafts.get(key('@new')) || { title: '', description: '', labels: [], executionOrder: '' },
      );
    },
    'button primary',
  );
  if (api) actions.append(create);
  const toolbar = node('div', undefined, 'toolbar ms-toolbar');
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'Search milestones';
  search.setAttribute('aria-label', 'Search milestones');
  search.addEventListener('input', () => {
    pages = {};
    renderList();
  });
  const segmented = node('div', undefined, 'segmented');
  segmented.setAttribute('role', 'group');
  segmented.setAttribute('aria-label', 'Filter milestones');
  const filterCounts = new Map();
  const filterButtons = FILTERS.map(([value, label]) => {
    const el = button(
      label,
      () => {
        filter = value;
        pages = {};
        renderList();
      },
      '',
    );
    el.dataset.filter = value;
    filterCounts.set(value, node('span', '', 'ms-filter-count'));
    el.append(filterCounts.get(value));
    segmented.append(el);
    return el;
  });
  const toggle = button('Show archived', async () => {
    if (busy) return;
    editorRequest++;
    showArchived = !showArchived;
    toggle.setAttribute('aria-pressed', String(showArchived));
    selected = null;
    pages = {};
    clearDetail();
    setPane('list');
    await refresh();
  });
  toggle.setAttribute('aria-pressed', 'false');
  toolbar.append(search, segmented);
  if (api) toolbar.append(toggle);
  const message = node('p', undefined, 'ms-message');
  message.setAttribute('role', 'status');

  // Two panes: the ordered list and the selected milestone -------------------------
  const layout = node('div', undefined, 'ms-layout');
  layout.dataset.pane = 'list';
  const listPane = node('div', undefined, 'ms-list-pane');
  const list = node('div', undefined, 'ms-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Milestones');
  listPane.append(list);
  const detail = node('div', undefined, 'ms-detail');
  detail.setAttribute('aria-label', 'Selected milestone');
  layout.append(listPane, detail);
  container.classList.add('milestone-panel');
  container.append(header, toolbar, message, layout);

  function setPane(pane) {
    layout.dataset.pane = pane;
    container.dataset.pane = pane;
  }
  function clearDetail() {
    cleanupProse();
    cleanupProse = () => {};
    updateReader = null;
    detail.replaceChildren();
    detail.dataset.mode = '';
  }
  function placeholder() {
    clearDetail();
    if (!(showArchived ? archived : milestones).length) return;
    const empty = node('div', undefined, 'empty ms-placeholder');
    empty.append(node('strong', 'Select a milestone'), node('span', 'Its scope, progress and tasks appear here.'));
    detail.append(empty);
  }

  // List -----------------------------------------------------------------------
  function listRow(milestone, state) {
    const counts = statusCounts(state.linked),
      total = state.linked.length;
    const row = node('div', undefined, 'ms-row');
    row.dataset.milestone = milestone.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected === milestone.id));
    row.tabIndex = -1;
    const order = node('span', milestone.executionOrder == null ? '–' : String(milestone.executionOrder), 'ms-order');
    if (milestone.executionOrder == null) order.dataset.unset = 'true';
    const name = node('span', undefined, 'ms-row-main');
    name.append(node('span', milestone.title, 'ms-row-title'));
    name.title = `${milestone.id} · ${milestone.title}`;
    const bar = progressBar(counts, total, 'ms-row-bar');
    const count = node('span', total ? `${state.done}/${total}` : '0', 'ms-row-count');
    if (!total) count.dataset.empty = 'true';
    const blocked = node('span', undefined, 'ms-row-blocked');
    if (state.blocked) {
      const dot = node('span', undefined, 'status-dot');
      dot.dataset.status = 'blocked';
      blocked.append(dot, node('span', String(state.blocked)));
      blocked.title = `${state.blocked} blocked`;
    }
    row.append(order, name, bar, count, blocked);
    if (milestone.executionOrder != null) row.dataset.ordered = 'true';
    if (!showArchived) {
      // Pointer-only drag handle; keyboard users reorder with Alt+Up/Down on the row.
      const handle = node('span', undefined, 'ms-handle');
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      handle.addEventListener('pointerdown', () => {
        row.draggable = reorderable();
      });
      row.prepend?.(handle);
      row.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      row.addEventListener('dragstart', event => {
        if (!row.draggable) return event.preventDefault();
        drag = { id: milestone.id, target: null };
        row.dataset.dragging = 'true';
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', milestone.id);
      });
      row.addEventListener('dragend', () => {
        row.draggable = false;
        delete row.dataset.dragging;
        drag = null;
        clearDropMarkers();
      });
    }
    row.setAttribute(
      'aria-label',
      [
        milestone.executionOrder == null ? 'Not ordered' : `Order ${milestone.executionOrder}`,
        milestone.title,
        total ? `${state.done} of ${total} tasks done` : 'no tasks',
        state.blocked ? `${state.blocked} blocked` : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
    row.addEventListener('click', () => choose(milestone.id));
    return row;
  }
  function renderList() {
    create.disabled = busy || !canWrite();
    create.title = canWrite() ? '' : blockedText();
    for (const el of filterButtons) el.setAttribute('aria-pressed', String(el.dataset.filter === filter));
    segmented.hidden = showArchived;
    const query = String(search.value || '').toLowerCase();
    const source = sortMilestones(showArchived ? archived : milestones);
    const matching = source.filter(m =>
      `${m.id} ${m.title} ${m.description || ''} ${(m.labels || []).join(' ')}`.toLowerCase().includes(query),
    );
    const signature = JSON.stringify([
      busy,
      canWrite(),
      filter,
      query,
      showArchived,
      doneOpen,
      pages,
      matching.map(m => [m.id, m.title, m.executionOrder]),
      tasks.map(t => [t.id, t.status, t.milestone]),
    ]);
    if (signature === listSignature && list.childNodes.length) return;
    listSignature = signature;
    const focusedId = list.contains?.(globalThis.document?.activeElement)
      ? globalThis.document.activeElement.dataset?.milestone
      : null;
    const scrollTop = listPane.scrollTop;
    list.replaceChildren();
    rows = [];
    for (const el of filterButtons) {
      const groups = GROUPS.filter(g => el.dataset.filter === 'all' || g.filter === el.dataset.filter).map(g => g.key);
      const total = source.filter(m => groups.includes(milestoneState(m, tasks).group)).length;
      filterCounts.get(el.dataset.filter).textContent = String(total);
    }
    if (!source.length) {
      const empty = node('div', undefined, 'empty');
      if (showArchived)
        empty.append(node('strong', 'No archived milestones'), node('span', 'Archived milestones appear here.'));
      else {
        empty.append(
          node('strong', 'No milestones yet'),
          node('span', 'A milestone is an outcome you accept or reject. Its tasks show progress.'),
        );
        if (api) empty.append(fence(button('New milestone', () => create.click(), 'button primary')));
      }
      list.append(empty);
      layout.dataset.empty = 'true';
      return;
    }
    layout.dataset.empty = '';
    const sections = showArchived
      ? [{ key: 'archived', label: 'Archived', status: 'backlog', items: matching }]
      : GROUPS.filter(g => filter === 'all' || g.filter === filter).map(g => ({
          ...g,
          items: matching.filter(m => milestoneState(m, tasks).group === g.key),
        }));
    let shownAny = false;
    for (const section of sections) {
      if (!section.items.length) continue;
      shownAny = true;
      const group = node('div', undefined, 'ms-group');
      group.dataset.group = section.key;
      group.setAttribute('role', 'group');
      const head = node('div', undefined, 'ms-group-head');
      const collapsible = section.key === 'Delivery tasks complete' && !query && filter !== 'done';
      const open = !collapsible || doneOpen;
      const label = node('span', section.label, 'ms-group-label');
      const count = node('span', String(section.items.length), 'count');
      let orderAll = null;
      if (section.key === 'Order not established' && api) {
        orderAll = fence(
          button(
            'Order these',
            () =>
              reorder(
                planMilestoneOrder(
                  milestones,
                  section.items.map(m => m.id),
                  null,
                ),
                `${section.items.length} milestone${section.items.length === 1 ? '' : 's'} added to the end of the order.`,
              ),
            'button quiet button-small ms-order-all',
          ),
        );
        orderAll.title = canWrite() ? 'Add these to the end of the order, as listed' : blockedText();
      }
      if (collapsible) {
        const toggleDone = button(
          '',
          () => {
            doneOpen = !doneOpen;
            renderList();
          },
          'ms-group-toggle',
        );
        toggleDone.setAttribute('aria-expanded', String(open));
        toggleDone.append(node('span', open ? '▾' : '▸', 'ms-caret'), label, count);
        head.append(toggleDone);
      } else head.append(label, count);
      if (orderAll) head.append(orderAll);
      group.setAttribute('aria-label', `${section.label}, ${section.items.length}`);
      group.append(head);
      if (open) {
        const limit = pages[section.key] || (collapsible ? DONE_PAGE : PAGE);
        for (const milestone of section.items.slice(0, limit)) {
          const row = listRow(milestone, milestoneState(milestone, tasks));
          rows.push(row);
          group.append(row);
        }
        if (section.items.length > limit) {
          const remaining = section.items.length - limit;
          group.append(
            button(
              `Show ${Math.min(remaining, collapsible ? DONE_PAGE : PAGE)} more`,
              () => {
                pages[section.key] = limit + (collapsible ? DONE_PAGE : PAGE);
                renderList();
              },
              'ms-more',
            ),
          );
        }
      }
      list.append(group);
    }
    if (!shownAny) {
      const empty = node('div', undefined, 'empty');
      empty.append(
        node('strong', query ? 'No milestones match' : 'Nothing here'),
        node('span', query ? 'Try a different search.' : 'No milestones in this filter.'),
      );
      if (query)
        empty.append(
          button('Clear search', () => {
            search.value = '';
            renderList();
            search.focus();
          }),
        );
      else
        empty.append(
          button('Show all', () => {
            filter = 'all';
            renderList();
          }),
        );
      list.append(empty);
    }
    const active = rows.find(row => row.dataset.milestone === selected) || rows[0];
    if (active) active.tabIndex = 0;
    listPane.scrollTop = scrollTop;
    if (focusedId) rows.find(row => row.dataset.milestone === focusedId)?.focus({ preventScroll: true });
  }
  list.addEventListener('keydown', event => {
    const index = rows.indexOf(event.target);
    if (index < 0) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      moveByKeyboard(event.target.dataset.milestone, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    let next = null;
    if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(event.target.dataset.milestone, { focus: true });
      return;
    } else return;
    event.preventDefault();
    if (!next || next === event.target) return;
    for (const row of rows) row.tabIndex = row === next ? 0 : -1;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    // Wide screens follow the selection; narrow screens open on Enter.
    if (wide()) choose(next.dataset.milestone, { focus: false, navigate: false });
  });
  // Reordering --------------------------------------------------------------------
  function reorderable() {
    return !!api && !showArchived && !busy && canWrite() && detail.dataset.mode !== 'edit';
  }
  function clearDropMarkers() {
    for (const row of rows) delete row.dataset.drop;
  }
  list.addEventListener('dragover', event => {
    if (!drag) return;
    const target = event.target.closest?.('.ms-row');
    clearDropMarkers();
    drag.target = null;
    if (!target || target.dataset.milestone === drag.id || target.dataset.ordered !== 'true') return;
    event.preventDefault();
    const box = target.getBoundingClientRect();
    const position = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
    target.dataset.drop = position;
    drag.target = { id: target.dataset.milestone, position };
    event.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('dragleave', event => {
    if (drag && !list.contains(event.relatedTarget)) clearDropMarkers();
  });
  list.addEventListener('drop', event => {
    event.preventDefault();
    const moved = drag?.id,
      target = drag?.target;
    clearDropMarkers();
    if (!moved || !target) return;
    const name = milestones.find(m => m.id === moved)?.title || moved;
    reorder(planMilestoneOrder(milestones, moved, target.id, target.position), `${name} moved.`, moved);
  });
  function moveByKeyboard(id, direction) {
    const milestone = milestones.find(m => m.id === id);
    if (!milestone || showArchived) return;
    const ordered = sortMilestones(milestones.filter(m => m.executionOrder != null)).map(m => m.id);
    if (milestone.executionOrder == null)
      return reorder(planMilestoneOrder(milestones, id, null), `${milestone.title} added to the end of the order.`, id);
    const neighbour = ordered[ordered.indexOf(id) + direction];
    if (!neighbour) {
      message.textContent = `${milestone.title} is already ${direction < 0 ? 'first' : 'last'}.`;
      return;
    }
    reorder(
      planMilestoneOrder(milestones, id, neighbour, direction < 0 ? 'before' : 'after'),
      `${milestone.title} moved ${direction < 0 ? 'up' : 'down'}.`,
      id,
    );
  }
  // Writes each changed order with that milestone's own revision. A failed write is reported and
  // rolled back locally; the others are kept.
  async function reorder(changes, doneText, focusId = null) {
    if (!changes.length) return;
    if (busy) return;
    const ticket = generation,
      project = projectKey();
    try {
      assertWritable();
      if (!api && !write) throw new Error('A revision-aware server is required for editing.');
      if (detail.dataset.mode === 'edit') throw new Error('Close the editor before changing the order.');
    } catch (error) {
      message.textContent = errorText(error);
      return;
    }
    busy = true;
    const previous = new Map(milestones.map(m => [m.id, m.executionOrder]));
    for (const change of changes) {
      const milestone = milestones.find(m => m.id === change.id);
      if (milestone) milestone.executionOrder = change.executionOrder;
    }
    renderList();
    if (focusId) rows.find(row => row.dataset.milestone === focusId)?.focus?.({ preventScroll: true });
    const failed = [];
    let saved = 0;
    for (const [index, change] of changes.entries()) {
      if (!current(ticket, project)) return;
      const milestone = milestones.find(m => m.id === change.id);
      message.textContent = `Saving order… ${index + 1} of ${changes.length}`;
      try {
        if (!canWrite()) throw new Error(blockedText());
        if (!milestone) throw new Error('Milestone not found.');
        const revision = milestone.revision || unwrap(await load(change.id)).revision;
        if (!revision || (!api && !milestone.atomicRevision))
          throw new Error('A revision-aware server is required for editing.');
        const body = { expectedRevision: revision, executionOrder: change.executionOrder };
        if (api) await api(route(change.id), { method: 'PUT', body });
        else await write(`/api${route(change.id)}`, body);
        saved++;
      } catch (error) {
        if (milestone) milestone.executionOrder = previous.get(change.id);
        failed.push(`${milestone?.title || change.id} (${errorText(error)})`);
      }
    }
    if (!current(ticket, project)) return;
    busy = false;
    const summary = failed.length
      ? `Order saved for ${saved} of ${changes.length}. Not saved: ${failed.join('; ')}. Refresh and try again.`
      : doneText;
    message.textContent = summary;
    try {
      await onSaved();
      if (!current(ticket, project)) return;
      await refresh();
      if (current(ticket, project) && selected && detail.dataset.mode === 'read')
        await show(selected, { focus: false });
    } catch (error) {
      if (current(ticket, project)) message.textContent = `${summary} Refresh failed: ${errorText(error)}`;
    }
    if (current(ticket, project)) message.textContent = summary;
  }
  function markSelected() {
    for (const row of rows) {
      row.setAttribute('aria-selected', String(row.dataset.milestone === selected));
      row.tabIndex = row.dataset.milestone === selected ? 0 : -1;
    }
  }
  function choose(id, { focus = true, navigate = true } = {}) {
    if (busy || !id) return;
    origin = { id, y: globalThis.window?.scrollY };
    message.textContent = '';
    if (navigate) onNavigate({ view: 'milestones', record: id });
    return show(id, { focus });
  }

  // Saving and archiving -------------------------------------------------------------
  async function saved(messageText, ticket, project, reopen = null) {
    if (!current(ticket, project)) return;
    // Keep the reopened record selected so the refresh does not auto-select another one.
    selected = reopen;
    clearDetail();
    message.textContent = messageText;
    try {
      await onSaved();
      if (current(ticket, project)) await refresh();
      if (!current(ticket, project) || detail.childNodes.length) return;
      if (reopen && selected === reopen) await show(reopen, { focus: true });
      else if (!reopen && selected === null) {
        placeholder();
        setPane('list');
      }
    } catch (error) {
      if (current(ticket, project)) message.textContent = `${messageText} Refresh failed: ${errorText(error)}`;
    }
  }
  async function mutate(milestone, { archiveOnly, handling = 'keep', target = '', preserve = () => {}, report }) {
    const ticket = generation,
      project = projectKey();
    if (busy) return;
    try {
      assertWritable();
      if (!archiveOnly && handling === 'reassign' && !target)
        throw new Error('Choose an active replacement milestone.');
      const outcome =
        archiveOnly || handling === 'keep'
          ? 'Keep task milestone links unchanged.'
          : handling === 'clear'
            ? 'Clear the milestone link on all matching local tasks.'
            : `Move all matching local tasks to ${target}.`;
      if (
        !globalThis.window?.confirm?.(
          `${archiveOnly ? 'Archive' : 'Remove'} ${milestone.id}: ${milestone.title}?\n\nArchive this milestone record and hide it from active milestones. ${outcome}\nNo tasks are deleted. Unsaved edits will not be applied. This server has no restore action.`,
        )
      )
        return;
      preserve();
      busy = true;
      editorRequest++;
      await api(`${route(milestone.id)}${archiveOnly ? '/archive' : ''}`, {
        method: archiveOnly ? 'POST' : 'DELETE',
        ...(!archiveOnly
          ? { body: { taskHandling: handling, ...(handling === 'reassign' ? { reassignTo: target } : {}) } }
          : {}),
      });
      busy = false;
      await saved(`${milestone.id} archived. ${outcome}`, ticket, project);
    } catch (error) {
      if (current(ticket, project)) report(errorText(error));
    } finally {
      if (current(ticket, project)) {
        busy = false;
        renderList();
      }
    }
  }

  // Editor ---------------------------------------------------------------------------
  function renderEditor(milestone, draft, latest = null) {
    const isNew = milestone.id === '@new',
      editorProject = projectKey(),
      editorTicket = generation;
    selected = milestone.id;
    clearDetail();
    markSelected();
    setPane('detail');
    detail.dataset.mode = 'edit';
    detail.scrollTop = 0;
    const top = node('div', undefined, 'ms-detail-head');
    const titles = node('div', undefined, 'ms-titles');
    if (!isNew) titles.append(node('span', milestone.id, 'ms-id'));
    const title = node('h2', isNew ? 'New milestone' : `Edit · ${milestone.title}`, 'ms-detail-title');
    title.tabIndex = -1;
    titles.append(title);
    top.append(titles);
    const form = node('form', undefined, 'ms-form');
    const input = (name, label, value, multiline = false, parent = form) => {
      const wrap = node('label', label, 'ms-field'),
        field = node(multiline ? 'textarea' : 'input');
      field.name = name;
      field.value = value ?? '';
      wrap.append(field);
      parent.append(wrap);
      return field;
    };
    const titleField = input('title', 'Title', draft.title);
    titleField.required = true;
    titleField.maxLength = 100;
    const description = input('description', 'Scope', draft.description, true);
    description.maxLength = 120000;
    description.rows = 12;
    description.placeholder = 'What is true when this milestone is done? Markdown is supported.';
    const pair = node('div', undefined, 'ms-field-row');
    form.append(pair);
    const labels = input('labels', 'Labels', (draft.labels || []).join(', '), false, pair);
    labels.placeholder = 'Comma separated';
    const order = input('executionOrder', 'Execution order', draft.executionOrder, false, pair);
    order.type = 'number';
    order.min = '0';
    order.step = '1';
    order.placeholder = 'Not ordered';
    form.append(node('p', 'Lower numbers come first. Leave the order blank if it is not decided.', 'ms-hint'));
    // A draft is kept only while it differs from the saved record.
    const baseline = isNew
      ? { title: '', description: '', labels: [], executionOrder: '' }
      : {
          title: milestone.title,
          description: milestone.description || '',
          labels: milestone.labels || [],
          executionOrder: milestone.executionOrder ?? '',
        };
    const comparable = value =>
      JSON.stringify([
        String(value.title ?? ''),
        String(value.description ?? ''),
        (value.labels || []).join(','),
        String(value.executionOrder ?? ''),
      ]);
    let dirty = false,
      conflict = false;
    const preserve = () => {
      const value = {
        ...draft,
        title: titleField.value,
        description: description.value,
        labels: labels.value
          .split(',')
          .map(v => v.trim())
          .filter(Boolean),
        executionOrder: order.value,
      };
      dirty = comparable(value) !== comparable(baseline);
      if (current(editorTicket, editorProject)) {
        if (dirty) drafts.set(`${editorProject}:${milestone.id}`, value);
        else drafts.delete(`${editorProject}:${milestone.id}`);
      }
      return value;
    };
    const bar = node('div', undefined, 'editor-bar ms-editor-bar'),
      notice = node('span', undefined, 'editor-state'),
      controls = node('div', undefined, 'editor-actions');
    notice.setAttribute('role', 'status');
    const setState = (text, state = '') => {
      notice.textContent = text;
      notice.dataset.state = state;
    };
    const showState = () => {
      if (dirty) setState('Unsaved changes · kept in this tab', 'dirty');
      else setState(isNew ? 'Not created yet.' : 'No changes yet.');
      discard.disabled = !dirty || busy;
    };
    form.addEventListener('input', () => {
      preserve();
      showState();
    });
    const save = node('button', isNew ? 'Create milestone' : 'Save milestone', 'button primary');
    save.type = 'submit';
    const editable = isNew || !!(milestone.revision && (api || milestone.atomicRevision));
    save.disabled = !editable || !canWrite() || busy;
    let comparison = null;
    const compare = button('Compare', () => {
      if (!comparison) return;
      comparison.open = !comparison.open;
      if (comparison.open) comparison.scrollIntoView?.({ block: 'nearest' });
    });
    compare.hidden = !latest;
    const reload = button('Load latest; keep my draft', async () => {
      const loadRequest = ++editorRequest;
      preserve();
      reload.disabled = true;
      try {
        const fresh = unwrap(await load(milestone.id));
        if (!current(editorTicket, editorProject) || selected !== milestone.id || loadRequest !== editorRequest) return;
        renderEditor(fresh, { ...preserve(), expectedRevision: fresh.revision }, fresh);
      } catch (error) {
        if (current(editorTicket, editorProject)) setState(errorText(error), 'error');
      } finally {
        reload.disabled = false;
      }
    });
    // Only offered once a save has hit a newer version.
    reload.hidden = true;
    const leave = () => {
      editorRequest++;
      if (!isNew) return show(milestone.id, { focus: true });
      const previous = origin?.id;
      if (previous && previous !== '@new') return show(previous, { focus: true });
      closeDetail();
    };
    const discard = button('Discard', () => {
      if (busy) return;
      drafts.delete(key(milestone.id));
      leave();
    });
    const cancel = button('Cancel', () => {
      if (busy) return;
      preserve();
      leave();
    });
    if (isNew) controls.append(discard, cancel, save);
    else controls.append(compare, reload, discard, cancel, save);
    bar.append(notice, controls);
    form.append(bar);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !current(editorTicket, editorProject)) return;
      const retained = preserve();
      let created;
      try {
        assertWritable();
        if (!editable) throw new Error('A revision-aware server is required for editing.');
        const body = {
          ...retained,
          title: retained.title.trim(),
          executionOrder: parseMilestoneOrder(retained.executionOrder),
        };
        if (!body.title) throw new Error('Title is required.');
        busy = true;
        editorRequest++;
        for (const field of form.querySelectorAll('input,textarea,select,button')) field.disabled = true;
        setState(isNew ? 'Creating…' : 'Saving…');
        if (isNew) {
          created = unwrap(
            await api('/milestones', {
              method: 'POST',
              body: {
                title: body.title,
                description: body.description,
                labels: body.labels,
                executionOrder: body.executionOrder,
              },
            }),
          );
          if (!current(editorTicket, editorProject)) return;
          drafts.delete(key('@new'));
        } else if (api) await api(route(milestone.id), { method: 'PUT', body });
        else await write(`/api${route(milestone.id)}`, body);
        if (!current(editorTicket, editorProject)) return;
        drafts.delete(key(created?.id || milestone.id));
        busy = false;
        await saved(`${created?.id || milestone.id} saved.`, editorTicket, editorProject, created?.id || milestone.id);
      } catch (error) {
        if (!current(editorTicket, editorProject)) return;
        conflict = !isNew && /conflict|changed|stale|revision|409/i.test(errorText(error));
        reload.hidden = !conflict;
        setState(`${errorText(error)} Your draft is preserved.`, 'error');
      } finally {
        if (current(editorTicket, editorProject)) {
          busy = false;
          for (const field of form.querySelectorAll('input,textarea,select,button')) field.disabled = false;
          save.disabled = !editable || !canWrite();
          reload.disabled = false;
          discard.disabled = !dirty;
          renderList();
        }
      }
    });
    detail.append(backButton(), top);
    preserve();
    showState();
    if (latest) {
      comparison = node('details', undefined, 'ms-compare');
      comparison.open = true;
      comparison.append(node('summary', 'Your edits and the latest saved version'));
      for (const [field, label] of [
        ['title', 'Title'],
        ['description', 'Scope'],
        ['labels', 'Labels'],
        ['executionOrder', 'Execution order'],
      ]) {
        const show = value => (Array.isArray(value) ? value.join(', ') : String(value ?? '(not set)'));
        if (show(draft[field]) === show(latest[field])) continue;
        const section = node('section', undefined, 'ms-compare-field');
        section.append(
          node('h4', label),
          node('p', 'Yours'),
          node('pre', show(draft[field])),
          node('p', 'Latest saved'),
          node('pre', show(latest[field])),
        );
        comparison.append(section);
      }
      detail.append(comparison);
      setState('Latest version loaded. Your draft is unchanged; compare before saving.', 'dirty');
    }
    if (!editable) setState('Editing requires the updated Backlog fork. Restart after installing it.', 'error');
    if (!canWrite()) setState(blockedText(), 'error');
    detail.append(form);
    if (!isNew && api) {
      renderTasks(milestone);
      renderRemoval(milestone, preserve);
    }
    title.focus({ preventScroll: true });
  }
  function renderTasks(milestone) {
    const section = node('section', undefined, 'ms-section milestone-tasks');
    const head = node('div', undefined, 'ms-section-head');
    head.append(node('h3', 'Assign tasks'));
    section.append(head);
    const tools = node('div', undefined, 'ms-assign-tools');
    const filter = node('input');
    filter.type = 'search';
    filter.placeholder = 'Search task ID, title or status';
    filter.setAttribute('aria-label', 'Search milestone tasks');
    const mode = node('select');
    mode.setAttribute('aria-label', 'Task assignment filter');
    for (const [value, label] of [
      ['assigned', 'Assigned here'],
      ['unassigned', 'Unassigned'],
      ['all', 'All tasks'],
    ]) {
      const option = node('option', label);
      option.value = value;
      mode.append(option);
    }
    let shown = TASK_PAGE;
    const rows = node('div', undefined, 'milestone-task-list'),
      status = node('p', undefined, 'ms-meta');
    status.setAttribute('role', 'status');
    const more = button(
      'Show more tasks',
      () => {
        shown += TASK_PAGE;
        render();
      },
      'ms-more',
    );
    tools.append(filter, mode);
    section.append(tools, status, rows, more);
    detail.append(section);
    const render = () => {
      rows.replaceChildren();
      const matches = tasks.filter(
        t =>
          (mode.value === 'all' ||
            (mode.value === 'assigned' ? milestoneMatches(t.milestone, milestone) : !t.milestone)) &&
          `${t.id} ${t.title} ${t.status}`.toLowerCase().includes(filter.value.toLowerCase()),
      );
      status.textContent = `${assigned(milestone).length} assigned · showing ${Math.min(shown, matches.length)} of ${matches.length}`;
      more.hidden = matches.length <= shown;
      for (const task of matches.slice(0, shown)) {
        const row = node('div', undefined, 'milestone-task-row'),
          isAssigned = milestoneMatches(task.milestone, milestone);
        const dot = node('span', undefined, 'status-dot');
        dot.dataset.status = STATUSES.find(s => s.key === taskBucket(task.status)).status;
        dot.title = task.status || 'No status';
        const label = onTask
          ? button(`${task.id} · ${task.title}`, () => onTask(task.id), 'ms-task-name')
          : node('span', `${task.id} · ${task.title}`, 'ms-task-name');
        row.append(
          dot,
          label,
          node('span', `${task.status || 'No status'}${task.milestone ? ` · ${task.milestone}` : ''}`, 'ms-meta'),
        );
        const action = button(
          isAssigned ? 'Unassign' : 'Assign here',
          async () => {
            const ticket = generation,
              project = projectKey();
            if (busy) return;
            try {
              assertWritable();
              if (!task.revision) throw new Error('Reload tasks before assigning: the task has no revision.');
              if (
                !isAssigned &&
                task.milestone &&
                !globalThis.window?.confirm?.(`Move ${task.id} from ${task.milestone} to ${milestone.id}?`)
              )
                return;
              busy = true;
              editorRequest++;
              action.disabled = true;
              await api(`/tasks/${encodeURIComponent(task.id)}`, {
                method: 'PUT',
                body: { milestone: isAssigned ? null : milestone.id, expectedRevision: task.revision },
              });
              if (!current(ticket, project)) return;
              await onSaved();
              if (!current(ticket, project)) return;
              await refresh();
              if (!current(ticket, project) || selected !== milestone.id) return;
              render();
              status.textContent += ` · ${task.id} ${isAssigned ? 'unassigned' : 'assigned'}.`;
            } catch (error) {
              if (current(ticket, project))
                status.textContent = `${errorText(error)} No retry was made. Refresh tasks and try again.`;
            } finally {
              if (current(ticket, project)) {
                busy = false;
                action.disabled = !canWrite();
              }
            }
          },
          'button quiet button-small',
        );
        action.disabled = !canWrite() || !task.revision;
        row.append(action);
        rows.append(row);
      }
      if (!matches.length) rows.append(node('p', 'No tasks match this filter.', 'ms-meta'));
    };
    filter.addEventListener('input', () => {
      shown = TASK_PAGE;
      render();
    });
    mode.addEventListener('change', () => {
      shown = TASK_PAGE;
      render();
    });
    head.append(
      button(
        'Refresh tasks',
        async () => {
          const ticket = generation,
            project = projectKey();
          await refresh();
          if (current(ticket, project)) render();
        },
        'button quiet button-small',
      ),
    );
    render();
  }
  function renderRemoval(milestone, preserve) {
    const section = node('details', undefined, 'ms-section milestone-removal');
    section.append(node('summary', 'Archive or remove'));
    section.append(
      node(
        'p',
        'Archive hides the milestone and keeps task links. Remove also archives it and applies the task handling you choose. No tasks are deleted.',
        'ms-meta',
      ),
    );
    const handling = node('select');
    handling.setAttribute('aria-label', 'Task handling on milestone removal');
    for (const [value, label] of [
      ['clear', 'Clear milestone links from matching tasks'],
      ['keep', 'Keep existing task milestone links'],
      ['reassign', 'Reassign matching tasks to another milestone'],
    ]) {
      const option = node('option', label);
      option.value = value;
      handling.append(option);
    }
    const target = node('select');
    target.setAttribute('aria-label', 'Replacement milestone');
    target.hidden = true;
    for (const other of sortMilestones(milestones).filter(m => m.id !== milestone.id)) {
      const option = node('option', `${other.id} · ${other.title}`);
      option.value = other.id;
      target.append(option);
    }
    handling.addEventListener('change', () => {
      target.hidden = handling.value !== 'reassign';
    });
    const status = node('p', undefined, 'ms-notice');
    status.setAttribute('role', 'alert');
    const report = text => {
      status.textContent = text;
    };
    const archiveButton = button(
        'Archive milestone',
        () => mutate(milestone, { archiveOnly: true, preserve, report }),
        'button quiet',
      ),
      removeButton = button(
        'Remove milestone',
        () =>
          mutate(milestone, { archiveOnly: false, handling: handling.value, target: target.value, preserve, report }),
        'button danger',
      );
    archiveButton.disabled = removeButton.disabled = !canWrite();
    const row = node('div', undefined, 'ms-removal-row');
    row.append(handling, target, removeButton);
    section.append(archiveButton, row, status);
    detail.append(section);
  }

  // Reader ---------------------------------------------------------------------------
  function backButton() {
    const back = button('Back to milestones', closeDetail, 'button quiet button-small ms-back');
    back.setAttribute('aria-label', 'Back to milestones');
    return back;
  }
  function closeDetail(_event, navigate = true) {
    editorRequest++;
    const previous = origin?.id ?? selected;
    selected = null;
    if (!wide() && navigate) onNavigate({ view: 'milestones' });
    placeholder();
    markSelected();
    setPane('list');
    const row = rows.find(el => el.dataset.milestone === previous);
    row?.focus({ preventScroll: true });
    if (origin?.y != null) globalThis.window?.scrollTo?.({ top: origin.y });
  }
  function renderReader(milestone, { focus = true } = {}) {
    const sameRecord = detail.dataset.record === milestone.id;
    const keepScroll = sameRecord ? detail.scrollTop : 0;
    clearDetail();
    detail.dataset.record = milestone.id;
    detail.scrollTop = keepScroll;
    markSelected();
    setPane('detail');
    detail.dataset.mode = 'read';
    const isArchived = showArchived && archived.some(m => m.id === milestone.id);
    const head = node('div', undefined, 'ms-detail-head');
    const kicker = node('div', undefined, 'ms-kicker');
    const pill = node('span', undefined, 'status-pill');
    const order = node(
      'span',
      milestone.executionOrder == null ? 'Not ordered' : `Order ${milestone.executionOrder}`,
      'badge ms-order-chip',
    );
    kicker.append(node('span', milestone.id, 'ms-id'), pill, order);
    const title = node('h2', milestone.title, 'ms-detail-title');
    title.tabIndex = -1;
    const titles = node('div', undefined, 'ms-titles');
    titles.append(kicker, title);
    if (milestone.labels?.length) {
      const labels = node('div', undefined, 'ms-labels');
      for (const label of milestone.labels) labels.append(node('span', label, 'chip'));
      titles.append(labels);
    }
    head.append(titles);
    const startEdit = () =>
      renderEditor(
        milestone,
        drafts.get(key(milestone.id)) || {
          expectedRevision: milestone.revision,
          title: milestone.title,
          description: milestone.description || '',
          labels: milestone.labels || [],
          executionOrder: milestone.executionOrder ?? '',
        },
      );
    // A div, not a form: the reader stays free of editor forms. Enter in the field saves.
    const orderForm = node('div', undefined, 'ms-order-form');
    orderForm.setAttribute('role', 'group');
    orderForm.setAttribute('aria-label', 'Set execution order');
    orderForm.hidden = true;
    if (!isArchived) {
      const tools = node('div', undefined, 'ms-detail-actions');
      const edit = button('Edit', startEdit, 'button quiet');
      const setOrder = button('Set order', () => {
        orderForm.hidden = !orderForm.hidden;
        setOrder.setAttribute('aria-expanded', String(!orderForm.hidden));
        if (!orderForm.hidden) orderInput.focus();
      });
      setOrder.setAttribute('aria-expanded', 'false');
      const tools2 = [edit, setOrder];
      if (api) {
        const archive = button('Archive', () =>
          mutate(milestone, {
            archiveOnly: true,
            report: text => {
              message.textContent = text;
            },
          }),
        );
        tools2.push(archive);
      }
      for (const el of tools2.slice(1)) fence(el);
      edit.title = canWrite() ? '' : blockedText();
      tools.append(...tools2);
      head.append(tools);
    }
    const orderLabel = node('label', 'Execution order', 'ms-field');
    const orderInput = node('input');
    orderInput.type = 'number';
    orderInput.min = '0';
    orderInput.step = '1';
    orderInput.name = 'order';
    orderInput.placeholder = 'Not ordered';
    orderInput.value = milestone.executionOrder ?? '';
    orderLabel.append(orderInput);
    const orderNotice = node('p', undefined, 'ms-notice');
    orderNotice.setAttribute('role', 'alert');
    const orderSave = node('button', 'Save order', 'button primary button-small');
    orderSave.type = 'button';
    orderSave.addEventListener('click', () => saveOrder());
    orderInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveOrder();
      }
    });
    const orderActions = node('div', undefined, 'ms-form-actions');
    const moveToEnd = button(
      'Move to end',
      () => {
        orderForm.hidden = true;
        reorder(
          planMilestoneOrder(milestones, milestone.id, null),
          `${milestone.title} moved to the end of the order.`,
          milestone.id,
        );
      },
      'button quiet button-small',
    );
    moveToEnd.hidden = !api || !milestones.some(m => m.id === milestone.id);
    orderActions.append(
      orderSave,
      moveToEnd,
      button(
        'Cancel',
        () => {
          orderForm.hidden = true;
          orderNotice.textContent = '';
        },
        'button quiet button-small',
      ),
    );
    orderForm.append(
      orderLabel,
      orderActions,
      node('p', 'Lower numbers come first. Leave blank to clear.', 'ms-hint'),
      orderNotice,
    );
    async function saveOrder() {
      const ticket = generation,
        project = projectKey();
      if (busy) return;
      try {
        assertWritable();
        if (!(milestone.revision && (api || milestone.atomicRevision)))
          throw new Error('A revision-aware server is required for editing.');
        const body = { expectedRevision: milestone.revision, executionOrder: parseMilestoneOrder(orderInput.value) };
        busy = true;
        orderSave.disabled = true;
        if (api) await api(route(milestone.id), { method: 'PUT', body });
        else await write(`/api${route(milestone.id)}`, body);
        busy = false;
        await saved(
          body.executionOrder == null
            ? `${milestone.id} order cleared.`
            : `${milestone.id} set to order ${body.executionOrder}.`,
          ticket,
          project,
          milestone.id,
        );
      } catch (error) {
        if (current(ticket, project))
          orderNotice.textContent = /changed|conflict|revision/i.test(errorText(error))
            ? `${errorText(error)} Someone else saved this milestone. Reopen it and try again.`
            : errorText(error);
      } finally {
        if (current(ticket, project)) {
          busy = false;
          orderSave.disabled = false;
        }
      }
    }
    detail.append(backButton(), head, orderForm);
    if (isArchived)
      detail.append(node('p', 'Archived. Restoring archived milestones is not supported here.', 'banner'));
    else if (!canWrite()) detail.append(node('p', blockedText(), 'banner ms-fence'));
    const pending = drafts.get(key(milestone.id));
    if (
      pending &&
      [
        [pending.title, milestone.title],
        [pending.description, milestone.description || ''],
        [(pending.labels || []).join(','), (milestone.labels || []).join(',')],
        [String(pending.executionOrder ?? ''), String(milestone.executionOrder ?? '')],
      ].some(([mine, saved]) => String(mine ?? '') !== String(saved ?? ''))
    ) {
      const resume = node('div', undefined, 'banner ms-draft');
      resume.append(
        node('span', 'You have unsaved edits to this milestone.'),
        button('Resume editing', startEdit, 'button quiet button-small'),
      );
      detail.append(resume);
    }
    // Summary, scope and linked tasks share one grid: stacked when narrow, scope beside the rest when wide.
    const body = node('div', undefined, 'ms-body');
    const summary = node('div', undefined, 'ms-summary');
    body.append(summary);
    detail.append(body);
    const scope = node('section', undefined, 'ms-section ms-scope');
    scope.append(node('h3', 'Scope'));
    const prose = node('article', undefined, 'docs-prose ms-prose');
    prose.innerHTML = renderMarkdown(milestone.description || 'No scope written yet.').html;
    scope.append(prose);
    body.append(scope);
    const readerTicket = editorRequest,
      readerProject = projectKey();
    cleanupProse = bindProseInteractions(prose, {
      api,
      onOpenRecord,
      sourcePath: milestone.path || '',
      report: text => {
        message.textContent = text;
      },
      isCurrent: () => !destroyed && readerTicket === editorRequest && readerProject === projectKey(),
    });
    const linkedSection = node('section', undefined, 'ms-section milestone-tasks ms-linked');
    const linkedHead = node('div', undefined, 'ms-section-head');
    const linkedCount = node('span', undefined, 'count');
    const linkedTitle = node('h3', 'Linked tasks');
    linkedHead.append(linkedTitle, linkedCount);
    const taskRows = node('div', undefined, 'ms-task-table'),
      count = node('span', undefined, 'ms-meta');
    count.setAttribute('role', 'status');
    let shown = TASK_PAGE,
      signature = null;
    const more = button(
      'Show more linked tasks',
      () => {
        shown += TASK_PAGE;
        renderLinked(true);
      },
      'ms-more',
    );
    const pager = node('div', undefined, 'ms-pager');
    pager.append(count, more);
    linkedSection.append(linkedHead, taskRows, pager);
    body.append(linkedSection);
    function renderSummary(state) {
      summary.replaceChildren();
      const group = groupOf(milestone);
      pill.dataset.status = isArchived ? 'backlog' : group.status;
      pill.textContent = isArchived ? 'Archived' : group.label;
      const counts = statusCounts(state.linked),
        total = state.linked.length;
      summary.dataset.empty = total ? '' : 'true';
      if (!total) {
        const empty = node('div', undefined, 'ms-summary-empty');
        empty.append(
          node('p', 'No tasks linked yet.', 'ms-next-reason'),
          node('p', api ? 'Use Edit to assign tasks to this milestone.' : 'Linked tasks appear here.', 'ms-hint'),
        );
        summary.append(empty);
        return;
      }
      const progress = node('div', undefined, 'ms-progress');
      const progressHead = node('div', undefined, 'ms-summary-head');
      progressHead.append(
        node('h3', 'Progress'),
        node('span', total ? `${state.done} of ${total} done` : 'No tasks', 'ms-meta'),
      );
      const percent = node('div', undefined, 'ms-percent');
      percent.append(
        node('span', total ? `${Math.round((100 * state.done) / total)}%` : '–', 'ms-percent-value'),
        progressBar(counts, total, 'ms-progress-bar'),
      );
      const legend = node('ul', undefined, 'ms-legend');
      for (const status of STATUSES) {
        const item = node('li');
        if (!counts[status.key]) item.dataset.zero = 'true';
        const dot = node('span', undefined, 'status-dot');
        dot.dataset.status = status.status;
        item.append(dot, node('span', status.label), node('strong', String(counts[status.key])));
        legend.append(item);
      }
      progress.append(progressHead, percent, legend);
      const next = node('div', undefined, 'ms-next');
      const nextHead = node('div', undefined, 'ms-summary-head');
      nextHead.append(node('h3', 'Next up'));
      next.append(nextHead);
      const upcoming = nextUp(state.linked, tasks, milestones);
      if (upcoming.task) {
        const task = upcoming.task;
        const link = node(onTask ? 'button' : 'div', undefined, 'ms-next-task');
        if (onTask) {
          link.type = 'button';
          link.addEventListener('click', () => onTask(task.id));
        }
        link.dataset.nextTask = task.id;
        const dot = node('span', undefined, 'status-dot');
        dot.dataset.status = 'ready';
        const text = node('span', undefined, 'ms-next-text');
        text.append(node('span', task.title, 'ms-next-title'));
        const meta = node('span', undefined, 'ms-meta');
        meta.textContent = [task.id, (task.assignee || []).join(', ') || 'Unassigned'].join(' · ');
        text.append(meta);
        link.append(dot, text);
        next.append(link, node('p', 'First Ready task in this milestone.', 'ms-hint'));
      } else {
        next.append(node('p', upcoming.reason, 'ms-next-reason'));
        if (upcoming.blockers?.length) {
          const blockers = node('div', undefined, 'ms-blockers');
          blockers.append(node('span', 'Waiting on', 'ms-meta'));
          for (const blocker of upcoming.blockers) {
            const label = `${blocker.id}${blocker.title ? ` · ${blocker.title}` : ''}`;
            const el = onTask
              ? button(label, () => onTask(blocker.id), 'ms-blocker')
              : node('span', label, 'ms-blocker');
            el.dataset.blocker = blocker.id;
            blockers.append(el);
          }
          if (upcoming.moreBlockers) blockers.append(node('span', `+${upcoming.moreBlockers} more`, 'ms-meta'));
          next.append(blockers);
        }
        for (const note of upcoming.notes || []) next.append(node('p', note, 'ms-hint'));
      }
      summary.append(progress, next);
    }
    function renderLinked(force = false) {
      const state = milestoneState(milestone, tasks);
      const nextSignature = JSON.stringify(
        state.linked.map(t => [t.id, t.title, t.status, t.assignee, t.dependencies, t.blockReason]),
      );
      if (!force && nextSignature === signature) return;
      signature = nextSignature;
      renderSummary(state);
      const ordered = state.linked
        .map((task, index) => ({ task, index }))
        .sort(
          (a, b) =>
            TASK_ORDER.indexOf(taskBucket(a.task.status)) - TASK_ORDER.indexOf(taskBucket(b.task.status)) ||
            (a.task.ordinal ?? Infinity) - (b.task.ordinal ?? Infinity) ||
            a.index - b.index,
        )
        .map(entry => entry.task);
      taskRows.replaceChildren();
      linkedCount.textContent = String(ordered.length);
      linkedSection.hidden = !ordered.length;
      count.textContent =
        ordered.length > TASK_PAGE ? `Showing ${Math.min(shown, ordered.length)} of ${ordered.length}` : '';
      more.hidden = ordered.length <= shown;
      pager.hidden = ordered.length <= TASK_PAGE;
      if (!ordered.length) {
        taskRows.append(node('p', 'No tasks linked yet.', 'ms-meta ms-task-empty'));
        return;
      }
      const counts = statusCounts(ordered);
      let bucket = null;
      for (const task of ordered.slice(0, shown)) {
        const taskBucketKey = taskBucket(task.status);
        if (taskBucketKey !== bucket) {
          bucket = taskBucketKey;
          const status = STATUSES.find(s => s.key === bucket);
          const groupHead = node('div', undefined, 'ms-task-group');
          const dot = node('span', undefined, 'status-dot');
          dot.dataset.status = status.status;
          groupHead.append(dot, node('span', status.label), node('span', String(counts[bucket]), 'ms-meta'));
          taskRows.append(groupHead);
        }
        const cells = [
          node('span', task.id, 'ms-task-id'),
          node('span', task.title, 'ms-task-title'),
          node('span', (task.assignee || []).join(', ') || '—', 'ms-task-assignee'),
        ];
        let row;
        if (onTask) {
          row = button('', () => onTask(task.id), 'ms-task-link');
          row.setAttribute('aria-label', `${task.id} - ${task.title} - ${task.status || 'No status'}`);
        } else row = node('div', undefined, 'ms-task-link');
        row.dataset.task = task.id;
        row.append(...cells);
        taskRows.append(row);
      }
    }
    updateReader = () => renderLinked();
    renderLinked(true);
    if (focus) title.focus({ preventScroll: true });
    if (!wide() && !sameRecord) globalThis.window?.scrollTo?.({ top: 0 });
  }
  async function show(id, { focus = true } = {}) {
    if (busy) return;
    const ticket = generation,
      project = projectKey(),
      loadRequest = ++editorRequest;
    selected = id;
    markSelected();
    const cached = (showArchived ? archived : milestones).find(m => m.id === id);
    if (cached) renderReader(cached, { focus });
    else message.textContent = 'Loading milestone…';
    if (showArchived && cached) return;
    try {
      const milestone = unwrap(await load(id));
      if (!current(ticket, project) || selected !== id || loadRequest !== editorRequest) return;
      if (message.textContent === 'Loading milestone…') message.textContent = '';
      if (
        !cached ||
        cached.revision !== milestone.revision ||
        cached.title !== milestone.title ||
        cached.description !== milestone.description
      )
        renderReader(milestone, {
          focus: focus && (!cached || !!detail.contains?.(globalThis.document?.activeElement)),
        });
    } catch (error) {
      if (current(ticket, project) && loadRequest === editorRequest) message.textContent = errorText(error);
    }
  }
  function open(id) {
    origin = { id, y: globalThis.window?.scrollY };
    return show(id, { focus: true });
  }
  async function refresh() {
    if (!milestones.length) message.textContent = 'Loading milestones…';
    const ticket = generation,
      project = projectKey(),
      requestId = ++request;
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
      if (refreshFailed || message.textContent === 'Loading milestones…') message.textContent = '';
      refreshFailed = false;
      renderList();
      if (updateReader) updateReader();
      else if (selected === null && !detail.childNodes.length) {
        // Wide screens always show a milestone; narrow screens keep the list.
        const first = rows[0]?.dataset.milestone;
        if (first && wide()) await show(first, { focus: false });
        else placeholder();
      }
    } catch (error) {
      if (current(ticket, project) && requestId === request) {
        message.textContent = errorText(error);
        refreshFailed = true;
      }
    }
  }
  function reset() {
    generation++;
    request++;
    editorRequest++;
    busy = false;
    selected = null;
    milestones = [];
    tasks = [];
    archived = [];
    showArchived = false;
    filter = 'all';
    doneOpen = false;
    pages = {};
    listSignature = '';
    rows = [];
    search.value = '';
    toggle.setAttribute('aria-pressed', 'false');
    list.replaceChildren();
    clearDetail();
    setPane('list');
    message.textContent = '';
  }
  return {
    refresh,
    reset,
    open,
    // Browser history reached the list without a record: close the narrow detail without a new entry.
    close() {
      if (!wide() && selected) closeDetail(null, false);
    },
    destroy() {
      reset();
      destroyed = true;
      container.replaceChildren();
    },
  };
}
