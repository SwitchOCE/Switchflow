import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { digest, stable, git, readState, updateState, withLock } from './storage.mjs';
import { stopCheckTree } from './check-process.mjs';

export async function captureCandidate(context) {
  const head = git(context.sourceRoot, ['rev-parse', 'HEAD']);
  const files = git(context.sourceRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    const target = path.join(context.sourceRoot, file);
    try {
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) throw new Error(`Submodule/directory requires explicit separate evidence: ${file}`);
      entries.push([file, stat.mode, stat.isSymbolicLink() ? `link:${await fs.readlink(target)}` : digest(await fs.readFile(target))]);
    } catch (error) { if (error.code === 'ENOENT') entries.push([file, 'deleted']); else throw error; }
  }
  return { head, digest: digest(stable({ head, entries })) };
}
export function createEnvironmentTag({ environment = process.env, inputs = {}, docker = false } = {}) {
  let dockerRuntime = null;
  if (docker) dockerRuntime = execFileSync('docker', ['version', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 10000 });
  return { digest: digest(stable({ platform: process.platform, arch: process.arch, node: process.version, environment, inputs, dockerRuntime })), platform: process.platform, node: process.version, dockerRuntimeChecked: Boolean(dockerRuntime), proof: 'local-process' };
}
export async function runCheck(context, { command, args = [], scope, environment = process.env, inputs = {}, docker = false, timeoutMs = 300000, reuse = true }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('Command and string argument array required');
  if (!scope || (typeof scope !== 'string' && typeof scope !== 'object')) throw new Error('Explicit evidence scope required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) throw new Error('Invalid check timeout');
  const candidate = await captureCandidate(context);
  const environmentTag = createEnvironmentTag({ environment, inputs, docker });
  const key = digest(stable({ candidate, command, args, scope, environment: environmentTag.digest, cwd: context.sourceRoot }));
  return withLock(context, `check-${key}`, async () => {
    // A waiter must not reuse a result after the working copy changed.
    if ((await captureCandidate(context)).digest !== candidate.digest) throw new Error('Candidate changed while waiting for check');
    const previous = (await readState(context, 'evidence', { entries: [] })).entries.findLast(e => e.key === key);
    if (reuse && previous?.exitCode === 0 && !previous.candidateChanged && !previous.timedOut) return { ...previous, reused: true };
    const startedAt = new Date().toISOString();
    const execution = await new Promise(resolve => {
      let output = '', timedOut = false, settled = false;
      const child = spawn(command, args, { cwd: context.sourceRoot, env: environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = data => { output = (output + data.toString()).slice(-128 * 1024); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const timer = setTimeout(() => { timedOut = true; stopCheckTree(child); }, timeoutMs);
      const done = result => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...result, timedOut, output }); };
      child.on('error', error => done({ exitCode: null, error: error.message }));
      child.on('close', (exitCode, signal) => done({ exitCode, signal }));
    });
    const candidateChanged = (await captureCandidate(context)).digest !== candidate.digest;
    const entry = { key, candidate, command, args, scope, environment: environmentTag, startedAt, completedAt: new Date().toISOString(), ...execution, candidateChanged, reused: false, proof: 'local-process' };
    await updateState(context, 'evidence', state => { state.entries.push(entry); }, { entries: [] });
    return entry;
  }, { timeoutMs: timeoutMs + 30000 });
}
