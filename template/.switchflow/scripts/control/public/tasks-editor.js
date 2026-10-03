import {
  escapeHTML as e,
  checklistText,
  taskPayload,
  clearSavedDraft,
  taskBlockerText,
  ownerMarkup,
  avatarMarkup,
  statusKey,
  isoDay,
} from './tasks-model.js';
import { renderMarkdown, bindProseInteractions } from './documents.js';
import { captureTaskView, restoreTaskView } from './tasks-view-state.js';

const svg = path =>
  `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const icons = {
  edit: svg('<path d="M12.5 4.5l3 3L7 16H4v-3z"/>'),
  expand: svg('<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11.5 8.5M3.5 16.5l5-5"/>'),
  collapse: svg('<path d="M16.5 8H12V3.5M3.5 12H8v4.5M12 8l4.5-4.5M8 12l-4.5 4.5"/>'),
};
const fieldLabels = {
  title: 'Title',
  description: 'Description',
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  milestone: 'Milestone',
  assignee: 'Owners',
  labels: 'Labels',
  dependencies: 'Prerequisites',
  blockReason: 'Block reason',
  implementationPlan: 'Implementation plan',
  implementationNotes: 'Implementation notes',
  finalSummary: 'Final summary',
  references: 'References',
  modifiedFiles: 'Changed files',
  acceptanceCriteriaItems: 'Acceptance criteria',
};

export function taskEditor({
  task,
  draft,
  statuses,
  types,
  milestones,
  storageKey,
  api,
  canWrite,
  writeBlockedReason = () => '',
  saved,
  navigate = () => {},
  closed = () => {},
  tasks = [],
  viewState,
  onOpenRecord = async () => {},
  // When supplied, a successful save of an existing record hands over to the caller,
  // which reloads the record into a fresh reading view instead of closing the sheet.
  afterSave = null,
  instant = false,
  opener: givenOpener = null,
  flash = '',
}) {
  const dialog = document.createElement('dialog'),
    opener = givenOpener?.isConnected ? givenOpener : document.activeElement;
  dialog.setAttribute('aria-labelledby', 'sf-task-title');
  dialog.className = `sf-task-editor sheet${instant ? ' sf-sheet-instant' : ''}`;
  const key = `${storageKey}:${task.id || (draft ? 'new-draft' : 'new')}`;
  let original = structuredClone(task),
    busy = false,
    alive = true,
    conflict = false,
    editing = !task.id,
    suppressClose = false,
    commentCount = viewState?.commentCount || 10,
    activity = viewState?.activity === true,
    proseCleanup = () => {};
  const snapshot = () =>
    captureTaskView(dialog, document.activeElement, {
      editing,
      activity,
      commentCount,
      expanded: dialog.classList.contains('sheet-wide'),
    });
  function bindProse() {
    proseCleanup();
    proseCleanup = bindProseInteractions(dialog, {
      api,
      onOpenRecord,
      sourcePath: task.path || '',
      report: text => {
        if (alive) message.textContent = text;
      },
      isCurrent: () => alive,
    });
  }
  let baselineDoD = JSON.stringify(task.definitionOfDoneItems || []);
  const field = (name, label, value = '', area = false) =>
    `<label class="sf-field"><span class="sf-field-label">${label}</span>${area ? `<textarea name="${name}" data-grow="${area === true ? 'medium' : area}">${e(value)}</textarea>` : `<input name="${name}" value="${e(value)}">`}</label>`;
  const select = (name, label, value, options) =>
    `<label class="sf-field"><span class="sf-field-label">${label}</span><select name="${name}">${options
      .map(x => {
        const [v, t] = Array.isArray(x) ? x : [x, x];
        return `<option value="${e(v)}" ${v === value ? 'selected' : ''}>${e(t)}</option>`;
      })
      .join('')}</select></label>`;
  // Reading order: what it is, what done means, then summary before working logs.
  const narratives = [
    ['description', 'Description'],
    ['blockReason', 'Block reason'],
    ['finalSummary', 'Final summary'],
    ['implementationPlan', 'Implementation plan'],
    ['implementationNotes', 'Implementation notes'],
  ];
  const capital = value => (value ? String(value)[0].toUpperCase() + String(value).slice(1) : 'None');
  const commentTotal = (task.comments || []).length;
  const kind = draft ? 'draft task' : 'task';
  dialog.innerHTML = `<form class="sf-sheet"><header class="sf-sheet-head"><div class="sf-sheet-bar"><div class="sf-sheet-ident"><span class="card-id">${e(task.id || `New ${kind}`)}</span>${draft && task.id ? '<span class="chip">Draft</span>' : ''}${task.id ? `<span class="status-pill" data-status="${e(statusKey(task.status))}">${e(task.status || 'No status')}</span>` : ''}</div><div class="sf-sheet-actions"><button type="button" class="button quiet button-small" data-edit>${icons.edit}Edit</button><button type="button" class="icon-button" data-expand aria-pressed="false" aria-label="Expand" title="Expand">${icons.expand}</button><button type="button" class="icon-button" data-close aria-label="Close task" title="Close">×</button></div></div><h2 id="sf-task-title">${e(task.title || `New ${kind}`)}</h2><div class="segmented sf-task-detail-tabs" role="group" aria-label="Task content"><button type="button" data-task-tab="details" aria-pressed="true">Details</button><button type="button" data-task-tab="discussion" aria-pressed="false">Discussion <span class="count">${commentTotal}</span></button></div></header><div class="sf-sheet-body"><div class="sf-editor-message" role="status"></div><div class="sf-conflict" hidden></div><div class="sf-task-reading"></div><fieldset class="sf-task-writing"><legend class="sf-sr">Edit ${kind}</legend><div class="sf-detail-layout"><div class="sf-detail-main"><label class="sf-field sf-title-field"><span class="sf-field-label">Title</span><textarea required rows="1" name="title" data-grow="title" placeholder="Name the outcome">${e(task.title || '')}</textarea></label>${field('description', 'Description', task.description, 'long')}${narratives
    .slice(1)
    .map(
      ([name, label]) =>
        `<details class="sf-narrative" data-narrative="${name}" ${task[name] ? 'open' : ''}><summary><span class="sf-narrative-add">Add ${label.toLowerCase()}</span><span class="sf-narrative-label">${label}</span></summary><textarea name="${name}" aria-label="${label}" data-grow="${name === 'blockReason' ? 'short' : 'medium'}">${e(task[name] || '')}</textarea></details>`,
    )
    .join(
      '',
    )}<section class="sf-check-section"><h3>Acceptance criteria</h3><div class="sf-checklist" data-checklist="ac"></div><button type="button" class="sf-add-row" data-add-check="ac">+ Add criterion</button><textarea name="acceptanceCriteriaItems" hidden>${e(checklistText(task.acceptanceCriteriaItems))}</textarea></section><section class="sf-check-section"><h3>Definition of done</h3><p class="sf-hint">New or reworded items can be checked after saving.</p><div class="sf-checklist" data-checklist="dod"></div><button type="button" class="sf-add-row" data-add-check="dod">+ Add item</button><div data-dod-fields></div><textarea name="definitionOfDoneAdd" hidden></textarea></section></div><aside class="sf-detail-rail" aria-label="Edit properties"><section class="sf-rail-group"><h3>Properties</h3><div class="sf-form-grid">${select('status', 'Status', task.status || statuses[0], draft ? ['Draft'] : [...new Set([...statuses, task.status].filter(Boolean))])}${select(
    'priority',
    'Priority',
    task.priority || '',
    [...new Set(['', 'low', 'medium', 'high', task.priority].filter(x => x !== undefined))].map(x => [x, capital(x)]),
  )}${select(
    'type',
    'Type',
    task.type || '',
    [...new Set(['', ...types, task.type].filter(x => x !== undefined))].map(x => [x, capital(x)]),
  )}${select('milestone', 'Milestone', task.milestone || '', [['', 'No milestone'], ...milestones.map(x => [x.id, x.title || x.id]), ...(task.milestone && !milestones.some(x => x.id === task.milestone) ? [[task.milestone, task.milestone]] : [])])}${field('assignee', 'Owners', task.assignee?.join(', '))}${field('labels', 'Labels', task.labels?.join(', '))}</div><p class="sf-hint">Separate owners and labels with commas.</p></section><section class="sf-rail-group"><h3>Prerequisites</h3><input type="search" data-dependency-search aria-label="Find a prerequisite" placeholder="Search tasks by title or ID"><div class="sf-dependency-options" data-dependency-options></div>${field('dependencies', 'Prerequisite IDs', task.dependencies?.join(', '))}</section><section class="sf-rail-group"><h3>Links</h3>${field('references', 'References · one per line', task.references?.join('\n'), 'short')}${field('modifiedFiles', 'Changed files · one per line', task.modifiedFiles?.join('\n'), 'short')}</section></aside></div></fieldset><section class="sf-task-discussion" aria-label="Discussion">${task.id ? `<fieldset class="sf-comment-composer"><legend class="sf-sr">Add a comment</legend><textarea name="comment" aria-label="Comment" placeholder="Add a comment. Markdown is supported." data-grow="comment"></textarea><div class="sf-composer-foot"><label class="sf-inline-field"><span class="sf-sr">Your name</span><input name="commentAuthor" placeholder="Your name" autocomplete="name"></label><button type="button" class="button primary button-small" data-comment>Comment</button></div></fieldset>` : '<p class="sf-thread-empty">Save the task before adding comments.</p>'}<div class="sf-comments"></div><button type="button" class="button quiet button-small sf-older" data-older>Show older comments</button></section></div><footer class="sf-sheet-foot editor-bar"><span class="editor-state sf-editor-policy" role="status"></span><div class="editor-actions"><button type="button" class="button quiet" data-compare hidden>Compare</button><button type="button" class="button quiet" data-recover hidden>Recover discarded edits</button><button type="button" class="button quiet" data-discard>Discard</button><button type="button" class="button quiet" data-cancel>Cancel</button><button type="submit" class="button primary">${task.id ? 'Save changes' : `Create ${kind}`}</button></div></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'),
    message = dialog.querySelector('.sf-editor-message'),
    comparison = dialog.querySelector('.sf-conflict'),
    head = dialog.querySelector('.sf-sheet-head'),
    foot = dialog.querySelector('.sf-sheet-foot');
  const info = text => {
    message.textContent = text;
    message.dataset.info = 'true';
  };
  const writable = () => canWrite() && !['remote', 'local-branch', 'completed'].includes(task.source);
  const values = () =>
    Object.fromEntries(
      [...form.elements].filter(f => f.name && (f.type !== 'checkbox' || f.checked)).map(f => [f.name, f.value]),
    );
  // Text areas fit their content, up to most of the viewport, then scroll inside.
  function grow(area) {
    if (!area?.isConnected || area.hidden || !area.getClientRects().length) return;
    const top = dialog.scrollTop;
    area.style.height = 'auto';
    const border = area.offsetHeight - area.clientHeight,
      cap = Math.max(160, Math.round(window.innerHeight * 0.7)),
      wanted = area.scrollHeight + border;
    area.style.height = `${Math.min(cap, wanted)}px`;
    area.style.overflowY = wanted > cap ? 'auto' : 'hidden';
    dialog.scrollTop = top;
  }
  const growAll = () => form.querySelectorAll('textarea[data-grow]').forEach(grow);
  function openFilledNarratives() {
    for (const details of form.querySelectorAll('.sf-narrative'))
      if (details.querySelector('textarea').value.trim()) details.open = true;
  }
  function row(kind, text, checked, index) {
    const el = document.createElement('div');
    el.className = 'sf-check-row';
    el.dataset.index = index || '';
    el.innerHTML = `<input type="checkbox" aria-label="Complete criterion" ${checked ? 'checked' : ''}><input type="text" aria-label="Criterion text" placeholder="Describe the criterion" value="${e(text)}"><button type="button" class="sf-row-remove" aria-label="Remove criterion" title="Remove">×</button>`;
    const check = el.querySelector('[type=checkbox]');
    if (kind === 'dod' && !index) {
      check.disabled = true;
      check.title = 'Save this new item before completing it.';
    }
    el.querySelector('button').onclick = () => {
      el.classList.toggle('sf-check-removed');
      el.dataset.removed = String(el.dataset.removed !== 'true');
      const removed = el.dataset.removed === 'true',
        remove = el.querySelector('button');
      remove.textContent = removed ? 'Undo' : '×';
      remove.setAttribute('aria-label', removed ? 'Undo remove' : 'Remove criterion');
      remove.title = removed ? 'Keep this criterion' : 'Remove';
      syncChecks();
      stash();
    };
    form.querySelector(`[data-checklist=${kind}]`).append(el);
  }
  for (const item of task.acceptanceCriteriaItems || []) row('ac', item.text, item.checked, item.index);
  for (const item of task.definitionOfDoneItems || []) row('dod', item.text, item.checked, item.index);
  function syncChecks() {
    const rows = kind =>
      [...form.querySelectorAll(`[data-checklist=${kind}] .sf-check-row`)].filter(
        r => r.dataset.removed !== 'true' && r.querySelector('[type=text]').value.trim(),
      );
    form.elements.acceptanceCriteriaItems.value = rows('ac')
      .map(r => `[${r.querySelector('[type=checkbox]').checked ? 'x' : ' '}] ${r.querySelector('[type=text]').value}`)
      .join('\n');
    const kept = [],
      added = [];
    for (const r of rows('dod')) {
      const text = r.querySelector('[type=text]').value,
        check = r.querySelector('[type=checkbox]').checked,
        old = (task.definitionOfDoneItems || []).find(x => String(x.index) === r.dataset.index);
      if (old && old.text === text) {
        r.querySelector('[type=checkbox]').disabled = false;
        kept.push(
          `<input type="hidden" name="dodKeep${old.index}" value="on">${check ? `<input type="hidden" name="dodCheck${old.index}" value="on">` : ''}`,
        );
      } else {
        added.push(text);
        r.querySelector('[type=checkbox]').checked = false;
        r.querySelector('[type=checkbox]').disabled = true;
        r.querySelector('[type=checkbox]').title = 'Save edited text before completing this item.';
      }
    }
    form.querySelector('[data-dod-fields]').innerHTML = kept.join('');
    form.elements.definitionOfDoneAdd.value = added.join('\n');
  }
  syncChecks();
  const initialValues = values();
  const changed = () => JSON.stringify(values()) !== JSON.stringify(initialValues);
  function restore(snapshot) {
    for (const el of form.elements)
      if (el.name) {
        if (el.type === 'checkbox') el.checked = Boolean(snapshot[el.name]);
        else if (snapshot[el.name] !== undefined) el.value = snapshot[el.name];
      }
  }
  function restoreChecks(snapshot) {
    form.querySelector('[data-checklist=ac]').replaceChildren();
    for (const line of String(snapshot.acceptanceCriteriaItems || '')
      .split('\n')
      .filter(Boolean))
      row('ac', line.replace(/^\[[ x]\]\s*/i, ''), /^\[x\]/i.test(line));
    form.querySelector('[data-checklist=dod]').replaceChildren();
    for (const item of task.definitionOfDoneItems || []) {
      if (snapshot[`dodKeep${item.index}`])
        row('dod', item.text, Boolean(snapshot[`dodCheck${item.index}`]), item.index);
    }
    for (const text of String(snapshot.definitionOfDoneAdd || '')
      .split('\n')
      .filter(Boolean))
      row('dod', text, false);
    syncChecks();
  }
  const stash = () => {
    try {
      const snapshot = JSON.stringify({ values: values(), revision: original.revision, baselineDoD });
      sessionStorage.setItem(key, snapshot);
      if (message.dataset.info === 'true') {
        message.textContent = '';
        delete message.dataset.info;
      }
      if (alive) sync();
      return snapshot;
    } catch {
      message.textContent = 'Tab recovery is unavailable. Keep this editor open until saved.';
      delete message.dataset.info;
      return null;
    }
  };
  let local;
  try {
    local = JSON.parse(sessionStorage.getItem(key));
  } catch {}
  if (local?.values) {
    baselineDoD = local.baselineDoD || baselineDoD;
    restore(local.values);
    restoreChecks(local.values);
    openFilledNarratives();
    editing = true;
    if (task.id && local.revision && local.revision !== original.revision) {
      original.revision = local.revision;
      conflict = true;
    }
    info('Restored unsaved edits from this tab.');
  }
  function renderRead() {
    const section = (title, body, extra = '') =>
      `<section class="sf-read-section"${extra}><h3>${title}</h3>${body}</section>`;
    const property = (label, value) => (value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : '');
    const related = (id, title, status) =>
      `<button type="button" class="sf-related" data-related="${e(id)}"><span class="status-dot" data-status="${e(statusKey(status))}"></span><span class="sf-related-text"><span class="sf-related-title">${e(title || id)}</span><span class="sf-related-meta">${e(id)} · ${e(status || 'Status unavailable')}</span></span></button>`;
    const blockedBy = (task.dependencies || []).map(id => {
      const other = tasks.find(x => x.id === id);
      return related(id, other?.title, other?.status);
    });
    const blocks = tasks.filter(x => x.dependencies?.includes(task.id)).map(x => related(x.id, x.title, x.status));
    const milestone = milestones.find(x => x.id === task.milestone)?.title || task.milestone;
    const rail = `<aside class="sf-detail-rail sf-read-rail" aria-label="Task properties"><dl class="sf-read-properties">${[
      property(
        'Status',
        quickStatusAvailable()
          ? `<span class="sf-quick-status" data-status="${e(statusKey(task.status))}"><span class="status-dot" data-status="${e(statusKey(task.status))}"></span><select id="sf-quick-status" data-quick-status aria-label="Status">${[
              ...new Set([...statuses, task.status].filter(Boolean)),
            ]
              .map(x => `<option ${x === task.status ? 'selected' : ''}>${e(x)}</option>`)
              .join('')}</select></span>`
          : `<span class="status-pill" data-status="${e(statusKey(task.status))}">${e(task.status || 'No status')}</span>`,
      ),
      property('Owner', ownerMarkup(task.assignee)),
      property('Milestone', milestone ? e(milestone) : '<span class="sf-none">None</span>'),
      property(
        'Priority',
        task.priority
          ? `<span class="chip sf-priority" data-priority="${e(statusKey(task.priority))}">${e(task.priority)}</span>`
          : '',
      ),
      property('Type', e(task.type || '')),
      property(
        'Labels',
        (task.labels || []).length
          ? `<span class="sf-task-labels">${task.labels.map(label => `<span class="sf-label">${e(label)}</span>`).join('')}</span>`
          : '',
      ),
      property('Created', e(isoDay(task.createdDate))),
      property('Updated', e(isoDay(task.updatedDate))),
    ].join(
      '',
    )}</dl>${blockedBy.length ? section('Blocked by', `<div class="sf-related-list">${blockedBy.join('')}</div>`) : ''}${
      blocks.length ? section('Blocks', `<div class="sf-related-list">${blocks.join('')}</div>`) : ''
    }${[
      ['references', 'References'],
      ['modifiedFiles', 'Changed files'],
    ]
      .map(([name, label]) =>
        task[name]?.length
          ? section(label, `<ul class="sf-rail-list">${task[name].map(x => `<li>${e(x)}</li>`).join('')}</ul>`)
          : '',
      )
      .join('')}</aside>`;
    const blocker = taskBlockerText(task, tasks);
    const checklistSection = (name, label) => {
      const items = task[name] || [];
      if (!items.length) return '';
      const done = items.filter(x => x.checked).length;
      return section(
        `${label}<span class="sf-check-count">${done}/${items.length}</span>`,
        `<div class="progress sf-check-progress" aria-hidden="true"><span data-progress="${Math.round((100 * done) / items.length)}"></span></div><ul class="sf-read-checklist">${items.map(x => `<li class="${x.checked ? 'is-checked' : ''}"><span class="sf-check-box" aria-hidden="true"></span><span><span class="sf-sr">${x.checked ? 'Complete' : 'Not complete'}: </span>${e(x.text)}</span></li>`).join('')}</ul>`,
      );
    };
    const missing = narratives.slice(2).filter(([name]) => !task[name]);
    const main = `<div class="sf-detail-main sf-read-main">${
      blocker
        ? `<div class="sf-read-blocker" role="note"><span class="sf-read-blocker-label">Blocked</span><p>${e(blocker)}</p></div>`
        : ''
    }${
      task.description
        ? section('Description', `<div class="docs-prose">${renderMarkdown(task.description).html}</div>`)
        : section('Description', '<p class="sf-none">No description yet.</p>')
    }${checklistSection('acceptanceCriteriaItems', 'Acceptance criteria')}${checklistSection('definitionOfDoneItems', 'Definition of done')}${narratives
      .slice(2)
      .map(([name, label]) =>
        task[name] ? section(label, `<div class="docs-prose">${renderMarkdown(task[name]).html}</div>`) : '',
      )
      .join(
        '',
      )}<div class="sf-read-add">${missing.map(([name, label]) => `<button type="button" class="sf-add-row" data-add-content="${name}">+ ${label}</button>`).join('')}</div></div>`;
    const reading = form.querySelector('.sf-task-reading');
    const kept = reading.querySelector('.sf-quick-status')?.closest('dl > div');
    if (!kept) reading.innerHTML = `<div class="sf-detail-layout">${main}${rail}</div>`;
    else {
      // Keep the Status row node in place so focus and the reading position survive a quick status change.
      const next = document.createElement('div');
      next.innerHTML = `${main}${rail}`;
      const nextKept = next.querySelector('.sf-quick-status').closest('dl > div'),
        siblings = [...nextKept.parentElement.children],
        at = siblings.indexOf(nextKept),
        oldList = kept.parentElement,
        oldRail = oldList.closest('.sf-read-rail');
      reading.querySelector('.sf-read-main').replaceWith(next.querySelector('.sf-read-main'));
      for (const child of [...oldList.children]) if (child !== kept) child.remove();
      kept.before(...siblings.slice(0, at));
      kept.after(...siblings.slice(at + 1));
      for (const child of [...oldRail.children]) if (child !== oldList) child.remove();
      oldRail.append(...[...next.querySelector('.sf-read-rail').children].filter(child => child.tagName !== 'DL'));
      const status = statusKey(task.status);
      kept.querySelector('.sf-quick-status').dataset.status = status;
      kept.querySelector('.sf-quick-status .status-dot').dataset.status = status;
      const select = kept.querySelector('[data-quick-status]');
      if (select.value !== task.status) select.value = task.status;
    }
    // CSP forbids inline style attributes; size progress through the CSSOM.
    for (const bar of form.querySelectorAll('.sf-task-reading [data-progress]'))
      bar.style.width = `${bar.dataset.progress}%`;
  }
  function comments() {
    proseCleanup();
    const all = task.comments || [];
    const shown = Math.min(commentCount, all.length);
    form.querySelector('.sf-comments').innerHTML = all.length
      ? `<p class="sf-thread-meta">${shown === all.length ? `${all.length} ${all.length === 1 ? 'comment' : 'comments'}` : `Latest ${shown} of ${all.length} comments`} · newest first</p><ol class="sf-thread">${all
          .slice(-commentCount)
          .reverse()
          .map(
            c =>
              `<li class="sf-comment">${avatarMarkup(c.author || '?')}<div class="sf-comment-body"><div class="sf-comment-head"><strong>${e(c.author || 'Unattributed')}</strong><time datetime="${e(c.createdDate || '')}">${e(
                String(c.createdDate || '')
                  .replace('T', ' ')
                  .slice(0, 16),
              )}</time></div><div class="docs-prose">${renderMarkdown(c.body || '').html}</div></div></li>`,
          )
          .join('')}</ol>`
      : '<p class="sf-thread-empty">No comments yet.</p>';
    const older = form.querySelector('[data-older]');
    older.hidden = commentCount >= all.length;
    older.textContent = `Show older comments (${Math.max(0, all.length - commentCount)} more)`;
    bindProse();
  }
  function quickStatusAvailable() {
    return Boolean(task.id && !draft && !['remote', 'local-branch', 'completed'].includes(task.source));
  }
  // Status changes from the reading view save at once, against the revision this sheet loaded.
  async function quickStatus(select) {
    const next = select.value;
    if (next === task.status) return;
    if (busy || !writable() || !original.revision) {
      select.value = task.status;
      message.textContent = !canWrite()
        ? writeBlockedReason() || 'Editing is temporarily unavailable.'
        : busy
          ? 'A change is being saved. Please wait.'
          : !writable()
            ? 'This record is read-only.'
            : 'No revision available. Reload before changing status.';
      delete message.dataset.info;
      return;
    }
    busy = true;
    sync();
    info(`Moving to ${next}…`);
    try {
      const body = taskPayload({ ...initialValues, status: next }, original);
      const result = await api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PUT', body });
      if (!alive) return;
      let fresh = null;
      try {
        fresh = await api(`/task/${encodeURIComponent(task.id)}`);
      } catch {}
      if (!alive) return;
      if (!fresh?.revision && result?.revision) fresh = { ...task, ...result, status: next };
      busy = false;
      // Update this sheet in place: a rebuild would lose the reading position and move focus.
      if (fresh?.revision && fresh.id === task.id) {
        applySavedStatus(fresh);
        saved(result);
      } else if (afterSave) afterSave(result, { status: next });
      else {
        saved(result);
        dialog.close();
      }
    } catch (error) {
      if (!alive) return;
      select.value = task.status;
      delete message.dataset.info;
      message.textContent =
        error.status === 409
          ? 'This task changed since you opened it, so the status was not changed. Close and reopen it to load the latest record.'
          : error.outcome === 'unknown'
            ? 'Status change outcome unknown. Close and reopen the task to check the saved status before trying again.'
            : `${error.message}. The status was not changed.`;
    } finally {
      busy = false;
      if (alive) sync();
    }
  }
  function applySavedStatus(fresh) {
    const top = dialog.scrollTop;
    task = fresh;
    original = structuredClone(fresh);
    renderRead();
    dialog.scrollTop = top;
    const pill = head.querySelector('.sf-sheet-ident .status-pill');
    if (pill) {
      pill.textContent = fresh.status || 'No status';
      pill.dataset.status = statusKey(fresh.status);
    }
    // Edits kept in this tab must not put the old status back on their next save.
    if (form.elements.status && [...form.elements.status.options].some(option => option.value === fresh.status))
      form.elements.status.value = fresh.status;
    initialValues.status = fresh.status;
    try {
      if (sessionStorage.getItem(key)) stash();
    } catch {}
    info(`Status changed to ${fresh.status}.`);
  }
  function policy() {
    if (!canWrite())
      return `${writeBlockedReason() || 'Editing is temporarily unavailable.'} Your tab edits are retained.`;
    if (!writable()) return 'This record is read-only.';
    if (task.id && !original.revision) return 'No revision available. Reload before editing.';
    if (!editing) return '';
    if (busy) return 'Saving…';
    if (conflict) return 'The saved task changed. Compare before saving; your edits are kept in this tab.';
    return changed() ? 'Unsaved changes · kept in this tab until you save or discard.' : 'No changes yet.';
  }
  function sync() {
    form.querySelector('.sf-task-reading').hidden = editing || activity;
    form.querySelector('.sf-task-writing').hidden = !editing || activity;
    form.querySelector('.sf-task-discussion').hidden = !activity;
    form.querySelector('.sf-task-detail-tabs').hidden = !task.id;
    form
      .querySelectorAll('[data-task-tab]')
      .forEach(b => b.setAttribute('aria-pressed', String((b.dataset.taskTab === 'discussion') === activity)));
    form.querySelector('.sf-task-writing').disabled = busy || !writable();
    const composer = form.querySelector('.sf-comment-composer');
    if (composer) composer.disabled = busy || !writable() || conflict;
    for (const b of form.querySelectorAll('[data-close]')) b.disabled = busy;
    form.querySelector('[data-edit]').hidden = editing;
    form.querySelector('[data-edit]').disabled = !writable();
    form.querySelectorAll('[data-add-content]').forEach(b => (b.hidden = !writable()));
    // Discard appears once there is something to discard.
    form.querySelector('[data-discard]').hidden = !editing || !changed();
    form.querySelector('[data-cancel]').hidden = !editing;
    form.querySelector('[data-cancel]').disabled = busy;
    form.querySelector('[data-compare]').hidden =
      !editing || !conflict || !comparison.querySelector('[data-compare-pending]');
    const submit = form.querySelector('[type=submit]');
    submit.hidden = !editing;
    submit.disabled = busy || !writable() || conflict || Boolean(task.id && !original.revision);
    const quick = form.querySelector('[data-quick-status]');
    if (quick) {
      // Stays enabled while saving so focus survives the reload; quickStatus ignores changes while busy.
      quick.disabled = !writable() || !original.revision || editing;
      quick.title = !canWrite() ? writeBlockedReason() || 'Editing is temporarily unavailable.' : '';
    }
    const text = policy();
    const status = dialog.querySelector('.sf-editor-policy');
    if (status.textContent !== text) status.textContent = text;
    status.dataset.state = text.startsWith('Unsaved') ? 'dirty' : conflict || !canWrite() ? 'error' : '';
    foot.hidden = !editing && !text && form.querySelector('[data-recover]').hidden;
    dialog.style.setProperty('--sf-sheet-head', `${head.offsetHeight}px`);
  }
  function edit(focusName) {
    editing = true;
    activity = false;
    openFilledNarratives();
    if (focusName) {
      const details = form.querySelector(`[data-narrative="${focusName}"]`);
      if (details) details.open = true;
    }
    sync();
    requestAnimationFrame(() => {
      if (!alive) return;
      growAll();
      if (focusName) form.elements.namedItem(focusName)?.focus();
    });
  }
  async function showConflict() {
    conflict = true;
    sync();
    comparison.hidden = false;
    comparison.innerHTML =
      '<div class="sf-conflict-head" data-compare-pending><div><strong>This task changed since you opened it.</strong><p>Your edits are still here. Choose Compare to review them against the saved record.</p></div></div>';
    comparison.scrollIntoView?.({ block: 'nearest' });
    sync();
    form.querySelector('[data-compare]').onclick = async event => {
      event.target.disabled = true;
      try {
        const latest = draft
          ? (await api('/drafts')).find(x => x.id === task.id)
          : await api(`/task/${encodeURIComponent(task.id)}`);
        if (!alive) return;
        if (!latest?.revision) throw new Error('Latest record has no revision.');
        const mine = taskPayload(values(), original);
        const fields = Object.keys(fieldLabels);
        // Compare what a person reads: an empty list equals a missing field, checklist key order is irrelevant.
        const text = (name, value) =>
          String(
            Array.isArray(value)
              ? name === 'acceptanceCriteriaItems'
                ? checklistText(value)
                : value.join('\n')
              : (value ?? ''),
          );
        const show = (name, value) => e(text(name, value)) || '<span class="sf-none">Empty</span>';
        const differing = fields.filter(name => text(name, mine[name]) !== text(name, latest[name]));
        comparison.innerHTML =
          `<div class="sf-conflict-head"><div><strong>${differing.length ? `${differing.length} ${differing.length === 1 ? 'field differs' : 'fields differ'}` : 'No field differences'}</strong><p>Your version is kept unless you choose the saved value.</p></div></div>` +
          differing
            .map(
              name =>
                `<section class="sf-conflict-field"><h3>${e(fieldLabels[name])}</h3><div class="sf-conflict-fields"><div><span class="sf-conflict-side">Your edits</span><pre>${show(name, mine[name])}</pre></div><div><span class="sf-conflict-side">Saved record</span><pre>${show(name, latest[name])}</pre></div></div><button type="button" class="button quiet button-small" data-use-field="${name}">Use saved value</button></section>`,
            )
            .join('') +
          '<div class="sf-conflict-actions"><button type="button" class="button primary" data-rebase>Keep my reviewed edits</button></div>';
        comparison.querySelectorAll('[data-use-field]').forEach(
          button =>
            (button.onclick = () => {
              const name = button.dataset.useField,
                value = latest[name];
              form.elements.namedItem(name).value = Array.isArray(value)
                ? name === 'acceptanceCriteriaItems'
                  ? checklistText(value)
                  : value.join(['references', 'modifiedFiles'].includes(name) ? '\n' : ', ')
                : value || '';
              if (name === 'acceptanceCriteriaItems') restoreChecks(values());
              button.textContent = 'Saved value selected';
              stash();
              growAll();
            }),
        );
        if (values().comment?.trim()) {
          comparison.insertAdjacentHTML(
            'beforeend',
            `<section class="sf-conflict-field"><h3>Saved comments</h3>${(latest.comments || [])
              .slice(-10)
              .map(c => `<p>${e(c.body)}</p>`)
              .join(
                '',
              )}<p>Check whether your comment was already saved before appending it again.</p><button type="button" class="button quiet button-small" data-comment-saved>My comment is already saved; clear the composer</button></section>`,
          );
          comparison.querySelector('[data-comment-saved]').onclick = () => {
            form.elements.comment.value = '';
            stash();
          };
        }
        const rebase = comparison.querySelector('[data-rebase]');
        if (JSON.stringify(latest.definitionOfDoneItems || []) !== baselineDoD) {
          rebase.disabled = true;
          comparison.insertAdjacentHTML(
            'beforeend',
            '<p class="sf-conflict-note">Definition of done changed. Close and reopen after preserving your edits; checklist positions cannot be safely rebased.</p>',
          );
        }
        rebase.onclick = () => {
          original = { ...latest, definitionOfDoneItems: task.definitionOfDoneItems };
          conflict = false;
          comparison.hidden = true;
          stash();
          sync();
        };
        sync();
      } catch (error) {
        message.textContent = error.message;
        delete message.dataset.info;
        event.target.disabled = false;
      }
    };
  }
  async function save() {
    if (busy || !writable() || conflict || (task.id && !original.revision)) return;
    if (!form.checkValidity()) {
      edit();
      const invalid = form.querySelector('input:invalid,textarea:invalid,select:invalid');
      for (let parent = invalid?.parentElement; parent && parent !== form; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      invalid?.focus();
      form.reportValidity();
      message.textContent = 'Complete the required task fields before saving. Your comment and edits are retained.';
      delete message.dataset.info;
      return;
    }
    busy = true;
    const submitted = values(),
      snapshot = stash();
    sync();
    try {
      const body = taskPayload(submitted, original);
      if (draft) body.status = 'Draft';
      const result = await api(task.id ? `/tasks/${encodeURIComponent(task.id)}` : '/tasks', {
        method: task.id ? 'PUT' : 'POST',
        body,
      });
      try {
        clearSavedDraft(sessionStorage, key, snapshot);
      } catch {}
      if (!alive) return;
      busy = false;
      if (afterSave) afterSave(result);
      else {
        saved(result);
        dialog.close();
      }
    } catch (error) {
      if (alive) {
        delete message.dataset.info;
        message.textContent = `${error.message}. Your edits are retained.`;
        if ((error.status === 409 || error.outcome === 'unknown') && task.id) {
          // The conflict panel and the editor bar carry this state; avoid a second banner.
          if (error.status === 409) message.textContent = '';
          showConflict();
          if (error.outcome === 'unknown')
            message.textContent =
              'Save outcome unknown. Compare the latest record before saving again; your edits are retained.';
        } else if (error.outcome === 'unknown') {
          conflict = true;
          message.textContent =
            'Creation outcome unknown. Close and refresh Draft tasks or Tasks to locate the saved record before creating again. Your tab edits are retained.';
        }
      }
    } finally {
      busy = false;
      if (alive) sync();
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    save();
  });
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.name === 'title') event.preventDefault();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (editing || event.target.name === 'comment')) {
      event.preventDefault();
      if (event.target.name === 'comment' && !form.elements.comment.value.trim()) return;
      save();
    }
  });
  form.addEventListener('change', event => {
    if (event.target.matches('[data-quick-status]')) quickStatus(event.target);
  });
  form.addEventListener('input', event => {
    if (event.target.matches('[data-quick-status]')) return;
    if (event.target.name === 'title' && /\n/.test(event.target.value))
      event.target.value = event.target.value.replace(/\s*\n\s*/g, ' ');
    if (event.target.matches('textarea[data-grow]')) grow(event.target);
    if (event.target.closest('[data-checklist]')) syncChecks();
    if (event.target.matches('[data-dependency-search]')) {
      const q = event.target.value.trim().toLowerCase();
      const matches = q ? tasks.filter(x => x.id !== task.id && `${x.id} ${x.title}`.toLowerCase().includes(q)) : [];
      form.querySelector('[data-dependency-options]').innerHTML = q
        ? `<p class="sf-hint">${matches.length > 20 ? `First 20 of ${matches.length} matches` : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}</p>${matches
            .slice(0, 20)
            .map(
              x =>
                `<button type="button" class="sf-related" data-dependency="${e(x.id)}"><span class="status-dot" data-status="${e(statusKey(x.status))}"></span><span class="sf-related-text"><span class="sf-related-title">${e(x.title)}</span><span class="sf-related-meta">${e(x.id)} · ${e(x.status)}</span></span></button>`,
            )
            .join('')}`
        : '';
      return;
    }
    stash();
  });
  form.addEventListener(
    'toggle',
    event => {
      if (event.target.matches?.('.sf-narrative') && event.target.open)
        requestAnimationFrame(() => grow(event.target.querySelector('textarea')));
    },
    true,
  );
  form.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.taskTab) {
      activity = b.dataset.taskTab === 'discussion';
      sync();
      dialog.scrollTop = 0;
      requestAnimationFrame(() => alive && growAll());
    }
    if (b.hasAttribute('data-edit')) edit();
    if (b.dataset.addContent) edit(b.dataset.addContent);
    if (b.hasAttribute('data-close') && !busy) dialog.close();
    // Cancel leaves edit mode without discarding: edits stay in this tab and return with Edit.
    if (b.hasAttribute('data-cancel') && !busy) {
      if (!task.id) dialog.close();
      else {
        editing = false;
        if (JSON.stringify(values()) !== JSON.stringify(initialValues))
          info('Your unsaved edits are kept in this tab. Choose Edit to continue them.');
        sync();
        dialog.scrollTop = 0;
        form.querySelector('[data-edit]').focus();
      }
    }
    if (b.hasAttribute('data-expand')) setExpanded(!dialog.classList.contains('sheet-wide'));
    if (b.dataset.addCheck) {
      row(b.dataset.addCheck, '', false);
      form.querySelector(`[data-checklist=${b.dataset.addCheck}] .sf-check-row:last-child [type=text]`).focus();
    }
    if (b.dataset.dependency) {
      const field = form.elements.dependencies;
      field.value = [
        ...new Set([
          ...field.value
            .split(',')
            .map(x => x.trim())
            .filter(Boolean),
          b.dataset.dependency,
        ]),
      ].join(', ');
      stash();
      b.classList.add('is-added');
      b.querySelector('.sf-related-meta').textContent += ' · Added';
    }
    if (b.dataset.related) navigate({ view: 'tasks', task: b.dataset.related });
    if (b.hasAttribute('data-older')) {
      commentCount += 10;
      comments();
    }
    if (b.hasAttribute('data-comment')) {
      if (!form.elements.comment.value.trim() && !editing) {
        message.textContent = 'Write a comment first.';
        message.dataset.info = 'true';
        form.elements.comment.focus();
      } else save();
    }
    if (b.hasAttribute('data-discard') && !busy) {
      try {
        sessionStorage.setItem(
          `${key}:discarded`,
          JSON.stringify({ values: values(), revision: original.revision, baselineDoD }),
        );
        sessionStorage.removeItem(key);
      } catch {}
      restore(initialValues);
      restoreChecks(initialValues);
      original = structuredClone(task);
      conflict = false;
      comparison.hidden = true;
      editing = !task.id;
      form.querySelector('[data-recover]').hidden = false;
      info('Edits discarded. Recover them from the footer while this tab stays open.');
      sync();
      if (editing) requestAnimationFrame(() => alive && growAll());
    }
    if (b.hasAttribute('data-recover')) {
      try {
        const discarded = JSON.parse(sessionStorage.getItem(`${key}:discarded`));
        if (discarded) {
          restore(discarded.values);
          restoreChecks(discarded.values);
          original.revision = discarded.revision;
          editing = true;
          stash();
          if (task.id && discarded.revision !== task.revision) showConflict();
          edit();
        }
      } catch {
        message.textContent = 'No discarded edits available.';
      }
    }
  });
  function setExpanded(expanded) {
    dialog.classList.toggle('sheet-wide', expanded);
    const expand = form.querySelector('[data-expand]');
    expand.setAttribute('aria-pressed', String(expanded));
    expand.setAttribute('aria-label', expanded ? 'Collapse' : 'Expand');
    expand.title = expanded ? 'Collapse' : 'Expand';
    expand.innerHTML = expanded ? icons.collapse : icons.expand;
    requestAnimationFrame(() => alive && growAll());
  }
  // A click on the backdrop (outside the sheet) closes it, like Escape.
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || busy) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
      dialog.close();
  });
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  const timer = setInterval(sync, 1000);
  dialog.addEventListener('close', () => {
    if (!suppressClose) closed();
    alive = false;
    proseCleanup();
    clearInterval(timer);
    dialog.remove();
    if (!suppressClose && opener?.isConnected) opener.focus();
  });
  renderRead();
  comments();
  try {
    form.querySelector('[data-recover]').hidden = !sessionStorage.getItem(`${key}:discarded`);
  } catch {} // A reading-position snapshot must not resurrect edit mode after Save or Discard cleared the draft.
  if (viewState?.editing !== undefined) editing = !task.id || (Boolean(local?.values) && viewState.editing);
  sync();
  dialog.showModal();
  if (editing) edit();
  if (viewState) {
    activity = viewState.activity === true;
    setExpanded(viewState.expanded === true);
    sync();
    requestAnimationFrame(() => {
      if (!alive) return;
      growAll();
      restoreTaskView(dialog, viewState);
    });
  }
  if (conflict) showConflict();
  else if (flash) info(flash);
  return {
    snapshot,
    opener,
    updateAccess: sync,
    destroy: () => {
      if (alive) {
        suppressClose = true;
        alive = false;
        proseCleanup();
        clearInterval(timer);
        dialog.close();
      }
    },
  };
}
