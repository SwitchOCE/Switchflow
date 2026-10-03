import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseComments,
  parseTaskRecord,
  readTaskRecords,
  renderReviews,
  summarizeReviews,
  verdictOf,
} from '../template/.switchflow/scripts/review-outcomes.mjs';

const comment = (author, created, body) => `author: ${author}\ncreated: ${created}\n---\n${body}\n---\n`;
const record = ({ id, status = 'Done', type = 'feature', labels = [], parent = null, comments = [] }) =>
  [
    '---',
    `id: ${id}`,
    `title: Task ${id}`,
    `status: ${status}`,
    labels.length ? `labels:\n${labels.map(label => `  - ${label}`).join('\n')}` : 'labels: []',
    parent ? `parent_task_id: ${parent}` : null,
    `type: ${type}`,
    '---',
    '',
    '## Description',
    '',
    'Body',
    '',
    comments.length ? `## Comments\n\n<!-- COMMENTS:BEGIN -->\n${comments.join('\n')}<!-- COMMENTS:END -->\n` : '',
  ]
    .filter(line => line !== null)
    .join('\n');

test('only an exact first-line verdict counts', () => {
  assert.equal(verdictOf('Verdict: accept\n\nNo findings.'), 'accept');
  assert.equal(verdictOf('\n  verdict: BLOCK  \n1. P1 race'), 'block');
  assert.equal(verdictOf('Independent review: accept.'), null);
  assert.equal(verdictOf('Findings first.\nVerdict: accept'), null);
  assert.equal(verdictOf('Verdict: accept with follow-up'), null);
});

test('comments parse from the fork delimited format, including CRLF records', () => {
  const source = record({
    id: 'T-1',
    comments: [
      comment('@codex-orch', '2026-09-05 22:00', 'Dispatched.'),
      comment('@codex-review', '2026-09-05 23:00', 'Verdict: block\n\n1. Missing guard.'),
    ],
  }).replace(/\n/g, '\r\n');
  const comments = parseComments(source);
  assert.deepEqual(
    comments.map(entry => [entry.author, entry.created]),
    [
      ['@codex-orch', '2026-09-05 22:00'],
      ['@codex-review', '2026-09-05 23:00'],
    ],
  );
  assert.deepEqual(parseTaskRecord(source).verdicts, [{ verdict: 'block', created: '2026-09-05 23:00' }]);
});

test('summary reports first pass, rounds and types, and never infers unstructured reviews', () => {
  const tasks = [
    record({ id: 'T-1', labels: ['phase-a', 'coordination'] }),
    record({
      id: 'T-1.1',
      parent: 'T-1',
      comments: [
        comment('@r', '2026-09-10 10:00', 'Verdict: block\n1. Race.'),
        comment('@r', '2026-09-10 12:00', 'Verdict: accept'),
      ],
    }),
    record({
      id: 'T-1.2',
      parent: 'T-1',
      type: 'bug',
      comments: [comment('@r', '2026-09-11 09:00', 'Verdict: accept')],
    }),
    record({ id: 'T-2', comments: [comment('@r', '2026-09-01 09:00', 'Independent review: block. Legacy wording.')] }),
    record({ id: 'T-3', status: 'Ready' }),
    record({ id: 'T-4', labels: ['discovery'], comments: [comment('@r', '2026-09-10 09:00', 'Verdict: block')] }),
  ].map(parseTaskRecord);
  const summary = summarizeReviews(tasks);
  assert.equal(summary.reviewedTasks, 2);
  assert.deepEqual(summary.firstPass, { accepted: 1, blocked: 1, acceptedPercent: 50 });
  assert.deepEqual(summary.reviewRounds, { mean: 1.5, max: 2 });
  assert.deepEqual(summary.byType, {
    feature: { reviewed: 1, firstPassAccepted: 0 },
    bug: { reviewed: 1, firstPassAccepted: 1 },
  });
  assert.deepEqual(summary.unstructured, { count: 1, ids: ['T-2'] });
  assert.match(renderReviews(summary), /Accepted on first review: 1 \(50%\)/);
  assert.match(renderReviews(summary), /Task T-1\.1 \[T-1\.1\] — 2 round\(s\)/);

  const later = summarizeReviews(tasks, { since: '2026-09-11' });
  assert.equal(later.reviewedTasks, 1);
  assert.equal(later.firstPass.acceptedPercent, 100);
});

test('an empty board reports no rates instead of dividing by zero', () => {
  const summary = summarizeReviews([]);
  assert.equal(summary.firstPass.acceptedPercent, null);
  assert.match(renderReviews(summary), /\(n\/a\)/);
});

test('records are read from active and completed folders only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'switchflow-reviews-'));
  try {
    for (const folder of ['tasks', 'completed', 'archive/tasks'])
      mkdirSync(path.join(root, 'backlog', folder), { recursive: true });
    writeFileSync(path.join(root, 'backlog/tasks/t-1.md'), record({ id: 'T-1' }));
    writeFileSync(path.join(root, 'backlog/completed/t-2.md'), record({ id: 'T-2' }));
    writeFileSync(path.join(root, 'backlog/archive/tasks/t-3.md'), record({ id: 'T-3' }));
    writeFileSync(path.join(root, 'backlog/tasks/notes.txt'), 'ignored');
    assert.deepEqual(
      readTaskRecords(root)
        .map(task => task.id)
        .sort(),
      ['T-1', 'T-2'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'PowerShell wrapper runs reviews read-only and rejects unknown options',
  { skip: process.platform !== 'win32' && 'Needs Windows PowerShell (powershell.exe)' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'switchflow-reviews-cli-'));
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template/.switchflow/scripts');
    try {
      const scripts = path.join(root, '.switchflow/scripts');
      const cli = path.join(root, '.switchflow/node_modules/backlog.md');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(cli, { recursive: true });
      mkdirSync(path.join(root, 'backlog/tasks'), { recursive: true });
      for (const file of ['backlog.ps1', 'tooling.ps1', 'review-outcomes.mjs'])
        copyFileSync(path.join(source, file), path.join(scripts, file));
      writeFileSync(
        path.join(root, '.switchflow/package.json'),
        JSON.stringify({ devDependencies: { 'backlog.md': '1.50.1' } }),
      );
      writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '1.50.1' }));
      writeFileSync(
        path.join(cli, 'cli.js'),
        "if (process.argv[2] === '--version') console.log('1.50.1'); else process.exit(2);\n",
      );
      writeFileSync(
        path.join(root, 'backlog/tasks/t-1.md'),
        record({ id: 'T-1', comments: [comment('@r', '2026-09-10 10:00', 'Verdict: accept')] }),
      );
      const run = args =>
        spawnSync(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'backlog.ps1'), 'reviews', ...args],
          { cwd: root, encoding: 'utf8', windowsHide: true },
        );
      const result = run(['--since', '2026-09-01', '--json']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).firstPass.accepted, 1);
      const invalid = run(['--since', 'yesterday']);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Usage: backlog.ps1 reviews/);
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
