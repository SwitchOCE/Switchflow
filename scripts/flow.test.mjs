import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFlowSnapshot, renderFlow } from '../template/.switchflow/scripts/flow.mjs';

test('worker queues exclude parents identified by relationships or explicit label', () => {
  const tasks = [
    { id: 'T-1', title: 'Phase', status: 'Backlog' },
    { id: 'T-1.1', title: 'Build', parentTaskId: 'T-1', status: 'Blocked' },
    { id: 'T-2', title: 'Empty phase', status: 'Backlog', labels: ['coordination'] },
    { id: 'T-3', title: 'Prepare', status: 'Ready' },
  ];
  const snapshot = buildFlowSnapshot(tasks);
  assert.deepEqual(snapshot.coordination.map(task => task.id), ['T-1', 'T-2']);
  assert.equal(snapshot.queues.Backlog.length, 0);
  assert.deepEqual(snapshot.queues.Ready.map(task => task.id), ['T-3']);
  assert.equal(snapshot.queues.Blocked.length, 1);
  assert.match(renderFlow(snapshot), /not recorded/);
});

test('reports recorded blocker evidence without promoting work or inventing transition history', () => {
  const tasks = [
    { id: 'T-1', title: 'Waiting', status: 'Blocked', updatedAt: '2026-09-05T00:00:00Z' },
    { id: 'T-2', title: 'Dependency', status: 'Done', updatedAt: '2026-09-05T01:00:00Z' },
    { id: 'T-3', title: 'Undated', status: 'Backlog', updatedAt: null },
  ];
  const notes = 'Waiting for: account\nUnblock owner: Human\nResume when: access is confirmed';
  const snapshot = buildFlowSnapshot(tasks, new Map([['T-1', { dependencies: ['T-2'], implementationNotes: notes }]]));
  assert.equal(snapshot.queues.Ready.length, 0);
  assert.equal(snapshot.blocked[0].waitingNotes, notes);
  assert.deepEqual(snapshot.blocked[0].dependencies, ['T-2']);
  assert.deepEqual(snapshot.recent.map(task => task.id), ['T-2', 'T-1']);
  assert.match(renderFlow(snapshot), /not a transition log/);
  assert.equal(tasks[0].status, 'Blocked');
});

test('discovery questions and intake parents stay outside delivery queues and phase counts', () => {
  const tasks = [
    { id: 'T-1', title: 'Clarify exports', status: 'In Progress', labels: ['discovery', 'coordination'] },
    { id: 'T-1.1', title: 'Choose output', status: 'Ready', parentTaskId: 'T-1', labels: ['discovery', 'discussion'] },
    { id: 'T-1.2', title: 'Research format', status: 'Done', parentTaskId: 'T-1', labels: ['discovery', 'research'] },
    { id: 'T-2', title: 'Deliver export', status: 'Ready' },
  ];
  const snapshot = buildFlowSnapshot(tasks);
  assert.deepEqual(snapshot.queues.Ready.map(task => task.id), ['T-2']);
  assert.equal(snapshot.queues.Done.length, 0);
  assert.equal(snapshot.coordination.length, 0);
  assert.equal(snapshot.discovery.length, 3);
  assert.match(renderFlow(snapshot), /Discovery records \(not delivery\): 3/);
});

test('PowerShell wrapper forwards flow options and makes only read calls', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'switchflow-flow-'));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template/.switchflow/scripts');
  try {
    const scripts = path.join(root, '.switchflow/scripts');
    const cli = path.join(root, '.switchflow/node_modules/backlog.md');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(cli, { recursive: true });
    for (const file of ['backlog.ps1', 'tooling.ps1', 'flow.mjs']) copyFileSync(path.join(source, file), path.join(scripts, file));
    writeFileSync(path.join(root, '.switchflow/package.json'), JSON.stringify({ devDependencies: { 'backlog.md': '1.50.1' } }));
    writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '1.50.1' }));
    writeFileSync(path.join(cli, 'cli.js'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');
if (args[0] === '--version') console.log('1.50.1');
else if (args.join(' ') === 'task list --json') console.log(JSON.stringify({tasks:[{id:'T-1',title:'Waiting',status:'Blocked'}]}));
else if (args.join(' ') === 'task view T-1 --json') console.log(JSON.stringify({task:{dependencies:['T-2'],implementationNotes:'Unblock owner: Human'}}));
else process.exit(2);
`);
    const run = args => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'backlog.ps1'), 'flow', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    const result = run(['--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).blocked[0].waitingNotes, 'Unblock owner: Human');
    const invalid = run(['--mutate']);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage: backlog.ps1 flow/);
    const calls = readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(args => args[0] === '--version' || args[0] === 'task' && ['list', 'view'].includes(args[1])));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  }
});
