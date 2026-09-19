const $ = (selector, root = document) => root.querySelector(selector);
const stages = [
  ['intake', 'Intake', 'Human checkpoint 01'],
  ['planning', 'Planning', 'Human checkpoint 02'],
  ['delivery', 'Delivery', 'Agents at work'],
  ['uat', 'UAT', 'Human checkpoint 03'],
  ['complete', 'Complete', 'Accepted outcomes'],
];
const labels = { 'awaiting-human': 'Your review', running: 'Agent working', idle: 'Ready', blocked: 'Needs attention', failed: 'Run failed', cancelled: 'Cancelled', complete: 'Accepted' };
let state = null;
let selectedId = null;
let displayedRevision = null;
let displayedActivity = null;
let busy = false;
let refreshing = false;
let returnFocus = null;
let recognition = null;
const drafts = new Map();
const taskDrafts = new Map();
const uatGenerations = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function button(label, action, kind = 'quiet') {
  const node = el('button', `button ${kind}`, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function showError(message, target = $('#error-banner')) {
  target.textContent = message || '';
  target.hidden = !message;
}
function notice(message) {
  $('#notice-banner').textContent = message;
  $('#notice-banner').hidden = !message;
}
function readable(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return value.summary || value.message || value.title || value.text || '';
  return String(value);
}
function safeLink(value) {
  if (!value) return null;
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function renderValue(value, depth = 0) {
  if (value === null || value === undefined || value === '') return el('p', 'muted', 'Not available yet.');
  if (depth > 5) return el('p', 'prose', JSON.stringify(value));
  if (Array.isArray(value)) {
    const list = el('ul', 'data-list');
    for (const item of value) { const li = el('li'); li.append(renderValue(item, depth + 1)); list.append(li); }
    return list;
  }
  if (typeof value === 'object') {
    const list = el('dl', 'data-fields');
    for (const [key, item] of Object.entries(value)) {
      list.append(el('dt', '', key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')));
      const dd = el('dd'); dd.append(renderValue(item, depth + 1)); list.append(dd);
    }
    return list;
  }
  return el('p', 'prose', value);
}
function section(title, content) {
  const node = el('section', 'detail-section'); node.append(el('h3', '', title));
  node.append(content instanceof Node ? content : renderValue(content)); return node;
}
function detail(title, content) {
  const node = el('details'); node.append(el('summary', '', title)); const body = el('div'); body.append(content); node.append(body); return node;
}
function current() { return state?.initiatives?.find(item => item.id === selectedId); }
function activityKey(item) {
  return JSON.stringify({ events: item.events, runs: item.runs, activeRun: state?.activeRun?.initiativeId === item.id ? state.activeRun : null });
}
function isRunning(item) { return item.status === 'running' || item.pending === true || state?.activeRun?.initiativeId === item.id; }
function statusSummary(item) {
  if (!isRunning(item)) return readable(item.summary) || item.request;
  const run = state?.activeRun?.initiativeId === item.id ? state.activeRun : item.runs?.at(-1);
  const progress = !item.pending && run?.startedAt && item.events?.findLast(entry => entry.type === 'progress' && entry.at >= run.startedAt);
  return readable(progress?.message) || (item.pending ? 'Waiting for the next available agent.' : 'The agent is preparing this stage.');
}
function nextAction(item) {
  if (item.nextAction) return readable(item.nextAction);
  if (isRunning(item)) return 'Agent working. Open to follow progress.';
  if (['failed', 'blocked'].includes(item.status)) return 'Review what needs attention';
  if (item.status === 'cancelled') return 'Review and retry when ready';
  return { intake: 'Review the scope', planning: 'Review the delivery plan', delivery: 'Follow agent delivery', uat: 'Try the result and record your checks', complete: 'View the accepted outcome' }[item.stage] || 'View initiative';
}
async function request(path, data, method = 'POST') {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': state?.csrfToken || '' }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = readable(result.error) || result.message || `Request failed (${response.status}).`;
    const error = new Error(response.status === 409 ? 'The project changed while you were reviewing it. The latest state has loaded; your draft is preserved. Review it before trying again.' : message);
    error.status = response.status;
    throw error;
  }
  return result;
}
function remember(field, value) {
  if (!selectedId) return;
  if (!drafts.has(selectedId)) drafts.set(selectedId, {});
  drafts.get(selectedId)[field] = value;
}
function inputField(id, labelText, initial = '', type = 'textarea') {
  const label = el('label', '', labelText);
  const input = el(type); input.id = id; input.name = id;
  input.value = drafts.get(selectedId)?.[id] ?? initial;
  if (type === 'textarea') input.rows = 3;
  input.addEventListener('input', () => remember(id, input.value));
  label.append(input); return { label, input };
}
async function act(action, payload = {}) {
  const item = current(); if (!item || busy) return;
  const errorTarget = $('#detail-error');
  showError('', errorTarget);
  busy = true; setBusy();
  try {
    await request(`/api/initiatives/${encodeURIComponent(item.id)}/actions`, { action, expectedRevision: displayedRevision, ...payload });
    if (action === 'answer') for (const key of Object.keys(drafts.get(item.id) || {})) { if (key.startsWith('answer-')) delete drafts.get(item.id)[key]; }
    if (action === 'update') delete drafts.get(item.id)?.['project-update'];
    if (action === 'scope-change') delete drafts.get(item.id)?.['scope-change'];
    if (action === 'request-rework') delete drafts.get(item.id)?.['rework-feedback'];
    if (['scope-change', 'request-rework'].includes(action)) clearUatDraft(item.id);
    await refresh(true);
    $('#live-status').textContent = 'Project action saved. The board is up to date.';
  } catch (error) {
    if (error.status === 409) await refresh(true);
    showError(error.message, $('#detail-error') || $('#error-banner'));
  } finally { busy = false; setBusy(); }
}
function setBusy() {
  for (const node of document.querySelectorAll('#detail-content button[data-action], #create-submit')) node.disabled = busy;
}
function actionButton(label, action, payload, kind = 'primary') {
  const node = button(label, () => act(action, typeof payload === 'function' ? payload() : payload), kind); node.dataset.action = action; return node;
}
function renderBoard() {
  const board = $('#board'); const query = $('#filter').value.trim().toLowerCase();
  const all = state?.initiatives || [];
  const items = all.filter(item => `${item.title} ${item.request} ${item.summary || ''}`.toLowerCase().includes(query));
  // Preserve focus across polling updates; cards have stable identifiers.
  const focusedId = document.activeElement?.dataset?.initiativeId;
  board.replaceChildren(); board.setAttribute('aria-busy', 'false');
  for (const [stage, title, subtitle] of stages) {
    const column = el('section', 'column'); column.dataset.stage = stage; column.setAttribute('aria-label', title);
    const heading = el('div', 'column-heading'); const label = el('h3', 'column-label'); label.append(el('span', 'column-dot'), document.createTextNode(title));
    const members = items.filter(item => item.stage === stage);
    heading.append(label, el('span', 'count', members.length)); column.append(heading, el('p', 'column-subtitle', subtitle));
    const list = el('div', 'card-list');
    for (const item of members) {
      const card = el('button', 'initiative-card'); card.type = 'button'; card.dataset.initiativeId = item.id;
      card.setAttribute('aria-label', `${item.title}. ${labels[item.status] || item.status}. ${nextAction(item)}`);
      const meta = el('div', 'card-meta'); meta.append(el('span', `badge ${item.status}`, item.pending ? 'Queued' : labels[item.status] || item.status));
      const next = el('div', 'card-next'); next.append(el('span', '', nextAction(item)), el('span', 'arrow', '↗'));
      card.append(meta, el('h4', 'card-title', item.title), el('p', 'card-summary', statusSummary(item)), next);
      card.addEventListener('click', () => openDetail(item.id, card)); list.append(card);
    }
    if (!members.length) list.append(el('div', 'column-empty', query ? 'No matching initiatives' : 'No initiatives here yet'));
    column.append(list); board.append(column);
  }
  if (focusedId) [...board.querySelectorAll('button')].find(node => node.dataset.initiativeId === focusedId)?.focus({ preventScroll: true });
  $('#board-count').textContent = `${all.length} initiative${all.length === 1 ? '' : 's'} · ${all.filter(item => ['awaiting-human', 'failed', 'blocked', 'cancelled'].includes(item.status)).length} need your attention`;
  $('#empty-state').hidden = all.length > 0 || !!query;
  const active = all.find(item => isRunning(item));
  $('#activity-title').textContent = active ? 'Agent working' : 'Agent activity';
  $('#activity-summary').textContent = active ? `${active.title} · ${statusSummary(active)}` : all.length ? 'No agent run is active. Your next decision is shown on each card.' : 'Ready for your first initiative.';
  renderTaskBoard();
}
function renderQuestions(item, body) {
  if (!item.questions?.length) return;
  const form = el('form');
  for (const question of item.questions) {
    const { label, input } = inputField(`answer-${question.id}`, question.prompt, question.answer || '');
    input.required = true; form.append(label);
  }
  const actions = el('div', 'detail-actions'); const submit = el('button', 'button primary', 'Send answers →'); submit.type = 'submit'; submit.dataset.action = 'answer'; actions.append(submit); form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const answers = Object.fromEntries(item.questions.map(question => [question.id, form.elements.namedItem(`answer-${question.id}`).value.trim()]));
    if (Object.values(answers).some(answer => !answer)) { showError('Please answer each question before continuing.', $('#detail-error')); return; }
    act('answer', { answers });
  });
  body.append(section('Decisions the agent needs from you', form));
}
function renderPlan(plan) {
  if (!Array.isArray(plan)) return renderValue(plan);
  const list = el('div');
  for (const [index, entry] of plan.entries()) {
    if (typeof entry === 'string') { list.append(section(`Step ${index + 1}`, entry)); continue; }
    const block = section(entry.outcome || entry.title || `Phase ${entry.phase ?? index + 1}`, entry.task || entry.description || '');
    if (entry.evidence) block.append(el('p', 'muted', `How it will be checked: ${readable(entry.evidence) || JSON.stringify(entry.evidence)}`));
    list.append(block);
  }
  return list;
}
function clearUatDraft(id) {
  for (const key of Object.keys(drafts.get(id) || {})) if (key.startsWith('uat-status-') || key.startsWith('uat-notes-')) delete drafts.get(id)[key];
  uatGenerations.delete(id);
}
function appendWalkthroughText(node, text) {
  const pattern = /https?:\/\/[^\s<>()]+/gi; let match; let cursor = 0;
  while ((match = pattern.exec(text))) {
    const reference = match[0].replace(/[.,;:!?]+$/, ''); node.append(document.createTextNode(text.slice(cursor, match.index)));
    if (safeLink(reference)) { const link = el('a', '', reference); link.href = safeLink(reference); link.target = '_blank'; link.rel = 'noopener noreferrer'; node.append(link); }
    else node.append(document.createTextNode(reference));
    node.append(document.createTextNode(match[0].slice(reference.length))); cursor = pattern.lastIndex;
  }
  node.append(document.createTextNode(text.slice(cursor)));
}
function uatInstruction(item, check, ordinal) {
  const heading = el('h4'); heading.append(document.createTextNode(`${ordinal}. `));
  const text = check.title || check.text || check.id;
  const expression = /\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g;
  let match; let cursor = 0; let referenceIndex = 0;
  while ((match = expression.exec(text))) {
    appendWalkthroughText(heading, text.slice(cursor, match.index));
    const [literal, label, reference] = match; const index = referenceIndex++;
    if (/^https?:\/\//i.test(reference) && safeLink(reference)) {
      const link = el('a', '', label); link.href = safeLink(reference); link.target = '_blank'; link.rel = 'noopener noreferrer'; heading.append(link);
    } else if (/^(?:[a-zA-Z]:[\\/]|\/)/.test(reference)) {
      const preview = button(`Preview ${label}`, () => openArtifact(item.id, check.id, index, preview)); preview.classList.add('artifact-preview-button'); preview.title = reference; heading.append(preview);
    } else heading.append(document.createTextNode(literal));
    cursor = expression.lastIndex;
  }
  appendWalkthroughText(heading, text.slice(cursor)); return heading;
}
async function openArtifact(initiativeId, stepId, index, trigger) {
  const dialog = el('dialog', 'detail-dialog artifact-dialog'); dialog.setAttribute('aria-label', 'Committed artifact preview');
  const header = el('div', 'detail-header dialog-heading'); header.append(el('h2', '', 'Committed artifact'));
  const close = button('×', () => dialog.close()); close.className = 'icon-button'; close.setAttribute('aria-label', 'Close artifact preview'); header.append(close);
  const body = el('div', 'detail-body'); body.append(el('p', 'muted', 'Reading the registered committed file…')); dialog.append(header, body); document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); (trigger.isConnected ? trigger : $('#detail-close'))?.focus({ preventScroll: true }); }); dialog.showModal();
  try {
    const query = new URLSearchParams({ stepId, index: String(index) });
    const response = await fetch(`/api/initiatives/${encodeURIComponent(initiativeId)}/artifacts?${query}`, { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json(); if (!response.ok) throw new Error(readable(result.error) || 'Artifact preview is unavailable.');
    body.replaceChildren(el('p', 'gate-note', 'This is the file recorded in the delivered commit. Unsaved working files are not included.'));
    body.append(el('h3', '', result.path), el('p', 'artifact-head', `Commit ${result.head}`));
    const content = el('pre', 'artifact-content', result.content); content.tabIndex = 0; content.setAttribute('aria-label', 'Committed file contents'); body.append(content);
  } catch (error) { const message = el('p', 'inline-error', error.message); message.setAttribute('role', 'alert'); body.replaceChildren(message); }
}
function renderUat(item, body) {
  const form = el('form'); const checks = Array.isArray(item.uat) ? item.uat : [];
  const normalized = checks.map((entry, index) => typeof entry === 'string' ? { id: `uat-${index + 1}`, title: entry, status: 'pending' } : entry);
  const generation = JSON.stringify(normalized.map(check => [check.id, check.title, check.text]));
  if (uatGenerations.has(item.id) && uatGenerations.get(item.id) !== generation) clearUatDraft(item.id);
  uatGenerations.set(item.id, generation);
  if (!normalized.length) { body.append(section('Acceptance checks', 'No guided checks are available yet. Request a delivery update before accepting.')); return; }
  form.append(el('p', 'gate-note', 'Try each step in the delivered product. Record what you observe; agent test results alone do not count as your acceptance.'));
  normalized.forEach((check, index) => {
    const block = el('div', 'uat-step'); block.append(uatInstruction(item, check, index + 1));
    if (check.instructions || check.expected) block.append(renderValue(check.instructions || check.expected));
    const label = el('label', '', 'Your result'); const select = el('select'); select.name = `uat-status-${check.id}`;
    for (const [value, text] of [['pending', 'Not checked yet'], ['passed', 'Passed'], ['failed', 'Needs rework']]) { const option = el('option', '', text); option.value = value; select.append(option); }
    select.value = drafts.get(item.id)?.[select.name] ?? check.status ?? 'pending';
    select.addEventListener('change', () => remember(select.name, select.value)); label.append(select); block.append(label);
    const notes = inputField(`uat-notes-${check.id}`, 'Notes (optional)', check.notes || ''); block.append(notes.label); form.append(block);
  });
  const submit = el('button', 'button primary', 'Accept delivered outcome'); submit.type = 'submit'; submit.dataset.action = 'accept-uat'; form.append(submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const results = normalized.map(check => ({ id: check.id, status: form.elements.namedItem(`uat-status-${check.id}`).value, notes: form.elements.namedItem(`uat-notes-${check.id}`).value.trim() }));
    if (results.some(result => result.status !== 'passed')) { showError('Mark every acceptance check as passed, or describe the changes needed below and request rework.', $('#detail-error')); $('#detail-error').scrollIntoView({ block: 'nearest' }); return; }
    act('accept-uat', { results });
  });
  body.append(section('Your guided acceptance checks', form));
}
function renderInputAction(title, id, label, action, payloadKey, help, kind = 'quiet') {
  const form = el('form'); if (help) form.append(el('p', 'gate-note', help));
  const field = inputField(id, label); field.input.required = true; form.append(field.label);
  const actions = el('div', 'detail-actions'); const submit = el('button', `button ${kind}`, title); submit.type = 'submit'; submit.dataset.action = action; actions.append(submit); form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); if (!field.input.value.trim()) { field.input.focus(); return; } act(action, { [payloadKey]: field.input.value.trim() }); });
  return form;
}
function renderTasks(item) {
  const container = el('div');
  const tasks = (state.tasks || []).filter(task => task.initiativeId === item.id || (item.taskIds || []).includes(task.id));
  if (!tasks.length) container.append(el('p', 'muted', 'Task details appear here when the plan creates delivery work.'));
  for (const task of tasks) {
    const row = el('button', 'task-row task-open'); row.type = 'button'; row.append(el('span', '', `${task.id} · ${task.title}`), el('span', 'badge', task.status || 'Planned')); row.addEventListener('click', () => openTask(task.id)); container.append(row);
  }
  const url = safeLink(state.project?.backlogUrl);
  if (url) { const link = el('a', 'button quiet', 'Open and edit tasks in Backlog ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; container.append(link); }
  return container;
}
function renderActivity(item) {
  const list = el('ol', 'timeline');
  const events = [...(item.events || [])].slice(-25).reverse();
  for (const event of events) {
    const li = el('li'); const text = readable(event) || event.type || JSON.stringify(event); li.append(el('span', '', text));
    const timestamp = event.at || event.createdAt || event.timestamp;
    if (timestamp) { const time = el('time', '', new Date(timestamp).toLocaleString()); time.dateTime = timestamp; li.append(time); }
    list.append(li);
  }
  if (!events.length) list.append(el('li', 'muted', 'Activity will appear when intake starts.'));
  return list;
}
function renderDetail() {
  const item = current(); if (!item) return;
  const previousScroll = $('#detail-dialog').scrollTop;
  const previousFocus = $('#detail-dialog').contains(document.activeElement) ? document.activeElement : null;
  const previousFocusId = previousFocus?.id;
  const previousAction = previousFocus?.dataset?.action;
  const expanded = [...$('#detail-content').querySelectorAll('details[open]')].map(node => node.firstElementChild.textContent);
  displayedRevision = item.revision;
  displayedActivity = activityKey(item);
  const container = $('#detail-content'); container.replaceChildren();
  const header = el('div', 'detail-header'); const meta = el('div', 'card-meta'); meta.append(el('span', 'eyebrow', stages.find(([stage]) => stage === item.stage)?.[1] || item.stage), el('span', `badge ${item.status}`, item.pending ? 'Queued' : labels[item.status] || item.status));
  const heading = el('div', 'dialog-heading'); const title = el('h2', '', item.title); title.id = 'detail-title';
  const close = button('×', closeDetail); close.id = 'detail-close'; close.className = 'icon-button'; close.setAttribute('aria-label', 'Close initiative'); heading.append(title, close); header.append(meta, heading);
  const body = el('div', 'detail-body'); const next = el('div', 'next-action'); next.append(el('p', 'eyebrow', ['failed', 'blocked', 'cancelled'].includes(item.status) || !isRunning(item) ? 'YOUR NEXT ACTION' : 'AGENT NEXT ACTION'), el('p', '', nextAction(item))); body.append(next);
  const error = el('p', 'inline-error'); error.id = 'detail-error'; error.setAttribute('role', 'alert'); error.hidden = true; body.append(error);
  body.append(section('The outcome you asked for', item.request));
  if (item.summary || isRunning(item)) body.append(section('Where things stand', statusSummary(item)));
  if (item.inventory || item.currentCapabilities || item.context) body.append(section('What is already in place', item.inventory || item.currentCapabilities || item.context));
  if (!isRunning(item)) renderQuestions(item, body);
  if (item.blockers?.length) body.append(section('What needs attention', item.blockers));
  if (item.scope) body.append(section(item.approvedScope ? 'Approved scope' : 'Scope for your approval', item.scope));
  if (item.plan?.length || (item.plan && !Array.isArray(item.plan))) body.append(section('Delivery plan', renderPlan(item.plan)));
  const actions = el('div', 'detail-actions');
  const recoveryHold = state.activeRun?.status === 'interrupted' && state.activeRun?.unknownProcess && state.activeRun?.initiativeId === item.id;
  if (recoveryHold) {
    const recovery = el('form');
    recovery.append(el('p', 'gate-note', 'The previous agent process could not be identified. Check that it has stopped before releasing this hold.'));
    const label = el('label', 'checkbox-label'); const confirmation = el('input'); confirmation.type = 'checkbox'; confirmation.required = true;
    label.append(confirmation, el('span', '', 'I have checked that the previous agent process has stopped'));
    const release = el('button', 'button quiet', 'Release recovery hold'); release.type = 'submit'; release.dataset.action = 'recover-run';
    const controls = el('div', 'detail-actions'); controls.append(release); recovery.append(label, controls);
    recovery.addEventListener('submit', event => { event.preventDefault(); if (confirmation.checked) act('recover-run', { confirmedStopped: true }); });
    body.append(section('Confirm the previous process has stopped', recovery));
  }
  const normalGate = !isRunning(item) && !['failed', 'cancelled', 'blocked', 'complete'].includes(item.status);
  if (normalGate && item.stage === 'intake' && item.status === 'awaiting-human' && item.scope && !item.questions?.length) actions.append(actionButton('Approve scope & prepare plan →', 'approve-scope'));
  if (normalGate && item.stage === 'planning' && item.status === 'awaiting-human' && !item.questions?.length && item.plan && (!Array.isArray(item.plan) || item.plan.length)) {
    body.append(el('p', 'gate-note', 'Approving this plan authorizes the agent to carry out its delivery phases and bring the result back for UAT.'));
    actions.append(actionButton('Approve plan & start delivery →', 'approve-plan'));
  }
  if (item.status === 'idle' && !isRunning(item) && item.stage === 'intake' && !item.scope && !item.questions?.length) actions.append(actionButton('Start intake →', 'start'));
  if (!recoveryHold && ['failed', 'cancelled', 'blocked'].includes(item.status)) actions.append(actionButton('Retry from the current checkpoint', 'retry'));
  if (isRunning(item) && !recoveryHold) actions.append(actionButton('Cancel active run', 'cancel', undefined, 'danger'));
  if (actions.childElementCount) body.append(actions);
  if (item.stage === 'uat' && item.approvedUat) body.append(section('Acceptance recorded', 'Your verdict is saved. The agent is updating the delivery records; no further acceptance is needed.'));
  if (item.stage === 'uat' && normalGate && !item.approvedUat) {
    renderUat(item, body);
    body.append(section('Something needs to change?', renderInputAction('Request rework', 'rework-feedback', 'What happened, and what should happen instead?', 'request-rework', 'feedback', 'The agent will address the feedback and return with updated acceptance checks.')));
  }
  if (item.stage === 'complete') body.append(section('Outcome accepted', 'Your UAT acceptance is recorded. Open a new initiative or propose a scope change for additional work.'));
  if (item.stage === 'complete' && item.uat?.length) {
    const checks = el('div'); item.uat.forEach((check, index) => checks.append(uatInstruction(item, check, index + 1))); body.append(section('Accepted walkthrough', checks));
  }
  if (item.evidence?.length || item.evidence && !Array.isArray(item.evidence)) body.append(section('Delivery evidence', item.evidence));
  const activity = detail('Agent activity and run evidence', renderActivity(item)); if (isRunning(item)) activity.open = true;
  activity.lastElementChild.append(el('p', 'muted', `Initiative ID: ${item.id}`));
  if (state.activeRun?.initiativeId === item.id) activity.lastElementChild.append(section('Active run', state.activeRun));
  if (item.runs?.length) activity.lastElementChild.append(section('Run records', item.runs)); body.append(activity);
  body.append(detail('Delivery tasks', renderTasks(item)));
  body.append(detail('Add a project update', renderInputAction('Save update', 'project-update', 'Information the agent should know', 'update', 'message', 'Updates are recorded for the next resumed run. Use a scope change when the approved outcome or constraints need to change.')));
  body.append(detail('Propose a scope change', renderInputAction('Submit scope change', 'scope-change', 'Describe the new or changed outcome', 'scope-change', 'request', 'This ends any active run and returns the initiative to intake. The changed scope and plan need your review before delivery resumes.')));
  container.append(header, body);
  for (const node of container.querySelectorAll('details')) if (expanded.includes(node.firstElementChild.textContent)) node.open = true;
  setBusy();
  const focusTarget = previousFocusId ? document.getElementById(previousFocusId) : previousAction ? [...container.querySelectorAll('[data-action]')].find(node => node.dataset.action === previousAction) : null;
  if (focusTarget && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
  $('#detail-dialog').scrollTop = previousScroll;
}
function openDetail(id, trigger) {
  selectedId = id; returnFocus = trigger; $('#detail-content').replaceChildren(); renderDetail(); $('#detail-dialog').showModal(); $('#detail-dialog').scrollTop = 0;
}
function closeDetail() { $('#detail-dialog').close(); }
$('#detail-dialog').addEventListener('close', () => {
  const id = selectedId; selectedId = null; displayedRevision = null; displayedActivity = null;
  const card = [...document.querySelectorAll('[data-initiative-id]')].find(node => node.dataset.initiativeId === id);
  (card || returnFocus || $('#new-initiative')).focus({ preventScroll: true });
});
async function refresh(forceDetail = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`Project connection failed (${response.status}).`);
    state = await response.json();
    $('#connection').textContent = 'Connected locally'; $('#connection').className = 'connection connected';
    $('#project-name').textContent = state.project?.name || 'Project control';
    const backlog = safeLink(state.project?.backlogUrl); $('#backlog-link').hidden = !backlog; if (backlog) $('#backlog-link').href = backlog;
    renderBoard();
    $('#updated-at').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (selectedId && current()) {
      const editing = $('#detail-dialog').contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
      if (forceDetail || ((current().revision !== displayedRevision || activityKey(current()) !== displayedActivity) && !editing)) renderDetail();
    }
    const availability = state.capabilities?.codex;
    if (availability === false || availability?.available === false) notice('Agent runtime is unavailable. You can review project state; configure the Codex runtime to start delivery.');
    else if ($('#notice-banner').textContent.startsWith('Agent runtime')) notice('');
    showError('');
  } catch (error) {
    $('#connection').textContent = 'Connection lost'; $('#connection').className = 'connection offline';
    showError(`${error.message} Your entries are preserved. Check that the local control server is running, then refresh.`);
  } finally { refreshing = false; }
}
function openCreate() { showError('', $('#create-error')); $('#create-dialog').showModal(); $('#initiative-title').focus(); }
$('#new-initiative').addEventListener('click', openCreate);
$('#empty-create').addEventListener('click', openCreate);
for (const close of document.querySelectorAll('.close-create')) close.addEventListener('click', () => $('#create-dialog').close());
$('#create-dialog').addEventListener('close', () => { recognition?.stop(); $('#new-initiative').focus(); });
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const title = $('#initiative-title').value.trim(); const userRequest = $('#initiative-request').value.trim();
  if (!title || !userRequest) { showError('Give your initiative a title and describe the outcome.', $('#create-error')); return; }
  if (!state?.csrfToken) { showError('Wait for a project connection before starting intake.', $('#create-error')); return; }
  busy = true; setBusy(); showError('', $('#create-error'));
  try {
    const result = await request('/api/initiatives', { title, request: userRequest, reviewMode: $('#review-mode').checked, start: true });
    $('#create-dialog').close(); $('#create-form').reset();
    await refresh();
    const id = result.initiative?.id || result.id;
    if (id && state.initiatives?.some(item => item.id === id)) openDetail(id, $('#new-initiative'));
    $('#live-status').textContent = 'Initiative created. Intake started.';
  } catch (error) { showError(error.message, $('#create-error')); if (error.status === 409) await refresh(); }
  finally { busy = false; setBusy(); }
});
$('#filter').addEventListener('input', renderBoard);
$('#refresh').addEventListener('click', () => refresh(true));

function agentsBusy() { return !!state?.activeRun || (state?.initiatives || []).some(isRunning); }
function taskEditable(task) { return task.atomicRevision !== false && !agentsBusy() && ['backlog', 'ready', 'blocked'].includes(String(task.status).toLowerCase()); }
function renderTaskBoard() {
  const container = $('#tasks-list');
  const focusedId = document.activeElement?.dataset?.taskId;
  container.replaceChildren();
  const tasks = state?.tasks || [];
  $('#task-count').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  if (!tasks.length) { container.append(el('p', 'muted', 'No delivery tasks have been recorded in Backlog yet.')); return; }
  for (const task of tasks) {
    const card = el('button', 'initiative-card task-card'); card.type = 'button'; card.dataset.taskId = task.id;
    const meta = el('div', 'card-meta'); meta.append(el('span', 'card-id', task.id), el('span', 'badge', task.status || 'Unspecified'));
    const footer = el('div', 'card-next'); footer.append(el('span', '', taskEditable(task) ? 'Inspect or edit task' : 'Inspect task'), el('span', 'arrow', '↗'));
    card.append(meta, el('h3', 'card-title', task.title), footer);
    card.addEventListener('click', () => openTask(task.id)); container.append(card);
  }
  if (focusedId) [...container.querySelectorAll('button')].find(node => node.dataset.taskId === focusedId)?.focus({ preventScroll: true });
}
let taskBeingViewed = null;
let taskLoadSequence = 0;
function renderTaskDraft(id) {
  const draft = taskDrafts.get(id); if (!draft) return null;
  const block = section('Your unsaved draft', 'This draft is kept in this browser tab until you save or explicitly discard it.');
  const text = el('textarea'); text.readOnly = true; text.rows = 6; text.setAttribute('aria-label', 'Unsaved task draft'); text.value = `${draft.title}\n\n${draft.description}`;
  const controls = el('div', 'detail-actions');
  controls.append(button('Select draft to copy', () => { text.focus(); text.select(); }), button('Discard unsaved draft', () => { taskDrafts.delete(id); openTask(id); }));
  block.append(text, controls); return block;
}
async function openTask(id, preserveDraft = false, editing = false) {
  const sequence = ++taskLoadSequence;
  const previous = taskDrafts.get(id);
  taskBeingViewed = id;
  const dialog = $('#task-dialog'); const container = $('#task-content');
  $('#task-dialog-title').textContent = id;
  container.replaceChildren(el('p', 'muted', 'Loading the current task…'));
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readable(result.error) || `Unable to load task (${response.status}).`);
    if (sequence !== taskLoadSequence || !dialog.open) return;
    const task = result.task;
    if (!task) throw new Error('The server returned no task details.');
    container.replaceChildren();
    container.append(el('span', 'badge', task.status));
    const allowed = taskEditable(task);
    if (!allowed || !editing) {
      if (!allowed) container.append(el('p', 'gate-note', task.atomicRevision === false ? 'Safe task editing is unavailable with this Backlog installation. Run node .switchflow/scripts/backlog-fork/setup.mjs, then restart the control server.' : agentsBusy() ? 'Task editing is paused while an agent run is active or queued. You can inspect the task now.' : 'This task has moved beyond the editable checkpoint. Use an initiative scope change for work that is running, in review, or complete.'));
      container.append(section('Task outcome', task.title), section('Description', task.description || 'No description recorded.'));
      const extra = Object.fromEntries(Object.entries(task).filter(([key]) => !['id', 'title', 'description', 'revision', 'status'].includes(key)));
      if (Object.keys(extra).length) container.append(detail('Task details and acceptance criteria', renderValue(extra)));
      const draft = renderTaskDraft(id); if (draft) container.append(draft);
      if (allowed) container.append(button(previous ? 'Continue editing draft' : 'Edit task', () => openTask(id, true, true), 'primary'));
      return;
    }
    if (previous) {
      container.append(el('p', 'gate-note', 'The latest saved task is shown below. Your unsaved text is preserved in the editor. Compare both before saving.'));
      container.append(section('Latest saved title', task.title), section('Latest saved description', task.description || 'No description recorded.'));
    }
    const form = el('form');
    const titleLabel = el('label', '', 'Task title'); const title = el('input'); title.id = 'task-edit-title'; title.required = true; title.maxLength = 240; title.value = previous?.title ?? task.title; titleLabel.append(title);
    const descriptionLabel = el('label', '', 'Description'); const description = el('textarea'); description.id = 'task-edit-description'; description.rows = 8; description.required = true; description.maxLength = 10000; description.value = previous?.description ?? task.description ?? ''; descriptionLabel.append(description);
    const keepDraft = () => taskDrafts.set(id, { title: title.value, description: description.value });
    title.addEventListener('input', keepDraft); description.addEventListener('input', keepDraft);
    const error = el('p', 'inline-error'); error.hidden = true; error.setAttribute('role', 'alert');
    const footer = el('div', 'dialog-footer'); const save = el('button', 'button primary', 'Save task'); save.type = 'submit'; footer.append(button('Back to task', () => openTask(id)), save);
    form.append(titleLabel, descriptionLabel, error, footer); container.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (save.disabled) return;
      if (agentsBusy()) { showError('An agent run has started. Wait for it to finish before editing this task.', error); return; }
      if (!title.value.trim() || !description.value.trim()) { showError('Enter a task title and description.', error); return; }
      save.disabled = true; showError('', error);
      try {
        await request(`/api/tasks/${encodeURIComponent(id)}`, { expectedRevision: task.revision, title: title.value.trim(), description: description.value.trim() }, 'PATCH');
        taskDrafts.delete(id); dialog.close(); notice(`Task ${id} was saved. Backlog validation completed.`); await refresh();
      } catch (failure) {
        showError(failure.status === 409 ? 'This task or its delivery checkpoint changed. Your draft is preserved. Load the latest task and compare before saving again.' : failure.message, error);
        if (failure.status === 409) {
          save.hidden = true;
          footer.append(button('Load latest and keep my draft', () => openTask(id, true)));
        }
      } finally { save.disabled = false; }
    });
  } catch (failure) { if (sequence === taskLoadSequence) { container.replaceChildren(el('p', 'inline-error', failure.message)); container.append(button('Try loading again', () => openTask(id))); } }
}
$('#task-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog').addEventListener('close', () => {
  taskLoadSequence++;
  const card = [...document.querySelectorAll('[data-task-id]')].find(node => node.dataset.taskId === taskBeingViewed);
  if (!$('#detail-dialog').open) (card || $('#tasks-title')).focus({ preventScroll: true });
});
$('#operations-close').addEventListener('click', () => $('#operations-dialog').close());
$('#operations-dialog').addEventListener('close', () => $('#operations-open').focus());
async function openOperations() {
  const dialog = $('#operations-dialog'); const container = $('#operations-content');
  container.replaceChildren(el('p', 'muted', 'Reading recorded project operations…'));
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch('/api/operations', { credentials: 'same-origin', cache: 'no-store' });
    const operations = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readable(operations.error) || `Unable to load framework health (${response.status}).`);
    container.replaceChildren(el('p', 'gate-note', 'Recorded operational evidence for this project. Reviewing an issue here does not dispatch work or change the approved scope.'));
    for (const [key, title, empty] of [
      ['issues', 'Recorded framework issues', 'No framework issues have been recorded.'],
      ['metrics', 'Workflow observations', 'No workflow metrics have been recorded.'],
      ['worktrees', 'Registered worktrees', 'No worktrees have been recorded.'],
      ['retention', 'Retention and cleanup evidence', 'No cleanup evidence has been recorded.'],
    ]) {
      const value = operations[key];
      const absent = value == null || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Object.keys(value).length);
      container.append(section(title, absent ? empty : value));
    }
    container.append(button('Refresh framework health', openOperations));
  } catch (failure) { container.replaceChildren(el('p', 'inline-error', failure.message)); container.append(button('Try again', openOperations)); }
}
$('#operations-open').addEventListener('click', openOperations);

// Speech recognition is optional and starts only after a deliberate button click.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  $('#dictation-controls').hidden = false;
  let listening = false;
  $('#dictate').addEventListener('click', () => {
    if (listening) { recognition?.stop(); return; }
    recognition = new SpeechRecognition(); recognition.continuous = true; recognition.interimResults = false; recognition.lang = navigator.language || 'en-AU';
    recognition.onstart = () => { listening = true; $('#dictate').textContent = 'Stop dictation'; $('#dictation-status').textContent = 'Listening…'; };
    recognition.onresult = event => {
      const field = $('#initiative-request');
      for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) field.value = `${field.value.trim()} ${event.results[index][0].transcript}`.trim().slice(0, 24000);
    };
    recognition.onerror = event => { $('#dictation-status').textContent = `Dictation unavailable (${event.error}). You can keep typing.`; };
    recognition.onend = () => { listening = false; $('#dictate').textContent = 'Use dictation'; if ($('#dictation-status').textContent === 'Listening…') $('#dictation-status').textContent = 'Dictation stopped. Review your text before starting intake.'; };
    try { recognition.start(); } catch { $('#dictation-status').textContent = 'Dictation could not start. You can keep typing.'; }
  });
}
await refresh();
setInterval(() => { if (!document.hidden && !busy) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
