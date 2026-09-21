import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withLock } from '../operations/storage.mjs';
import { hash, text, ControlError } from './lifecycle.mjs';

const exec = promisify(execFile);
export async function findBacklog(context) {
  try {
    const { resolveBacklogFork } = await import('../backlog-fork/runtime.mjs');
    return (await resolveBacklogFork()).cliPath;
  } catch { /* Original Backlog remains readable until the pinned CAS runtime is set up. */ }
  const expected = JSON.parse(await fs.readFile(path.join(context.sourceRoot, '.switchflow', 'package.json'), 'utf8')).devDependencies['backlog.md'];
  for (const root of new Set([context.sourceRoot, context.governanceRoot])) {
    if (!root) continue;
    const directory = path.join(root, '.switchflow', 'node_modules', 'backlog.md');
    try {
      const installed = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (installed.version === expected) return path.join(directory, 'cli.js');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Install pinned Backlog ${expected}: npm --prefix .switchflow ci --ignore-scripts`);
}

export function callBacklogTool(cliPath, root, name, args, { spawnChild = spawn, executable, timeoutMs = 30000, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('Invalid Backlog transport limits');
    if (!executable) {
      const require = createRequire(cliPath);
      executable = require(path.join(path.dirname(cliPath), 'resolveBinary.cjs')).resolveBinaryPath();
    }
    const child = spawnChild(executable, ['mcp', 'start'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let outcome = null;
    let initialized = false;
    let buffer = '';
    let outputBytes = 0;
    // Signalling a writer is not proof it stopped. Keep the caller's board and
    // engine admission locks held until close, even when termination fails.
    const stop = (error, result, kill = true) => {
      if (outcome) return;
      outcome = { error, result }; clearTimeout(timer); buffer = '';
      try { child.stdin.end(); } catch { /* close remains the settlement fence. */ }
      if (kill) try { child.kill(); } catch { /* Uncertain termination keeps admission. */ }
    };
    const timer = setTimeout(() => stop(new Error('Backlog update timed out. Inspect the current task before retrying.')), timeoutMs);
    const send = message => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
      catch (error) { stop(error); }
    };
    child.on('error', error => stop(error));
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', error => stop(error));
    child.stderr.resume();
    child.on('exit', code => stop(new Error(`Backlog stopped before confirming the update (${code}). Inspect the current task.`), undefined, false));
    child.once('close', code => {
      clearTimeout(timer);
      outcome ||= { error: new Error(`Backlog stopped before confirming the update (${code}). Inspect the current task.`) };
      outcome.error ? reject(outcome.error) : resolve(outcome.result);
    });
    const receive = line => {
      if (outcome || !line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid Backlog response');
        if (msg.error) throw new Error(msg.error.message);
        if (msg.id === 1 && !initialized) {
          initialized = true;
          send({ method: 'notifications/initialized' });
          if (!outcome) send({ id: 2, method: 'tools/call', params: { name, arguments: args } });
        } else if (msg.id === 2 && initialized) {
          if (!msg.result || typeof msg.result !== 'object' || Array.isArray(msg.result) || msg.result.isError) throw new Error(msg.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Backlog rejected the update.');
          stop(null, msg.result);
        } else if (msg.id !== undefined || typeof msg.method !== 'string') throw new Error('Unexpected Backlog response');
      } catch (error) { stop(error); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (outcome) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) { stop(new Error('Backlog response exceeds the transport limit. Inspect the current task before retrying.')); return; }
      buffer += chunk;
      let newline;
      while (!outcome && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        receive(line);
      }
    });
    child.stdout.on('end', () => { if (!outcome && buffer) receive(buffer); });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'switchflow-control', version: '0.4.0' } } });
  });
}

export function createBacklogAdapter(context, { cliPath, execute = exec, callTool = callBacklogTool } = {}) {
  const root = context.governanceRoot || context.sourceRoot;
  let selectedCli;
  const cli = async () => selectedCli ||= cliPath || await findBacklog(context);
  const read = async args => {
    const { stdout } = await execute(process.execPath, [await cli(), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const view = async id => {
    if (!/^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/i.test(id)) throw new ControlError('Invalid task ID.');
    const task = (await read(['task', 'view', id, '--json'])).task;
    if (!task) throw new ControlError('Task not found.', 404);
    const atomicRevision = typeof task.revision === 'string' && /^[a-f0-9]{64}$/.test(task.revision);
    return { ...task, revision: atomicRevision ? task.revision : hash(task), atomicRevision };
  };
  const viewMilestone = async id => {
    if (!/^m-\d+$/i.test(id)) throw new ControlError('Invalid milestone ID.');
    const result = await read(['milestone', 'view', id, '--json']);
    const milestone = result.milestone || result;
    if (!milestone?.id) throw new ControlError('Milestone not found.', 404);
    const atomicRevision = typeof milestone.revision === 'string' && /^[a-f0-9]{64}$/.test(milestone.revision);
    return { ...milestone, atomicRevision };
  };
  const optionalText = (value, name, limit) => {
    if (typeof value !== 'string' || value.length > limit) throw new ControlError(`${name} must be text of at most ${limit} characters.`);
    return value.trim();
  };
  return {
    async listMilestones() {
      const result = await read(['milestone', 'list', '--json']);
      return Array.isArray(result) ? result : result.milestones || [];
    },
    viewMilestone,
    async editMilestone(id, input) {
      if (Object.keys(input).some(key => !['expectedRevision', 'title', 'description', 'labels', 'executionOrder'].includes(key))) throw new ControlError('Unsupported milestone field.');
      const changes = {};
      if (input.title !== undefined) changes.title = text(input.title, 'Title', 240);
      if (input.description !== undefined) changes.description = optionalText(input.description, 'Description', 120000);
      if (input.labels !== undefined) {
        if (!Array.isArray(input.labels) || input.labels.length > 30 || input.labels.some(label => typeof label !== 'string' || !label.trim() || label.length > 80 || label.includes(','))) throw new ControlError('Labels must be a list of up to 30 names, each 1-80 characters without commas.');
        changes.labels = [...new Set(input.labels.map(label => label.trim()))];
      }
      if (input.executionOrder !== undefined) {
        if (input.executionOrder !== null && (!Number.isSafeInteger(input.executionOrder) || input.executionOrder < 0)) throw new ControlError('Execution order must be a non-negative integer, or empty.');
        changes.executionOrder = input.executionOrder;
      }
      if (!Object.keys(changes).length) throw new ControlError('No milestone change supplied.');
      return withLock(context, 'board-edit', async () => {
        const before = await viewMilestone(id);
        if (!before.atomicRevision) throw new ControlError('Safe editing needs the pinned Backlog CAS runtime. Set it up, then restart this board.', 503);
        if (before.revision !== input.expectedRevision) throw new ControlError('This milestone changed. Load the latest version before saving your draft.', 409);
        try { await callTool(await cli(), root, 'milestone_edit', { id, expectedRevision: input.expectedRevision, ...changes }); }
        catch (error) {
          if (/revision|stale|conflict|lock|busy/i.test(error.message)) throw new ControlError('This milestone changed or is being edited. Load the latest version before saving your draft.', 409);
          throw error;
        }
        return viewMilestone(id);
      });
    },
    async list() { return (await read(['task', 'list', '--json'])).tasks || []; },
    view,
    async edit(id, input) {
      if (Object.keys(input).some(key => !['expectedRevision', 'title', 'description', 'blockReason'].includes(key))) throw new ControlError('Only title, description and block reason can be edited here.');
      const title = input.title === undefined ? undefined : text(input.title, 'Title', 240);
      const description = input.description === undefined ? undefined : text(input.description, 'Description', 10000);
      const blockReason = input.blockReason === undefined ? undefined : optionalText(input.blockReason, 'Block reason', 1000);
      if (title === undefined && description === undefined && blockReason === undefined) throw new ControlError('No task change supplied.');
      return withLock(context, 'board-edit', async () => {
        const before = await view(id);
        if (!before.atomicRevision) throw new ControlError('Safe editing needs the pinned Backlog CAS runtime. Run node .switchflow/scripts/backlog-fork/setup.mjs, then restart this board.', 503);
        if (before.revision !== input.expectedRevision) throw new ControlError('This task changed. Reload before saving your edit.', 409);
        if (['In Progress', 'Review', 'Done'].includes(before.status)) throw new ControlError('Use an initiative scope change for work already running, in review, or completed.', 409);
        try {
          await callTool(await cli(), root, 'task_edit', { id, expectedRevision: input.expectedRevision, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(blockReason === undefined ? {} : { blockReason }) });
        } catch (error) {
          if (/revision|stale|conflict|lock|busy/i.test(error.message)) throw new ControlError('This task changed or is being edited. Reload before saving your draft.', 409);
          throw error;
        }
        const after = await view(id);
        await execute(process.execPath, [await cli(), 'doctor'], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        await execute(process.execPath, [path.join(root, '.switchflow', 'scripts', 'check-ready-dependencies.mjs'), await cli(), root], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
        return after;
      });
    },
  };
}
