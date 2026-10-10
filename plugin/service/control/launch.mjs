// Starts or reuses the machine-wide control service without PowerShell.
// Usage: node launch.mjs --data <dir> [--project <dir>] [--upgrade-if-idle]
// The service runs from a copy in <data>/runtime/<version>/, so it outlives the folder it was
// launched from (plugin versions are deleted after an update). Prints one JSON line.
import fs from 'node:fs/promises';
import { readFileSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ownServiceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 30000;

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// The plugin manifest two levels up wins; a runtime copy carries VERSION; a template install
// names its version in .switchflow/project.json; the Switchflow repository has VERSION at its root.
export function serviceVersion(serviceRoot = ownServiceRoot) {
  const candidates = [
    () => readJson(path.join(serviceRoot, '..', '.claude-plugin', 'plugin.json')).version,
    () => readFileSync(path.join(serviceRoot, 'VERSION'), 'utf8'),
    () => readJson(path.join(serviceRoot, '..', 'project.json')).templateVersion,
    () => readFileSync(path.join(serviceRoot, '..', '..', '..', 'VERSION'), 'utf8'),
  ];
  for (const candidate of candidates) {
    try {
      const value = String(candidate() ?? '').trim();
      if (value) return value;
    } catch {
      // Try the next source.
    }
  }
  return null;
}

// Semantic version order, prerelease below release. A missing version sorts first.
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = value => {
    const [core, pre] = String(value).replace(/^v/, '').split('+')[0].split(/-(.*)/s);
    return { core: core.split('.').map(part => Number(part) || 0), pre: pre ? pre.split('.') : [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const difference = (left.core[i] || 0) - (right.core[i] || 0);
    if (difference) return Math.sign(difference);
  }
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const [x, y] = [left.pre[i], right.pre[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric ? Number(x) !== Number(y) : x !== y) return numeric ? Math.sign(Number(x) - Number(y)) : x < y ? -1 : 1;
  }
  return 0;
}

// Same resolution as operations/storage.mjs resolveProject.
export function stateHome(env = process.env) {
  return path.resolve(
    env.SWITCHFLOW_HOME ||
      (env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Switchflow')
        : path.join(os.homedir(), '.local', 'state', 'switchflow')),
  );
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function renameWithRetry(source, target) {
  // Windows can briefly refuse a directory rename while a scanner holds a file open.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(source, target);
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || (await exists(target))) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

// Copies a folder to a temporary sibling and renames it into place. When another launcher wins
// the rename, its complete copy is used and this one is discarded.
async function installFolder(target, fill) {
  const temp = path.join(
    path.dirname(target),
    `.tmp-${path.basename(target)}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  try {
    await fill(temp);
    await renameWithRetry(temp, target);
  } catch (error) {
    if (!(await exists(target))) throw error;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function ensureRuntime({ dataDir, serviceRoot = ownServiceRoot, version = serviceVersion(serviceRoot) }) {
  const name = String(version || 'unversioned').replace(/[^A-Za-z0-9._-]/g, '-');
  const target = path.join(path.resolve(dataDir), 'runtime', name);
  const pluginRoot = path.dirname(serviceRoot);
  // Plugin installs place node_modules beside the service; it is deleted with that version too.
  const modules = (await exists(path.join(pluginRoot, '.claude-plugin', 'plugin.json')))
    ? path.join(pluginRoot, 'node_modules')
    : null;
  const withModules = modules && (await exists(modules));
  if (!(await exists(path.join(target, 'control', 'server.mjs')))) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await installFolder(target, async temp => {
      await fs.cp(serviceRoot, temp, {
        recursive: true,
        filter: source => !path.relative(serviceRoot, source).split(path.sep).includes('node_modules'),
      });
      if (withModules) await fs.cp(modules, path.join(temp, 'node_modules'), { recursive: true });
      if (version) await fs.writeFile(path.join(temp, 'VERSION'), `${version}\n`);
    });
  }
  // A copy made before the plugin's dependency install finished gets its modules later.
  if (withModules && !(await exists(path.join(target, 'node_modules'))))
    await installFolder(path.join(target, 'node_modules'), temp => fs.cp(modules, temp, { recursive: true }));
  return target;
}

async function request(url, { method = 'GET', body, token, timeoutMs = 2000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      ...(token ? { 'X-Switchflow-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON replies keep an empty body.
  }
  return { status: response.status, data };
}

// Returns { url, health } for the service named in service-info.json, or null.
export async function findService(sharedDir) {
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(sharedDir, 'service-info.json'), 'utf8'));
    const url = new URL(info.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
  } catch {
    return null;
  }
  try {
    const { status, data: health } = await request(`${info.url}/api/health`);
    if (
      status === 200 &&
      health.service === 'switchflow-control' &&
      health.apiVersion === 2 &&
      health.mode === 'multi-project' &&
      health.pid === info.pid
    )
      return { url: info.url, health };
  } catch {
    // Not answering.
  }
  return null;
}

const isProject = async root => Boolean(root) && (await exists(path.join(root, '.switchflow', 'project.json')));

// The service needs one project to start from: the session's project, else a registered one.
async function startingProject(sharedDir, project) {
  if (await isProject(project)) return project;
  try {
    const registry = JSON.parse(await fs.readFile(path.join(sharedDir, 'projects.json'), 'utf8'));
    for (const entry of registry.projects || []) if (await isProject(entry.root)) return entry.root;
  } catch {
    // No registry yet.
  }
  return null;
}

async function startService({ sharedDir, runtime, projectRoot }) {
  const launchId = randomBytes(16).toString('hex');
  const stdoutPath = path.join(sharedDir, `service.${launchId}.stdout.log`);
  const stderrPath = path.join(sharedDir, `service.${launchId}.stderr.log`);
  const out = openSync(stdoutPath, 'a');
  const err = openSync(stderrPath, 'a');
  let exited = false;
  try {
    const child = spawn(process.execPath, [path.join(runtime, 'control', 'server.mjs'), '--project', projectRoot], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err],
    });
    child.once('exit', () => (exited = true));
    child.once('error', () => (exited = true));
    child.unref();
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const found = await findService(sharedDir);
    if (found) return found;
    // A simultaneous launcher can win the shared lock; keep waiting while its owner lives.
    if (exited && !(await serviceLockHeld(sharedDir))) break;
  }
  let detail = '';
  try {
    detail = (await fs.readFile(stderrPath, 'utf8')).trim().split(/\r?\n/).slice(-3).join(' ');
  } catch {
    // No log.
  }
  throw new Error(`Switchflow did not start${detail ? `: ${detail}` : ''}. Inspect ${stderrPath}`);
}

async function serviceLockHeld(sharedDir) {
  try {
    return alive(JSON.parse(await fs.readFile(path.join(sharedDir, 'service.lock'), 'utf8')).pid);
  } catch {
    return false;
  }
}

async function stopIdle(found) {
  const { data: registry } = await request(`${found.url}/api/projects`, { timeoutMs: 5000 });
  const { status, data } = await request(`${found.url}/api/shutdown`, {
    method: 'POST',
    body: { ifIdle: true },
    token: registry.csrfToken,
    timeoutMs: 10000,
  });
  if (status !== 202) return { stopped: false, activeRuns: data.activeRuns || [], error: data.error };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (alive(found.health.pid)) {
    if (Date.now() >= deadline)
      throw new Error(`The previous Switchflow service (pid ${found.health.pid}) is still stopping.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { stopped: true };
}

async function register(url, projectRoot) {
  const { data: registry } = await request(`${url}/api/projects`, { timeoutMs: 5000 });
  const { status, data } = await request(`${url}/api/projects`, {
    method: 'POST',
    body: { projectRoot },
    token: registry.csrfToken,
    timeoutMs: 30000,
  });
  if (status !== 201) throw new Error(data.error || `Project registration failed (${status}).`);
  return data.project.id;
}

export async function launch({
  data,
  project,
  upgradeIfIdle = false,
  serviceRoot = ownServiceRoot,
  version = serviceVersion(serviceRoot),
  env = process.env,
}) {
  if (!data) throw new Error('--data is required.');
  const sharedDir = path.join(stateHome(env), 'control-service');
  await fs.mkdir(sharedDir, { recursive: true });
  const projectRoot = project ? path.resolve(project) : null;
  let found = await findService(sharedDir);
  let status = 'running';
  const result = {};
  if (found && compareVersions(found.health.version, version) < 0) {
    if (!upgradeIfIdle) result.update = version;
    else {
      const stop = await stopIdle(found);
      if (stop.stopped) {
        found = null;
        status = 'upgraded';
      } else {
        status = 'update-ready';
        result.update = version;
        if (stop.activeRuns.length) result.activeRuns = stop.activeRuns;
        else if (stop.error) result.reason = stop.error;
      }
    }
  }
  if (!found) {
    const startFrom = await startingProject(sharedDir, projectRoot);
    if (!startFrom) return { status: 'not-running', reason: 'No Switchflow project to start from.', version };
    const runtime = await ensureRuntime({ dataDir: data, serviceRoot, version });
    found = await startService({ sharedDir, runtime, projectRoot: startFrom });
    if (status === 'running') status = 'started';
  }
  const output = { status, url: found.url, version: found.health.version ?? null, ...result };
  if (await isProject(projectRoot)) {
    try {
      output.projectId = await register(found.url, projectRoot);
    } catch (error) {
      output.projectError = error.message;
    }
  }
  return output;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--upgrade-if-idle') options.upgradeIfIdle = true;
    else if (['--data', '--project'].includes(argv[i]) && argv[i + 1] !== undefined)
      options[argv[i].slice(2)] = argv[++i];
    else throw new Error('Usage: launch.mjs --data <dir> [--project <dir>] [--upgrade-if-idle]');
  }
  if (!options.data) throw new Error('Usage: launch.mjs --data <dir> [--project <dir>] [--upgrade-if-idle]');
  // An unexpanded placeholder means the host had no project folder to give.
  if (options.project && /^\$\{.*\}$/.test(options.project)) delete options.project;
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  Promise.resolve()
    .then(() => launch(parseArgs(process.argv.slice(2))))
    .then(
      output => console.log(JSON.stringify(output)),
      error => {
        console.log(JSON.stringify({ status: 'error', error: error.message }));
        process.exitCode = 1;
      },
    );
