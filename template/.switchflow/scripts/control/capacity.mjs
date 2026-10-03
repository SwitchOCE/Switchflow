// Local capacity management: memory admission for delegated workers, named leases for shared
// resources (gate slots, e2e stacks, ports), and the worker environment caps, port blocks and
// Docker cleanup of a project's capacity profile (blocks and cleanup: worker-resources.mjs).
// See docs/browser-control.md "Capacity".
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafePath, readState, updateState } from '../operations/storage.mjs';
import { ControlError } from './lifecycle.mjs';
import { MAX_ENV_VARS, workerEnvRefusal } from './worker-env.mjs';

export const CAPACITY_CONFIG = '.switchflow/capacity.json';
const MAX_CONFIG_BYTES = 16 * 1024;
const GB = 1024 ** 3;
const LEASE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_LEASES = 16;
/** Memory a worker admitted this recently may not use yet; it is held back from "free". */
export const RAMP_MS = 2 * 60 * 1000;
export const DEFAULT_LEASE_MINUTES = 30;
/** Built-in leases. gate and e2e are the heavy steps; suite keeps acquire_suite_lock working. */
const BUILTIN_LEASES = Object.freeze({
  suite: { count: 1, gating: true, maxMinutes: 120 },
  gate: { count: 2, gating: true, maxMinutes: 120 },
  e2e: { count: 1, gating: true, maxMinutes: 120 },
});
const GATING_BY_DEFAULT = new Set(Object.keys(BUILTIN_LEASES));

export function defaultCapacityProfile() {
  return {
    schemaVersion: 1,
    memory: { admission: true, workerIdleGB: 1.5, workerGatingGB: 6, headroomGB: 3 },
    leases: structuredClone(BUILTIN_LEASES),
    workerEnv: {},
    ports: null,
    docker: { composeDown: false },
  };
}

const invalid = message => new ControlError(`${CAPACITY_CONFIG}: ${message}`, 409);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const only = (value, keys, where) => {
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw invalid(`unsupported field ${where}${extra[0]}.`);
};

/**
 * Validates a lease pool { name: count | { count, gating, maxMinutes } } and returns it normalized.
 * Throws an Error naming the field. An environment's pool (gating: false) describes another
 * machine, so it cannot gate: gating reserves this PC's memory.
 */
export function validateLeasePool(value, { gating = true, where = 'leases' } = {}) {
  const fields = gating ? ['count', 'gating', 'maxMinutes'] : ['count', 'maxMinutes'];
  const shape = `{ ${fields.join(', ')} }`;
  if (!plain(value)) throw new Error(`${where} must be an object of name: count or ${shape}.`);
  const pool = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!LEASE_NAME.test(name))
      throw new Error(`lease name "${name}" must be lowercase letters, digits and dashes (at most 32).`);
    const lease = Number.isInteger(entry) ? { count: entry } : entry;
    if (!plain(lease)) throw new Error(`${where}.${name} must be a count or ${shape}.`);
    const extra = Object.keys(lease).filter(key => !fields.includes(key));
    if (extra.length)
      throw new Error(
        `unsupported field ${where}.${name}.${extra[0]}${extra[0] === 'gating' ? " (gating reserves this PC's memory)" : ''}.`,
      );
    if (!Number.isInteger(lease.count) || lease.count < 1 || lease.count > 16)
      throw new Error(`${where}.${name}.count must be a whole number from 1 to 16.`);
    if (lease.gating !== undefined && typeof lease.gating !== 'boolean')
      throw new Error(`${where}.${name}.gating must be true or false.`);
    if (
      lease.maxMinutes !== undefined &&
      (!Number.isInteger(lease.maxMinutes) || lease.maxMinutes < 1 || lease.maxMinutes > 480)
    )
      throw new Error(`${where}.${name}.maxMinutes must be a whole number from 1 to 480.`);
    pool[name] = {
      count: lease.count,
      ...(gating ? { gating: lease.gating ?? GATING_BY_DEFAULT.has(name) } : {}),
      maxMinutes: lease.maxMinutes ?? 120,
    };
  }
  if (Object.keys(pool).length > MAX_LEASES) throw new Error(`at most ${MAX_LEASES} leases can be declared.`);
  return pool;
}

/** Validates an owner capacity profile. Unknown fields are refused. Returns the merged profile. */
export function validateCapacityProfile(value) {
  if (!plain(value)) throw invalid('expected a JSON object.');
  only(value, ['schemaVersion', 'memory', 'leases', 'workerEnv', 'ports', 'docker'], '');
  if (value.schemaVersion !== 1) throw invalid('schemaVersion must be 1.');
  const profile = defaultCapacityProfile();
  if (value.memory !== undefined) {
    if (!plain(value.memory)) throw invalid('memory must be an object.');
    only(value.memory, ['admission', 'workerIdleGB', 'workerGatingGB', 'headroomGB'], 'memory.');
    const { admission, workerIdleGB, workerGatingGB, headroomGB } = value.memory;
    if (admission !== undefined && typeof admission !== 'boolean')
      throw invalid('memory.admission must be true or false.');
    if (workerIdleGB !== undefined && !number(workerIdleGB, 0.1, 64))
      throw invalid('memory.workerIdleGB must be a number from 0.1 to 64.');
    if (workerGatingGB !== undefined && !number(workerGatingGB, 0.1, 256))
      throw invalid('memory.workerGatingGB must be a number from 0.1 to 256.');
    if (headroomGB !== undefined && !number(headroomGB, 0, 64))
      throw invalid('memory.headroomGB must be a number from 0 to 64.');
    Object.assign(
      profile.memory,
      Object.fromEntries(Object.entries(value.memory).filter(([, entry]) => entry !== undefined)),
    );
    if (profile.memory.workerGatingGB < profile.memory.workerIdleGB)
      throw invalid('memory.workerGatingGB must be at least memory.workerIdleGB.');
  }
  if (value.leases !== undefined) {
    try {
      Object.assign(profile.leases, validateLeasePool(value.leases));
    } catch (error) {
      throw invalid(error.message);
    }
    if (Object.keys(profile.leases).length > MAX_LEASES) throw invalid(`at most ${MAX_LEASES} leases can be declared.`);
  }
  if (value.workerEnv !== undefined) {
    if (!plain(value.workerEnv) || Object.keys(value.workerEnv).length > MAX_ENV_VARS)
      throw invalid(`workerEnv must be an object of at most ${MAX_ENV_VARS} variables.`);
    for (const [name, entry] of Object.entries(value.workerEnv)) {
      const refusal = workerEnvRefusal(name, entry);
      if (refusal) throw invalid(`workerEnv.${name} ${refusal}.`);
    }
    profile.workerEnv = { ...value.workerEnv };
  }
  if (value.ports !== undefined) {
    // One block of ports per running worker, in each environment (worker-resources.mjs).
    if (!plain(value.ports)) throw invalid('ports must be { base, blockSize, blocks }.');
    only(value.ports, ['base', 'blockSize', 'blocks'], 'ports.');
    const { base, blockSize, blocks } = value.ports;
    if (!Number.isInteger(base) || base < 1024 || base > 65535)
      throw invalid('ports.base must be a whole number from 1024 to 65535.');
    if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 1000)
      throw invalid('ports.blockSize must be a whole number from 1 to 1000.');
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 64)
      throw invalid('ports.blocks must be a whole number from 1 to 64.');
    if (base + blockSize * blocks - 1 > 65535)
      throw invalid(`ports: ${blocks} blocks of ${blockSize} from ${base} end past port 65535.`);
    profile.ports = { base, blockSize, blocks };
  }
  if (value.docker !== undefined) {
    if (!plain(value.docker)) throw invalid('docker must be { composeDown }.');
    only(value.docker, ['composeDown'], 'docker.');
    if (value.docker.composeDown !== undefined && typeof value.docker.composeDown !== 'boolean')
      throw invalid('docker.composeDown must be true or false.');
    profile.docker = { composeDown: value.docker.composeDown ?? false };
  }
  return profile;
}

/**
 * Reads `.switchflow/capacity.json` from the primary checkout. Absent means defaults; an invalid
 * file also falls back to defaults and reports the error, so a typo cannot stop delivery.
 */
export async function readCapacityProfile(context) {
  const file = path.join(context.governanceRoot, ...CAPACITY_CONFIG.split('/'));
  const fallback = error => ({ ...defaultCapacityProfile(), source: 'defaults', error });
  let text;
  try {
    await assertSafePath(context.governanceRoot, file);
    const info = await fs.lstat(file);
    if (!info.isFile()) return fallback(`${CAPACITY_CONFIG} must be a regular file.`);
    if (info.size > MAX_CONFIG_BYTES) return fallback(`${CAPACITY_CONFIG} is larger than 16 KiB.`);
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback(null);
    return fallback(`${CAPACITY_CONFIG} could not be read: ${error.message}`);
  }
  try {
    return { ...validateCapacityProfile(JSON.parse(text.replace(/^﻿/, ''))), source: CAPACITY_CONFIG, error: null };
  } catch (error) {
    return fallback(error instanceof SyntaxError ? `${CAPACITY_CONFIG} is not valid JSON.` : error.message);
  }
}

/**
 * Free and total physical memory in bytes. os.freemem() is the memory available to new work:
 * on Windows it equals the "Available MBytes" counter (free plus standby), on Linux MemAvailable.
 */
export function systemMemory() {
  return { free: os.freemem(), total: os.totalmem() };
}

const round = bytes => Math.round((bytes / GB) * 10) / 10;
const gbText = value => `${Math.max(0, Math.round(value * 10) / 10)} GB`;

/**
 * Machine-wide memory reservations, shared by every project the service runs. A reservation is
 * a budget the service has promised: an admitted worker's idle budget, or the extra a gating
 * lease adds. available = min(free - still-starting reservations, total - all reservations) - headroom.
 */
export class MemoryPool {
  constructor({ memory = systemMemory, clock = Date.now, rampMs = RAMP_MS } = {}) {
    Object.assign(this, { memory, clock, rampMs });
    this.reservations = new Map(); // key -> { bytes, since }
    this.listeners = new Set();
  }
  reserve(key, gigabytes) {
    this.reservations.set(key, { bytes: gigabytes * GB, since: this.clock() });
  }
  release(key) {
    if (!this.reservations.delete(key)) return;
    for (const listener of this.listeners) listener();
  }
  has(prefix) {
    return [...this.reservations.keys()].some(key => key.startsWith(prefix));
  }
  snapshot(headroomGB) {
    const { free, total } = this.memory();
    const now = this.clock();
    let reserved = 0;
    let starting = 0;
    for (const { bytes, since } of this.reservations.values()) {
      reserved += bytes;
      if (since > now - this.rampMs) starting += bytes;
    }
    const headroom = headroomGB * GB;
    const available = Math.min(free - starting, total - reserved) - headroom;
    return {
      freeGB: round(free),
      totalGB: round(total),
      reservedGB: round(reserved),
      startingGB: round(starting),
      headroomGB,
      availableGB: round(available),
      availableBytes: available,
      reservations: this.reservations.size,
      // Which term binds, for the reason text.
      bound: total - reserved < free - starting ? 'reserved' : 'free',
    };
  }
}
export const sharedMemoryPool = new MemoryPool();

function memoryReason(need, snapshot) {
  const why =
    snapshot.bound === 'reserved'
      ? `${gbText(snapshot.reservedGB)} of ${gbText(snapshot.totalGB)} reserved by running workers`
      : `${gbText(snapshot.freeGB)} free${snapshot.startingGB ? `, ${gbText(snapshot.startingGB)} held for workers still starting` : ''}`;
  return `needs ${gbText(need)}, ${gbText(snapshot.availableGB)} available (${why}, ${gbText(snapshot.headroomGB)} headroom)`;
}

const minutesLeft = (expiresAt, now) => Math.max(0, Math.ceil((expiresAt - now) / 60000));
/** The pool a lease belongs to: "local" for this PC, or the environment whose resources it describes. */
const poolOf = lease => lease.environment ?? 'local';

/**
 * Per-project capacity: the FIFO admission queue for delegated workers and the project's leases.
 * Leases persist in external state so a restart neither forgets nor leaks them.
 */
export class CapacityManager {
  constructor(host, { pool = sharedMemoryPool, clock, recheckMs = 5000 } = {}) {
    this.host = host;
    this.pool = pool;
    this.clock = clock ?? pool.clock;
    this.recheckMs = recheckMs;
    this.queue = [];
    this.leases = [];
    this.waiting = new Map(); // lease name -> [token]
    this.claimed = new Set(); // holders granted leases at admission whose session is not open yet
    this.cached = null;
    this.loaded = null;
    this.persisting = Promise.resolve();
    this.onWake = () => this.schedulePump();
    host.registry.waiters.add(this.onWake);
    this.unsubscribe = (pool.listeners.add(this.onWake), () => pool.listeners.delete(this.onWake));
  }

  /** The project profile, re-read only when the file changes. */
  async profile() {
    const file = path.join(this.host.context.governanceRoot, ...CAPACITY_CONFIG.split('/'));
    let stamp = 'absent';
    try {
      const info = await fs.stat(file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {}
    if (this.cached?.stamp !== stamp) this.cached = { stamp, value: await readCapacityProfile(this.host.context) };
    return this.cached.value;
  }

  // ---- Admission -------------------------------------------------------------------------

  /**
   * Asks to start a worker. entry: { id, runId, task, kind, maxWorkers, slotFree(), start(), onFailure(error) },
   * plus for a worker on another machine { lane: environment id, memory: false, limitReason }, and
   * optionally claim(): takes what the worker needs from its start (a port block, leases named at
   * delegation) all or none, synchronously, and returns null or the reason it must wait.
   * start() must mark the worker as starting before its first await. Strictly first in, first out
   * within a lane: a new request never overtakes a queued one of its lane. Returns
   * { admitted: true, note? } once start() succeeded, or { admitted: false, position, reason } when queued.
   */
  async request(entry) {
    Object.assign(entry, { since: this.clock(), reason: null, awaiting: true });
    this.queue.push(entry);
    try {
      try {
        await this.pump();
      } catch (error) {
        this.cancel(entry.id);
        throw error;
      }
      if (entry.startPromise) {
        await entry.startPromise;
        return { admitted: true, ...(entry.note ? { note: entry.note } : {}) };
      }
      return { admitted: false, ...this.queueInfo(entry.id) };
    } finally {
      entry.awaiting = false;
    }
  }
  async pump() {
    if (!this.queue.length) return;
    const profile = await this.profile();
    // From here to the end nothing awaits, so two pumps cannot admit past a limit. Each lane (this
    // PC, or one remote environment) is first in, first out on its own, so a full SSH box never
    // holds up local workers.
    const blocked = new Set();
    for (const head of [...this.queue]) {
      const lane = head.lane ?? 'local';
      if (blocked.has(lane)) continue;
      const decision = this.decide(head, profile);
      const claimed = decision.ok ? (head.claim?.() ?? null) : decision.reason;
      if (claimed) {
        head.reason = claimed;
        blocked.add(lane);
        continue;
      }
      this.queue.splice(this.queue.indexOf(head), 1);
      head.note = decision.note ?? null;
      if (decision.reserve) this.pool.reserve(`worker:${head.id}`, decision.reserve);
      head.startPromise = head.start().catch(error => {
        this.pool.release(`worker:${head.id}`);
        if (!head.awaiting) head.onFailure?.(error);
        throw error;
      });
      head.startPromise.catch(() => {});
    }
    const ahead = new Map();
    for (const entry of this.queue) {
      const lane = entry.lane ?? 'local';
      const index = ahead.get(lane) ?? 0;
      if (index) entry.reason = `waiting behind ${index} earlier worker${index === 1 ? '' : 's'}`;
      ahead.set(lane, index + 1);
    }
    this.scheduleRecheck();
  }
  decide(entry, profile) {
    if (!entry.slotFree())
      return {
        ok: false,
        reason: entry.limitReason ?? `${entry.maxWorkers} workers are running, the limit (limits.maxWorkers)`,
      };
    // A worker on another machine uses none of this PC's memory.
    if (entry.memory === false) return { ok: true, reserve: 0 };
    const { admission, workerIdleGB, headroomGB } = profile.memory;
    if (!admission) return { ok: true, reserve: 0 };
    const snapshot = this.pool.snapshot(headroomGB);
    if (snapshot.availableBytes >= workerIdleGB * GB) return { ok: true, reserve: workerIdleGB };
    // With nothing else reserved, waiting would never end; start one worker and say so.
    if (!snapshot.reservations)
      return {
        ok: true,
        reserve: workerIdleGB,
        note: `Started with less memory than its budget (${memoryReason(workerIdleGB, snapshot)}) because no other worker is running.`,
      };
    return { ok: false, reason: memoryReason(workerIdleGB, snapshot) };
  }
  schedulePump() {
    if (!this.queue.length || this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump().catch(() => {});
    });
  }
  /** Memory can free without any event; look again while something waits. */
  scheduleRecheck() {
    clearTimeout(this.recheckTimer);
    if (!this.queue.length || !this.recheckMs) return;
    this.recheckTimer = setTimeout(() => void this.pump().catch(() => {}), this.recheckMs);
    this.recheckTimer.unref?.();
  }
  queueInfo(id) {
    const index = this.queue.findIndex(entry => entry.id === id);
    if (index === -1) return null;
    const entry = this.queue[index];
    return { position: index + 1, reason: entry.reason, since: new Date(entry.since).toISOString() };
  }
  /** Removes a queued worker; returns true when it was still waiting. */
  cancel(id) {
    const index = this.queue.findIndex(entry => entry.id === id);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.schedulePump();
    return true;
  }
  releaseWorker(id) {
    this.pool.release(`worker:${id}`);
  }

  // ---- Leases ----------------------------------------------------------------------------

  async ensureLoaded() {
    this.loaded ??= (async () => {
      const stored = await readState(this.host.context, 'leases', { schemaVersion: 1, leases: [] });
      const profile = await this.profile();
      for (const lease of Array.isArray(stored.leases) ? stored.leases : []) {
        const acquiredAt = Date.parse(lease.acquiredAt);
        const expiresAt = Date.parse(lease.expiresAt);
        if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) continue;
        this.leases.push({ ...lease, acquiredAt, expiresAt });
        if (poolOf(lease) === 'local' && profile.leases[lease.name]?.gating && profile.memory.admission)
          this.reserveGating(lease, profile, acquiredAt);
      }
      await this.sweep();
    })();
    return this.loaded;
  }
  reserveGating({ id }, profile, since = this.clock()) {
    const extra = Math.max(0, profile.memory.workerGatingGB - profile.memory.workerIdleGB);
    this.pool.reserve(`lease:${id}`, extra);
    if (since !== undefined) this.pool.reservations.get(`lease:${id}`).since = since;
  }
  /**
   * Releases leases whose holder session is gone. A lease of an interrupted run stays while the
   * restart fence still holds that run's processes; they may still be using the resource.
   */
  async sweep() {
    const live = this.host.registry.live;
    const state = await this.host.engine?.read().catch(() => null);
    const fenced = state?.activeRun?.status === 'interrupted' ? state.activeRun.id : null;
    const gone = this.leases.filter(
      lease => !live.has(lease.holder) && !this.claimed.has(lease.holder) && lease.runId !== fenced,
    );
    for (const lease of gone) this.drop(lease, null);
    if (gone.length) await this.persist();
  }
  /** Expires overdue leases; records a notice on a holder that is still open. */
  expire() {
    const now = this.clock();
    const overdue = this.leases.filter(lease => lease.expiresAt <= now);
    for (const lease of overdue)
      this.drop(
        lease,
        `Lease "${lease.name}" expired after ${Math.round((lease.expiresAt - lease.acquiredAt) / 60000)} min and was released.`,
      );
    if (overdue.length) {
      this.persist();
      setImmediate(() => this.host.registry.wake());
    }
  }
  drop(lease, notice) {
    this.leases = this.leases.filter(other => other !== lease);
    this.pool.release(`lease:${lease.id}`);
    // Deferred: recording wakes waiters, and drop() can run inside a waiter's own check.
    if (notice)
      setImmediate(
        () => void this.host.registry.record(lease.holder, { kind: 'notice', level: 'warning', text: notice }),
      );
    this.scheduleExpiry();
  }
  persist() {
    const snapshot = this.leases.map(lease => ({
      ...lease,
      acquiredAt: new Date(lease.acquiredAt).toISOString(),
      expiresAt: new Date(lease.expiresAt).toISOString(),
    }));
    // Serialized, each write a full snapshot. A failed write is retried by the next change; the
    // in-memory leases stay authoritative while the service runs.
    this.persisting = this.persisting.then(() =>
      updateState(this.host.context, 'leases', () => ({ schemaVersion: 1, leases: snapshot }), {
        schemaVersion: 1,
        leases: [],
      }).catch(() => {}),
    );
    return this.persisting;
  }
  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.leases.length) return;
    const next = Math.min(...this.leases.map(lease => lease.expiresAt));
    this.expiryTimer = setTimeout(() => this.expire(), Math.min(Math.max(next - this.clock(), 1000), 2 ** 31 - 1));
    this.expiryTimer.unref?.();
  }
  describe(lease, now = this.clock()) {
    const who = lease.kind === 'orchestrator' ? 'the orchestrator' : `${lease.task} ${lease.kind} worker`;
    return `${who}, ${minutesLeft(lease.expiresAt, now)} min left`;
  }
  view(lease, now = this.clock()) {
    return {
      id: lease.id,
      name: lease.name,
      environment: poolOf(lease),
      holder: lease.holder,
      runId: lease.runId,
      task: lease.task ?? null,
      kind: lease.kind,
      acquiredAt: new Date(lease.acquiredAt).toISOString(),
      expiresAt: new Date(lease.expiresAt).toISOString(),
      minutesLeft: minutesLeft(lease.expiresAt, now),
    };
  }
  /**
   * Whether token may take a lease of name in pool now; the reason when not. Without a token (a
   * lease named at delegation) the request comes after every waiting acquire_lease call.
   */
  leaseDecision(name, token, resource, profile, pool = 'local') {
    const active = this.leases.filter(lease => lease.name === name && poolOf(lease) === pool);
    const free = resource.count - active.length;
    const waiting = pool === 'local' ? this.waiting.get(name) || [] : [];
    const ahead = token ? waiting.indexOf(token) : waiting.length;
    const where = pool === 'local' ? '' : ` on ${pool}`;
    if (free <= 0)
      return {
        ok: false,
        reason: `${name}${where}: ${resource.count} of ${resource.count} held by ${active.map(lease => this.describe(lease)).join('; ')}`,
      };
    if (ahead >= free)
      return { ok: false, reason: `${name}: waiting behind ${ahead} earlier request${ahead === 1 ? '' : 's'}` };
    // Gating reserves this PC's memory; another environment's leases never do.
    if (pool === 'local' && resource.gating && profile.memory.admission) {
      const extra = Math.max(0, profile.memory.workerGatingGB - profile.memory.workerIdleGB);
      const snapshot = this.pool.snapshot(profile.memory.headroomGB);
      // The first gating lease on the machine is always granted, or nothing could ever gate.
      if (snapshot.availableBytes < extra * GB && this.pool.has('lease:'))
        return { ok: false, reason: `${name}: gating ${memoryReason(extra, snapshot)}` };
    }
    return { ok: true };
  }
  /**
   * Waits up to timeoutMs for a lease. Re-acquiring a lease you hold renews it. The wait is
   * first in, first out per name, and a gating lease also waits for its extra memory.
   */
  async acquireLease({ name, holder, runId, task = null, kind, ttlMinutes, timeoutMs, signal }) {
    await this.ensureLoaded();
    await this.sweep();
    const profile = await this.profile();
    if (typeof name !== 'string' || !profile.leases[name])
      throw new ControlError(
        `Unknown lease "${name}". This project declares: ${Object.keys(profile.leases).join(', ')} (${CAPACITY_CONFIG}).`,
        404,
      );
    const resource = profile.leases[name];
    const minutes = ttlMinutes ?? Math.min(DEFAULT_LEASE_MINUTES, resource.maxMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > resource.maxMinutes)
      throw new ControlError(`ttlMinutes must be 1–${resource.maxMinutes} for lease "${name}".`);
    this.expire();
    const held = this.leases.find(lease => lease.name === name && lease.holder === holder && poolOf(lease) === 'local');
    if (held) {
      held.expiresAt = this.clock() + minutes * 60000;
      this.scheduleExpiry();
      await this.persist();
      return { acquired: true, renewed: true, ...this.view(held) };
    }
    const token = { holder };
    if (!this.waiting.has(name)) this.waiting.set(name, []);
    this.waiting.get(name).push(token);
    let granted = null;
    const attempt = () => {
      if (granted) return true;
      this.expire();
      const decision = this.leaseDecision(name, token, resource, profile);
      token.reason = decision.reason;
      if (!decision.ok) return false;
      // Granting inside the check keeps it atomic with the decision.
      const now = this.clock();
      granted = {
        id: randomUUID(),
        name,
        holder,
        runId,
        task,
        kind,
        acquiredAt: now,
        expiresAt: now + minutes * 60000,
      };
      this.leases.push(granted);
      if (resource.gating && profile.memory.admission) this.reserveGating(granted, profile, now);
      return true;
    };
    try {
      await this.host.registry.waitFor(attempt, timeoutMs, signal);
    } finally {
      const list = this.waiting.get(name);
      list.splice(list.indexOf(token), 1);
      if (!list.length) this.waiting.delete(name);
    }
    if (!granted) {
      setImmediate(() => this.host.registry.wake());
      return { acquired: false, name, reason: token.reason ?? `${name} is busy` };
    }
    this.scheduleExpiry();
    await this.persist();
    return { acquired: true, ...this.view(granted) };
  }
  /**
   * Leases named at delegation (delegate_task leases): granted to holder all or none, for its whole
   * session up to each lease's maxMinutes. Synchronous, because admission calls it between
   * decisions; ensureLoaded() must have run. pool is "local" or an environment ID, and resources
   * its declared leases. Returns null when granted, otherwise the reason the worker waits.
   */
  takeLeases({ names, pool = 'local', resources, holder, runId, task = null, kind }, profile) {
    this.expire();
    // Every decision before any grant: undoing a grant would release memory and wake admission again.
    for (const name of names) {
      const decision = resources[name]
        ? this.leaseDecision(name, null, resources[name], profile, pool)
        : { ok: false, reason: `${name}: not declared` };
      if (!decision.ok) return decision.reason;
    }
    const granted = [];
    for (const name of names) {
      const resource = resources[name];
      const now = this.clock();
      const lease = {
        id: randomUUID(),
        name,
        environment: pool,
        holder,
        runId,
        task,
        kind,
        acquiredAt: now,
        expiresAt: now + resource.maxMinutes * 60000,
      };
      this.leases.push(lease);
      if (pool === 'local' && resource.gating && profile.memory.admission) this.reserveGating(lease, profile, now);
      granted.push(lease);
    }
    if (granted.length) {
      this.claimed.add(holder);
      this.scheduleExpiry();
      void this.persist();
    }
    return null;
  }
  /** releasedBy is the holder, or a run whose orchestrator may release its workers' leases. */
  async releaseLease(id, { holder, runId = null }) {
    await this.ensureLoaded();
    const lease = this.leases.find(entry => entry.id === id);
    if (!lease) return { released: false, reason: 'No such lease; it may have expired or been released.' };
    if (lease.holder !== holder && !(runId && lease.runId === runId))
      throw new ControlError('Only the holder or its orchestrator can release this lease.', 403);
    this.drop(lease, null);
    await this.persist();
    this.host.registry.wake();
    return { released: true, id, name: lease.name };
  }
  /** Releases every lease of a holder, optionally only one name. Used when a session closes. */
  async releaseHolder(holder, name = null) {
    if (!name) this.claimed.delete(holder);
    await this.ensureLoaded();
    const mine = this.leases.filter(lease => lease.holder === holder && (!name || lease.name === name));
    for (const lease of mine) this.drop(lease, null);
    if (mine.length) {
      await this.persist();
      this.host.registry.wake();
    }
    return mine.map(lease => lease.id);
  }
  /** pools: { environmentId: declared leases } to list beside this PC's, for the orchestrator. */
  async listLeases({ pools = null } = {}) {
    await this.ensureLoaded();
    await this.sweep();
    this.expire();
    await this.persisting;
    const profile = await this.profile();
    const now = this.clock();
    const held = (name, pool) => this.leases.filter(lease => lease.name === name && poolOf(lease) === pool).length;
    return {
      leases: this.leases.map(lease => this.view(lease, now)),
      resources: Object.entries(profile.leases).map(([name, resource]) => ({
        name,
        ...resource,
        held: held(name, 'local'),
        waiting: (this.waiting.get(name) || []).length,
      })),
      ...(pools
        ? {
            environments: Object.entries(pools).map(([id, declared]) => ({
              id,
              resources: Object.entries(declared).map(([name, resource]) => ({
                name,
                ...resource,
                held: held(name, id),
              })),
            })),
          }
        : {}),
    };
  }

  // ---- Visibility ------------------------------------------------------------------------

  async status({ maxWorkers = null } = {}) {
    const profile = await this.profile();
    const { leases, resources } = await this.listLeases();
    const memory = this.pool.snapshot(profile.memory.headroomGB);
    const workerSessions = [...this.host.registry.live.values()].filter(entry =>
      ['deliver', 'review'].includes(entry.meta.kind),
    );
    return {
      profile: { source: profile.source, error: profile.error },
      memory: {
        admission: profile.memory.admission,
        freeGB: memory.freeGB,
        totalGB: memory.totalGB,
        reservedGB: memory.reservedGB,
        startingGB: memory.startingGB,
        headroomGB: memory.headroomGB,
        availableGB: memory.availableGB,
        workerIdleGB: profile.memory.workerIdleGB,
        workerGatingGB: profile.memory.workerGatingGB,
      },
      workers: { admitted: workerSessions.length, queued: this.queue.length, maxWorkers },
      queue: this.queue.map((entry, index) => ({
        workerId: entry.id,
        runId: entry.runId,
        task: entry.task,
        kind: entry.kind,
        position: index + 1,
        reason: entry.reason,
        since: new Date(entry.since).toISOString(),
      })),
      leases,
      resources,
      workerEnv: Object.keys(profile.workerEnv),
    };
  }
  close() {
    clearTimeout(this.recheckTimer);
    clearTimeout(this.expiryTimer);
    this.host.registry.waiters.delete(this.onWake);
    this.unsubscribe();
    for (const entry of this.queue) this.pool.release(`worker:${entry.id}`);
  }
}
