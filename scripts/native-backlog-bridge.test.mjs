import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveBacklogFork, webIntegrity } from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';

test('native stdio bridge preserves native workflows, revision conflicts and clean EOF', { timeout: 60000 }, async t => {
  const source = process.env.SWITCHFLOW_TEST_FORK_SOURCE;
  const executable = source ? process.env.SWITCHFLOW_TEST_BUN : process.env.SWITCHFLOW_TEST_FORK_EXE || (await resolveBacklogFork()).executable;
  const prefix = source ? [path.resolve(source, 'src/cli.ts')] : [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-native-'));
  let child;
  let closed;
  let stderr = '';
  let lastResponse = 'No response received';
  const waiters = new Map();
  const diagnostic = message => new Error(`${message}\nLast response: ${lastResponse}\nBridge stderr:\n${stderr || '(empty)'}`);
  const rejectOutstanding = message => {
    for (const [id, waiter] of waiters) { clearTimeout(waiter.timer); waiter.reject(diagnostic(`${message}: ${waiter.route}`)); waiters.delete(id); }
  };
  t.after(async () => {
    try {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.stdin.end();
        const waitForClose = ms => new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), ms);
          closed.then(() => { clearTimeout(timer); resolve(true); });
        });
        if (!await waitForClose(2000)) { child.kill('SIGKILL'); if (!await waitForClose(2000)) throw diagnostic('Bridge did not exit during teardown'); }
      }
      rejectOutstanding('Bridge teardown');
      await fs.rm(root, { recursive: true, force: true });
    } catch (error) { console.error(diagnostic(`Fixture cleanup failed: ${error.message}`).message); throw error; }
  });
  execFileSync(executable, [...prefix, 'init', 'Native bridge', '--defaults', '--no-git', '--integration-mode', 'none'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  execFileSync(executable, [...prefix, 'draft', 'create', 'Native draft'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  child = spawn(executable, [...prefix, 'switchflow-bridge'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', b => { stderr += b; });
  let nextId = 0;
  closed = new Promise(resolve => child.once('close', code => { rejectOutstanding(`Bridge closed with code ${code}`); resolve(code); }));
  child.on('error', error => rejectOutstanding(`Bridge process error: ${error.message}`));
  child.once('exit', (code, signal) => rejectOutstanding(`Bridge exited: code=${code}, signal=${signal}`));
  child.stdin.on('error', error => rejectOutstanding(`Bridge stdin error: ${error.message}`));
  const expectResponse = (id, route) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(diagnostic(`Bridge request timed out: ${route}`)); }, 10000);
    waiters.set(id, { resolve, reject, timer, route });
  });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line);
      const waiter = waiters.get(response.id);
      if (!waiter) { rejectOutstanding(`Unexpected stdout: ${line.slice(0, 500)}`); return; }
      clearTimeout(waiter.timer); waiters.delete(response.id);
      const body = response.body ? Buffer.from(response.body, 'base64').toString().slice(0, 1000) : response.error;
      lastResponse = `${waiter.route}: status=${response.status ?? 'transport error'}; body=${body}`;
      waiter.resolve(response);
    } catch (error) { rejectOutstanding(`Malformed stdout: ${error.message}; ${line.slice(0, 500)}`); }
  });
  t.after(() => { if (!t.passed) console.error(diagnostic('Native bridge test failed').message); });
  const request = async (method, url, body, contentType) => {
    const id = ++nextId;
    const pending = expectResponse(id, `${method} ${url}`);
    child.stdin.write(JSON.stringify({ id, method, path: url, body, contentType }) + '\n');
    const response = await pending;
    if (response.body) { response.text = Buffer.from(response.body, 'base64').toString(); try { response.json = JSON.parse(response.text); } catch {} }
    return response;
  };
  for (const route of ['statuses', 'config', 'tasks', 'drafts', 'docs', 'decisions', 'milestones', 'milestones/archived', 'statistics', 'search?query=Native']) {
    assert.equal((await request('GET', '/api/' + route)).status, 200, route);
  }
  const drafts = (await request('GET', '/api/drafts')).json;
  assert.equal(drafts.length, 1);
  assert.equal((await request('POST', '/api/drafts/' + drafts[0].id + '/promote')).status, 200);
  const draftCreated = await request('POST', '/api/tasks', { title: 'Editable draft', status: 'Draft', description: 'Keep draft body', labels: ['draft'] });
  assert.equal(draftCreated.status, 201);
  const draftSnapshot = (await request('GET', '/api/tasks/' + draftCreated.json.id)).json;
  assert.match(draftSnapshot.revision, /^[a-f0-9]{64}$/);
  const draftSaved = await request('PUT', '/api/tasks/' + draftSnapshot.id, { expectedRevision: draftSnapshot.revision, title: 'Renamed draft', definitionOfDoneAdd: ['Review'], commentsAppend: ['Draft comment'] });
  assert.equal(draftSaved.status, 200); assert.equal(draftSaved.json.status, 'Draft'); assert.equal(draftSaved.json.description, 'Keep draft body');
  assert.deepEqual(draftSaved.json.labels, ['draft']); assert.equal(draftSaved.json.definitionOfDoneItems[0].text, 'Review');
  assert.equal((await request('PUT', '/api/tasks/' + draftSnapshot.id, { expectedRevision: draftSnapshot.revision, title: 'Stale draft' })).status, 409);
  assert.equal((await request('PUT', '/api/tasks/' + draftSnapshot.id, { expectedRevision: draftSaved.json.revision, status: 'To Do' })).status, 400);
  const created = await request('POST', '/api/tasks', { title: 'Native round trip' }); assert.equal(created.status, 201);
  const task = (await request('GET', '/api/tasks/' + created.json.id)).json;
  assert.match(task.revision, /^[a-f0-9]{64}$/);
  assert.equal((await request('PUT', '/api/tasks/' + task.id, { title: 'Missing revision' })).status, 400);
  const update = await request('PUT', '/api/tasks/' + task.id, { expectedRevision: task.revision, title: 'Updated native task', blockReason: 'manual' });
  assert.equal(update.status, 200); assert.equal(update.json.blockReason, 'manual');
  assert.equal((await request('PUT', '/api/tasks/' + task.id, { expectedRevision: task.revision, title: 'Stale' })).status, 409);
  assert.equal((await request('POST', '/api/tasks/reorder', { taskId: task.id, targetStatus: 'In Progress', orderedTaskIds: [task.id] })).status, 200);
  const doc = await request('POST', '/api/docs', { title: 'Bridge documentation', content: 'Unicode café 日本語' }); assert.equal(doc.status, 201);
  assert.match((await request('GET', '/api/docs/' + doc.json.id)).text, /日本語/);
  const beforeMilestones = (await request('GET', '/api/milestones')).json.length;
  assert.equal((await request('POST', '/api/milestones', { title: 'Invalid metadata', labels: [''], executionOrder: 2 })).status, 400);
  assert.equal((await request('GET', '/api/milestones')).json.length, beforeMilestones);
  const milestone = await request('POST', '/api/milestones', { title: 'Native milestone', labels: ['created'], executionOrder: 8 }); assert.equal(milestone.status, 201);
  assert.deepEqual(milestone.json.labels, ['created']); assert.equal(milestone.json.executionOrder, 8); assert.match(milestone.json.revision, /^[a-f0-9]{64}$/);
  const original = (await request('GET', '/api/milestones/' + milestone.json.id)).json;
  assert.equal((await request('PUT', '/api/milestones/' + original.id, { expectedRevision: original.revision, title: 'Updated milestone', executionOrder: 3, labels: ['native'] })).status, 200);
  assert.equal((await request('PUT', '/api/milestones/' + original.id, { expectedRevision: original.revision, description: 'Stale' })).status, 409);
  const decision = await request('POST', '/api/decisions', { title: 'Native decision' }); assert.equal(decision.status, 201);
  assert.equal((await request('GET', '/api/decisions/' + decision.json.id)).status, 200);
  assert.equal((await request('PUT', '/api/decisions/' + decision.json.id, '# Native decision\n\n## Context\n\nUpdated Unicode café 日本語', 'text/plain')).status, 200);
  assert.match((await request('GET', '/api/decisions/' + decision.json.id)).text, /Updated Unicode/);
  const structuredContent = '## Context\n\nBrowser body café 日本語\n\n## Decision\n\nSelected option\n\n## Consequences\n\nExpected impact';
  const structured = await request('POST', '/api/decisions', { title: 'Structured decision', content: structuredContent });
  assert.equal(structured.status, 201);
  let persistedDecision = (await request('GET', '/api/decisions/' + structured.json.id)).json;
  assert.equal(persistedDecision.title, 'Structured decision'); assert.equal(persistedDecision.context, 'Browser body café 日本語');
  assert.equal(persistedDecision.decision, 'Selected option'); assert.equal(persistedDecision.consequences, 'Expected impact');
  assert.equal((await request('PUT', '/api/decisions/' + structured.json.id, { title: 'Renamed structured decision', content: '## Context\n\n\n## Decision\n\nChanged option\n\n## Consequences\n\n' })).status, 200);
  persistedDecision = (await request('GET', '/api/decisions/' + structured.json.id)).json;
  assert.equal(persistedDecision.title, 'Renamed structured decision'); assert.equal(persistedDecision.context, ''); assert.equal(persistedDecision.decision, 'Changed option');
  for (const [openFence, innerFence, closeFence] of [['````md', '```', '````'], ['~~~md', '~~~still content', '~~~~']]) {
    const context = `${openFence}\n${innerFence}\n## Literal example\n${closeFence}`;
    const content = `## Context\n\n${context}\n\n## Decision\n\nSelected\n\n## Consequences\n\nPreserved`;
    assert.equal((await request('PUT', '/api/decisions/' + structured.json.id, { title: 'Nested code fences', content })).status, 200);
    const saved = (await request('GET', '/api/decisions/' + structured.json.id)).json;
    assert.equal(saved.context, context); assert.equal(saved.decision, 'Selected'); assert.equal(saved.consequences, 'Preserved');
  }
  const decisionFiles = await fs.readdir(path.join(root, 'backlog/decisions'));
  const beforeDecisionBytes = await Promise.all(decisionFiles.map(async name => [name, await fs.readFile(path.join(root, 'backlog/decisions', name), 'utf8')]));
  assert.equal((await request('PUT', '/api/decisions/' + structured.json.id, { title: 'Do not overwrite', content: 'unsupported draft text' })).status, 400);
  assert.equal((await request('POST', '/api/decisions', { title: 'Do not partially create', content: 'unsupported draft text' })).status, 400);
  assert.equal((await request('PUT', '/api/decisions/' + structured.json.id, { title: 'a'.repeat(400), content: structuredContent })).status, 500);
  assert.deepEqual(await fs.readdir(path.join(root, 'backlog/decisions')), decisionFiles);
  assert.deepEqual(await Promise.all(decisionFiles.map(async name => [name, await fs.readFile(path.join(root, 'backlog/decisions', name), 'utf8')])), beforeDecisionBytes);
  const config = (await request('GET', '/api/config')).json;
  assert.equal((await request('PUT', '/api/config', { ...config, projectName: 'Native updated settings' })).status, 200);
  assert.equal((await request('GET', '/api/config')).json.projectName, 'Native updated settings');
  assert.equal((await request('DELETE', '/api/tasks/' + task.id)).status, 200);
  assert.equal((await request('GET', '/api/not-a-route')).status, 404);
  assert.match((await request('GET', '/etc/passwd')).error, /Route not allowed/);
  await fs.mkdir(path.join(root, 'backlog/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'backlog/assets/example.txt'), 'native asset');
  assert.equal((await request('GET', '/assets/example.txt')).text, 'native asset');
  assert.equal((await request('GET', '/assets/missing.txt')).status, 404);
  await fs.writeFile(path.join(root, 'backlog/assets/too-large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.match((await request('GET', '/assets/too-large.txt')).error, /Reply exceeds/);
  const oversized = expectResponse(null, 'oversized input boundary');
  child.stdin.write('x'.repeat(1024 * 1024 + 1) + '\n');
  assert.match((await oversized).error, /Request exceeds/);
  assert.equal((await request('GET', '/api/statuses')).status, 200, 'oversized input does not desynchronize protocol');
  child.stdin.end();
  assert.equal(await closed, 0, stderr);
});

test('native web integrity detects changed assets and requires actual entrypoint', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-web-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(webIntegrity(root), /entrypoint missing/);
  await fs.writeFile(path.join(root, 'index.html'), '<script src="/backlog-assets/a.js"></script>');
  await fs.writeFile(path.join(root, 'a.js'), 'original');
  const first = await webIntegrity(root);
  await fs.writeFile(path.join(root, 'a.js'), 'changed');
  assert.notDeepEqual(await webIntegrity(root), first);
});
