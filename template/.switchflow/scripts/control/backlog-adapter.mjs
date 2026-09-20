import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
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

export function callBacklogTool(cliPath, root, name, args) {
  return new Promise((resolve, reject) => {
    const require = createRequire(cliPath);
    const { resolveBinaryPath } = require(path.join(path.dirname(cliPath), 'resolveBinary.cjs'));
    const child = spawn(resolveBinaryPath(), ['mcp', 'start'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Backlog update timed out. Inspect the current task before retrying.')), 30000);
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    child.on('error', error => finish(error)); child.stdin.on('error', error => finish(error)); child.stderr.resume();
    child.on('exit', code => finish(new Error(`Backlog stopped before confirming the update (${code}). Inspect the current task.`)));
    createInterface({ input: child.stdout }).on('line', line => {
      if (finished) return;
      try {
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error.message);
        if (msg.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name, arguments: args } });
        } else if (msg.id === 2) {
          if (!msg.result || msg.result.isError) throw new Error(msg.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Backlog rejected the update.');
          finish(null, msg.result);
        }
      } catch (error) { finish(error); }
    });
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
