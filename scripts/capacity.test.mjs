import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readState, updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import { AgentHost } from '../template/.switchflow/scripts/control/agent-host.mjs';
import { ControlEngine } from '../template/.switchflow/scripts/control/engine.mjs';
import { createInitiative } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import * as protocol from '../template/.switchflow/scripts/control/agent-protocol.mjs';
import { Orchestration, resumeInstructions } from '../template/.switchflow/scripts/control/orchestration.mjs';
import {
  CAPACITY_CONFIG,
  PAUSED_REASON,
  readCapacityProfile,
  validateCapacityProfile,
} from '../template/.switchflow/scripts/control/capacity.mjs';
import { safeWorkerEnv, withWorkerEnv } from '../template/.switchflow/scripts/control/worker-env.mjs';
import { composeProjectName, defaultRunner } from '../template/.switchflow/scripts/control/worker-resources.mjs';
import { childEnvironment } from '../template/.switchflow/scripts/control/providers/process.mjs';
import { codexAppServerArguments } from '../template/.switchflow/scripts/control/providers/codex-app-server.mjs';
import { codexArguments, isRunProcessAlive } from '../template/.switchflow/scripts/control/codex-runner.mjs';
import { ProcessTracker, descendantsOf, parseElapsed } from '../template/.switchflow/scripts/control/process-tree.mjs';
import { recordDelegation } from '../template/.switchflow/scripts/control/worker-ledger.mjs';
import { fakeMachine, fakeProvider, fixture, roomyPool, until } from './agent-fakes.mjs';

const both = { codex: { available: true }, claude: { available: true, loggedIn: true } };
const planHash = 'b'.repeat(64);
const MINUTE = 60 * 1000;

function respond(text, options, sandbox) {
  if (options.sandbox === 'read-only')
    return {
      task: 'DEMO-1',
      verdict: 'accept',
      findings: [],
      blastRadius: 'none',
      comment: 'Verdict: accept',
      envelope: '',
    };
  return {
    task: 'DEMO-1',
    outcome: sandbox === 'read-only' ? 'approach' : 'handoff',
    approach: 'a',
    head: 'h',
    envelope: 'e',
    summary: 's',
    blockers: [],
  };
}

async function writeProfile(context, profile) {
  const file = path.join(context.governanceRoot, ...CAPACITY_CONFIG.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof profile === 'string' ? profile : JSON.stringify(profile));
}

/** An orchestration with one candidate, fake providers and the given memory pool. */
async function orchestrate(context, { pool, maxWorkers = 8, providers, resources = {} } = {}) {
  const initiativeId = randomUUID();
  const managedRoot = path.join(context.stateDir, 'candidates', 'grant');
  const candidate = path.join(managedRoot, 'cand');
  await fs.mkdir(candidate, { recursive: true });
  const real = await fs.realpath(candidate);
  await updateState(context, `git-bridge-${initiativeId}-${planHash}`, () => ({
    schemaVersion: 1,
    initiativeId,
    planHash,
    entries: [{ name: 'cand', path: real, branch: 'codex/x' }],
  }));
  const log = [];
  const host = new AgentHost(context, {
    capabilities: both,
    providers: providers ?? {
      codex: fakeProvider('codex', log, respond),
      claude: fakeProvider('claude', log, respond),
    },
    capacity: { pool, recheckMs: 0 },
    processes: { sampleMs: 0 },
    resources,
  });
  await host.init();
  await host.updateSettings({ limits: { maxWorkers } });
  const runId = randomUUID();
  const controller = new AbortController();
  const orchestration = await new Orchestration({
    host,
    runId,
    initiativeId,
    runDirectory: path.join(context.stateDir, 'runs', runId),
    gitBridge: {
      initiativeId,
      planHash,
      managedRoot: await fs.realpath(managedRoot),
      channelPath: path.join(context.stateDir, 'runs', runId, 'git-channel'),
      helperPath: path.join(context.stateDir, 'helper.mjs'),
    },
    signal: controller.signal,
    orchestratorProvider: 'claude',
    serviceUrl: 'http://127.0.0.1:9',
    projectId: context.id,
  }).prepare();
  const orchestrator = await host.registry.create({ runId, initiativeId, role: 'execution', provider: 'claude' });
  orchestration.setOrchestrator(orchestrator.id);
  const call = (tool, args, principal) => orchestration.call(tool, args, principal);
  const deliver = task => call('delegate_task', { task, kind: 'deliver', instructions: 'slow', worktree: 'cand' });
  const close = async () => {
    controller.abort();
    await orchestration.close();
    await host.close();
  };
  return { host, log, runId, orchestration, orchestrator, call, deliver, close };
}

test('the capacity profile is strict, merges with defaults and refuses unsafe worker variables', () => {
  const defaults = validateCapacityProfile({ schemaVersion: 1 });
  assert.deepEqual(defaults.memory, { admission: true, workerIdleGB: 1.5, workerGatingGB: 6, headroomGB: 3 });
  assert.deepEqual(Object.keys(defaults.leases), ['suite', 'gate', 'e2e']);
  assert.deepEqual(defaults.workerEnv, {});
  const profile = validateCapacityProfile({
    schemaVersion: 1,
    memory: { workerGatingGB: 8, headroomGB: 4 },
    leases: { gate: 3, 'docker-stack': 1, e2e: { count: 1, maxMinutes: 60 } },
    workerEnv: { VITEST_MAX_WORKERS: '2', JEST_WORKERS: '2', NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  assert.deepEqual(profile.memory, { admission: true, workerIdleGB: 1.5, workerGatingGB: 8, headroomGB: 4 });
  assert.deepEqual(profile.leases.gate, { count: 3, gating: true, maxMinutes: 120 });
  assert.deepEqual(profile.leases['docker-stack'], { count: 1, gating: false, maxMinutes: 120 });
  assert.deepEqual(profile.leases.e2e, { count: 1, gating: true, maxMinutes: 60 });
  assert.equal(profile.workerEnv.NODE_OPTIONS, '--max-old-space-size=4096');

  const refused = (value, pattern) =>
    assert.throws(
      () => validateCapacityProfile({ schemaVersion: 1, ...value }),
      error => error.status === 409 && pattern.test(error.message),
    );
  assert.throws(() => validateCapacityProfile({ schemaVersion: 2 }), /schemaVersion must be 1/);
  refused({ extra: 1 }, /unsupported field extra/);
  refused({ memory: { idle: 1 } }, /unsupported field memory\.idle/);
  refused({ memory: { workerIdleGB: 4, workerGatingGB: 2 } }, /at least memory\.workerIdleGB/);
  refused({ memory: { headroomGB: -1 } }, /headroomGB/);
  refused({ leases: { Gate: 1 } }, /lease name "Gate"/);
  refused({ leases: { gate: { count: 1, slots: 2 } } }, /unsupported field leases\.gate\.slots/);
  refused({ leases: { gate: 0 } }, /count must be a whole number/);
  for (const [name, value, pattern] of [
    ['PATH', 'C:/evil', /reserved/],
    ['Path', 'C:/evil', /reserved/],
    ['TEMP', 'C:/evil', /reserved/],
    ['CLAUDE_CONFIG_DIR', 'x', /agent/],
    ['CODEX_HOME', 'x', /agent/],
    ['ANTHROPIC_API_KEY', 'x', /agent/],
    ['GITHUB_TOKEN', 'x', /agent|secret/],
    ['GIT_SSH_COMMAND', 'x', /Git/],
    ['NPM_CONFIG_REGISTRY', 'x', /package manager/],
    ['LD_PRELOAD', 'x', /loader/],
    ['MY_SERVICE_PASSWORD', 'x', /secret/],
    ['STRIPE_KEY', 'x', /secret/],
    ['NODE_OPTIONS', '--require ./evil.js', /max-old-space-size/],
    ['NODE_OPTIONS', '--max-old-space-size=4096 --import=x', /max-old-space-size/],
    ['VITEST_MAX_WORKERS', 'two\nlines', /single-line/],
    ['VITEST_MAX_WORKERS', 2, /single-line/],
  ])
    refused({ workerEnv: { [name]: value } }, pattern);
});

test('the profile is read from the primary checkout; a broken file falls back to defaults and says why', () =>
  fixture(async context => {
    let profile = await readCapacityProfile(context);
    assert.equal(profile.source, 'defaults');
    assert.equal(profile.error, null);
    await writeProfile(context, '{ not json');
    profile = await readCapacityProfile(context);
    assert.equal(profile.source, 'defaults');
    assert.match(profile.error, /not valid JSON/);
    await writeProfile(context, { schemaVersion: 1, workerEnv: { PATH: 'x' } });
    profile = await readCapacityProfile(context);
    assert.deepEqual(profile.workerEnv, {});
    assert.match(profile.error, /workerEnv\.PATH is reserved/);
    await writeProfile(context, { schemaVersion: 1, leases: { 'docker-stack': 1 }, workerEnv: { JEST_WORKERS: '2' } });
    profile = await readCapacityProfile(context);
    assert.equal(profile.source, CAPACITY_CONFIG);
    assert.equal(profile.error, null);
    assert.equal(profile.leases['docker-stack'].count, 1);
  }));

test('worker caps reach every agent process without overriding host or security variables', () =>
  fixture(async context => {
    const env = childEnvironment(
      'C:/tmp/run',
      { CLAUDE_CODE_ENTRYPOINT: 'switchflow' },
      { VITEST_MAX_WORKERS: '2', NODE_OPTIONS: '--max-old-space-size=4096', PATH: 'C:/evil', TMP: 'C:/evil' },
    );
    assert.equal(env.VITEST_MAX_WORKERS, '2');
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.TMP, 'C:/tmp/run');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'switchflow');
    assert.equal(env.NO_COLOR, '1');
    // Windows names are case-insensitive: the cap replaces an existing spelling.
    assert.deepEqual(
      withWorkerEnv({ Node_Options: '--old', Path: 'p' }, { NODE_OPTIONS: '--max-old-space-size=2048' }, 'win32'),
      { Path: 'p', NODE_OPTIONS: '--max-old-space-size=2048' },
    );
    // Codex shells get the caps through its environment policy too.
    const appServer = codexAppServerArguments({
      sandbox: 'read-only',
      env: { VITEST_MAX_WORKERS: '2', OPENAI_API_KEY: 'sk-x' },
    });
    assert.ok(appServer.includes('shell_environment_policy.set.VITEST_MAX_WORKERS="2"'));
    assert.ok(!appServer.some(arg => arg.includes('OPENAI')));
    assert.ok(
      codexArguments({ outputPath: 'C:/out.json', env: { JEST_WORKERS: '1' } }).includes(
        'shell_environment_policy.set.JEST_WORKERS="1"',
      ),
    );

    // The host reads the profile and hands its caps to the provider it opens.
    await writeProfile(context, { schemaVersion: 1, workerEnv: { VITEST_MAX_WORKERS: '2' } });
    const log = [];
    const host = new AgentHost(context, {
      capabilities: both,
      providers: { codex: fakeProvider('codex', log), claude: fakeProvider('claude', log) },
      processes: { sampleMs: 0 },
    });
    await host.init();
    const opened = await host.openSession({
      provider: 'claude',
      role: 'delivery',
      kind: 'deliver',
      runId: randomUUID(),
      cwd: context.sourceRoot,
      sandbox: 'workspace-write',
      runDirectory: path.join(context.stateDir, 'runs', 'x'),
    });
    // A worker also gets its own compose project (and a port block when the profile declares ports).
    assert.deepEqual(log[0].options.env, {
      VITEST_MAX_WORKERS: '2',
      COMPOSE_PROJECT_NAME: `sf-${opened.meta.id.slice(0, 8)}`,
    });
    await host.closeSession(opened.meta, opened.handle, { status: 'completed' });
    await host.close();
  }));

test('memory admission queues workers first in first out and starts them as memory frees', () =>
  fixture(async context => {
    // 5 GB free of 32 with the default 3 GB headroom: room for one 1.5 GB worker at a time
    // while new workers are still growing into their budget.
    const machine = fakeMachine({ free: 5, total: 32 });
    const { host, orchestration, call, deliver, close } = await orchestrate(context, { pool: machine.pool });
    try {
      const first = await deliver('DEMO-1');
      assert.equal(first.status, 'working');
      const second = await deliver('DEMO-2');
      const third = await deliver('DEMO-3');
      assert.equal(second.status, 'queued');
      assert.deepEqual(
        [second.queue.position, second.queue.reason],
        [1, 'needs 1.5 GB, 0.5 GB available (5 GB free, 1.5 GB held for workers still starting, 3 GB headroom)'],
      );
      assert.deepEqual(
        [third.status, third.queue.position, third.queue.reason],
        ['queued', 2, 'waiting behind 1 earlier worker'],
      );
      // The orchestrator sees the queue; a wait does not return for a queued worker.
      const [status] = (await call('worker_status', { workerId: second.workerId })).workers;
      assert.equal(status.queue.position, 1);
      const waited = await call('wait_for_workers', { workerIds: [second.workerId], timeoutSeconds: 1 });
      assert.equal(waited.timedOut, true);
      let capacity = await host.capacity.status({ maxWorkers: 8 });
      assert.deepEqual(capacity.workers, { admitted: 1, queued: 2, maxWorkers: 8 });
      assert.deepEqual(
        capacity.queue.map(entry => [entry.task, entry.position]),
        [
          ['DEMO-2', 1],
          ['DEMO-3', 2],
        ],
      );
      assert.equal(capacity.memory.freeGB, 5);

      // Once the first worker has had time to grow, its use shows in "free" and the next starts.
      machine.advance(3 * MINUTE);
      await host.capacity.pump();
      await until(
        async () => (await call('worker_status', { workerId: second.workerId })).workers[0].status === 'working',
      );
      assert.equal((await call('worker_status', { workerId: third.workerId })).workers[0].queue.position, 1);

      // A worker that finishes releases its budget, which starts the next one by itself.
      machine.advance(3 * MINUTE);
      await orchestration.finishWorker(orchestration.worker(first.workerId), 'completed');
      await until(
        async () => (await call('worker_status', { workerId: third.workerId })).workers[0].status === 'working',
      );

      // Interrupting a queued worker cancels it.
      machine.free = 2;
      const fourth = await deliver('DEMO-4');
      assert.equal(fourth.status, 'queued');
      assert.deepEqual(await call('interrupt_worker', { workerId: fourth.workerId }), {
        workerId: fourth.workerId,
        interrupted: true,
        cancelled: true,
      });
      assert.equal((await call('worker_status', { workerId: fourth.workerId })).workers[0].status, 'cancelled');
      capacity = (await host.list()).capacity;
      assert.equal(capacity.workers.queued, 0);
      assert.equal(capacity.workers.admitted, 2);
    } finally {
      await close();
    }
  }));

test('with no other worker running, one worker starts even below its budget and says so', () =>
  fixture(async context => {
    const machine = fakeMachine({ free: 2, total: 8 });
    const { deliver, close } = await orchestrate(context, { pool: machine.pool });
    try {
      const only = await deliver('DEMO-1');
      assert.equal(only.status, 'working');
      assert.match(only.capacityNote, /less memory than its budget .* because no other worker is running/);
      assert.equal((await deliver('DEMO-2')).status, 'queued');
    } finally {
      await close();
    }
  }));

test('leases share named resources in order, renew, expire, and release with their session', () =>
  fixture(async context => {
    await writeProfile(context, { schemaVersion: 1, leases: { 'docker-stack': { count: 1, maxMinutes: 60 } } });
    const machine = fakeMachine();
    const { host, orchestration, orchestrator, call, deliver, close } = await orchestrate(context, {
      pool: machine.pool,
    });
    try {
      const [w1, w2, w3] = [await deliver('DEMO-1'), await deliver('DEMO-2'), await deliver('DEMO-3')].map(
        worker => worker.workerId,
      );
      const lease = (principal, args) => call('acquire_lease', args, principal);
      const a = await lease(w1, { name: 'gate', timeoutSeconds: 1 });
      assert.deepEqual([a.acquired, a.name, a.minutesLeft, a.task, a.kind], [true, 'gate', 30, 'DEMO-1', 'deliver']);
      assert.equal((await lease(w2, { name: 'gate' })).acquired, true);
      const busy = await lease(w3, { name: 'gate', timeoutSeconds: 1 });
      assert.equal(busy.acquired, false);
      assert.equal(
        busy.reason,
        'gate: 2 of 2 held by DEMO-1 deliver worker, 30 min left; DEMO-2 deliver worker, 30 min left',
      );
      const waiting = lease(w3, { name: 'gate', timeoutSeconds: 20 });
      await assert.rejects(call('release_lease', { id: a.id }, w2), error => error.status === 403);
      assert.deepEqual(await call('release_lease', { id: a.id }, w1), { released: true, id: a.id, name: 'gate' });
      assert.equal((await waiting).acquired, true);

      await assert.rejects(
        lease(w1, { name: 'nope' }),
        /Unknown lease "nope". This project declares: suite, gate, e2e, docker-stack/,
      );
      await assert.rejects(lease(w1, { name: 'docker-stack', ttlMinutes: 61 }), /ttlMinutes must be 1–60/);
      await assert.rejects(call('delegate_task', { task: 'DEMO-9' }, w1), error => error.status === 403);

      // Renewing extends the time limit; an overdue lease is released and its holder told.
      const stack = await lease(w1, { name: 'docker-stack', ttlMinutes: 10 });
      machine.advance(5 * MINUTE);
      const renewed = await lease(w1, { name: 'docker-stack', ttlMinutes: 10 });
      assert.deepEqual([renewed.renewed, renewed.id, renewed.minutesLeft], [true, stack.id, 10]);
      machine.advance(11 * MINUTE);
      const listed = await call('list_leases', {}, w2);
      assert.equal(listed.resources.find(resource => resource.name === 'docker-stack').held, 0);
      assert.deepEqual(listed.leases.map(entry => [entry.name, entry.task]).sort(), [
        ['gate', 'DEMO-2'],
        ['gate', 'DEMO-3'],
      ]);
      await until(async () =>
        (await host.events(w1, 0, 500)).events.some(
          event => event.kind === 'notice' && /Lease "docker-stack" expired after 15 min/.test(event.text),
        ),
      );

      // The orchestrator can hold leases too, and release a stuck worker's.
      const own = await call('acquire_lease', { name: 'e2e' });
      assert.equal(own.holder, orchestrator.id);
      const w2Gate = listed.leases.find(entry => entry.task === 'DEMO-2');
      assert.equal((await call('release_lease', { id: w2Gate.id })).released, true);

      // Closing a session releases its leases; the persisted record follows.
      await orchestration.finishWorker(orchestration.worker(w3), 'completed');
      const stored = await readState(context, 'leases', { leases: [] });
      assert.deepEqual(
        stored.leases.map(entry => entry.name),
        ['e2e'],
      );
    } finally {
      await close();
    }
    assert.deepEqual((await readState(context, 'leases', { leases: [] })).leases, []);
  }));

test('a gating lease also waits for the memory a gate needs', () =>
  fixture(async context => {
    const machine = fakeMachine({ free: 10, total: 32 });
    const { call, deliver, close } = await orchestrate(context, { pool: machine.pool });
    try {
      const w1 = (await deliver('DEMO-1')).workerId;
      const w2 = (await deliver('DEMO-2')).workerId;
      // The first gate on the machine is always granted.
      assert.equal((await call('acquire_lease', { name: 'gate' }, w1)).acquired, true);
      const refused = await call('acquire_lease', { name: 'gate', timeoutSeconds: 1 }, w2);
      assert.equal(refused.acquired, false);
      assert.match(refused.reason, /^gate: gating needs 4\.5 GB, 0 GB available \(10 GB free, 7\.5 GB held/);
      machine.free = 30;
      machine.advance(3 * MINUTE);
      assert.equal((await call('acquire_lease', { name: 'gate', timeoutSeconds: 1 }, w2)).acquired, true);
    } finally {
      await close();
    }
  }));

test('after a restart, leases of gone sessions are released unless the restart fence still holds their run', () =>
  fixture(async context => {
    const fencedRun = randomUUID();
    const at = Date.now();
    const stored = (runId, name) => ({
      id: randomUUID(),
      name,
      holder: randomUUID(),
      runId,
      task: 'DEMO-1',
      kind: 'deliver',
      acquiredAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 30 * MINUTE).toISOString(),
    });
    await updateState(context, 'leases', () => ({
      schemaVersion: 1,
      leases: [stored(fencedRun, 'e2e'), stored(randomUUID(), 'gate')],
    }));
    let state = { activeRun: { id: fencedRun, status: 'interrupted', held: [{ kind: 'deliver', state: 'running' }] } };
    const host = new AgentHost(context, { capabilities: both, capacity: { pool: fakeMachine().pool } });
    await host.init();
    host.bind({ read: async () => state });
    let { leases } = await host.capacity.listLeases();
    assert.deepEqual(
      leases.map(lease => lease.name),
      ['e2e'],
    );
    // Once the owner clears the fence, the remaining lease goes too.
    state = { activeRun: null };
    ({ leases } = await host.capacity.listLeases());
    assert.deepEqual(leases, []);
    assert.deepEqual((await readState(context, 'leases', {})).leases, []);
    await host.close();
  }));

test('the process tracker stops only what a closed session left running', async () => {
  const now = 10_000_000;
  let processes = [
    { pid: 4, ppid: 0, startedAt: 0, name: 'System' },
    { pid: 50, ppid: 4, startedAt: 1000, name: 'node.exe' }, // the service
    { pid: 100, ppid: 50, startedAt: now + 10, name: 'claude.exe' },
    { pid: 101, ppid: 100, startedAt: now + 20, name: 'cmd.exe' },
    { pid: 102, ppid: 101, startedAt: now + 30, name: 'node.exe' }, // dev server
    { pid: 103, ppid: 102, startedAt: now + 40, name: 'WebKitNetworkProcess' },
    { pid: 104, ppid: 100, startedAt: now - 60000, name: 'old.exe' }, // older than its "parent": a stale PID link
    { pid: 200, ppid: 50, startedAt: now + 10, name: 'codex.exe' }, // another session
    { pid: 201, ppid: 200, startedAt: now + 20, name: 'node.exe' },
  ];
  const stopped = [];
  const alive = pid => processes.some(entry => entry.pid === pid);
  const tracker = new ProcessTracker({
    list: async () => processes.map(entry => ({ ...entry })),
    stop: async pid => {
      stopped.push(pid);
      processes = processes.filter(entry => entry.pid !== pid);
      return true;
    },
    alive,
    clock: () => now,
    sampleMs: 0,
    self: 50,
  });
  tracker.begin('s1');
  tracker.track('s1', 100);
  tracker.track('s2', 200);
  await tracker.sample();
  // The agent and its shell exit; the dev server and browser are orphans now. The browser's PID
  // is then reused by an unrelated program.
  processes = processes.filter(entry => ![100, 101, 103].includes(entry.pid));
  processes.push({ pid: 103, ppid: 4, startedAt: now + 600000, name: 'notepad.exe' });
  assert.deepEqual(await tracker.cleanup('s1'), [{ pid: 102, name: 'node.exe' }]);
  assert.deepEqual(stopped, [102]);
  // A process older than the session never becomes its root, so nothing under it is touched.
  tracker.track('s3', 4);
  await tracker.sample('s3');
  assert.deepEqual(await tracker.cleanup('s3'), []);
  assert.deepEqual(stopped, [102]);
  tracker.close();

  assert.equal(parseElapsed('05:07'), 307000);
  assert.equal(parseElapsed('2-03:04:05'), (((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
  assert.deepEqual(
    descendantsOf(
      [
        { pid: 1, ppid: 0, startedAt: 5 },
        { pid: 2, ppid: 1, startedAt: 6 },
        { pid: 3, ppid: 2, startedAt: 7 },
      ],
      { pid: 1, startedAt: 5 },
    ).map(entry => entry.pid),
    [2, 3],
  );
});

test('closing a session stops the real processes its agent left running, and nothing else', t =>
  fixture(async context => {
    // The fake agent starts a long-running child, then exits when its stdin closes: the child is
    // an orphan, like a dev server or a browser left behind by a test run. detached lets it
    // outlive its parent on Windows too (Node otherwise ties children to the parent's job object).
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });",
      'child.unref();',
      "process.stdout.write(child.pid + '\\n');",
      "process.stdin.on('end', () => process.exit(0));",
      'process.stdin.resume();',
    ].join('\n');
    const spawned = [];
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    spawned.push(bystander.pid);
    t.after(() => {
      for (const pid of spawned)
        try {
          process.kill(pid);
        } catch {}
    });
    let orphan = null;
    const provider = async options => {
      const root = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      spawned.push(root.pid);
      await options.onProcess(root.pid);
      orphan = await new Promise(resolve => root.stdout.once('data', data => resolve(Number(String(data).trim()))));
      spawned.push(orphan);
      await options.onEvent({
        kind: 'session.started',
        provider: 'codex',
        transport: 'fake',
        threadId: 't',
        pid: root.pid,
      });
      let closed = false;
      return {
        provider: 'codex',
        threadId: 't',
        activeTurnId: null,
        get closed() {
          return closed;
        },
        async startTurn() {
          throw new Error('not used');
        },
        async close() {
          closed = true;
          const exited = once(root, 'exit');
          root.stdin.end();
          await exited;
          await options.onEvent({ kind: 'session.closed' });
        },
      };
    };
    const host = new AgentHost(context, {
      capabilities: both,
      providers: { codex: provider },
      processes: { sampleMs: 0 },
    });
    await host.init();
    const opened = await host.openSession({
      provider: 'codex',
      role: 'delivery',
      kind: 'deliver',
      runId: randomUUID(),
      task: 'DEMO-1',
      cwd: context.sourceRoot,
      sandbox: 'workspace-write',
      runDirectory: path.join(context.stateDir, 'runs', 'x'),
    });
    assert.ok(isRunProcessAlive(orphan));
    await host.closeSession(opened.meta, opened.handle, { status: 'completed' });
    await until(() => !isRunProcessAlive(orphan), 15000);
    assert.ok(isRunProcessAlive(bystander.pid), 'a process the session did not start keeps running');
    const events = (await host.events(opened.meta.id, 0, 500)).events;
    const notice = events.find(event => event.processes);
    assert.ok(notice, JSON.stringify(events));
    assert.match(notice.text, /^Stopped 1 process this session left running: node(\.exe)? \d+\.$/);
    assert.deepEqual(
      notice.processes.map(entry => entry.pid),
      [orphan],
    );
    await host.close();
  }));

test('a restart offers the held workers, and one owner action resumes them with their instructions', () =>
  fixture(async context => {
    const runId = randomUUID();
    const item = createInitiative({ title: 'Parity', request: 'Close the gaps', start: false });
    Object.assign(item, {
      stage: 'delivery',
      status: 'running',
      approvedPlan: { tasks: [], hash: 'p', scopeHash: 's', baseHead: 'abc', gitGrantHash: planHash },
      runs: [{ id: runId, status: 'running' }],
    });
    await updateState(context, 'control', () => ({
      schemaVersion: 1,
      revision: 1,
      initiatives: [item],
      activeRun: { id: runId, initiativeId: item.id, stage: 'execution', status: 'running', workers: [] },
    }));
    const delegation = (workerId, task, kind, status, extra = {}) =>
      recordDelegation(context, {
        runId,
        initiativeId: item.id,
        workerId,
        task,
        kind,
        worktree: 'cand',
        provider: kind === 'deliver' ? 'codex' : 'claude',
        instructions: `Original instructions for ${task} ${kind}.`,
        status,
        approval: kind === 'deliver' ? 'confirmed' : null,
        ...extra,
      });
    await delegation('w-open', 'DEMO-1', 'deliver', 'open');
    await delegation('w-queued', 'DEMO-2', 'deliver', 'queued');
    await delegation('w-done', 'DEMO-3', 'deliver', 'finished');
    await delegation('w-other', 'DEMO-4', 'deliver', 'open', { runId: randomUUID() });
    const runs = [];
    const engine = new ControlEngine(context, {
      protocol,
      runner: async options => {
        runs.push(options);
        throw new Error('fixture stop');
      },
      processAlive: () => false,
      bridgeFactory: async () => ({
        descriptor: { helperPath: 'h', channelPath: 'c', managedRoot: 'm' },
        close: async () => {},
      }),
    });
    try {
      await engine.recover();
      let current = (await engine.read()).initiatives[0];
      assert.deepEqual(
        current.heldWorkers.workers.map(worker => [worker.workerId, worker.task, worker.status]),
        [
          ['w-open', 'DEMO-1', 'open'],
          ['w-queued', 'DEMO-2', 'queued'],
        ],
      );
      // The fence comes first: the stage process was never recorded.
      await assert.rejects(
        engine.action(item.id, { action: 'resume-workers', expectedRevision: current.revision }),
        /unidentified/,
      );
      await engine.action(item.id, {
        action: 'recover-run',
        confirmedStopped: true,
        expectedRevision: current.revision,
      });
      current = (await engine.read()).initiatives[0];
      assert.equal(current.status, 'failed');
      await assert.rejects(
        engine.action(item.id, { action: 'resume-workers', expectedRevision: current.revision, extra: 1 }),
        /Unsupported fields: extra/,
      );
      await engine.action(item.id, { action: 'resume-workers', expectedRevision: current.revision });
      await until(() => runs.length);
      assert.deepEqual(
        runs[0].resumeWorkers.map(entry => [entry.workerId, entry.task, entry.kind, entry.instructions]),
        [
          ['w-open', 'DEMO-1', 'deliver', 'Original instructions for DEMO-1 deliver.'],
          ['w-queued', 'DEMO-2', 'deliver', 'Original instructions for DEMO-2 deliver.'],
        ],
      );
      assert.match(runs[0].prompt, /"resumedWorkers":\{"note":"The owner resumed these workers/);
      await until(async () => (await engine.read()).initiatives[0].status === 'failed');
      current = (await engine.read()).initiatives[0];
      assert.equal(current.events.filter(event => event.type === 'resume-workers').length, 1);
      assert.ok(!current.events.some(event => event.type === 'retry'));
      assert.match(
        current.events.find(event => event.type === 'resume-workers').message,
        /2 held workers: DEMO-1 deliver, DEMO-2 deliver/,
      );
      // The list is consumed by the run it started.
      assert.equal(current.heldWorkers, null);
      await assert.rejects(
        engine.action(item.id, { action: 'resume-workers', expectedRevision: current.revision }),
        /no held workers/,
      );
    } finally {
      await engine.close();
    }
  }));

test('resumed workers are delegated again with a note and their original instructions', () =>
  fixture(async context => {
    const { host, log, orchestration, orchestrator, close, call } = await orchestrate(context, {
      pool: fakeMachine().pool,
    });
    try {
      const outcome = await orchestration.resume([
        {
          workerId: 'old-review',
          task: 'DEMO-1',
          kind: 'review',
          worktree: 'cand',
          provider: 'codex',
          instructions: 'Review it.',
          status: 'queued',
        },
        {
          workerId: 'old-deliver',
          task: 'DEMO-1',
          kind: 'deliver',
          worktree: 'cand',
          provider: 'claude',
          instructions: 'Do the thing.',
          status: 'open',
          approval: 'confirmed',
        },
      ]);
      assert.deepEqual(outcome.failed, []);
      assert.deepEqual(outcome.resumed, ['DEMO-1 deliver (working)', 'DEMO-1 review (working)']);
      // Deliveries first, on their original provider; the reviewer is routed away from the author.
      assert.deepEqual(
        log.map(entry => [entry.name, entry.options.sandbox]),
        [
          ['claude', 'workspace-write'],
          ['codex', 'read-only'],
        ],
      );
      assert.match(
        log[0].prompt,
        /Resumed after the Switchflow service stopped\. The previous deliver worker for DEMO-1 \(claude\) had started \(approach confirmed\)/,
      );
      assert.match(log[0].prompt, /Do the thing\./);
      const workers = (await call('worker_status', {})).workers;
      assert.deepEqual(
        workers.map(worker => worker.resumedFrom),
        ['old-deliver', 'old-review'],
      );
      const notice = (await host.events(orchestrator.id, 0, 50)).events.find(event => event.kind === 'notice');
      assert.match(notice.text, /Resumed held workers: DEMO-1 deliver \(working\); DEMO-1 review \(working\)\./);
      assert.ok(
        resumeInstructions({ task: 'T', kind: 'deliver', status: 'queued', instructions: 'x'.repeat(60000) }).length <=
          50000,
      );
    } finally {
      await close();
    }
  }));

/** A docker double: records every command and answers as docker compose would. Never runs docker. */
function fakeDocker({ installed = true, projects = [] } = {}) {
  const docker = { installed, projects, calls: [], downFails: false };
  docker.run = async (argv, { environment = null } = {}) => {
    docker.calls.push({ argv, where: environment?.id ?? 'local' });
    if (!docker.installed) return { code: -1, stdout: '', stderr: 'spawn docker ENOENT' };
    const line = argv.join(' ');
    if (line === 'docker compose version') return { code: 0, stdout: 'Docker Compose version v2.29.7\n', stderr: '' };
    if (line === 'docker compose ls --all --quiet')
      return { code: 0, stdout: `${docker.projects.join('\n')}\n`, stderr: '' };
    if (argv[2] === '-p' && argv[4] === 'down') {
      if (docker.downFails) return { code: 1, stdout: '', stderr: 'Error response from daemon: conflict\n' };
      docker.projects = docker.projects.filter(name => name !== argv[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected: ${line}` };
  };
  return docker;
}
const downs = docker => docker.calls.filter(call => call.argv.includes('down')).map(call => call.argv);

test('ports and docker profile fields are strict, and only the host sets the per-worker variables', () => {
  const profile = validateCapacityProfile({
    schemaVersion: 1,
    ports: { base: 41000, blockSize: 10, blocks: 4 },
    docker: { composeDown: true },
  });
  assert.deepEqual(profile.ports, { base: 41000, blockSize: 10, blocks: 4 });
  assert.deepEqual(profile.docker, { composeDown: true });
  const defaults = validateCapacityProfile({ schemaVersion: 1 });
  assert.deepEqual([defaults.ports, defaults.docker], [null, { composeDown: false }]);
  const refused = (value, pattern) =>
    assert.throws(
      () => validateCapacityProfile({ schemaVersion: 1, ...value }),
      error => error.status === 409 && pattern.test(error.message),
    );
  refused({ ports: { base: 80, blockSize: 10, blocks: 2 } }, /ports\.base must be a whole number from 1024/);
  refused({ ports: { base: 41000, blockSize: 10 } }, /ports\.blocks/);
  refused({ ports: { base: 65000, blockSize: 100, blocks: 10 } }, /end past port 65535/);
  refused({ ports: { base: 41000, blockSize: 10, blocks: 2, step: 1 } }, /unsupported field ports\.step/);
  refused({ docker: { composeDown: 'yes' } }, /docker\.composeDown must be true or false/);
  refused({ docker: { prune: true } }, /unsupported field docker\.prune/);
  refused({ workerEnv: { COMPOSE_PROJECT_NAME: 'shared' } }, /set by the host for each worker/);
  refused({ workerEnv: { SWITCHFLOW_PORT_BASE: '3000' } }, /set by the host for each worker/);

  // Spawn sites pass the host's variables only in the host's own shape.
  assert.deepEqual(
    safeWorkerEnv({
      SWITCHFLOW_PORT_BASE: '41000',
      SWITCHFLOW_PORT_COUNT: '10',
      COMPOSE_PROJECT_NAME: 'sf-0123abcd',
      VITEST_MAX_WORKERS: '2',
    }),
    {
      VITEST_MAX_WORKERS: '2',
      SWITCHFLOW_PORT_BASE: '41000',
      SWITCHFLOW_PORT_COUNT: '10',
      COMPOSE_PROJECT_NAME: 'sf-0123abcd',
    },
  );
  assert.deepEqual(
    safeWorkerEnv({
      SWITCHFLOW_PORT_BASE: '1; rm -rf /',
      COMPOSE_PROJECT_NAME: 'webatrice-e2e',
      SWITCHFLOW_TOKEN: '1',
    }),
    {},
  );
  // Codex shells see them through its environment policy too.
  assert.ok(
    codexAppServerArguments({ sandbox: 'read-only', env: { SWITCHFLOW_PORT_BASE: '41000' } }).includes(
      'shell_environment_policy.set.SWITCHFLOW_PORT_BASE="41000"',
    ),
  );
  assert.equal(composeProjectName('0123ABCD-ef01-4000-8000-000000000000'), 'sf-0123abcd');
});

test('each worker gets its own port block and compose project; a worker waits while no block is free', () =>
  fixture(async context => {
    await writeProfile(context, { schemaVersion: 1, ports: { base: 41000, blockSize: 10, blocks: 2 } });
    const { host, log, orchestration, deliver, close } = await orchestrate(context, { pool: fakeMachine().pool });
    const envOf = workerId => log.find(entry => entry.options.id === workerId).options.env;
    try {
      const first = await deliver('DEMO-1');
      const second = await deliver('DEMO-2');
      assert.deepEqual([first.status, second.status], ['working', 'working']);
      assert.deepEqual(envOf(first.workerId), {
        SWITCHFLOW_PORT_BASE: '41000',
        SWITCHFLOW_PORT_COUNT: '10',
        COMPOSE_PROJECT_NAME: composeProjectName(first.workerId),
      });
      assert.equal(envOf(second.workerId).SWITCHFLOW_PORT_BASE, '41010');
      assert.notEqual(envOf(first.workerId).COMPOSE_PROJECT_NAME, envOf(second.workerId).COMPOSE_PROJECT_NAME);
      assert.deepEqual(
        [first.ports, first.composeProject],
        [{ base: 41000, count: 10 }, composeProjectName(first.workerId)],
      );

      const third = await deliver('DEMO-3');
      assert.equal(third.status, 'queued');
      assert.equal(third.queue.reason, 'no free port block: 2 of 2 in use (ports.blocks)');
      await host.resources.persisting;
      const stored = await readState(context, 'worker-resources', { workers: [] });
      assert.deepEqual(
        stored.workers.map(entry => [entry.holder, entry.base]).sort(),
        [
          [first.workerId, 41000],
          [second.workerId, 41010],
        ].sort(),
      );

      // A worker's session end frees its block, and the waiting worker starts on it.
      await orchestration.finishWorker(orchestration.worker(first.workerId), 'completed');
      await until(() => orchestration.worker(third.workerId).status === 'working');
      assert.equal(envOf(third.workerId).SWITCHFLOW_PORT_BASE, '41000');
    } finally {
      await close();
    }
    assert.deepEqual((await readState(context, 'worker-resources', {})).workers, []);
  }));

test('after a restart, blocks of gone workers are freed after their compose project stops, unless the fence holds their run', () =>
  fixture(async context => {
    const ports = { base: 41000, blockSize: 10, blocks: 2 };
    await writeProfile(context, { schemaVersion: 1, ports, docker: { composeDown: true } });
    const fencedRun = randomUUID();
    const record = (runId, block) => {
      const holder = randomUUID();
      const base = 41000 + block * 10;
      return { holder, runId, environment: 'local', block, base, count: 10, compose: composeProjectName(holder) };
    };
    const kept = record(fencedRun, 0);
    const gone = record(randomUUID(), 1);
    await updateState(context, 'worker-resources', () => ({ schemaVersion: 1, workers: [kept, gone] }));
    const docker = fakeDocker({ projects: ['webatrice-e2e', gone.compose, kept.compose] });
    const logged = [];
    let state = { activeRun: { id: fencedRun, status: 'interrupted' } };
    const host = new AgentHost(context, {
      capabilities: both,
      capacity: { pool: fakeMachine().pool },
      resources: { run: docker.run, log: message => logged.push(message) },
    });
    await host.init();
    host.bind({ read: async () => state });
    await host.resources.ensureLoaded();
    assert.deepEqual(
      host.resources.records.map(entry => entry.holder),
      [kept.holder],
    );
    assert.deepEqual(downs(docker), [['docker', 'compose', '-p', gone.compose, 'down', '--remove-orphans']]);
    assert.match(logged[0], /^Stopped Docker Compose project sf-[0-9a-f]{8} on this PC .*did not close/);
    // The freed block goes to the next worker; the fenced run's block stays taken.
    const next = randomUUID();
    assert.equal(host.resources.claim(next, { runId: randomUUID(), ports }), null);
    assert.deepEqual(host.resources.of(next).ports, { base: 41010, count: 10 });
    host.resources.unclaim(next);
    // Once the owner clears the fence, the rest goes too. Other projects are never touched.
    state = { activeRun: null };
    await host.resources.ensureLoaded();
    assert.deepEqual(host.resources.records, []);
    assert.deepEqual(docker.projects, ['webatrice-e2e']);
    assert.deepEqual((await readState(context, 'worker-resources', {})).workers, []);
    await host.close();
  }));

test('closing a worker session stops only its own compose project, when opted in and docker is installed', () =>
  fixture(async context => {
    const docker = fakeDocker();
    const host = new AgentHost(context, {
      capabilities: both,
      providers: { claude: fakeProvider('claude') },
      processes: { sampleMs: 0 },
      resources: { run: docker.run },
    });
    await host.init();
    const session = async ({ started = true } = {}) => {
      const opened = await host.openSession({
        provider: 'claude',
        role: 'delivery',
        kind: 'deliver',
        runId: randomUUID(),
        task: 'DEMO-1',
        cwd: context.sourceRoot,
        sandbox: 'workspace-write',
        runDirectory: path.join(context.stateDir, 'runs', randomUUID()),
      });
      const name = composeProjectName(opened.meta.id);
      // The agent brought its stack up under the project name it was given.
      if (started) docker.projects.push(name);
      await host.closeSession(opened.meta, opened.handle, { status: 'completed' });
      const events = (await host.events(opened.meta.id, 0, 500)).events;
      return { name, notices: events.filter(event => event.kind === 'notice') };
    };
    try {
      // Off unless the profile opts in: no docker command at all.
      await session();
      assert.deepEqual(docker.calls, []);
      docker.projects = ['webatrice-e2e'];

      await writeProfile(context, { schemaVersion: 1, docker: { composeDown: true } });
      let closed = await session();
      assert.deepEqual(downs(docker), [['docker', 'compose', '-p', closed.name, 'down', '--remove-orphans']]);
      assert.deepEqual(
        closed.notices.map(notice => [notice.level, notice.text]),
        [['info', `Stopped Docker Compose project ${closed.name} on this PC (down --remove-orphans).`]],
      );
      assert.deepEqual(docker.projects, ['webatrice-e2e']);

      // The project does not exist: listed, nothing stopped, nothing to say.
      docker.calls = [];
      closed = await session({ started: false });
      assert.deepEqual(
        docker.calls.map(call => call.argv.slice(1, 3).join(' ')),
        ['compose version', 'compose ls'],
      );
      assert.deepEqual(closed.notices, []);

      // A failed down is a warning on the session.
      docker.downFails = true;
      closed = await session();
      assert.deepEqual(
        [closed.notices.at(-1).level, closed.notices.at(-1).text],
        ['warning', `docker compose -p ${closed.name} down failed on this PC: Error response from daemon: conflict`],
      );
      docker.downFails = false;

      // No docker on this machine: skipped and said so.
      docker.installed = false;
      docker.calls = [];
      closed = await session();
      assert.equal(docker.calls.length, 1);
      assert.equal(
        closed.notices.at(-1).text,
        `Skipped Docker Compose cleanup of ${closed.name}: docker compose is not available on this PC.`,
      );
      // Every down ever run named that session's own project.
      assert.ok(downs(docker).every(argv => /^sf-[0-9a-f]{8}$/.test(argv[3])));
    } finally {
      await host.close();
    }
  }));

test('leases named at delegation are taken before the worker starts, all or none, and go with its session', () =>
  fixture(async context => {
    const { orchestration, call, close } = await orchestrate(context, { pool: fakeMachine().pool });
    const delegate = (task, leases) =>
      call('delegate_task', { task, kind: 'deliver', instructions: 'slow', worktree: 'cand', leases });
    try {
      await assert.rejects(
        delegate('DEMO-1', ['nope']),
        error =>
          error.status === 404 &&
          /Unknown lease "nope" on this PC\. It declares: suite, gate, e2e \(\.switchflow\/capacity\.json\)/.test(
            error.message,
          ),
      );
      await assert.rejects(delegate('DEMO-1', ['e2e', 'e2e']), /different lease names/);
      const first = await delegate('DEMO-1', ['e2e']);
      assert.deepEqual([first.status, first.leases], ['working', ['e2e']]);
      let listed = await call('list_leases', {});
      const held = listed.leases.find(lease => lease.name === 'e2e');
      // Held for the session, up to the lease's maxMinutes.
      assert.deepEqual(
        [held.holder, held.environment, held.task, held.kind, held.minutesLeft],
        [first.workerId, 'local', 'DEMO-1', 'deliver', 120],
      );
      const ledger = await readState(context, 'worker-ledger', { entries: [] });
      assert.deepEqual(ledger.entries.find(entry => entry.workerId === first.workerId).leases, ['e2e']);

      const second = await delegate('DEMO-2', ['gate', 'e2e']);
      assert.equal(second.status, 'queued');
      assert.equal(second.queue.reason, 'e2e: 1 of 1 held by DEMO-1 deliver worker, 120 min left');
      listed = await call('list_leases', {});
      assert.equal(listed.resources.find(resource => resource.name === 'gate').held, 0, 'all or none');

      await orchestration.finishWorker(orchestration.worker(first.workerId), 'completed');
      await until(() => orchestration.worker(second.workerId).status === 'working');
      listed = await call('list_leases', {});
      assert.deepEqual(listed.leases.map(lease => [lease.name, lease.holder]).sort(), [
        ['e2e', second.workerId],
        ['gate', second.workerId],
      ]);
      await orchestration.finishWorker(orchestration.worker(second.workerId), 'completed');
      assert.deepEqual((await call('list_leases', {})).leases, []);
    } finally {
      await close();
    }
  }));

test('pausing local workers queues new local delegations; resuming starts them first in first out', () =>
  fixture(async context => {
    const { host, runId, orchestration, call, deliver, close } = await orchestrate(context, {
      pool: roomyPool(),
      maxWorkers: 2,
    });
    // A run holds admission: other settings are locked, but the pause toggle is not.
    host.bind({
      read: async () => ({ schemaVersion: 1, initiatives: [], activeRun: { id: runId, status: 'running' } }),
      mutate: async fn => fn({ activeRun: { id: runId, status: 'running' } }),
      trackProcess: async () => {},
      untrackProcess: async () => {},
    });
    const status = async worker => (await call('worker_status', { workerId: worker.workerId })).workers[0];
    try {
      await assert.rejects(host.updateSettings({ limits: { maxWorkers: 3 } }), /Wait for the current run/);
      const first = await deliver('DEMO-1');
      assert.equal(first.status, 'working');
      const paused = await host.updateSettings({ pauseLocalWorkers: true, expectedRevision: 1 });
      assert.equal(paused.settings.pauseLocalWorkers, true);
      assert.equal(paused.settings.revision, 2);

      const second = await deliver('DEMO-2');
      const third = await deliver('DEMO-3');
      assert.deepEqual([second.status, second.queue.reason], ['queued', PAUSED_REASON]);
      assert.deepEqual([third.status, third.queue.position, third.queue.reason], ['queued', 2, PAUSED_REASON]);
      // The running worker continues.
      assert.equal((await status(first)).status, 'working');
      assert.deepEqual(
        (await host.list()).capacity.queue.map(entry => [entry.task, entry.reason]),
        [
          ['DEMO-2', PAUSED_REASON],
          ['DEMO-3', PAUSED_REASON],
        ],
      );

      // Stored service-side: a restarted host reads the same setting.
      const restarted = new AgentHost(context, { capabilities: both, capacity: { pool: roomyPool(), recheckMs: 0 } });
      assert.equal(await restarted.localPaused(), true);
      await restarted.close();

      // Resuming starts the queue in order: DEMO-2 takes the free slot, DEMO-3 waits for the limit.
      await host.updateSettings({ pauseLocalWorkers: false });
      await until(async () => (await status(second)).status === 'working');
      const waiting = await status(third);
      assert.equal(waiting.status, 'queued');
      assert.match(waiting.queue.reason, /2 workers are running, the limit/);
      await orchestration.finishWorker(orchestration.worker(first.workerId), 'completed');
      await until(async () => (await status(third)).status === 'working');
    } finally {
      await close();
    }
  }));
