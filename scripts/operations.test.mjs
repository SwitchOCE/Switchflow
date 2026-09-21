import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolveProject, readState, updateState, withLock, recordIssue, issueMetrics, runCheck, writeScratch, promoteScratch, planRetention, applyRetention, registerWorktree, inspectWorktrees } from '../template/.switchflow/scripts/operations/operations.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-operations-'));
  const repo = path.join(base, 'source'); await fs.mkdir(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'source.txt'), 'initial'); git(['add', '.']); git(['commit', '-m', 'fixture']);
  const context = await resolveProject(repo, { stateHome: path.join(base, 'state') });
  t.after(() => { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); return fs.rm(base, { recursive: true, force: true }); });
  return { base, repo, git, context };
}

test('worktrees share external project identity and primary governance root', async t => {
  const { base, repo, git, context } = await fixture(t);
  const secondary = path.join(base, 'secondary'); git(['worktree', 'add', '-b', 'candidate', secondary]);
  const other = await resolveProject(secondary, { stateHome: path.join(base, 'state') });
  assert.equal(other.id, context.id); assert.equal(other.stateDir, context.stateDir); assert.equal(other.governanceRoot, repo);
  await registerWorktree(other, { owner: 'codex', purpose: 'test' });
  const inventory = await inspectWorktrees(context);
  assert.equal(inventory.find(e => e.path === secondary).owner, 'codex');
  assert.equal(inventory.find(e => e.path === repo).owner, 'unknown');
  await assert.rejects(resolveProject(repo, { stateHome: path.join(repo, 'state') }), /outside/);
});

test('agent operations ledgers are separate from controller state and retain earlier candidate data', async t => {
  const { context } = await fixture(t);
  const legacy = JSON.stringify({ entries: [{ id: 'prior', kind: 'issue', summary: 'Earlier candidate record', status: 'open' }] });
  await fs.writeFile(path.join(context.stateDir, 'issues.json'), legacy);
  await recordIssue(context, { kind: 'update', summary: 'Current operations record' });
  assert.equal((await readState(context, 'issues')).entries.length, 2);
  assert.equal(await fs.readFile(path.join(context.stateDir, 'issues.json'), 'utf8'), legacy);
  assert.equal(JSON.parse(await fs.readFile(path.join(context.stateDir, 'operations', 'issues.json'), 'utf8')).entries.length, 2);
  await updateState(context, 'control', () => ({ protected: true }));
  assert.equal(JSON.parse(await fs.readFile(path.join(context.stateDir, 'control.json'), 'utf8')).protected, true);
  await assert.rejects(fs.stat(path.join(context.stateDir, 'operations', 'control.json')), { code: 'ENOENT' });
});

test('concurrent durable mutations lose no entries and locks cannot be stolen', async t => {
  const { context } = await fixture(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => recordIssue(context, { kind: i % 2 ? 'permission' : 'clarification', summary: `Interruption ${i}` })));
  assert.deepEqual(await issueMetrics(context), { total: 30, open: 30, byKind: { clarification: 15, permission: 15, 'scope-change': 0, issue: 0, update: 0 }, automaticDispatches: 0 });
  await withLock(context, 'held', async () => assert.rejects(withLock(context, 'held', () => {}, { timeoutMs: 30 }), /Lock busy/));
  await assert.rejects(updateState(context, '../outside', () => ({})), /Invalid/);
  const moduleUrl = new URL('../template/.switchflow/scripts/operations/storage.mjs', import.meta.url).href;
  const source = `import {updateState} from ${JSON.stringify(moduleUrl)}; for(let i=0;i<10;i++) await updateState(${JSON.stringify(context)},'multiprocess',s=>{s.count++},{count:0});`;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: 'pipe' });
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  })));
  assert.equal((await readState(context, 'multiprocess')).count, 30);
});

test('evidence executes once concurrently and invalidates on content, command, scope, environment and failure', async t => {
  const { context, repo, base } = await fixture(t);
  const counter = path.join(base, 'runs.txt');
  const script = `require('fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`;
  const check = { command: process.execPath, args: ['-e', script], scope: 'unit', environment: { ...process.env, OPERATIONS_TEST: 'one' } };
  const results = await Promise.all([runCheck(context, check), runCheck(context, check)]);
  assert.equal(results.filter(e => e.reused).length, 1); assert.equal((await fs.readFile(counter, 'utf8')).trim(), 'run');
  await fs.writeFile(path.join(repo, 'source.txt'), 'changed'); assert.equal((await runCheck(context, check)).reused, false);
  assert.equal((await runCheck(context, { ...check, scope: 'integration' })).reused, false);
  assert.equal((await runCheck(context, { ...check, environment: { ...check.environment, OPERATIONS_TEST: 'two' } })).reused, false);
  assert.equal((await runCheck(context, { ...check, args: ['-e', script + '; void 0'] })).reused, false);
  const failure = { ...check, args: ['-e', 'process.exit(2)'] };
  assert.equal((await runCheck(context, failure)).exitCode, 2); assert.equal((await runCheck(context, failure)).reused, false);
  const modifying = { ...check, args: ['-e', "require('fs').writeFileSync('source.txt','changed in test')"] };
  assert.equal((await runCheck(context, modifying)).candidateChanged, true);
});

test('retention is explicit and preserves referenced, changed, unknown and linked content', async t => {
  const { context, base } = await fixture(t);
  const old = await writeScratch(context, { content: 'disposable', retentionDays: 0 });
  const referenced = await writeScratch(context, { content: 'evidence', retentionDays: 0 });
  await promoteScratch(context, referenced.id, 'accepted-evidence');
  const changed = await writeScratch(context, { content: 'before', retentionDays: 0 });
  await fs.writeFile(path.join(context.stateDir, changed.relativePath), 'after');
  const unknown = path.join(context.stateDir, 'scratch', 'unknown.txt'); await fs.writeFile(unknown, 'unknown');
  const plan = await planRetention(context); assert.equal(plan.dryRun, true); assert.deepEqual(plan.candidates.map(e => e.id), [old.id]);
  await assert.rejects(applyRetention(context, [referenced.id]), /not eligible/);
  await applyRetention(context, [old.id]); assert.equal(await fs.readFile(unknown, 'utf8'), 'unknown');
  const outside = path.join(base, 'outside'); await fs.mkdir(outside);
  const link = path.join(context.stateDir, 'linked'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedContext = { ...context, stateDir: link };
  await assert.rejects(updateState(linkedContext, 'control', () => ({ bad: true })), /Linked/);
  await updateState(context, 'scratch', state => { state.entries.push({ id: 'attack', relativePath: '../outside/victim', digest: 'x', retainUntil: '2000-01-01' }); });
  assert.ok((await planRetention(context)).preserved.some(e => e.id === 'attack'));
  assert.equal((await readState(context, 'scratch')).entries.find(e => e.id === old.id).deletedAt.length > 0, true);
});

test('check timeouts reject invalid limits and terminate descendants holding output pipes', { timeout: 15000 }, async t => {
  const { context } = await fixture(t);
  const check = { command: process.execPath, scope: 'timeout' };
  for (const timeoutMs of [0, -1, NaN, Infinity, '100', 0.5, 86400001]) {
    await assert.rejects(runCheck(context, { ...check, timeoutMs }), /Invalid check timeout/);
  }
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'inherit'}); console.log('descendant='+child.pid); setInterval(()=>{},1000);`;
  const started = Date.now();
  const result = await runCheck(context, { ...check, args: ['-e', script], timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 10000);
  const descendant = Number(/descendant=(\d+)/.exec(result.output)?.[1]);
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0, result.output);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  const retry = await runCheck(context, { ...check, args: ['-e', 'process.exit(0)'] });
  assert.equal(retry.exitCode, 0);
});

test('latest failed attempt invalidates an older success for the same evidence key', async t => {
  const { context, base } = await fixture(t);
  const trigger = path.join(base, 'fail-check');
  const check = { command: process.execPath, args: ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(trigger)}) ? 2 : 0)`], scope: 'latest-attempt' };
  const success = await runCheck(context, check); assert.equal(success.exitCode, 0);
  await fs.writeFile(trigger, 'fail');
  const forced = await runCheck(context, { ...check, reuse: false });
  assert.equal(forced.key, success.key); assert.equal(forced.exitCode, 2);
  const retried = await runCheck(context, check);
  assert.equal(retried.reused, false); assert.equal(retried.exitCode, 2);
  await fs.unlink(trigger);
  const recovered = await runCheck(context, check);
  assert.equal(recovered.reused, false); assert.equal(recovered.exitCode, 0);
  assert.equal((await runCheck(context, check)).reused, true);
});

test('leading whitespace in the first tracked filename participates in candidate identity', async t => {
  const { context, repo, git } = await fixture(t);
  const filename = path.join(repo, ' leading.txt');
  await fs.writeFile(filename, 'before'); git(['add', '--', ' leading.txt']); git(['commit', '-m', 'leading filename']);
  const check = { command: process.execPath, args: ['-e', 'process.exit(0)'], scope: 'filename-identity' };
  const before = await runCheck(context, check);
  assert.equal((await runCheck(context, check)).reused, true);
  await fs.writeFile(filename, 'after');
  const after = await runCheck(context, check);
  assert.equal(after.reused, false); assert.notEqual(after.candidate.digest, before.candidate.digest);
});

test('atomic replacement retries transient rename errors without rerunning mutation or dropping writer lock', async t => {
  const { context } = await fixture(t);
  await updateState(context, 'control', () => ({ revision: 0 }));
  const originalRename = fs.rename;
  let attempts = 0, mutations = 0;
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    attempts++;
    assert.equal((await fs.stat(path.join(context.stateDir, 'control.lock'))).isFile(), true);
    assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).revision, 0);
    if (attempts <= 3) throw Object.assign(new Error('Injected reader lock'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
    return originalRename(source, destination);
  });
  await updateState(context, 'control', state => { mutations++; state.revision++; });
  mock.mock.restore();
  assert.equal(attempts, 4); assert.equal(mutations, 1);
  assert.equal((await readState(context, 'control')).revision, 1);
  assert.deepEqual((await fs.readdir(context.stateDir)).filter(name => name.endsWith('.tmp')), []);
});

test('permanent rename failure preserves old state and removes only its temporary file', async t => {
  const { context } = await fixture(t);
  await updateState(context, 'control', () => ({ revision: 0 }));
  const unrelated = path.join(context.stateDir, 'unrelated.tmp'); await fs.writeFile(unrelated, 'keep');
  for (const code of ['EINVAL', 'EPERM']) {
    let attempts = 0, mutations = 0;
    const mock = t.mock.method(fs, 'rename', async () => { attempts++; throw Object.assign(new Error('Injected permanent error'), { code }); });
    const started = Date.now();
    await assert.rejects(updateState(context, 'control', state => { mutations++; state.revision++; }), error => error.code === code);
    mock.mock.restore();
    assert.equal(mutations, 1);
    if (code === 'EINVAL') assert.equal(attempts, 1);
    else { assert.ok(attempts > 1); assert.ok(Date.now() - started < 3500); }
    assert.equal((await readState(context, 'control')).revision, 0);
    assert.deepEqual((await fs.readdir(context.stateDir)).filter(name => name.endsWith('.tmp')), ['unrelated.tmp']);
  }
});

test('busy readers observe complete state while multiple writers serialize updates', async t => {
  const { context } = await fixture(t);
  await updateState(context, 'control', () => ({ revision: 0, payload: 'x'.repeat(16384) }));
  let reading = true, reads = 0;
  const readers = Array.from({ length: 6 }, async () => {
    while (reading) {
      const state = await readState(context, 'control');
      assert.equal(Number.isInteger(state.revision), true); assert.equal(state.payload.length, 16384); reads++;
      // Pollers release their handles between refreshes; perpetual overlapping
      // Windows handles constitute persistent contention, not a transient lock.
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 20; i++) await updateState(context, 'control', state => { state.revision++; });
    }));
  } finally { reading = false; await Promise.all(readers); }
  assert.equal((await readState(context, 'control')).revision, 80); assert.ok(reads > 0);
});

test('Windows lock creation retries delete-pending errors without taking another owner lock', { skip: process.platform !== 'win32' }, async t => {
  const { context } = await fixture(t);
  const lock = path.join(context.stateDir, 'pending.lock');
  const originalOpen = fs.open;
  let attempts = 0, actions = 0;
  const mock = t.mock.method(fs, 'open', async (file, flags, ...rest) => {
    if (file === lock && flags === 'wx' && ++attempts <= 3) throw Object.assign(new Error('Delete pending'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
    return originalOpen(file, flags, ...rest);
  });
  await withLock(context, 'pending', async () => { actions++; assert.equal((await fs.stat(lock)).isFile(), true); });
  mock.mock.restore();
  assert.equal(attempts, 4); assert.equal(actions, 1);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('Windows persistent lock permission failures are bounded and preserve existing owner bytes', { skip: process.platform !== 'win32' }, async t => {
  const { context } = await fixture(t);
  const lock = path.join(context.stateDir, 'denied.lock');
  await fs.writeFile(lock, 'other-owner');
  const originalOpen = fs.open;
  let attempts = 0, actions = 0;
  const mock = t.mock.method(fs, 'open', async (file, flags, ...rest) => {
    if (file === lock && flags === 'wx') { attempts++; throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); }
    return originalOpen(file, flags, ...rest);
  });
  const started = Date.now();
  await assert.rejects(withLock(context, 'denied', () => { actions++; }), { code: 'EPERM' });
  mock.mock.restore();
  assert.ok(attempts > 1); assert.ok(Date.now() - started < 3500); assert.equal(actions, 0);
  assert.equal(await fs.readFile(lock, 'utf8'), 'other-owner');
});
