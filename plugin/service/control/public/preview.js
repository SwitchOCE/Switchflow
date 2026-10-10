// UAT preview bar: starts the delivered candidate locally with the owner-configured command.
// The bar owns its own polling so the initiative sheet does not re-render for log output.
const cache = new Map();
const LABELS = {
  loading: ['Checking', 'backlog'],
  unconfigured: ['Not configured', 'backlog'],
  invalid: ['Config invalid', 'failed'],
  unavailable: ['Unavailable', 'backlog'],
  idle: ['Not running', 'backlog'],
  starting: ['Starting', 'running'],
  running: ['Running', 'done'],
  stopping: ['Stopping', 'running'],
  stopped: ['Stopped', 'backlog'],
  failed: ['Failed', 'failed'],
  elsewhere: ['In use', 'running'],
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Only loopback HTTP(S) links are offered; anything else is shown as text. */
export function previewLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Where the preview listens, when the owner needs to know: `exposed` (other devices can reach it; `stopped`
 * when the service stopped it for that) or `unknown` (the check could not tell).
 */
export function networkView(runtime) {
  const network = runtime?.network;
  if (network?.state === 'exposed' && network.exposed?.length && (runtime.state === 'running' || !network.allowed))
    return {
      state: 'exposed',
      exposed: network.exposed,
      allowed: !!network.allowed,
      stopped: runtime.state !== 'running',
    };
  if (network?.state === 'unknown' && runtime.state === 'running') return { state: 'unknown', error: network.error };
  return null;
}

/** Reduces a status response to what the bar shows for one initiative. */
export function previewView(status, initiativeId) {
  if (!status) return { state: 'loading' };
  const runtime = status.runtime || { state: 'idle' };
  const mine = runtime.initiativeId === initiativeId;
  const active = ['starting', 'running', 'stopping'].includes(runtime.state);
  if (active && !mine) return { state: 'elsewhere', runtime };
  if (active || (mine && ['stopped', 'failed'].includes(runtime.state)))
    return { state: runtime.state, runtime, network: networkView(runtime) };
  if (!status.configured) return { state: status.configError ? 'invalid' : 'unconfigured', error: status.configError };
  if (!status.eligible || status.candidateError)
    return { state: 'unavailable', error: status.reason || status.candidateError };
  return { state: 'idle' };
}

// Compact copies of the bar's state (see createPreviewStatus); they redraw whenever the bar polls.
const mirrors = new Set();
function publish() {
  for (const mirror of mirrors)
    if (mirror.node.isConnected) mirror.draw();
    else mirrors.delete(mirror);
}

/**
 * A one-line copy of the preview state for a sticky header: "Preview running · Open ↗", the network
 * warning, or nothing. It follows the initiative's preview bar, which does the polling.
 */
export function createPreviewStatus(initiativeId) {
  const node = el('span', 'preview-status');
  node.hidden = true;
  let drawn = null;
  const draw = () => {
    const view = previewView(cache.get(initiativeId), initiativeId);
    const exposed = view.network?.state === 'exposed' && view.network;
    const link = view.state === 'running' && previewLink(view.runtime.url);
    const text =
      exposed && exposed.stopped
        ? 'Preview stopped: it was on your network'
        : exposed
          ? 'Preview on your network'
          : view.state === 'running'
            ? 'Preview running'
            : view.state === 'starting'
              ? 'Preview starting…'
              : '';
    const key = JSON.stringify([text, link]);
    if (key === drawn) return;
    drawn = key;
    node.hidden = !text;
    node.dataset.tone = exposed ? 'warning' : view.state === 'running' ? 'running' : 'starting';
    node.replaceChildren();
    if (!text) return;
    node.append(el('span', 'preview-status-dot'), el('span', 'preview-status-text', text));
    if (link) {
      const open = el('a', 'preview-status-open', 'Open ↗');
      open.href = link;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.setAttribute('aria-label', `Open the preview at ${link} in a new tab`);
      node.append(' · ', open);
    }
  };
  draw();
  mirrors.add({ node, draw });
  return node;
}

export function createPreviewBar({
  initiativeId,
  path,
  token,
  canWrite,
  writeBlockedReason = () => '',
  initiativeTitle = () => '',
}) {
  const bar = el('section', 'detail-section preview-bar');
  bar.setAttribute('aria-labelledby', `preview-title-${initiativeId}`);
  let busy = false;
  let error = '';
  let timer = null;
  let chosen = null;
  let logOpen = null;
  let keepFocus = false;
  let shownState = null;

  const call = async (suffix, body) => {
    const response = await fetch(path(`/api/initiatives/${encodeURIComponent(initiativeId)}/preview${suffix}`), {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': token() || '' },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Preview request failed (${response.status}).`);
    return result;
  };
  const schedule = () => {
    clearTimeout(timer);
    const state = previewView(cache.get(initiativeId), initiativeId).state;
    const delay = ['starting', 'stopping'].includes(state) ? 1500 : ['running', 'elsewhere'].includes(state) ? 5000 : 0;
    // A re-rendered sheet replaces this bar; a detached bar stops polling.
    if (delay) timer = setTimeout(() => bar.isConnected && load(), delay);
  };
  async function load() {
    try {
      cache.set(initiativeId, await call(''));
      error = '';
    } catch (failure) {
      error = failure.message;
    }
    publish();
    if (!bar.isConnected) return;
    draw();
    schedule();
  }
  const act = async (suffix, body) => {
    if (busy) return;
    keepFocus = bar.contains(document.activeElement);
    busy = true;
    error = '';
    draw();
    try {
      await call(suffix, body);
    } catch (failure) {
      error = failure.message;
    } finally {
      busy = false;
    }
    await load();
  };

  let drawn = null;
  function draw() {
    const status = cache.get(initiativeId);
    // Polling must not replace controls (or a text selection in the log) when nothing changed.
    const key = JSON.stringify([status, error, busy, chosen, canWrite()]);
    if (key === drawn) return;
    drawn = key;
    const view = previewView(status, initiativeId);
    const runtime = view.runtime;
    const focused = bar.contains(document.activeElement) ? document.activeElement.id : null;
    const openLog = bar.querySelector('details.preview-log');
    if (openLog) logOpen = openLog.open;
    // A failure shows its output; afterwards the owner's open/closed choice stands.
    if (view.state !== shownState) {
      if (view.state === 'failed') logOpen = true;
      shownState = view.state;
    }
    bar.replaceChildren();

    const head = el('div', 'preview-head');
    const title = el('h3', '', 'Preview');
    title.id = `preview-title-${initiativeId}`;
    const exposed = view.network?.state === 'exposed' && view.network;
    const [label, tone] =
      exposed && !exposed.stopped
        ? ['On your network', 'warning']
        : exposed
          ? ['Stopped', 'warning']
          : LABELS[view.state];
    const pill = el('span', 'status-pill', label);
    pill.dataset.status = tone;
    pill.setAttribute('role', 'status');
    const actions = el('div', 'preview-actions');
    const link = view.state === 'running' && previewLink(runtime.url);
    if (link) {
      const open = el('a', 'button primary button-small', 'Open ↗');
      open.href = link;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.id = `preview-open-${initiativeId}`;
      open.setAttribute('aria-label', `Open the preview at ${link} in a new tab`);
      actions.append(open);
    }
    if (['starting', 'running', 'elsewhere'].includes(view.state)) {
      const stop = el('button', 'button quiet button-small', 'Stop');
      stop.type = 'button';
      stop.id = `preview-stop-${initiativeId}`;
      stop.disabled = busy;
      stop.addEventListener('click', () => act('/stop', {}));
      actions.append(stop);
    }
    const startable = ['idle', 'stopped', 'failed'].includes(view.state) && status?.configured && status.eligible;
    if (startable && !status.candidateError) {
      const start = el('button', 'button primary button-small', view.state === 'idle' ? 'Start' : 'Start again');
      start.type = 'button';
      start.id = `preview-start-${initiativeId}`;
      const blocked = canWrite() ? '' : writeBlockedReason() || 'Starting is paused right now.';
      start.disabled = busy || !!blocked;
      if (blocked) start.title = blocked;
      start.addEventListener('click', () =>
        act('/start', {
          commandHash: status.command.hash,
          ...(chosen ? { candidate: chosen } : {}),
        }),
      );
      actions.append(start);
    }
    head.append(title, pill, actions);
    bar.append(head);

    const note = (text, className = 'preview-note') => bar.append(el('p', className, text));
    if (view.state === 'loading') note('Checking whether this delivery can be previewed…');
    if (view.state === 'invalid') note(view.error, 'preview-note preview-problem');
    if (['unconfigured', 'invalid'].includes(view.state)) {
      const how = el('p', 'preview-note');
      how.append(
        view.state === 'invalid' ? 'Fix ' : 'To start the delivered product from here, add ',
        el('code', '', '.switchflow/preview.json'),
        view.state === 'invalid'
          ? ' in your project. It should look like '
          : ' to your project with the command that runs it, for example ',
        el('code', '', '{"schemaVersion": 1, "command": "npm", "args": ["run", "dev"]}'),
        '.',
      );
      bar.append(how);
    }
    if (view.state === 'unavailable') note(view.error);
    if (view.state === 'elsewhere')
      note(
        `The preview for ${initiativeTitle(runtime.initiativeId) || runtime.initiativeTitle || 'another initiative'} is running. One preview runs at a time; stop it to preview this one.`,
      );
    if (status?.command && !['unconfigured', 'invalid', 'elsewhere'].includes(view.state)) {
      const command = el('p', 'preview-command');
      command.append(
        'Runs ',
        el('code', '', runtime?.command || status.command.display),
        status.command.cwd ? ` in ${status.command.cwd}/ of` : ' in',
        ' the delivered candidate',
      );
      const candidate = runtime?.candidate || chosen || status.suggested;
      const entry = status.candidates?.find(value => value.name === candidate);
      if (candidate)
        command.append(' ', el('strong', '', candidate), entry?.head ? ` at ${entry.head.slice(0, 7)}` : '');
      command.append('.');
      if (status.command.env?.length) command.append(` Sets ${status.command.env.join(', ')}.`);
      if (status.command.allowNetwork) command.append(' Allowed to listen on your network.');
      bar.append(command);
      if (startable && status.candidates?.length > 1) {
        const field = el('label', 'preview-candidate', 'Candidate');
        const select = el('select');
        select.id = `preview-candidate-${initiativeId}`;
        for (const value of status.candidates) {
          const option = el('option', '', `${value.name} · ${value.head.slice(0, 7)}`);
          option.value = value.name;
          select.append(option);
        }
        select.value = chosen || status.suggested || status.candidates[0].name;
        select.addEventListener('change', () => {
          chosen = select.value;
          draw();
        });
        field.append(select);
        // Choose first, then start: the picker sits just before the Start button.
        actions.prepend(field);
      }
    }
    if (startable && !status.candidateError && !canWrite())
      note(writeBlockedReason() || 'Starting is paused right now.');
    if (view.state === 'running' && runtime.url && !link) note(`Reported address: ${runtime.url}`);
    if (view.state === 'running' && link) {
      const where = el('p', 'preview-note');
      const anchor = el('a', 'preview-url', link);
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      where.append('Running at ', anchor, '. Stops when you accept or request rework.');
      bar.append(where);
    }
    if (exposed) {
      if (!exposed.stopped)
        note(
          `Listening on your network: ${exposed.exposed.join(', ')} — other devices can reach it.`,
          'preview-note preview-warning',
        );
      const fix = el('p', 'preview-note');
      const config = el('code', '', '.switchflow/preview.json');
      const vite = el('code', '', '"--host", "127.0.0.1"');
      if (exposed.allowed)
        fix.append(
          'Allowed by ',
          el('code', '', '"allowNetwork": true'),
          ' in ',
          config,
          '. To keep it on this computer, remove that and make it listen on 127.0.0.1 (for Vite, add ',
          vite,
          ' to args).',
        );
      else
        fix.append(
          'Make it listen on 127.0.0.1 (for Vite, add ',
          vite,
          ' to args in ',
          config,
          '), then start again. To allow other devices on purpose, set ',
          el('code', '', '"allowNetwork": true'),
          '.',
        );
      // The service's stop reason leads; the fix follows it below.
      if (exposed.stopped) bar.append(el('p', 'preview-note preview-problem', runtime.reason || ''), fix);
      else bar.append(fix);
    }
    if (view.network?.state === 'unknown')
      note(`Couldn't verify the listening address${view.network.error ? `: ${view.network.error}` : '.'}`);
    if (view.state === 'starting')
      note(
        status?.command?.port
          ? `Waiting for port ${status.command.port} to accept connections…`
          : 'Waiting for the program to report a local address…',
      );
    if (['stopped', 'failed'].includes(view.state) && runtime.reason && !exposed)
      note(runtime.reason, view.state === 'failed' ? 'preview-note preview-problem' : 'preview-note');
    if (runtime?.notice || status?.runtime?.notice) note(runtime?.notice || status.runtime.notice);
    if (error) {
      const problem = el('p', 'inline-error preview-error', error);
      problem.setAttribute('role', 'alert');
      bar.append(problem);
    }
    if (runtime?.logs?.length && view.state !== 'elsewhere') {
      const log = el('details', 'preview-log');
      log.open = logOpen ?? view.state === 'failed';
      log.append(el('summary', '', view.state === 'failed' ? 'Last output' : 'Recent output'));
      const output = el('pre', 'preview-output', runtime.logs.join('\n'));
      output.tabIndex = 0;
      output.setAttribute('aria-label', 'Recent preview output');
      log.append(output);
      log.addEventListener('toggle', () => {
        logOpen = log.open;
      });
      bar.append(log);
    }
    // Start and Stop replace each other; keep keyboard focus on the bar's current action.
    if (focused || keepFocus) {
      const target = [document.getElementById(focused), ...bar.querySelectorAll('.preview-actions button')].find(
        node => node && !node.disabled && bar.contains(node),
      );
      if (target) {
        target.focus({ preventScroll: true });
        keepFocus = false;
      }
    }
  }

  draw();
  void load();
  return bar;
}
