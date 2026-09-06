import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(root, 'template/.switchflow/scripts/update-document.mjs');
const cli = process.env.BACKLOG_TEST_CLI;
const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
const ps = (script, args, cwd) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], cwd);
const success = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); };

test('file route rejects mixed content flags before starting Backlog', () => {
  const result = run(process.execPath, [helper, 'missing-cli', root, 'doc', 'update', 'doc-01', '--content-file', 'x', '--content', 'y']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('file route fails on unreadable content before starting Backlog', () => {
  const result = run(process.execPath, [helper, 'missing-cli', root, 'doc', 'update', 'doc-01', '--content-file', join(root, 'missing-content-file')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

test('pinned Backlog round-trips document and checkpoint bodies without losing metadata or active status', { skip: !cli && 'Set BACKLOG_TEST_CLI to an installed pinned backlog.md/cli.js' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'switchflow-document-'));
  try {
    success(ps(join(root, 'scripts/import-switchflow.ps1'), ['-TargetPath', fixture, '-ProjectName', 'Document transport test', '-TaskPrefix', 'VAL']));
    const packageRoot = join(fixture, '.switchflow/node_modules/backlog.md');
    mkdirSync(packageRoot, { recursive: true });
    // Reuse the real pinned runtime, keeping all document writes inside the fixture.
    cpSync(join(dirname(cli), 'package.json'), join(packageRoot, 'package.json'));
    cpSync(cli, join(packageRoot, 'cli.js'));
    writeFileSync(join(packageRoot, 'resolveBinary.cjs'), `module.exports = require(${JSON.stringify(join(dirname(resolve(cli)), 'resolveBinary.cjs'))});`);
    const wrapper = join(fixture, '.switchflow/scripts/backlog.ps1');
    const doc = join(fixture, 'backlog/docs/doc-05 - Maintaining-documentation.md');
    const original = readFileSync(doc, 'utf8');
    const frontmatter = text => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
    const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const content = '# Complete contract\r\n\r\n' + 'Unicode: 艦隊 ⚓ café; "quotes" `ticks` $HOME $(literal) \\paths\r\n'.repeat(1600) + '\r\n```json\r\n{"lastRequiredCase":true}\r\n```\r\n';
    assert.ok(content.length > 90000);
    const source = join(fixture, 'complete body.md');
    writeFileSync(source, '\uFEFF' + content);
    success(ps(wrapper, ['doc', 'update', 'doc-05', '--content-file', 'complete body.md'], fixture));
    const updated = readFileSync(doc, 'utf8');
    assert.equal(body(updated).replace(/\r\n/g, '\n'), content.trim().replace(/\r\n/g, '\n'));
    for (const key of ['id', 'title', 'type']) {
      const pattern = new RegExp(`^${key}: .+$`, 'm');
      assert.equal(frontmatter(updated).match(pattern)[0], frontmatter(original).match(pattern)[0]);
    }
    assert.match(frontmatter(updated), /documentation/);
    assert.match(frontmatter(updated), /governance/);
    // A failed update must not damage an existing document or create another one.
    const missing = ps(wrapper, ['doc', 'update', 'doc-9999', '--content-file', source], fixture);
    assert.notEqual(missing.status, 0);
    assert.equal(readFileSync(doc, 'utf8'), updated);
    // Checkpoint transport must preserve active status, comments and relationships.
    success(ps(wrapper, ['task', 'create', 'Clarify export', '--status', 'In Progress', '-l', 'discovery,coordination', '--ac', 'Owner accepts a concrete contract', '--plain'], fixture));
    success(ps(wrapper, ['task', 'edit', 'VAL-1', '--comment', 'Confirmed: local-only; format still undecided.', '--comment-author', 'Owner'], fixture));
    const readTask = () => {
      const result = ps(wrapper, ['task', 'view', 'VAL-1', '--json'], fixture);
      success(result);
      return JSON.parse(result.stdout).task;
    };
    const beforeTask = readTask();
    const checkpoint = '# Resume\n\n' + 'Unicode 艦隊 café; "quotes" `ticks` $HOME $(literal)\n'.repeat(150) + '\nNext question: export format?\n';
    const checkpointFile = join(fixture, 'checkpoint body.md');
    writeFileSync(checkpointFile, '\uFEFF' + checkpoint);
    success(ps(wrapper, ['task', 'edit', 'VAL-1', '--description-file', 'checkpoint body.md'], fixture));
    const afterTask = readTask();
    assert.equal(afterTask.description.trim(), checkpoint.trim());
    for (const key of ['id', 'status', 'labels', 'comments', 'acceptanceCriteria', 'milestone', 'dependencies', 'assignees', 'parentTaskId']) assert.deepEqual(afterTask[key], beforeTask[key], key);
    writeFileSync(checkpointFile, 'x'.repeat(10001));
    const tooLong = ps(wrapper, ['task', 'edit', 'VAL-1', '--description-file', checkpointFile], fixture);
    assert.notEqual(tooLong.status, 0);
    assert.match(tooLong.stderr, /10000/);
    assert.deepEqual(readTask(), afterTask);
    const mixed = ps(wrapper, ['task', 'edit', 'VAL-1', '--description-file', source, '--status', 'Done'], fixture);
    assert.notEqual(mixed.status, 0);
    assert.deepEqual(readTask(), afterTask);
    const absentFile = ps(wrapper, ['doc', 'update', 'doc-05', '--content-file', join(fixture, 'absent.md')], fixture);
    assert.notEqual(absentFile.status, 0);
    assert.equal(readFileSync(doc, 'utf8'), updated);
  } finally {
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});
