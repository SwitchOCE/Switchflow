import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafePath, readState, updateState } from '../operations/storage.mjs';

export const SESSION_STATUSES = Object.freeze(['starting', 'working', 'idle', 'completed', 'failed', 'cancelled']);
export const EVENT_KINDS = Object.freeze([
  'session.started',
  'session.closed',
  'turn.started',
  'message',
  'tool',
  'command',
  'file_change',
  'steer',
  'interrupt',
  'turn.completed',
  'turn.failed',
  'stderr',
  'notice',
]);
const FINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_SESSIONS = 200;
const MAX_LIVE_EVENTS = 5000;
const MAX_EVENT_FILE = 16 * 1024 * 1024;
const MAX_TEXT = 20000;

const clip = (value, limit = MAX_TEXT) =>
  typeof value === 'string' && value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/**
 * Durable index of agent sessions plus their live handles. The index lives in the external
 * project state (not agent-writable); events are appended per session under runs/<runId>/sessions.
 */
export class AgentSessionRegistry {
  constructor(context) {
    this.context = context;
    this.live = new Map(); // id -> { meta, handle, events, waiters, writes, bytes }
    this.waiters = new Set();
  }
  async init() {
    // A restarted service cannot reach earlier processes. Their sessions are closed, not replayed,
    // and marked failed so the owner sees them; the engine's recovery hold fences live processes.
    await updateState(
      this.context,
      'agent-sessions',
      state => {
        for (const session of state.sessions)
          if (!FINAL.has(session.status)) {
            session.status = 'failed';
            session.error = `The service stopped while this session was open${session.pid ? ` (process ${session.pid})` : ''}. It was not resumed; if its initiative shows a recovery hold, stop or confirm its processes there.`;
            session.endedAt ??= new Date().toISOString();
            session.canSteer = false;
            session.canInterrupt = false;
          }
      },
      { schemaVersion: 1, sessions: [] },
    );
  }
  async eventsPath(meta) {
    const directory = path.join(this.context.stateDir, 'runs', meta.runId, 'sessions');
    await fs.mkdir(await assertSafePath(this.context.stateDir, directory), { recursive: true });
    return assertSafePath(this.context.stateDir, path.join(directory, `${meta.id}.events.jsonl`));
  }
  rawLogPath(meta) {
    return path.join(this.context.stateDir, 'runs', meta.runId, 'sessions', `${meta.id}.raw.jsonl`);
  }
  async create(fields) {
    const at = new Date().toISOString();
    const meta = {
      id: fields.id || randomUUID(),
      parentId: fields.parentId ?? null,
      runId: fields.runId,
      initiativeId: fields.initiativeId ?? null,
      role: fields.role,
      kind: fields.kind ?? 'stage',
      provider: fields.provider,
      transport: fields.transport ?? null,
      model: fields.model ?? null,
      threadId: null,
      task: fields.task ?? null,
      worktree: fields.worktree ?? null,
      sandbox: fields.sandbox ?? null,
      reviewRound: fields.reviewRound ?? null,
      status: 'starting',
      startedAt: at,
      updatedAt: at,
      endedAt: null,
      usage: null,
      lastMessage: null,
      result: null,
      error: null,
      fallback: fields.fallback ?? null,
      eventCount: 0,
      canSteer: false,
      canInterrupt: false,
    };
    if (!/^[a-f0-9-]{36}$/.test(meta.id) || !/^[a-f0-9-]{36}$/.test(meta.runId))
      throw new Error('Invalid session identity');
    const entry = {
      meta,
      handle: null,
      events: [],
      writes: Promise.resolve(),
      bytes: 0,
      file: await this.eventsPath(meta),
    };
    this.live.set(meta.id, entry);
    await this.persist(meta);
    return meta;
  }
  attach(id, handle) {
    const entry = this.live.get(id);
    if (entry) {
      entry.handle = handle;
      this.refreshControls(entry);
    }
  }
  refreshControls(entry) {
    const { meta, handle } = entry;
    const open = Boolean(handle) && !handle.closed && !FINAL.has(meta.status);
    meta.canInterrupt = open && Boolean(handle.activeTurnId);
    meta.canSteer =
      open &&
      typeof handle.steer === 'function' &&
      handle.canSteer !== false &&
      (Boolean(handle.activeTurnId) || (meta.status === 'idle' && typeof handle.followUp === 'function'));
  }
  /** Appends one normalized event and updates the session summary. Returns the stored event. */
  async record(id, event) {
    const entry = this.live.get(id);
    if (!entry) return null;
    const { meta } = entry;
    const stored = { seq: ++meta.eventCount, at: new Date().toISOString(), ...event };
    for (const key of ['text', 'summary', 'command', 'error'])
      if (typeof stored[key] === 'string') stored[key] = clip(stored[key]);
    entry.events.push(stored);
    if (entry.events.length > MAX_LIVE_EVENTS) entry.events.splice(0, entry.events.length - MAX_LIVE_EVENTS);
    meta.updatedAt = stored.at;
    let statusChanged = false;
    if (event.kind === 'session.started') {
      meta.threadId = event.threadId ?? meta.threadId;
      meta.model = event.model ?? meta.model;
      meta.transport = event.transport ?? meta.transport;
      meta.pid = event.pid ?? null;
    }
    if (event.kind === 'turn.started' && meta.status !== 'working') {
      meta.status = 'working';
      statusChanged = true;
    }
    if (event.kind === 'message') meta.lastMessage = clip(event.text, 4000);
    if (event.kind === 'turn.completed' || event.kind === 'turn.failed') {
      if (event.usage) meta.usage = event.usage;
      meta.lastTurn = {
        id: event.turnId ?? null,
        status: event.kind === 'turn.failed' ? 'failed' : event.status,
        at: stored.at,
      };
      if (!FINAL.has(meta.status)) {
        meta.status = 'idle';
        statusChanged = true;
      }
      if (event.kind === 'turn.failed') meta.error = clip(event.error, 4000);
    }
    const line = `${JSON.stringify(stored)}\n`;
    entry.bytes += Buffer.byteLength(line);
    if (entry.bytes <= MAX_EVENT_FILE)
      entry.writes = entry.writes.then(() => fs.appendFile(entry.file, line)).catch(() => {});
    this.refreshControls(entry);
    // Process identity is persisted at once so a restart can name it.
    if (statusChanged || event.kind === 'session.started') await this.persist(meta);
    this.wake();
    return stored;
  }
  async update(id, patch) {
    const entry = this.live.get(id);
    if (!entry) return null;
    Object.assign(entry.meta, patch, { updatedAt: new Date().toISOString() });
    if (FINAL.has(entry.meta.status)) entry.meta.endedAt ??= entry.meta.updatedAt;
    this.refreshControls(entry);
    await this.persist(entry.meta);
    this.wake();
    return entry.meta;
  }
  /** Ends the live entry. The durable summary and event file stay for history. */
  async finish(id, patch) {
    const entry = this.live.get(id);
    if (!entry) return;
    await this.update(id, { ...patch, canSteer: false, canInterrupt: false });
    entry.handle = null;
    await entry.writes;
    this.live.delete(id);
    this.wake();
  }
  /** Writes are serialized and copy the summary at write time, so a later state never loses to an earlier one. */
  persist(meta) {
    const write = (this.persisting ?? Promise.resolve()).catch(() => {}).then(() => this.write(meta));
    this.persisting = write;
    return write;
  }
  async write(meta) {
    const snapshot = structuredClone(meta);
    await updateState(
      this.context,
      'agent-sessions',
      state => {
        const index = state.sessions.findIndex(session => session.id === snapshot.id);
        if (index === -1) state.sessions.push(snapshot);
        else state.sessions[index] = snapshot;
        if (state.sessions.length > MAX_SESSIONS) {
          // Drop the oldest finished sessions first; never drop a live one.
          const removable = state.sessions.filter(s => FINAL.has(s.status) && !this.live.has(s.id));
          const excess = new Set(removable.slice(0, state.sessions.length - MAX_SESSIONS).map(s => s.id));
          state.sessions = state.sessions.filter(s => !excess.has(s.id));
        }
      },
      { schemaVersion: 1, sessions: [] },
    );
  }
  get(id) {
    return this.live.get(id) ?? null;
  }
  async list() {
    const stored = await readState(this.context, 'agent-sessions', { schemaVersion: 1, sessions: [] });
    const byId = new Map(stored.sessions.map(session => [session.id, session]));
    for (const [id, entry] of this.live) {
      // Turn identity can arrive after the event that announced the turn; read controls now.
      this.refreshControls(entry);
      byId.set(id, { ...entry.meta });
    }
    return [...byId.values()]
      .map(session => ({ ...session, live: this.live.has(session.id) }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }
  async find(id) {
    if (this.live.has(id)) {
      this.refreshControls(this.live.get(id));
      return { ...this.live.get(id).meta, live: true };
    }
    return (await this.list()).find(session => session.id === id) ?? null;
  }
  /** Events after a sequence number, from memory for live sessions and from disk otherwise. */
  async events(id, after = 0, limit = 200) {
    const session = await this.find(id);
    if (!session) return null;
    const entry = this.live.get(id);
    let events;
    if (entry && (entry.events[0]?.seq ?? 1) <= after + 1) events = entry.events.filter(event => event.seq > after);
    else {
      if (entry) await entry.writes;
      const file = await this.eventsPath(session);
      let text = '';
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      events = text
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(event => event && event.seq > after);
    }
    const page = events.slice(0, limit);
    return {
      sessionId: id,
      status: session.status,
      live: session.live,
      events: page,
      nextAfter: page.length ? page.at(-1).seq : after,
      more: events.length > page.length,
    };
  }
  wake() {
    for (const waiter of this.waiters) waiter();
  }
  /** Resolves when predicate() is true, the timeout passes, or the signal aborts. */
  async waitFor(predicate, timeoutMs, signal) {
    if (predicate()) return true;
    return new Promise(resolve => {
      const done = value => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const check = () => {
        if (predicate()) done(true);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
