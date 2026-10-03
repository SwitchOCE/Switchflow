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
import { ControlEngine } from '../template/.switchflow/scripts/control/engine.mjs';
import { createInitiative } from '../template/.switchflow/scripts/control/lifecycle.mjs';
import * as protocol from '../template/.switchflow/scripts/control/agent-protocol.mjs';
import { CAPACITY_CONFIG } from '../template/.switchflow/scripts/control/capacity.mjs';
import { composeProjectName, defaultRunner } from '../template/.switchflow/scripts/control/worker-resources.mjs';
import { fakeMachine, fakeProvider, fixture, roomyPool, until } from './agent-fakes.mjs';

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
  refuse({ maxWorkers: 0 }, /maxWorkers/);
  refuse({ maxWorkers: 1.5 }, /maxWorkers/);
  assert.equal(validateEnvironmentConfig({ ...sshConfig(file), maxWorkers: 3 }).maxWorkers, 3);
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
  // Codex cloud cannot hold the approach gate, so it takes reviews but never delivery placement.
  const codexCloud = {
    id: 'codex',
    kind: 'codex-cloud',
    environmentId: 'env-test',
    repository: 'https://github.com/example/project',
    push: true,
    experimental: true,
  };
  assert.equal(
    applySettingsPatch(base, { environments: [codexCloud], placement: { review: 'codex' } }).placement.review,
    'codex',
  );
  assert.throws(
    () => applySettingsPatch(base, { environments: [codexCloud], placement: { delivery: 'codex' } }),
    /reviews only/,
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
  const projects = [];
  return {
    calls,
    factory: config => ({
      id: config.id,
      kind: 'ssh',
      label: config.label,
      maxWorkers: config.maxWorkers ?? 2,
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
      // The box's docker: lists the projects the test says are up there.
      async exec(argv) {
        calls.push(['exec', argv]);
        if (argv.join(' ') === 'docker compose ls --all --quiet')
          return { code: 0, stdout: `${projects.join('\n')}\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
    projects,
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

async function orchestrationWith(
  context,
  t,
  environmentDouble,
  placement = 'box',
  { config = {}, pool = roomyPool(), resources = {}, entries = [] } = {},
) {
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
    capacity: { pool },
    environments: { factories: { ssh: environmentDouble.factory }, entries },
    resources,
  });
  await host.init();
  await host.updateSettings({ environments: [{ ...sshConfig(file), ...config }], placement: { delivery: placement } });
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

test('SSH workers skip memory admission and queue against their box limit, not this PC', t =>
  fixture(async context => {
    const box = fakeEnvironment();
    // No free memory here: a local worker would wait (or start with a warning); box workers do not.
    const machine = fakeMachine({ free: 0 });
    const { log, orchestration } = await orchestrationWith(context, t, box, 'box', {
      config: { maxWorkers: 1 },
      pool: machine.pool,
    });
    const delegate = environment =>
      orchestration.call('delegate_task', {
        task: 'DEMO-1',
        kind: 'deliver',
        instructions: 'x',
        worktree: 'cand',
        ...(environment ? { environment } : {}),
      });
    const first = await delegate();
    assert.equal(first.status, 'working');
    assert.equal(first.capacityNote, undefined, 'no memory warning for a box worker');
    assert.equal(machine.pool.snapshot(0).reservations, 0, 'nothing reserved on this PC');
    const firstSession = log.at(-1);

    const second = await delegate();
    assert.equal(second.status, 'queued');
    assert.match(second.queue.reason, /1 worker is running on Test box, its limit \(maxWorkers\)/);

    // The full box does not hold up this PC.
    const local = await delegate('local');
    assert.notEqual(local.status, 'queued');
    assert.equal(local.environment, 'local');

    // The box worker's approach turn ends: its slot frees and the queued one starts there.
    await until(() => firstSession.handle.activeTurnId);
    firstSession.handle.finish('approach');
    await until(() => orchestration.workers.get(second.workerId).status === 'working');
    assert.equal(orchestration.workers.get(second.workerId).environment.id, 'box');
  }));

test('a remote PID fences a restart even after its ssh client is gone, until the owner confirms', t =>
  fixture(async context => {
    const { file, directory } = await keyFile(t);
    const fake = fakeSsh({
      answer: call => (call.words?.some(word => word.includes('kill -TERM')) ? { code: 0 } : 'stay'),
    });
    t.after(() => fake.children.forEach(child => child.end(0)));
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
    const engine = new ControlEngine(context, { protocol, runner: async () => assert.fail('no run') });
    t.after(() => engine.close());
    const host = new AgentHost(context, {
      capabilities: both,
      capacity: { pool: roomyPool() },
      environments: {
        factories: {
          ssh: (config, deps) =>
            createSshEnvironment(config, {
              ...deps,
              stateDir: directory,
              spawnProcess: fake.spawnProcess,
              sshExecutable: 'ssh',
            }),
        },
      },
      providers: {
        // Spawns its CLI through the environment as the real providers do; the box wrapper
        // reports the remote PID on stderr.
        codex: async options => {
          options.spawnProcess('codex', ['app-server'], { env: {} });
          fake.calls.at(-1).rawStderr.write('SWITCHFLOW_REMOTE_PID 4321\n');
          return fakeProvider('codex')(options);
        },
      },
    });
    await host.init();
    t.after(() => host.close());
    await host.updateSettings({ environments: [sshConfig(file)] });
    host.bind(engine);
    await host.openSession({
      provider: 'codex',
      role: 'delivery',
      kind: 'deliver',
      runId,
      initiativeId: item.id,
      task: 'DEMO-1',
      cwd: '/home/me/sf/worktrees/w1',
      sandbox: 'workspace-write',
      runDirectory: path.join(context.stateDir, 'runs', runId),
      environment: 'box',
      workspace: { path: '/home/me/sf/worktrees/w1', temporaryRoot: '/home/me/sf/tmp/w1', name: 'w1' },
    });
    const [entry] = await until(async () => {
      const workers = (await engine.read()).activeRun.workers ?? [];
      return workers[0]?.remotePid ? workers : null;
    });
    assert.equal(entry.environment, 'box');
    assert.equal(entry.remotePid, 4321);

    // Restart: the local ssh client (4242) is gone, but the box may still run the agent.
    const restarted = new ControlEngine(context, {
      protocol,
      runner: async () => assert.fail('no run'),
      processAlive: () => false,
      stopProcess: async () => assert.fail('a remote process is never stopped through a local PID'),
    });
    t.after(() => restarted.close());
    await restarted.recover();
    let state = await restarted.read();
    assert.equal(state.activeRun.status, 'interrupted');
    const held = state.activeRun.held.find(process => process.kind === 'deliver');
    assert.deepEqual([held.state, held.environment, held.remotePid, held.pid], ['remote', 'box', 4321, 4242]);
    assert.equal(state.activeRun.unknownProcess, true);
    assert.match(state.initiatives[0].nextAction, /on box, remote process group 4321/);
    assert.match(state.initiatives[0].nextAction, /could not confirm/);

    // Stop finds nothing verified to stop on this PC, so the hold stays and other actions are refused.
    await restarted.action(item.id, { action: 'stop-processes', expectedRevision: state.initiatives[0].revision });
    state = await restarted.read();
    assert.equal(state.activeRun.status, 'interrupted');
    await assert.rejects(
      restarted.action(item.id, { action: 'retry', expectedRevision: state.initiatives[0].revision }),
      /Confirm the unidentified prior process has stopped/,
    );
    await restarted.action(item.id, {
      action: 'recover-run',
      confirmedStopped: true,
      expectedRevision: state.initiatives[0].revision,
    });
    assert.equal((await restarted.read()).activeRun, null);
  }));

test('an environment declares its own leases (no gating), and the host runs commands on the box quoted', async t => {
  const { file, directory } = await keyFile(t);
  const valid = validateEnvironmentConfig({
    ...sshConfig(file),
    leases: { gate: 1, 'e2e-stack': { count: 2, maxMinutes: 90 } },
  });
  assert.deepEqual(valid.leases, { gate: { count: 1, maxMinutes: 120 }, 'e2e-stack': { count: 2, maxMinutes: 90 } });
  assert.throws(
    () => validateEnvironmentConfig({ ...sshConfig(file), leases: { gate: { count: 1, gating: true } } }),
    /unsupported field leases\.gate\.gating \(gating reserves this PC's memory\)/,
  );
  assert.throws(() => validateEnvironmentConfig({ ...sshConfig(file), leases: { Gate: 1 } }), /lease name "Gate"/);

  // Compose cleanup runs where the worker ran: on the box through exec, from /.
  const fake = fakeSsh({ answer: () => ({ code: 0, stdout: 'sf-0123abcd\n', stderr: '' }) });
  const environment = createSshEnvironment(sshConfig(file), {
    stateDir: directory,
    spawnProcess: fake.spawnProcess,
    sshExecutable: 'ssh',
  });
  const result = await defaultRunner(['docker', 'compose', 'ls', '--all', '--quiet'], { environment });
  assert.deepEqual(result, { code: 0, stdout: 'sf-0123abcd\n', stderr: '' });
  assert.deepEqual(fake.calls.at(-1).words, [
    'sh',
    '-c',
    'cd / && exec "$@"',
    'switchflow',
    'docker',
    'compose',
    'ls',
    '--all',
    '--quiet',
  ]);
  // A cloud environment has no command runner: nothing runs anywhere.
  assert.equal((await defaultRunner(['docker'], { environment: { id: 'cloud', kind: 'claude-cloud' } })).code, -1);
});

test('box workers get the box’s own port blocks and lease pool, and their compose project is stopped on the box', t =>
  fixture(async context => {
    const profile = path.join(context.governanceRoot, ...CAPACITY_CONFIG.split('/'));
    await fs.mkdir(path.dirname(profile), { recursive: true });
    await fs.writeFile(
      profile,
      JSON.stringify({
        schemaVersion: 1,
        ports: { base: 42000, blockSize: 5, blocks: 2 },
        docker: { composeDown: true },
      }),
    );
    const box = fakeEnvironment();
    const local = [];
    const { host, log, orchestration } = await orchestrationWith(context, t, box, 'box', {
      config: { leases: { gate: 1 } },
      resources: {
        // Never real docker: this PC's runs are recorded, the box's go through its exec.
        run: (argv, options) =>
          options.environment?.kind === 'ssh'
            ? defaultRunner(argv, options)
            : (local.push(argv), { code: -1, stdout: '', stderr: 'not installed' }),
      },
    });
    const call = (tool, args) => orchestration.call(tool, args);
    const delegate = (task, extra = {}) =>
      call('delegate_task', { task, kind: 'deliver', instructions: 'x', worktree: 'cand', ...extra });
    const envOf = workerId => log.find(entry => entry.options.id === workerId).options.env;

    const onBox = await delegate('DEMO-1', { leases: ['gate'] });
    assert.deepEqual([onBox.status, onBox.environment], ['working', 'box']);
    assert.equal(envOf(onBox.workerId).SWITCHFLOW_PORT_BASE, '42000');
    assert.equal(envOf(onBox.workerId).COMPOSE_PROJECT_NAME, composeProjectName(onBox.workerId));
    // This PC has its own blocks and its own gate lease.
    const here = await delegate('DEMO-2', { environment: 'local', leases: ['gate'] });
    assert.deepEqual([here.status, here.environment], ['working', 'local']);
    assert.equal(envOf(here.workerId).SWITCHFLOW_PORT_BASE, '42000');

    const waiting = await delegate('DEMO-3', { leases: ['gate'] });
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.queue.reason, 'gate on box: 1 of 1 held by DEMO-1 deliver worker, 120 min left');
    assert.equal(
      host.resources.records.filter(entry => entry.environment === 'box').length,
      1,
      'its port block went back while it waits',
    );
    await assert.rejects(
      delegate('DEMO-4', { leases: ['e2e'] }),
      error =>
        error.status === 404 && /Unknown lease "e2e" on environment box\. It declares: gate\./.test(error.message),
    );
    const listed = await call('list_leases', {});
    assert.deepEqual(listed.environments, [
      { id: 'box', resources: [{ name: 'gate', count: 1, maxMinutes: 120, held: 1 }] },
    ]);
    assert.deepEqual(listed.leases.map(lease => [lease.name, lease.environment, lease.task]).sort(), [
      ['gate', 'box', 'DEMO-1'],
      ['gate', 'local', 'DEMO-2'],
    ]);

    // The box worker brought a stack up; its session end stops it there and frees the box's lease.
    box.projects.push(composeProjectName(onBox.workerId), 'other-project');
    await orchestration.finishWorker(orchestration.workers.get(onBox.workerId), 'completed');
    assert.deepEqual(
      box.calls.filter(([kind, argv]) => kind === 'exec' && argv.includes('down')).map(([, argv]) => argv),
      [['docker', 'compose', '-p', composeProjectName(onBox.workerId), 'down', '--remove-orphans']],
    );
    const events = (await host.events(onBox.workerId, 0, 500)).events;
    assert.ok(
      events.some(event => /^Stopped Docker Compose project sf-[0-9a-f]{8} on Test box/.test(event.text || '')),
    );
    assert.deepEqual(local, [], 'nothing ran on this PC for a box worker');
    await until(() => orchestration.workers.get(waiting.workerId).status === 'working');
    assert.equal(envOf(waiting.workerId).SWITCHFLOW_PORT_BASE, '42000');
  }));

test('a cloud worker that names leases waits for them before it is submitted', t =>
  fixture(async context => {
    const opened = [];
    const cloud = {
      id: 'cloud',
      kind: 'claude-cloud',
      label: 'Cloud',
      provider: 'claude',
      remote: true,
      capabilities: { stream: false, steer: true, interrupt: false, followUp: true, result: 'remote-branch' },
      config: { leases: { 'staging-db': { count: 1, maxMinutes: 60 } } },
      health: async () => ({ ok: true }),
      openSession: async () => {
        let fail = () => {};
        const handle = {
          provider: 'claude',
          canSteer: false,
          activeTurnId: null,
          closed: false,
          startTurn: () => new Promise((resolve, reject) => (fail = reject)),
          close: async () => {
            handle.closed = true;
            fail(new Error('closed'));
          },
        };
        opened.push(handle);
        return handle;
      },
    };
    const { orchestration } = await orchestrationWith(context, t, fakeEnvironment(), 'box', { entries: [cloud] });
    const delegate = task =>
      orchestration.call('delegate_task', {
        task,
        kind: 'deliver',
        instructions: 'x',
        worktree: 'cand',
        environment: 'cloud',
        leases: ['staging-db'],
      });
    const first = await delegate('DEMO-1');
    assert.equal(first.status, 'working');
    const second = await delegate('DEMO-2');
    assert.equal(second.status, 'queued');
    assert.equal(second.queue.reason, 'staging-db on cloud: 1 of 1 held by DEMO-1 deliver worker, 60 min left');
    assert.equal(opened.length, 1, 'not submitted while it waits');
    await orchestration.finishWorker(orchestration.workers.get(first.workerId), 'completed');
    await until(() => orchestration.workers.get(second.workerId).status === 'working');
    assert.equal(opened.length, 2);
  }));
