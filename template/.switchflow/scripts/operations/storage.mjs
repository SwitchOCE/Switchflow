import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const git = (cwd, args) => {
  const output = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // NUL-delimited filenames are data: whitespace may be part of a path.
  return args.includes('-z') ? output : output.replace(/\r?\n$/, '');
};
export async function resolveProject(projectPath = process.cwd(), { stateHome = process.env.SWITCHFLOW_HOME } = {}) {
  const sourceRoot = await fs.realpath(git(projectPath, ['rev-parse', '--show-toplevel']));
  const commonDir = await fs.realpath(path.resolve(sourceRoot, git(sourceRoot, ['rev-parse', '--git-common-dir'])));
  const canonical = process.platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  const id = digest(canonical);
  const base = path.resolve(stateHome || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Switchflow') : path.join(os.homedir(), '.local', 'state', 'switchflow')));
  const stateDir = path.join(base, 'projects', id);
  const worktreeRoots = git(sourceRoot, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice(9)));
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (worktreeRoots.some(root => normalize(stateDir) === normalize(root) || normalize(stateDir).startsWith(normalize(root) + path.sep))) throw new Error('Control storage must be outside the source worktree');
  await assertSafePath(stateDir, stateDir);
  try { if (!(await fs.stat(stateDir)).isDirectory()) throw new Error('Control storage is not a directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(stateDir, { recursive: true }); }
  await assertSafePath(stateDir, stateDir);
  const governanceRoot = await fs.realpath(worktreeRoots[0]);
  return { id, sourceRoot, governanceRoot, commonDir, stateDir };
}
// Reject links at every existing path component, including the managed root.
export async function assertSafePath(root, target) {
  root = path.resolve(root); target = path.resolve(target);
  const relative = path.relative(root, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path escapes managed storage');
  let cursor = path.parse(target).root;
  for (const component of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Linked paths are not permitted in managed storage'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}
const agentLedger = name => ['issues', 'evidence', 'worktrees', 'scratch', 'scratch-files'].includes(name) || /^check-[a-f0-9]{64}$/.test(name);
const ledgerDirectory = (context, name) => assertSafePath(context.stateDir, agentLedger(name) ? path.join(context.stateDir, 'operations') : context.stateDir);
export async function withLock(context, name, action, { timeoutMs = 30000 } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid lock name');
  const directory = await ledgerDirectory(context, name);
  await fs.mkdir(directory, { recursive: true });
  const lockPath = await assertSafePath(directory, path.join(directory, `${name}.lock`));
  const deadline = Date.now() + timeoutMs;
  let handle;
  let accessDeadline;
  while (!handle) {
    try { handle = await fs.open(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') {
        accessDeadline = undefined;
        if (Date.now() >= deadline) throw new Error(`Lock busy: ${name}; inspect owner before manual recovery`);
      } else {
        // Windows may deny CREATE_NEW while a competing owner's deleted lock
        // still has a pending kernel handle. Retry creation, never remove or
        // adopt that lock, and do not mask a persistent ACL/permission error.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        accessDeadline ??= Math.min(deadline, Date.now() + 2000);
        if (Date.now() >= accessDeadline) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(0, (accessDeadline ?? deadline) - Date.now()))));
    }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await action(); }
  finally { await handle.close(); await fs.unlink(lockPath); }
}
export async function readState(context, name, fallback = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid state name');
  const directory = await ledgerDirectory(context, name);
  const file = await assertSafePath(directory, path.join(directory, `${name}.json`));
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Preserve ledgers from earlier local candidates. The next locked update
    // writes the separated operations copy; original bytes remain untouched.
    if (agentLedger(name)) {
      const legacy = await assertSafePath(context.stateDir, path.join(context.stateDir, `${name}.json`));
      try { return JSON.parse(await fs.readFile(legacy, 'utf8')); }
      catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
    }
    return structuredClone(fallback);
  }
}
async function renameWithRetry(source, destination) {
  const deadline = Date.now() + 2000;
  let delayMs = 10;
  for (;;) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      // Windows readers and antivirus scanners can briefly prevent replacement.
      // Keep the old destination intact and the writer lock held during retries.
      const remaining = deadline - Date.now();
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}
export async function updateState(context, name, mutate, fallback = {}) {
  return withLock(context, name, async () => {
    const state = await readState(context, name, fallback);
    const next = await mutate(state) ?? state;
    const directory = await ledgerDirectory(context, name);
    const target = await assertSafePath(directory, path.join(directory, `${name}.json`));
    const temporary = target + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
    try { await renameWithRetry(temporary, target); }
    catch (error) {
      try { await fs.unlink(temporary); }
      catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError; }
      throw error;
    }
    return next;
  });
}
