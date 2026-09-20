import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveBacklogFork } from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';
import { editMilestone, viewMilestone } from '../template/.switchflow/scripts/milestone-scope.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeCli = process.env.BACKLOG_TEST_CLI;
const runtime = await resolveBacklogFork();
const original = '---\r\nid: m-0\r\ntitle: "Keep identity"\r\ncustom: preserve-me\r\n---\r\n\r\n## Description\r\n\r\nOriginal scope\r\n';
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; };
const ps = (script, args, cwd) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], cwd);
const change = (root, description = 'Revised scope') => ({ expectedRevision: viewMilestone(root, 'm-0').revision, description, reason: 'Owner changed the requirement', approval: 'Intake comment: owner accepts revised scope' });
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-scope-'));
  try {
    ok(run(runtime.executable, ['init', 'Scope fixture', '--defaults', '--no-git', '--integration-mode', 'none', '--task-prefix', 'VAL'], root));
    mkdirSync(join(root, 'backlog/milestones'), { recursive: true });
    writeFileSync(join(root, 'backlog/milestones/m-0 - keep.md'), original);
    fn(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('scope edit preserves metadata and exact prior record; supports long Unicode and restoration', () => fixture(root => {
  const long = '# Accepted scope\n\n' + '艦隊 ⚓ café "quotes" `ticks` $HOME $(literal)\n'.repeat(2400);
  const result = editMilestone(root, 'm-0', change(root, long));
  assert.equal(result.description, long.trim());
  assert.equal(result.path, join('backlog', 'milestones', 'm-0 - keep.md'));
  const saved = readFileSync(join(root, result.path), 'utf8');
  assert.match(saved, /custom: preserve-me/);
  assert.match(saved, /title:.*Keep identity/);
  const snapshot = JSON.parse(readFileSync(join(root, result.snapshot), 'utf8'));
  assert.equal(snapshot.previousContent, original);
  assert.equal(snapshot.status, 'prepared');
  const receipt = JSON.parse(readFileSync(join(root, result.snapshot.replace(/\.json$/, '.applied.json')), 'utf8'));
  assert.equal(receipt.proposedRevision, result.revision);
  assert.equal(snapshot.approval, change(root).approval);
  const restored = editMilestone(root, 'm-0', change(root, 'Original scope'));
  assert.equal(restored.description, 'Original scope');
  assert.equal(restored.snapshots.length, 2);
}));

test('stale baseline, simultaneous writer and malformed input leave accepted content unchanged', () => fixture(root => {
  const stale = change(root);
  const current = editMilestone(root, 'm-0', change(root));
  const before = readFileSync(join(root, current.path));
  assert.throws(() => editMilestone(root, 'm-0', stale), /Stale/);
  for (const input of [{ ...change(root), approval: '' }, { ...change(root), id: 'm-1' }, { ...change(root), description: '' }]) {
    assert.throws(() => editMilestone(root, 'm-0', input), /Input requires/);
  }
  const lock = join(root, 'backlog/.locks/workflow');
  mkdirSync(lock, {recursive:true});
  assert.throws(() => editMilestone(root, 'm-0', change(root, 'Contending edit')), /lock|modified|editing/i);
  assert.ok(readdirSync(join(root,'backlog/.locks')).includes('workflow'));
  rmSync(lock, {recursive:true});
  assert.deepEqual(readFileSync(join(root, current.path)), before);
  assert.equal(viewMilestone(root, 'm-0').snapshots.length, 2); // the unsuccessful prepared snapshot does not assert application
}));

test('exact IDs exclude path traversal, absent, duplicate and archived milestones', () => fixture(root => {
  for (const id of ['../m-0', 'Keep identity', 'm-99']) assert.throws(() => viewMilestone(root, id));
  writeFileSync(join(root, 'backlog/milestones/duplicate.md'), original);
  assert.throws(() => viewMilestone(root, 'm-0'), /found 2/);
}));

test('a legacy milestone without description can gain scope; identical edit creates no snapshot', () => fixture(root => {
  const path = join(root, 'backlog/milestones/m-0 - keep.md');
  writeFileSync(path, original.split('## Description')[0]);
  assert.equal(viewMilestone(root, 'm-0').description, '');
  const first = editMilestone(root, 'm-0', change(root));
  const second = editMilestone(root, 'm-0', change(root));
  assert.equal(second.changed, false);
  assert.equal(first.revision, second.revision);
  assert.equal(second.snapshots.length, 1);
}));

test('failure to save history leaves current scope intact before native mutation', () => fixture(root => {
  mkdirSync(join(root, 'backlog/archive'), { recursive: true });
  writeFileSync(join(root, 'backlog/archive/milestone-revisions'), 'not a directory');
  const input = change(root);
  assert.throws(() => editMilestone(root, 'm-0', input), /ENOTDIR|ENOENT/);
  assert.equal(readFileSync(join(root, 'backlog/milestones/m-0 - keep.md'), 'utf8'), original);
  assert.ok(!readdirSync(join(root, 'backlog/milestones')).some(name => name.endsWith('.scope-lock') || name.endsWith('.tmp')));
}));

test('pinned Backlog and imported wrapper retain task relationships through edit and rename', { skip: !nativeCli && 'Set BACKLOG_TEST_CLI to pinned backlog.md/cli.js' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-scope-native-'));
  try {
    ok(ps(join(repo, 'scripts/import-switchflow.ps1'), ['-TargetPath', root, '-ProjectName', 'Scope fixture', '-TaskPrefix', 'VAL']));
    const packageRoot = join(root, '.switchflow/node_modules/backlog.md');
    mkdirSync(packageRoot, { recursive: true });
    copyFileSync(join(dirname(nativeCli), 'package.json'), join(packageRoot, 'package.json'));
    copyFileSync(nativeCli, join(packageRoot, 'cli.js'));
    writeFileSync(join(packageRoot, 'resolveBinary.cjs'), `module.exports = require(${JSON.stringify(join(dirname(resolve(nativeCli)), 'resolveBinary.cjs'))});`);
    const wrapper = join(root, '.switchflow/scripts/backlog.ps1');
    const cli = args => run(process.execPath, [nativeCli, ...args], root);
    ok(cli(['milestone', 'add', 'Accepted result', '--description', 'Original scope']));
    const baseline = JSON.parse(ok(ps(wrapper, ['milestone', 'view', 'm-0', '--json'], root)));
    ok(cli(['task', 'create', 'Deliver first slice', '-m', 'm-0', '--plain']));
    ok(cli(['task', 'create', 'Deliver second slice', '-m', 'm-0', '--dep', 'VAL-1', '--plain']));
    const tasksRoot = join(root, 'backlog/tasks');
    const beforeTasks = readdirSync(tasksRoot).filter(name => name.endsWith('.md')).map(name => [name, readFileSync(join(tasksRoot, name), 'utf8')]);
    const description = '# Revised contract\n\n' + 'Long scope café 艦隊 `ticks` $(literal)\n'.repeat(2500);
    const input = { ...change(root, description), expectedRevision: baseline.revision };
    const inputPath = join(root, 'change with spaces.json');
    writeFileSync(inputPath, '\uFEFF' + JSON.stringify(input));
    const result = JSON.parse(ok(ps(wrapper, ['milestone', 'edit', 'm-0', '--input-file', 'change with spaces.json'], root)));
    assert.equal(result.description, description.trim());
    for (const [name, before] of beforeTasks) assert.equal(readFileSync(join(tasksRoot, name), 'utf8'), before);
    const stale = ps(wrapper, ['milestone', 'edit', 'm-0', '--input-file', inputPath], root);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /Stale/);
    ok(cli(['milestone', 'rename', 'Accepted result', 'Renamed result']));
    assert.equal(viewMilestone(root, 'm-0').description, description.trim());
    const tasks = JSON.parse(ok(cli(['task', 'list', '--json']))).tasks;
    assert.ok(tasks.every(task => task.milestone === 'm-0'));
    ok(ps(wrapper, ['doctor'], root));
    ok(cli(['milestone', 'archive', 'm-0']));
    assert.throws(() => viewMilestone(root, 'm-0'), /found 0/);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
