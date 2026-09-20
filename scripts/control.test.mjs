import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createInitiative, applyAction, applyResult } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import { ControlEngine } from '../template/.switchflow/scripts/control/engine.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { resolveProject, updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import * as protocol from '../template/.switchflow/scripts/control/agent-protocol.mjs';

function result(stage, status = 'ready') {
  return { stage, status, summary: `${stage} checkpoint`, nextAction: 'Review the checkpoint.', questions: [], scope: 'Show the existing capability and add an example.', plan: stage === 'planning' ? [{ phase: 'one', task: 'Example', outcome: 'Example works', evidence: 'Run the example' }, { phase: 'two', task: 'Document', outcome: 'Example is documented', evidence: 'Read the guide' }] : [], evidence: stage === 'execution' ? ['Fixture test receipt; synthetic adapter, not real Codex delivery.'] : [], blockers: [], uat: stage === 'execution' ? ['Try the example', 'Read its guide'] : [] };
}
function action(item, name, extra = {}) { return applyAction(item, { action: name, expectedRevision: item.revision, ...extra }); }
async function fixture(fn) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-control-test-'));
  const root = path.join(base, 'repo'); await fs.mkdir(root);
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Accepted baseline'], { stdio: 'ignore', windowsHide: true });
  const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
  try { await fn(context); } finally { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); await fs.rm(base, { recursive: true, force: true }); }
}
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for test condition');
}

test('only Intake, Planning and human UAT authorize transitions; stale/partial approval fails', () => {
  const item = createInitiative({ title: 'Example', request: 'A useful example', start: false });
  assert.throws(() => action(item, 'approve-plan'), /Finish Planning/);
  applyResult(item, result('intake'));
  action(item, 'approve-scope'); item.pending = false; applyResult(item, result('planning'));
  const stale = item.revision; action(item, 'approve-plan');
  assert.equal(item.approvedPlan.tasks.length, 2); assert.equal(item.stage, 'delivery');
  assert.throws(() => applyAction(item, { action: 'update', expectedRevision: stale, message: 'Stale' }), /changed/);
  item.pending = false; applyResult(item, result('execution', 'ready_for_uat'));
  assert.equal(item.stage, 'uat'); assert.equal(item.status, 'awaiting-human');
  assert.throws(() => action(item, 'accept-uat', { results: [] }), /every UAT/);
  assert.throws(() => action(item, 'accept-uat', { results: item.uat.map(s => ({ id: s.id, status: 'failed' })) }), /must pass/);
  action(item, 'accept-uat', { results: item.uat.map(s => ({ id: s.id, status: 'passed' })) });
  assert.equal(item.stage, 'uat'); assert.equal(item.pending, true); assert.ok(item.approvedUat);
  item.pending = false;
  assert.throws(() => applyResult(item, result('uat')), /records were updated/);
  applyResult(item, { ...result('uat'), evidence: ['Fixture: accepted Human task and milestone records updated.'] });
  assert.equal(item.status, 'complete'); assert.equal(item.approvalHistory.at(-1).by, 'Human');
});

test('questions, revisions and UAT rework preserve history without expanding authority', () => {
  const item = createInitiative({ title: 'Example', request: 'Request', start: false });
  const question = { ...result('intake', 'questions'), questions: [{ id: 'existing', prompt: 'Keep existing data?' }] };
  applyResult(item, question); assert.throws(() => action(item, 'approve-scope'), /Finish Intake/);
  assert.throws(() => action(item, 'answer', { answers: {} }), /Keep existing data/);
  action(item, 'answer', { answers: { existing: 'Yes' } }); item.pending = false; applyResult(item, result('intake'));
  action(item, 'approve-scope'); item.pending = false; applyResult(item, result('planning')); action(item, 'approve-plan');
  item.pending = false; applyResult(item, result('execution', 'ready_for_uat')); const oldUat = item.uat.map(s => ({ id: s.id, status: 'passed' })); action(item, 'request-rework', { feedback: 'Fix the example' });
  assert.equal(item.stage, 'delivery'); assert.ok(item.approvedPlan);
  item.pending = false; applyResult(item, result('execution', 'ready_for_uat'));
  assert.throws(() => action(item, 'accept-uat', { results: oldUat }), /must pass/);
  action(item, 'scope-change', { request: 'A different outcome' });
  assert.equal(item.stage, 'intake'); assert.equal(item.approvedPlan, null); assert.equal(item.approvedScope, null);
  assert.equal(item.approvalHistory.length, 2); assert.ok(item.messages.find(m => m.type === 'answers'));
});

test('agent checkpoints automatically continue delivery through every phase to UAT', () => fixture(async context => {
  let executions = 0; const calls = [];
  const engine = new ControlEngine(context, { protocol, runner: async ({ prompt }) => {
    const stage = /Current stage: (\w+)/.exec(prompt)[1]; calls.push(stage);
    return { threadId: 'fixture', exitCode: 0, result: result(stage, stage === 'execution' ? (++executions === 1 ? 'in_progress' : 'ready_for_uat') : 'ready') };
  } });
  try {
    const created = await engine.create({ title: 'Example', request: 'Request' }); const id = created.initiatives[0].id;
    let item = await until(async () => (await engine.read()).initiatives.find(i => i.id === id && i.status === 'awaiting-human'));
    await engine.action(id, { action: 'approve-scope', expectedRevision: item.revision });
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'planning' && i.status === 'awaiting-human'));
    await engine.action(id, { action: 'approve-plan', expectedRevision: item.revision });
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'uat'));
    assert.deepEqual(calls, ['intake', 'planning', 'execution', 'execution']); assert.equal(item.approvalHistory.length, 2);
    assert.equal(item.runs.length, 4); assert.equal(item.status, 'awaiting-human');
  } catch (error) {
    throw new Error(`${error.message}\nEngine diagnostics: ${JSON.stringify({ state: await engine.read(), lastError: engine.lastError, current: Boolean(engine.current), pumping: engine.pumping, calls })}`);
  } finally { await engine.close(); }
}));

test('cancel during durable admission reaches the abort signal before runner work', () => fixture(async context => {
  let admission; let release; const held = new Promise(r => { release = r; }); const reached = new Promise(r => { admission = r; });
  let startedWithoutAbort = false;
  const engine = new ControlEngine(context, { protocol, runner: async ({ signal }) => { startedWithoutAbort ||= !signal.aborted; throw new Error('Stopped fixture'); } });
  const original = engine.mutate.bind(engine); let intercept = true;
  engine.mutate = async fn => { const state = await original(fn); if (intercept && state.activeRun) { intercept = false; admission(); await held; } return state; };
  try {
    await engine.create({ title: 'Example', request: 'Request' }); await reached;
    const item = (await engine.read()).initiatives[0]; await engine.action(item.id, { action: 'cancel', expectedRevision: item.revision });
    release(); await until(async () => !(await engine.read()).activeRun);
    assert.equal(startedWithoutAbort, false); assert.equal((await engine.read()).initiatives[0].status, 'cancelled');
  } finally { release(); await engine.close(); }
}));

test('plan approval binds the Git baseline and grants the bridge only to delivery', () => fixture(async context => {
  const bridges = []; let planningRuns = 0;
  const engine = new ControlEngine(context, { protocol,
    bridgeFactory: async options => {
      bridges.push(options);
      const descriptor = { managedRoot: path.join(context.stateDir, 'candidates', 'fixture'), channelPath: path.join(options.runDirectory, 'git-channel') };
      await fs.mkdir(descriptor.managedRoot, { recursive: true });
      await fs.mkdir(path.join(descriptor.channelPath, 'requests'), { recursive: true });
      return { descriptor, close: async () => {} };
    },
    runner: async ({ prompt, additionalWritableRoots }) => {
      assert.ok(!additionalWritableRoots.includes(context.stateDir));
      for (const protectedPath of ['control.json', 'git-receipts', 'service.lock']) {
        const target = path.join(context.stateDir, protectedPath);
        assert.ok(additionalWritableRoots.every(root => target !== root && !target.startsWith(root + path.sep)));
      }
      const stage = /Current stage: (\w+)/.exec(prompt)[1];
      if (stage === 'planning') planningRuns++;
      const outcome = result(stage, stage === 'execution' ? 'ready_for_uat' : 'ready');
      if (stage === 'uat') outcome.evidence = ['Fixture: authoritative UAT records closed.'];
      return { threadId: 'fixture', exitCode: 0, result: outcome };
    },
  });
  try {
    const id = (await engine.create({ title: 'Bound baseline', request: 'Request' })).initiatives[0].id;
    let item = await until(async () => (await engine.read()).initiatives.find(i => i.id === id && i.status === 'awaiting-human'));
    await engine.action(id, { action: 'approve-scope', expectedRevision: item.revision });
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'planning' && i.status === 'awaiting-human'));
    const oldHead = item.planningBaseline;
    assert.equal(bridges.length, 0);
    execFileSync('git', ['-C', context.sourceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Changed baseline'], { stdio: 'ignore', windowsHide: true });
    const refreshed = await engine.action(id, { action: 'approve-plan', expectedRevision: item.revision });
    assert.equal(refreshed.initiatives[0].approvedPlan, null);
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'planning' && i.status === 'awaiting-human' && i.planningBaseline !== oldHead));
    assert.equal(planningRuns, 2); assert.equal(bridges.length, 0);
    await engine.action(id, { action: 'approve-plan', expectedRevision: item.revision });
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'uat'));
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].baseHead, item.approvedPlan.baseHead);
    assert.equal(bridges[0].planHash, item.approvedPlan.gitGrantHash);
    assert.equal(item.approvalHistory.at(-1).baseHead, item.planningBaseline);
    assert.equal(item.approvalHistory.filter(a => a.type === 'plan').length, 1);
    await engine.action(id, { action: 'accept-uat', expectedRevision: item.revision, results: item.uat.map(step => ({ id: step.id, status: 'passed' })) });
    item = await until(async () => (await engine.read()).initiatives.find(i => i.stage === 'complete'));
    assert.equal(bridges.length, 1); assert.equal(item.approvalHistory.filter(a => a.type === 'uat').length, 1);
    assert.equal(item.approvedUat.candidateEvidence.length, 1);
    assert.equal(item.runs.at(-1).stage, 'uat');
  } finally { await engine.close(); }
}));

test('restart fences live and unknown processes; it never automatically replays uncertain work', () => fixture(async context => {
  const item = createInitiative({ title: 'Interrupted', request: 'Request', start: false });
  item.status = 'running'; item.runs = [{ id: 'old', status: 'running' }];
  const second = createInitiative({ title: 'Queued', request: 'Request' });
  await updateState(context, 'control', () => ({ schemaVersion: 1, revision: 1, initiatives: [item, second], activeRun: { id: 'old', initiativeId: item.id } }));
  let launched = false;
  const engine = new ControlEngine(context, { protocol, runner: async () => { launched = true; throw new Error('fixture'); } });
  try {
    await engine.recover(); await engine.pump(); assert.equal(launched, false);
    const current = (await engine.read()).initiatives[0];
    await assert.rejects(engine.action(item.id, { action: 'retry', expectedRevision: current.revision }), /unidentified/);
    await engine.action(item.id, { action: 'recover-run', confirmedStopped: true, expectedRevision: current.revision });
    await until(() => launched); assert.equal((await engine.read()).initiatives[0].status, 'failed');
  } finally { await engine.close(); }
}));

test('HTTP uses loopback, token/origin guards, real state, stale revisions, and safe static routes', () => fixture(async context => {
  const app = await createControlServer({ context, capabilities: { codex: false }, backlog: { list: async () => [{ id: 'VAL-1', title: 'Existing task', status: 'Ready' }] }, runner: async () => { throw new Error('Fixture does not launch Codex'); } });
  try {
    const state = await (await fetch(app.url + '/api/state')).json(); assert.equal(state.tasks[0].title, 'Existing task');
    const payload = { title: '<img src=x onerror=alert(1)>', request: 'Request', start: false };
    const write = (extra = {}) => fetch(app.url + '/api/initiatives', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': state.csrfToken, ...extra }, body: JSON.stringify(payload) });
    assert.equal((await write({ 'X-Switchflow-Token': '' })).status, 403);
    assert.equal((await write({ Origin: 'https://attacker.example' })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => { const req = http.get(app.url + '/api/state', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(reboundStatus, 403);
    const response = await write(); assert.equal(response.status, 201); const { initiative } = await response.json(); assert.equal(initiative.title, payload.title);
    const stale = await fetch(`${app.url}/api/initiatives/${initiative.id}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': state.csrfToken }, body: JSON.stringify({ action: 'update', expectedRevision: 0, message: 'Stale' }) });
    assert.equal(stale.status, 409); assert.equal((await fetch(app.url + '/unknown.js')).status, 404);
    const home = await fetch(app.url + '/control'); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await home.text(), /Switchflow/);
  } finally { await app.close(); }
}));
