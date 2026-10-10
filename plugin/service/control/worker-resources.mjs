// What each worker gets of its own besides memory and leases: a block of ports and a Docker
// Compose project name, injected into its environment, and the cleanup of that compose project
// when its session ends. Blocks persist like leases, so a restart neither forgets nor leaks them.
// See docs/browser-control.md "Capacity".
import { spawn } from 'node:child_process';
import os from 'node:os';
import { readState, updateState } from '../operations/storage.mjs';

const STATE = 'worker-resources';
const EMPTY = { schemaVersion: 1, workers: [] };
/** Only a worker's own project is ever stopped: sf- and 8 hex digits of its session ID. */
const COMPOSE_PROJECT = /^sf-[0-9a-f]{8}$/;
const DOCKER_TIMEOUT_MS = 120000;

/** A worker session's compose project: sf- and the first 8 hex digits of its ID. */
export const composeProjectName = id =>
  `sf-${String(id)
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 8)
    .toLowerCase()}`;

const firstLine = text =>
  String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';

/** Runs argv on this PC without a shell, from a folder with no compose file. Never rejects. */
export function runLocal(argv, { timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    const done = result => {
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, cwd: os.tmpdir(), stdio: 'pipe' });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr: `Timed out after ${Math.round(timeoutMs / 1000)} s.` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.stdin.end();
    child.once('error', error => done({ code: -1, stdout, stderr: error.message }));
    child.once('close', code => done({ code: code ?? -1, stdout, stderr }));
  });
}

/** Runs argv where the worker ran: this PC, or its environment's own runner (environment.exec on an SSH box). */
export function defaultRunner(argv, { environment = null, timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  if (!environment || environment.kind === 'local') return runLocal(argv, { timeoutMs });
  if (typeof environment.exec !== 'function')
    return Promise.resolve({ code: -1, stdout: '', stderr: `${environment.id} cannot run commands.` });
  return environment.exec(argv, { timeoutMs });
}

export class WorkerResources {
  /** run(argv, { environment, timeoutMs }) -> { code, stdout, stderr }; tests inject it, so no real docker runs. */
  constructor(host, { run = defaultRunner, log = message => console.warn(`Switchflow: ${message}`) } = {}) {
    Object.assign(this, { host, run, log });
    this.records = []; // { holder, runId, environment, block, base, count, compose }
    this.pending = new Set(); // claimed at admission, session not open yet
    this.targets = new Map(); // holder -> environment object of an open session
    this.loaded = null;
    this.persisting = Promise.resolve();
  }
  load() {
    this.loaded ??= readState(this.host.context, STATE, EMPTY).then(stored => {
      for (const record of Array.isArray(stored.workers) ? stored.workers : [])
        if (typeof record?.holder === 'string' && typeof record.compose === 'string') this.records.push(record);
    });
    return this.loaded;
  }
  persist() {
    const snapshot = this.records.map(({ releasing, ...record }) => record);
    this.persisting = this.persisting.then(() =>
      updateState(this.host.context, STATE, () => ({ schemaVersion: 1, workers: snapshot }), EMPTY).catch(() => {}),
    );
    return this.persisting;
  }
  /** Loads, then releases the records of sessions that are gone, as for leases (capacity.mjs sweep). */
  async ensureLoaded() {
    await this.load();
    await this.sweep();
  }
  /**
   * After a restart, a worker that never closed may still have its compose stack up on its ports:
   * stop it (when the profile opts in) before its block is handed out again. A run the restart
   * fence holds keeps its records until the fence is cleared.
   */
  async sweep() {
    const live = this.host.registry.live;
    const state = await this.host.engine?.read().catch(() => null);
    const fenced = state?.activeRun?.status === 'interrupted' ? state.activeRun.id : null;
    const gone = this.records.filter(
      record =>
        !record.releasing && !live.has(record.holder) && !this.pending.has(record.holder) && record.runId !== fenced,
    );
    if (!gone.length) return;
    for (const record of gone) record.releasing = true;
    for (const record of gone) {
      let environment = null;
      if (record.environment !== 'local')
        environment = await this.host.environment(record.environment).catch(() => undefined);
      const note =
        environment === undefined
          ? { text: `Could not clean up compose project ${record.compose}: environment ${record.environment} is gone.` }
          : await this.composeDown(record, environment).catch(error => ({ text: error.message }));
      if (note) this.log(`${note.text} (a worker that did not close before the service stopped)`);
    }
    this.records = this.records.filter(record => !gone.includes(record));
    await this.persist();
    this.host.registry.wake();
  }

  /**
   * Takes a port block for a worker about to start, synchronously: admission calls it between
   * decisions, so two workers can never get the same block. ensureLoaded() must have run. Blocks
   * are counted per environment. Returns null, or the reason the worker waits.
   */
  claim(holder, { runId, environment = 'local', ports = null }) {
    if (this.records.some(record => record.holder === holder)) return null;
    let block = null;
    if (ports) {
      const used = new Set(
        this.records.filter(record => record.environment === environment).map(record => record.block),
      );
      block = [...Array(ports.blocks).keys()].find(index => !used.has(index)) ?? null;
      if (block === null)
        return `no free port block: ${ports.blocks} of ${ports.blocks} in use${environment === 'local' ? '' : ` on ${environment}`} (ports.blocks)`;
    }
    this.records.push({
      holder,
      runId,
      environment,
      block,
      base: block === null ? null : ports.base + block * ports.blockSize,
      count: block === null ? null : ports.blockSize,
      compose: composeProjectName(holder),
    });
    this.pending.add(holder);
    void this.persist();
    return null;
  }
  /**
   * Undoes claim() for a worker that did not start. It does not wake admission: admission itself
   * undoes a claim when the worker's leases are busy, and waking it then would spin.
   */
  unclaim(holder) {
    if (!this.pending.delete(holder)) return;
    this.records = this.records.filter(record => record.holder !== holder);
    void this.persist();
  }
  /**
   * The variables a worker session gets: its compose project, and its port block when it has one.
   * Called once the session is registered, so a sweep sees it as live from here on.
   */
  async attach(holder, { runId, environment = 'local', target = null }) {
    await this.load();
    let record = this.records.find(entry => entry.holder === holder);
    if (!record) {
      record = {
        holder,
        runId,
        environment,
        block: null,
        base: null,
        count: null,
        compose: composeProjectName(holder),
      };
      this.records.push(record);
      await this.persist();
    }
    this.pending.delete(holder);
    this.targets.set(holder, target);
    return {
      COMPOSE_PROJECT_NAME: record.compose,
      ...(record.base === null
        ? {}
        : { SWITCHFLOW_PORT_BASE: String(record.base), SWITCHFLOW_PORT_COUNT: String(record.count) }),
    };
  }
  /** The port block a worker holds, for its summary. */
  of(holder) {
    const record = this.records.find(entry => entry.holder === holder);
    return record
      ? { ports: record.base === null ? null : { base: record.base, count: record.count }, compose: record.compose }
      : null;
  }
  /**
   * A session ended (or a worker never started, compose: false): stop its compose project when the
   * profile opts in, then free its port block. Returns a notice for the session, or null.
   */
  async release(holder, { compose = true } = {}) {
    this.pending.delete(holder);
    const target = this.targets.get(holder) ?? null;
    this.targets.delete(holder);
    await this.load();
    const record = this.records.find(entry => entry.holder === holder);
    if (!record || record.releasing) return null;
    record.releasing = true;
    try {
      return compose ? await this.composeDown(record, target) : null;
    } finally {
      // The block is free only once its stack is down, so the next worker finds the ports unused.
      this.records = this.records.filter(entry => entry !== record);
      await this.persist();
      this.host.registry.wake();
    }
  }

  /**
   * docker compose -p <sf-…> down --remove-orphans, only when the profile opts in
   * (docker.composeDown), docker compose is installed where the worker ran, and that project
   * exists. Never touches another project. Returns { level, text } to log, or null.
   */
  async composeDown(record, environment) {
    const profile = await this.host.capacity.profile();
    if (!profile.docker?.composeDown) return null;
    const name = record.compose;
    if (!COMPOSE_PROJECT.test(name)) return null;
    const where = environment && environment.kind !== 'local' ? (environment.label ?? environment.id) : 'this PC';
    const run = argv =>
      Promise.resolve()
        .then(() => this.run(argv, { environment, timeoutMs: DOCKER_TIMEOUT_MS }))
        .catch(error => ({ code: -1, stdout: '', stderr: error.message }));
    const version = await run(['docker', 'compose', 'version']);
    if (version.code !== 0)
      return {
        level: 'info',
        text: `Skipped Docker Compose cleanup of ${name}: docker compose is not available on ${where}.`,
      };
    const listed = await run(['docker', 'compose', 'ls', '--all', '--quiet']);
    if (listed.code !== 0)
      return {
        level: 'warning',
        text: `Could not list Docker Compose projects on ${where} to clean up ${name}: ${firstLine(listed.stderr) || `exit ${listed.code}`}`,
      };
    if (
      !String(listed.stdout)
        .split(/\r?\n/)
        .some(line => line.trim() === name)
    )
      return null;
    const down = await run(['docker', 'compose', '-p', name, 'down', '--remove-orphans']);
    return down.code === 0
      ? { level: 'info', text: `Stopped Docker Compose project ${name} on ${where} (down --remove-orphans).` }
      : {
          level: 'warning',
          text: `docker compose -p ${name} down failed on ${where}: ${firstLine(down.stderr) || `exit ${down.code}`}`,
        };
  }
}
