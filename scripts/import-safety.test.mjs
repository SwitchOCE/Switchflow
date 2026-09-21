import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const importer = resolve('scripts/import-switchflow.ps1');
const ps = code => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], { encoding: 'utf8', timeout: 60000 });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-import-safety-'));
  try { fn(root); } finally { assert.ok(root.startsWith(join(tmpdir(), 'switchflow-import-safety-'))); rmSync(root, { recursive: true, force: true }); }
}
const command = target => `& ${quote(importer)} -TargetPath ${quote(target)} -ProjectName Safe -TaskPrefix SAFE`;
test('import rejects a file ancestor before creating any governance files', () => fixture(root => {
  writeFileSync(join(root, '.agents'), 'preserve');
  const result = ps(command(root));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires a directory/);
  assert.deepEqual(readdirSync(root), ['.agents']);
}));
test('import refuses a junction destination without writing into its external target', () => fixture(root => {
  const target = join(root, 'target'), outside = join(root, 'outside'); mkdirSync(target); mkdirSync(outside);
  symlinkSync(outside, join(target, '.agents'), 'junction');
  const result = ps(command(target));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /linked path/);
  assert.deepEqual(readdirSync(outside), []); assert.deepEqual(readdirSync(target), ['.agents']);
}));
test('late locked gitignore failure rolls back staged governance and permits retry', () => fixture(root => {
  const target = join(root, 'target'); mkdirSync(target);
  const ignore = join(target, '.gitignore'); writeFileSync(ignore, 'keep-me\r\n');
  const result = ps(`$h=[IO.File]::Open(${quote(ignore)},'Open','Read','Read'); try { ${command(target)} } finally { $h.Dispose() }`);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(ignore, 'utf8'), 'keep-me\r\n');
  assert.throws(() => readFileSync(join(target, 'AGENTS.md')), { code: 'ENOENT' });
  assert.equal(readdirSync(root).filter(name => name.startsWith('.switchflow-import-')).length, 0);
  const retry = ps(command(target)); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(readFileSync(join(target, '.switchflow/project.json'), 'utf8')).projectName, 'Safe');
  assert.ok(readFileSync(ignore, 'utf8').startsWith('keep-me\n'));
}));
test('interrupted import journal blocks replay and points to exact recovery evidence', () => fixture(root => {
  const target = join(root, 'target'), stage = join(root, '.switchflow-import-0123456789abcdef0123456789abcdef');
  mkdirSync(target); mkdirSync(stage);
  const journal = join(stage, 'recovery.json');
  writeFileSync(journal, JSON.stringify({ target, files: [] }));
  const result = ps(command(target)); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interrupted import needs reconciliation/);
  assert.deepEqual(readdirSync(target), []); assert.ok(readFileSync(journal));
}));
test('staging refuses a gitignore changed after rendering without overwriting owner edits', () => fixture(root => {
  const target = join(root, 'target'); mkdirSync(target); writeFileSync(join(target, '.gitignore'), 'new owner edit');
  const installer = resolve('scripts/install-rendered-template.ps1');
  const result = ps(`$file=[pscustomobject]@{RelativePath='.gitignore';Content='stale rendered value';Bytes=$null;OriginalBytes=[Text.Encoding]::UTF8.GetBytes('old value')}; & ${quote(installer)} -TargetRoot ${quote(target)} -Files @($file)`);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /changed during rendering/);
  assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), 'new owner edit');
  assert.deepEqual(readdirSync(root), ['target']);
}));
