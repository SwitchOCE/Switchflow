import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { AgentHost, normalizeExecEvent } from '../template/.switchflow/scripts/control/agent-host.mjs';
import { ControlEngine } from '../template/.switchflow/scripts/control/engine.mjs';
import { createInitiative } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import * as protocol from '../template/.switchflow/scripts/control/agent-protocol.mjs';
import {
  applySettingsPatch,
  defaultAgentSettings,
  normalizeCapabilities,
  probeCapabilities,
  resolveProvider,
} from '../template/.switchflow/scripts/control/agent-settings.mjs';

import { fakeProvider, fixture, intakeResult, until } from './agent-fakes.mjs';

const both = { codex: { available: true, version: 'codex 1' }, claude: { available: true, loggedIn: true } };

test('role routing defaults, review independence and visible fallback', () => {
  const settings = defaultAgentSettings();
  assert.deepEqual(resolveProvider({ role: 'execution', settings, capabilities: both }), {
    provider: 'claude',
    fallback: null,
  });
  assert.equal(resolveProvider({ role: 'delivery', settings, capabilities: both }).provider, 'codex');
  assert.equal(resolveProvider({ role: 'review', settings, capabilities: both, author: 'codex' }).provider, 'claude');
  assert.equal(resolveProvider({ role: 'review', settings, capabilities: both, author: 'claude' }).provider, 'codex');
  assert.throws(
    () => resolveProvider({ role: 'review', settings, capabilities: both, author: 'codex', requested: 'codex' }),
    /different provider/,
  );
  const signedOut = { codex: both.codex, claude: { available: true, loggedIn: false } };
  assert.deepEqual(resolveProvider({ role: 'intake', settings, capabilities: signedOut }), {
    provider: 'codex',
    fallback: { from: 'claude', to: 'codex', reason: 'claude is not signed in' },
  });
  assert.throws(
    () => resolveProvider({ role: 'review', settings, capabilities: signedOut, author: 'codex' }),
    /Independent review needs claude/,
  );
  assert.throws(
    () => resolveProvider({ role: 'intake', settings, capabilities: { codex: false } }),
    error => error.status === 503,
  );
  assert.deepEqual(normalizeCapabilities({ codex: false }), {
    codex: { available: false },
    claude: { available: false },
  });
});

test('settings patches are validated, partial and revisioned', () => {
  const current = defaultAgentSettings();
  const next = applySettingsPatch(current, {
    roles: { execution: 'codex', review: 'claude' },
    models: { claude: 'haiku' },
    limits: { maxWorkers: 3 },
    expectedRevision: 0,
  });
  assert.equal(next.revision, 1);
  assert.equal(next.roles.execution, 'codex');
  assert.equal(next.roles.intake, 'claude');
  assert.equal(next.models.claude, 'haiku');
  assert.equal(next.limits.maxWorkers, 3);
  assert.equal(next.limits.maxReviewRounds, 2);
  for (const input of [
    { roles: { execution: 'auto' } },
    { roles: { unknown: 'codex' } },
    { models: { codex: '--yolo' } },
    { limits: { maxWorkers: 99 } },
    { limits: { timeoutMinutes: 1.5 } },
    { extra: true },
  ])
    assert.throws(
      () => applySettingsPatch(current, input),
      error => error.status === 400,
      JSON.stringify(input),
    );
  assert.throws(
    () => applySettingsPatch(next, { expectedRevision: 0 }),
    error => error.status === 409,
  );
});

test('capability probe reports both providers including Claude sign-in', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (file === 'codex') return { stdout: 'codex-cli 0.153.4\n', stderr: '' };
    if (args[0] === '--version') return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
    throw Object.assign(new Error('exit 1'), { stdout: '{"loggedIn":false,"authMethod":"none"}' });
  };
  const capabilities = await probeCapabilities({ run, claudePath: 'claude.exe' });
  assert.deepEqual(capabilities.codex, {
    available: true,
    version: 'codex-cli 0.153.4',
    transport: 'app-server',
    diagnostic: '',
  });
  assert.equal(capabilities.claude.version, '2.1.288');
  assert.equal(capabilities.claude.loggedIn, false);
  assert.ok(calls.includes('claude.exe auth status'));
  const missing = await probeCapabilities({ run, claudePath: null });
  assert.equal(missing.claude.available, false);
});

test('exec events are normalized and the host falls back to exec when app-server fails its handshake', () =>
  fixture(async context => {
    assert.deepEqual(normalizeExecEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Hi' } }), {
      kind: 'message',
      text: 'Hi',
      final: false,
    });
    assert.equal(normalizeExecEvent({ type: 'thread.started', thread_id: 'x' }).threadId, 'x');
    const execCalls = [];
    const host = new AgentHost(context, {
      capabilities: { codex: { available: true }, claude: { available: false } },
      providers: {
        codex: async () => {
          throw Object.assign(new Error('initialize timed out'), { handshake: true });
        },
      },
      execRunner: async options => {
        execCalls.push(options);
        await options.onEvent({ type: 'runner.started', pid: 77 });
        await options.onEvent({ type: 'thread.started', thread_id: 'exec-thread' });
        await options.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Exec says hi' } });
        return { threadId: 'exec-thread', exitCode: 0, result: intakeResult() };
      },
    });
    await host.init();
    const events = [];
    const runId = randomUUID();
    const runDirectory = path.join(context.stateDir, 'runs', runId);
    const schemaPath = path.join(context.stateDir, 'schema.json');
    await fs.writeFile(schemaPath, '{"type":"object"}');
    const outcome = await host.run({
      projectRoot: context.sourceRoot,
      runDirectory,
      temporaryRoot: path.join(context.stateDir, 'tmp'),
      additionalWritableRoots: [context.governanceRoot],
      prompt: 'Current stage: intake',
      schemaPath,
      stage: 'intake',
      runId,
      initiativeId: randomUUID(),
      onEvent: async event => events.push(event),
    });
    assert.deepEqual(outcome, { threadId: 'exec-thread', result: intakeResult(), exitCode: 0 });
    assert.equal(execCalls[0].sandboxMode, 'workspace-write');
    assert.equal(execCalls[0].runDirectory, runDirectory);
    const notices = events.filter(event => event.kind === 'notice').map(event => event.text);
    assert.match(notices[0], /Using codex for intake: claude is not installed/);
    assert.match(notices[1], /using codex exec, which cannot be steered/);
    const [session] = (await host.list()).sessions;
    assert.equal(session.transport, 'exec');
    assert.equal(session.status, 'completed');
    assert.equal(session.threadId, 'exec-thread');
    assert.equal(session.fallback.from, 'claude');
  }));

test('agents API lists sessions, pages events, steers durably, interrupts, and fences settings', () =>
  fixture(async context => {
    const opened = [];
    const app = await createControlServer({
      context,
      capabilities: both,
      backlog: { list: async () => [] },
      providers: { codex: fakeProvider('codex', opened), claude: fakeProvider('claude', opened) },
    });
    const base = `${app.url}/api/projects/${context.id}`;
    try {
      const { csrfToken } = await (await fetch(`${app.url}/api/projects`)).json();
      const headers = { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken };
      const post = (url, body, extra = {}) =>
        fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      const put = (body, extra = {}) =>
        fetch(`${base}/agents/settings`, {
          method: 'PUT',
          headers: { ...headers, ...extra },
          body: JSON.stringify(body),
        });
      const empty = await (await fetch(`${base}/agents`)).json();
      assert.deepEqual(empty.sessions, []);
      assert.equal(empty.providers.claude.loggedIn, true);
      assert.equal(empty.routing.intake.provider, 'claude');
      assert.equal(empty.routing.review.provider, 'claude');
      assert.equal(empty.settings.revision, 0);

      const created = await post(`${base}/initiatives`, { title: 'Steer me', request: 'Do it' });
      const { initiative } = await created.json();
      const session = await until(async () =>
        (await (await fetch(`${base}/agents`)).json()).sessions.find(s => s.status === 'working' && s.canInterrupt),
      );
      assert.equal(session.role, 'intake');
      assert.equal(session.provider, 'claude');
      assert.equal(session.parentId, null);
      assert.equal(session.initiativeId, initiative.id);
      assert.equal(session.canSteer, true);
      assert.equal(session.canInterrupt, true);
      assert.equal(session.live, true);
      const page = await (await fetch(`${base}/agents/${session.id}/events?after=0&limit=2`)).json();
      assert.deepEqual(
        page.events.map(e => [e.seq, e.kind]),
        [
          [1, 'session.started'],
          [2, 'turn.started'],
        ],
      );
      assert.equal(page.more, true);
      const rest = await (await fetch(`${base}/agents/${session.id}/events?after=${page.nextAfter}`)).json();
      assert.equal(rest.events[0].seq, 3);
      assert.equal((await fetch(`${base}/agents/${session.id}/events?after=-1`)).status, 400);
      assert.equal((await fetch(`${base}/agents/${randomUUID()}/events`)).status, 404);

      // Settings cannot change while the run holds admission.
      assert.equal((await put({ roles: { intake: 'codex' } })).status, 409);
      assert.equal((await put({ roles: { intake: 'codex' } }, { 'X-Switchflow-Token': 'bad' })).status, 403);
      // Steering needs the page token and same origin.
      assert.equal(
        (await post(`${base}/agents/${session.id}/steer`, { message: 'x' }, { 'X-Switchflow-Token': '' })).status,
        403,
      );
      assert.equal(
        (await post(`${base}/agents/${session.id}/steer`, { message: 'x' }, { Origin: 'https://evil.example' })).status,
        403,
      );
      assert.equal((await post(`${base}/agents/${session.id}/steer`, { message: '' })).status, 400);
      assert.equal((await post(`${base}/agents/${session.id}/steer`, { message: 'x', extra: 1 })).status, 400);
      const steered = await post(`${base}/agents/${session.id}/steer`, { message: 'Prefer SQLite' });
      assert.equal(steered.status, 202);
      assert.deepEqual(await steered.json(), {
        ok: true,
        sessionId: session.id,
        mode: 'steer',
        turnId: (await (await fetch(`${base}/agents/${session.id}/events`)).json()).events.find(
          e => e.kind === 'turn.started',
        ).turnId,
      });
      assert.deepEqual(opened[0].steers, ['Prefer SQLite']);
      let state = await (await fetch(`${base}/state`)).json();
      const steer = state.initiatives[0].messages.at(-1);
      assert.equal(steer.type, 'steer');
      assert.equal(steer.mode, 'steer');
      assert.equal(steer.message, 'Prefer SQLite');
      assert.equal(steer.sessionId, session.id);
      // Queue on a stage agent: kept as owner input for the next checkpoint, not sent mid-turn.
      assert.equal((await post(`${base}/agents/${session.id}/steer`, { message: 'x', mode: 'later' })).status, 400);
      const queued = await post(`${base}/agents/${session.id}/steer`, { message: 'Also add CSV', mode: 'queue' });
      assert.equal(queued.status, 202);
      assert.equal((await queued.json()).mode, 'queue');
      assert.deepEqual(opened[0].steers, ['Prefer SQLite']);
      state = await (await fetch(`${base}/state`)).json();
      assert.deepEqual(
        [state.initiatives[0].messages.at(-1).type, state.initiatives[0].messages.at(-1).mode],
        ['update', 'queue'],
      );
      const modes = (await (await fetch(`${base}/agents/${session.id}/events`)).json()).events
        .filter(e => e.kind === 'steer')
        .map(e => e.mode);
      assert.deepEqual(modes, ['steer', 'queue']);

      // Interrupting the stage agent ends the run; the owner can retry.
      const interrupted = await post(`${base}/agents/${session.id}/interrupt`, {});
      assert.equal(interrupted.status, 202);
      assert.deepEqual(await interrupted.json(), { sessionId: session.id, interrupted: true });
      state = await until(async () => {
        const next = await (await fetch(`${base}/state`)).json();
        return !next.activeRun && next.initiatives[0].status === 'failed' && next;
      });
      assert.match(state.initiatives[0].events.at(-1).message, /interrupted this agent/);
      const finished = (await (await fetch(`${base}/agents`)).json()).sessions[0];
      assert.equal(finished.status, 'failed');
      assert.equal(finished.live, false);
      assert.equal(finished.canSteer, false);
      assert.equal((await post(`${base}/agents/${session.id}/steer`, { message: 'late' })).status, 409);
      assert.equal((await post(`${base}/agents/${session.id}/interrupt`, {})).status, 409);
      const history = await (await fetch(`${base}/agents/${session.id}/events?after=0&limit=500`)).json();
      assert.equal(history.live, false);
      assert.ok(history.events.some(e => e.kind === 'steer' && e.by === 'owner' && e.text === 'Prefer SQLite'));
      assert.ok(history.events.some(e => e.kind === 'interrupt'));

      // Idle again: settings save, with optimistic revision checks.
      const saved = await put({ roles: { intake: 'codex' }, models: { codex: 'gpt-test' }, expectedRevision: 0 });
      assert.equal(saved.status, 200);
      const body = await saved.json();
      assert.equal(body.settings.revision, 1);
      assert.equal(body.routing.intake.provider, 'codex');
      assert.equal((await put({ expectedRevision: 0 })).status, 409);
      assert.equal((await put({ roles: { intake: 'gpt' } })).status, 400);

      // The retry uses the new routing and model; the steer is retained as history, not new input.
      const item = state.initiatives[0];
      await post(`${base}/initiatives/${item.id}/actions`, { action: 'retry', expectedRevision: item.revision });
      await until(() => opened[1]?.handle?.activeTurnId);
      assert.equal(opened[1].name, 'codex');
      assert.equal(opened[1].options.model, 'gpt-test');
      assert.match(opened[1].prompt, /Prefer SQLite/);
      await opened[1].handle.steer('FINISH-NOW', { by: 'owner' });
      state = await until(async () => {
        const next = await (await fetch(`${base}/state`)).json();
        return next.initiatives[0].status === 'awaiting-human' && next;
      });
      const steers = state.initiatives[0].messages.filter(m => m.type === 'steer');
      assert.equal(steers.length, 1);
    } finally {
      await app.close();
    }
  }));

test('a restarted service closes sessions it can no longer reach', () =>
  fixture(async context => {
    const host = new AgentHost(context, { capabilities: both });
    await host.init();
    const meta = await host.registry.create({ runId: randomUUID(), role: 'intake', provider: 'claude' });
    await host.registry.record(meta.id, { kind: 'turn.started', turnId: 't' });
    const restarted = new AgentHost(context, { capabilities: both });
    await restarted.init();
    const [session] = (await restarted.list()).sessions;
    assert.equal(session.status, 'failed');
    assert.equal(session.live, false);
    assert.match(session.error, /service stopped/);
    const events = await restarted.events(meta.id, 0, 10);
    assert.deepEqual(
      events.events.map(e => e.kind),
      ['turn.started'],
    );
  }));

test('worker processes are recorded durably before they start and fence a restart that loses them', () =>
  fixture(async context => {
    const runId = randomUUID();
    const item = createInitiative({ title: 'Orchestrated', request: 'Request', start: false });
    item.status = 'running';
    item.runs = [{ id: runId, status: 'running' }];
    await updateState(context, 'control', () => ({
      schemaVersion: 1,
      revision: 1,
      initiatives: [item],
      activeRun: { id: runId, initiativeId: item.id, stage: 'execution', status: 'running' },
    }));
    const seen = [];
    const engine = new ControlEngine(context, { protocol, runner: async () => assert.fail('no run') });
    const workersNow = async () => (await engine.read()).activeRun.workers ?? [];
    const host = new AgentHost(context, {
      capabilities: both,
      providers: {
        codex: async options => {
          // The fence entry exists before the provider spawns anything.
          seen.push((await workersNow()).map(worker => worker.pid));
          return fakeProvider('codex')(options);
        },
        claude: async () => {
          throw new Error('Claude failed to start');
        },
      },
    });
    await host.init();
    host.bind(engine);
    const open = (provider, kind) =>
      host.openSession({
        provider,
        role: kind === 'deliver' ? 'delivery' : 'review',
        kind,
        runId,
        initiativeId: item.id,
        task: 'DEMO-1',
        cwd: context.sourceRoot,
        sandbox: kind === 'deliver' ? 'workspace-write' : 'read-only',
        runDirectory: path.join(context.stateDir, 'runs', runId),
      });
    const first = await open('codex', 'deliver');
    assert.deepEqual(seen, [[null]]);
    let [entry] = await workersNow();
    assert.equal(entry.sessionId, first.meta.id);
    assert.equal(entry.pid, 4242);
    assert.equal(entry.provider, 'codex');
    assert.equal(entry.task, 'DEMO-1');
    assert.ok(Date.parse(entry.recordedAt) <= Date.now());
    // A provider that fails to open leaves no fence entry behind.
    await assert.rejects(open('claude', 'review'), /failed to start/);
    assert.equal((await workersNow()).length, 1);
    await host.closeSession(first.meta, first.handle, { status: 'completed' });
    assert.deepEqual(await workersNow(), []);

    // A crash with a worker open: the restarted service holds the run and lists the worker as failed.
    const second = await open('codex', 'deliver');
    [entry] = await workersNow();
    const restarted = new ControlEngine(context, {
      protocol,
      runner: async () => assert.fail('no run'),
      processAlive: pid => pid === 4242,
      processStarted: async () => Date.parse(entry.recordedAt) - 100,
    });
    const restartedHost = new AgentHost(context, { capabilities: both });
    await restartedHost.init();
    await restarted.recover();
    const state = await restarted.read();
    assert.equal(state.activeRun.status, 'interrupted');
    assert.deepEqual(
      state.activeRun.held.map(held => [held.kind, held.sessionId, held.pid, held.state]),
      [
        ['stage', null, null, 'unknown'],
        ['deliver', second.meta.id, 4242, 'running'],
      ],
    );
    const session = (await restartedHost.list()).sessions.find(listed => listed.id === second.meta.id);
    assert.equal(session.status, 'failed');
    assert.match(session.error, /process 4242/);
    await restarted.close();
  }));
