import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBacklogAdapter } from '../template/.switchflow/scripts/control/backlog-adapter.mjs';

async function fixture(run) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-adapter-'));
  const context = { stateDir, governanceRoot: stateDir, sourceRoot: stateDir };
  let milestone = { id: 'm-27', title: 'Later ID, first execution', description: '', labels: ['delivery'], executionOrder: 0, revision: 'a'.repeat(64) };
  let task = { id: 'TEST-1', title: 'Task', status: 'Blocked', description: 'Existing', blockReason: 'dependent', revision: 'b'.repeat(64) };
  const calls = [];
  const execute = async (_exe, args) => {
    calls.push(args);
    if (args[1] === 'milestone') return { stdout: JSON.stringify(args[2] === 'list' ? [milestone] : milestone) };
    if (args[1] === 'task') return { stdout: JSON.stringify({ task }) };
    return { stdout: '' };
  };
  const mutations = [];
  const callTool = async (_cli, root, name, input) => {
    mutations.push({ root, name, input });
    if (name === 'milestone_edit') milestone = { ...milestone, ...input, revision: 'c'.repeat(64) };
    else task = { ...task, ...input, revision: 'd'.repeat(64) };
  };
  const adapter = createBacklogAdapter(context, { cliPath: path.join(stateDir, 'cli.cjs'), execute, callTool });
  try { await run({ adapter, context, calls, mutations, setTask: value => task = { ...task, ...value } }); }
  finally { await fs.rm(stateDir, { recursive: true, force: true }); }
}

test('milestone adapter preserves identity and transports explicit order, descriptions, labels with CAS', async () => fixture(async ({ adapter, mutations, context }) => {
  assert.equal((await adapter.listMilestones())[0].id, 'm-27');
  const before = await adapter.viewMilestone('m-27'); assert.equal(before.atomicRevision, true);
  const after = await adapter.editMilestone('m-27', { expectedRevision: before.revision, title: 'Edited', description: '', labels: [' urgent ', 'urgent'], executionOrder: null });
  assert.equal(after.id, 'm-27'); assert.equal(after.executionOrder, null);
  assert.deepEqual(mutations[0], { root: context.governanceRoot, name: 'milestone_edit', input: { id: 'm-27', expectedRevision: before.revision, title: 'Edited', description: '', labels: ['urgent'], executionOrder: null } });
  await assert.rejects(adapter.editMilestone('m-27', { expectedRevision: before.revision, title: 'Stale' }), error => error.status === 409);
  assert.equal(mutations.length, 1);
}));

test('milestone adapter rejects invalid metadata before mutation', async () => fixture(async ({ adapter, mutations }) => {
  for (const changes of [{ executionOrder: -1 }, { executionOrder: 1.5 }, { labels: ['a,b'] }, { id: 'm-1' }, { title: '' }]) {
    await assert.rejects(adapter.editMilestone('m-27', { expectedRevision: 'a'.repeat(64), ...changes }));
  }
  await assert.rejects(adapter.viewMilestone('../m-27'));
  assert.equal(mutations.length, 0);
}));

test('milestone edits preserve long scope descriptions within the bounded browser transport', async () => fixture(async ({ adapter, mutations }) => {
  const description = 'Scope: readability and preserved evidence.\n'.repeat(2500);
  const before = await adapter.viewMilestone('m-27');
  const after = await adapter.editMilestone('m-27', { expectedRevision: before.revision, description });
  assert.equal(after.description, description.trim());
  assert.equal(mutations[0].input.description, description.trim());
}));

test('task block reason edits preserve status and CAS while retaining active-work protection', async () => fixture(async ({ adapter, mutations, setTask }) => {
  const task = await adapter.view('TEST-1');
  await adapter.edit('TEST-1', { expectedRevision: task.revision, blockReason: 'Waiting for supplier' });
  assert.deepEqual(mutations[0].input, { id: 'TEST-1', expectedRevision: task.revision, blockReason: 'Waiting for supplier' });
  assert.equal(mutations[0].name, 'task_edit');
  const updated = await adapter.view('TEST-1');
  await adapter.edit('TEST-1', { expectedRevision: updated.revision, blockReason: '' });
  assert.equal(mutations[1].input.blockReason, '');
  setTask({ status: 'Done' });
  await assert.rejects(adapter.edit('TEST-1', { expectedRevision: 'd'.repeat(64), blockReason: '' }), error => error.status === 409);
  assert.equal(mutations.length, 2);
}));
