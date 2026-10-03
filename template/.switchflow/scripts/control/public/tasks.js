import {
  escapeHTML as e,
  filterTasks,
  moveTaskOrder,
  taskBlockerText,
  ownerMarkup,
  statusKey,
  isoDay as day,
} from './tasks-model.js';
import { taskEditor } from './tasks-editor.js';

const PAGE_SIZE = 30;
// Board lanes are bounded; the finished lane reads newest first and grows in pages of 20.
const LANE_STEP = 20;
const LANE_LIMIT = 50;
const flip = { top: 'bottom', bottom: 'top', before: 'after', after: 'before' };
const finishedLane = status => ['done', 'completed', 'complete'].includes(String(status || '').toLowerCase());
const icon = {
  refresh:
    '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16 4v3.5h-3.5"/></svg>',
  filter:
    '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h14M6 10h8M8.5 15h3"/></svg>',
  search:
    '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="m13.2 13.2 3.3 3.3"/></svg>',
};
export function mountTasks(
  container,
  {
    api,
    projectId,
    canWrite = () => true,
    writeBlockedReason = () => '',
    onChange = () => {},
    onNavigate = () => {},
    onClose = () => {},
    onOpenRecord = async () => {},
  },
) {
  let mode = 'tasks',
    layout = 'board',
    tasks = [],
    statuses = [],
    types = [],
    milestones = [],
    generation = 0,
    editorGeneration = 0,
    destroyed = false,
    editor,
    review,
    dragging,
    pending = false,
    filtersOpen = false,
    restoreFocusTo = null,
    laneLimit = {};
  const events = new AbortController();
  const listen = (type, handler) => container.addEventListener(type, handler, { signal: events.signal });
  const filters = { search: '', status: '', assignee: '', labels: '', priority: '', type: '', milestone: '' };
  const storageKey = `switchflow:task-edits:${projectId}`;
  const uid = `sf-tasks-${Math.random().toString(36).slice(2, 8)}`;
  let activeTaskId = null,
    detailViews = {};
  try {
    detailViews = JSON.parse(sessionStorage.getItem(`${storageKey}:views`)) || {};
  } catch {}
  function rememberEditor() {
    if (!editor || !activeTaskId) return;
    detailViews[activeTaskId] = editor.snapshot();
    const entries = Object.entries(detailViews);
    if (entries.length > 40) detailViews = Object.fromEntries(entries.slice(-40));
    try {
      sessionStorage.setItem(`${storageKey}:views`, JSON.stringify(detailViews));
    } catch {}
  }
  function closeEditor() {
    rememberEditor();
    editor?.destroy();
    editor = null;
    activeTaskId = null;
  }
  let lastLoaded = '',
    hideEmptyColumns = false,
    defaultStatus,
    page = 1,
    sort = 'ordinal',
    density = 'comfortable',
    laneScroll = {},
    boardScroll = 0,
    loadFeedback = '';
  const viewKey = `switchflow:task-view:${projectId}`;
  try {
    const state = JSON.parse(sessionStorage.getItem(viewKey));
    if (state) {
      Object.assign(filters, state.filters);
      layout = state.layout || layout;
      sort = state.sort || sort;
      density = state.density || density;
      page = state.page || 1;
      laneScroll = state.laneScroll || {};
      boardScroll = state.boardScroll || 0;
    }
  } catch {}
  const persist = () => {
    try {
      sessionStorage.setItem(
        viewKey,
        JSON.stringify({ filters, layout, sort, density, page, laneScroll, boardScroll }),
      );
    } catch {}
  };
  const plural = {
    status: 'statuses',
    assignee: 'owners',
    labels: 'labels',
    priority: 'priorities',
    type: 'types',
    milestone: 'milestones',
  };
  const names = {
    status: 'Status',
    assignee: 'Owner',
    labels: 'Label',
    priority: 'Priority',
    type: 'Type',
    milestone: 'Milestone',
  };
  const milestoneName = id => milestones.find(x => x.id === id)?.title || id;
  container.classList.add('sf-tasks');
  container.innerHTML = `<header class="page-header sf-tasks-header"><div><h1 data-title>Tasks</h1><p data-subtitle>Plan, assign and track work across your project.</p></div><div class="page-actions"><button type="button" class="button primary" data-create>Create task</button></div></header><div class="toolbar sf-task-toolbar"><label class="sf-task-search"><span class="sf-search-icon">${icon.search}</span><span class="sf-sr">Search tasks</span><input type="search" data-search placeholder="Search ID, title or description" autocomplete="off"></label><div class="segmented" role="group" aria-label="Task layout"><button type="button" data-layout="board" aria-pressed="true">Board</button><button type="button" data-layout="list" aria-pressed="false">List</button></div><button type="button" class="button quiet sf-filter-toggle" data-filters aria-expanded="false" aria-controls="${uid}-filters">${icon.filter}Filters<span class="count" data-filter-count hidden></span></button><div class="sf-active-filters" data-active-filters></div><div class="sf-toolbar-end"><p class="sf-task-count" aria-live="polite"></p><button type="button" class="icon-button" data-refresh aria-label="Refresh tasks" title="Refresh">${icon.refresh}</button><details class="sf-menu sf-maintenance"><summary class="icon-button" aria-label="More task actions" title="More"><span aria-hidden="true">⋯</span></summary><div class="sf-menu-list"><button type="button" data-maintenance="duplicates">Review duplicate IDs</button><button type="button" data-maintenance="cleanup">Review completed cleanup</button></div></details></div></div><div class="sf-filter-panel" id="${uid}-filters" data-filter-panel role="region" aria-label="Filters and view" hidden><div class="sf-task-filters"></div><div class="sf-task-view-options"><label>Sort<select data-sort><option value="ordinal">Board order</option><option value="title">Title</option><option value="status">Status</option><option value="priority">Priority</option></select></label><label>Density<select data-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div><div class="sf-filter-foot"><button type="button" class="button quiet button-small" data-clear>Clear filters</button><button type="button" class="button quiet button-small" data-filters-close>Done</button></div></div><p class="sf-task-notice" role="status"></p><div class="sf-task-results"></div>`;
  const find = selector => container.querySelector(selector),
    notice = find('.sf-task-notice'),
    results = find('.sf-task-results');
  const blockedReason = () => writeBlockedReason() || 'Changes are temporarily unavailable.';
  function updateAccess() {
    updateCount();
    find('[data-create]').disabled = !canWrite();
    container.querySelectorAll('.sf-task-card').forEach(card => {
      const task = tasks.find(item => item.id === card.dataset.id);
      card.draggable = mode === 'tasks' && canWrite() && Boolean(task && editable(task));
    });
    container.querySelectorAll('[data-action=promote]').forEach(button => (button.disabled = !canWrite()));
    editor?.updateAccess();
    if (review?.isConnected) {
      const confirm = review.querySelector('[data-confirm]'),
        message = review.querySelector('.sf-review-message');
      if (confirm) confirm.disabled = pending || !canWrite() || review.dataset.uncertain === 'true';
      if (!canWrite()) {
        review.dataset.accessReason = blockedReason();
        message.textContent = review.dataset.accessReason;
      } else if (message.textContent === review.dataset.accessReason) {
        message.textContent = '';
        delete review.dataset.accessReason;
      }
    }
    if (!canWrite() && dragging) clearDrag();
  }
  const filtered = () => Object.values(filters).some(Boolean);
  function updateCount() {
    const total = tasks.length,
      noun = `${mode === 'drafts' ? 'draft ' : ''}${total === 1 ? 'task' : 'tasks'}`;
    find('.sf-task-count').textContent =
      `${filtered() ? `${filterTasks(tasks, filters).length} of ${total}` : total} ${noun}${!canWrite() ? ` · ${blockedReason()}` : ''}`;
  }
  function locked() {
    if (!canWrite()) {
      notice.textContent = blockedReason();
      return true;
    }
    return false;
  }
  function filterControls() {
    const options = {
      status: statuses,
      assignee: [...new Set(tasks.flatMap(x => x.assignee || []))],
      labels: [...new Set(tasks.flatMap(x => x.labels || []))],
      priority: ['high', 'medium', 'low'],
      type: [...new Set([...types, ...tasks.map(x => x.type).filter(Boolean)])],
      milestone: [...new Set([...milestones.map(x => x.id), ...tasks.map(x => x.milestone).filter(Boolean)])],
    };
    find('.sf-task-filters').innerHTML = Object.entries(options)
      .map(
        ([key, items]) =>
          `<label>${names[key]}<select data-filter="${key}"><option value="">All ${plural[key]}</option>${items.map(value => `<option value="${e(value)}" ${filters[key] === value ? 'selected' : ''}>${e(key === 'milestone' ? milestoneName(value) : value)}</option>`).join('')}</select></label>`,
      )
      .join('');
  }
  function renderFilterState() {
    const active = Object.entries(filters).filter(([key, value]) => value && key !== 'search');
    const count = find('[data-filter-count]');
    count.textContent = String(active.length);
    count.hidden = !active.length;
    find('[data-active-filters]').innerHTML = active.length
      ? `${active
          .map(
            ([key, value]) =>
              `<button type="button" class="chip sf-filter-chip" data-remove-filter="${key}" aria-label="Remove ${e(names[key])} filter ${e(key === 'milestone' ? milestoneName(value) : value)}"><span class="sf-chip-key">${e(names[key])}</span>${e(key === 'milestone' ? milestoneName(value) : value)}<span aria-hidden="true">×</span></button>`,
          )
          .join(
            '',
          )}${active.length > 1 ? '<button type="button" class="sf-text-button" data-clear>Clear all</button>' : ''}`
      : '';
    find('[data-filter-panel]').hidden = !filtersOpen;
    container.querySelectorAll('[data-filters]').forEach(x => x.setAttribute('aria-expanded', String(filtersOpen)));
  }
  container.addEventListener(
    'scroll',
    event => {
      if (event.target.matches?.('.sf-task-board')) {
        boardScroll = event.target.scrollLeft;
        boardEdges();
      }
      if (event.target.matches?.('.sf-task-stack'))
        laneScroll[event.target.closest('.sf-task-column').dataset.status] = event.target.scrollTop;
      persist();
    },
    { capture: true, signal: events.signal },
  );
  const editable = task => !['remote', 'local-branch', 'completed'].includes(task.source);
  const chipsFor = task =>
    `${task.priority ? `<span class="chip sf-priority" data-priority="${e(statusKey(task.priority))}">${e(task.priority)}</span>` : ''}${task.type ? `<span class="chip">${e(task.type)}</span>` : ''}${editable(task) ? '' : `<span class="chip" title="This record cannot be edited here">Read only</span>`}`;
  const labelsFor = task =>
    (task.labels || []).length
      ? `<span class="sf-task-labels">${task.labels.map(x => `<span class="sf-label">${e(x)}</span>`).join('')}</span>`
      : '';
  const actionsFor = task =>
    mode === 'drafts'
      ? `<button type="button" class="button quiet button-small" data-action="promote" data-id="${e(task.id)}" ${!canWrite() ? 'disabled' : ''}>Promote</button>`
      : editable(task)
        ? `<button type="button" class="sf-task-more icon-button" data-actions="${e(task.id)}" aria-label="Move or archive ${e(task.id)}" title="Move or archive"><span aria-hidden="true">⋯</span></button>`
        : '';
  function card(task) {
    const blocker = taskBlockerText(task, tasks);
    return `<article class="sf-task-card" data-id="${e(task.id)}" draggable="${mode === 'tasks' && canWrite() && editable(task)}"><button type="button" class="sf-task-open" data-open="${e(task.id)}"><span class="sf-card-top"><span class="card-id">${e(task.id)}</span>${chipsFor(task)}</span><span class="card-title">${e(task.title)}</span>${blocker ? `<span class="task-block-reason">${e(blocker)}</span>` : ''}<span class="sf-card-meta">${ownerMarkup(task.assignee)}${task.milestone ? `<span class="sf-card-milestone">${e(milestoneName(task.milestone))}</span>` : ''}</span>${labelsFor(task)}</button><div class="sf-task-card-actions">${actionsFor(task)}</div></article>`;
  }
  function row(task) {
    const blocker = taskBlockerText(task, tasks);
    return `<tr data-row="${e(task.id)}"><td class="sf-col-id"><span class="card-id">${e(task.id)}</span></td><td class="sf-col-title"><button type="button" class="sf-row-open" data-open="${e(task.id)}">${e(task.title)}</button>${blocker ? `<span class="task-block-reason">${e(blocker)}</span>` : ''}</td><td class="sf-col-status"><span class="status-pill" data-status="${e(statusKey(task.status))}">${e(task.status || 'No status')}</span></td><td class="sf-col-owner">${ownerMarkup(task.assignee)}</td><td class="sf-col-milestone">${task.milestone ? e(milestoneName(task.milestone)) : '<span class="sf-none">—</span>'}</td><td class="sf-col-priority">${task.priority ? `<span class="chip sf-priority" data-priority="${e(statusKey(task.priority))}">${e(task.priority)}</span>` : '<span class="sf-none">—</span>'}</td><td class="sf-col-updated">${task.updatedDate ? `<time datetime="${e(task.updatedDate)}">${e(day(task.updatedDate))}</time>` : '<span class="sf-none">—</span>'}</td><td class="sf-col-actions">${actionsFor(task)}</td></tr>`;
  }
  function render() {
    if (destroyed) return;
    const shown = filterTasks(tasks, filters).sort((a, b) =>
      sort === 'ordinal'
        ? (a.ordinal || 0) - (b.ordinal || 0)
        : sort === 'priority'
          ? ['high', 'medium', 'low', ''].indexOf(a.priority || '') -
            ['high', 'medium', 'low', ''].indexOf(b.priority || '')
          : String(a[sort] || '').localeCompare(String(b[sort] || '')),
    );
    persist();
    container.dataset.density = density;
    container.dataset.viewLayout = layout === 'list' || mode === 'drafts' ? 'list' : 'board';
    find('[data-search]').value = filters.search;
    find('[data-sort]').value = sort;
    find('[data-density]').value = density;
    container
      .querySelectorAll('[data-layout]')
      .forEach(x => x.setAttribute('aria-pressed', String(x.dataset.layout === layout)));
    renderFilterState();
    updateCount();
    find('[data-create]').disabled = !canWrite();
    if (!shown.length) {
      results.innerHTML = `<div class="empty sf-task-empty"><strong>${tasks.length ? 'No matching tasks' : mode === 'drafts' ? 'No drafts yet' : 'No tasks yet'}</strong><p>${tasks.length ? 'Adjust or clear the filters to see more work.' : `Create a ${mode === 'drafts' ? 'draft to shape an idea before promoting it.' : 'task to start tracking work.'}`}</p>${tasks.length ? '<button type="button" class="button quiet" data-clear>Clear filters</button>' : `<button type="button" class="button primary" data-create ${!canWrite() ? 'disabled' : ''}>${mode === 'drafts' ? 'Create draft' : 'Create task'}</button>`}</div>`;
      return;
    }
    if (layout === 'list' || mode === 'drafts') {
      page = Math.min(page, Math.max(1, Math.ceil(shown.length / PAGE_SIZE)));
      const start = (page - 1) * PAGE_SIZE;
      results.innerHTML = `<div class="sf-task-table-wrap"><table class="data-table sf-task-table"><thead><tr><th scope="col" class="sf-col-id">ID</th><th scope="col" class="sf-col-title">Title</th><th scope="col" class="sf-col-status">Status</th><th scope="col" class="sf-col-owner">Owner</th><th scope="col" class="sf-col-milestone">Milestone</th><th scope="col" class="sf-col-priority">Priority</th><th scope="col" class="sf-col-updated">Updated</th><th scope="col" class="sf-col-actions"><span class="sf-sr">Actions</span></th></tr></thead><tbody>${shown
        .slice(start, start + PAGE_SIZE)
        .map(row)
        .join(
          '',
        )}</tbody></table></div><nav class="sf-task-pagination" aria-label="Task pages"><span>${start + 1}–${Math.min(start + PAGE_SIZE, shown.length)} of ${shown.length}</span><button type="button" class="button quiet button-small" data-page="previous" ${page === 1 ? 'disabled' : ''}>Previous</button><button type="button" class="button quiet button-small" data-page="next" ${start + PAGE_SIZE >= shown.length ? 'disabled' : ''}>Next</button></nav>`;
    } else
      results.innerHTML = `<div class="sf-board-wrap"><div class="sf-task-board">${[
        ...new Set([...statuses, ...tasks.map(x => x.status)]),
      ]
        .map(status => {
          const reversed = finishedLane(status),
            lane = shown
              .filter(x => x.status === status)
              .sort((a, b) => ((a.ordinal || 0) - (b.ordinal || 0)) * (reversed ? -1 : 1)),
            limit = laneLimit[status] || (reversed ? LANE_STEP : LANE_LIMIT),
            rest = lane.length - Math.min(limit, lane.length);
          return `<section class="sf-task-column lane" data-status="${e(status)}" aria-label="${e(status)}, ${lane.length} ${lane.length === 1 ? 'task' : 'tasks'}${reversed ? ', newest first' : ''}" ${(hideEmptyColumns || filtered()) && !lane.length ? 'data-empty-hidden hidden' : ''}><header class="sf-lane-head"><span class="status-dot" data-status="${e(statusKey(status))}"></span><h2>${e(status)}</h2>${reversed && lane.length > 1 ? '<span class="sf-lane-note">Newest first</span>' : ''}<span class="count">${lane.length}</span></header><div class="sf-task-stack">${
            lane.slice(0, limit).map(card).join('') || '<p class="column-empty">No tasks</p>'
          }${rest ? `<button type="button" class="sf-lane-more" data-lane-more="${e(status)}">Show ${Math.min(reversed ? LANE_STEP : LANE_LIMIT, rest)} more <span>· ${rest} not shown</span></button>` : ''}</div></section>`;
        })
        .join('')}</div></div>`;
    // A refresh replaces the control that opened a dialog; return focus to the same task.
    if (restoreFocusTo) {
      const active = globalThis.document?.activeElement;
      const target = [...container.querySelectorAll('[data-open]')].find(x => x.dataset.open === restoreFocusTo);
      if (target && (!active || active === document.body || !active.isConnected))
        target.focus({ preventScroll: false });
      ((restoreFocusTo = null), (laneLimit = {}));
    }
    const board = find('.sf-task-board');
    if (board) {
      board.scrollLeft = boardScroll;
      board.querySelectorAll('.sf-task-stack').forEach(stack => {
        stack.scrollTop = laneScroll[stack.closest('.sf-task-column').dataset.status] || 0;
      });
      boardEdges();
    }
  }
  // Fade the board edge that has more lanes beyond it, so horizontal overflow is visible.
  function boardEdges() {
    const board = find('.sf-task-board');
    const wrap = board?.parentElement;
    if (!wrap?.dataset) return;
    wrap.dataset.moreLeft = String(board.scrollLeft > 2);
    wrap.dataset.moreRight = String(board.scrollLeft + board.clientWidth < board.scrollWidth - 2);
  }
  async function refresh() {
    const current = ++generation;
    if (!lastLoaded && !tasks.length && !notice.textContent) {
      loadFeedback = 'Loading tasks…';
      notice.textContent = loadFeedback;
    }
    try {
      const response = await Promise.all([
        api(mode === 'drafts' ? '/drafts' : '/tasks'),
        api('/statuses'),
        api('/config'),
        api('/milestones'),
      ]);
      if (destroyed || current !== generation) return;
      const signature = JSON.stringify([response, canWrite()]);
      [tasks, statuses] = response;
      types = response[2].types || [];
      milestones = response[3];
      hideEmptyColumns = response[2].hideEmptyColumns === true;
      defaultStatus = response[2].defaultStatus || statuses[0];
      updateCount();
      if (notice.textContent === loadFeedback) notice.textContent = '';
      loadFeedback = '';
      if (dragging) return;
      if (signature !== lastLoaded) {
        lastLoaded = signature;
        filterControls();
        render();
      }
    } catch (error) {
      if (!destroyed && current === generation) {
        loadFeedback = `Unable to load ${mode}: ${error.message}. Use Refresh to retry.`;
        notice.textContent = loadFeedback;
      }
    }
  }
  // replace: reload the record into the sheet that is already open (after a save), keeping
  // its place in history, its opener and its width, and returning it to the reading view.
  async function openTask(id, { replace = false, flash = '' } = {}) {
    const current = ++editorGeneration;
    try {
      const task = mode === 'drafts' ? tasks.find(x => x.id === id) : await api(`/task/${encodeURIComponent(id)}`);
      if (destroyed || current !== editorGeneration) return;
      if (!task) throw new Error('Task is no longer available. Refresh the list.');
      const keptOpener = replace ? editor?.opener : null;
      closeEditor();
      if (replace && detailViews[id]?.editing)
        detailViews[id] = { ...detailViews[id], editing: false, scrollTop: 0, focusIndex: -1, identity: null };
      activeTaskId = id;
      editor = taskEditor({
        task,
        draft: mode === 'drafts',
        statuses,
        types,
        milestones,
        storageKey,
        api,
        canWrite,
        writeBlockedReason,
        saved: changed,
        navigate: route => openTask(route.task),
        closed: () => {
          restoreFocusTo = id;
          rememberEditor();
          editor = null;
          activeTaskId = null;
          onClose();
          // The opener may have been replaced by a refresh; fall back to the same task's card.
          setTimeout(() => {
            if (destroyed || !restoreFocusTo) return;
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) return;
            [...container.querySelectorAll('[data-open]')].find(x => x.dataset.open === id)?.focus();
            restoreFocusTo = null;
          }, 0);
        },
        tasks,
        viewState: detailViews[id],
        afterSave: (result, detail) => afterSave(id, result, detail),
        instant: replace,
        opener: keptOpener,
        flash,
        onOpenRecord: async target => {
          closeEditor();
          try {
            await onOpenRecord(target);
          } catch (error) {
            await openTask(id);
            notice.textContent = `Unable to open linked record: ${error.message}. Your task reading position and edits are retained.`;
          }
        },
      });
      if (mode === 'tasks' && !replace) onNavigate({ view: 'tasks', task: id });
    } catch (error) {
      if (!destroyed && current === editorGeneration) {
        notice.textContent = replace ? `Saved, but the task could not be reloaded: ${error.message}` : error.message;
        if (replace) {
          closeEditor();
          onClose();
        }
      }
    }
  }
  // A save keeps the sheet open: refresh the workset, then show the saved record for reading.
  async function afterSave(id, result, detail = {}) {
    if (destroyed) return;
    onChange();
    await refresh();
    if (destroyed) return;
    const target = id || result?.id;
    if (!target) {
      editorGeneration++;
      closeEditor();
      onClose();
      notice.textContent = 'Saved.';
      return;
    }
    await openTask(target, {
      replace: Boolean(id),
      flash: detail.status ? `Status changed to ${detail.status}.` : id ? 'Saved.' : 'Created.',
    });
  }
  function changed() {
    if (destroyed) return;
    onChange();
    refresh();
  }
  function showReview(title, content, confirmLabel, action) {
    review?.close();
    review = document.createElement('dialog');
    review.className = 'sf-task-review';
    const headingId = `${uid}-review-${Date.now()}`;
    review.setAttribute('aria-labelledby', headingId);
    const opener = document.activeElement;
    const active = review;
    active.innerHTML = `<div class="sf-review-head"><h2 id="${headingId}">${e(title)}</h2><button type="button" class="icon-button" data-close aria-label="Close">×</button></div><div class="sf-review-content">${content}</div><p class="sf-review-message" role="status"></p><div class="sf-review-foot"><button type="button" class="button quiet" data-close>Cancel</button>${action ? `<button type="button" class="button danger" data-confirm>${e(confirmLabel)}</button>` : ''}</div>`;
    document.body.append(active);
    active.showModal();
    active.querySelectorAll('[data-close]').forEach(x => (x.onclick = () => active.close()));
    active.addEventListener('close', () => {
      active.remove();
      if (opener?.isConnected) opener.focus();
    });
    if (action)
      active.querySelector('[data-confirm]').onclick = async () => {
        if (pending || locked()) {
          active.querySelector('.sf-review-message').textContent = pending
            ? 'A change is being saved. Please wait.'
            : blockedReason();
          return;
        }
        pending = true;
        active.querySelector('[data-confirm]').disabled = true;
        try {
          const response = await action();
          if (destroyed) return;
          active.close();
          changed();
          notice.textContent = response?.message || 'Change saved.';
        } catch (error) {
          if (!destroyed) {
            active.querySelector('.sf-review-message').textContent =
              error.outcome === 'unknown'
                ? `${error.message} Close this review and Refresh to inspect the saved records before retrying.`
                : error.message;
            if (error.outcome === 'unknown') active.dataset.uncertain = 'true';
          }
        } finally {
          pending = false;
          if (active.isConnected) active.querySelector('[data-confirm]').disabled = active.dataset.uncertain === 'true';
        }
      };
    return active;
  }
  function taskAction(id, action) {
    if (locked()) return;
    const task = tasks.find(x => x.id === id);
    if (!task) return;
    const title =
      action === 'promote'
        ? 'Promote draft to task'
        : action === 'complete'
          ? 'Move task to completed archive'
          : 'Archive task';
    showReview(
      title,
      `<p class="sf-review-subject"><span class="card-id">${e(task.id)}</span> ${e(task.title)}</p><p>${action === 'promote' ? 'The draft becomes a task with a new task ID.' : action === 'complete' ? 'The task file moves out of the active board. To change status only, edit the task instead.' : 'The task leaves the active board and is stored in the archive.'}</p>`,
      title,
      () =>
        api(
          action === 'promote'
            ? `/drafts/${encodeURIComponent(id)}/promote`
            : `/tasks/${encodeURIComponent(id)}${action === 'complete' ? '/complete' : ''}`,
          { method: action === 'archive' ? 'DELETE' : 'POST' },
        ),
    );
  }
  async function maintenance(kind) {
    const current = ++editorGeneration;
    try {
      if (kind === 'duplicates') {
        const plan = await api('/tasks/duplicates');
        if (destroyed || current !== editorGeneration) return;
        showReview(
          'Review duplicate task IDs',
          `<p>${plan.changes.length} files will receive a new ID. References need a separate review.</p><ul>${plan.changes.map(x => `<li>${e(x.oldId)} → ${e(x.newId)}: ${e(x.title)}<br><small>${e(x.sourcePath)} → ${e(x.targetPath)}</small></li>`).join('')}</ul><p>${e(plan.blockedReasons.join('\n'))}</p><details><summary>References and cross-branch findings</summary><pre>${e(JSON.stringify({ references: plan.references, crossBranchFindings: plan.crossBranchFindings }, null, 2))}</pre></details>`,
          'Apply reviewed ID repair',
          plan.repairable && plan.changes.length
            ? () => api('/tasks/duplicates', { method: 'POST', body: { fingerprint: plan.fingerprint } })
            : null,
        );
      } else {
        const chooser = showReview(
          'Review completed cleanup',
          '<p>Move Done tasks older than the chosen age to the completed archive. You review the list before anything moves.</p><div class="sf-review-row"><label>Minimum age in days<input type="number" min="0" value="30" data-age></label><button type="button" class="button quiet" data-preview>Preview eligible tasks</button></div>',
        );
        chooser.querySelector('[data-preview]').onclick = async () => {
          const age = Number(chooser.querySelector('[data-age]').value);
          if (!Number.isInteger(age) || age < 0) return;
          const button = chooser.querySelector('[data-preview]');
          button.disabled = true;
          try {
            const preview = await api(`/tasks/cleanup?age=${age}`);
            if (destroyed || !chooser.isConnected) return;
            showReview(
              'Confirm completed cleanup',
              `<p>${preview.count} Done tasks at least ${age} days old will move to the completed archive.</p><ul>${preview.tasks.map(x => `<li>${e(x.id)} — ${e(x.title)}</li>`).join('')}</ul><p>The age rule is applied when you confirm, so Done tasks that become eligible before then are included.</p>`,
              'Apply cleanup age rule',
              preview.count ? () => api('/tasks/cleanup/execute', { method: 'POST', body: { age } }) : null,
            );
          } catch (error) {
            chooser.querySelector('.sf-review-message').textContent = error.message;
          } finally {
            button.disabled = false;
          }
        };
      }
    } catch (error) {
      if (!destroyed) notice.textContent = error.message;
    }
  }
  function resetPosition() {
    boardScroll = 0;
    laneScroll = {};
    laneLimit = {};
    page = 1;
  }
  listen('input', event => {
    if (event.target.matches('[data-search]')) {
      filters.search = event.target.value;
      resetPosition();
      render();
    }
  });
  listen('change', event => {
    const key = event.target.dataset.filter;
    if (key) {
      filters[key] = event.target.value;
      resetPosition();
      render();
    }
    if (event.target.matches('[data-sort]')) {
      sort = event.target.value;
      render();
    }
    if (event.target.matches('[data-density]')) {
      density = event.target.value;
      render();
    }
  });
  listen('keydown', event => {
    if (event.key === 'Escape' && filtersOpen && event.target.closest?.('[data-filter-panel]')) {
      filtersOpen = false;
      renderFilterState();
      find('[data-filters]').focus();
    }
  });
  function openActions(id) {
    const task = tasks.find(x => x.id === id);
    if (!task) return;
    const actions = showReview(
      `Move ${id}`,
      `<p class="sf-review-subject">${e(task.title)}</p><div class="sf-move-grid"><label>Status<select data-move-status>${statuses.map(status => `<option ${status === task.status ? 'selected' : ''}>${e(status)}</option>`).join('')}</select></label><label>Position<select data-move-position><option value="top">Top</option><option value="bottom">Bottom</option><option value="before">Before task</option><option value="after">After task</option></select></label><label class="sf-move-reference">Reference task<select data-move-reference></select></label></div><button type="button" class="button primary" data-move>Move task</button><div class="sf-review-section"><h3>Archive</h3><p>These move the task file out of the active board.</p><div class="sf-review-actions"><button type="button" class="button quiet" data-complete>Move to completed archive</button><button type="button" class="button danger" data-archive>Archive task</button></div></div>`,
    );
    const destination = actions.querySelector('[data-move-status]'),
      reference = actions.querySelector('[data-move-reference]');
    const choices = () => {
      reference.innerHTML = tasks
        .filter(x => x.id !== id && x.status === destination.value)
        .sort((a, b) => ((a.ordinal || 0) - (b.ordinal || 0)) * (finishedLane(destination.value) ? -1 : 1))
        .map(x => `<option value="${e(x.id)}">${e(x.id)} · ${e(x.title)}</option>`)
        .join('');
    };
    destination.onchange = choices;
    choices();
    actions.querySelector('[data-move]').onclick = async () => {
      if (locked() || pending) return;
      pending = true;
      try {
        const position = actions.querySelector('[data-move-position]').value;
        if (['before', 'after'].includes(position) && !reference.value)
          throw new Error('Choose a reference task, or use Top or Bottom.');
        const body = moveTaskOrder(
          tasks,
          id,
          destination.value,
          reference.value,
          finishedLane(destination.value) ? flip[position] : position,
        );
        if (body) await api('/tasks/reorder', { method: 'POST', body });
        restoreFocusTo = id;
        actions.close();
        changed();
        notice.textContent = body ? 'Moved ' + id + ' to ' + body.targetStatus + '.' : 'Task position unchanged.';
      } catch (error) {
        actions.querySelector('.sf-review-message').textContent = error.message;
      } finally {
        pending = false;
      }
    };
    actions.querySelector('[data-complete]').onclick = () => taskAction(id, 'complete');
    actions.querySelector('[data-archive]').onclick = () => taskAction(id, 'archive');
  }
  const click = event => {
    const button = event.target.closest('button');
    if (!button) {
      const tableRow = event.target.closest('tr[data-row]');
      if (tableRow && !event.target.closest('a,input,select,textarea')) openTask(tableRow.dataset.row);
      return;
    }
    if (button.dataset.page) {
      page += button.dataset.page === 'next' ? 1 : -1;
      render();
      find('.sf-task-table-wrap')?.scrollTo?.({ top: 0 });
    }
    if (button.hasAttribute('data-refresh')) refresh();
    if (button.dataset.open) openTask(button.dataset.open);
    if (button.hasAttribute('data-create') && !locked()) {
      editorGeneration++;
      closeEditor();
      editor = taskEditor({
        task: { status: defaultStatus },
        draft: mode === 'drafts',
        statuses,
        types,
        milestones,
        storageKey,
        api,
        canWrite,
        writeBlockedReason,
        saved: changed,
        closed: onClose,
        afterSave: result => afterSave(null, result),
        tasks,
      });
    }
    if (button.dataset.layout) {
      layout = button.dataset.layout;
      page = 1;
      render();
    }
    if (button.hasAttribute('data-filters') || button.hasAttribute('data-filters-close')) {
      filtersOpen = button.hasAttribute('data-filters') ? !filtersOpen : false;
      renderFilterState();
      if (filtersOpen) find('[data-filter-panel] select')?.focus();
      else if (button.hasAttribute('data-filters-close')) find('[data-filters]').focus();
    }
    if (button.dataset.removeFilter) {
      filters[button.dataset.removeFilter] = '';
      resetPosition();
      filterControls();
      render();
      find('[data-filters]').focus();
    }
    if (button.hasAttribute('data-clear')) {
      resetPosition();
      Object.keys(filters).forEach(x => (filters[x] = ''));
      find('[data-search]').value = '';
      filterControls();
      render();
    }
    if (button.dataset.maintenance) {
      button.closest('details')?.removeAttribute('open');
      maintenance(button.dataset.maintenance);
    }
    if (button.dataset.action) taskAction(button.dataset.id, button.dataset.action);
    if (button.dataset.actions) openActions(button.dataset.actions);
    if (button.dataset.laneMore) {
      const status = button.dataset.laneMore,
        shownBefore = laneLimit[status] || (finishedLane(status) ? LANE_STEP : LANE_LIMIT);
      laneLimit[status] = shownBefore + (finishedLane(status) ? LANE_STEP : LANE_LIMIT);
      render();
      // Continue from the first newly shown card.
      const column = [...container.querySelectorAll('.sf-task-column')].find(x => x.dataset.status === status);
      column?.querySelectorAll('.sf-task-open')[shownBefore]?.focus();
    }
  };
  listen('click', click);
  const resized =
    globalThis.ResizeObserver && globalThis.Element && results instanceof Element
      ? new ResizeObserver(() => boardEdges())
      : null;
  resized?.observe(results);
  events.signal.addEventListener('abort', () => resized?.disconnect());
  globalThis.document?.addEventListener(
    'click',
    event => {
      for (const menu of container.querySelectorAll('.sf-menu[open]'))
        if (!menu.contains(event.target)) menu.removeAttribute('open');
    },
    { signal: events.signal },
  );
  const clearDrag = () => {
    dragging = null;
    container.querySelectorAll('[data-empty-hidden]').forEach(x => (x.hidden = true));
    container.querySelectorAll('[data-drop-position]').forEach(x => delete x.dataset.dropPosition);
    container.querySelectorAll('.sf-drop-column').forEach(x => x.classList.remove('sf-drop-column'));
    container.querySelectorAll('.is-dragging').forEach(x => x.classList.remove('is-dragging'));
  };
  listen('dragstart', event => {
    const card = event.target.closest('[draggable=true]');
    if (!card || locked()) {
      event.preventDefault();
      return;
    }
    dragging = card.dataset.id;
    event.dataTransfer.setData('text/plain', dragging);
    event.dataTransfer.effectAllowed = 'move';
    // Reveal hidden empty destinations after the browser has lifted the card.
    setTimeout(() => {
      if (!dragging) return;
      card.classList.add('is-dragging');
      container.querySelectorAll('[data-empty-hidden]').forEach(x => (x.hidden = false));
    }, 0);
  });
  listen('dragover', event => {
    const column = event.target.closest('.sf-task-column');
    if (!dragging || !column) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    container.querySelectorAll('[data-drop-position]').forEach(x => delete x.dataset.dropPosition);
    container.querySelectorAll('.sf-drop-column').forEach(x => x.classList.remove('sf-drop-column'));
    const card = event.target.closest('.sf-task-card');
    if (card && card.dataset.id !== dragging)
      card.dataset.dropPosition =
        event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2 ? 'before' : 'after';
    else if (!card) column.classList.add('sf-drop-column');
    const stack = column.querySelector('.sf-task-stack'),
      rect = stack.getBoundingClientRect();
    if (event.clientY < rect.top + 45) stack.scrollTop -= 14;
    else if (event.clientY > rect.bottom - 45) stack.scrollTop += 14;
    const board = column.closest('.sf-task-board'),
      bounds = board.getBoundingClientRect();
    if (event.clientX < bounds.left + 45) board.scrollLeft -= 14;
    else if (event.clientX > bounds.right - 45) board.scrollLeft += 14;
  });
  listen('dragend', clearDrag);
  listen('drop', async event => {
    const column = event.target.closest('.sf-task-column');
    if (!column || !dragging || locked() || pending) {
      clearDrag();
      return;
    }
    event.preventDefault();
    const id = dragging,
      card = event.target.closest('.sf-task-card'),
      position = card
        ? event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2
          ? 'before'
          : 'after'
        : 'bottom';
    const body = moveTaskOrder(
      tasks,
      id,
      column.dataset.status,
      card?.dataset.id,
      finishedLane(column.dataset.status) && card ? flip[position] : position,
    );
    clearDrag();
    if (!body) {
      notice.textContent = 'Task position unchanged.';
      return;
    }
    pending = true;
    try {
      await api('/tasks/reorder', { method: 'POST', body });
      changed();
      notice.textContent = `Moved ${id} to ${body.targetStatus}.`;
    } catch (error) {
      if (!destroyed) notice.textContent = error.message;
    } finally {
      pending = false;
    }
  });
  return {
    refresh,
    openTask,
    updateAccess,
    closeTask({ navigate = false } = {}) {
      editorGeneration++;
      closeEditor();
      if (navigate) onClose();
    },
    setMode(value) {
      lastLoaded = '';
      notice.textContent = '';
      loadFeedback = '';
      mode = value === 'drafts' ? 'drafts' : 'tasks';
      generation++;
      editorGeneration++;
      closeEditor();
      tasks = [];
      find('[data-title]').textContent = mode === 'drafts' ? 'Draft tasks' : 'Tasks';
      find('[data-create]').textContent = mode === 'drafts' ? 'Create draft' : 'Create task';
      find('[data-subtitle]').textContent =
        mode === 'drafts'
          ? 'Shape ideas here, then promote them into project work.'
          : 'Plan, assign and track work across your project.';
      refresh();
    },
    destroy() {
      destroyed = true;
      events.abort();
      generation++;
      editorGeneration++;
      closeEditor();
      review?.close();
      container.replaceChildren();
    },
  };
}
