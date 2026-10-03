import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  codexAppServerArguments,
  openCodexSession,
  sandboxPolicy,
  threadStartParams,
} from '../template/.switchflow/scripts/control/providers/codex-app-server.mjs';
import {
  claudeArguments,
  claudeExecutable,
  openClaudeSession,
} from '../template/.switchflow/scripts/control/providers/claude-cli.mjs';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

// A JSON-RPC peer that behaves like `codex app-server` for the methods Switchflow uses.
const fakeCodex = String.raw`
const fs = require('fs');
const log = process.env.FAKE_LOG;
const mode = process.env.FAKE_MODE || 'normal';
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
record({ argv: process.argv.slice(2) });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const thread = '01a1000a-0000-7000-8000-000000000001';
let turn = null;
let n = 0;
const notify = (method, params) => send({ method, params: { threadId: thread, ...params }, emittedAtMs: Date.now() });
function complete(status, text) {
  if (!turn) return;
  const id = turn.id;
  if (text !== undefined) {
    notify('item/completed', { turnId: id, item: { type: 'agentMessage', id: 'm' + n++, text, phase: 'final_answer' } });
    notify('thread/tokenUsage/updated', { turnId: id, tokenUsage: { total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 0 } } });
  }
  turn = null;
  notify('turn/completed', { turn: { id, status, error: status === 'failed' ? { message: 'model refused' } : null } });
}
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    record(msg);
    if (msg.method === 'initialize') {
      if (mode === 'no-handshake') { process.exit(3); }
      send({ id: msg.id, result: { userAgent: 'fake', platformOs: 'windows' } });
    } else if (msg.method === 'config/read') {
      send({ id: msg.id, result: { config: { mcp_servers: { supabase: { url: 'https://example' }, dead: { command: 'x' } } } } });
    } else if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: thread }, model: 'fake-model', approvalPolicy: msg.params.approvalPolicy, sandbox: { type: msg.params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' } } });
    } else if (msg.method === 'turn/start') {
      turn = { id: 'turn-' + n++ };
      send({ id: msg.id, result: { turn: { id: turn.id, status: 'inProgress' } } });
      notify('turn/started', { turn: { id: turn.id } });
      notify('item/completed', { turnId: turn.id, item: { type: 'commandExecution', command: 'git status', status: 'completed', exitCode: 0 } });
      notify('item/completed', { turnId: turn.id, item: { type: 'agentMessage', id: 'c' + n++, text: 'Working on it', phase: 'commentary' } });
      if (mode === 'approval') send({ id: 900, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /' } });
      const text = msg.params.input[0].text;
      if (text.includes('finish now')) complete('completed', JSON.stringify({ answer: 'done' }));
      if (text.includes('fail now')) complete('failed');
    } else if (msg.method === 'turn/steer') {
      if (!turn || turn.id !== msg.params.expectedTurnId) send({ id: msg.id, error: { code: -32600, message: 'expected turn mismatch' } });
      else {
        send({ id: msg.id, result: { turnId: turn.id } });
        notify('item/completed', { turnId: turn.id, item: { type: 'userMessage', id: 'u' + n++, content: msg.params.input } });
        complete('completed', JSON.stringify({ answer: 'steered: ' + msg.params.input[0].text }));
      }
    } else if (msg.method === 'turn/interrupt') {
      if (!turn) send({ id: msg.id, error: { code: -32600, message: 'no active turn to interrupt' } });
      else { send({ id: msg.id, result: {} }); complete('interrupted'); }
    } else if (msg.id !== undefined && !msg.method) {
      // client reply to a server request
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// A stream-json peer that behaves like `claude -p --input-format stream-json`.
const fakeClaude = String.raw`
const fs = require('fs');
const log = process.env.FAKE_LOG;
const mode = process.env.FAKE_MODE || 'normal';
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
const args = process.argv.slice(2);
record({ argv: args });
const session = args[args.indexOf('--session-id') + 1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let started = false;
let queue = [];
let busy = false;
let interrupted = false;
const result = (text, extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 }, ...extra });
function run(message) {
  busy = true;
  const text = message.message.content[0].text;
  send({ type: 'user', message: message.message, isReplay: true, session_id: session });
  if (mode === 'auth') { busy = false; return result('Not logged in · Please run /login', { is_error: true, terminal_reason: 'api_error' }); }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }] }, session_id: session });
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:/x/a.txt' } }] }, session_id: session });
  const finish = () => {
    busy = false;
    if (interrupted) { interrupted = false; result('', { subtype: 'error_during_execution', is_error: true }); }
    else {
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answer: ' + text }] }, session_id: session });
      result('Answer: ' + text, { structured_output: { answer: text } });
    }
    if (queue.length) run(queue.shift());
  };
  if (text.includes('slow')) setTimeout(finish, 2000); else finish();
}
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    record(msg);
    if (!started) { started = true; send({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', tools: ['Read'] }); }
    if (msg.type === 'user') { if (busy) queue.push(msg); else run(msg); }
    if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      interrupted = true;
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// Waits for a condition instead of a fixed sleep: process start-up time varies with machine load.
async function until(condition, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t, script, mode = 'normal') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'switchflow-provider-'));
  // A failed assertion must not leave a fake provider running, or the test file never exits.
  const children = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const scriptPath = path.join(root, 'fake.cjs');
  const log = path.join(root, 'log.jsonl');
  await writeFile(scriptPath, script);
  const events = [];
  return {
    root,
    events,
    lines: async () =>
      (await readFile(log, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
    options: {
      cwd: root,
      writableRoots: [path.join(root, 'governance')],
      temporaryRoot: path.join(root, 'tmp'),
      onEvent: async event => {
        events.push(event);
      },
      rawLogPath: path.join(root, 'raw', 'session.jsonl'),
      spawnProcess: (_exe, args, options) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
          ...options,
          env: { ...options.env, FAKE_LOG: log, FAKE_MODE: mode },
        });
        children.push(child);
        return child;
      },
    },
  };
}

test('Codex app-server arguments and thread settings keep the exec guardrails', () => {
  const temporaryRoot = path.resolve(os.tmpdir(), 'bounded');
  const args = codexAppServerArguments({ sandbox: 'workspace-write', writableRoots: [], temporaryRoot });
  assert.equal(args[0], 'app-server');
  for (const flag of [
    'notify=[]',
    'approval_policy="never"',
    'sandbox_mode="workspace-write"',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([temporaryRoot])}`,
    `shell_environment_policy.set.TEMP=${JSON.stringify(temporaryRoot)}`,
  ])
    assert.ok(args.includes(flag), flag);
  assert.ok(!args.some(arg => /danger|bypass/.test(arg)));
  assert.throws(() => codexAppServerArguments({ sandbox: 'danger-full-access' }), /Unsafe sandbox/);
  assert.throws(() => codexAppServerArguments({ sandbox: 'workspace-write', writableRoots: ['relative'] }), /absolute/);
  const params = threadStartParams({
    cwd: temporaryRoot,
    sandbox: 'read-only',
    writableRoots: [temporaryRoot],
    disabledMcpServers: ['supabase'],
    mcpServers: { switchflow: { command: 'node', args: ['mcp.mjs'] } },
  });
  assert.equal(params.approvalPolicy, 'never');
  assert.equal(params.approvalsReviewer, 'user');
  assert.deepEqual(params.config.notify, []);
  assert.deepEqual(params.config.sandbox_workspace_write.writable_roots, []);
  assert.deepEqual(params.config.mcp_servers.supabase, { enabled: false });
  assert.deepEqual(params.config.features, { apps: false, plugins: false, computer_use: false });
  assert.equal(params.config.apps._default.enabled, false);
  for (const feature of ['apps', 'plugins', 'computer_use']) assert.ok(args.includes(`features.${feature}=false`));
  assert.equal(params.config.mcp_servers.switchflow.command, 'node');
  // approvalPolicy "never" would otherwise refuse host tools that lack readOnlyHint (live run, 2026-10-03).
  assert.equal(params.config.mcp_servers.switchflow.default_tools_approval_mode, 'approve');
  assert.deepEqual(sandboxPolicy({ sandbox: 'read-only', writableRoots: [temporaryRoot] }), {
    type: 'readOnly',
    networkAccess: false,
  });
});

test('Codex session streams normalized events, steers the active turn and parses structured output', async t => {
  const { options, events, lines } = await fixture(t, fakeCodex);
  const session = await openCodexSession({ ...options, model: 'gpt-test', effort: 'low' });
  assert.equal(session.threadId, '01a1000a-0000-7000-8000-000000000001');
  const turn = session.startTurn('Take your time', { outputSchema: schema });
  await until(() => session.activeTurnId, 'the Codex turn to start');
  assert.ok(session.activeTurnId);
  await assert.rejects(session.steer('wrong', { expectedTurnId: 'stale' }), /No active turn/);
  await session.steer('stop and report', { by: 'orchestrator' });
  const outcome = await turn;
  assert.deepEqual(outcome.result, { answer: 'steered: stop and report' });
  assert.equal(outcome.usage.totalTokens, 12);
  const followUp = await session.startTurn('finish now', { outputSchema: schema });
  assert.deepEqual(followUp.result, { answer: 'done' });
  await session.close();
  const kinds = events.map(event => event.kind);
  for (const kind of [
    'session.started',
    'turn.started',
    'command',
    'message',
    'steer',
    'turn.completed',
    'session.closed',
  ])
    assert.ok(kinds.includes(kind), kind);
  assert.deepEqual(
    events.filter(event => event.kind === 'message').map(event => event.final),
    [false, true, false, true],
  );
  assert.equal(events.find(event => event.kind === 'steer').by, 'orchestrator');
  const sent = await lines();
  const argv = sent[0].argv;
  assert.ok(argv.includes('notify=[]') && argv.includes('approval_policy="never"'));
  const thread = sent.find(message => message.method === 'thread/start').params;
  assert.equal(thread.approvalsReviewer, 'user');
  assert.equal(thread.model, 'gpt-test');
  assert.equal(thread.config.model_reasoning_effort, 'low');
  assert.deepEqual(thread.config.mcp_servers, { supabase: { enabled: false }, dead: { enabled: false } });
  const start = sent.find(message => message.method === 'turn/start').params;
  assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.sandboxPolicy.writableRoots, [...options.writableRoots, options.temporaryRoot]);
  assert.equal(start.sandboxPolicy.networkAccess, false);
  assert.deepEqual(start.outputSchema, schema);
  const initialize = sent.find(message => message.method === 'initialize').params;
  assert.ok(initialize.capabilities.optOutNotificationMethods.includes('item/agentMessage/delta'));
});

test('Codex interrupt, failure, declined approvals and handshake failure', async t => {
  const { options, events } = await fixture(t, fakeCodex, 'approval');
  const session = await openCodexSession(options);
  const turn = session.startTurn('wait');
  await until(() => session.activeTurnId, 'the Codex turn to start');
  assert.equal(await session.interrupt(), true);
  await assert.rejects(turn, error => error.interrupted === true);
  assert.equal(await session.interrupt(), false);
  await assert.rejects(session.startTurn('fail now'), /turn.failed: model refused/);
  await session.close();
  assert.ok(events.some(event => event.kind === 'notice' && /Declined item\/commandExecution/.test(event.text)));
  assert.ok(events.some(event => event.kind === 'interrupt'));
  const broken = await fixture(t, fakeCodex, 'no-handshake');
  await assert.rejects(openCodexSession(broken.options), error => error.handshake === true);
});

test('Codex session stops on cancellation and when the host cannot record events', async t => {
  const { options } = await fixture(t, fakeCodex);
  const controller = new AbortController();
  const session = await openCodexSession({ ...options, signal: controller.signal });
  const turn = session.startTurn('wait');
  await until(() => session.activeTurnId, 'the Codex turn to start');
  controller.abort();
  await assert.rejects(turn, /cancelled/);
  await session.close();
  const second = await fixture(t, fakeCodex);
  let calls = 0;
  const failing = await openCodexSession({
    ...second.options,
    onEvent: async event => {
      if (event.kind === 'turn.started' && ++calls) throw new Error('state persistence unavailable');
    },
  });
  await assert.rejects(failing.startTurn('wait'), /state persistence unavailable/);
  await failing.close();
});

test('Claude arguments restrict tools per role and never bypass permissions', () => {
  const root = path.resolve(os.tmpdir(), 'claude-roots');
  const base = {
    sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    writableRoots: [path.join(root, 'governance')],
    temporaryRoot: path.join(root, 'tmp'),
    maxTurns: 20,
    outputSchema: schema,
  };
  const writer = claudeArguments({ ...base, sandbox: 'workspace-write', model: 'sonnet', effort: 'low' });
  for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--replay-user-messages'])
    assert.ok(writer.includes(flag), flag);
  assert.equal(writer[writer.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(writer[writer.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(writer[writer.indexOf('--max-turns') + 1], '20');
  assert.deepEqual(JSON.parse(writer[writer.indexOf('--json-schema') + 1]), schema);
  assert.ok(writer[writer.indexOf('--tools') + 1].split(',').includes('Edit'));
  assert.deepEqual(
    writer.flatMap((arg, i) => (arg === '--add-dir' ? [writer[i + 1]] : [])),
    [...base.writableRoots, base.temporaryRoot],
  );
  assert.ok(writer.includes('Bash(git diff *)'));
  assert.ok(!writer.some(arg => /bypass|dangerously|Bash\(\*\)|^Bash$/.test(arg) && arg !== 'Bash'));
  const reviewer = claudeArguments({ ...base, sandbox: 'read-only' });
  const tools = reviewer[reviewer.indexOf('--tools') + 1].split(',');
  assert.ok(!tools.includes('Edit') && !tools.includes('Write'));
  assert.equal(reviewer[reviewer.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!reviewer.includes('--add-dir'));
  assert.ok(!reviewer.some(arg => arg.startsWith('Bash(node')));
  assert.throws(() => claudeArguments({ ...base, sandbox: 'danger-full-access' }), /Unsafe sandbox/);
  assert.throws(() => claudeArguments({ ...base, sandbox: 'read-only', model: '--dangerously-skip' }), /model/);
  assert.throws(() => claudeArguments({ ...base, sandbox: 'read-only', maxTurns: 0 }), /turn limit/);
  assert.equal(claudeExecutable({ platform: 'win32', env: { APPDATA: 'C:\\A' }, exists: () => false }), null);
  assert.match(
    claudeExecutable({ platform: 'win32', env: { APPDATA: 'C:\\A' }, exists: () => true }),
    /claude-code[\\/]bin[\\/]claude\.exe$/,
  );
});

test('Claude session streams events, queues a steer into the same turn and returns structured output', async t => {
  const { options, events, lines } = await fixture(t, fakeClaude);
  const session = await openClaudeSession({ ...options, executable: 'claude.exe', limits: { maxTurns: 5 } });
  const turn = session.startTurn('slow question', { outputSchema: schema });
  await until(() => events.some(event => event.kind === 'command'), 'the Claude turn to start');
  await session.steer('extra detail', { by: 'owner' });
  const outcome = await turn;
  // The steer produced its own reply; the turn ends with the last one.
  assert.deepEqual(outcome.result, { answer: 'extra detail' });
  assert.equal(outcome.usage.outputTokens, 4);
  assert.ok(Math.abs(outcome.usage.costUsd - 0.02) < 1e-9);
  await assert.rejects(session.startTurn('different schema', { outputSchema: { type: 'object' } }), /schema/);
  await session.close();
  const kinds = events.map(event => event.kind);
  for (const kind of [
    'session.started',
    'turn.started',
    'command',
    'file_change',
    'message',
    'steer',
    'turn.completed',
  ])
    assert.ok(kinds.includes(kind), kind);
  assert.equal(events.filter(event => event.kind === 'message' && event.final).at(-1).text, 'Answer: extra detail');
  const sent = await lines();
  assert.ok(sent[0].argv.includes('--restricted'));
  const steer = sent.filter(message => message.type === 'user')[1];
  assert.equal(steer.priority, 'next');
});

test('Claude errors, interrupts and sign-in failures are not treated as success', async t => {
  const { options, events } = await fixture(t, fakeClaude);
  const session = await openClaudeSession({ ...options, executable: 'claude.exe' });
  const turn = session.startTurn('slow work');
  await until(() => events.some(event => event.kind === 'command'), 'the Claude turn to start');
  assert.equal(await session.interrupt(), true);
  await assert.rejects(turn, error => error.interrupted === true);
  await session.close();
  const signedOut = await fixture(t, fakeClaude, 'auth');
  const failing = await openClaudeSession({ ...signedOut.options, executable: 'claude.exe' });
  await assert.rejects(
    failing.startTurn('hello', { outputSchema: schema }),
    /Claude reported api_error: Not logged in/,
  );
  assert.ok(signedOut.events.some(event => event.kind === 'turn.failed'));
  await failing.close();
  await assert.rejects(openClaudeSession({ ...options, executable: null }), /not installed/);
});
