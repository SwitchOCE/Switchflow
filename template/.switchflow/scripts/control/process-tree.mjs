// Leftover-process cleanup for agent sessions. A provider's close ends the agent process it
// started, but programs that agent launched (dev servers, browsers, test runners) can outlive
// it: on Windows an orphan keeps running with no parent to walk from. The tracker therefore
// records each session's descendants while the agent is alive, with their start times, and
// after the session closes stops the ones that are still the same processes.
import { execFile } from 'node:child_process';
import { isRunProcessAlive, stopProcessTree } from './codex-runner.mjs';

// Start times come from different clocks (Windows CIM, `ps` elapsed seconds); allow for rounding.
const SLACK_MS = 2000;
const MAX_RECORDED = 500;

/** "[[dd-]hh:]mm:ss" from `ps -o etime` as milliseconds. */
export function parseElapsed(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!match) return NaN;
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map(part => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Every process on the machine as { pid, ppid, startedAt (ms), name }. */
export function listProcesses({ platform = process.platform, now = Date.now } = {}) {
  const windows = platform === 'win32';
  const [file, args] = windows
    ? [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.Name } }",
        ],
      ]
    : ['ps', ['-A', '-o', 'pid=,ppid=,etime=,comm=']];
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error) return reject(error);
        const at = now();
        const processes = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          if (!line.trim()) continue;
          let pid;
          let ppid;
          let startedAt;
          let name;
          if (windows) {
            const [a, b, c, ...rest] = line.split('|');
            [pid, ppid, startedAt, name] = [Number(a), Number(b), Date.parse(c), rest.join('|')];
          } else {
            const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
            if (!match) continue;
            [pid, ppid, startedAt, name] = [Number(match[1]), Number(match[2]), at - parseElapsed(match[3]), match[4]];
          }
          if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startedAt))
            processes.push({ pid, ppid, startedAt, name: String(name).trim().slice(0, 120) });
        }
        resolve(processes);
      },
    ),
  );
}

/**
 * Descendants of root in one snapshot. A child counts only when it started no earlier than its
 * parent, so a stale parent PID that was reused by an unrelated process does not adopt children.
 */
export function descendantsOf(processes, root) {
  const children = new Map();
  for (const entry of processes) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = [];
  const seen = new Set([root.pid]);
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const child of children.get(parent.pid) || []) {
      if (seen.has(child.pid) || child.startedAt < parent.startedAt - SLACK_MS) continue;
      seen.add(child.pid);
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/** PIDs of this service and its ancestors: never stopped, whatever a record says. */
export function protectedPids(processes, self = process.pid) {
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  const result = new Set([self]);
  let current = byPid.get(self);
  while (current && !result.has(current.ppid) && current.ppid > 0) {
    result.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return result;
}

/**
 * Per-host record of each session's agent process and what it started. track() is called with
 * every PID the provider reports; sample() snapshots descendants; cleanup() stops survivors.
 */
export class ProcessTracker {
  constructor({
    list = listProcesses,
    stop = stopProcessTree,
    alive = isRunProcessAlive,
    clock = Date.now,
    sampleMs = 30000,
    self = process.pid,
  } = {}) {
    Object.assign(this, { list, stop, alive, clock, sampleMs, self });
    this.sessions = new Map(); // sessionId -> { openedAt, roots: Map(pid -> startedAt|null), recorded: Map(pid -> entry) }
    this.timer = null;
  }
  /** Called before the provider starts anything: no process older than this belongs to the session. */
  begin(sessionId) {
    if (!this.sessions.has(sessionId))
      this.sessions.set(sessionId, { openedAt: this.clock(), roots: new Map(), recorded: new Map() });
  }
  track(sessionId, pid) {
    this.begin(sessionId);
    const session = this.sessions.get(sessionId);
    if (Number.isSafeInteger(pid) && pid > 0 && !session.roots.has(pid)) session.roots.set(pid, null);
    this.schedule();
  }
  untrack(sessionId) {
    this.sessions.delete(sessionId);
    if (!this.sessions.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  schedule() {
    if (this.timer || !this.sampleMs) return;
    this.timer = setInterval(() => void this.sample().catch(() => {}), this.sampleMs);
    this.timer.unref?.();
  }
  /** True when a snapshot could find anything for these sessions. Avoids a process listing otherwise. */
  worthListing(sessions) {
    return sessions.some(session => session.recorded.size || [...session.roots.keys()].some(pid => this.alive(pid)));
  }
  /** Records the current descendants of each tracked (or the named) session's agent processes. */
  async sample(sessionId = null) {
    const sessions = sessionId ? [this.sessions.get(sessionId)].filter(Boolean) : [...this.sessions.values()];
    if (!sessions.length || !this.worthListing(sessions)) return;
    const processes = await this.list();
    const byPid = new Map(processes.map(entry => [entry.pid, entry]));
    for (const session of sessions) {
      for (const [pid, startedAt] of session.roots) {
        const live = byPid.get(pid);
        if (!live) continue;
        // A root must be a process started for this session, not an older one that shares the PID.
        if (startedAt === null) {
          if (live.startedAt < session.openedAt - SLACK_MS) {
            session.roots.delete(pid);
            continue;
          }
          session.roots.set(pid, live.startedAt);
        } else if (Math.abs(live.startedAt - startedAt) > SLACK_MS) continue;
        for (const child of descendantsOf(processes, live))
          if (session.recorded.size < MAX_RECORDED && !session.roots.has(child.pid))
            session.recorded.set(child.pid, child);
      }
    }
  }
  /**
   * Stops what is left of a closed session: its recorded descendants and any agent process that
   * is still the same process. Never this service, its ancestors, or another session's process.
   * Returns the stopped processes as [{ pid, name }].
   */
  async cleanup(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const verifiedRoots = [...session.roots].filter(([, startedAt]) => startedAt !== null);
    if (!session.recorded.size && !verifiedRoots.some(([pid]) => this.alive(pid))) return [];
    const processes = await this.list();
    const byPid = new Map(processes.map(entry => [entry.pid, entry]));
    const keep = protectedPids(processes, this.self);
    for (const [id, other] of this.sessions) {
      if (id === sessionId) continue;
      for (const pid of other.roots.keys()) keep.add(pid);
      for (const pid of other.recorded.keys()) keep.add(pid);
    }
    const candidates = [
      ...verifiedRoots.map(([pid, startedAt]) => ({ pid, startedAt, name: byPid.get(pid)?.name ?? '' })),
      ...session.recorded.values(),
    ];
    const targets = candidates.filter(entry => {
      const live = byPid.get(entry.pid);
      return live && !keep.has(entry.pid) && Math.abs(live.startedAt - entry.startedAt) <= SLACK_MS;
    });
    const stopped = [];
    for (const entry of targets) {
      // Stopping a tree can take later targets with it; those count as stopped too.
      const result = this.alive(entry.pid) ? await this.stop(entry.pid) : false;
      if (result || !this.alive(entry.pid)) stopped.push({ pid: entry.pid, name: byPid.get(entry.pid).name || '' });
    }
    return stopped;
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.sessions.clear();
  }
}
