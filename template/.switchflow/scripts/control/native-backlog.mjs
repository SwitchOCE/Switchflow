import { spawn } from 'node:child_process';
import { resolveBacklogFork } from '../backlog-fork/runtime.mjs';
import { ControlError } from './lifecycle.mjs';

const MAX_LINE = 24 * 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;

// Reuse Backlog's own request handlers over a private pipe. The shared HTTP
// service is the only listener and owns authentication and agent admission.
export function createNativeBacklog(context, { resolveRuntime = resolveBacklogFork, spawnChild = spawn, timeoutMs = 35000 } = {}) {
  let child = null;
  let starting = null;
  let closed = false;
  let nextId = 0;
  const pending = new Map();
  const children = new Map();
  const failPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  async function start() {
    if (closed) throw new ControlError('The project workspace is stopping.', 503);
    if (child && !child.killed && child.exitCode === null) return child;
    if (starting) return starting;
    starting = (async () => {
      const runtime = await resolveRuntime();
      if (closed) throw new ControlError('The project workspace is stopping.', 503);
      const process = spawnChild(runtime.executable, runtime.bridgeArgs || ['switchflow-bridge'], {
        cwd: context.governanceRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = process;
      children.set(process, new Promise(resolve => process.once('close', () => { children.delete(process); resolve(); })));
      let buffer = '';
      let diagnostic = '';
      const fail = message => {
        if (child !== process) return;
        child = null;
        failPending(new ControlError(message, 503));
        process.kill();
      };
      process.stderr.setEncoding('utf8');
      process.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-2000); });
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', value => {
        buffer += value;
        if (buffer.length > MAX_LINE) { fail('Backlog returned an oversized response. Inspect the saved record before retrying.'); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let reply;
          try { reply = JSON.parse(line); }
          catch { fail('Backlog returned an invalid response. Inspect the saved record before retrying.'); return; }
          const item = pending.get(reply.id);
          if (!item) { fail('Backlog returned an unexpected response. Reload the workspace.'); return; }
          pending.delete(reply.id); clearTimeout(item.timer);
          if (reply.error) { item.reject(new ControlError(String(reply.error), 502)); continue; }
          if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string') {
            item.reject(new ControlError('Backlog returned an invalid response.', 502)); fail('Backlog connection failed.'); return;
          }
          const bytes = Buffer.from(reply.body, 'base64');
          if (bytes.toString('base64') !== reply.body) { item.reject(new ControlError('Backlog returned invalid response bytes.', 502)); fail('Backlog connection failed.'); return; }
          if (bytes.length > MAX_BODY) { item.reject(new ControlError('Backlog response exceeds the workspace limit.', 502)); continue; }
          item.resolve({ status: reply.status, body: bytes, headers: reply.headers || {} });
        }
      });
      process.on('error', error => fail(`Cannot start the Backlog workspace: ${error.message}`));
      process.stdin.on('error', () => fail('Backlog disconnected. Inspect the saved record before retrying.'));
      process.on('exit', () => {
        if (child !== process) return;
        child = null;
        failPending(new ControlError(`Backlog stopped. Inspect the saved record before retrying.${diagnostic.trim() ? ` ${diagnostic.trim()}` : ''}`, 503));
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
      if (pending.size >= 64) throw new ControlError('The project is busy. Try again shortly.', 429);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (child === process) { child = null; process.kill(); }
          failPending(new ControlError('Backlog timed out. Inspect the saved record before retrying; the operation may have completed.', 504));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        process.stdin.write(JSON.stringify({ id, method, path, ...(body === undefined ? {} : { body }), ...(contentType ? { contentType } : {}) }) + '\n');
      });
    },
    async close() {
      closed = true;
      if (starting) await starting.catch(() => {});
      child = null;
      failPending(new ControlError('The project workspace stopped.', 503));
      await Promise.all([...children].map(async ([process, closed]) => {
        const timer = setTimeout(() => process.kill(), 3000);
        process.stdin.end();
        try { await closed; } finally { clearTimeout(timer); }
      }));
    },
  };
}
