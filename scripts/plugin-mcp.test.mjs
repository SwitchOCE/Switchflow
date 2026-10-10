import './git-test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import {
  OWNER_ONLY_ACTIONS,
  TOOLS,
  TOOL_NAMES,
  handleMessage,
  serviceClient,
  switchflowHome,
  toolHandlers,
} from '../plugin/mcp/server.mjs';
import { fakeProvider, fixture, roomyPool, until } from './agent-fakes.mjs';

const serverPath = fileURLToPath(new URL('../plugin/mcp/server.mjs', import.meta.url));
const both = { codex: { available: true }, claude: { available: true, loggedIn: true } };

/** Runs the stdio server with the given environment and returns one reply per request. */
async function converse(env, messages) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => (output += chunk));
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .sort((a, b) => a.id - b.id);
}

async function emptyHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-mcp-home-'));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('stdio handshake lists the owner tools and supports the orchestration protocol versions', () =>
  emptyHome(async home => {
    const replies = await converse({ SWITCHFLOW_HOME: home }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { jsonrpc: '2.0', id: 5, method: 'resources/list' },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'approve_plan', arguments: {} } },
    ]);
    assert.equal(replies.length, 6, 'notifications get no reply');
    assert.equal(replies[0].result.protocolVersion, '2025-03-26');
    assert.equal(replies[0].result.serverInfo.name, 'switchflow');
    assert.match(replies[0].result.instructions, /owner's buttons/);
    assert.deepEqual(
      replies[1].result.tools.map(tool => tool.name),
      [
        'status',
        'list_initiatives',
        'start_initiative',
        'answer',
        'worker_feed',
        'steer_worker',
        'interrupt_worker',
        'list_environments',
        'add_environment',
        'test_environment',
        'pause_local_workers',
        'open_board',
      ],
    );
    for (const tool of replies[1].result.tools) assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(replies[2].result, {});
    assert.equal(replies[3].result.protocolVersion, '2025-06-18');
    assert.equal(replies[4].error.code, -32601);
    assert.equal(replies[5].error.code, -32602);
  }));

test('approvals, recovery and approach confirmation are never exposed as tools', async () => {
  const forbidden = [
    ...OWNER_ONLY_ACTIONS,
    'approve-scope',
    'approve-plan',
    'request-changes',
    'accept-uat',
    'request-rework',
    'recover-run',
    'resume-workers',
    'stop-processes',
  ];
  const normalized = name => name.replaceAll('_', '-');
  for (const name of TOOL_NAMES) assert.ok(!forbidden.includes(normalized(name)), `${name} must not be a tool`);
  assert.deepEqual([...new Set(forbidden)].sort(), [...OWNER_ONLY_ACTIONS].sort());
  // No tool takes an action name or a confirmation, so none can be steered into one.
  const properties = TOOLS.flatMap(tool => Object.keys(tool.inputSchema.properties || {}));
  assert.ok(!properties.includes('action'));
  assert.ok(!properties.includes('confirm'));
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);

  // Whatever arguments arrive, steer_worker sends only message and mode.
  const sent = [];
  const client = {
    scoped: async (method, route, body) => {
      sent.push({ method, route, body });
      return { ok: true };
    },
  };
  const handlers = toolHandlers(client);
  await handlers.steer_worker({ workerId: 'w', message: 'Looks good', confirm: true, mode: 'queue' });
  assert.deepEqual(sent, [
    { method: 'POST', route: '/agents/w/steer', body: { message: 'Looks good', mode: 'queue' } },
  ]);
  // A handler cannot be reached for an unlisted name either.
  const reply = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'accept_uat', arguments: {} } },
    { handlers: { ...handlers, accept_uat: () => ({}) } },
  );
  assert.equal(reply.error.code, -32602);
});

test('every tool says the service is not running when it is down or its receipt is stale', () =>
  emptyHome(async home => {
    const calls = TOOL_NAMES.map((name, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }));
    const missing = await converse({ SWITCHFLOW_HOME: home }, calls);
    assert.equal(missing.length, TOOL_NAMES.length);
    for (const reply of missing) {
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /not running/);
    }
    // A receipt left by a stopped service points at a port nothing answers on.
    await fs.mkdir(path.join(home, 'control-service'));
    await fs.writeFile(
      path.join(home, 'control-service', 'service-info.json'),
      JSON.stringify({ pid: 999999, url: 'http://127.0.0.1:9', apiVersion: 2 }),
    );
    const stale = await converse({ SWITCHFLOW_HOME: home }, calls.slice(0, 1));
    assert.equal(stale[0].result.isError, true);
    assert.match(stale[0].result.content[0].text, /not running/);
  }));

test('the state folder follows SWITCHFLOW_HOME, then LOCALAPPDATA, then ~/.local/state', () => {
  assert.equal(switchflowHome({ SWITCHFLOW_HOME: path.resolve('custom') }), path.resolve('custom'));
  assert.equal(
    switchflowHome({ LOCALAPPDATA: path.resolve('appdata') }),
    path.join(path.resolve('appdata'), 'Switchflow'),
  );
  assert.equal(switchflowHome({}), path.join(os.homedir(), '.local', 'state', 'switchflow'));
});

test('each tool maps to the control service API for the Claude project folder', () =>
  fixture(async context => {
    const root = context.sourceRoot;
    await fs.mkdir(path.join(root, '.switchflow'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.switchflow', 'project.json'),
      JSON.stringify({ projectName: 'Fixture', schemaVersion: 1, templateVersion: '0.5.0' }),
    );
    await fs.writeFile(path.join(root, 'backlog.config.yml'), 'project_name: Fixture\n');
    const opened = [];
    const app = await createControlServer({
      context,
      capabilities: both,
      capacity: { pool: roomyPool() },
      backlog: { list: async () => [] },
      providers: { codex: fakeProvider('codex', opened), claude: fakeProvider('claude', opened) },
    });
    const home = path.dirname(path.dirname(context.stateDir));
    await fs.mkdir(path.join(home, 'control-service'), { recursive: true });
    await fs.writeFile(
      path.join(home, 'control-service', 'service-info.json'),
      JSON.stringify({ pid: process.pid, url: app.url, apiVersion: 2 }),
    );
    const client = serviceClient({ env: { SWITCHFLOW_HOME: home, CLAUDE_PROJECT_DIR: root }, cwd: os.tmpdir() });
    const tools = toolHandlers(client);
    const call = async (name, args = {}) => {
      const reply = await handleMessage(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        { handlers: tools },
      );
      if (reply.result.isError) throw new Error(reply.result.content[0].text);
      assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
      return reply.result.structuredContent;
    };
    try {
      assert.equal(await client.project(), context.id);

      const status = await call('status');
      assert.equal(status.projectId, context.id);
      assert.deepEqual(await call('status', { since: status.version }), { unchanged: true, version: status.version });
      assert.equal((await call('open_board', { view: 'agents' })).url, `${app.url}/?project=${context.id}&view=agents`);

      // Environments: settings change only while no run is active.
      const identityFile = path.join(home, 'id_test');
      await fs.writeFile(identityFile, 'not a real key');
      const box = {
        id: 'box',
        kind: 'ssh',
        label: 'Test box',
        host: 'box.example',
        user: 'me',
        identityFile,
        workRoot: '/home/me/sf',
      };
      assert.deepEqual((await call('add_environment', { environment: box })).environments, [
        { id: 'box', kind: 'ssh', label: 'Test box' },
      ]);
      await assert.rejects(call('add_environment', { environment: box }), /already exists/);
      const environments = await call('list_environments');
      assert.deepEqual(
        environments.environments.map(entry => entry.id),
        ['local', ...environments.environments.slice(1, -1).map(entry => entry.id), 'box'],
      );
      assert.equal(typeof environments.placement, 'object');
      const tested = await call('test_environment', { id: 'local' });
      assert.equal(tested.id, 'local');
      assert.ok(tested.checkedAt);
      await assert.rejects(call('test_environment', { id: 'nowhere' }), /Unknown environment/);
      assert.deepEqual(await call('pause_local_workers'), { pauseLocalWorkers: true });
      assert.equal((await call('status')).capacity.pauseLocalWorkers, true);
      assert.deepEqual(await call('pause_local_workers', { paused: false }), { pauseLocalWorkers: false });

      // An initiative: its intake worker, steering, the feed, then the owner's answer.
      const started = await call('start_initiative', { title: 'Through MCP', request: 'Add an example' });
      assert.equal(started.initiative.title, 'Through MCP');
      assert.equal(started.initiative.stage, 'intake');
      const working = await until(async () => {
        const { workers } = await call('status');
        return workers.find(worker => worker.status === 'working' && worker.lastEvent === 'claude is working');
      });
      assert.equal(working.role, 'intake');
      assert.equal(working.environment, 'local');
      assert.equal(working.held, false);
      const steered = await call('steer_worker', { workerId: working.id, message: 'Prefer SQLite' });
      assert.equal(steered.mode, 'steer');
      assert.equal(steered.confirmed, undefined);
      const feed = await call('worker_feed', { workerId: working.id, limit: 500 });
      assert.equal(feed.workerId, working.id);
      assert.deepEqual(feed.events.at(-1), {
        seq: feed.events.at(-1).seq,
        at: feed.events.at(-1).at,
        kind: 'steer',
        by: 'owner',
        line: 'Prefer SQLite',
      });
      const later = await call('worker_feed', { workerId: working.id, after: feed.nextAfter });
      assert.deepEqual(later.events, []);

      // The worker reports working just before its provider turn has an ID to interrupt.
      const interrupted = await until(() => call('interrupt_worker', { workerId: working.id }).catch(() => null));
      assert.deepEqual(interrupted, { sessionId: working.id, interrupted: true });
      await until(async () => !(await call('status')).activeRun);

      // Intake questions wait for the owner's answers, which Claude passes on.
      await updateState(context, 'control', state => {
        Object.assign(state.initiatives[0], {
          status: 'awaiting-human',
          pending: false,
          questions: [{ id: 'q1', prompt: 'Keep the data?' }],
        });
        state.revision++;
        return state;
      });
      const asked = (await call('list_initiatives')).initiatives[0];
      assert.deepEqual(asked.questions, [{ id: 'q1', prompt: 'Keep the data?' }]);
      assert.equal(asked.needsOwner.kind, 'questions');
      assert.deepEqual(
        asked.needsOwner.actions.map(entry => entry.action),
        ['answer'],
      );
      await assert.rejects(call('answer', { initiativeId: asked.id, answers: {} }), /Keep the data/);
      const answered = await call('answer', { initiativeId: asked.id, answers: { q1: 'Yes' } });
      assert.equal(answered.initiative.id, asked.id);
      assert.equal(answered.initiative.pending, true);
      await assert.rejects(call('worker_feed', { workerId: '00000000-0000-0000-0000-000000000000' }), /not found/);
    } finally {
      await app.close();
    }
  }));
