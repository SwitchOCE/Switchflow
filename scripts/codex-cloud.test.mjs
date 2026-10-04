import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import { AgentHost } from '../template/.switchflow/scripts/control/agent-host.mjs';
import { Orchestration } from '../template/.switchflow/scripts/control/orchestration.mjs';
import { readDelegations } from '../template/.switchflow/scripts/control/worker-ledger.mjs';
import {
  CAPABILITIES,
  MAX_PROMPT,
  RESULT_FILE,
  createCodexCloudEnvironment,
  diffFiles,
  openCodexCloudSession,
  parseStatus,
  parseTaskId,
  resultFromDiff,
  validateCodexCloudConfig,
} from '../template/.switchflow/scripts/control/environments/codex-cloud.mjs';
import {
  EnvironmentRegistry,
  validateEnvironmentConfig,
} from '../template/.switchflow/scripts/control/environments/index.mjs';
import { fakeProvider, fixture, roomyPool, until } from './agent-fakes.mjs';

const CONFIG = {
  environmentId: 'env-switchflow-test',
  repository: 'https://github.com/example/project',
  push: true,
  pollSeconds: 15,
  experimental: true,
};
const TASK_URL = 'https://chatgpt.com/codex/tasks/task_e_0123456789abcdef';
const KEY = 't-1-abcdef12';

// A stand-in for `codex` with the output shapes of codex-cli 0.153.4 (cloud-tasks/src/lib.rs):
// exec prints the task URL, status prints "[STATUS] title" and exits 0 only when READY, diff
// prints the unified diff, list --json prints { tasks, cursor }.
const FAKE_CODEX = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');
const mode = process.env.FAKE_MODE || 'ok';
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
const [, command, ...rest] = args;
if (command === 'list') {
  if (mode === 'signed-out') { console.error('Error: not signed in with ChatGPT'); process.exit(1); }
  console.log(JSON.stringify({ tasks: [], cursor: null }, null, 2));
} else if (command === 'exec') {
  console.log(${JSON.stringify(TASK_URL)});
} else if (command === 'status') {
  const counter = path.join(state, 'polls');
  const polls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(polls + 1));
  if (mode === 'error') { console.log('\u001b[31m[ERROR]\u001b[0m Make the change\nenv-switchflow-test • just now'); process.exit(1); }
  if (polls < 1) { console.log('[PENDING] Make the change\nenv-switchflow-test • just now\n+0/-0 • 0 files'); process.exit(1); }
  console.log('[READY] Make the change\nenv-switchflow-test • just now\n+2/-0 • 2 files');
} else if (command === 'diff') {
  const file = path.join(state, 'diff.patch');
  if (!fs.existsSync(file)) { console.error('No diff available for task ' + rest[0] + '; it may still be running.'); process.exit(1); }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
} else { console.error('unexpected ' + command); process.exit(2); }
`;

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

async function repoWithRemote(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-codex-cloud-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const remote = path.join(base, 'remote.git');
  const local = path.join(base, 'local');
  git(base, 'init', '--bare', '-b', 'main', remote);
  git(base, 'init', '-b', 'main', local);
  git(local, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(local, 'a.txt'), 'a\n');
  git(local, 'add', 'a.txt');
  git(local, 'commit', '-m', 'base');
  git(local, 'remote', 'add', 'origin', remote);
  const state = path.join(base, 'fake');
  await fs.mkdir(state);
  return { base, remote, local, state };
}

/** The diff a cloud task would produce: files written in a scratch clone of the candidate. */
async function cloudDiff(base, local, files) {
  const clone = path.join(base, `worker-${randomUUID().slice(0, 8)}`);
  git(base, 'clone', '-q', '-c', 'core.autocrlf=false', local, clone);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(clone, name), content);
  git(clone, 'add', '-A');
  return execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--cached'], {
    cwd: clone,
    encoding: 'utf8',
    windowsHide: true,
  });
}

const result = fields =>
  JSON.stringify({
    task: 'T-1',
    outcome: 'handoff',
    approach: '',
    head: 'x',
    envelope: 'e',
    summary: 'done',
    blockers: [],
    ...fields,
  });

/** Runs the fake `codex` through node; every child is killed in t.after if it is still running. */
async function fakeCodex(t, state, mode = 'ok') {
  const script = path.join(state, 'codex.cjs');
  await fs.writeFile(script, FAKE_CODEX);
  const children = new Set();
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const run = (_executable, args, { cwd, env, timeoutMs = 60000 } = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [script, ...args],
        { cwd, env: { ...env, FAKE_STATE: state, FAKE_MODE: mode }, timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          children.delete(child);
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        },
      );
      children.add(child);
    });
  const calls = async () =>
    (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  return { run, calls };
}

test('configuration is opt-in and validated, providers match the kind, and capabilities are honest', () => {
  assert.deepEqual(validateCodexCloudConfig(CONFIG).problems, []);
  assert.match(validateCodexCloudConfig({ ...CONFIG, experimental: false }).problems.join(' '), /opt in/);
  assert.match(validateCodexCloudConfig({ ...CONFIG, environmentId: 'a b' }).problems.join(' '), /environmentId/);
  assert.match(validateCodexCloudConfig({ ...CONFIG, repository: 'git@x:y' }).problems.join(' '), /repository/);
  const valid = validateEnvironmentConfig({ id: 'codex-cloud', kind: 'codex-cloud', provider: 'codex', ...CONFIG });
  assert.equal(valid.kind, 'codex-cloud');
  assert.equal(valid.push, true);
  assert.throws(
    () => validateEnvironmentConfig({ id: 'codex-cloud', kind: 'codex-cloud', ...CONFIG, experimental: undefined }),
    /experimental/,
  );
  assert.throws(
    () => validateEnvironmentConfig({ id: 'codex-cloud', kind: 'codex-cloud', provider: 'claude', ...CONFIG }),
    /runs codex workers only/,
  );
  assert.throws(
    () =>
      validateEnvironmentConfig({
        id: 'claude-cloud',
        kind: 'claude-cloud',
        provider: 'codex',
        environmentId: 'env_01GCmxMt1zESEPw1oYusiee2',
        repository: 'https://github.com/example/project',
      }),
    /runs claude workers only/,
  );
  assert.throws(
    () => validateEnvironmentConfig({ id: 'codex-cloud', kind: 'codex-cloud', ...CONFIG, model: 'x' }),
    /Unsupported Codex cloud fields: model/,
  );
  assert.deepEqual(
    { ...CAPABILITIES },
    { stream: false, steer: false, interrupt: false, followUp: false, result: 'diff', approachGate: false },
  );
});

test('CLI output is parsed: task URL, status lines, diff files and the result file', async t => {
  assert.equal(parseTaskId(`${TASK_URL}\n`), 'task_e_0123456789abcdef');
  assert.equal(parseTaskId(`${TASK_URL}/?tab=diff#x`), 'task_e_0123456789abcdef');
  assert.equal(parseTaskId('nothing useful'), null);
  assert.deepEqual(parseStatus('\u001b[32m[READY]\u001b[0m Fix it\nenv • 1m ago\n+1/-0 • 1 file'), {
    status: 'ready',
    title: 'Fix it',
    detail: 'env • 1m ago • +1/-0 • 1 file',
  });
  assert.equal(parseStatus(''), null);
  const { base, local } = await repoWithRemote(t);
  const diff = await cloudDiff(base, local, { 'b.txt': 'b\n', [RESULT_FILE]: result() });
  assert.deepEqual(diffFiles(diff).sort(), [RESULT_FILE, 'b.txt'].sort());
  assert.equal(resultFromDiff(diff).outcome, 'handoff');
  assert.equal(resultFromDiff(await cloudDiff(base, local, { 'b.txt': 'b\n' })), null);
});

test('submit refuses without the push grant, then pushes the candidate head and submits with --env and --branch', async t => {
  const { local, remote, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  const head = git(local, 'rev-parse', 'HEAD');
  const refused = createCodexCloudEnvironment({
    config: { ...CONFIG, push: false },
    projectRoot: local,
    run: fake.run,
  });
  await assert.rejects(
    refused.submit({ key: KEY, task: 'T-1', prompt: 'x', head, cwd: local }),
    /candidate head must be pushed.*owner grants pushes/,
  );
  await assert.rejects(
    createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run }).submit({
      key: KEY,
      task: 'T-1',
      prompt: 'x'.repeat(MAX_PROMPT),
      head,
      cwd: local,
    }),
    /command line allows/,
  );
  assert.deepEqual(await fake.calls(), [], 'nothing was submitted');
  const env = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run });
  const handle = await env.submit({ key: KEY, task: 'T-1', prompt: 'Make the change.', head, cwd: local });
  assert.equal(handle.taskId, 'task_e_0123456789abcdef');
  assert.equal(handle.url, TASK_URL);
  assert.equal(git(remote, 'rev-parse', `refs/heads/sf-task/${KEY}`), head);
  const [exec] = await fake.calls();
  assert.deepEqual(exec.slice(0, 6), ['cloud', 'exec', '--env', CONFIG.environmentId, '--branch', `sf-task/${KEY}`]);
  assert.match(exec[6], /Make the change\./);
  assert.match(exec[6], new RegExp(RESULT_FILE.replace('.', '\\.')));
});

test('a writable session polls to READY, applies the diff into the candidate and commits it; no follow-up', async t => {
  const { base, local, remote, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  await fs.writeFile(
    path.join(state, 'diff.patch'),
    await cloudDiff(base, local, { 'b.txt': 'b\n', [RESULT_FILE]: result() }),
  );
  const env = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run });
  const events = [];
  const session = await openCodexCloudSession({
    adapter: env,
    task: 'T-1',
    key: KEY,
    cwd: local,
    pollMs: 5,
    onEvent: async e => events.push(e),
  });
  assert.equal(session.canSteer, false);
  const turn = await session.startTurn('Make the change.', { sandbox: 'workspace-write' });
  assert.equal(turn.result.outcome, 'handoff');
  assert.equal(turn.result.head, git(local, 'rev-parse', 'HEAD'));
  assert.equal(await fs.readFile(path.join(local, 'b.txt'), 'utf8'), 'b\n');
  await assert.rejects(fs.stat(path.join(local, RESULT_FILE)), 'the result file is never applied');
  assert.equal(git(local, 'status', '--porcelain'), '');
  assert.match(git(local, 'log', '-1', '--format=%an %s'), /^Switchflow T-1: work from Codex cloud task task_e_/);
  const statuses = (await fake.calls()).filter(args => args[1] === 'status').length;
  assert.equal(statuses, 2, 'pending, then ready');
  assert.ok(events.some(e => e.kind === 'notice' && /Codex cloud task pending/.test(e.text)));
  assert.ok(events.some(e => e.kind === 'notice' && /Applied the Codex cloud diff \(1 file/.test(e.text)));
  await assert.rejects(session.startTurn('More.'), /no follow-up turns/);
  await assert.rejects(session.steer('Hurry.'), /cannot be steered/);
  assert.equal(await session.interrupt(), false, 'nothing is running');
  await session.close();
  assert.throws(() => git(remote, 'rev-parse', '--verify', `refs/heads/sf-task/${KEY}`), 'the start branch is removed');
  assert.equal(events.at(-1).kind, 'session.closed');
});

test('a read-only session returns its result and never applies the diff', async t => {
  const { base, local, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  const verdict = result({ outcome: undefined, verdict: 'accept', comment: 'Verdict: accept' });
  await fs.writeFile(
    path.join(state, 'diff.patch'),
    await cloudDiff(base, local, { 'a.txt': 'edited\n', [RESULT_FILE]: verdict }),
  );
  const env = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run });
  const events = [];
  const session = await openCodexCloudSession({
    adapter: env,
    task: 'T-1',
    key: KEY,
    cwd: local,
    pollMs: 5,
    onEvent: async e => events.push(e),
  });
  const before = git(local, 'rev-parse', 'HEAD');
  const turn = await session.startTurn('Review it.', { sandbox: 'read-only' });
  assert.equal(turn.result.verdict, 'accept');
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);
  assert.equal(await fs.readFile(path.join(local, 'a.txt'), 'utf8'), 'a\n');
  assert.ok(events.some(e => e.level === 'warning' && /changed 1 file\(s\); the host discarded them/.test(e.text)));
  assert.match((await fake.calls()).find(args => args[1] === 'exec')[6], /read-only/);
  await session.close();
});

test('collect refuses a dirty candidate or a diff that does not apply, leaving the candidate as it was', async t => {
  const { base, local, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  const env = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run });
  const handle = { task: 'T-1', taskId: 'task_e_0123456789abcdef', cwd: local };
  const head = git(local, 'rev-parse', 'HEAD');
  const diff = await cloudDiff(base, local, { 'a.txt': 'cloud\n', [RESULT_FILE]: result() });
  await fs.writeFile(path.join(local, 'a.txt'), 'local edit\n');
  const dirty = await env.collect(handle, { diff });
  assert.equal(dirty.collected, false);
  assert.match(dirty.reason, /uncommitted changes/);
  git(local, 'commit', '-am', 'local change');
  const conflicting = await env.collect(handle, { diff });
  assert.equal(conflicting.collected, false);
  assert.match(conflicting.reason, /does not apply/);
  assert.equal(git(local, 'status', '--porcelain'), '');
  assert.notEqual(git(local, 'rev-parse', 'HEAD'), head);
  assert.equal(await fs.readFile(path.join(local, 'a.txt'), 'utf8'), 'local edit\n');
  const empty = await env.collect(handle, { diff: await cloudDiff(base, local, { [RESULT_FILE]: result() }) });
  assert.deepEqual([empty.collected, empty.changed], [true, false]);
});

test('a failed cloud task fails the turn, and a missing result file is an error', async t => {
  const { base, local, state } = await repoWithRemote(t);
  const failing = await fakeCodex(t, state, 'error');
  const env = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: failing.run });
  const session = await openCodexCloudSession({ adapter: env, task: 'T-1', key: KEY, cwd: local, pollMs: 5 });
  await assert.rejects(session.startTurn('x', { sandbox: 'read-only' }), /Codex cloud task failed: Make the change/);
  await session.close();
  await fs.rm(path.join(state, 'polls'));
  await fs.writeFile(path.join(state, 'diff.patch'), await cloudDiff(base, local, { 'b.txt': 'b\n' }));
  const fake = await fakeCodex(t, state);
  const other = createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run });
  const second = await openCodexCloudSession({ adapter: other, task: 'T-1', key: KEY, cwd: local, pollMs: 5 });
  await assert.rejects(second.startTurn('x'), /without \.switchflow-result\.json/);
  await assert.rejects(fs.stat(path.join(local, 'b.txt')));
  await second.close();
});

test('health explains the push requirement and reports ChatGPT sign-in through codex cloud list', async t => {
  const { local, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  const env = createCodexCloudEnvironment({ config: { ...CONFIG, push: false }, projectRoot: local, run: fake.run });
  const health = await env.health();
  const byName = Object.fromEntries(health.checks.map(c => [c.name, c]));
  assert.equal(byName.configured.ok, true);
  assert.equal(byName.codex.ok, true);
  assert.equal(byName.cloud.ok, true);
  assert.equal(byName.remote.ok, false, 'origin is a local path, not the configured GitHub repository');
  assert.equal(byName.push.ok, false);
  assert.match(byName.push.detail, /candidate head must be pushed/);
  assert.equal(health.ok, false);
  assert.match(health.reason, /candidate head must be pushed/);
  assert.ok(
    (await fake.calls()).some(args => args.join(' ') === `cloud list --json --env ${CONFIG.environmentId} --limit 1`),
  );
  const signedOut = await fakeCodex(t, state, 'signed-out');
  const out = await createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: signedOut.run }).health();
  assert.equal(out.checks.find(c => c.name === 'cloud').ok, false);
  assert.match(out.checks.find(c => c.name === 'cloud').detail, /not signed in/);
});

test('the registry builds a codex-cloud adapter from owner settings', () => {
  const registry = new EnvironmentRegistry({ projectRoot: process.cwd() });
  const settings = { environments: [{ id: 'codex-cloud', kind: 'codex-cloud', ...CONFIG }] };
  const env = registry.get('codex-cloud', settings);
  assert.equal(typeof env.openSession, 'function');
  assert.equal(env.provider, 'codex');
  assert.equal(env.remote, true);
  assert.deepEqual(registry.list(settings).find(e => e.id === 'codex-cloud').capabilities, CAPABILITIES);
});

const planHash = 'b'.repeat(64);

/** A codex-cloud double whose session answers every turn with a review verdict. */
function cloudDouble() {
  const opened = [];
  return {
    opened,
    id: 'codex-cloud',
    kind: 'codex-cloud',
    label: 'Codex cloud',
    provider: 'codex',
    remote: true,
    capabilities: CAPABILITIES,
    config: {},
    health: async () => ({ ok: true, checks: [] }),
    openSession: async options => {
      const handle = {
        provider: 'codex',
        canSteer: false,
        activeTurnId: null,
        closed: false,
        turns: [],
        resumed: 0,
        startTurn: async (text, turnOptions) => {
          handle.turns.push({ text, ...turnOptions });
          return { turnId: 'task_e_1', result: JSON.parse(result({ verdict: 'accept', comment: 'Verdict: accept' })) };
        },
        // A reconnected task: its running turn ends with the same verdict.
        resumeTurn: async () => {
          handle.resumed++;
          return { turnId: 'task_e_1', result: JSON.parse(result({ verdict: 'accept', comment: 'Verdict: accept' })) };
        },
        close: async () => opened.push('closed'),
      };
      opened.push({ options, handle });
      return handle;
    },
  };
}

/** An orchestration with one candidate whose only remote environment is `cloud`. */
async function cloudOrchestration(t, context, cloud) {
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
    capabilities: { codex: { available: true }, claude: { available: true, loggedIn: true } },
    providers: { codex: fakeProvider('codex', log), claude: fakeProvider('claude', log) },
    capacity: { pool: roomyPool() },
    environments: new EnvironmentRegistry([cloud]),
  });
  await host.init();
  const runId = randomUUID();
  const orchestration = new Orchestration({
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
    signal: new AbortController().signal,
    orchestratorProvider: 'claude',
    serviceUrl: 'http://127.0.0.1:9',
    projectId: context.id,
  });
  await orchestration.prepare();
  const orchestrator = await host.registry.create({ runId, initiativeId, role: 'execution', provider: 'claude' });
  orchestration.setOrchestrator(orchestrator.id);
  t.after(async () => {
    await orchestration.close();
    await host.close();
  });
  return { host, log, orchestration };
}

test('orchestration refuses Codex cloud delivery (approach gate) and Claude reviewers, and runs Codex reviews there', t =>
  fixture(async context => {
    const cloud = cloudDouble();
    const { host, log, orchestration } = await cloudOrchestration(t, context, cloud);
    const call = (tool, args) => orchestration.call(tool, args);
    const base = { task: 'DEMO-1', instructions: 'x', worktree: 'cand', environment: 'codex-cloud' };
    await assert.rejects(
      call('delegate_task', { ...base, kind: 'deliver' }),
      error => error.status === 409 && /no approach turn.*approach gate/.test(error.message),
    );
    await assert.rejects(
      call('delegate_task', { ...base, kind: 'review', provider: 'claude' }),
      error => error.status === 409 && /runs codex workers only/.test(error.message),
    );
    assert.equal(cloud.opened.length, 0);
    assert.equal(log.length, 0, 'nothing fell back to this PC');
    const review = await call('delegate_task', { ...base, kind: 'review' });
    assert.equal(review.environment, 'codex-cloud');
    const waited = await call('wait_for_workers', { workerIds: [review.workerId], timeoutSeconds: 5 });
    assert.equal(waited.workers[0].status, 'completed');
    const { options } = cloud.opened.find(entry => entry.handle);
    assert.equal(options.sandbox, 'read-only', 'a review session is read-only on every turn');
    const meta = await until(() => host.registry.find(review.workerId));
    assert.equal(meta.provider, 'codex');
    assert.equal(meta.transport, 'codex-cloud');
    assert.equal(log.length, 0);
  }));

test('a Codex cloud task is reattached by its ID after a restart: polling goes on, nothing is resubmitted', async t => {
  const { base, local, state } = await repoWithRemote(t);
  const fake = await fakeCodex(t, state);
  const verdict = result({ outcome: undefined, verdict: 'accept', comment: 'Verdict: accept' });
  await fs.writeFile(path.join(state, 'diff.patch'), await cloudDiff(base, local, { [RESULT_FILE]: verdict }));
  const records = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stopped = await openCodexCloudSession({
    adapter: createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run }),
    task: 'T-1',
    key: KEY,
    cwd: local,
    sandbox: 'read-only',
    pollMs: 5,
    signal: controller.signal,
    onHandle: async record => records.push(record),
  });
  const abandoned = stopped.startTurn('Review it.').catch(error => error);
  const record = structuredClone(await until(() => records.find(entry => entry.status === 'pending')));
  controller.abort();
  await abandoned;
  assert.deepEqual(
    [record.key, record.taskId, record.url, record.branch, record.turn],
    [KEY, 'task_e_0123456789abcdef', TASK_URL, `sf-task/${KEY}`, { open: true, writable: false }],
  );

  // A restarted service: a new adapter and session from the record alone.
  const events = [];
  const recordsAfter = [];
  const session = await openCodexCloudSession({
    adapter: createCodexCloudEnvironment({ config: CONFIG, projectRoot: local, run: fake.run }),
    task: 'T-1',
    cwd: local,
    sandbox: 'read-only',
    pollMs: 5,
    resume: record,
    onEvent: async event => events.push(event),
    onHandle: async entry => recordsAfter.push(entry),
  });
  assert.equal(session.threadId, 'task_e_0123456789abcdef');
  assert.match(events.find(event => event.kind === 'notice').text, /Reconnected to Codex cloud task task_e_/);
  const turn = await session.resumeTurn();
  assert.equal(turn.result.verdict, 'accept');
  const calls = await fake.calls();
  assert.equal(calls.filter(args => args[1] === 'exec').length, 1, 'the task was not submitted again');
  assert.ok(calls.filter(args => args[1] === 'status').every(args => args[2] === 'task_e_0123456789abcdef'));
  assert.deepEqual(recordsAfter.at(-1).turn, { open: false, writable: false });
  await assert.rejects(session.startTurn('More.'), /no follow-up turns/);
  await session.close();
});

test('resuming a held Codex cloud review reconnects to its task instead of submitting another', t =>
  fixture(async context => {
    const cloud = cloudDouble();
    const { orchestration } = await cloudOrchestration(t, context, cloud);
    const record = { key: KEY, taskId: 'task_e_1', url: TASK_URL, turn: { open: true, writable: false } };
    const outcome = await orchestration.resume([
      {
        workerId: 'old-review',
        task: 'DEMO-1',
        kind: 'review',
        worktree: 'cand',
        provider: 'codex',
        environment: 'codex-cloud',
        instructions: 'Review it.',
        status: 'open',
        cloud: record,
      },
    ]);
    assert.deepEqual(outcome, { resumed: ['DEMO-1 review (reconnected)'], failed: [] });
    const waited = await orchestration.call('wait_for_workers', { timeoutSeconds: 5 });
    assert.equal(waited.workers[0].status, 'completed');
    assert.equal(waited.workers[0].result.verdict, 'accept');
    const { options, handle } = cloud.opened.find(entry => entry.handle);
    assert.deepEqual(options.resume, record);
    assert.deepEqual([handle.turns.length, handle.resumed], [0, 1], 'no new task: the running one is followed');
    const [carried] = await readDelegations(context, [waited.workers[0].workerId]);
    assert.equal(carried.cloud.taskId, 'task_e_1');
  }));
