import './git-test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  ensureRuntime,
  parseArgs,
  serviceVersion,
} from '../template/.switchflow/scripts/control/launch.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { canonicalProject } from '../template/.switchflow/scripts/control/projects.mjs';

const scripts = fileURLToPath(new URL('../template/.switchflow/scripts/', import.meta.url));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });

async function makeProject(root, name = 'Alpha') {
  await fs.mkdir(path.join(root, '.switchflow'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.switchflow', 'project.json'),
    JSON.stringify({ schemaVersion: 1, projectName: name, templateVersion: '0.5.0' }),
  );
  await fs.writeFile(path.join(root, 'backlog.config.yml'), `project_name: ${name}\n`);
  git(root, 'init', '-b', 'main');
  git(root, 'add', '--', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Initial');
  return root;
}

// A plugin folder like the one Claude Code installs: <plugin>/.claude-plugin/plugin.json and <plugin>/service.
async function makePlugin(base, version) {
  const plugin = path.join(base, `plugin-${version}`);
  await fs.cp(scripts, path.join(plugin, 'service'), {
    recursive: true,
    filter: source => !source.split(path.sep).includes('node_modules'),
  });
  await fs.mkdir(path.join(plugin, '.claude-plugin'));
  await fs.writeFile(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'switchflow', version }),
  );
  return path.join(plugin, 'service', 'control', 'launch.mjs');
}

async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-launch-'));
  const home = path.join(base, 'home');
  const data = path.join(base, 'data');
  const env = { ...process.env, SWITCHFLOW_HOME: home };
  const pids = new Set();
  const launch = (launcher, ...args) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      execFile(
        process.execPath,
        [launcher, '--data', data, ...args],
        { env, encoding: 'utf8', windowsHide: true, timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          const lines = stdout.trim().split(/\r?\n/);
          assert.equal(lines.length, 1, stdout);
          resolve({ ...JSON.parse(lines[0]), elapsedMs: Date.now() - started });
        },
      );
    });
  const health = async url => {
    const value = await (await fetch(url + '/api/health')).json();
    pids.add(value.pid);
    return value;
  };
  try {
    await run({ base, home, data, env, launch, health, pids });
  } finally {
    try {
      pids.add(JSON.parse(await fs.readFile(path.join(home, 'control-service', 'service-info.json'), 'utf8')).pid);
    } catch {
      // No service was started.
    }
    pids.delete(process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // Already stopped.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

test('versions compare semantically and the launcher reads the plugin manifest first', async () => {
  assert.equal(compareVersions('0.7.0-alpha.1', '0.7.0'), -1);
  assert.equal(compareVersions('0.7.0-alpha.2', '0.7.0-alpha.10'), -1);
  assert.equal(compareVersions('0.7.0', '0.6.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions(undefined, '0.5.0'), -1);
  assert.equal(compareVersions('0.5.0', null), 1);
  assert.equal(serviceVersion(scripts), (await fs.readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim());
  const plugin = fileURLToPath(new URL('../plugin/', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(serviceVersion(path.join(plugin, 'service')), manifest.version);
  assert.deepEqual(parseArgs(['--data', 'd', '--project', '${CLAUDE_PROJECT_DIR}', '--upgrade-if-idle']), {
    data: 'd',
    upgradeIfIdle: true,
  });
  assert.throws(() => parseArgs(['--project', 'p']), /Usage/);
});

test('racing launchers copy the runtime once and both use the complete copy', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-runtime-'));
  try {
    const plugin = path.join(base, 'plugin');
    await fs.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"version":"2.0.0-beta.1"}');
    await fs.cp(scripts, path.join(plugin, 'service'), {
      recursive: true,
      filter: source => !source.split(path.sep).includes('node_modules'),
    });
    await fs.mkdir(path.join(plugin, 'node_modules', 'backlog.md'), { recursive: true });
    await fs.writeFile(path.join(plugin, 'node_modules', 'backlog.md', 'cli.js'), '// cli\n');
    const data = path.join(base, 'data');
    const serviceRoot = path.join(plugin, 'service');
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureRuntime({ dataDir: data, serviceRoot })));
    const target = path.join(data, 'runtime', '2.0.0-beta.1');
    assert.deepEqual(new Set(results), new Set([target]));
    assert.deepEqual(await fs.readdir(path.join(data, 'runtime')), ['2.0.0-beta.1']);
    assert.equal((await fs.readFile(path.join(target, 'VERSION'), 'utf8')).trim(), '2.0.0-beta.1');
    assert.equal(serviceVersion(target), '2.0.0-beta.1');
    await fs.access(path.join(target, 'control', 'server.mjs'));
    await fs.access(path.join(target, 'control', 'launch.mjs'));
    assert.equal(await fs.readFile(path.join(target, 'node_modules', 'backlog.md', 'cli.js'), 'utf8'), '// cli\n');

    // A copy taken before the plugin's dependency install finished gains node_modules later.
    await fs.rm(path.join(target, 'node_modules'), { recursive: true });
    await Promise.all([ensureRuntime({ dataDir: data, serviceRoot }), ensureRuntime({ dataDir: data, serviceRoot })]);
    await fs.access(path.join(target, 'node_modules', 'backlog.md', 'cli.js'));
    assert.deepEqual(await fs.readdir(target).then(names => names.filter(name => name.startsWith('.tmp-'))), []);
  } finally {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('the launcher starts the service, reuses it, and upgrades it when idle', () =>
  fixture(async ({ base, data, launch, health }) => {
    const project = await makeProject(path.join(base, 'Alpha'));
    const first = await makePlugin(base, '1.0.0');
    const started = await launch(first, '--project', project, '--upgrade-if-idle');
    assert.equal(started.status, 'started');
    assert.equal(started.version, '1.0.0');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(started.projectId, /^[a-f0-9]{64}$/);
    const firstHealth = await health(started.url);
    assert.equal(firstHealth.version, '1.0.0');
    assert.equal(firstHealth.codeRoot, path.join(data, 'runtime', '1.0.0'));

    const reused = await launch(first, '--project', project, '--upgrade-if-idle');
    assert.equal(reused.status, 'running');
    assert.equal(reused.url, started.url);
    assert.equal(reused.projectId, started.projectId);
    // Reuse starts nothing: the same process still answers. (No time limit: a loaded machine
    // makes any wall-clock bound flaky.)
    assert.equal((await health(started.url)).pid, firstHealth.pid);

    // An older plugin never replaces a newer service, and without the flag nothing is stopped.
    const second = await makePlugin(base, '1.1.0');
    const offered = await launch(second);
    assert.equal(offered.status, 'running');
    assert.equal(offered.update, '1.1.0');
    assert.equal((await health(offered.url)).pid, firstHealth.pid);

    const upgraded = await launch(second, '--project', project, '--upgrade-if-idle');
    assert.equal(upgraded.status, 'upgraded');
    assert.equal(upgraded.version, '1.1.0');
    assert.equal(upgraded.projectId, started.projectId);
    const secondHealth = await health(upgraded.url);
    assert.notEqual(secondHealth.pid, firstHealth.pid);
    assert.equal(alive(firstHealth.pid), false);
    assert.equal(secondHealth.codeRoot, path.join(data, 'runtime', '1.1.0'));
    assert.deepEqual(secondHealth.projectIds, [started.projectId]);

    const older = await launch(first, '--project', project, '--upgrade-if-idle');
    assert.equal(older.status, 'running');
    assert.equal(older.version, '1.1.0');
    assert.equal(older.update, undefined);
  }));

test('a launcher outside any Switchflow project starts from a registered one, or reports nothing to start', () =>
  fixture(async ({ base, launch, health }) => {
    const launcher = await makePlugin(base, '1.0.0');
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain);
    const idle = await launch(launcher, '--project', plain);
    assert.equal(idle.status, 'not-running');

    const project = await makeProject(path.join(base, 'Alpha'));
    const [one, two] = await Promise.all([
      launch(launcher, '--project', project),
      launch(launcher, '--project', project),
    ]);
    assert.equal(one.url, two.url);
    const { pid } = await health(one.url);
    // The losing service gives up on the shared lock after a second; let it go first.
    await new Promise(resolve => setTimeout(resolve, 1500));
    process.kill(pid);
    while (alive(pid)) await new Promise(resolve => setTimeout(resolve, 50));

    const restarted = await launch(launcher, '--project', plain);
    assert.equal(restarted.status, 'started');
    assert.equal(restarted.projectId, undefined);
    assert.deepEqual((await health(restarted.url)).projectIds, [one.projectId]);
  }));

test('the launcher leaves an older busy service running and reports update-ready', () =>
  fixture(async ({ base, home, launch }) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url} ${req.headers['x-switchflow-token'] || ''}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/health')
        return res.end(
          JSON.stringify({ service: 'switchflow-control', apiVersion: 2, mode: 'multi-project', pid: process.pid }),
        );
      if (req.url === '/api/projects') return res.end(JSON.stringify({ csrfToken: 'token' }));
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'A run is active.', activeRuns: [{ projectId: 'p', runId: 'r' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      await fs.mkdir(path.join(home, 'control-service'), { recursive: true });
      await fs.writeFile(
        path.join(home, 'control-service', 'service-info.json'),
        JSON.stringify({ pid: process.pid, url, apiVersion: 2 }),
      );
      const result = await launch(await makePlugin(base, '1.0.0'), '--upgrade-if-idle');
      assert.equal(result.status, 'update-ready');
      assert.equal(result.url, url);
      assert.equal(result.version, null);
      assert.equal(result.update, '1.0.0');
      assert.deepEqual(result.activeRuns, [{ projectId: 'p', runId: 'r' }]);
      assert.ok(calls.includes('POST /api/shutdown token'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }));

test('POST /api/shutdown needs the page token and refuses while a run is active when ifIdle is set', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-shutdown-'));
  const root = await makeProject(path.join(base, 'Alpha'));
  const context = await canonicalProject(root, { stateDir: path.join(base, 'state', 'control-service') });
  const stops = [];
  const app = await createControlServer({
    context,
    capabilities: { codex: false },
    backlog: { list: async () => [], view: async () => null },
    nativeFactory: () => ({ request: async () => ({ status: 404, headers: {}, body: Buffer.from('{}') }), close() {} }),
    runner: async () => {
      throw new Error('No real agent in fixture');
    },
    onShutdown: () => stops.push(Date.now()),
  });
  try {
    const shutdown = (input, token) =>
      fetch(app.url + '/api/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Switchflow-Token': token } : {}) },
        body: JSON.stringify(input),
      });
    const health = await (await fetch(app.url + '/api/health')).json();
    assert.equal(health.codeRoot, scripts.replace(/[\\/]$/, ''));
    assert.equal(health.version, serviceVersion(scripts));
    assert.equal((await shutdown({ ifIdle: true })).status, 403);
    assert.equal((await shutdown({ ifIdle: true }, 'f'.repeat(64))).status, 403);
    const { csrfToken } = await (await fetch(app.url + '/api/projects')).json();
    assert.equal((await shutdown({ ifIdle: 'yes' }, csrfToken)).status, 400);
    assert.equal((await shutdown({ force: true }, csrfToken)).status, 400);

    const engine = app.projects.get(context.id).engine;
    await engine.mutate(state => {
      state.activeRun = { id: 'run-1', initiativeId: 'init-1', stage: 'intake', status: 'running' };
    });
    const busy = await shutdown({ ifIdle: true }, csrfToken);
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()).activeRuns, [
      { projectId: context.id, projectName: 'Alpha', runId: 'run-1', initiativeId: 'init-1', stage: 'intake' },
    ]);
    assert.equal(stops.length, 0);

    // Without ifIdle the owner asked to stop regardless.
    const forced = await shutdown({}, csrfToken);
    assert.equal(forced.status, 202);
    assert.equal((await forced.json()).stopping, true);
    while (!stops.length) await new Promise(resolve => setTimeout(resolve, 10));

    await engine.mutate(state => {
      state.activeRun = null;
    });
    assert.equal((await shutdown({ ifIdle: true }, csrfToken)).status, 202);
    while (stops.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    await app.close();
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('POST /api/shutdown without a handler closes the server', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-shutdown-'));
  const root = await makeProject(path.join(base, 'Alpha'));
  const context = await canonicalProject(root, { stateDir: path.join(base, 'state', 'control-service') });
  const app = await createControlServer({
    context,
    capabilities: { codex: false },
    backlog: { list: async () => [], view: async () => null },
    nativeFactory: () => ({ request: async () => ({ status: 404, headers: {}, body: Buffer.from('{}') }), close() {} }),
  });
  try {
    const { csrfToken } = await (await fetch(app.url + '/api/projects')).json();
    const response = await fetch(app.url + '/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken },
      body: '{"ifIdle":true}',
    });
    assert.equal(response.status, 202);
    const deadline = Date.now() + 10000;
    while (app.server.listening && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(app.server.listening, false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
