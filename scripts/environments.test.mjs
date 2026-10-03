import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import { AgentHost } from '../template/.switchflow/scripts/control/agent-host.mjs';
import { Orchestration } from '../template/.switchflow/scripts/control/orchestration.mjs';
import { applySettingsPatch, defaultAgentSettings } from '../template/.switchflow/scripts/control/agent-settings.mjs';
import { stopTree } from '../template/.switchflow/scripts/control/codex-runner.mjs';
import {
  EnvironmentRegistry,
  validateEnvironmentConfig,
} from '../template/.switchflow/scripts/control/environments/index.mjs';
import { createLocalEnvironment } from '../template/.switchflow/scripts/control/environments/local.mjs';
import {
  createSshEnvironment,
  parseHealth,
  remoteCommand,
  remoteEnvironment,
  shellQuote,
  validateSshConfig,
} from '../template/.switchflow/scripts/control/environments/ssh.mjs';
import { fakeProvider, fixture, roomyPool, until } from './agent-fakes.mjs';

const both = { codex: { available: true }, claude: { available: true, loggedIn: true } };
const planHash = 'b'.repeat(64);

async function keyFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-env-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'id_test');
  await fs.writeFile(file, 'not a real key');
  return { directory, file };
}
const sshConfig = identityFile => ({
  id: 'box',
  kind: 'ssh',
  label: 'Test box',
  host: 'box.example',
  port: 2222,
  user: 'me',
  identityFile,
  workRoot: '/home/me/sf',
});

/** Unquotes one POSIX command line the way sh would for single-quoted words. */
function unquote(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') word = (word ?? '') + line[++i];
    else if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else throw new Error(`unquoted character ${c}`);
  }
  if (word !== null) words.push(word);
  return words;
}

/** A fake ssh client: records argv and answers by the remote script. */
function fakeSsh({ answer = () => ({ code: 0, stdout: '', stderr: '' }) } = {}) {
  const calls = [];
  const children = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 9000 + calls.length;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.end(null, 'SIGTERM');
    };
    // Never a real taskkill on a made-up PID.
    child.stopTree = async () => child.kill();
    child.end = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    const remote = args.at(-1);
    const call = {
      executable,
      args,
      options,
      remote,
      words: executable === 'ssh' ? unquote(remote) : null,
      rawStderr: child.stderr,
      child,
    };
    calls.push(call);
    children.push(child);
    setImmediate(() => {
      const reply = answer(call);
      if (reply === 'stay') return;
      if (reply.stdout) child.stdout.write(reply.stdout);
      if (reply.stderr) child.stderr.write(reply.stderr);
      child.end(reply.code);
    });
    return child;
  };
  return { spawnProcess, calls, children };
}

test('remote commands are single-quoted word by word; hostile text stays one word', () => {
  for (const value of ["a'b", '$(rm -rf ~)', '`id`', 'x; reboot', '"q"', 'new\nline', '', "'"])
    assert.deepEqual(unquote(shellQuote(value)), [value]);
  assert.deepEqual(unquote(remoteCommand(['echo', "it's", '$HOME', 'a b'])), ['echo', "it's", '$HOME', 'a b']);
  // Only variables the provider set or changed travel to the box; this PC's paths stay home.
  assert.deepEqual(
    remoteEnvironment({ PATH: '/x', TMPDIR: '/r/tmp', SAME: 'v', lower: 'x', NO_COLOR: '1' }, { SAME: 'v' }),
    ['TMPDIR=/r/tmp', 'NO_COLOR=1'],
  );
});

test('SSH configs are strict: absolute existing key, plain host and root, no inline secrets', async t => {
  const { file, directory } = await keyFile(t);
  const valid = validateEnvironmentConfig({ ...sshConfig(file), wake: 'wsl.exe -d Ubuntu -- true' });
  assert.deepEqual(valid.wake, ['wsl.exe', '-d', 'Ubuntu', '--', 'true']);
  assert.equal(valid.enabled, true);
  const refuse = (patch, pattern) =>
    assert.throws(() => validateEnvironmentConfig({ ...sshConfig(file), ...patch }), pattern);
  refuse({ password: 'hunter2' }, /Secrets are never stored inline/);
  refuse({ host: '-oProxyCommand=calc' }, /host/);
  refuse({ host: 'a b' }, /host/);
  refuse({ user: 'me;id' }, /user/);
  refuse({ port: 0 }, /port/);
  refuse({ identityFile: 'id_test' }, /absolute/);
  refuse({ identityFile: path.join(directory, 'missing') }, /does not exist/);
  refuse({ identityFile: directory }, /not a file/);
  refuse({ workRoot: 'relative/root' }, /workRoot/);
  refuse({ workRoot: '/home/me/../etc' }, /workRoot/);
  refuse({ workRoot: '/home/me/$(id)' }, /workRoot/);
  refuse({ wake: 'wsl.exe "-d" Ubuntu' }, /wake/);
  refuse({ wake: 'cmd /c a&b' }, /wake/);
  refuse({ id: 'local' }, /reserved/);
  refuse({ kind: 'telnet' }, /Unsupported environment kind/);
  assert.throws(() => validateSshConfig({ ...sshConfig(file), port: 22.5 }), /port/);
});

test('owner settings hold environments and placement; placement must name an enabled environment', async t => {
  const { file } = await keyFile(t);
  const base = defaultAgentSettings();
  assert.deepEqual(base.placement, { delivery: 'local', review: 'local' });
  const saved = applySettingsPatch(base, { environments: [sshConfig(file)], placement: { delivery: 'box' } });
  assert.equal(saved.placement.delivery, 'box');
  assert.equal(saved.environments[0].port, 2222);
  assert.throws(() => applySettingsPatch(base, { placement: { delivery: 'nowhere' } }), /not a configured environment/);
  assert.throws(() => applySettingsPatch(base, { placement: { execution: 'local' } }), /delivery and review/);
  assert.throws(
    () =>
      applySettingsPatch(base, {
        environments: [{ ...sshConfig(file), enabled: false }],
        placement: { review: 'box' },
      }),
    /disabled/,
  );
  // Removing a placed environment is refused rather than silently moving work to this PC.
  assert.throws(() => applySettingsPatch(saved, { environments: [] }), /not a configured environment/);
  assert.throws(() => applySettingsPatch(base, { environments: [sshConfig(file), sshConfig(file)] }), /unique/);
  assert.throws(
    () => applySettingsPatch(base, { environments: [{ ...sshConfig(file), token: 'x' }] }),
    /Environment box/,
  );
});

test('the registry builds environments from settings and refuses missing or disabled ones', async t => {
  const { file, directory } = await keyFile(t);
  const registry = new EnvironmentRegistry({ stateDir: directory });
  assert.equal(registry.get('local').kind, 'local');
  assert.equal(registry.get(undefined).capabilities.result, 'local-worktree');
  const settings = { environments: [validateEnvironmentConfig(sshConfig(file))] };
  const box = registry.get('box', settings);
  assert.equal(box.kind, 'ssh');
  assert.equal(registry.get('box', settings), box, 'cached while the config is unchanged');
  assert.deepEqual(box.capabilities, {
    stream: true,
    steer: true,
    interrupt: true,
    followUp: true,
    result: 'remote-branch',
  });
  assert.throws(() => registry.get('other', settings), /not configured/);
  assert.throws(
    () => registry.get('box', { environments: [{ ...settings.environments[0], enabled: false }] }),
    /disabled/,
  );
  assert.deepEqual(
    registry.list(settings).map(entry => entry.id),
    ['local', 'box'],
  );
  // The local environment is today's spawn, unchanged.
  const local = createLocalEnvironment();
  assert.equal(local.spawnFor(), spawn);
  assert.deepEqual(await local.health(), { ok: true, reason: null });
});

test('SSH spawn: hardened ssh argv, remote wrapper, PID fenced from stderr, stop reaches the remote group', async t => {
  const { file, directory } = await keyFile(t);
  const fake = fakeSsh({
    answer: call =>
      call.words?.includes('kill -TERM -- "-$1" 2>/dev/null; sleep 2; kill -KILL -- "-$1" 2>/dev/null; true')
        ? { code: 0 }
        : 'stay',
  });
  t.after(() => fake.children.forEach(child => child.end(0)));
  const environment = createSshEnvironment(validateEnvironmentConfig(sshConfig(file)), {
    stateDir: directory,
    spawnProcess: fake.spawnProcess,
    sshExecutable: 'ssh',
  });
  const pids = [];
  const workspace = {
    path: '/home/me/sf/worktrees/w1',
    temporaryRoot: '/home/me/sf/tmp/w1',
    name: 'w1',
    branch: 'switchflow/w1',
  };
  const spawnProcess = environment.spawnFor(workspace, { onRemoteProcess: pid => pids.push(pid) });
  const child = spawnProcess(
    'codex',
    ['app-server', '-c', 'sandbox_workspace_write.writable_roots=["/home/me/sf/worktrees/w1"]'],
    {
      cwd: 'C:\\ignored',
      env: { ...process.env, TMPDIR: workspace.temporaryRoot, EVIL: "x'; rm -rf / #" },
    },
  );
  const [call] = fake.calls;
  const args = call.args;
  for (const option of [
    'BatchMode=yes',
    'StrictHostKeyChecking=accept-new',
    'IdentitiesOnly=yes',
    'ConnectTimeout=10',
    'ServerAliveInterval=15',
  ])
    assert.ok(args.includes(option), option);
  assert.deepEqual(args.slice(0, 2), ['-F', 'none']);
  assert.ok(args.some(arg => arg.startsWith('UserKnownHostsFile=') && arg.includes('box.known_hosts')));
  assert.deepEqual(args.slice(-7, -2), ['-p', '2222', '-l', 'me', '--']);
  assert.equal(args.at(-2), 'box.example');
  assert.equal(call.options.cwd, undefined, 'the Windows cwd never reaches ssh');
  const words = call.words;
  assert.deepEqual(words.slice(0, 2), ['sh', '-c']);
  assert.equal(words[5], workspace.path);
  assert.match(words[4], /^\/home\/me\/sf\/run\/w1-[0-9a-f]+\.pid$/);
  assert.equal(words[6], 'env');
  assert.ok(words.includes(`TMPDIR=${workspace.temporaryRoot}`));
  assert.ok(words.includes("EVIL=x'; rm -rf / #"), 'hostile values stay one word');
  assert.ok(!words.some(word => word.startsWith('PATH=')));
  assert.deepEqual(words.slice(-4), [
    'codex',
    'app-server',
    '-c',
    'sandbox_workspace_write.writable_roots=["/home/me/sf/worktrees/w1"]',
  ]);

  // The wrapper's PID line is reported and removed from the agent's stderr.
  const seen = [];
  child.stderr.on('data', chunk => seen.push(String(chunk)));
  call.rawStderr.write('warming up\nSWITCHFLOW_REMOTE_PID 4321\nreal error\n');
  await until(() => pids.length === 1 && seen.join('').includes('real error'));
  assert.deepEqual(pids, [4321]);
  assert.equal(child.remotePid, 4321);
  assert.doesNotMatch(seen.join(''), /SWITCHFLOW_REMOTE_PID/);

  // stopTree (used by every provider) kills the remote process group over a second connection.
  await stopTree(child);
  const kill = fake.calls[1];
  assert.equal(kill.words.at(-1), '4321');
  assert.ok(call.child.killed, 'the local ssh client is stopped too');
});

test('keepAwake holds the box up while agents run and stops with the last one', async t => {
  const { file, directory } = await keyFile(t);
  const fake = fakeSsh({ answer: call => (call.executable === 'wsl.exe' ? 'stay' : 'stay') });
  t.after(() => fake.children.forEach(child => child.end(0)));
  const environment = createSshEnvironment(
    validateEnvironmentConfig({ ...sshConfig(file), keepAwake: 'wsl.exe -d Ubuntu -- sleep infinity' }),
    { stateDir: directory, spawnProcess: fake.spawnProcess, sshExecutable: 'ssh' },
  );
  const workspace = { path: '/home/me/sf/worktrees/w', temporaryRoot: '/home/me/sf/tmp/w', name: 'w' };
  const spawnAgent = environment.spawnFor(workspace);
  const keepers = () => fake.calls.filter(call => call.executable === 'wsl.exe');
  const first = spawnAgent('codex', ['app-server'], {});
  assert.equal(keepers().length, 1);
  const second = spawnAgent('codex', ['app-server'], {});
  assert.equal(keepers().length, 1, 'one keeper for all sessions');
  first.end(0);
  await until(() => !keepers()[0].child.killed && true);
  second.end(0);
  // Its tree is stopped once the last agent process closes (stopTree; the fake records kill()).
  await until(
    () => keepers()[0].child.exitCode !== null || keepers()[0].child.signalCode !== null || keepers()[0].child.killed,
  );
  // A new session starts a new keeper; the old one's late close must not forget it.
  const third = spawnAgent('codex', ['app-server'], {});
  assert.equal(keepers().length, 2);
  keepers()[0].child.end(0);
  third.end(0);
  await until(() => keepers()[1].child.killed || keepers()[1].child.exitCode !== null);
});

test('SSH health parses the box report and never claims an unreachable box is fine', async t => {
  const { file, directory } = await keyFile(t);
  const report = [
    'git=git version 2.53.0',
    'node=v22.22.1',
    'setsid=/usr/bin/setsid',
    'codex=codex-cli 0.160.0',
    'codexLogin=yes',
    'claude=2.1.288 (Claude Code)',
    'claudeAuth={"loggedIn": true, "authMethod": "claude.ai"}',
    'workRoot=ok',
  ].join('\n');
  const healthy = parseHealth(report);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.providers.claude.version, '2.1.288');
  assert.equal(healthy.providers.codex.available, true);
  const signedOut = parseHealth(report.replace('codexLogin=yes', 'codexLogin=no').replace('true', 'false'));
  assert.equal(signedOut.ok, false);
  assert.match(signedOut.reason, /signed-in codex or claude/);
  const wakes = [];
  const fake = fakeSsh({
    answer: call => {
      if (call.executable === 'wsl.exe') {
        wakes.push(call.args);
        return { code: 0 };
      }
      return { code: 255, stderr: 'ssh: connect to host box.example port 2222: Connection refused\n' };
    },
  });
  const environment = createSshEnvironment(
    validateEnvironmentConfig({ ...sshConfig(file), wake: 'wsl.exe -d Ubuntu -- true' }),
    { stateDir: directory, spawnProcess: fake.spawnProcess, sshExecutable: 'ssh' },
  );
  const health = await environment.health();
  assert.equal(health.ok, false);
  assert.match(health.reason, /Connection refused/);
  assert.deepEqual(wakes, [['-d', 'Ubuntu', '--', 'true']]);
});

/** An interactive environment double for orchestration tests. */
function fakeEnvironment({ healthy = true } = {}) {
  const calls = [];
  return {
    calls,
    factory: config => ({
      id: config.id,
      kind: 'ssh',
      label: config.label,
      capabilities: { stream: true, steer: true, interrupt: true, followUp: true, result: 'remote-branch' },
      executables: { codex: 'codex', claude: 'claude' },
      async health() {
        calls.push(['health']);
        return healthy
          ? {
              ok: true,
              reason: null,
              providers: { codex: { available: true }, claude: { available: true, loggedIn: true } },
            }
          : { ok: false, reason: 'Connection refused.' };
      },
      async prepareWorkspace(input) {
        calls.push(['prepare', input]);
        return {
          path: `/box/worktrees/${input.name}`,
          temporaryRoot: `/box/tmp/${input.name}`,
          writableRoots: [`/box/worktrees/${input.name}`],
          name: input.name,
          branch: `switchflow/${input.name}`,
          local: false,
        };
      },
      spawnFor(workspace) {
        calls.push(['spawnFor', workspace.path]);
        return () => {
          throw new Error('fake providers do not spawn');
        };
      },
      async collect(workspace, options) {
        calls.push(['collect', workspace.path, options.into]);
        return { changed: true, head: 'c'.repeat(40) };
      },
      async cleanup(workspace) {
        calls.push(['cleanup', workspace.path]);
      },
    }),
  };
}

function respond(text, options, sandbox) {
  return {
    task: 'DEMO-1',
    outcome: sandbox === 'read-only' ? 'approach' : 'handoff',
    approach: 'a / b / c',
    head: '',
    envelope: 'task: DEMO-1',
    summary: 'done',
    blockers: [],
  };
}

async function orchestrationWith(context, t, environmentDouble, placement = 'box') {
  const { file } = await keyFile(t);
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
    providers: { codex: fakeProvider('codex', log, respond), claude: fakeProvider('claude', log, respond) },
    capacity: { pool: roomyPool() },
    environments: { factories: { ssh: environmentDouble.factory } },
  });
  await host.init();
  await host.updateSettings({ environments: [sshConfig(file)], placement: { delivery: placement } });
  const runId = randomUUID();
  const controller = new AbortController();
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
    signal: controller.signal,
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
  return { host, log, orchestration, candidate: real, controller };
}

test('placement runs a delivery worker on the SSH environment; the gate holds and results are collected', t =>
  fixture(async context => {
    const box = fakeEnvironment();
    const { host, log, orchestration, candidate } = await orchestrationWith(context, t, box);
    const call = (tool, args) => orchestration.call(tool, args);
    const delivered = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'Make the change.',
      worktree: 'cand',
    });
    assert.equal(delivered.environment, 'box');
    const session = log.at(-1);
    const remotePath = box.calls.find(([kind]) => kind === 'prepare')[1];
    assert.equal(remotePath.repo, candidate);
    assert.match(session.options.cwd, /^\/box\/worktrees\/DEMO-1-deliver-/);
    assert.deepEqual(session.options.writableRoots, [session.options.cwd]);
    assert.match(session.options.temporaryRoot, /^\/box\/tmp\//);
    assert.equal(typeof session.options.spawnProcess, 'function');
    assert.equal(session.options.executable, 'codex');
    assert.equal(session.options.mcpServers, undefined, 'no loopback lease server on the box');
    assert.equal(session.options.gitHelperPath, undefined);
    assert.match(session.prompt, /remote environment "Test box"/);
    assert.match(session.prompt, /do not commit/);
    assert.equal((await host.registry.find(delivered.workerId)).environment, 'box');

    // Approach turn stays read-only and collects nothing.
    assert.equal(session.turns[0].sandbox, 'read-only');
    await until(() => session.handle.activeTurnId);
    session.handle.finish('approach');
    await call('wait_for_workers', { workerIds: [delivered.workerId], timeoutSeconds: 5 });
    assert.ok(!box.calls.some(([kind]) => kind === 'collect'));

    // Confirmed: the writable turn's result is collected into the local candidate.
    await call('send_to_worker', { workerId: delivered.workerId, message: 'Go. FINISH-NOW', confirm: true });
    const waited = await call('wait_for_workers', { workerIds: [delivered.workerId], timeoutSeconds: 5 });
    assert.equal(waited.workers[0].collected.head, 'c'.repeat(40));
    const collect = box.calls.find(([kind]) => kind === 'collect');
    assert.equal(collect[2], candidate);
    const events = await host.events(delivered.workerId, 0, 200);
    assert.ok(events.events.some(event => /Collected the remote work/.test(event.text || '')));

    // Finishing removes the remote worktree.
    await orchestration.finishWorker(orchestration.workers.get(delivered.workerId), 'completed');
    await until(() => box.calls.some(([kind]) => kind === 'cleanup'));
  }));

test('an unhealthy or unknown environment is refused with its reason, never replaced by this PC', t =>
  fixture(async context => {
    const box = fakeEnvironment({ healthy: false });
    const { log, orchestration } = await orchestrationWith(context, t, box);
    const call = (tool, args) => orchestration.call(tool, args);
    await assert.rejects(
      call('delegate_task', { task: 'DEMO-1', kind: 'deliver', instructions: 'x', worktree: 'cand' }),
      error =>
        error.status === 409 && /box is unavailable: Connection refused\..*does not fall back/.test(error.message),
    );
    await assert.rejects(
      call('delegate_task', {
        task: 'DEMO-1',
        kind: 'deliver',
        instructions: 'x',
        worktree: 'cand',
        environment: 'elsewhere',
      }),
      error => error.status === 409 && /not configured/.test(error.message),
    );
    assert.equal(log.length, 0, 'no session opened anywhere');
    // The orchestrator may still choose this PC explicitly.
    const local = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'x',
      worktree: 'cand',
      environment: 'local',
    });
    assert.equal(local.environment, 'local');
    assert.equal(log.at(-1).options.spawnProcess, undefined);
  }));
