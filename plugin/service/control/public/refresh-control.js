// One refresh control for every workspace view: an icon button at the right end of the page
// header, with the time of the last successful load beside it.
//
//   const control = createRefreshControl(() => refreshView());
//   actions.append(control.create());          // or mount(element) for markup a view already wrote
//   control.loaded();  control.failed(error);  // from the view's load path, manual or polled
//
// run() is the manual refresh. It shows progress on the icon, keeps keyboard focus on the button
// (aria-disabled rather than disabled) and announces the outcome. A failure shows briefly and
// never clears the view: the last good data and its time stay on screen.
const MIN_BUSY_MS = 400;
const ERROR_MS = 6000;
const MARKUP =
  '<span class="refresh-control-time" data-refresh-time></span><button type="button" class="icon-button refresh-control-button" data-refresh-button aria-label="Refresh" title="Refresh"><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-refresh"></use></svg></button><span class="sr-only" role="status" data-refresh-status></span>';

export const refreshTime = date => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function createRefreshControl(refresh, { now = () => new Date() } = {}) {
  let host = null,
    time = null,
    button = null,
    status = null,
    updatedAt = null,
    error = '',
    running = false,
    errorTimer = 0;

  function render() {
    if (!button) return;
    host.setAttribute('data-state', running ? 'busy' : error ? 'error' : updatedAt ? 'ready' : 'idle');
    button.setAttribute('aria-disabled', String(running));
    button.setAttribute('aria-busy', String(running));
    if (error) {
      time.textContent = updatedAt ? 'Couldn’t refresh' : 'Couldn’t load';
      time.title = updatedAt ? `${error} Showing data from ${refreshTime(updatedAt)}.` : error;
    } else {
      time.textContent = updatedAt ? `Updated ${refreshTime(updatedAt)}` : '';
      time.title = updatedAt ? `Last updated ${updatedAt.toLocaleString()}` : '';
    }
  }

  function loaded(at = now()) {
    updatedAt = at;
    error = '';
    clearTimeout(errorTimer);
    // Drop a stale failure announcement; run() writes the outcome of a manual refresh itself.
    if (status && !running) status.textContent = '';
    render();
  }

  function failed(reason) {
    error = String(reason?.message || reason || 'Refresh failed.').trim();
    if (!/[.!?]$/.test(error)) error += '.';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      error = '';
      render();
    }, ERROR_MS);
    errorTimer.unref?.();
    render();
  }

  async function run() {
    if (running) return;
    running = true;
    if (status) status.textContent = '';
    render();
    const started = Date.now();
    try {
      await refresh();
    } catch (reason) {
      failed(reason);
    } finally {
      // A local refresh can finish in a few milliseconds; keep the feedback long enough to see.
      const wait = MIN_BUSY_MS - (Date.now() - started);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      running = false;
      render();
      if (status)
        status.textContent = error
          ? `${updatedAt ? 'Couldn’t refresh' : 'Couldn’t load'}. ${error}`
          : updatedAt
            ? `Updated ${refreshTime(updatedAt)}`
            : '';
    }
  }

  // Fill an element (normally <div class="refresh-control">) with the control. Test doubles
  // without a DOM get a control that tracks state and renders nothing.
  function mount(element) {
    host = element;
    if (typeof host?.querySelector !== 'function') return host;
    host.innerHTML = MARKUP;
    time = host.querySelector('[data-refresh-time]');
    button = host.querySelector('[data-refresh-button]');
    status = host.querySelector('[data-refresh-status]');
    if (!time || !button) {
      button = null;
      return host;
    }
    button.addEventListener('click', () => void run());
    render();
    return host;
  }

  function create(doc = globalThis.document) {
    if (host) return host;
    const element = doc?.createElement?.('div');
    if (!element) return null;
    element.className = 'refresh-control';
    return mount(element);
  }

  return {
    run,
    loaded,
    failed,
    mount,
    create,
    get busy() {
      return running;
    },
    destroy() {
      clearTimeout(errorTimer);
    },
  };
}
