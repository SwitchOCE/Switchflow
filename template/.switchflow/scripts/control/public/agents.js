// Agents: live and recent provider sessions, the orchestrator → worker tree, a readable
// transcript and a composer that steers the selected session mid-turn.
import { renderMarkdown } from './documents.js';
import { createRefreshControl } from './refresh-control.js';

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
// Workers that can run in another environment (agent-settings PLACEABLE_ROLES).
const placeable = [
  ['delivery', 'Task delivery workers'],
  ['review', 'Review workers'],
];
const sshFields = [
  ['id', 'Name (id)', 'text', 'wsl-box'],
  ['label', 'Label', 'text', 'WSL box'],
  ['host', 'Host', 'text', 'localhost'],
  ['port', 'Port', 'number', '22'],
  ['user', 'User', 'text', 'me'],
  ['identityFile', 'Private key file (absolute path)', 'text', 'C:\\Users\\me\\.ssh\\id_ed25519'],
  ['workRoot', 'Work root on the box', 'text', '/home/me/switchflow'],
  ['wake', 'Wake command (optional)', 'text', 'wsl.exe -d Ubuntu -- true'],
];

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
// The detail pane redraws when the session's status or approach gate changes.
const renderKey = session => (session ? `${session.id}:${session.status}:${session.approval ?? ''}` : null);
// A delivery worker whose approach waits for confirmation is idle but cannot write yet.
const awaitingApproach = session => session?.approval === 'awaiting-confirmation' && session.status === 'idle';
function statusPill(status, session) {
  if (awaitingApproach(session))
    return el('span', 'agent-status status-approach', 'Approach ready · waiting for confirmation');
  const pill = el('span', `agent-status status-${status}`, statusLabel[status] || status);
  return pill;
}

const attention = new Set(['failed', 'interrupted']);
const settleAfterMs = 3 * 24 * 60 * 60 * 1000;

export function mountAgents(
  container,
  { request, send, canWrite, writeBlockedReason, onOpenTask, onOpenInitiative, projectId, initiativeTitle = () => '' },
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
  let composerControls = null;

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
  const refreshControl = createRefreshControl(() => refresh());
  const headerTools = el('div', 'agents-header-tools');
  headerTools.append(providerChips, routingToggle, refreshControl.create());
  header.append(titles, headerTools);

  const routing = el('section', 'agents-routing');
  routing.hidden = true;
  routing.setAttribute('aria-label', 'Provider routing');

  // Machine capacity: memory, admitted and queued workers, and leases on shared resources.
  const capacityStrip = el('section', 'agents-capacity');
  capacityStrip.hidden = true;
  capacityStrip.setAttribute('aria-label', 'Capacity');

  const message = el('p', 'agents-message');
  message.setAttribute('role', 'status');

  const layout = el('div', 'agents-layout');
  const list = el('nav', 'agents-list');
  list.setAttribute('aria-label', 'Agent sessions');
  const detail = el('section', 'agents-detail');
  detail.setAttribute('aria-live', 'off');
  layout.append(list, detail);
  container.append(header, capacityStrip, routing, message, layout);
  // Phones show one pane at a time; the page header compacts while a session is open.
  const setPane = pane => {
    layout.dataset.pane = pane;
    container.dataset.agentsPane = pane;
  };
  setPane('list');

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

  const kindLabel = kind => ({ deliver: 'delivery', review: 'review', orchestrator: 'orchestrator' })[kind] || kind;
  const gb = value => `${Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  function renderCapacity() {
    const capacity = data?.capacity;
    capacityStrip.hidden = !capacity?.memory;
    if (capacityStrip.hidden) return;
    capacityStrip.replaceChildren();
    const { memory, workers = {}, queue = [], leases = [], resources = [] } = capacity;
    const row = el('div', 'capacity-row');

    const used = memory.totalGB ? Math.min(1, Math.max(0, 1 - memory.freeGB / memory.totalGB)) : 0;
    const memoryItem = el('div', 'capacity-item');
    const bar = el('span', `capacity-bar${used > 0.85 ? ' is-high' : ''}`);
    const fill = el('span', 'capacity-bar-fill');
    // CSSOM, not a style attribute, so the page's CSP holds.
    fill.style.setProperty('--used', used.toFixed(3));
    bar.append(fill);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${Math.round(used * 100)}% of memory in use`);
    memoryItem.append(
      el('span', 'capacity-label', 'Memory'),
      bar,
      el('span', '', `${gb(memory.freeGB)} free of ${gb(memory.totalGB)}`),
    );
    memoryItem.title = memory.admission
      ? `New workers need ${gb(memory.workerIdleGB)} (${gb(memory.workerGatingGB)} while gating). Available after ${gb(memory.headroomGB)} headroom${memory.reservedGB ? ` and ${gb(memory.reservedGB)} reserved` : ''}: ${gb(Math.max(0, memory.availableGB))}.`
      : 'Memory admission is off in this project’s capacity profile.';

    const workerItem = el('div', 'capacity-item');
    workerItem.append(
      el('span', 'capacity-label', 'Workers'),
      el('span', '', `${workers.admitted ?? 0} running`),
      ...(workers.queued ? [el('span', 'capacity-queued', `${workers.queued} queued`)] : []),
    );
    if (workers.maxWorkers)
      workerItem.title = `At most ${workers.maxWorkers} work at once (Routing → Parallel workers).`;

    const leaseItem = el('div', 'capacity-item');
    leaseItem.append(el('span', 'capacity-label', 'Leases'));
    for (const resource of resources) {
      if (resource.name === 'suite' && !resource.held) continue;
      const chip = el(
        'span',
        `capacity-chip${resource.held >= resource.count ? ' is-full' : resource.held ? ' is-held' : ''}`,
        `${resource.name} ${resource.held}/${resource.count}`,
      );
      chip.title = `${resource.name}: ${resource.held} of ${resource.count} held${resource.waiting ? `, ${resource.waiting} waiting` : ''}${resource.gating ? '. Gating: holding it reserves gate memory.' : '.'}`;
      leaseItem.append(chip);
    }
    row.append(memoryItem, workerItem, leaseItem);
    capacityStrip.append(row);

    if (queue.length || leases.length) {
      const details = el('ul', 'capacity-list');
      for (const entry of queue) {
        const item = el('li');
        item.append(
          el('span', 'agent-status status-queued', `Queued #${entry.position}`),
          el('strong', '', `${entry.task} ${kindLabel(entry.kind)}`),
          el('span', 'muted', entry.reason || 'Waiting for capacity'),
        );
        details.append(item);
      }
      for (const lease of leases) {
        const item = el('li');
        item.append(
          el('span', 'capacity-chip is-held', lease.name),
          el('strong', '', lease.kind === 'orchestrator' ? 'Orchestrator' : `${lease.task} ${kindLabel(lease.kind)}`),
          el('span', 'muted', `${lease.minutesLeft} min left`),
        );
        details.append(item);
      }
      capacityStrip.append(details);
    }
    if (capacity.profile?.error)
      capacityStrip.append(el('p', 'capacity-error', `Using default capacity settings: ${capacity.profile.error}`));
  }

  function environmentLabel(id) {
    if (!id || id === 'local') return 'This PC';
    return (data?.environments || []).find(environment => environment.id === id)?.label || id;
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
      statusPill(session.status, session),
      el('span', '', [roleLabel[session.role] || session.role, taskOf(session)].filter(Boolean).join(' · ')),
      ...(session.environment && session.environment !== 'local'
        ? [el('span', 'agents-env-chip', `on ${environmentLabel(session.environment)}`)]
        : []),
      el(
        'span',
        'agents-row-time',
        live.has(session.status) ? duration(session.startedAt) : relative(session.updatedAt),
      ),
    );
    row.append(top, meta);
    if (session.lastMessage) row.append(el('span', 'agents-row-last', session.lastMessage));
    row.addEventListener('click', () => {
      select(session.id);
      setPane('detail');
      detail.querySelector('h2')?.focus?.({ preventScroll: true });
    });
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
        head.append(
          el(
            'span',
            'agents-tag',
            event.confirm ? 'Confirmed approach' : { followup: 'Follow-up', queue: 'Queued' }[event.mode] || 'Steer',
          ),
        );
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
    renderedFor = renderKey(session);
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
    const back = el('button', 'button quiet agents-back', '← Sessions');
    back.type = 'button';
    back.addEventListener('click', () => {
      setPane('list');
      list.querySelector(`[data-session="${CSS.escape(session.id)}"]`)?.focus({ preventScroll: true });
    });
    title.append(back);
    const h2 = el('h2');
    h2.tabIndex = -1;
    h2.append(providerBadge(session.provider), document.createTextNode(titleOf(session)));
    const facts = el('p', 'agents-facts');
    const parent = sessions().find(other => other.id === session.parentId);
    facts.append(
      statusPill(session.status, session),
      el('span', '', roleLabel[session.role] || session.role || ''),
      el('span', 'agents-env-fact', `Runs on ${environmentLabel(session.environment)}`),
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
      const settle = el('button', 'button quiet', done ? 'Return to inbox' : 'Mark handled');
      settle.type = 'button';
      settle.title = done ? 'Move back to your inbox' : 'Move out of your inbox';
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
    composerControls = null;
    if (!live.has(session.status) && !steerable(session)) {
      const ended = el('div', 'agents-ended');
      const canOpen = !!(session.initiativeId && onOpenInitiative && initiativeTitle(session.initiativeId));
      ended.append(
        el(
          'p',
          '',
          session.status === 'failed' || session.status === 'interrupted'
            ? `This session has ended. Retry or add an update on its initiative${canOpen ? '' : ' in Overview'} to continue.`
            : `This session has ended. Add an update on its initiative${canOpen ? '' : ' in Overview'} to give the next run more direction.`,
        ),
      );
      if (canOpen) {
        const open = el('button', 'button quiet', 'Open initiative →');
        open.type = 'button';
        open.title = initiativeTitle(session.initiativeId);
        open.addEventListener('click', () => onOpenInitiative(session.initiativeId));
        ended.append(open);
      }
      return ended;
    }
    const form = el('form', 'agents-composer');
    const field = el('textarea');
    field.rows = 2;
    field.maxLength = 20000;
    field.setAttribute('aria-label', `Message ${providers[session.provider]?.name || 'agent'}`);
    const working = ['working', 'running', 'starting'].includes(session.status);
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
    // The owner can approve a delivery worker's approach, which unlocks its edits.
    let confirmBox = null;
    const confirmLabel = el('label', 'checkbox-label agents-confirm');
    if (awaitingApproach(session)) {
      confirmBox = el('input');
      confirmBox.type = 'checkbox';
      confirmLabel.append(confirmBox, el('span', '', 'Confirm approach and allow edits'));
    }
    const hint = el('p', 'agents-composer-hint');
    hint.textContent = unavailable;
    // Above the field so a reason or a failure is read before the next attempt.
    const blockedNote = el('p', 'agents-composer-blocked');
    blockedNote.setAttribute('role', 'status');
    const errorNote = el('p', 'agents-composer-error');
    errorNote.setAttribute('role', 'alert');
    field.disabled = !!unavailable;
    const row = el('div', 'agents-composer-row');
    row.append(field, submit);
    form.append(blockedNote, errorNote, row);
    const foot = el('div', 'agents-composer-foot');
    if (modes.childElementCount) foot.append(modes);
    if (confirmBox) foot.append(confirmLabel);
    foot.append(hint);
    form.append(foot);
    composerControls = { form, submit, modes, blockedNote, unavailable };
    updateComposerAccess();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const text = field.value.trim();
      if (!text || sending) return;
      updateComposerAccess();
      if (unavailable || blockedNote.textContent) return;
      sending = true;
      submit.disabled = true;
      errorNote.textContent = '';
      hint.textContent = 'Sending…';
      try {
        const result = await send(`/agents/${encodeURIComponent(session.id)}/steer`, 'POST', {
          message: text,
          ...(working ? { mode } : {}),
          ...(confirmBox?.checked ? { confirm: true } : {}),
        });
        field.value = '';
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
        hint.textContent = result?.confirmed
          ? 'Approach confirmed. The worker may now edit.'
          : {
              followup: 'Sent as a follow-up turn.',
              queue: 'Queued for when this turn finishes.',
              steer: 'Sent. The agent reads it at its next step.',
            }[result?.mode || 'steer'];
        pinnedToBottom = true;
        await loadEvents(true);
      } catch (error) {
        hint.textContent = '';
        const reason = String(error.message || 'The request failed').trim();
        errorNote.textContent = `Not sent: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Your message is kept.`;
      } finally {
        sending = false;
        updateComposerAccess();
      }
    });
    return form;
  }
  // Writes can stop (offline, another operation) after the composer was drawn; keep Send honest.
  function updateComposerAccess() {
    const controls = composerControls;
    if (!controls?.form.isConnected) return;
    const reason = controls.unavailable ? '' : !canWrite() ? writeBlockedReasonFor() : '';
    const text = reason ? `Sending is paused. ${reason}` : '';
    if (controls.blockedNote.textContent !== text) controls.blockedNote.textContent = text;
    const disabled = !!(controls.unavailable || reason) || sending;
    controls.submit.disabled = disabled;
    controls.submit.title = reason;
    for (const option of controls.modes.children) option.disabled = !!(controls.unavailable || reason);
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
    const blocked = !canWrite()
      ? writeBlockedReason?.() || 'Editing is unavailable.'
      : data?.activeRun
        ? 'Routing is locked while an agent run is active. Change it when the run finishes.'
        : '';
    const save = el('button', 'button primary', 'Save routing');
    save.type = 'submit';
    save.disabled = !!blocked;
    for (const control of [...grid.querySelectorAll('select'), ...limits.querySelectorAll('input')])
      control.disabled = !!blocked;
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
    routing.append(form, renderEnvironments(blocked));
  }

  // Environments: where workers run. The owner's settings live in the service, not the checkout.
  let environmentDraft = null;
  let environmentEditing = null;
  const environmentTests = {};
  function renderEnvironments(blocked) {
    const settings = data?.settings || {};
    environmentDraft ??= structuredClone(settings.environments || []);
    const form = el('form', 'agents-environments');
    const intro = el('div', 'agents-routing-intro');
    intro.append(
      el('h2', '', 'Where workers run'),
      el(
        'p',
        'muted',
        'Workers run on this PC unless you place them on an SSH box. Code goes only to the boxes you add here. An unavailable box makes the task wait with its reason; Switchflow never falls back to this PC.',
      ),
    );
    const list = el('ul', 'agents-environment-list');
    const localItem = el('li', 'agents-environment');
    localItem.append(el('strong', '', 'This PC'), el('span', 'muted', 'local · always available'));
    list.append(localItem);
    environmentDraft.forEach((environment, index) => {
      const item = el('li', 'agents-environment');
      const text = el('div', 'agents-environment-text');
      text.append(
        el('strong', '', environment.label || environment.id),
        el(
          'span',
          'muted',
          `${
            environment.kind === 'ssh'
              ? `ssh · ${environment.user}@${environment.host}:${environment.port ?? 22} · ${environment.workRoot}`
              : `${environment.kind} · ${environment.repository || environment.environmentId || ''}`
          }${environment.enabled === false ? ' · disabled' : ''}`,
        ),
      );
      const result = environmentTests[environment.id];
      if (result)
        text.append(
          el(
            'span',
            result.ok ? 'agents-environment-ok' : 'agents-route-error',
            result.pending
              ? 'Testing…'
              : result.ok
                ? `Connected. ${['codex', 'claude']
                    .filter(name => result.providers?.[name]?.available)
                    .map(name => `${providers[name].name} ${result.providers[name].version || ''}`.trim())
                    .join(', ')}`
                : result.reason || 'Not reachable.',
          ),
        );
      const tools = el('div', 'agents-environment-tools');
      const test = el('button', 'button quiet', 'Test connection');
      test.type = 'button';
      const saved = (settings.environments || []).some(other => other.id === environment.id);
      test.disabled = !saved;
      if (!saved) test.title = 'Save first, then test.';
      test.addEventListener('click', async () => {
        environmentTests[environment.id] = { pending: true };
        renderRouting();
        try {
          environmentTests[environment.id] = await send(
            `/agents/environments/${encodeURIComponent(environment.id)}/test`,
            'POST',
            {},
          );
        } catch (error) {
          environmentTests[environment.id] = { ok: false, reason: error.message };
        }
        renderRouting();
      });
      const editButton = el('button', 'button quiet', 'Edit');
      editButton.type = 'button';
      editButton.disabled = !!blocked;
      editButton.addEventListener('click', () => {
        environmentEditing = index;
        renderRouting();
      });
      const remove = el('button', 'button quiet', 'Remove');
      remove.type = 'button';
      remove.disabled = !!blocked;
      remove.addEventListener('click', () => {
        environmentDraft.splice(index, 1);
        environmentEditing = null;
        renderRouting();
      });
      // Only SSH environments are edited here; others keep their fields and can be tested or removed.
      tools.append(test, ...(environment.kind === 'ssh' ? [editButton] : []), remove);
      item.append(text, tools);
      list.append(item);
    });
    form.append(intro, list);
    if (environmentEditing !== null) form.append(environmentEditor(environmentDraft[environmentEditing] || null));
    else {
      const add = el('button', 'button quiet', 'Add SSH environment');
      add.type = 'button';
      add.disabled = !!blocked;
      add.addEventListener('click', () => {
        environmentEditing = 'new';
        renderRouting();
      });
      form.append(add);
    }
    const placement = el('div', 'agents-routing-grid agents-placement');
    for (const [role, label] of placeable) {
      const row = el('label', 'agents-route');
      const text = el('span');
      text.append(el('strong', '', label), el('small', '', 'Runs on'));
      const select = el('select');
      select.name = `placement-${role}`;
      select.disabled = !!blocked;
      for (const environment of [{ id: 'local', label: 'This PC' }, ...environmentDraft]) {
        const option = el('option', '', environment.label || environment.id);
        option.value = environment.id;
        option.selected = (settings.placement?.[role] || 'local') === environment.id;
        select.append(option);
      }
      row.append(text, select);
      placement.append(row);
    }
    const footer = el('div', 'agents-routing-footer');
    const status = el('span', 'muted');
    status.setAttribute('role', 'status');
    status.textContent = blocked;
    const save = el('button', 'button primary', 'Save environments');
    save.type = 'submit';
    save.disabled = !!blocked || environmentEditing !== null;
    footer.append(status, save);
    form.append(placement, footer);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(form);
      const next = {
        environments: environmentDraft,
        placement: Object.fromEntries(placeable.map(([role]) => [role, values.get(`placement-${role}`) || 'local'])),
        ...(Number.isInteger(settings.revision) ? { expectedRevision: settings.revision } : {}),
      };
      save.disabled = true;
      status.textContent = 'Saving…';
      try {
        const saved = await send('/agents/settings', 'PUT', next);
        data = { ...data, settings: saved?.settings || data?.settings, routing: saved?.routing || data?.routing };
        environmentDraft = null;
        renderRouting();
        refresh();
      } catch (error) {
        status.textContent = error.message;
        save.disabled = false;
      }
    });
    return form;
  }
  function environmentEditor(existing) {
    const box = el('fieldset', 'agents-environment-editor');
    box.append(el('legend', '', existing ? `Edit ${existing.label || existing.id}` : 'New SSH environment'));
    const inputs = {};
    for (const [name, label, type, placeholder] of sshFields) {
      const wrap = el('label', '', label);
      const input = el('input');
      input.type = type;
      input.name = `ssh-${name}`;
      input.placeholder = placeholder;
      const value = existing?.[name];
      input.value = Array.isArray(value) ? value.join(' ') : (value ?? '');
      if (name === 'id' && existing) input.readOnly = true;
      inputs[name] = input;
      wrap.append(input);
      box.append(wrap);
    }
    const enabled = el('label', 'agents-environment-check');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = existing?.enabled !== false;
    enabled.append(check, document.createTextNode(' Enabled'));
    box.append(
      enabled,
      el(
        'p',
        'muted',
        'Use a key-only login. Switchflow keeps its own known-hosts file and accepts a new host key once; no passwords or secrets are stored.',
      ),
    );
    const tools = el('div', 'agents-environment-tools');
    const done = el('button', 'button', existing ? 'Apply' : 'Add');
    done.type = 'button';
    done.addEventListener('click', () => {
      const value = name => inputs[name].value.trim();
      const config = {
        id: value('id'),
        kind: 'ssh',
        label: value('label') || value('id'),
        host: value('host'),
        port: Number(value('port') || 22),
        user: value('user'),
        identityFile: value('identityFile'),
        workRoot: value('workRoot'),
        enabled: check.checked,
        ...(value('wake') ? { wake: value('wake') } : {}),
      };
      if (existing) environmentDraft[environmentEditing] = config;
      else environmentDraft.push(config);
      environmentEditing = null;
      renderRouting();
    });
    const cancel = el('button', 'button quiet', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      environmentEditing = null;
      renderRouting();
    });
    tools.append(done, cancel);
    box.append(tools);
    return box;
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
      refreshControl.loaded();
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
      renderCapacity();
      renderList();
      if (showRouting && !routing.contains(document.activeElement)) renderRouting();
      const key = renderKey(current());
      if (key !== renderedFor) {
        renderDetail();
        void loadEvents();
      } else if (headNode && current() && !headNode.contains(document.activeElement)) {
        const head = renderHead(current());
        headNode.replaceWith(head);
        headNode = head;
      }
      updateComposerAccess();
      schedule();
    } catch (error) {
      if (destroyed) return;
      message.textContent = `Agent sessions are unavailable: ${error.message}`;
      refreshControl.failed(error);
      updateComposerAccess();
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
  const accessTimer = setInterval(updateComposerAccess, 1000);
  void refresh();
  return {
    refresh,
    open: id => select(id),
    destroy() {
      destroyed = true;
      refreshControl.destroy();
      clearInterval(timer);
      clearInterval(accessTimer);
      clearTimeout(streamTimer);
    },
  };
}
