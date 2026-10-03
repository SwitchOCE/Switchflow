import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createInitiative } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import {
  PreviewManager,
  resolveExecutable,
  suggestCandidate,
  validatePreviewConfig,
} from '../template/.switchflow/scripts/control/preview.mjs';
import {
  descendantPids,
  isLoopbackAddress,
  parseLsof,
  parseSs,
  parseWindowsListing,
  previewListeners,
} from '../template/.switchflow/scripts/control/preview-network.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { networkView, previewLink, previewView } from '../template/.switchflow/scripts/control/public/preview.js';
import { digest, readState, resolveProject, updateState } from '../template/.switchflow/scripts/operations/storage.mjs';

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t, config = { schemaVersion: 1, command: 'npm', args: ['run', 'dev'], env: { FOO: '1' } }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-preview-'));
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Preview tests']);
  git(repo, ['config', 'user.email', 'preview@example.invalid']);
  await fs.writeFile(path.join(repo, 'app.txt'), 'delivered\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'Delivered baseline']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const context = await resolveProject(repo, { stateHome: path.join(base, 'state') });
  const item = createInitiative({ title: 'Preview', request: 'Try the delivered app.', start: false });
  const grant = digest('approved-grant');
  const name = 'integration';
  const branch = `codex/switchflow-${item.id}-${grant.slice(0, 16)}-${name}`;
  const candidate = path.join(context.stateDir, 'candidates', digest(`${item.id}:${grant}`).slice(0, 16), name);
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  git(repo, ['worktree', 'add', '-b', branch, candidate, head]);
  await updateState(context, `git-bridge-${item.id}-${grant}`, () => ({
    schemaVersion: 1,
    layoutVersion: 2,
    initiativeId: item.id,
    planHash: grant,
    baseHead: head,
    entries: [{ name, path: candidate, branch, baseHead: head, lastHead: head }],
  }));
  Object.assign(item, {
    stage: 'uat',
    status: 'awaiting-human',
    approvedScope: { hash: 'scope' },
    approvedPlan: { hash: 'plan', scopeHash: 'scope', gitGrantHash: grant, baseHead: head, tasks: [] },
    uat: [{ id: 'uat-1', title: 'Open the app and see the result.', status: 'pending', notes: '' }],
    evidence: [`Candidate ${candidate} at ${head}`],
  });
  const configPath = path.join(repo, '.switchflow', 'preview.json');
  await fs.mkdir(path.dirname(configPath));
  const writeConfig = value => fs.writeFile(configPath, JSON.stringify(value));
  if (config) await writeConfig(config);
  const state = { schemaVersion: 1, revision: 1, initiatives: [item], activeRun: null };
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, repo, context, item, candidate, head, configPath, writeConfig, state };
}

function fakeProcesses() {
  const calls = [];
  const killed = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 41000 + calls.length;
    child.finish = (code, signal = null) => {
      child.stdout.end();
      child.stderr.end();
      setTimeout(() => child.emit('close', code, signal), 5);
    };
    child.kill = () => child.finish(null, 'SIGTERM');
    calls.push({ file, args, options, child });
    return child;
  };
  const killTree = async (pid, child) => {
    killed.push(pid);
    child?.finish(null, 'SIGKILL');
  };
  return { spawn, killTree, calls, killed };
}

async function until(fn, label = 'condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function manager(f, processes, options = {}) {
  return new PreviewManager(f.context, {
    engine: { read: async () => structuredClone(f.state) },
    spawn: processes.spawn,
    killTree: processes.killTree,
    resolveCommand: async command => ({ file: `/fake/bin/${command}`, prefix: [] }),
    probePort: async () => false,
    processAlive: () => false,
    processStartedAt: async () => null,
    listListeners: async pid => [{ pid, port: 5173, address: '127.0.0.1' }],
    pollMs: 10,
    stopTimeoutMs: 1000,
    networkRetryMs: 10,
    ...options,
  });
}

test('preview configuration accepts an exact program and rejects shells, traversal and unknown fields', () => {
  const config = validatePreviewConfig({
    schemaVersion: 1,
    command: 'npm',
    args: ['run', 'dev', '--', '--host', '127.0.0.1', 'two words'],
    cwd: 'web/app',
    port: 5173,
    env: { VITE_MODE: 'uat' },
  });
  assert.equal(config.display, 'npm run dev -- --host 127.0.0.1 "two words"');
  assert.match(config.hash, /^[a-f0-9]{64}$/);
  const plain = validatePreviewConfig({ schemaVersion: 1, command: 'npm', args: ['run', 'dev'] });
  assert.equal(plain.hash, validatePreviewConfig({ args: ['run', 'dev'], command: 'npm', schemaVersion: 1 }).hash);
  // Allowing network listeners is part of the reviewed command; leaving it false keeps the old hash.
  assert.equal(plain.allowNetwork, false);
  const open = validatePreviewConfig({ schemaVersion: 1, command: 'npm', args: ['run', 'dev'], allowNetwork: true });
  assert.equal(open.allowNetwork, true);
  assert.notEqual(open.hash, plain.hash);
  assert.equal(
    validatePreviewConfig({ schemaVersion: 1, command: 'npm', args: ['run', 'dev'], allowNetwork: false }).hash,
    plain.hash,
  );
  for (const [value, pattern] of [
    [{ schemaVersion: 1, command: 'npm run dev' }, /command must be/],
    [{ schemaVersion: 1, command: './node_modules/.bin/vite' }, /command must be/],
    [{ schemaVersion: 1, command: 'npm', args: 'run dev' }, /args must be/],
    [{ schemaVersion: 1, command: 'npm', args: ['a\nb'] }, /args must be/],
    [{ schemaVersion: 1, command: 'npm', cwd: '../outside' }, /cwd must be/],
    [{ schemaVersion: 1, command: 'npm', cwd: 'C:/outside' }, /cwd must be/],
    [{ schemaVersion: 1, command: 'npm', port: 70000 }, /port must be/],
    [{ schemaVersion: 1, command: 'npm', env: { 'BAD-NAME': 'x' } }, /env\.BAD-NAME/],
    [{ schemaVersion: 1, command: 'npm', shell: true }, /unsupported field shell/],
    [{ schemaVersion: 1, command: 'npm', allowNetwork: 'yes' }, /allowNetwork must be true or false/],
    [{ command: 'npm' }, /schemaVersion must be 1/],
  ])
    assert.throws(() => validatePreviewConfig(value), pattern);
});

test('Windows programs resolve without a shell or the candidate folder', async () => {
  const files = new Set([
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    'C:\\tools\\vite.cmd',
    'C:\\tools\\caddy.exe',
  ]);
  const options = {
    platform: 'win32',
    env: { PATH: 'C:\\tools;relative\\bin' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    isFile: async file => files.has(file),
  };
  assert.deepEqual(await resolveExecutable('npm', options), {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    prefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
  });
  assert.deepEqual(await resolveExecutable('node', options), { file: options.execPath, prefix: [] });
  assert.deepEqual(await resolveExecutable('caddy', options), { file: 'C:\\tools\\caddy.exe', prefix: [] });
  await assert.rejects(resolveExecutable('vite', options), /Windows command script/);
  await assert.rejects(resolveExecutable('C:\\tools\\vite.cmd', options), /Windows command script/);
  await assert.rejects(resolveExecutable('missing', options), /not found on PATH/);
  await assert.rejects(
    resolveExecutable('npx', { ...options, isFile: async () => false }),
    /npx was not found next to Node/,
  );
});

test('the preview bar links only to loopback addresses and shows the initiative its own preview', () => {
  assert.equal(previewLink('http://localhost:5173/app'), 'http://localhost:5173/app');
  assert.equal(previewLink('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(previewLink('http://[::1]:3000/'), 'http://[::1]:3000/');
  for (const value of ['http://192.168.1.5:5173/', 'javascript:alert(1)', 'http://localhost.evil.example/', null])
    assert.equal(previewLink(value), null);
  const base = { configured: true, eligible: true, candidates: [{ name: 'integration' }], runtime: { state: 'idle' } };
  assert.equal(previewView(undefined, 'a').state, 'loading');
  assert.equal(previewView({ ...base, configured: false }, 'a').state, 'unconfigured');
  assert.equal(previewView({ ...base, configured: false, configError: 'Unknown field: cmd' }, 'a').state, 'invalid');
  assert.equal(previewView({ ...base, eligible: false, reason: 'Not UAT' }, 'a').error, 'Not UAT');
  assert.equal(previewView(base, 'a').state, 'idle');
  const running = { state: 'running', initiativeId: 'b', url: 'http://localhost:5173/' };
  assert.equal(previewView({ ...base, runtime: running }, 'a').state, 'elsewhere');
  assert.equal(previewView({ ...base, runtime: running }, 'b').state, 'running');
  // Another initiative's finished preview does not hide this one's Start.
  assert.equal(previewView({ ...base, runtime: { state: 'failed', initiativeId: 'b' } }, 'a').state, 'idle');
});

test('the suggested candidate is the one the delivery evidence names', () => {
  const entries = [
    {
      name: 'integration',
      path: 'C:\\state\\candidates\\a\\integration',
      baseHead: 'a'.repeat(40),
      lastHead: 'b'.repeat(40),
    },
    { name: 'worker', path: 'C:\\state\\candidates\\a\\worker', baseHead: 'b'.repeat(40), lastHead: 'c'.repeat(40) },
  ];
  assert.equal(suggestCandidate(entries, ['Delivered in C:/state/candidates/a/integration']).name, 'integration');
  assert.equal(suggestCandidate(entries, [`HEAD ${'c'.repeat(7)}`]).name, 'worker');
  assert.equal(suggestCandidate(entries, []).name, 'worker');
  assert.equal(suggestCandidate([], []), null);
});

test('an owner-started preview runs the verified candidate, reports its URL and stops cleanly', async t => {
  const f = await fixture(t);
  const processes = fakeProcesses();
  const preview = manager(f, processes);
  const status = await preview.status(f.item.id);
  assert.equal(status.configured, true);
  assert.equal(status.eligible, true);
  assert.equal(status.suggested, 'integration');
  assert.equal(status.command.display, 'npm run dev');
  assert.deepEqual(status.command.env, ['FOO']);
  assert.equal(status.runtime.state, 'idle');

  await assert.rejects(preview.start(f.item.id, { commandHash: 'f'.repeat(64) }), /command changed/);
  await assert.rejects(preview.start(f.item.id, { commandHash: status.command.hash, shell: true }), /Only commandHash/);
  assert.equal(processes.calls.length, 0);

  const started = await preview.start(f.item.id, { commandHash: status.command.hash });
  assert.equal(started.state, 'starting');
  const [call] = processes.calls;
  assert.equal(call.file, '/fake/bin/npm');
  assert.deepEqual(call.args, ['run', 'dev']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, f.candidate);
  assert.equal(call.options.env.HOST, '127.0.0.1');
  assert.equal(call.options.env.BROWSER, 'none');
  assert.equal(call.options.env.FOO, '1');
  assert.equal((await readState(f.context, 'preview', null)).pid, call.child.pid);

  call.child.stdout.write('  Network: http://192.168.1.5:5173/\n');
  call.child.stdout.write('  \x1b[32m➜\x1b[39m  Local:   http://localhost:\x1b[1m5173\x1b[22m/\n');
  const running = await until(async () => {
    const value = (await preview.status(f.item.id)).runtime;
    return value.state === 'running' && value;
  }, 'running preview');
  assert.equal(running.url, 'http://localhost:5173/');
  assert.equal(running.candidate, 'integration');
  assert.ok(running.logs.includes('  ➜  Local:   http://localhost:5173/'));

  await assert.rejects(preview.start(f.item.id, { commandHash: status.command.hash }), /already running/);
  const stopped = await preview.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.reason, 'Stopped by you.');
  assert.deepEqual(processes.killed, [call.child.pid]);
  await until(async () => (await readState(f.context, 'preview', null)).pid === null, 'cleared record');
});

test('a crashed preview reports failure with its last output', async t => {
  const f = await fixture(t);
  const processes = fakeProcesses();
  const preview = manager(f, processes);
  const { command } = await preview.status(f.item.id);
  await preview.start(f.item.id, { commandHash: command.hash });
  const { child } = processes.calls[0];
  child.stderr.write('Error: Cannot find module vite\n');
  child.finish(1);
  const runtime = await until(async () => {
    const value = (await preview.status(f.item.id)).runtime;
    return value.state === 'failed' && value;
  }, 'failed preview');
  assert.match(runtime.reason, /exit code 1/);
  assert.deepEqual(runtime.logs, ['Error: Cannot find module vite']);
  // A failure clears the slot: the owner can start again.
  await preview.start(f.item.id, { commandHash: command.hash });
  assert.equal(processes.calls.length, 2);
  await preview.close();
});

test('a preview stops when its initiative leaves UAT, and only UAT can start one', async t => {
  const f = await fixture(t);
  const processes = fakeProcesses();
  const preview = manager(f, processes);
  const { command } = await preview.status(f.item.id);
  await preview.start(f.item.id, { commandHash: command.hash });
  f.state.initiatives[0].stage = 'delivery';
  const status = await preview.status(f.item.id);
  assert.equal(status.eligible, false);
  assert.equal(status.runtime.state, 'stopped');
  assert.match(status.runtime.reason, /left UAT/);
  await assert.rejects(preview.start(f.item.id, { commandHash: command.hash }), /waits for your UAT decision/);
  f.state.initiatives[0].stage = 'uat';
  f.state.initiatives[0].status = 'running';
  await assert.rejects(preview.start(f.item.id, { commandHash: command.hash }), /Wait for the agent/);
});

test('a preview refuses a modified candidate, a missing configuration and a busy port', async t => {
  const f = await fixture(t, null);
  const processes = fakeProcesses();
  let busy = true;
  let probes = 0;
  const preview = manager(f, processes, {
    probePort: async () => {
      probes++;
      return busy || probes > 4;
    },
  });
  const unconfigured = await preview.status(f.item.id);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.configError, null);
  await assert.rejects(preview.start(f.item.id, { commandHash: 'a'.repeat(64) }), /Add \.switchflow\/preview\.json/);
  await fs.writeFile(f.configPath, '{ not json');
  assert.match((await preview.status(f.item.id)).configError, /not valid JSON/);

  await f.writeConfig({ schemaVersion: 1, command: 'npm', args: ['start'], port: 4321 });
  const { command } = await preview.status(f.item.id);
  await fs.writeFile(path.join(f.candidate, 'app.txt'), 'changed after review\n');
  await assert.rejects(preview.start(f.item.id, { commandHash: command.hash }), /uncommitted changes/);
  git(f.candidate, ['checkout', '--', 'app.txt']);
  await assert.rejects(preview.start(f.item.id, { commandHash: command.hash }), /Port 4321 is already in use/);
  busy = false;
  probes = 0;
  await preview.start(f.item.id, { commandHash: command.hash });
  assert.equal(processes.calls[0].options.env.PORT, '4321');
  const runtime = await until(async () => {
    const value = (await preview.status(f.item.id)).runtime;
    return value.state === 'running' && value;
  }, 'port probe');
  assert.equal(runtime.url, 'http://localhost:4321/');
  await preview.close();
  assert.deepEqual(processes.killed, [processes.calls[0].child.pid]);
  await assert.rejects(preview.start(f.item.id, { commandHash: command.hash }), /service is stopping/);
});

test('a real local server starts shell-free, answers on its reported URL and its process tree stops', async t => {
  const server =
    "require('http').createServer((q,s)=>s.end('delivered')).listen(0,'127.0.0.1',function(){console.log('Local: http://localhost:'+this.address().port+'/')})";
  const f = await fixture(t, { schemaVersion: 1, command: 'node', args: ['-e', server] });
  const preview = new PreviewManager(f.context, { engine: { read: async () => structuredClone(f.state) } });
  const { command } = await preview.status(f.item.id);
  await preview.start(f.item.id, { commandHash: command.hash });
  const runtime = await until(async () => {
    const value = (await preview.status(f.item.id)).runtime;
    assert.notEqual(value.state, 'failed', value.reason);
    return value.state === 'running' && value;
  }, 'real server');
  // The URL names localhost; the server listens on IPv4 loopback only.
  assert.equal(await (await fetch(runtime.url.replace('localhost', '127.0.0.1'))).text(), 'delivered');
  const stopped = await preview.stop();
  assert.equal(stopped.state, 'stopped');
  await until(() => {
    try {
      process.kill(runtime.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'stopped process');
  await preview.close();
});

test('listener detection walks the preview process tree and tells loopback from network addresses', async () => {
  for (const address of ['127.0.0.1', '127.4.5.6', '::1', '[::1]', '::ffff:127.0.0.1', '127.0.0.1%lo'])
    assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ['0.0.0.0', '::', '[::]', '*', '192.168.1.5', 'fe80::1', '::ffff:0.0.0.0', '127.example'])
    assert.equal(isLoopbackAddress(address), false, address);

  // npm (100) -> cmd (101) -> vite (102); 103 claims 101 as parent but predates it: a reused parent ID.
  const listing = [
    'P 100 50 1000',
    'P 101 100 1100',
    'P 102 101 1200',
    'P 103 101 900',
    'P 200 50 1000',
    'P 0 0 0',
    'L 102 5173 0.0.0.0',
    'L 102 5174 ::1',
    'L 103 9000 0.0.0.0',
    'L 200 8080 0.0.0.0',
    'noise',
  ].join('\r\n');
  const { processes, listeners } = parseWindowsListing(listing);
  assert.equal(processes.length, 6);
  assert.deepEqual([...descendantPids(100, processes)].sort(), [100, 101, 102]);
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return listing;
  };
  assert.deepEqual(await previewListeners(100, { platform: 'win32', run }), listeners.slice(0, 2));
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  assert.equal(calls[0].options.timeout, 10000);
  await assert.rejects(previewListeners(100, { platform: 'win32', run: async () => '' }), /process list was empty/);
  await assert.rejects(previewListeners(0, { platform: 'win32', run }), /no process ID/);

  assert.deepEqual(parseLsof('p102\nf20\nn*:5173\nf21\nn127.0.0.1:5174\np103\nf3\nn[::]:9000\n'), [
    { pid: 102, address: '*', port: 5173 },
    { pid: 102, address: '127.0.0.1', port: 5174 },
    { pid: 103, address: '[::]', port: 9000 },
  ]);
  assert.deepEqual(
    parseSs(
      'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=102,fd=20))\nLISTEN 0 4096 127.0.0.1%lo:53 0.0.0.0:*\n',
    ),
    [{ pid: 102, address: '0.0.0.0', port: 5173 }],
  );
  // Elsewhere: ps for the tree, lsof for listeners, ss when lsof is missing, and lsof's "nothing found" exit.
  const ps = '  100  50\n  101 100\n  102 101\n  200  50\n';
  const unix = lsof => async (file, args) => {
    if (file === 'ps') return ps;
    if (file === 'lsof') return lsof(args);
    return 'LISTEN 0 511 *:5173 *:* users:(("node",pid=102,fd=20))\nLISTEN 0 511 *:8080 *:* users:(("x",pid=200,fd=3))';
  };
  assert.deepEqual(
    await previewListeners(100, {
      platform: 'linux',
      run: unix(args => {
        assert.equal(args[args.indexOf('-p') + 1], '100,101,102');
        return 'p102\nn[::]:5173\n';
      }),
    }),
    [{ pid: 102, address: '[::]', port: 5173 }],
  );
  const missing = Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(
    await previewListeners(100, {
      platform: 'linux',
      run: unix(() => {
        throw missing;
      }),
    }),
    [{ pid: 102, address: '*', port: 5173 }],
  );
  const none = Object.assign(new Error('exit 1'), { code: 1, stdout: '' });
  assert.deepEqual(
    await previewListeners(100, {
      platform: 'darwin',
      run: unix(() => {
        throw none;
      }),
    }),
    [],
  );
});

async function runningPreview(t, config, listListeners, options = {}) {
  const f = await fixture(t, { schemaVersion: 1, command: 'npm', args: ['run', 'dev'], ...config });
  const processes = fakeProcesses();
  const preview = manager(f, processes, { listListeners, ...options });
  t.after(() => preview.close());
  const { command } = await preview.status(f.item.id);
  await preview.start(f.item.id, { commandHash: command.hash });
  processes.calls[0].child.stdout.write('Local: http://localhost:5173/\n');
  return { f, preview, processes, command };
}

test('a preview listening on the network is stopped unless the owner allowed it', async t => {
  const exposedOn = async pid => [
    { pid, port: 5173, address: '0.0.0.0' },
    { pid, port: 5173, address: '::' },
    { pid, port: 24678, address: '127.0.0.1' },
  ];
  const blocked = await runningPreview(t, {}, exposedOn);
  const stopped = await until(async () => {
    const value = (await blocked.preview.status(blocked.f.item.id)).runtime;
    return value.state === 'stopped' && value;
  }, 'network stop');
  assert.equal(
    stopped.reason,
    'Stopped because it was listening on your network (0.0.0.0:5173, [::]:5173), where other devices could reach it.',
  );
  assert.deepEqual(stopped.network, {
    state: 'exposed',
    exposed: ['0.0.0.0:5173', '[::]:5173'],
    allowed: false,
    error: null,
  });
  assert.deepEqual(blocked.processes.killed, [blocked.processes.calls[0].child.pid]);
  assert.deepEqual(networkView(stopped), {
    state: 'exposed',
    exposed: ['0.0.0.0:5173', '[::]:5173'],
    allowed: false,
    stopped: true,
  });

  let checks = 0;
  const allowed = await runningPreview(
    t,
    { allowNetwork: true },
    async pid => {
      checks++;
      return exposedOn(pid);
    },
    { networkCheckMs: 10 },
  );
  assert.equal(allowed.command.allowNetwork, true);
  // It keeps running and is checked again while it runs.
  await until(() => checks >= 3, 'repeated checks');
  const runtime = (await allowed.preview.status(allowed.f.item.id)).runtime;
  assert.equal(runtime.state, 'running');
  assert.equal(runtime.network.state, 'exposed');
  assert.equal(runtime.network.allowed, true);
  assert.deepEqual(allowed.processes.killed, []);
  assert.equal(networkView(runtime).stopped, false);
  assert.equal(previewView({ configured: true, eligible: true, runtime }, allowed.f.item.id).network.state, 'exposed');
  await allowed.preview.stop();
  const after = checks;
  // Stopping ends the checks: a stopped preview is never checked again.
  await allowed.preview.checkNetwork(allowed.preview.last);
  assert.equal(checks, after);
});

test('a listener check that fails or finds nothing is reported without stopping the preview', async t => {
  const failing = await runningPreview(t, {}, async () => {
    throw new Error('Get-NetTCPConnection is not available\nat line 7');
  });
  const unknown = await until(async () => {
    const value = (await failing.preview.status(failing.f.item.id)).runtime;
    return value.network?.state === 'unknown' && value;
  }, 'unknown network');
  assert.equal(unknown.state, 'running');
  assert.equal(unknown.network.error, 'Get-NetTCPConnection is not available');
  assert.deepEqual(networkView(unknown), { state: 'unknown', error: 'Get-NetTCPConnection is not available' });
  assert.deepEqual(failing.processes.killed, []);

  // A hung check never blocks Stop: stopping cancels it.
  let aborted = false;
  const hung = await runningPreview(t, {}, (pid, { signal }) => {
    signal.addEventListener('abort', () => (aborted = true));
    return new Promise(() => {});
  });
  await until(async () => (await hung.preview.status(hung.f.item.id)).runtime.state === 'running', 'running');
  assert.equal((await hung.preview.stop()).state, 'stopped');
  assert.equal(aborted, true);

  let empty = 0;
  const quiet = await runningPreview(t, {}, async () => {
    empty++;
    return [];
  });
  const none = await until(async () => {
    const value = (await quiet.preview.status(quiet.f.item.id)).runtime;
    return value.network?.state === 'unknown' && value;
  }, 'no listener');
  assert.equal(empty, 3);
  assert.match(none.network.error, /No listening port was found/);
  assert.equal(none.state, 'running');
});

test('the real listener check stops a server bound to every interface and keeps a loopback one', async t => {
  const server = host =>
    `require('http').createServer((q,s)=>s.end('ok')).listen(0,'${host}',function(){console.log('Local: http://localhost:'+this.address().port+'/')})`;
  for (const [host, expected] of [
    ['0.0.0.0', 'exposed'],
    ['127.0.0.1', 'local'],
  ]) {
    const f = await fixture(t, { schemaVersion: 1, command: 'node', args: ['-e', server(host)] });
    const preview = new PreviewManager(f.context, { engine: { read: async () => structuredClone(f.state) } });
    t.after(() => preview.close());
    const { command } = await preview.status(f.item.id);
    await preview.start(f.item.id, { commandHash: command.hash });
    const runtime = await until(
      async () => {
        const value = (await preview.status(f.item.id)).runtime;
        const checked = value.network && value.network.state !== 'checking';
        return checked && (value.network.state !== 'exposed' || value.state === 'stopped') && value;
      },
      `${host} listener check`,
      60000,
    );
    assert.equal(runtime.network.state, expected, runtime.network.error || '');
    if (expected === 'exposed') {
      assert.equal(runtime.state, 'stopped');
      assert.match(runtime.network.exposed[0], /^0\.0\.0\.0:\d+$/);
      await until(() => {
        try {
          process.kill(runtime.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 'stopped process');
    } else assert.equal(runtime.state, 'running');
    await preview.close();
  }
});

test('restart stops a recorded preview only when it is still the same process', async t => {
  const f = await fixture(t);
  const startedAt = new Date().toISOString();
  for (const [startTime, expectKill] of [
    [Date.parse(startedAt) + 800, true],
    [Date.parse(startedAt) - 3600000, false],
  ]) {
    await updateState(f.context, 'preview', () => ({ schemaVersion: 1, pid: 777, startedAt }));
    const processes = fakeProcesses();
    const preview = manager(f, processes, { processAlive: () => true, processStartedAt: async () => startTime });
    await preview.recover();
    assert.deepEqual(processes.killed, expectKill ? [777] : []);
    assert.match(preview.notice, expectKill ? /Stopped a preview/ : /could not be confirmed/);
    assert.equal((await readState(f.context, 'preview', null)).pid, null);
  }
});

test('HTTP preview routes need the page token and stop the preview when rework is requested', async t => {
  const f = await fixture(t);
  const processes = fakeProcesses();
  const app = await createControlServer({
    context: f.context,
    capabilities: { codex: false },
    backlog: { list: async () => [] },
    nativeFactory: () => ({ close: async () => {} }),
    runner: async () => {
      throw new Error('No agents in the preview fixture');
    },
    previewFactory: (context, options) =>
      new PreviewManager(context, {
        ...options,
        spawn: processes.spawn,
        killTree: processes.killTree,
        resolveCommand: async command => ({ file: `/fake/bin/${command}`, prefix: [] }),
        probePort: async () => false,
      }),
  });
  try {
    await app.engine.mutate(state => {
      state.initiatives.push(f.item);
    });
    const route = `${app.url}/api/initiatives/${f.item.id}/preview`;
    const { csrfToken } = await (await fetch(`${app.url}/api/state`)).json();
    const status = await (await fetch(route)).json();
    assert.equal(status.configured, true);
    const post = (suffix, body, token = csrfToken) =>
      fetch(route + suffix, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': token },
        body: JSON.stringify(body),
      });
    assert.equal((await post('/start', { commandHash: status.command.hash }, '')).status, 403);
    assert.equal(processes.calls.length, 0);
    const started = await post('/start', { commandHash: status.command.hash });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).runtime.state, 'starting');
    const rework = await fetch(`${app.url}/api/initiatives/${f.item.id}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken },
      body: JSON.stringify({
        action: 'request-rework',
        expectedRevision: f.item.revision,
        feedback: 'The page is blank.',
        results: [{ id: 'uat-1', status: 'failed', notes: 'Blank page' }],
      }),
    });
    assert.equal(rework.status, 200);
    assert.deepEqual(processes.killed, [processes.calls[0].child.pid]);
    const after = await (await fetch(route)).json();
    assert.equal(after.runtime.state, 'stopped');
    assert.equal(after.runtime.reason, 'Stopped because you requested rework.');
    assert.equal(after.eligible, false);
  } finally {
    await app.close();
  }
});
