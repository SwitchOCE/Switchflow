import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshControl } from '../template/.switchflow/scripts/control/public/refresh-control.js';

// A host whose innerHTML yields the control's three parts, enough to observe its state.
function fakeHost() {
  const part = () => ({
    textContent: '',
    title: '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  });
  const parts = {
    '[data-refresh-time]': part(),
    '[data-refresh-button]': part(),
    '[data-refresh-status]': part(),
  };
  return {
    ...part(),
    innerHTML: '',
    parts,
    querySelector: selector => parts[selector] || null,
  };
}

test('manual refresh shows progress, keeps focusable, and reports the load time', async () => {
  let finish;
  const control = createRefreshControl(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    { now: () => new Date(2026, 9, 3, 14, 2) },
  );
  const host = fakeHost();
  control.mount(host);
  const button = host.parts['[data-refresh-button]'];
  assert.match(host.innerHTML, /aria-label="Refresh"/);
  assert.equal(host.attributes['data-state'], 'idle');

  const run = control.run();
  assert.equal(host.attributes['data-state'], 'busy');
  assert.equal(button.attributes['aria-disabled'], 'true');
  control.run(); // ignored while busy
  control.loaded();
  finish();
  await run;
  assert.equal(host.attributes['data-state'], 'ready');
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.match(host.parts['[data-refresh-time]'].textContent, /^Updated /);
  assert.match(host.parts['[data-refresh-status]'].textContent, /^Updated /);
});

test('a failed refresh keeps the last load time and names the cause', async () => {
  const control = createRefreshControl(async () => {
    throw new Error('Connection lost');
  });
  const host = fakeHost();
  control.mount(host);
  control.loaded(new Date(2026, 9, 3, 14, 2));
  await control.run();
  assert.equal(host.attributes['data-state'], 'error');
  assert.equal(host.parts['[data-refresh-time]'].textContent, 'Couldn’t refresh');
  assert.match(host.parts['[data-refresh-time]'].title, /^Connection lost\. Showing data from /);
  assert.equal(host.parts['[data-refresh-status]'].textContent, 'Couldn’t refresh. Connection lost.');
  control.loaded();
  assert.equal(host.attributes['data-state'], 'ready');
  assert.equal(host.parts['[data-refresh-status]'].textContent, '');
  control.destroy();
});

test('a host without a DOM gets a control that only tracks state', async () => {
  const control = createRefreshControl(async () => {});
  assert.equal(createRefreshControl(async () => {}).create({}), null);
  assert.deepEqual(control.mount({ textContent: '' }), { textContent: '' });
  control.loaded();
  control.failed('offline');
  await control.run();
  assert.equal(control.busy, false);
  control.destroy();
});
