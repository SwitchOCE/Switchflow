// Agents: live and recent provider sessions, the orchestrator → worker tree, a readable
// transcript and a composer that steers the selected session mid-turn.
import { renderMarkdown } from './documents.js';

const providers = {
  claude: { name: 'Claude', mark: 'C' },
  codex: { name: 'Codex', mark: 'X' },
};
const roles = [
  ['intake', 'Intake', 'Shapes the request into a scope you approve.'],
  ['planning', 'Planning', 'Turns approved scope into ordered tasks.'],
  ['execution', 'Phase orchestrator', 'Runs the approved plan and coordinates workers.'],
  ['delivery', 'Task delivery', 'Implements one task in its own worktree.'],
  ['review', 'Review', 'Independently reviews a finished task.'],
  ['uat', 'UAT guide', 'Prepares and walks you through acceptance.'],
];
// starting/working/idle are the service's open states; running/waiting remain for older fixtures.
const live = new Set(['starting', 'working', 'idle', 'running', 'waiting', 'queued']);
const statusLabel = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting for orchestrator',
  running: 'Working',
  waiting: 'Waiting',
  queued: 'Queued',
  completed: 'Done',
  complete: 'Done',
  failed: 'Failed',
  interrupted: 'Stopped',
  cancelled: 'Cancelled',
};
const roleLabel = Object.fromEntries(roles.map(([id, label]) => [id, label]));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function relative(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(time).toLocaleDateString();
}
function duration(start, end) {
  const ms = (Date.parse(end) || Date.now()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  return minutes ? `${minutes}m ${Math.floor((ms % 60000) / 1000)}s` : `${Math.floor(ms / 1000)}s`;
}
function tokens(usage) {
  const total = usage?.totalTokens || (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
  if (!total) return '';
  const text = total >= 1000 ? `${(total / 1000).toFixed(total >= 10000 ? 0 : 1)}k tokens` : `${total} tokens`;
  return usage?.costUsd ? `${text} · $${usage.costUsd.toFixed(2)}` : text;
}
function providerBadge(id) {
  const provider = providers[id] || { name: id || 'Agent', mark: '?' };
  const badge = el('span', `agent-provider provider-${id || 'unknown'}`, provider.mark);
  badge.title = provider.name;
  badge.setAttribute('aria-label', provider.name);
  return badge;
}
function statusPill(status) {
  const pill = el('span', `agent-status status-${status}`, statusLabel[status] || status);
  return pill;
}

const attention = new Set(['failed', 'interrupted']);
const settleAfterMs = 3 * 24 * 60 * 60 * 1000;

export function mountAgents(
  container,
  { request, send, canWrite, writeBlockedReason, onOpenTask, projectId, initiativeTitle = () => '' },
) {
  const taskOf = session => session.task || session.taskId || null;
  const titleOf = session => {
    if (session.title) return session.title;
    const task = taskOf(session);
    if (session.kind === 'deliver') return `Deliver ${task}`;
    if (session.kind === 'review')
      return `Review ${task}${session.reviewRound > 1 ? ` · round ${session.reviewRound}` : ''}`;
    const initiative = initiativeTitle(session.initiativeId);
    return [roleLabel[session.role] || 'Agent', initiative].filter(Boolean).join(' · ');
  };
  const steerable = session => session.canSteer ?? live.has(session.status);
  const interruptible = session => session.canInterrupt ?? live.has(session.status);
  // Settling is a per-browser inbox marker: it hides a handled session and never changes project records.
  const settleKey = `switchflow:settled:${projectId || 'project'}`;
  let settled = {};
  try {
    settled = JSON.parse(localStorage.getItem(settleKey) || '{}');
  } catch {}
  const isSettled = session =>
    !!settled[session.id] ||
    (!live.has(session.status) &&
      !attention.has(session.status) &&
      Date.now() - Date.parse(session.updatedAt || session.startedAt || 0) > settleAfterMs);
  function setSettled(session, value) {
    if (value) settled[session.id] = Date.now();
    else delete settled[session.id];
    try {
      localStorage.setItem(settleKey, JSON.stringify(settled));
    } catch {}
    renderList();
    const head = renderHead(session);
    headNode?.replaceWith(head);
    headNode = head;
  }
  let data = null;
  let selected = null;
  let events = [];
  let eventsFor = null;
  let after = 0;
  let timer = null;
  let streamTimer = null;
  let destroyed = false;
  let pinnedToBottom = true;
  let sending = false;
  let showRouting = false;
  let feedNode = null;
  let headNode = null;
  let renderedFor = null;
  let settledOpen = false;

  container.replaceChildren();
  const header = el('header', 'agents-header');
  const titles = el('div');
  titles.append(
    el('h1', '', 'Agents'),
    el('p', 'muted', 'Every Claude and Codex session for this project. Message one to steer it while it works.'),
  );
  const providerChips = el('div', 'agents-providers');
  const routingToggle = el('button', 'button quiet', 'Routing');
  routingToggle.type = 'button';
  routingToggle.setAttribute('aria-expanded', 'false');
  routingToggle.addEventListener('click', () => {
    showRouting = !showRouting;
    routingToggle.setAttribute('aria-expanded', String(showRouting));
    renderRouting();
  });
  const headerTools = el('div', 'agents-header-tools');
  headerTools.append(providerChips, routingToggle);
  header.append(titles, headerTools);

  const routing = el('section', 'agents-routing');
  routing.hidden = true;
  routing.setAttribute('aria-label', 'Provider routing');

  const message = el('p', 'agents-message');
  message.setAttribute('role', 'status');

  const layout = el('div', 'agents-layout');
  const list = el('nav', 'agents-list');
  list.setAttribute('aria-label', 'Agent sessions');
  const detail = el('section', 'agents-detail');
  detail.setAttribute('aria-live', 'off');
  layout.append(list, detail);
  container.append(header, routing, message, layout);

  function sessions() {
    return Array.isArray(data?.sessions) ? data.sessions : [];
  }
  function current() {
    return sessions().find(session => session.id === selected) || null;
  }
  function childrenOf(id) {
    return sessions().filter(session => (session.parentId || null) === id);
  }

  function renderProviders() {
    providerChips.replaceChildren();
    for (const [id, provider] of Object.entries(providers)) {
      const info = data?.providers?.[id] || {};
      const ready = info.available !== false && info.loggedIn !== false && (info.available || info.version);
      const chip = el('span', `agents-provider-chip ${ready ? 'ready' : 'unavailable'}`);
      chip.append(providerBadge(id), el('span', '', provider.name));
      const detailText = !info.available
        ? 'Not installed'
        : info.loggedIn === false
          ? 'Not signed in'
          : info.version
            ? String(info.version).replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1')
            : 'Ready';
      chip.append(el('small', '', detailText));
      chip.title = `${provider.name}: ${detailText}`;
      providerChips.append(chip);
    }
  }

  function sessionRow(session, depth) {
    const row = el('button', 'agents-row');
    row.type = 'button';
    row.dataset.session = session.id;
    row.style.setProperty('--depth', depth);
    if (session.id === selected) row.setAttribute('aria-current', 'true');
    const top = el('span', 'agents-row-top');
    top.append(providerBadge(session.provider), el('strong', '', titleOf(session)));
    const meta = el('span', 'agents-row-meta');
    meta.append(
      statusPill(session.status),
      el('span', '', [roleLabel[session.role] || session.role, taskOf(session)].filter(Boolean).join(' · ')),
      el(
        'span',
        'agents-row-time',
        live.has(session.status) ? duration(session.startedAt) : relative(session.updatedAt),
      ),
    );
    row.append(top, meta);
    if (session.lastMessage) row.append(el('span', 'agents-row-last', session.lastMessage));
    row.addEventListener('click', () => select(session.id));
    return row;
  }

  function renderList() {
    const focused = document.activeElement?.closest?.('.agents-row')?.dataset.session;
    list.replaceChildren();
    const all = sessions();
    if (!all.length) {
      const empty = el('div', 'agents-empty');
      empty.append(
        el('strong', '', 'No agent sessions yet'),
        el('p', 'muted', 'Sessions appear here when an initiative starts intake, planning or delivery.'),
      );
      list.append(empty);
      return;
    }
    const roots = all.filter(session => !session.parentId || !all.some(other => other.id === session.parentId));
    const tree = session => [session, ...childrenOf(session.id)];
    const bucket = session => {
      const family = tree(session);
      if (family.some(s => attention.has(s.status) && !settled[s.id])) return 'Needs you';
      if (family.some(s => live.has(s.status))) return 'Running';
      return family.every(isSettled) ? 'Settled' : 'Done';
    };
    const groups = ['Needs you', 'Running', 'Done', 'Settled'].map(title => [
      title,
      roots.filter(session => bucket(session) === title),
    ]);
    for (const [title, members] of groups) {
      if (!members.length) continue;
      const group = el(
        title === 'Settled' ? 'details' : 'div',
        `agents-group group-${title.toLowerCase().replace(/\s+/g, '-')}`,
      );
      if (title === 'Settled') {
        group.open = settledOpen || members.some(m => tree(m).some(s => s.id === selected));
        group.addEventListener('toggle', () => {
          settledOpen = group.open;
        });
        const summary = el('summary', 'agents-group-title', `Settled · ${members.length}`);
        group.append(summary);
        const walk = (session, depth) => {
          group.append(sessionRow(session, depth));
          for (const child of childrenOf(session.id)) walk(child, depth + 1);
        };
        members.forEach(session => walk(session, 0));
        list.append(group);
        continue;
      }
      group.append(el('h2', 'agents-group-title', `${title} · ${members.length}`));
      const walk = (session, depth) => {
        group.append(sessionRow(session, depth));
        for (const child of childrenOf(session.id)) walk(child, depth + 1);
      };
      members
        .sort((a, b) => Date.parse(b.updatedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.startedAt || 0))
        .forEach(session => walk(session, 0));
      list.append(group);
    }
    if (focused) list.querySelector(`[data-session="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function eventNode(event) {
    const kind = event.kind || event.type;
    const source = event.by || event.source || (kind === 'steer' ? 'owner' : 'agent');
    if (kind === 'message' || kind === 'steer') {
      const bubble = el('article', `agents-msg from-${source}${event.final ? ' final' : ''}`);
      const by =
        source === 'owner'
          ? 'You'
          : source === 'orchestrator'
            ? 'Orchestrator'
            : providers[event.provider || current()?.provider]?.name || 'Agent';
      const head = el('header');
      head.append(el('strong', '', by), el('time', '', relative(event.at)));
      if (kind === 'steer')
        head.append(el('span', 'agents-tag', { followup: 'Follow-up', queue: 'Queued' }[event.mode] || 'Steer'));
      const body = el('div', 'docs-prose');
      body.innerHTML = renderMarkdown(String(event.text || '')).html;
      bubble.append(head, body);
      return bubble;
    }
    if (['tool', 'command', 'file_change'].includes(kind)) {
      const line = el('div', `agents-op op-${kind}`);
      const label = kind === 'command' ? '$' : kind === 'file_change' ? '±' : '⚙';
      line.append(
        el('span', 'agents-op-icon', label),
        el(
          'code',
          '',
          kind === 'command'
            ? event.command || event.text
            : kind === 'file_change'
              ? (event.paths || []).join(', ') || event.text
              : [event.name, event.summary].filter(Boolean).join(' · ') || event.text || kind,
        ),
      );
      if (event.exitCode !== undefined && event.exitCode !== null && event.exitCode !== 0)
        line.append(el('span', 'agents-op-fail', `exit ${event.exitCode}`));
      return line;
    }
    const note = el(
      'div',
      `agents-note note-${kind}${['turn.failed', 'stderr', 'error'].includes(kind) || event.level === 'error' ? ' is-error' : event.level === 'warning' ? ' is-warning' : ''}`,
    );
    const text =
      event.text ||
      {
        'session.started': 'Session started',
        'turn.started': 'Turn started',
        'turn.completed': `Turn finished${tokens(event.usage) ? ` · ${tokens(event.usage)}` : ''}`,
        'turn.failed': `Turn failed${event.error ? `: ${event.error}` : ''}`,
        interrupt: event.by === 'orchestrator' ? 'Stopped by the orchestrator' : 'Stopped',
        'session.closed': 'Session closed',
      }[kind] ||
      kind;
    note.append(el('span', '', text), el('time', '', relative(event.at)));
    return note;
  }

  function renderDetail() {
    const session = current();
    detail.replaceChildren();
    feedNode = headNode = null;
    renderedFor = session ? `${session.id}:${session.status}` : null;
    if (!session) {
      const empty = el('div', 'agents-empty agents-detail-empty');
      empty.append(
        el('strong', '', sessions().length ? 'Select a session' : 'Nothing running'),
        el('p', 'muted', 'Choose a session to read its transcript and steer it.'),
      );
      detail.append(empty);
      return;
    }
    headNode = renderHead(session);
    const feed = el('div', 'agents-feed');
    feed.tabIndex = 0;
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-label', 'Session transcript');
    feed.addEventListener('scroll', () => {
      pinnedToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    });
    if (eventsFor !== session.id) feed.append(el('p', 'muted agents-loading', 'Loading transcript…'));
    else if (!events.length) feed.append(el('p', 'muted', 'No activity recorded yet.'));
    else for (const event of events) feed.append(eventNode(event));
    feedNode = feed;
    detail.append(headNode, feed, composer(session));
    if (pinnedToBottom) feed.scrollTop = feed.scrollHeight;
  }
  function appendEvents(incoming) {
    if (!feedNode) return renderDetail();
    if (incoming.length) feedNode.querySelector(':scope > p.muted')?.remove();
    for (const event of incoming) feedNode.append(eventNode(event));
    while (feedNode.childElementCount > 500) feedNode.firstElementChild.remove();
    if (pinnedToBottom) feedNode.scrollTop = feedNode.scrollHeight;
  }
  function renderHead(session) {
    const head = el('header', 'agents-detail-head');
    const title = el('div');
    const h2 = el('h2');
    h2.append(providerBadge(session.provider), document.createTextNode(titleOf(session)));
    const facts = el('p', 'agents-facts');
    const parent = sessions().find(other => other.id === session.parentId);
    facts.append(
      statusPill(session.status),
      el('span', '', roleLabel[session.role] || session.role || ''),
      ...(session.model ? [el('span', '', session.model)] : []),
      ...(session.startedAt
        ? [el('span', '', duration(session.startedAt, live.has(session.status) ? null : session.updatedAt))]
        : []),
      ...(tokens(session.usage) ? [el('span', '', tokens(session.usage))] : []),
    );
    title.append(h2, facts);
    if (session.fallback)
      title.append(
        el(
          'p',
          'agents-fallback',
          `Ran on ${providers[session.fallback.to]?.name || session.fallback.to}: ${session.fallback.reason}.`,
        ),
      );
    if (session.error && !live.has(session.status)) title.append(el('p', 'agents-error', session.error));
    const actions = el('div', 'agents-detail-actions');
    if (taskOf(session) && onOpenTask) {
      const open = el('button', 'button quiet', `Open ${taskOf(session)}`);
      open.type = 'button';
      open.addEventListener('click', () => onOpenTask(taskOf(session)));
      actions.append(open);
    }
    if (parent) {
      const up = el('button', 'button quiet', 'Orchestrator');
      up.type = 'button';
      up.title = `Go to ${parent.title || 'orchestrator'}`;
      up.addEventListener('click', () => select(parent.id));
      actions.append(up);
    }
    if (!live.has(session.status)) {
      const done = !!settled[session.id];
      const settle = el('button', 'button quiet', done ? 'Unsettle' : 'Settle');
      settle.type = 'button';
      settle.title = done ? 'Move back to your inbox' : 'Mark handled and move out of your inbox';
      settle.addEventListener('click', () => setSettled(session, !done));
      actions.append(settle);
    }
    if (interruptible(session)) {
      const stop = el('button', 'button danger', 'Stop');
      stop.type = 'button';
      stop.dataset.stop = '';
      stop.addEventListener('click', () => interrupt(session));
      actions.append(stop);
    }
    head.append(title, actions);
    return head;
  }

  function composer(session) {
    const form = el('form', 'agents-composer');
    const field = el('textarea');
    field.rows = 2;
    field.maxLength = 20000;
    field.setAttribute('aria-label', `Message ${providers[session.provider]?.name || 'agent'}`);
    const working = ['working', 'running', 'starting'].includes(session.status);
    const blocked = !canWrite() ? writeBlockedReasonFor() : '';
    const unavailable = !steerable(session)
      ? session.transport === 'exec'
        ? 'This session runs through codex exec, which cannot take messages.'
        : live.has(session.status)
          ? 'This session cannot take a message right now.'
          : 'This session has ended. Add an update on its initiative instead.'
      : '';
    let mode = 'steer';
    const modes = el('div', 'segmented agents-mode');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'When the agent reads it');
    if (working)
      for (const [value, label, help] of [
        ['steer', 'Steer now', 'Read at its next step, inside the current turn.'],
        ['queue', 'Queue', 'Held until the current turn finishes.'],
      ]) {
        const option = el('button', '', label);
        option.type = 'button';
        option.title = help;
        option.setAttribute('aria-pressed', String(mode === value));
        option.addEventListener('click', () => {
          mode = value;
          for (const other of modes.children) other.setAttribute('aria-pressed', String(other === option));
          field.placeholder = placeholder();
        });
        modes.append(option);
      }
    const placeholder = () =>
      !working
        ? 'Send a follow-up turn. Ctrl+Enter to send.'
        : mode === 'steer'
          ? 'Steer this agent; it reads your message at its next step. Ctrl+Enter to send.'
          : 'Queue a message for when this turn finishes. Ctrl+Enter to send.';
    field.placeholder = placeholder();
    const draftKey = `switchflow:agent-draft:${session.id}`;
    try {
      field.value = sessionStorage.getItem(draftKey) || '';
    } catch {}
    field.addEventListener('input', () => {
      try {
        sessionStorage.setItem(draftKey, field.value);
      } catch {}
    });
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const submit = el('button', 'button primary', 'Send');
    submit.type = 'submit';
    const hint = el('p', 'agents-composer-hint');
    hint.textContent = blocked || unavailable;
    const disabled = !!(blocked || unavailable) || sending;
    field.disabled = disabled;
    submit.disabled = disabled;
    for (const option of modes.children) option.disabled = disabled;
    const row = el('div', 'agents-composer-row');
    row.append(field, submit);
    form.append(row);
    const foot = el('div', 'agents-composer-foot');
    if (modes.childElementCount) foot.append(modes);
    foot.append(hint);
    form.append(foot);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const text = field.value.trim();
      if (!text || sending) return;
      sending = true;
      submit.disabled = true;
      hint.textContent = 'Sending…';
      try {
        const result = await send(`/agents/${encodeURIComponent(session.id)}/steer`, 'POST', {
          message: text,
          ...(working ? { mode } : {}),
        });
        field.value = '';
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
        hint.textContent = {
          followup: 'Sent as a follow-up turn.',
          queue: 'Queued for when this turn finishes.',
          steer: 'Sent. The agent reads it at its next step.',
        }[result?.mode || 'steer'];
        pinnedToBottom = true;
        await loadEvents(true);
      } catch (error) {
        hint.textContent = `${error.message} Your message is kept.`;
      } finally {
        sending = false;
        submit.disabled = false;
      }
    });
    return form;
  }
  function writeBlockedReasonFor() {
    const reason = writeBlockedReason?.() || '';
    // Steering is the point of a live session, so the agent-busy write fence does not apply here.
    return /agent is active/.test(reason) ? '' : reason;
  }

  async function interrupt(session) {
    if (!confirm(`Stop ${session.title || 'this session'}? Its current turn ends; the transcript is kept.`)) return;
    try {
      await send(`/agents/${encodeURIComponent(session.id)}/interrupt`, 'POST', {});
      message.textContent = 'Stop requested.';
      await refresh();
    } catch (error) {
      message.textContent = error.message;
    }
  }

  function renderRouting() {
    routing.hidden = !showRouting;
    if (!showRouting) return;
    routing.replaceChildren();
    const settings = data?.settings || { roles: {}, limits: {} };
    const form = el('form', 'agents-routing-form');
    const intro = el('div', 'agents-routing-intro');
    intro.append(
      el('h2', '', 'Who does what'),
      el(
        'p',
        'muted',
        'Pick a provider for each role. Review always uses a different provider from the author unless you choose one. Changes apply to the next run.',
      ),
    );
    const grid = el('div', 'agents-routing-grid');
    for (const [id, label, help] of roles) {
      const row = el('label', 'agents-route');
      const text = el('span');
      text.append(el('strong', '', label), el('small', '', help));
      const select = el('select');
      select.name = id;
      const options =
        id === 'review'
          ? [['auto', 'Other provider'], ...Object.entries(providers).map(([k, v]) => [k, v.name])]
          : Object.entries(providers).map(([k, v]) => [k, v.name]);
      for (const [value, name] of options) {
        const option = el('option', '', name);
        option.value = value;
        option.selected = (settings.roles?.[id] || (id === 'review' ? 'auto' : '')) === value;
        select.append(option);
      }
      const effective = data?.routing?.[id];
      if (effective?.error) text.append(el('small', 'agents-route-error', effective.error));
      else if (effective?.fallback)
        text.append(
          el(
            'small',
            'agents-route-fallback',
            `Using ${providers[effective.fallback.to]?.name || effective.fallback.to}: ${effective.fallback.reason}`,
          ),
        );
      row.append(text, select);
      grid.append(row);
    }
    const limits = el('div', 'agents-routing-limits');
    const number = (name, label, min, max) => {
      const wrap = el('label', '', label);
      const input = el('input');
      input.type = 'number';
      input.name = name;
      input.min = min;
      input.max = max;
      input.value = settings.limits?.[name] ?? '';
      wrap.append(input);
      return wrap;
    };
    limits.append(
      number('maxWorkers', 'Parallel workers', 1, 8),
      number('maxReviewRounds', 'Review rounds', 1, 5),
      number('timeoutMinutes', 'Run timeout (min)', 1, 1440),
      number('maxTurns', 'Turn limit', 1, 1000),
    );
    const footer = el('div', 'agents-routing-footer');
    const status = el('span', 'muted');
    status.setAttribute('role', 'status');
    const blocked = !canWrite() ? writeBlockedReason?.() || 'Editing is unavailable.' : '';
    const save = el('button', 'button primary', 'Save routing');
    save.type = 'submit';
    save.disabled = !!blocked;
    status.textContent = blocked;
    footer.append(status, save);
    form.append(intro, grid, limits, footer);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(form);
      const next = {
        roles: Object.fromEntries(roles.map(([id]) => [id, values.get(id)])),
        ...(Number.isInteger(settings.revision) ? { expectedRevision: settings.revision } : {}),
        limits: Object.fromEntries(
          ['maxWorkers', 'maxReviewRounds', 'timeoutMinutes', 'maxTurns']
            .filter(name => values.get(name) !== '')
            .map(name => [name, Number(values.get(name))]),
        ),
      };
      save.disabled = true;
      status.textContent = 'Saving…';
      try {
        const saved = await send('/agents/settings', 'PUT', next);
        data = { ...data, settings: saved?.settings || next, routing: saved?.routing || data?.routing };
        renderRouting();
        status.textContent = 'Saved. Applies to the next run.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    routing.append(form);
  }

  async function loadEvents(force = false) {
    const id = selected;
    if (!id) return;
    if (eventsFor !== id) {
      events = [];
      after = 0;
    }
    try {
      const page = await request(`/agents/${encodeURIComponent(id)}/events?after=${after}`);
      if (destroyed || id !== selected) return;
      const incoming = Array.isArray(page?.events) ? page.events : [];
      const first = eventsFor !== id;
      eventsFor = id;
      events = events.concat(incoming).slice(-500);
      after = page?.nextAfter ?? incoming.at(-1)?.seq ?? after;
      if (first || !feedNode) renderDetail();
      else if (incoming.length || force) appendEvents(incoming);
    } catch (error) {
      if (id === selected) message.textContent = `Transcript unavailable: ${error.message}`;
    }
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    pinnedToBottom = true;
    eventsFor = null;
    renderList();
    renderDetail();
    void loadEvents();
    schedule();
  }

  function schedule() {
    clearTimeout(streamTimer);
    if (destroyed) return;
    const session = current();
    if (session && live.has(session.status))
      streamTimer = setTimeout(async () => {
        if (!document.hidden) await loadEvents();
        schedule();
      }, 1500);
  }

  async function refresh() {
    try {
      const next = await request('/agents');
      if (destroyed) return;
      data = next;
      message.textContent = data?.notice || '';
      if (!selected || !current()) {
        const pick =
          sessions().find(session => attention.has(session.status) && !settled[session.id]) ||
          sessions().find(session => live.has(session.status)) ||
          sessions()[0];
        selected = pick?.id || null;
        eventsFor = null;
      }
      renderProviders();
      renderList();
      if (showRouting && !routing.contains(document.activeElement)) renderRouting();
      const key = current() ? `${current().id}:${current().status}` : null;
      if (key !== renderedFor) {
        renderDetail();
        void loadEvents();
      } else if (headNode && current() && !headNode.contains(document.activeElement)) {
        const head = renderHead(current());
        headNode.replaceWith(head);
        headNode = head;
      }
      schedule();
    } catch (error) {
      if (destroyed) return;
      message.textContent = `Agent sessions are unavailable: ${error.message}`;
      if (!data) {
        renderProviders();
        renderList();
        renderDetail();
      }
    }
  }

  timer = setInterval(() => {
    if (!document.hidden && container.isConnected && !container.closest('[hidden]')) void refresh();
  }, 3000);
  void refresh();
  return {
    refresh,
    open: id => select(id),
    destroy() {
      destroyed = true;
      clearInterval(timer);
      clearTimeout(streamTimer);
    },
  };
}
