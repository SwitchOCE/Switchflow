import { spawn } from 'node:child_process';
import { resolveBacklogFork } from '../backlog-fork/runtime.mjs';
import { ControlError } from './lifecycle.mjs';

const MAX_LINE = 24 * 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;

// Reuse Backlog's own request handlers over a private pipe. The shared HTTP
// service is the only listener and owns authentication and agent admission.
export function createNativeBacklog(context, { resolveRuntime = resolveBacklogFork, spawnChild = spawn, timeoutMs = 35000 } = {}) {
  let child = null;
  let stopping = null;
  let starting = null;
  let closed = false;
  let nextId = 0;
  const pending = new Map();
  const children = new Map();
  const terminationRequested = new WeakSet();
  const failPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  // A signal is only a request to stop. Keep pending callers (and their engine
  // admission locks) alive until close proves this writer has settled.
  const stop = (process, error, kill = true) => {
    if (child !== process) return;
    stopping ||= error;
    for (const item of pending.values()) clearTimeout(item.timer);
    if (kill && !terminationRequested.has(process)) {
      terminationRequested.add(process);
      try { process.kill(); } catch { /* Uncertain termination keeps the fence. */ }
    }
  };
  async function start() {
    if (closed) throw new ControlError('The project workspace is stopping.', 503);
    if (child) {
      if (stopping || child.killed || child.exitCode !== null) throw new ControlError('Backlog is still stopping. Wait for the previous operation to settle before retrying.', 503);
      return child;
    }
    if (starting) return starting;
    starting = (async () => {
      const runtime = await resolveRuntime();
      if (closed) throw new ControlError('The project workspace is stopping.', 503);
      const process = spawnChild(runtime.executable, runtime.bridgeArgs || ['switchflow-bridge'], {
        cwd: context.governanceRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = process;
      children.set(process, new Promise(resolve => process.once('close', () => {
        children.delete(process);
        if (child === process) {
          child = null;
          failPending(stopping || new ControlError('Backlog stopped. Inspect the saved record before retrying.', 503));
          stopping = null;
        }
        resolve();
      })));
      let buffer = '';
      let diagnostic = '';
      const fail = message => {
        stop(process, new ControlError(message, 503));
      };
      process.stderr.setEncoding('utf8');
      process.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-2000); });
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', value => {
        if (child !== process || stopping) return;
        buffer += value;
        if (buffer.length > MAX_LINE) { fail('Backlog returned an oversized response. Inspect the saved record before retrying.'); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let reply;
          try { reply = JSON.parse(line); }
          catch { fail('Backlog returned an invalid response. Inspect the saved record before retrying.'); return; }
          if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
            fail('Backlog returned an invalid response. Inspect the saved record before retrying.'); return;
          }
          const item = pending.get(reply.id);
          if (!item) { fail('Backlog returned an unexpected response. Reload the workspace.'); return; }
          if (reply.error) { pending.delete(reply.id); clearTimeout(item.timer); item.reject(new ControlError(String(reply.error), 502)); continue; }
          if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string') {
            fail('Backlog returned an invalid response. Inspect the saved record before retrying.'); return;
          }
          const bytes = Buffer.from(reply.body, 'base64');
          if (bytes.toString('base64') !== reply.body) { fail('Backlog returned invalid response bytes. Inspect the saved record before retrying.'); return; }
          pending.delete(reply.id); clearTimeout(item.timer);
          if (bytes.length > MAX_BODY) { item.reject(new ControlError('Backlog response exceeds the workspace limit.', 502)); continue; }
          item.resolve({ status: reply.status, body: bytes, headers: reply.headers || {} });
        }
      });
      process.on('error', error => fail(`Cannot start the Backlog workspace: ${error.message}`));
      process.stdin.on('error', () => fail('Backlog disconnected. Inspect the saved record before retrying.'));
      process.on('exit', () => {
        if (child !== process) return;
        stop(process, new ControlError(`Backlog stopped. Inspect the saved record before retrying.${diagnostic.trim() ? ` ${diagnostic.trim()}` : ''}`, 503), false);
      });
      return process;
    })();
    try { return await starting; } finally { starting = null; }
  }
  return {
    async request({ method, path, body, contentType }) {
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !/^\/(?:api|assets)\//.test(path) || /[\r\n\0]/.test(path)) throw new ControlError('Invalid Backlog request.');
      if (pending.size >= 64) throw new ControlError('The project is busy. Try again shortly.', 429);
      const process = await start();
      if (closed || stopping || child !== process) throw new ControlError('The Backlog workspace is stopping. Wait before retrying.', 503);
      if (pending.size >= 64) throw new ControlError('The project is busy. Try again shortly.', 429);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          stop(process, new ControlError('Backlog timed out. Inspect the saved record before retrying; the operation may have completed.', 504));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { process.stdin.write(JSON.stringify({ id, method, path, ...(body === undefined ? {} : { body }), ...(contentType ? { contentType } : {}) }) + '\n'); }
        catch { stop(process, new ControlError('Backlog disconnected. Inspect the saved record before retrying.', 503)); }
      });
    },
    async close() {
      closed = true;
      if (starting) await starting.catch(() => {});
      await Promise.all([...children].map(async ([process, closed]) => {
        stop(process, new ControlError('The project workspace stopped.', 503), false);
        const timer = setTimeout(() => stop(process, new ControlError('The project workspace stopped.', 503)), 3000);
        try { process.stdin.end(); } catch { stop(process, new ControlError('The project workspace stopped.', 503)); }
        try { await closed; } finally { clearTimeout(timer); }
      }));
    },
  };
}
