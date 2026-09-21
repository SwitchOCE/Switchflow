import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../template/.switchflow/scripts/control/public/milestones.js', import.meta.url), 'utf8');
const { createMilestonePanel, milestoneMatches, parseMilestoneOrder, sortMilestones } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.classList = { add() {} }; }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = elements; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() {}
  querySelector() { return null; }
  querySelectorAll(selector) { const tags = selector.split(','); return this.all().slice(1).filter(element => tags.includes(element.tagName)); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
const document = { createElement: tag => new Element(tag) };
const setup = options => { globalThis.document = document; const container = new Element('div'); const panel = createMilestonePanel({ container, projectKey: () => 'p', ...options }); return { panel, container, find: text => container.all().find(el => el.textContent === text) }; };
const milestone = { id: 'm-20', title: 'Scope', description: '', revision: 'revision-1', labels: [], executionOrder: null };

test('execution order is explicit, zero is valid, IDs do not determine sequence', () => {
  assert.deepEqual(sortMilestones([{ id: 'm-1', title: 'Z' }, { id: 'm-99', title: 'B', executionOrder: 0 }, { id: 'm-2', title: 'A', executionOrder: 3 }]).map(m => m.id), ['m-99', 'm-2', 'm-1']);
  assert.equal(parseMilestoneOrder(''), null); assert.equal(parseMilestoneOrder('0'), 0);
  for (const value of ['-1', '1.1', 'x', '9007199254740992']) assert.throws(() => parseMilestoneOrder(value));
});
test('task matching accepts native ID aliases and legacy titles without substring matches', () => {
  for (const value of ['m-20', '20', 'M-020', ' Scope ']) assert.equal(milestoneMatches(value, milestone), true);
  for (const value of ['', 'm-2', 'm-200', 'Scope extra']) assert.equal(milestoneMatches(value, milestone), false);
});
test('native edit uses captured revision and preserves a conflicted draft', async () => {
  const drafts = new Map(); let submitted;
  const { panel, container, find } = setup({ drafts, api: async (route, options) => {
    if (options) { submitted = options.body; throw new Error('Revision conflict'); }
    return milestone;
  } });
  await panel.open('m-20');
  const title = container.all().find(el => el.name === 'title'); title.value = 'My retained scope';
  const form = container.all().find(el => el.tagName === 'form'); await form.listeners.submit({ preventDefault() {} });
  assert.equal(submitted.expectedRevision, 'revision-1'); assert.equal(drafts.get('p:m-20').title, 'My retained scope');
  assert.match(find('Revision conflict Your draft is preserved.').textContent, /preserved/);
});
test('native creation sends metadata in a single POST', async () => {
  const calls = [];
  const { find, container } = setup({ api: async (route, options) => {
    calls.push({ route, options }); if (options) return milestone; return [];
  } });
  find('New milestone').listeners.click();
  container.all().find(el => el.name === 'title').value = 'New scope';
  container.all().find(el => el.name === 'labels').value = 'ux, reviewed';
  container.all().find(el => el.name === 'executionOrder').value = '0';
  await container.all().find(el => el.tagName === 'form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options);
  assert.equal(writes.length, 1); assert.equal(writes[0].options.method, 'POST');
  assert.deepEqual(writes[0].options.body, { title: 'New scope', description: '', labels: ['ux', 'reviewed'], executionOrder: 0 });
});
test('late project response does not render or start follow-up reads', async () => {
  let project = 'old', resolve, calls = 0;
  const { panel, container } = setup({ projectKey: () => project, api: () => { calls++; return new Promise(r => { resolve = r; }); } });
  const pending = panel.refresh(); project = 'new'; panel.reset(); resolve([milestone]); await pending;
  assert.equal(calls, 1); assert.equal(container.all().some(el => el.textContent === 'Scope'), false);
});
test('active-agent guard rejects submit even if editor was opened while writable', async () => {
  let writable = true, writes = 0;
  const { panel, container } = setup({ canWrite: () => writable, api: async (route, options) => { if (options) writes++; return milestone; } });
  await panel.open('m-20'); writable = false;
  await container.all().find(el => el.tagName === 'form').listeners.submit({ preventDefault() {} });
  assert.equal(writes, 0); assert.ok(container.all().some(el => el.textContent?.includes('Stop the active agent')));
});
test('wrapper edit compatibility still requires atomicRevision', async () => {
  const { panel, find } = setup({ read: async () => milestone, write: async () => assert.fail('must not write') });
  await panel.open('m-20'); assert.equal(find('Save milestone').disabled, true);
});
test('assignment writes only milestone and captured task revision; unassignment uses null', async () => {
  const writes = [], task = { id: 'T-1', title: 'Example', status: 'Ready', milestone: null, revision: 'task-r1' };
  const { panel, find, container } = setup({ api: async (route, options) => {
    if (options) { writes.push(options.body); task.milestone = options.body.milestone; task.revision = 'task-r2'; return task; }
    if (route.startsWith('/tasks')) return [{ ...task }];
    if (route === '/milestones') return [milestone]; return milestone;
  } });
  await panel.refresh(); await panel.open('m-20');
  const filter = container.all().find(el => el['aria-label'] === 'Task assignment filter'); filter.value = 'all'; filter.listeners.change();
  await find('Assign here').listeners.click();
  assert.deepEqual(writes[0], { milestone: 'm-20', expectedRevision: 'task-r1' });
  await find('Unassign').listeners.click();
  assert.deepEqual(writes[1], { milestone: null, expectedRevision: 'task-r2' });
});
test('removal confirmation names archive outcome and explicit task handling', async () => {
  const calls = []; let confirmation;
  globalThis.window = { confirm: text => { confirmation = text; return true; } };
  const { panel, find, container } = setup({ api: async (route, options) => {
    if (options) { calls.push({ route, options }); return { success: true }; }
    if (route === '/milestones') return [milestone]; if (route.startsWith('/tasks')) return []; return milestone;
  } });
  await panel.refresh(); await panel.open('m-20');
  container.all().find(el => el['aria-label'] === 'Task handling on milestone removal').value = 'clear';
  await find('Remove milestone').listeners.click();
  assert.deepEqual(calls, [{ route: '/milestones/m-20', options: { method: 'DELETE', body: { taskHandling: 'clear' } } }]);
  assert.match(confirmation, /Archive this milestone record/); assert.match(confirmation, /No tasks are deleted/); assert.match(confirmation, /all matching local tasks/);
});

test('opening another milestone while saving cannot replace or discard its editor', async () => {
  let finish; const reads = [];
  const {panel, container, find} = setup({api:async (route, options) => {
    if (options) return new Promise(resolve => {finish = resolve;});
    reads.push(route); return route === '/milestones' || route.startsWith('/tasks') ? [] : milestone;
  }});
  await panel.open('m-20');
  const saving = container.all().find(el => el.tagName === 'form').listeners.submit({preventDefault(){}});
  await panel.open('m-21'); find('New milestone').listeners.click();
  assert.equal(reads.includes('/milestones/m-21'), false);
  assert.ok(find('Edit m-20')); assert.equal(find('Create milestone'), undefined);
  finish(milestone); await saving;
});

test('late same-record loads cannot replace a newer response', async () => {
  const reads = [];
  const {panel, container} = setup({api:() => new Promise(resolve => reads.push(resolve))});
  const first = panel.open('m-20'), second = panel.open('m-20');
  reads[1]({...milestone,title:'Latest title'}); await second;
  reads[0]({...milestone,title:'Stale title'}); await first;
  assert.equal(container.all().find(el => el.name === 'title').value, 'Latest title');
});

test('loading latest retains edits typed while the comparison read was pending', async () => {
  let finish, calls = 0;
  const {panel, container, find} = setup({api:async () => ++calls === 1 ? milestone : new Promise(resolve => {finish = resolve;})});
  await panel.open('m-20');
  const loading = find('Load latest; keep my draft').listeners.click();
  container.all().find(el => el.name === 'title').value = 'Typed during request';
  finish({...milestone,revision:'revision-2'}); await loading;
  assert.equal(container.all().find(el => el.name === 'title').value, 'Typed during request');
});
