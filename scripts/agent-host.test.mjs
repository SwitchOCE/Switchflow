import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveProject } from '../template/.switchflow/scripts/operations/storage.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { AgentHost, normalizeExecEvent } from '../template/.switchflow/scripts/control/agent-host.mjs';
import {
  applySettingsPatch,
  defaultAgentSettings,
  normalizeCapabilities,
  probeCapabilities,
  resolveProvider,
} from '../template/.switchflow/scripts/control/agent-settings.mjs';

const both = { codex: { available: true, version: 'codex 1' }, claude: { available: true, loggedIn: true } };

export function intakeResult(stage = 'intake') {
  return {
    stage,
    status: 'ready',
    summary: `${stage} checkpoint`,
    nextAction: 'Review the checkpoint.',
    questions: [],
    scope: 'Fixture scope',
    plan: [],
    evidence: [],
    blockers: [],
    uat: [],
  };
}

/**
 * In-process provider with the session interface. A turn waits until it is steered with FINISH-NOW
 * (or ends at once when the prompt contains it), so tests control timing.
 */
export function fakeProvider(name, log = []) {
  return async options => {
    const opened = { name, options, steers: [] };
    log.push(opened);
    let active = null;
    let closed = false;
    const emit = event => options.onEvent(event);
    await emit({ kind: 'session.started', provider: name, transport: 'fake', threadId: `${name}-thread`, pid: 4242 });
    const handle = {
      provider: name,
      threadId: `${name}-thread`,
      get activeTurnId() {
        return active?.id ?? null;
      },
      get closed() {
        return closed;
      },
      async startTurn(text, { outputSchema } = {}) {
        if (active) throw new Error('busy');
        const id = randomUUID();
        opened.prompt ??= text;
        opened.outputSchema = outputSchema;
        await emit({ kind: 'turn.started', turnId: id });
        await emit({ kind: 'message', text: `${name} is working`, final: false });
        return new Promise((resolve, reject) => {
          active = { id, resolve, reject };
          const cancel = () => {
            active = null;
            reject(new Error('Agent session cancelled'));
          };
          if (options.signal?.aborted) return cancel();
          options.signal?.addEventListener('abort', cancel);
          if (/FINISH-NOW/.test(text)) handle.finish(text);
          options.onTurn?.(handle, text);
        });
      },
      finish(text) {
        const turn = active;
        active = null;
        const result = opened.respond ? opened.respond(text, options) : intakeResult();
        void emit({ kind: 'message', text: 'done', final: true })
          .then(() => emit({ kind: 'turn.completed', turnId: turn.id, status: 'completed', usage: { totalTokens: 3 } }))
          .then(() => turn.resolve({ turnId: turn.id, result, text: JSON.stringify(result) }));
      },
      async steer(text, { by }) {
        if (!active) throw new Error('No active turn to steer');
        opened.steers.push(text);
        await emit({ kind: 'steer', text, by, turnId: active.id });
        if (/FINISH-NOW/.test(text)) handle.finish(text);
        return { turnId: active?.id };
      },
      async interrupt({ by }) {
        if (!active) return false;
        const turn = active;
        active = null;
        await emit({ kind: 'interrupt', by, turnId: turn.id });
        await emit({ kind: 'turn.completed', turnId: turn.id, status: 'interrupted' });
        turn.reject(Object.assign(new Error('interrupted'), { interrupted: true }));
        return true;
      },
      async close() {
        closed = true;
        await emit({ kind: 'session.closed' });
      },
    };
    opened.handle = handle;
    return handle;
  };
}

export async function fixture(fn) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-agents-test-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true });
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Base',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
  try {
    await fn(context);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for test condition');
}

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
        sessionId: session.id,
        delivered: 'steer',
        turnId: (await (await fetch(`${base}/agents/${session.id}/events`)).json()).events.find(
          e => e.kind === 'turn.started',
        ).turnId,
      });
      assert.deepEqual(opened[0].steers, ['Prefer SQLite']);
      let state = await (await fetch(`${base}/state`)).json();
      const steer = state.initiatives[0].messages.at(-1);
      assert.equal(steer.type, 'steer');
      assert.equal(steer.message, 'Prefer SQLite');
      assert.equal(steer.sessionId, session.id);

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
    assert.equal(session.status, 'cancelled');
    assert.equal(session.live, false);
    assert.match(session.error, /service stopped/);
    const events = await restarted.events(meta.id, 0, 10);
    assert.deepEqual(
      events.events.map(e => e.kind),
      ['turn.started'],
    );
  }));
