import { execFile, spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertSafePath, digest, readState, stable, updateState } from '../operations/storage.mjs';
import { candidateGrant, candidateLocation, verifyCandidateCheckout } from './artifacts.mjs';
import { isRunProcessAlive } from './codex-runner.mjs';
import { ControlError } from './lifecycle.mjs';

// The UAT preview runs the delivered candidate with the owner's own permissions, outside any
// agent sandbox. Its command therefore comes only from owner-edited configuration, is shown
// before it runs, and must match the exact command the owner saw (see docs/browser-control.md).
export const PREVIEW_CONFIG = '.switchflow/preview.json';
const CONFIG_KEYS = ['schemaVersion', 'command', 'args', 'cwd', 'port', 'env'];
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_LINES = 200;
const SHOWN_LINES = 40;
const MAX_LINE = 2000;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LOOPBACK_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?:\/[^\s'"<>`]*)?/i;
const unsafeText = /[\x00-\x1f\x7f]/;
const invalid = message => new ControlError(`${PREVIEW_CONFIG}: ${message}`, 409);

const quote = value => (/^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`);

/** Validates owner preview configuration. Throws a ControlError naming the first problem. */
export function validatePreviewConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('expected a JSON object.');
  const unknown = Object.keys(value).filter(key => !CONFIG_KEYS.includes(key));
  if (unknown.length) throw invalid(`unsupported field ${unknown[0]}.`);
  if (value.schemaVersion !== 1) throw invalid('schemaVersion must be 1.');
  const { command, args = [], cwd = '', port = null, env = {} } = value;
  if (
    typeof command !== 'string' ||
    !command ||
    command.length > 400 ||
    unsafeText.test(command) ||
    !(/^[A-Za-z0-9._+-]{1,100}$/.test(command) || path.isAbsolute(command))
  )
    throw invalid(
      'command must be a program name on PATH (such as npm) or an absolute program path, without arguments.',
    );
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some(arg => typeof arg !== 'string' || arg.length > 1000 || unsafeText.test(arg))
  )
    throw invalid('args must be a list of at most 64 single-line strings.');
  if (
    typeof cwd !== 'string' ||
    cwd.length > 300 ||
    unsafeText.test(cwd) ||
    cwd.includes('\\') ||
    path.posix.isAbsolute(cwd) ||
    /^[A-Za-z]:/.test(cwd) ||
    (cwd && cwd.split('/').some(part => !part || part === '.' || part === '..'))
  )
    throw invalid('cwd must be a folder inside the candidate, written with forward slashes and no "..".');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw invalid('port must be a whole number from 1 to 65535.');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 32)
    throw invalid('env must be an object of at most 32 variables.');
  for (const [key, entry] of Object.entries(env))
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
      typeof entry !== 'string' ||
      entry.length > 1000 ||
      unsafeText.test(entry)
    )
      throw invalid(`env.${key} must be a single-line string with a plain variable name.`);
  const normalized = { command, args: [...args], cwd, port, env: { ...env } };
  return {
    ...normalized,
    display: [command, ...args].map(quote).join(' '),
    hash: digest(stable(normalized)),
  };
}

/** Reads `.switchflow/preview.json` from the primary checkout. Absent means "not configured". */
export async function readPreviewConfig(context) {
  const file = path.join(context.governanceRoot, ...PREVIEW_CONFIG.split('/'));
  let text;
  try {
    await assertSafePath(context.governanceRoot, file);
    const info = await fs.lstat(file);
    if (!info.isFile()) return { configured: false, error: `${PREVIEW_CONFIG} must be a regular file.` };
    if (info.size > MAX_CONFIG_BYTES) return { configured: false, error: `${PREVIEW_CONFIG} is larger than 16 KiB.` };
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { configured: false, error: null };
    return { configured: false, error: `${PREVIEW_CONFIG} could not be read: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { configured: false, error: `${PREVIEW_CONFIG} is not valid JSON.` };
  }
  try {
    return { configured: true, error: null, ...validatePreviewConfig(parsed) };
  } catch (error) {
    return { configured: false, error: error.message };
  }
}

async function regularFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the program without a shell and without searching the candidate's working folder.
 * Windows npm/npx are `.cmd` wrappers that cannot run shell-free, so they run as Node scripts.
 */
export async function resolveExecutable(
  command,
  { platform = process.platform, env = process.env, execPath = process.execPath, isFile = regularFile } = {},
) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const wrapper = new ControlError(
    `"${command}" is a Windows command script, which needs a shell. Set command to the program it wraps (for example "node" with the script path in args).`,
    409,
  );
  if (paths.isAbsolute(command)) {
    if (windows && /\.(?:cmd|bat)$/i.test(command)) throw wrapper;
    if (!(await isFile(command))) throw new ControlError(`The preview program was not found: ${command}`, 409);
    return { file: command, prefix: [] };
  }
  const name = windows ? command.toLowerCase().replace(/\.(?:exe|cmd)$/, '') : command;
  if (name === 'node') return { file: execPath, prefix: [] };
  const directories = (env.PATH ?? env.Path ?? '')
    .split(windows ? ';' : ':')
    .filter(directory => directory && paths.isAbsolute(directory));
  if (windows && ['npm', 'npx'].includes(name)) {
    for (const directory of [paths.dirname(execPath), ...directories]) {
      const script = paths.join(directory, 'node_modules', 'npm', 'bin', `${name}-cli.js`);
      if (await isFile(script)) return { file: execPath, prefix: [script] };
    }
    throw new ControlError(
      `${name} was not found next to Node. Set command to "node" with the path of ${name}-cli.js as the first argument.`,
      409,
    );
  }
  const extensions = windows && !/\.(?:exe|com)$/i.test(command) ? ['.exe', '.com'] : [''];
  for (const directory of directories)
    for (const extension of extensions) {
      const file = paths.join(directory, command + extension);
      if (await isFile(file)) return { file, prefix: [] };
    }
  if (windows)
    for (const directory of directories)
      for (const extension of ['.cmd', '.bat'])
        if (await isFile(paths.join(directory, command + extension))) throw wrapper;
  throw new ControlError(`The preview program "${command}" was not found on PATH.`, 409);
}

/** Picks the registered candidate the delivery evidence names; the owner can choose another. */
export function suggestCandidate(entries, evidence) {
  const text = (Array.isArray(evidence) ? evidence : [])
    .filter(line => typeof line === 'string')
    .join('\n')
    .replaceAll('\\', '/')
    .toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const score =
      (text.includes(entry.path.replaceAll('\\', '/').toLowerCase()) ? 4 : 0) +
      (typeof entry.lastHead === 'string' && text.includes(entry.lastHead.slice(0, 7)) ? 2 : 0) +
      (entry.lastHead !== entry.baseHead ? 1 : 0);
    if (score >= bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

export function portAccepts(port, timeoutMs = 400) {
  const attempt = host =>
    new Promise(resolve => {
      const socket = net.connect({ host, port });
      const done = open => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return Promise.all([attempt('127.0.0.1'), attempt('::1')]).then(results => results.some(Boolean));
}

/** Stops the whole process tree: dev servers commonly start their own children. */
export function killProcessTree(pid, child) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    child?.kill();
    return Promise.resolve();
  }
  if (process.platform === 'win32')
    return new Promise(resolve => {
      const killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child?.kill();
        resolve();
      });
      killer.once('close', code => {
        if (code !== 0) child?.kill();
        resolve();
      });
    });
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already stopped. */
    }
  }
  return Promise.resolve();
}

/** Creation time of a process in epoch milliseconds, or null when it cannot be established. */
export function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  const [file, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ],
        ]
      : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
  return new Promise(resolve =>
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      const time = error ? NaN : Date.parse(String(stdout).trim());
      resolve(Number.isFinite(time) ? time : null);
    }),
  );
}

function eligibility(state, item) {
  if (!item) return 'Initiative not found.';
  if (item.stage !== 'uat' || item.approvedUat)
    return 'A preview runs only while a delivered candidate waits for your UAT decision.';
  if (item.status !== 'awaiting-human' || item.pending || state.activeRun?.initiativeId === item.id)
    return 'Wait for the agent to finish this stage before starting a preview.';
  if (!item.approvedPlan?.gitGrantHash) return 'This delivery has no approved Git grant, so its candidate is unknown.';
  return '';
}

/** One locally running preview per project, started only by the owner. */
export class PreviewManager {
  constructor(
    context,
    {
      engine,
      spawn = spawnProcess,
      killTree = killProcessTree,
      processStartedAt = processStartTime,
      processAlive = isRunProcessAlive,
      resolveCommand = resolveExecutable,
      probePort = portAccepts,
      pollMs = 500,
      stopTimeoutMs = 10000,
    } = {},
  ) {
    Object.assign(this, {
      context,
      engine,
      spawn,
      killTree,
      processStartedAt,
      processAlive,
      resolveCommand,
      probePort,
      pollMs,
      stopTimeoutMs,
    });
    this.queue = Promise.resolve();
    this.current = null;
    this.last = null;
    this.notice = null;
    this.closed = false;
  }
  serial(action) {
    const run = this.queue.then(action);
    this.queue = run.catch(() => {});
    return run;
  }
  /** A preview the previous service session recorded is its own child: stop it, if it is still that process. */
  async recover() {
    const saved = await readState(this.context, 'preview', null);
    if (!Number.isSafeInteger(saved?.pid) || saved.pid <= 0) return;
    if (this.processAlive(saved.pid)) {
      const started = await this.processStartedAt(saved.pid);
      const recorded = Date.parse(saved.startedAt);
      if (started !== null && Number.isFinite(recorded) && Math.abs(started - recorded) < 30000) {
        await this.killTree(saved.pid);
        this.notice = `Stopped a preview (process ${saved.pid}) left running by the previous service session.`;
      } else
        this.notice = `A preview process recorded by the previous service session (${saved.pid}) could not be confirmed, so it was left alone. If its port is still busy, stop that program yourself.`;
    }
    await updateState(this.context, 'preview', () => ({ schemaVersion: 1, pid: null }));
  }
  runtime() {
    const record = this.current || this.last;
    const notice = this.notice ? { notice: this.notice } : {};
    if (!record) return { state: 'idle', ...notice };
    return {
      state: record.state,
      initiativeId: record.initiativeId,
      candidate: record.candidate,
      head: record.head,
      command: record.command,
      url: record.url,
      pid: record.pid,
      startedAt: record.startedAt,
      exitCode: record.exitCode,
      reason: record.reason,
      logs: record.logs.slice(-SHOWN_LINES),
      ...notice,
    };
  }
  async status(initiativeId) {
    const state = await this.engine.read();
    const item = state.initiatives.find(entry => entry.id === initiativeId);
    if (!item) throw new ControlError('Initiative not found.', 404);
    await this.reconcile(state);
    const config = await readPreviewConfig(this.context);
    const reason = eligibility(state, item);
    let candidates = [];
    let suggested = null;
    let candidateError = null;
    if (!reason)
      try {
        const grant = await candidateGrant(this.context, item);
        candidates = grant.entries.map(entry => ({ name: entry.name, path: entry.path, head: entry.lastHead }));
        suggested = suggestCandidate(grant.entries, item.evidence)?.name || null;
        if (!candidates.length) candidateError = 'No managed candidate is registered for this delivery.';
      } catch (error) {
        candidateError = error.message;
      }
    return {
      configPath: PREVIEW_CONFIG,
      configured: config.configured,
      configError: config.error,
      command: config.configured
        ? {
            display: config.display,
            hash: config.hash,
            cwd: config.cwd,
            port: config.port,
            env: Object.keys(config.env),
          }
        : null,
      eligible: !reason,
      reason: reason || null,
      candidates,
      suggested,
      candidateError,
      runtime: this.runtime(),
    };
  }
  /** Ends a preview whose UAT is no longer waiting, whatever path ended it. */
  async reconcile(state) {
    const record = this.current;
    if (!record || record.stopping) return;
    const item = state.initiatives.find(entry => entry.id === record.initiativeId);
    if (!item || item.stage !== 'uat' || item.approvedUat)
      await this.stop(record.initiativeId, 'Stopped because this initiative left UAT.');
  }
  async start(initiativeId, input = {}) {
    if (Object.keys(input).some(key => !['commandHash', 'candidate'].includes(key)))
      throw new ControlError('Only commandHash and candidate can be supplied.');
    if (typeof input.commandHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.commandHash))
      throw new ControlError('Start the preview from the command shown in the board.');
    if (input.candidate !== undefined && (typeof input.candidate !== 'string' || input.candidate.length > 40))
      throw new ControlError('Choose a registered candidate.');
    return this.serial(async () => {
      if (this.closed) throw new ControlError('The service is stopping.', 503);
      const state = await this.engine.read();
      const item = state.initiatives.find(entry => entry.id === initiativeId);
      if (!item) throw new ControlError('Initiative not found.', 404);
      const reason = eligibility(state, item);
      if (reason) throw new ControlError(reason, 409);
      if (this.current)
        throw new ControlError(
          this.current.initiativeId === initiativeId
            ? 'This preview is already running. Stop it before starting it again.'
            : 'A preview for another initiative is running. Stop it first: one preview runs per project.',
          409,
        );
      const config = await readPreviewConfig(this.context);
      if (!config.configured)
        throw new ControlError(config.error || `Add ${PREVIEW_CONFIG} to configure the preview command.`, 409);
      if (input.commandHash !== config.hash)
        throw new ControlError(
          'The preview command changed since it was shown. Review the current command, then start again.',
          409,
        );
      const grant = await candidateGrant(this.context, item);
      const entry =
        input.candidate === undefined
          ? suggestCandidate(grant.entries, item.evidence)
          : grant.entries.find(value => value.name === input.candidate);
      if (!entry) throw new ControlError('Choose a candidate registered for this delivery.', 409);
      const location = await candidateLocation(grant, entry);
      const { git } = await verifyCandidateCheckout(this.context, location);
      if (await git(location.candidate, ['status', '--porcelain', '--untracked-files=no']))
        throw new ControlError(
          'The candidate has uncommitted changes to tracked files, so a preview would not show the delivered commit.',
          409,
        );
      const cwd = await assertSafePath(location.candidate, path.join(location.candidate, ...config.cwd.split('/')));
      if (!(await fs.stat(cwd).catch(() => null))?.isDirectory())
        throw new ControlError(`The preview folder ${config.cwd} does not exist in the candidate.`, 409);
      if (config.port && (await this.probePort(config.port)))
        throw new ControlError(
          `Port ${config.port} is already in use. Stop the program using it, then start the preview.`,
          409,
        );
      const { file, prefix } = await this.resolveCommand(config.command);
      const record = {
        initiativeId,
        candidate: entry.name,
        head: location.head,
        command: config.display,
        port: config.port,
        state: 'starting',
        url: null,
        logs: [],
        startedAt: new Date().toISOString(),
        pid: null,
        exitCode: null,
        reason: null,
      };
      let child;
      try {
        child = this.spawn(file, [...prefix, ...config.args], {
          cwd,
          env: {
            ...process.env,
            BROWSER: 'none',
            HOST: '127.0.0.1',
            ...(config.port ? { PORT: String(config.port) } : {}),
            ...config.env,
          },
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        throw new ControlError(`The preview could not start: ${error.message}`, 409);
      }
      record.child = child;
      record.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
      this.current = record;
      this.last = null;
      this.notice = null;
      this.watch(record);
      if (record.pid)
        try {
          await updateState(this.context, 'preview', () => ({
            schemaVersion: 1,
            pid: record.pid,
            initiativeId,
            candidate: entry.name,
            startedAt: record.startedAt,
          }));
        } catch (error) {
          await this.stopNow(null, `Stopped because its process record could not be saved: ${error.message}`);
          throw new ControlError(`The preview was stopped: its process record could not be saved.`, 500);
        }
      return this.runtime();
    });
  }
  watch(record) {
    const { child } = record;
    const line = text => {
      const clean = text.replace(ANSI, '').slice(0, MAX_LINE);
      if (!clean.trim()) return;
      record.logs.push(clean);
      if (record.logs.length > MAX_LINES) record.logs.splice(0, record.logs.length - MAX_LINES);
      if (record.url || record.state !== 'starting') return;
      const match = LOOPBACK_URL.exec(clean);
      const port = match && Number(match[1] || (match[0].startsWith('https') ? 443 : 80));
      if (match && port > 0 && port < 65536 && (!record.port || record.port === port)) {
        record.url = match[0].replace(/[.,;:)\]]+$/, '');
        record.state = 'running';
      }
    };
    for (const stream of [child.stdout, child.stderr].filter(Boolean)) {
      const decoder = new StringDecoder('utf8');
      let partial = '';
      stream.on('data', chunk => {
        const parts = (partial + decoder.write(chunk)).split(/\r?\n|\r/);
        partial = parts.pop();
        if (partial.length > MAX_LINE) {
          parts.push(partial);
          partial = '';
        }
        parts.forEach(line);
      });
      stream.on('end', () => {
        line(partial + decoder.end());
        partial = '';
      });
    }
    child.on('error', error => {
      record.error = error.message;
      // A failed spawn has no process to close; settle it here.
      if (!record.pid) setImmediate(() => this.exited(record, null, null));
    });
    child.on('close', (code, signal) => this.exited(record, code, signal));
    if (record.port) {
      let probing = false;
      record.timer = setInterval(async () => {
        if (probing || record.state !== 'starting') return;
        probing = true;
        try {
          if ((await this.probePort(record.port)) && record.state === 'starting' && !record.url) {
            record.url = `http://localhost:${record.port}/`;
            record.state = 'running';
          }
        } finally {
          probing = false;
        }
      }, this.pollMs);
      record.timer.unref?.();
    }
  }
  exited(record, code, signal) {
    if (record.done) return;
    record.done = true;
    clearInterval(record.timer);
    record.exitCode = code;
    if (record.stopping) record.state = 'stopped';
    else if (record.error) {
      record.state = 'failed';
      record.reason = `The preview could not start: ${record.error}`;
    } else if (code === 0) {
      record.state = 'stopped';
      record.reason = 'The preview program finished on its own.';
    } else {
      record.state = 'failed';
      record.reason = `The preview stopped unexpectedly (${code === null ? `signal ${signal}` : `exit code ${code}`}).`;
    }
    delete record.child;
    if (this.current === record) this.current = null;
    this.last = record;
    record.cleared = record.pid
      ? updateState(this.context, 'preview', saved =>
          saved?.pid === record.pid ? { schemaVersion: 1, pid: null } : saved,
        ).catch(error => {
          this.notice = `The stopped preview's process record could not be cleared: ${error.message}`;
        })
      : Promise.resolve();
    record.settle?.();
  }
  /** Stops the project's preview; with an initiative ID, only that initiative's preview. */
  async stop(initiativeId = null, reason = 'Stopped by you.') {
    return this.serial(() => this.stopNow(initiativeId, reason));
  }
  async stopNow(initiativeId, reason) {
    const record = this.current;
    if (!record || (initiativeId && record.initiativeId !== initiativeId)) return this.runtime();
    record.stopping = true;
    record.state = 'stopping';
    record.reason = reason;
    const settled = new Promise(resolve => {
      record.settle = resolve;
      if (record.done) resolve();
    });
    await this.killTree(record.pid, record.child);
    let timer;
    await Promise.race([settled, new Promise(resolve => (timer = setTimeout(resolve, this.stopTimeoutMs)))]);
    clearTimeout(timer);
    if (!record.done)
      record.reason = `Stop was requested, but process ${record.pid} has not exited yet. Try Stop again.`;
    await record.cleared;
    return this.runtime();
  }
  async close() {
    this.closed = true;
    await this.serial(async () => {
      await this.stopNow(null, 'Stopped because the service stopped.');
      await this.last?.cleared;
    });
  }
}
