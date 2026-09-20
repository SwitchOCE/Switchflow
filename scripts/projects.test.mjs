import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { canonicalProject, sharedServiceContext } from '../template/.switchflow/scripts/control/projects.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' }).toString().trim();
async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-projects-'));
  const stateHome = path.join(base, 'state');
  const shared = { stateDir: path.join(stateHome, 'control-service') };
  const roots = [];
  for (const name of ['Alpha', 'Beta']) {
    const root = path.join(base, name); roots.push(root); await fs.mkdir(path.join(root, '.switchflow'), { recursive: true });
    await fs.mkdir(path.join(root, 'backlog', 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, '.switchflow', 'project.json'), JSON.stringify({ projectName: name, templateVersion: '0.5.0' }));
    await fs.writeFile(path.join(root, 'backlog.config.yml'), `project_name: ${name}\n`);
    await fs.writeFile(path.join(root, 'backlog', 'docs', 'guide.md'), `# ${name} guide\n\n${name} canonical documentation.`);
    git(root, 'init', '-b', 'main'); git(root, 'add', '--', '.');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial fixture');
  }
  const contexts = await Promise.all(roots.map(root => canonicalProject(root, shared)));
  const adapters = new Map(contexts.map(context => [context.id, {
    task: { id: 'SAME-1', title: path.basename(context.sourceRoot), status: 'Ready', revision: 'a'.repeat(64), atomicRevision: true },
    async list() { return [this.task]; }, async view() { return this.task; }, async edit(id, input) { this.task = { ...this.task, title: input.title }; return this.task; },
  }]));
  const nativeCalls = [];
  const nativeFactory = context => ({
    async request(input) { const result = { projectId: context.id, root: context.governanceRoot, ...input }; nativeCalls.push(result); return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(result)) }; },
    async close() {},
  });
  const options = { context: contexts[0], capabilities: { codex: false }, backlogFactory: context => adapters.get(context.id), nativeFactory, runner: async () => { throw new Error('No real agent in fixture'); }, persistProjects: true, lockProjects: true };
  const apps = [];
  try { await run({ base, roots, contexts, shared, options, apps, adapters, nativeCalls }); }
  finally { for (const app of apps.reverse()) await app.close(); assert.equal(path.dirname(base), path.resolve(os.tmpdir())); await fs.rm(base, { recursive: true, force: true }); }
}

test('one HTTP port keeps project state, colliding task IDs and docs separate; worktree alias reuses authority', () => fixture(async ({ base, roots, contexts, options, apps }) => {
  const app = await createControlServer(options); apps.push(app);
  const registry = await (await fetch(app.url + '/api/projects')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Switchflow-Token': registry.csrfToken };
  const register = root => fetch(app.url + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ projectRoot: root }) });
  assert.equal((await register(roots[1])).status, 201);
  const worktree = path.join(base, 'alpha-code'); git(roots[0], 'worktree', 'add', '-b', 'candidate', worktree);
  await fs.writeFile(path.join(worktree, 'backlog', 'docs', 'guide.md'), '# Wrong duplicate');
  const linked = await (await register(worktree)).json(); assert.equal(linked.project.id, contexts[0].id); assert.equal(linked.project.root, roots[0]);
  assert.equal((await (await fetch(app.url + '/api/projects')).json()).projects.length, 2);
  const api = index => app.url + '/api/projects/' + contexts[index].id;
  const created = await fetch(api(0) + '/initiatives', { method: 'POST', headers, body: JSON.stringify({ title: 'Only Alpha', request: 'Fixture', start: false }) });
  assert.equal(created.status, 201);
  assert.equal((await (await fetch(api(0) + '/state')).json()).initiatives.length, 1);
  assert.equal((await (await fetch(api(1) + '/state')).json()).initiatives.length, 0);
  const write = await fetch(api(1) + '/tasks/SAME-1', { method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 'a'.repeat(64), title: 'Changed Beta' }) });
  assert.equal(write.status, 200);
  assert.equal((await (await fetch(api(0) + '/tasks/SAME-1')).json()).task.title, 'Alpha');
  assert.equal((await (await fetch(api(1) + '/tasks/SAME-1')).json()).task.title, 'Changed Beta');
  assert.match((await (await fetch(api(0) + '/docs/content?id=guide.md')).json()).markdown, /Alpha canonical/);
  assert.match((await (await fetch(api(1) + '/docs/content?id=guide.md')).json()).markdown, /Beta canonical/);
  assert.equal((await fetch(api(0) + '/docs/content?id=../config.yml')).status, 400);
  assert.equal((await fetch(app.url + '/api/projects/' + '0'.repeat(64) + '/state')).status, 404);
  assert.equal((await fetch(app.url + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoot: roots[1] }) })).status, 403);
  assert.deepEqual(sharedServiceContext(contexts[0]), sharedServiceContext(contexts[1]));
}));

test('registry persists both projects through restart and project locks reject duplicate engines', () => fixture(async ({ roots, contexts, options, apps }) => {
  const first = await createControlServer(options); apps.push(first);
  await first.register(roots[1]);
  await assert.rejects(createControlServer(options), /already has a running service/);
  await first.close(); apps.pop();
  const restored = await createControlServer(options); apps.push(restored);
  assert.deepEqual([...restored.projects.keys()].sort(), contexts.map(context => context.id).sort());
  assert.ok((await (await fetch(restored.url + '/api/health')).json()).projectIds.includes(contexts[1].id));
}));

test('missing primary governance does not adopt stale worktree records', () => fixture(async ({ base, roots, shared }) => {
  const worktree = path.join(base, 'stale'); git(roots[0], 'worktree', 'add', '-b', 'stale', worktree);
  await fs.rename(path.join(roots[0], 'backlog.config.yml'), path.join(roots[0], 'backlog.config.yml.saved'));
  await assert.rejects(canonicalProject(worktree, shared), /primary checkout is missing/);
  assert.match(await fs.readFile(path.join(worktree, 'backlog', 'docs', 'guide.md'), 'utf8'), /Alpha/);
}));

test('registration refuses older governance writers without changing their records', () => fixture(async ({ roots, shared }) => {
  const metadataPath = path.join(roots[1], '.switchflow', 'project.json');
  const previous = JSON.stringify({ projectName: 'Older installation', templateVersion: '0.4.0' });
  await fs.writeFile(metadataPath, previous);
  await assert.rejects(canonicalProject(roots[1], shared), /Update this project to Switchflow 0\.5/);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), previous);
}));

test('Switchflow pages, legacy links, project assets and every write method retain the shared project and admission boundaries', () => fixture(async ({ roots, contexts, options, apps, nativeCalls }) => {
  const app = await createControlServer(options); apps.push(app); await app.register(roots[1]);
  const registry = await (await fetch(app.url + '/api/projects')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Switchflow-Token': registry.csrfToken };
  const api = index => `${app.url}/api/projects/${contexts[index].id}/native`;
  const home = await fetch(`${app.url}/?project=${contexts[1].id}`, {redirect:'manual'});
  assert.equal(home.status,200);
  const html = await home.text(); assert.match(html,/Switchflow/); assert.match(html,/data-view="tasks"/); assert.match(html,/data-view="settings"/); assert.doesNotMatch(html,/<iframe|backlog-assets/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  for (const asset of ['tasks.js','tasks-model.js','tasks-editor.js','knowledge.js','knowledge-model.js','insights.js','workspace-client.js','workspace-search.js']) assert.equal((await fetch(app.url+'/'+asset)).status,200,asset);
  assert.equal((await fetch(app.url + '/backlog-assets/main.js')).status,404);
  const legacy = await fetch(`${app.url}/projects/${contexts[1].id}/backlog/tasks/SAME-1`,{redirect:'manual'});
  assert.equal(legacy.status,302); const redirect = new URL(legacy.headers.get('location'),app.url);
  assert.equal(redirect.searchParams.get('project'),contexts[1].id); assert.equal(redirect.searchParams.get('view'),'tasks'); assert.equal(redirect.searchParams.get('task'),'SAME-1');
  assert.equal((await fetch(app.url+'/?project='+'0'.repeat(64))).status,404);
  const control = await fetch(`${app.url}/control?project=${contexts[1].id}&embedded=1`);
  assert.equal(control.headers.get('x-frame-options'),'DENY'); assert.doesNotMatch(await control.text(),/class="embedded-workspace"/);
  assert.equal((await fetch(api(0) + '/tasks?status=Ready')).status, 200);
  assert.equal(nativeCalls.at(-1).root, roots[0]); assert.equal(nativeCalls.at(-1).path, '/api/tasks?status=Ready');
  const image = await fetch(`${app.url}/projects/${contexts[1].id}/backlog-assets/picture.png`); assert.equal(image.status, 200);
  assert.match(image.headers.get('content-security-policy'), /^sandbox;/); assert.match(image.headers.get('content-security-policy'), /script-src 'none'/);
  assert.equal(nativeCalls.at(-1).root, roots[1]); assert.equal(nativeCalls.at(-1).path, '/assets/picture.png');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const payload = JSON.stringify({ title: `Beta ${method}` });
    assert.equal((await fetch(api(1) + '/tasks/SAME-1', { method, headers: { 'Content-Type': 'application/json' }, body: payload })).status, 403);
    assert.equal((await fetch(api(1) + '/tasks/SAME-1', { method, headers: { ...headers, Origin: 'https://other.invalid' }, body: payload })).status, 403);
    const response = await fetch(api(1) + '/tasks/SAME-1', { method, headers, body: payload }); assert.equal(response.status, 200);
    assert.equal(nativeCalls.at(-1).projectId, contexts[1].id); assert.equal(nativeCalls.at(-1).body.title, `Beta ${method}`);
  }
  assert.equal((await fetch(app.url + '/api/native/tasks')).status, 404);
  const decisionBody = '# Decision\n\nUnicode café 日本語';
  assert.equal((await fetch(api(1) + '/decisions/decision-1', { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: decisionBody })).status, 200);
  assert.equal(nativeCalls.at(-1).body, decisionBody); assert.equal(nativeCalls.at(-1).contentType, 'text/plain');
  assert.equal((await fetch(api(1) + '/tasks/SAME-1', { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: decisionBody })).status, 415);
  assert.equal((await fetch(api(0) + '/init', { method: 'POST', headers, body: '{}' })).status, 409);
  const count = nativeCalls.length;
  await app.engine.mutate(state => { state.activeRun = { id: 'fixture' }; });
  assert.equal((await fetch(api(0) + '/tasks/SAME-1', { method: 'PUT', headers, body: '{}' })).status, 409);
  assert.equal(nativeCalls.length, count);
  assert.equal((await fetch(api(1) + '/tasks/SAME-1', { method: 'PUT', headers, body: '{}' })).status, 200);
  await app.engine.mutate(state => { state.activeRun = null; });
}));
