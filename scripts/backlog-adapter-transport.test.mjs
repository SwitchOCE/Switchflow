import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { callBacklogTool, createBacklogAdapter } from '../template/.switchflow/scripts/control/backlog-adapter.mjs';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function controlled(killResult = false, limits = {}) {
  const children = [];
  const options = {
    executable: 'controlled-mcp', timeoutMs: 5000, ...limits,
    spawnChild: () => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kills: 0, requests: [] });
      child.stdin.on('data', chunk => child.requests.push(JSON.parse(String(chunk))));
      child.kill = () => {
        child.kills++; child.emit('kill-requested');
        if (killResult === 'throw') throw new Error('Termination unavailable');
        if (killResult === 'error') { child.emit('error', new Error('Termination denied')); return false; }
        return killResult;
      };
      child.reply = value => child.stdout.write(JSON.stringify(value) + '\n');
      children.push(child);
      return child;
    },
  };
  return { children, call: (cli = 'unused', root = '.', name = 'task_edit', args = {}) => callBacklogTool(cli, root, name, args, options) };
}

test('MCP timeout preserves caller admission through failed termination and late output until close', async () => {
  for (const killResult of [true, false, 'throw', 'error']) {
    const { call, children } = controlled(killResult, { timeoutMs: 20 });
    let settled = false;
    const rejected = assert.rejects(call().finally(() => { settled = true; }), /timed out/);
    const child = children[0];
    child.reply({ id: 1, result: {} });
    await new Promise(resolve => child.once('kill-requested', resolve));
    child.reply({ id: 2, result: { content: [] } });
    child.emit('exit', 0);
    await nextTurn();
    assert.equal(child.kills, 1);
    assert.equal(child.exitCode, null);
    assert.equal(settled, false);
    child.emit('close', 0);
    await rejected;
  }
});

test('MCP protocol, stream, process, and output-limit failures settle only after close', async () => {
  const failures = [
    child => child.stdout.write('not-json\n'),
    child => child.reply(null),
    child => child.reply({ id: 17, result: {} }),
    child => child.reply({ id: 1, error: { message: 'Tool rejected the update' } }),
    child => { child.reply({ id: 1, result: {} }); child.reply({ id: 2, result: { isError: true, content: [] } }); },
    child => { child.reply({ id: 1, result: {} }); child.reply({ id: 2, result: true }); },
    child => child.stdout.write('x'.repeat(1025)),
    child => child.emit('error', new Error('Child process failed')),
    ...['stdin', 'stdout', 'stderr'].map(stream => child => child[stream].emit('error', new Error('Broken transport'))),
    child => child.emit('exit', 7),
  ];
  for (const fail of failures) {
    const { call, children } = controlled(false, { maxOutputBytes: 1024 });
    let settled = false;
    const rejected = assert.rejects(call().finally(() => { settled = true; }));
    const child = children[0]; fail(child);
    child.reply({ id: 2, result: { content: [] } });
    await nextTurn(); assert.equal(settled, false);
    child.emit('close', 7); await rejected;
  }
});

test('confirmed MCP success also waits for writer close and duplicate initialization never dispatches twice', async () => {
  const success = controlled();
  let settled = false;
  const result = success.call().then(value => { settled = true; return value; });
  const child = success.children[0];
  child.reply({ id: 1, result: {} });
  child.reply({ id: 2, result: { content: [] } });
  await nextTurn(); assert.equal(settled, false);
  child.emit('close', 0); assert.deepEqual(await result, { content: [] });

  const duplicate = controlled();
  const rejected = assert.rejects(duplicate.call(), /Unexpected Backlog response/);
  const writer = duplicate.children[0];
  writer.reply({ id: 1, result: {} }); writer.reply({ id: 1, result: {} });
  assert.equal(writer.requests.filter(request => request.method === 'tools/call').length, 1);
  writer.emit('close', 0); await rejected;
});

test('task and milestone adapter locks reject overlap until the timed-out MCP writer closes', async () => {
  for (const kind of ['task', 'milestone']) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-mcp-admission-'));
    const transport = controlled(false, { timeoutMs: 100 });
    const revision = 'a'.repeat(64);
    const adapter = createBacklogAdapter({ stateDir, sourceRoot: stateDir, governanceRoot: stateDir }, {
      cliPath: path.join(stateDir, 'cli.cjs'), callTool: transport.call,
      execute: async (_executable, args) => ({ stdout: JSON.stringify(args[1] === 'task' ? { task: { id: 'TEST-1', status: 'Ready', revision } } : { id: 'm-1', revision }) }),
    });
    const edit = () => kind === 'task'
      ? adapter.edit('TEST-1', { expectedRevision: revision, title: 'Changed task' })
      : adapter.editMilestone('m-1', { expectedRevision: revision, title: 'Changed milestone' });
    try {
      const first = assert.rejects(edit(), /timed out/);
      while (!transport.children.length) await nextTurn();
      const writer = transport.children[0];
      writer.reply({ id: 1, result: {} });
      await new Promise(resolve => writer.once('kill-requested', resolve));
      const second = edit();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(transport.children.length, 1, 'the first caller must retain the board-edit lock');
      writer.emit('close', 0); await first;
      while (transport.children.length < 2) await nextTurn();
      const replacement = transport.children[1];
      replacement.reply({ id: 1, result: {} });
      replacement.reply({ id: 2, result: { content: [] } });
      replacement.emit('close', 0); await second;
    } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
  }
});

test('real MCP pipe returns its result only after the spawned writer closes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-mcp-pipe-'));
  const script = path.join(root, 'mcp-fixture.cjs');
  let closed = false;
  try {
    await fs.writeFile(script, `
      const input = require('node:readline').createInterface({input:process.stdin});
      input.on('line', line => {
        const request = JSON.parse(line);
        if (request.id === 1) console.log(JSON.stringify({id:1,result:{}}));
        if (request.id === 2) console.log(JSON.stringify({id:2,result:{content:[{type:'text',text:request.params.name}]}}));
      });
      setInterval(()=>{},1000);
    `);
    const result = await callBacklogTool(script, root, 'task_edit', { id: 'TEST-1' }, {
      executable: process.execPath,
      spawnChild: (_executable, _args, options) => {
        const child = spawn(process.execPath, [script], options);
        child.once('close', () => { closed = true; });
        return child;
      },
    });
    assert.equal(closed, true);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'task_edit' }] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
