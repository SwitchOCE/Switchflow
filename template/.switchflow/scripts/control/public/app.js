import { overviewGroups, runPresentation, historyPage, milestoneOrderSummary, reworkReviewSummary } from './overview-model.js';
import { mountSkills } from './skills.js';
import { mountKnowledge } from './knowledge.js';
import { mountTasks } from './tasks.js';
import { mountInsights } from './insights.js';
import { createNativeClient, workspaceLocation } from './workspace-client.js';
import { mountSearch } from './workspace-search.js';
import { createMilestonePanel } from './milestones.js';
import { initiativeTasks } from './initiative-tasks.js';
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
let drafts = new Map();
let taskDrafts = new Map();
let uatGenerations = new Map();
const projectDrafts = new Map();
const milestoneDrafts = new Map();
function savePageDrafts() {
  if (!selectedProjectId) return;
  try {
    sessionStorage.setItem(`switchflow:drafts:${selectedProjectId}`, JSON.stringify({
      drafts: [...drafts], taskDrafts: [...taskDrafts], uatGenerations: [...uatGenerations],
      milestoneDrafts: [...milestoneDrafts].filter(([key]) => key.startsWith(`${selectedProjectId}:`)),
      title: $('#initiative-title').value, request: $('#initiative-request').value,
      review: $('#review-mode').checked, filter: $('#filter').value,
    }));
  } catch { /* In-memory drafts still work when browser storage is unavailable. */ }
}
function restorePageDrafts(id) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`switchflow:drafts:${id}`) || '{}');
    return { ...saved, drafts: new Map(saved.drafts || []), taskDrafts: new Map(saved.taskDrafts || []), uatGenerations: new Map(saved.uatGenerations || []) };
  } catch { return {}; }
}
document.addEventListener('input', () => queueMicrotask(savePageDrafts));
document.addEventListener('change', () => queueMicrotask(savePageDrafts));
window.addEventListener('pagehide', savePageDrafts);
let selectedProjectId = null;
let projectEpoch = 0;
let sharedToken = '';
let projectList = [];
const views = ['board', 'tasks', 'milestones', 'documents', 'decisions', 'drafts', 'statistics', 'skills', 'settings'];
let activeView = workspaceLocation(location.href).view;
const panels = new Map();
const historyPages = new Map();
const overviewMilestones = new Map();
let taskOrigin = null;
const recordReturnPositions = new Map();
let followingRoute = false;
let panelRefreshedAt = 0;
let nativeWrites = 0;
let connected = false;
let projectsRefreshedAt = 0;
function scopedPath(route, projectId = selectedProjectId) {
  if (!projectId) throw new Error('Select a connected project first.');
  return `/api/projects/${encodeURIComponent(projectId)}${route.replace(/^\/api(?=\/|$)/, '')}`;
}
async function readProject(route, projectId = selectedProjectId) {
  const response = await fetch(scopedPath(route, projectId), { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Unable to load project (${response.status}).`);
  return data;
}

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
  const presentation = runPresentation(item,state?.activeRun);
  if (presentation.label !== 'Agent working') return presentation.reason || readable(item.summary) || item.request;
  const run = state.activeRun;
  const progress = !item.pending && run?.startedAt && item.events?.findLast(entry => entry.type === 'progress' && entry.at >= run.startedAt);
  return readable(progress?.message) || (item.pending ? 'Waiting for the next available agent.' : 'The agent is preparing this stage.');
}
function nextAction(item) {
  if (isRunning(item)) return `${runPresentation(item, state?.activeRun).label}. Open to follow progress.`;
  if (item.nextAction) return readable(item.nextAction);
  if (['failed', 'blocked'].includes(item.status)) return 'Review what needs attention';
  if (item.status === 'cancelled') return 'Review and retry when ready';
  return { intake: 'Review the scope', planning: 'Review the delivery plan', delivery: 'Follow agent delivery', uat: 'Try the result and record your checks', complete: 'View the accepted outcome' }[item.stage] || 'View initiative';
}
async function request(path, data, method = 'POST', projectId = selectedProjectId) {
  const response = await fetch(scopedPath(path, projectId), { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': state?.csrfToken || '' }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = readable(result.error) || result.message || `Request failed (${response.status}).`;
    const error = new Error(response.status === 409 ? 'The record changed while you were reviewing it. Your draft is preserved. Load the latest record and compare before trying again.' : message);
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
    $('#live-status').textContent = connected ? 'Project action saved. The board is up to date.' : 'Project action saved, but the latest state could not be loaded. Refresh before taking another action.';
  } catch (error) {
    if (error.status === 409) await refresh(true);
    showError(error.status ? error.message : `${error.message} The action outcome is unknown. Your input is retained. Refresh and reconcile the current checkpoint before submitting again.`, $('#detail-error') || $('#error-banner'));
  } finally { busy = false; setBusy(); }
}
function setBusy() {
  $('#project-select').disabled = busy || nativeWrites > 0; $('#add-project').disabled = busy || nativeWrites > 0;
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
      const meta = el('div', 'card-meta'); meta.append(el('span', `badge ${item.status}`, runPresentation(item, state?.activeRun).label));
      const next = el('div', 'card-next'); next.append(el('span', '', nextAction(item)), el('span', 'arrow', '↗'));
      card.append(meta, el('h4', 'card-title', item.title), el('p', 'card-summary', statusSummary(item)), next);
      card.addEventListener('click', () => openDetail(item.id, card)); list.append(card);
    }
    if (!members.length) list.append(el('div', 'column-empty', query ? 'No matching initiatives' : 'No initiatives here yet'));
    column.append(list); board.append(column);
  }
  if (focusedId) [...board.querySelectorAll('button')].find(node => node.dataset.initiativeId === focusedId)?.focus({ preventScroll: true });
  $('#board-count').textContent = `${all.length} initiative${all.length === 1 ? '' : 's'} · ${overviewGroups(state).decisions.length} initiative decisions · ${overviewGroups(state).humanTasks.length} Ready Human tasks`;
  $('#empty-state').hidden = all.length > 0 || !!query;
  const active = all.find(item => runPresentation(item, state?.activeRun).label === 'Agent working');
  $('#activity-title').textContent = active ? 'Agent working' : 'Agent activity';
  $('#activity-summary').textContent = active ? `${active.title} · ${statusSummary(active)}` : all.length ? 'No agent run is active. Your next decision is shown on each card.' : 'Ready for your first initiative.';
  renderTaskBoard();
  renderOverview();
}
function renderOverview() {
  const container = $('#overview-queues');
  const focused = document.activeElement?.dataset?.overviewKey;
  const expanded = [...container.querySelectorAll('details[open]')].map(n => n.dataset.group);
  container.replaceChildren();
  if (state?.boardError) container.append(el('p','inline-error',`Tasks are unavailable: ${state.boardError}. Initiative decisions remain available; refresh to retry.`));
  const overview = overviewGroups(state);
  for (const group of overview.groups) {
    const block = el('section','overview-queue'); block.append(el('h2','',`${group.title} · ${group.items.length}`));
    if (group.title === 'Needs you') block.append(el('p','muted',`${overview.decisions.length} initiative decisions · ${state?.boardError ? 'Ready Human tasks unavailable' : `${overview.humanTasks.length} Ready Human tasks`}`));
    if (!group.items.length) block.append(el('p','muted',group.empty));
    if (group.title === 'Next eligible') {
      const milestones = overviewMilestones.get(selectedProjectId);
      block.append(el('p','gate-note',milestones?.value ? milestoneOrderSummary(milestones.value) : milestones?.error ? `Milestone order is unavailable: ${milestones.error}. Open Milestones to retry.` : 'Checking recorded milestone order…'));
      block.append(button('Open Milestones',() => showView('milestones')));
    }
    const older = detail(`Show ${Math.max(0,group.items.length - 4)} more`,el('div'));
    older.dataset.group = group.title; older.open = expanded.includes(group.title);
    group.items.forEach((item,index) => {
      const row = button('', () => item.kind === 'task' ? openTask(item.id) : openDetail(item.id,row));
      row.className = 'overview-row'; row.dataset.overviewKey = `${group.title}:${item.id}`;
      row.append(el('strong','',item.title),el('span','',item.reason));
      (index < 4 ? block : older.lastElementChild).append(row);
    });
    if (group.items.length > 4) block.append(older);
    container.append(block);
  }
  if (focused) [...container.querySelectorAll('[data-overview-key]')].find(n => n.dataset.overviewKey === focused)?.focus({preventScroll:true});
}
async function refreshOverviewMilestones() {
  const id = selectedProjectId, epoch = projectEpoch;
  if (!id || !connected) return;
  const cached = overviewMilestones.get(id);
  if (cached?.loading || (cached && Date.now() - cached.at < 30000)) return;
  const entry = {...cached,loading:true,at:Date.now()}; overviewMilestones.set(id,entry);
  try {
    const result = await nativeClient(id)('/milestones');
    if (epoch !== projectEpoch || id !== selectedProjectId || overviewMilestones.get(id) !== entry) { if (overviewMilestones.get(id) === entry) overviewMilestones.delete(id); return; }
    entry.value = Array.isArray(result) ? result : result.milestones || []; entry.error = null;
  } catch (error) { if (epoch !== projectEpoch || id !== selectedProjectId || overviewMilestones.get(id) !== entry) {if (overviewMilestones.get(id) === entry) overviewMilestones.delete(id);return;} entry.error = error.message; }
  finally {entry.loading = false;}
  if (epoch === projectEpoch) renderOverview();
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
    const response = await fetch(scopedPath(`/api/initiatives/${encodeURIComponent(initiativeId)}/artifacts?${query}`), { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json(); if (!response.ok) throw new Error(readable(result.error) || 'Artifact preview is unavailable.');
    body.replaceChildren(el('p', 'gate-note', 'This is the file recorded in the delivered commit. Unsaved working files are not included.'));
    body.append(el('h3', '', result.path), el('p', 'artifact-head', `Commit ${result.head}`));
    const content = el('pre', 'artifact-content', result.content); content.tabIndex = 0; content.setAttribute('aria-label', 'Committed file contents'); body.append(content);
  } catch (error) { const message = el('p', 'inline-error', error.message); message.setAttribute('role', 'alert'); body.replaceChildren(message); }
}
function renderUat(item, body) {
  const form = el('form'); form.id = 'uat-checks'; const checks = Array.isArray(item.uat) ? item.uat : [];
  const normalized = checks.map((entry, index) => typeof entry === 'string' ? { id: `uat-${index + 1}`, title: entry, status: 'pending' } : entry);
  const generation = JSON.stringify(normalized.map(check => [check.id, check.title, check.text]));
  if (uatGenerations.has(item.id) && uatGenerations.get(item.id) !== generation) clearUatDraft(item.id);
  uatGenerations.set(item.id, generation);
  if (!normalized.length) { body.append(section('Acceptance checks', 'No guided checks are available yet. Request a delivery update before accepting.')); return; }
  form.append(el('p', 'gate-note', 'Try each step in the delivered product. Record what you observe; agent test results alone do not count as your acceptance.'));
  const scenario = el('select'); scenario.setAttribute('aria-label','Acceptance scenario');
  normalized.forEach((check,index) => {const option = el('option','',`${index + 1}. ${check.title || check.text || check.id}`);option.value = index;scenario.append(option);});
  const firstPending = normalized.findIndex(check => (drafts.get(item.id)?.[`uat-status-${check.id}`] ?? check.status ?? 'pending') === 'pending');
  scenario.value = String(Math.max(0,firstPending));
  const showScenario = index => {scenario.value = String(index);[...form.querySelectorAll('.uat-step')].forEach((step,i) => step.hidden = i !== Number(scenario.value));};
  scenario.addEventListener('change',() => showScenario(scenario.value));
  form.append(scenario);
  const progress = el('div','uat-progress'); progress.setAttribute('role','status'); form.append(progress);
  const updateProgress = () => { const selects = [...form.querySelectorAll('.uat-step select')]; const remaining = selects.filter(n => n.value === 'pending'); progress.replaceChildren(el('strong','',`${selects.length - remaining.length} of ${normalized.length} checked · ${remaining.length} remaining · ${selects.filter(n => n.value === 'failed').length} need rework`),el('p','muted','Changes are kept in this browser session until you submit a verdict.')); if (remaining.length) progress.append(button('Next unchecked',() => { showScenario(selects.indexOf(remaining[0])); remaining[0].closest('.uat-step').scrollIntoView({block:'start'}); remaining[0].focus({preventScroll:true}); })); };
  normalized.forEach((check, index) => {
    const block = el('div', 'uat-step'); block.append(uatInstruction(item, check, index + 1));
    if (check.instructions || check.expected) block.append(renderValue(check.instructions || check.expected));
    const label = el('label', '', 'Your result'); const select = el('select'); select.name = `uat-status-${check.id}`;
    for (const [value, text] of [['pending', 'Not checked yet'], ['passed', 'Passed'], ['failed', 'Needs rework']]) { const option = el('option', '', text); option.value = value; select.append(option); }
    select.value = drafts.get(item.id)?.[select.name] ?? check.status ?? 'pending';
    select.addEventListener('change', () => {remember(select.name, select.value);updateProgress();}); label.append(select); block.append(label);
    const notes = inputField(`uat-notes-${check.id}`, 'Notes (optional)', check.notes || ''); notes.input.maxLength = 12000; block.append(notes.label); form.append(block);
  });
  showScenario(scenario.value); updateProgress();
  const stepNavigation = el('div','detail-actions'); stepNavigation.append(button('Previous check',() => showScenario(Math.max(0,Number(scenario.value)-1))),button('Next check',() => showScenario(Math.min(normalized.length-1,Number(scenario.value)+1)))); form.append(stepNavigation);
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
  form.addEventListener('submit', event => { event.preventDefault(); if (!field.input.value.trim()) { field.input.focus(); return; } act(action, { [payloadKey]: field.input.value.trim(), ...(action === 'request-rework' ? {results: (current()?.uat || []).map(check => ({id:check.id,status: drafts.get(selectedId)?.[`uat-status-${check.id}`] ?? check.status ?? 'pending',notes:drafts.get(selectedId)?.[`uat-notes-${check.id}`] ?? check.notes ?? ''}))} : {}) }); });
  return form;
}
function renderTasks(item) {
  const container = el('div');
  const tasks = initiativeTasks(item, state.tasks || []);
  if (!tasks.length) container.append(el('p', 'muted', 'No available tasks are linked to this initiative. Plan entries must name exact Backlog task IDs; titles alone do not identify delivery work.'));
  for (const task of tasks) {
    const row = el('button', 'task-row task-open'); row.type = 'button'; row.append(el('span', '', `${task.id} · ${task.title}`), el('span', 'badge', task.status || 'Planned')); row.addEventListener('click', () => openTask(task.id)); container.append(row);
  }
  container.append(button('Open all project tasks', () => { closeDetail(); showView('tasks'); }));
  return container;
}
function renderHistory(item, records, key, renderRecord) {
  const wrapper = el('div'), list = el('div','history-records'), controls = el('div','history-controls');
  const storageKey = `${selectedProjectId}:${item.id}:${key}`;
  const filter = el('select'); filter.setAttribute('aria-label',`Filter ${key}`);
  for (const value of ['all',...new Set(records.map(r => r.type || r.status || 'other'))]) { const option = el('option','',value === 'all' ? 'All types' : value); option.value = value; filter.append(option); }
  const saved = historyPages.get(storageKey) || {page:0,filter:'all'};
  filter.value = [...filter.options].some(o => o.value === saved.filter) ? saved.filter : 'all';
  const draw = () => {
    const matching = records.filter(r => filter.value === 'all' || (r.type || r.status || 'other') === filter.value);
    const page = historyPage(matching,saved.page); saved.page = page.index; saved.filter = filter.value; historyPages.set(storageKey,saved);
    list.replaceChildren(...page.items.map(renderRecord)); controls.replaceChildren();
    const newer = button('Newer',() => { saved.page--; draw(); controls.querySelector('button')?.focus(); }); newer.disabled = page.index === 0;
    const older = button('Older',() => { saved.page++; draw(); controls.lastElementChild?.focus(); }); older.disabled = page.index + 1 === page.pages;
    controls.append(newer,el('span','muted',`${page.start}–${page.end} of ${page.total} matching retained ${key}`),older);
    if (!page.total) list.append(el('p','muted','No matching records.'));
  };
  filter.addEventListener('change',() => {saved.page = 0;draw();});
  wrapper.append(el('p','muted',key === 'reviews' ? `${records.length} saved rework reviews. Expand a review to read its observations.` : `${records.length} retained ${key}. Runtime retention is limited to the latest ${key === 'events' ? 200 : 100}; older discarded records are unavailable.`),filter,controls,list);draw();return wrapper;
}
function renderReworkReview(review) {
  const summary = reworkReviewSummary(review);
  const content = el('div');
  content.append(el('p','prose',review.message || 'Rework requested.'));
  content.append(el('p','muted',`${summary.checked} of ${summary.total} checked · ${summary.failed} need rework · ${summary.unchecked.length} unchecked without notes`));
  const checks = el('div','history-records');
  for (const check of summary.observed) {
    const row = el('section','detail-section');
    row.append(el('h4','',`${check.title || check.text || check.id} · ${check.status === 'failed' ? 'Needs rework' : check.status === 'passed' ? 'Passed' : 'Not checked; note recorded'}`));
    if (check.notes?.trim()) row.append(el('p','prose',check.notes));
    checks.append(row);
  }
  if (summary.observed.length) content.append(checks);
  if (summary.unchecked.length) {
    const pending = el('ul','data-list history-records');
    summary.unchecked.forEach(check => pending.append(el('li','',check.title || check.text || check.id)));
    content.append(detail(`View ${summary.unchecked.length} unchecked check titles`,pending));
  }
  if (review.candidateEvidence?.length) content.append(detail('Candidate evidence for this review',renderValue(review.candidateEvidence)));
  const date = review.at ? new Date(review.at).toLocaleString() : 'Recorded review';
  const node = detail(`${date} · ${summary.checked}/${summary.total} checked · ${summary.failed} need rework`,content);
  // Feedback remains visible in the collapsed summary without exposing all check metadata.
  node.firstElementChild.append(el('span','rework-feedback-summary',review.message || 'Rework requested.'));
  return node;
}
function renderActivity(item) {
  return renderHistory(item,item.events || [],'events',event => {
    const row = el('div','timeline'); row.append(el('p','',readable(event) || event.type || JSON.stringify(event)));
    const timestamp = event.at || event.createdAt || event.timestamp;
    if (timestamp) row.append(el('time','muted',new Date(timestamp).toLocaleString()));
    return row;
  });
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
  const header = el('div', 'detail-header'); const meta = el('div', 'card-meta'); meta.append(el('span', 'eyebrow', stages.find(([stage]) => stage === item.stage)?.[1] || item.stage), el('span', `badge ${item.status}`, runPresentation(item, state?.activeRun).label));
  const heading = el('div', 'dialog-heading'); const title = el('h2', '', item.title); title.id = 'detail-title';
  const close = button('×', closeDetail); close.id = 'detail-close'; close.className = 'icon-button'; close.setAttribute('aria-label', 'Close initiative'); heading.append(title, close); header.append(meta, heading);
  const decision = el('section','decision-region'); decision.setAttribute('aria-label','Current decision');
  const body = el('div', 'detail-body'); const next = el('div', 'next-action'); next.append(el('p', 'eyebrow', ['failed', 'blocked', 'cancelled'].includes(item.status) || !isRunning(item) ? 'YOUR NEXT ACTION' : 'AGENT NEXT ACTION'), el('p', '', nextAction(item))); decision.append(next);
  const error = el('p', 'inline-error'); error.id = 'detail-error'; error.setAttribute('role', 'alert'); error.hidden = true; body.append(error);
  body.append(section('The outcome you asked for', item.request));
  if (item.summary || isRunning(item)) body.append(section('Where things stand', statusSummary(item)));
  if (item.inventory || item.currentCapabilities || item.context) body.append(section('What is already in place', item.inventory || item.currentCapabilities || item.context));
  if (!isRunning(item)) renderQuestions(item, body);
  if (item.blockers?.length) body.append(section('What needs attention', item.blockers));
  if (item.scope) body.append(section(item.approvedScope ? 'Approved scope' : 'Scope for your approval', item.scope));
  const displayedPlan = item.approvedPlan ? item.approvedPlan.tasks : item.plan;
  if (displayedPlan?.length || (displayedPlan && !Array.isArray(displayedPlan))) body.append(section('Delivery plan', renderPlan(displayedPlan)));
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
  if (normalGate && item.stage === 'intake' && item.status === 'awaiting-human' && item.scope && !item.questions?.length) { decision.append(el('p','gate-note','Approve this scope to prepare a plan. Delivery still requires plan approval.')); actions.append(actionButton('Approve scope & prepare plan →', 'approve-scope')); }
  if (normalGate && item.stage === 'planning' && item.status === 'awaiting-human' && !item.questions?.length && item.plan && (!Array.isArray(item.plan) || item.plan.length)) {
    decision.append(el('p', 'gate-note', 'Approving this plan authorizes the agent to carry out its delivery phases and bring the result back for UAT.'));
    actions.append(actionButton('Approve plan & start delivery →', 'approve-plan'));
  }
  if (item.status === 'idle' && !isRunning(item) && item.stage === 'intake' && !item.scope && !item.questions?.length) actions.append(actionButton('Start intake →', 'start'));
  if (!recoveryHold && ['failed', 'cancelled', 'blocked'].includes(item.status)) actions.append(actionButton('Retry from the current checkpoint', 'retry'));
  if (isRunning(item) && !recoveryHold) actions.append(actionButton('Cancel active run', 'cancel', undefined, 'danger'));
  if (actions.childElementCount) decision.append(actions);
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
  if (item.runs?.length) activity.lastElementChild.append(section('Run records', renderHistory(item,item.runs,'runs',run => detail(`${run.stage || 'Run'} · ${run.status || 'Recorded'} · ${run.startedAt ? new Date(run.startedAt).toLocaleString() : run.id}`,renderValue(run))))); body.append(activity);
  body.append(detail('Delivery tasks', renderTasks(item)));
  body.append(detail('Add a project update', renderInputAction('Save update', 'project-update', 'Information the agent should know', 'update', 'message', 'Updates are recorded for the next resumed run. Use a scope change when the approved outcome or constraints need to change.')));
  body.append(detail('Propose a scope change', renderInputAction('Submit scope change', 'scope-change', 'Describe the new or changed outcome', 'scope-change', 'request', 'This ends any active run and returns the initiative to intake. The changed scope and plan need your review before delivery resumes.')));
  const navigation = el('nav','evidence-nav'); navigation.setAttribute('aria-label','Initiative evidence');
  for (const [label,match] of [['Scope','scope'],['Plan','Delivery plan'],['Evidence','Delivery evidence'],['Checks','Your guided acceptance checks']]) {
    const target = [...body.querySelectorAll('.detail-section')].find(n => n.querySelector('h3')?.textContent.toLowerCase().includes(match.toLowerCase()));
    if (target) { target.tabIndex = -1; navigation.append(button(label,() => {target.scrollIntoView({block:'start'});target.focus({preventScroll:true});})); }
  }
  if (item.questions?.length && !isRunning(item)) decision.append(button('Answer outstanding questions',() => { const field = body.querySelector('textarea'); field?.scrollIntoView({block:'center'});field?.focus({preventScroll:true}); }));
  if (item.stage === 'uat' && normalGate && !item.approvedUat) decision.append(button('Review checks / submit verdict',() => {$('#uat-checks')?.scrollIntoView({block:'start'});}));
  const reviews = (item.messages || []).filter(m => m.type === 'rework' && m.results);
  if (reviews.length) body.append(detail('Previous rework observations',renderHistory(item,reviews,'reviews',renderReworkReview)));
  header.append(navigation); container.append(header, body, decision);
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
  if (!selectedProjectId) return;
  refreshing = true;
  const epoch = projectEpoch;
  try {
    const response = await fetch(scopedPath('/api/state'), { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`Project connection failed (${response.status}).`);
    const loaded = await response.json();
    if (epoch !== projectEpoch) return;
    state = loaded; sharedToken = state.csrfToken; connected = true;
    document.title = `${state.project.name} · Switchflow`;
    if (Date.now() - projectsRefreshedAt > 8000) loadProjects().catch(() => {});
    $('#connection').textContent = 'Connected locally'; $('#connection').className = 'connection connected';
    $('#project-name').textContent = state.project?.name || 'Project control';
    renderBoard();
    void refreshOverviewMilestones();
    $('#updated-at').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (selectedId && current()) {
      const editing = $('#detail-dialog').contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
      if (forceDetail || ((current().revision !== displayedRevision || activityKey(current()) !== displayedActivity) && !editing)) renderDetail();
    }
    const availability = state.capabilities?.codex;
    if (availability === false || availability?.available === false) notice('Agent runtime is unavailable. You can review project state; configure the Codex runtime to start delivery.');
    else if ($('#notice-banner').textContent.startsWith('Agent runtime')) notice('');
    showError('');
    if (activeView !== 'board') {
      showView(activeView, false);
      if (!busy && !nativeWrites && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input,textarea,select') && Date.now() - panelRefreshedAt > 10000) {
        panelRefreshedAt = Date.now(); panels.get(activeView)?.refresh();
      }
    }
  } catch (error) {
    if (epoch !== projectEpoch) return;
    connected = false; $('#connection').textContent = 'Connection lost'; $('#connection').className = 'connection offline';
    showError(`${error.message} Your entries are preserved. Check that the local control server is running, then refresh.`);
  } finally { if (epoch === projectEpoch) refreshing = false; }
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
  if (!tasks.length) { container.append(el('p', 'muted', 'No delivery tasks have been recorded yet.')); return; }
  for (const task of tasks.slice(0, 8)) {
    const card = el('button', 'initiative-card task-card'); card.type = 'button'; card.dataset.taskId = task.id;
    const meta = el('div', 'card-meta'); meta.append(el('span', 'card-id', task.id), el('span', 'badge', task.status || 'Unspecified'));
    const footer = el('div', 'card-next'); footer.append(el('span', '', taskEditable(task) ? 'Inspect or edit task' : 'Inspect task'), el('span', 'arrow', '↗'));
    card.append(meta, el('h3', 'card-title', task.title));
    if (task.blockReason) card.append(el('p', 'task-block-reason', task.blockReason === 'dependent' ? 'Waiting for dependencies' : `Blocked: ${task.blockReason}`));
    card.append(footer);
    card.addEventListener('click', () => openTask(task.id)); container.append(card);
  }
  if (focusedId) [...container.querySelectorAll('button')].find(node => node.dataset.taskId === focusedId)?.focus({ preventScroll: true });
}
async function openTask(id, trigger = document.activeElement) {
  const epoch = projectEpoch;
  taskOrigin = {view:activeView,url:location.href,scroll:window.scrollY,initiative:selectedId,initiativeScroll:$('#detail-dialog').scrollTop,trigger};
  if ($('#detail-dialog').open) closeDetail();
  const panel = showView('tasks',false);
  if (panel) { await panel.refresh(); if (epoch === projectEpoch) await panel.openTask(id); }
}
function taskClosed() {
  if (followingRoute) return;
  const origin = taskOrigin; taskOrigin = null;
  if (!origin) { writeLocation({view:activeView}); return; }
  showView(origin.view,false); history.pushState(null,'',origin.url);
  requestAnimationFrame(() => {
    window.scrollTo(0,origin.scroll);
    if (origin.initiative && state?.initiatives?.some(i => i.id === origin.initiative)) {openDetail(origin.initiative,origin.trigger);$('#detail-dialog').scrollTop = origin.initiativeScroll;}
    else if (origin.trigger?.isConnected) origin.trigger.focus({preventScroll:true});
  });
}
$('#all-tasks').addEventListener('click', () => showView('tasks'));
$('#operations-close').addEventListener('click', () => $('#operations-dialog').close());
$('#operations-dialog').addEventListener('close', () => $('#operations-open').focus());
async function openOperations() {
  const epoch = projectEpoch;
  const dialog = $('#operations-dialog'); const container = $('#operations-content');
  container.replaceChildren(el('p', 'muted', 'Reading recorded project operations…'));
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(scopedPath('/api/operations'), { credentials: 'same-origin', cache: 'no-store' });
    const operations = await response.json().catch(() => ({}));
    if (epoch !== projectEpoch || !dialog.open) return;
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

async function loadProjects() {
  const response = await fetch('/api/projects', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot load the shared project registry.');
  const data = await response.json(); sharedToken = data.csrfToken; projectList = data.projects; projectsRefreshedAt = Date.now();
  const picker = $('#project-select'); picker.replaceChildren();
  for (const project of projectList) {
    const option = el('option', '', `${project.name}${!project.available ? ' · unavailable' : project.activeRun ? ' · agent working' : project.attention ? ` · ${project.attention} initiative decisions` : ''}`);
    option.value = project.id; option.disabled = !project.available; option.selected = project.id === selectedProjectId; picker.append(option);
  }
  const active = projectList.filter(project => project.activeRun).length;
  const attention = projectList.reduce((sum, project) => sum + (project.attention || 0), 0);
  $('#project-overview').textContent = `${projectList.length} projects · ${active} active runs · ${attention} initiative decisions`;
}
function writeLocation(values, replace = false) {
  const url = new URL(location.href); url.pathname = '/';
  url.search = ''; url.searchParams.set('project', selectedProjectId);
  url.searchParams.set('view', values.view || activeView);
  for (const key of ['task','record']) if (values[key]) url.searchParams.set(key, values[key]);
  const origin = taskOrigin ? {view:taskOrigin.view,url:taskOrigin.url,scroll:taskOrigin.scroll,initiative:taskOrigin.initiative,initiativeScroll:taskOrigin.initiativeScroll} : null;
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState']({taskOrigin:values.task ? origin : null}, '', url);
}
function nativeClient(id) {
  return createNativeClient({projectId:id, token:() => sharedToken,
    canWrite:() => selectedProjectId === id && connected && !!state && !agentsBusy() && !busy,
    onWrite:delta => { nativeWrites += delta; setBusy(); },
  });
}
function showView(view, updateLocation = true) {
  activeView = views.includes(view) ? view : 'board';
  if (matchMedia('(max-width:760px)').matches) setNavigation(false);
  $('.skip-link').href = `#workspace-${activeView}`;
  $('.skip-link').textContent = 'Skip to workspace content';
  $(`#workspace-${activeView}`).tabIndex = -1;
  for (const name of views) $(`#workspace-${name}`).hidden = name !== activeView;
  for (const tab of document.querySelectorAll('[data-view]')) {
    if (tab.dataset.view === activeView) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  if (updateLocation && selectedProjectId) writeLocation({view:activeView});
  if (!state || activeView === 'board') return;
  if (panels.has(activeView)) return panels.get(activeView);
  const id = selectedProjectId, epoch = projectEpoch, viewName = activeView;
  const api = nativeClient(id), container = $(`#workspace-${viewName}`);
  const options = {api,projectId:id,onClose:taskClosed,onOpenTask:openTask,canWrite:() => id === selectedProjectId && connected && !agentsBusy() && !busy,
    writeBlockedReason:() => id !== selectedProjectId ? 'This project is no longer selected.' : !connected ? 'Connection lost. Editing resumes when the local connection returns.' : agentsBusy() ? 'Editing paused while an agent is active or queued.' : busy ? 'Another operation is in progress. Editing resumes when it finishes.' : '',
    onChange:() => { if (epoch === projectEpoch) { savePageDrafts(); panelRefreshedAt = 0; overviewMilestones.delete(id); void refresh(); } },
    onNavigate:values => { if (epoch === projectEpoch && activeView === viewName) writeLocation(values); },
    onOpenRecord:async ({view,record,anchor}) => {
      if (epoch !== projectEpoch || nativeWrites || busy) return;
      const sourceView = activeView, sourceUrl = location.href, sourceHistory = history.state;
      if (sourceView !== 'tasks') {
        recordReturnPositions.delete(sourceUrl);
        recordReturnPositions.set(sourceUrl,{scroll:window.scrollY,trigger:document.activeElement});
        if (recordReturnPositions.size > 40) recordReturnPositions.delete(recordReturnPositions.keys().next().value);
      }
      try {
        const target = showView(view,false);
        await target.refresh();
        if (epoch !== projectEpoch || activeView !== view) return;
        if (await target.open(record,anchor) === false) throw new Error('The linked record could not be opened. Your reading position has been retained. Try again.');
      } catch (error) {
        if (epoch === projectEpoch && activeView === view) {
          showView(sourceView,false);
          history.replaceState(sourceHistory,'',sourceUrl);
        }
        throw error;
      }
    },
  };
  let panel;
  if (['tasks','drafts'].includes(viewName)) { panel = mountTasks(container,options); if (viewName === 'drafts') panel.setMode('drafts'); else void panel.refresh(); }
  else if (['documents','decisions'].includes(viewName)) panel = mountKnowledge(container,{...options,kind:viewName});
  else if (viewName === 'milestones') { panel = createMilestonePanel({container,...options,projectKey:() => id,drafts:milestoneDrafts,onSaved:options.onChange,onTask:openTask}); void panel.refresh(); }
  else if (viewName === 'skills') panel = mountSkills(container,{request:route => readProject(route,id),onNavigate:options.onNavigate});
  else panel = mountInsights(container,{...options,kind:viewName});
  panels.set(viewName,panel); panelRefreshedAt = Date.now(); return panel;
}
async function switchProject(id, {preserveLocation = false} = {}) {
  if (!id || busy || nativeWrites || (id === selectedProjectId && state)) return;
  if (!projectList.some(project => project.id === id && project.available)) throw new Error('The selected project is unavailable. Choose a connected project.');
  savePageDrafts();
  if (selectedProjectId) projectDrafts.set(selectedProjectId, { drafts, taskDrafts, uatGenerations, title: $('#initiative-title').value, request: $('#initiative-request').value, review: $('#review-mode').checked, filter: $('#filter').value });
  recognition?.abort();
  for (const panel of panels.values()) panel.destroy(); panels.clear();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#connection').textContent = 'Connecting…'; $('#connection').className = 'connection';
  taskOrigin = null;
  recordReturnPositions.clear();
  selectedProjectId = id; projectEpoch++; refreshing = false; selectedId = null; state = null; connected = false;
  const saved = projectDrafts.get(id) || restorePageDrafts(id);
  for (const [key, draft] of saved.milestoneDrafts || []) if (key.startsWith(`${id}:`) && !milestoneDrafts.has(key)) milestoneDrafts.set(key, draft);
  drafts = saved.drafts || new Map(); taskDrafts = saved.taskDrafts || new Map(); uatGenerations = saved.uatGenerations || new Map();
  $('#initiative-title').value = saved.title || ''; $('#initiative-request').value = saved.request || ''; $('#review-mode').checked = saved.review || false; $('#filter').value = saved.filter || '';
  $('#board').replaceChildren(el('p', 'muted', 'Loading project…')); $('#tasks-list').replaceChildren();
  for (const view of views.filter(v => v !== 'board')) $(`#workspace-${view}`).replaceChildren();
  $('#project-select').value = id;
  if (!preserveLocation) writeLocation({view:activeView});
  await refresh(); showView(activeView, false);
}
async function followLocation() {
  const route = workspaceLocation(location.href);
  if (busy || nativeWrites) { writeLocation({view:activeView},true); return; }
  followingRoute = true;
  const priorOrigin = taskOrigin;
  taskOrigin = route.task ? history.state?.taskOrigin || null : null;
  panels.get('tasks')?.closeTask?.({navigate:false});
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (route.project && route.project !== selectedProjectId) await switchProject(route.project,{preserveLocation:true});
  if (route.project && route.project !== selectedProjectId) return;
  const panel = showView(route.view,false);
  if (route.task && route.view === 'tasks' && panel) { await panel.refresh(); await panel.openTask(route.task); }
  else if (route.record && panel?.open) await panel.open(route.record);
  const recordReturn = !route.task && recordReturnPositions.get(location.href);
  // Let the browser finish its history scroll restoration before restoring this reader.
  if (recordReturn) requestAnimationFrame(() => requestAnimationFrame(() => {
    if (recordReturn.trigger?.isConnected && !recordReturn.trigger.closest('[hidden]')) recordReturn.trigger.focus({preventScroll:true});
    window.scrollTo(0,recordReturn.scroll);
  }));
  if (!route.task && priorOrigin?.url === location.href) {
    window.scrollTo(0,priorOrigin.scroll);
    if (priorOrigin.initiative && current() === undefined && state?.initiatives?.some(i => i.id === priorOrigin.initiative)) {openDetail(priorOrigin.initiative,priorOrigin.trigger);$('#detail-dialog').scrollTop = priorOrigin.initiativeScroll;}
  }
  followingRoute = false;
}
window.addEventListener('popstate', () => { void followLocation().catch(error => showError(error.message)).finally(() => {followingRoute = false;}); });
$('#project-select').addEventListener('change', event => { void switchProject(event.target.value).catch(error => showError(error.message)); });
for (const tab of document.querySelectorAll('[data-view]')) tab.addEventListener('click', () => {showView(tab.dataset.view); if (matchMedia('(max-width:760px)').matches) $(`#workspace-${activeView}`).focus({preventScroll:true});});
$('.brand').addEventListener('click', event => { event.preventDefault(); showView('board'); });
$('#add-project').addEventListener('click', () => { showError('', $('#project-error')); $('#project-dialog').showModal(); $('#project-path').focus(); });
$('#project-close').addEventListener('click', () => $('#project-dialog').close());
$('#project-dialog').addEventListener('close', () => $('#add-project').focus());
$('#project-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; setBusy(); $('#project-submit').disabled = true; showError('', $('#project-error'));
  let id;
  try {
    const response = await fetch('/api/projects', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': sharedToken }, body: JSON.stringify({ projectRoot: $('#project-path').value.trim() }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Cannot add the project.');
    id = result.project.id; await loadProjects(); $('#project-dialog').close(); $('#project-form').reset();
  } catch (error) { showError(error.message, $('#project-error')); }
  finally { busy = false; setBusy(); $('#project-submit').disabled = false; }
  if (id) await switchProject(id);
});

// Speech recognition is optional and starts only after a deliberate button click.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  $('#dictation-controls').hidden = false;
  let listening = false;
  $('#dictate').addEventListener('click', () => {
    if (listening) { recognition?.stop(); return; }
    const dictationEpoch = projectEpoch;
    recognition = new SpeechRecognition(); recognition.continuous = true; recognition.interimResults = false; recognition.lang = navigator.language || 'en-AU';
    recognition.onstart = () => { listening = true; $('#dictate').textContent = 'Stop dictation'; $('#dictation-status').textContent = 'Listening…'; };
    recognition.onresult = event => {
      if (dictationEpoch !== projectEpoch) return;
      const field = $('#initiative-request');
      for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) field.value = `${field.value.trim()} ${event.results[index][0].transcript}`.trim().slice(0, 24000);
    };
    recognition.onerror = event => { $('#dictation-status').textContent = `Dictation unavailable (${event.error}). You can keep typing.`; };
    recognition.onend = () => { listening = false; $('#dictate').textContent = 'Use dictation'; if ($('#dictation-status').textContent === 'Listening…') $('#dictation-status').textContent = 'Dictation stopped. Review your text before starting intake.'; };
    try { recognition.start(); } catch { $('#dictation-status').textContent = 'Dictation could not start. You can keep typing.'; }
  });
}
function setNavigation(open, restoreFocus = false) {
  const narrow = matchMedia('(max-width:760px)').matches;
  document.body.classList.toggle('drawer-open',narrow && open);
  document.body.classList.toggle('shell-collapsed',!narrow && !open);
  $('#nav-backdrop').hidden = !narrow || !open;
  $('#nav-toggle').setAttribute('aria-expanded',String(open));
  if (narrow) { $('main').inert = open; $('.topbar').inert = open; }
  else { $('main').inert = false; $('.topbar').inert = false; }
  if (open && narrow) $('#nav-close').focus();
  if (restoreFocus) $('#nav-toggle').focus();
}
$('#nav-toggle').addEventListener('click',() => setNavigation($('#nav-toggle').getAttribute('aria-expanded') !== 'true'));
$('#nav-close').addEventListener('click',() => setNavigation(false,true));
$('#nav-backdrop').addEventListener('click',() => setNavigation(false,true));
document.addEventListener('keydown',event => {
  if (!document.body.classList.contains('drawer-open')) return;
  if (event.key === 'Escape') {event.preventDefault();setNavigation(false,true);}
  if (event.key === 'Tab') {
    const nodes = [...$('#workspace-navigation').querySelectorAll('button,summary')].filter(n => n.getClientRects().length);
    if (event.shiftKey && document.activeElement === nodes[0]) {event.preventDefault();nodes.at(-1).focus();}
    else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {event.preventDefault();nodes[0].focus();}
  }
});
matchMedia('(max-width:760px)').addEventListener('change',event => setNavigation(!event.matches));
setNavigation(!matchMedia('(max-width:760px)').matches);
async function connectWorkspace() {
  try {
    await loadProjects();
    const requestedProject = workspaceLocation(location.href).project;
    const id = requestedProject || projectList.find(project => project.available)?.id;
    if (!id) throw new Error('No connected projects. Add a project to begin.');
    await switchProject(id,{preserveLocation:true});
    await followLocation();
    if (!requestedProject) writeLocation({view:activeView},true);
  } catch (error) { showError(error.message); }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? 'Light' : 'Dark';
  $('#theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme');
  try { localStorage.setItem('switchflow:theme',theme); } catch {}
}
let initialTheme; try { initialTheme = localStorage.getItem('switchflow:theme'); } catch {}
setTheme(initialTheme === 'dark' || (!initialTheme && matchMedia('(prefers-color-scheme:dark)').matches) ? 'dark' : 'light');
$('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
mountSearch({dialog:$('#search-dialog'),trigger:$('#workspace-search'),project:() => selectedProjectId,
  api:(route) => nativeClient(selectedProjectId)(route),initiatives:() => state?.initiatives || [],
  navigate:async item => { if (item.view === 'board') { showView('board'); openDetail(item.id,$('#workspace-search')); } else { const panel = showView(item.view); if (item.task) { await panel.refresh(); await panel.openTask(item.task); } else await panel.open(item.record); } },
});
await connectWorkspace();
setInterval(() => { if (!document.hidden && !busy) { if (selectedProjectId) refresh(); else connectWorkspace(); } }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
