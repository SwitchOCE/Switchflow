import './git-test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitiative, applyAction, applyResult } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { needsOwner, eventLine } from '../template/.switchflow/scripts/control/summary.mjs';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import { fixture, roomyPool } from './agent-fakes.mjs';

function result(stage, status = 'ready', extra = {}) {
  return {
    stage,
    status,
    summary: `${stage} checkpoint`,
    nextAction: 'Review the checkpoint.',
    questions: [],
    scope: 'Fixture scope',
    plan: stage === 'planning' ? [{ phase: 'one', task: 'Example', outcome: 'Works', evidence: 'Run it' }] : [],
    evidence: stage === 'execution' ? ['Fixture receipt.'] : [],
    blockers: [],
    uat: stage === 'execution' ? ['Try the example'] : [],
    ...extra,
  };
}
const act = (item, action, extra = {}) => applyAction(item, { action, expectedRevision: item.revision, ...extra });
const actions = value => value?.actions.map(entry => entry.action);
const settle = item => {
  item.pending = false;
  return item;
};

test('needs-owner follows the browser decision buttons at every stage', () => {
  const item = createInitiative({ title: 'Example', request: 'Request', start: false });
  assert.deepEqual(needsOwner(item, null), {
    kind: 'start',
    label: 'Start intake.',
    actions: [{ action: 'start', label: 'Start intake' }],
  });
  act(item, 'start');
  assert.equal(needsOwner(item, null), null, 'queued work needs nobody');
  settle(item);
  item.status = 'running';
  assert.equal(needsOwner(item, { id: 'r', initiativeId: item.id, status: 'running' }), null);

  item.status = 'idle';
  applyResult(item, result('intake', 'questions', { questions: [{ id: 'q1', prompt: 'Keep data?' }] }));
  const questions = needsOwner(item, null);
  assert.equal(questions.kind, 'questions');
  assert.deepEqual(questions.actions, [{ action: 'answer', label: 'Send answers', needs: 'answers' }]);
  act(item, 'answer', { answers: { q1: 'Yes' } });
  settle(item);

  applyResult(item, result('intake'));
  const scope = needsOwner(item, null);
  assert.equal(scope.kind, 'scope');
  assert.deepEqual(actions(scope), ['request-changes', 'approve-scope']);
  assert.equal(scope.actions[0].needs, 'message');
  act(item, 'approve-scope');
  settle(item);

  applyResult(item, result('planning'));
  assert.equal(needsOwner(item, null).kind, 'plan');
  assert.deepEqual(actions(needsOwner(item, null)), ['request-changes', 'approve-plan']);
  act(item, 'approve-plan');
  settle(item);
  assert.equal(item.stage, 'delivery');
  assert.equal(needsOwner(item, null), null, 'delivery is agent work');

  applyResult(item, result('execution', 'ready_for_uat'));
  const uat = needsOwner(item, null);
  assert.equal(uat.kind, 'uat');
  assert.deepEqual(
    uat.actions.map(entry => [entry.action, entry.needs]),
    [
      ['request-rework', 'feedback'],
      ['accept-uat', 'results'],
    ],
  );
  // Without guided checks the browser offers rework only.
  assert.deepEqual(actions(needsOwner({ ...item, uat: [] }, null)), ['request-rework']);
  act(item, 'accept-uat', { results: item.uat.map(check => ({ id: check.id, status: 'passed' })) });
  settle(item);
  assert.equal(needsOwner(item, null), null, 'accepted UAT waits for the record update only');
});

test('needs-owner names holds: retry, environment, held workers and recovery', () => {
  const base = { ...createInitiative({ title: 'Held', request: 'Request', start: false }), pending: false };
  const failed = { ...base, stage: 'delivery', status: 'failed', approvedPlan: {} };
  assert.deepEqual(needsOwner(failed, null), {
    kind: 'retry',
    label: 'Review failed work before any retry.',
    actions: [{ action: 'retry', label: 'Retry from the current checkpoint' }],
  });

  const environment = {
    ...failed,
    status: 'blocked',
    environmentHold: {
      checkedAt: '2026-10-10T10:00:00.000Z',
      environments: [{ id: 'box', label: 'Box', reason: 'Off' }],
    },
  };
  assert.deepEqual(needsOwner(environment, null), {
    kind: 'environment',
    label: 'Delivery is waiting for Box.',
    actions: [{ action: 'retry', label: 'Test again' }],
  });

  const workers = { ...failed, heldWorkers: { workers: [{ workerId: 'w1', task: 'T-1', kind: 'deliver' }] } };
  const held = needsOwner(workers, null);
  assert.equal(held.kind, 'held-workers');
  assert.deepEqual(actions(held), ['resume-workers', 'retry']);

  const run = id => ({ id: 'r', initiativeId: id, status: 'interrupted', held: [] });
  const live = needsOwner(failed, { ...run(failed.id), held: [{ kind: 'stage', role: 'delivery', state: 'running' }] });
  assert.equal(live.kind, 'recovery');
  assert.deepEqual(live.actions, [{ action: 'stop-processes', label: 'Stop the running process' }]);
  const unconfirmed = needsOwner(failed, { ...run(failed.id), held: [{ kind: 'stage', state: 'unverified' }] });
  assert.deepEqual(unconfirmed.actions, [
    { action: 'recover-run', label: 'Release recovery hold', needs: 'confirmedStopped' },
  ]);
});

test('event lines read like the Agents feed and stay on one short line', () => {
  assert.equal(eventLine({ kind: 'command', command: 'npm test' }), '$ npm test');
  assert.equal(eventLine({ kind: 'tool', name: 'Edit', summary: 'app.js' }), 'Edit · app.js');
  assert.equal(eventLine({ kind: 'turn.failed', error: 'boom' }), 'Turn failed: boom');
  assert.equal(eventLine({ kind: 'message', text: '\nFirst\nSecond' }), 'First');
  assert.equal(eventLine({ kind: 'message', text: 'x'.repeat(500) }).length, 200);
  assert.equal(eventLine(null), null);
});

test('summary API is compact, versioned, answers unchanged and rolls up every project', () =>
  fixture(async context => {
    const app = await createControlServer({
      context,
      capabilities: { codex: false },
      capacity: { pool: roomyPool() },
      backlog: { list: async () => [] },
      runner: async () => {
        throw new Error('Fixture does not launch agents');
      },
    });
    const base = `${app.url}/api/projects/${context.id}`;
    try {
      const { csrfToken } = await (await fetch(`${app.url}/api/projects`)).json();
      const post = (url, body) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken },
          body: JSON.stringify(body),
        });
      const empty = await (await fetch(`${base}/summary`)).json();
      assert.match(empty.version, /^[a-f0-9]{16}$/);
      assert.deepEqual(empty.project, { id: context.id, name: app.projects.get(context.id).project.name });
      assert.deepEqual(empty.initiatives, []);
      assert.deepEqual(empty.workers, []);
      assert.equal(empty.activeRun, null);
      assert.equal(empty.needsOwner, 0);
      assert.deepEqual(Object.keys(empty.capacity).sort(), [
        'leases',
        'memory',
        'pauseLocalWorkers',
        'queue',
        'workers',
      ]);
      assert.equal(empty.capacity.pauseLocalWorkers, false);
      assert.equal(empty.capacity.leases, 0);
      assert.equal(empty.environments[0].id, 'local');
      assert.equal(empty.environments[0].lastHealth, null);
      assert.deepEqual(empty.holds, []);

      const unchanged = await (await fetch(`${base}/summary?since=${empty.version}`)).json();
      assert.deepEqual(unchanged, { unchanged: true, version: empty.version });

      const created = await post(`${base}/initiatives`, { title: 'Summarize', request: 'Do it', start: false });
      const { initiative } = await created.json();
      const one = await (await fetch(`${base}/summary?since=${empty.version}`)).json();
      assert.notEqual(one.version, empty.version, 'a write changes the version at once');
      assert.deepEqual(
        one.initiatives.map(({ id, title, stage, status, needsOwner: owner }) => ({
          id,
          title,
          stage,
          status,
          kind: owner?.kind,
        })),
        [{ id: initiative.id, title: 'Summarize', stage: 'intake', status: 'idle', kind: 'start' }],
      );
      assert.equal(one.needsOwner, 1);

      // Environment health from a test shows on the summary.
      const tested = await (await post(`${base}/agents/environments/local/test`, {})).json();
      const healthy = await (await fetch(`${base}/summary`)).json();
      assert.equal(healthy.environments[0].lastHealth.ok, tested.ok === true);
      assert.equal(healthy.environments[0].lastHealth.checkedAt, tested.checkedAt);

      // Holds come from the control state the browser reads.
      await updateState(context, 'control', state => {
        const item = state.initiatives[0];
        Object.assign(item, {
          stage: 'delivery',
          status: 'blocked',
          approvedPlan: {},
          environmentHold: {
            checkedAt: new Date().toISOString(),
            environments: [{ id: 'box', label: 'Box', reason: 'Off' }],
          },
        });
        state.revision++;
        return state;
      });
      const held = await (await fetch(`${base}/summary`)).json();
      assert.deepEqual(held.holds, [
        { kind: 'environment', initiativeId: initiative.id, reason: 'Box is not ready (Off)', environments: ['box'] },
      ]);
      assert.equal(held.initiatives[0].needsOwner.kind, 'environment');

      const rolled = await (await fetch(`${app.url}/api/summary`)).json();
      assert.match(rolled.version, /^[a-f0-9]{16}$/);
      assert.deepEqual(rolled.projects, [
        {
          id: context.id,
          name: held.project.name,
          available: true,
          stage: 'delivery',
          needsOwner: 1,
          workers: 0,
          activeRun: false,
        },
      ]);
      assert.equal(rolled.needsOwner, 1);
      assert.deepEqual(await (await fetch(`${app.url}/api/summary?since=${rolled.version}`)).json(), {
        unchanged: true,
        version: rolled.version,
      });
      assert.equal((await fetch(`${app.url}/api/projects/${'0'.repeat(64)}/summary`)).status, 404);
    } finally {
      await app.close();
    }
  }));
