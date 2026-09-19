import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_LOG = 16 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_RESULT = 1024 * 1024;

/** Conservative recovery probe. A reused PID is considered alive: never kill an unverified process. */
export function isRunProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function codexArguments({ schemaPath, outputPath, resumeThreadId, sandboxMode = 'workspace-write', additionalWritableRoots = [], temporaryRoot }) {
  if (!['workspace-write', 'read-only'].includes(sandboxMode)) throw new Error('Unsafe sandbox mode');
  if (resumeThreadId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(resumeThreadId)) throw new Error('Invalid resume thread ID');
  const args = ['exec'];
  if (resumeThreadId) args.push('resume', resumeThreadId);
  args.push('-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandboxMode}"`, '--json', '--color', 'never');
  args.push('-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true');
  if (!Array.isArray(additionalWritableRoots) || additionalWritableRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Writable roots must be absolute host-approved paths');
  if (temporaryRoot !== undefined) {
    if (typeof temporaryRoot !== 'string' || !path.isAbsolute(temporaryRoot)) throw new Error('Temporary root must be an absolute host-approved path');
    additionalWritableRoots = [...additionalWritableRoots, temporaryRoot];
    for (const name of ['TMP', 'TEMP', 'TMPDIR']) args.push('-c', `shell_environment_policy.set.${name}=${JSON.stringify(temporaryRoot)}`);
  }
  if (additionalWritableRoots.length) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(additionalWritableRoots)}`);
  // Resume does not expose --color in this CLI version.
  if (resumeThreadId) args.splice(args.indexOf('--color'), 2);
  if (schemaPath) args.push('--output-schema', path.resolve(schemaPath));
  args.push('--output-last-message', outputPath, '-');
  return args;
}

function stopTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', (code) => { if (code !== 0) child.kill(); resolve(); });
    });
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  return Promise.resolve();
}

/** Runs the locally installed CLI. executable is a trusted host/test setting, never a browser field. */
export async function startCodexRun({ projectRoot, runDirectory, prompt, schemaPath, onEvent = () => {}, signal, resumeThreadId, sandboxMode = 'workspace-write', additionalWritableRoots = [], temporaryRoot, timeoutMs = 60 * 60 * 1000, executable = 'codex', spawnProcess = spawn }) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_RESULT) throw new Error('Invalid or oversized prompt');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) throw new Error('Invalid run timeout');
  if (signal?.aborted) throw new Error('Codex run cancelled');
  await mkdir(runDirectory, { recursive: true });
  const outputPath = path.resolve(runDirectory, 'result.json');
  const args = codexArguments({ schemaPath, outputPath, resumeThreadId, sandboxMode, additionalWritableRoots, temporaryRoot });
  // Exclusive creation prevents reusing stale results or overwriting another run.
  const log = await open(path.join(runDirectory, 'events.jsonl'), 'wx');
  let threadId = resumeThreadId ?? null;
  let failure = null;
  let completed = false;
  let logBytes = 0;
  let exitCode = null;
  let child;
  let timer;
  const abort = () => { failure ??= new Error('Codex run cancelled'); void stopTree(child); };
  try {
    await writeFile(path.join(runDirectory, 'prompt.txt'), prompt, { flag: 'wx' });
    await writeFile(outputPath, '', { flag: 'wx' });
    child = spawnProcess(executable, args, { cwd: path.resolve(projectRoot), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], ...(temporaryRoot ? { env: { ...process.env, TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot } } : {}) });
    const closed = new Promise((resolve) => {
      child.once('error', (error) => { failure ??= error; });
      child.once('close', (code) => resolve(code));
    });
    const fail = (error) => { failure ??= error; void stopTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => fail(new Error('Codex run timed out')), timeoutMs);
    child.stdin.on('error', (error) => fail(error));
    child.stdin.end(prompt);
    // One serialized sink bounds memory and propagates stream backpressure.
    let writes = Promise.resolve();
    const emit = async (event) => {
      const line = `${JSON.stringify(event)}\n`;
      logBytes += Buffer.byteLength(line);
      if (logBytes > MAX_LOG) throw new Error('Codex event log limit exceeded');
      const pending = writes.then(async () => { await log.write(line); await onEvent(event); });
      writes = pending.catch(() => {});
      await pending;
    };
    const consume = async (stream, stderr) => {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      const parse = async (line) => {
        if (!line.trim()) return;
        if (stderr) return emit({ type: 'runner.stderr', text: line });
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Malformed Codex JSONL event'); }
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') failure ??= new Error(`Codex reported ${event.type}: ${JSON.stringify(event.error ?? event.message ?? '')}`);
        await emit(event);
      };
      try {
        for await (const chunk of stream) {
          buffer += decoder.write(chunk);
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            if (newline > MAX_LINE) throw new Error('Codex event line limit exceeded');
            await parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (buffer.length > MAX_LINE) throw new Error('Codex event line limit exceeded');
        }
        buffer += decoder.end();
        if (buffer) await parse(buffer);
      } catch (error) { fail(error); }
    };
    if (child.pid) {
      try { await emit({ type: 'runner.started', pid: child.pid, startedAt: new Date().toISOString() }); }
      catch (error) { fail(error); }
    }
    const readers = [consume(child.stdout, false), consume(child.stderr, true)];
    exitCode = await closed;
    await Promise.all(readers);
    await writes;
    if (failure) throw failure;
    if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}`);
    if (!completed || !threadId) throw new Error('Codex ended without a completed turn and durable thread ID');
    if ((await stat(outputPath)).size > MAX_RESULT) throw new Error('Codex result limit exceeded');
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    await writeFile(path.join(runDirectory, 'completion.json'), JSON.stringify({ threadId, exitCode, status: 'completed' }));
    return { threadId, result, exitCode };
  } catch (error) {
    error.threadId = threadId;
    error.exitCode = exitCode;
    await writeFile(path.join(runDirectory, 'completion.json'), JSON.stringify({ threadId, exitCode, status: 'failed', error: error.message }));
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await log.close();
  }
}
