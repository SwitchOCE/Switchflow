import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { startGitBridge } from '../template/.switchflow/scripts/control/git-bridge.mjs';
import { requestGitBridge } from '../template/.switchflow/scripts/control/git-bridge-client.mjs';
import { resolveProject, digest, stable, readState } from '../template/.switchflow/scripts/operations/storage.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const planHash = digest('approved plan');
async function fixture(t, { nestedFile, initiativeId = 'fixture', targetStateDirLength } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-git-bridge-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Switchflow fixture']); git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(repo, 'baseline.txt'), 'baseline');
  if (nestedFile) { await fs.mkdir(path.dirname(path.join(repo, nestedFile)), { recursive: true }); await fs.writeFile(path.join(repo, nestedFile), 'nested baseline'); }
  git(repo, ['add', '--', 'baseline.txt', ...(nestedFile ? [nestedFile] : [])]); git(repo, ['commit', '-m', 'fixture baseline']);
  const baseHead = git(repo, ['rev-parse', 'HEAD']);
  const stateHome = path.join(root, targetStateDirLength ? 's'.repeat(Math.max(5, targetStateDirLength - '/projects/'.length - 64 - root.length - 1)) : 'state');
  const context = await resolveProject(repo, { stateHome });
  const runDirectory = path.join(context.stateDir, 'runs', randomUUID()); await fs.mkdir(runDirectory, { recursive: true });
  const controller = new AbortController();
  const bridge = await startGitBridge({ context, runDirectory, initiativeId, planHash, baseHead, signal: controller.signal });
  t.after(async () => { await bridge.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const request = data => requestGitBridge(bridge.descriptor.channelPath, data, { timeoutMs: 30000 });
  return { root, repo, context, baseHead, runDirectory, bridge, request, controller };
}

test('actual Git creates isolated registered candidates, commits exact files, merges frozen heads, and preserves primary dirt', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'unrelated.txt'), 'preserve');
  const [worker, target] = await Promise.all([f.request({ operation: 'create', name: 'worker' }), f.request({ operation: 'create', name: 'candidate' })]);
  assert.equal(worker.ok, true, worker.error); assert.equal(target.ok, true, target.error);
  assert.ok(worker.result.branch.includes(planHash.slice(0, 16)));
  assert.equal((await readState(f.context, 'worktrees')).entries.length, 2);
  await fs.writeFile(path.join(worker.result.path, 'feature.txt'), 'implemented');
  await fs.writeFile(path.join(worker.result.path, 'unrelated-worker.txt'), 'preserve');
  const commit = await f.request({ operation: 'commit', name: 'worker', expectedHead: f.baseHead, paths: ['feature.txt'], message: 'Implement focused feature' });
  assert.equal(commit.ok, true, commit.error);
  assert.equal(git(worker.result.path, ['show', '--format=', '--name-only', 'HEAD']), 'feature.txt');
  assert.match(git(worker.result.path, ['status', '--porcelain']), /unrelated-worker/);
  const dirtyMerge = await f.request({ operation: 'merge', source: 'worker', target: 'candidate', sourceHead: commit.result.head, targetHead: f.baseHead });
  assert.equal(dirtyMerge.ok, false); assert.match(dirtyMerge.error, /clean/);
  await fs.unlink(path.join(worker.result.path, 'unrelated-worker.txt'));
  const merged = await f.request({ operation: 'merge', source: 'worker', target: 'candidate', sourceHead: commit.result.head, targetHead: f.baseHead });
  assert.equal(merged.ok, true, merged.error); assert.equal(merged.result.head, commit.result.head);
  assert.equal(await fs.readFile(path.join(target.result.path, 'feature.txt'), 'utf8'), 'implemented');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.baseHead);
  assert.equal(git(f.repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await fs.readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'preserve');
});

test('rejects escapes, symlinks, primary names, protected paths, stale heads, and staged contamination', async t => {
  const f = await fixture(t); const created = await f.request({ operation: 'create', name: 'candidate' });
  assert.equal(created.ok, true, created.error);
  for (const file of ['../outside', ':!baseline.txt', '.git/config', '.agents/config', '.codex/config', '.git./config', '.agents /config', 'a/../../b', 'C:/outside', 'directory\\file']) {
    const response = await f.request({ operation: 'commit', name: 'candidate', expectedHead: f.baseHead, paths: [file], message: 'Should be refused' });
    assert.equal(response.ok, false, file); assert.match(response.error, /Unsafe/);
  }
  await fs.symlink(f.repo, path.join(created.result.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await f.request({ operation: 'commit', name: 'candidate', expectedHead: f.baseHead, paths: ['linked/baseline.txt'], message: 'Reject linked files' });
  assert.equal(linked.ok, false); assert.match(linked.error, /Linked/);
  const primary = await f.request({ operation: 'commit', name: 'main', expectedHead: f.baseHead, paths: ['baseline.txt'], message: 'Never primary checkout' });
  assert.equal(primary.ok, false); assert.match(primary.error, /Unknown managed/);
  const stale = await f.request({ operation: 'commit', name: 'candidate', expectedHead: 'a'.repeat(40), paths: ['baseline.txt'], message: 'Reject stale candidate' });
  assert.equal(stale.ok, false); assert.match(stale.error, /HEAD changed/);
  await fs.writeFile(path.join(created.result.path, 'staged.txt'), 'preexisting'); git(created.result.path, ['add', '--', 'staged.txt']);
  const staged = await f.request({ operation: 'commit', name: 'candidate', expectedHead: f.baseHead, paths: ['baseline.txt'], message: 'Preserve staged work' });
  assert.equal(staged.ok, false); assert.match(staged.error, /Preexisting staged/);
  assert.equal(git(created.result.path, ['diff', '--cached', '--name-only']), 'staged.txt');
  const arbitrary = await f.request({ operation: 'shell', command: 'anything' });
  assert.equal(arbitrary.ok, false); assert.match(arbitrary.error, /Unsupported/);
});

test('receipt replay is idempotent, payload-bound, and uncertain receipts never run again', async t => {
  const f = await fixture(t); const id = randomUUID(); const payload = { id, operation: 'create', name: 'candidate' };
  const first = await f.request(payload); assert.equal(first.ok, true, first.error);
  const second = await f.request(payload); assert.deepEqual(second, first);
  const changed = await f.request({ ...payload, name: 'different' });
  assert.equal(changed.ok, false); assert.match(changed.error, /different content/);
  const uncertain = { id: randomUUID(), operation: 'create', name: 'uncertain' };
  const receiptsRoot = path.join(f.context.stateDir, 'git-receipts', 'fixture', planHash);
  await fs.writeFile(path.join(receiptsRoot, `${uncertain.id}.json`), JSON.stringify({ id: uncertain.id, requestHash: digest(stable(uncertain)), status: 'started' }));
  const response = await f.request(uncertain); assert.equal(response.ok, false); assert.equal(response.uncertain, true);
  assert.equal(git(f.repo, ['branch', '--list', '*uncertain']).length, 0);
  await assert.rejects(f.request({ operation: 'create', name: 'after-uncertain' }), /closed/);
  await f.bridge.close();
  const nextRun = path.join(f.context.stateDir, 'runs', randomUUID()); await fs.mkdir(nextRun);
  await assert.rejects(startGitBridge({ context: f.context, runDirectory: nextRun, initiativeId: 'fixture', planHash, baseHead: f.baseHead }), /Uncertain prior Git operation/);
});

test('refuses candidate hooks and configured helpers instead of executing host code or skipping policy', async t => {
  const f = await fixture(t); const created = await f.request({ operation: 'create', name: 'candidate' }); assert.equal(created.ok, true, created.error);
  const hooks = path.join(created.result.path, '.hooks'); await fs.mkdir(hooks);
  const marker = path.join(f.repo, 'host-hook-ran.txt');
  await fs.writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho host-execution > '${marker.replaceAll('\\', '/')}'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(created.result.path, 'feature.txt'), 'safe');
  git(f.repo, ['config', 'core.hooksPath', '.hooks']);
  const response = await f.request({ operation: 'commit', name: 'candidate', expectedHead: f.baseHead, paths: ['feature.txt'], message: 'Never execute host hook' });
  assert.equal(response.ok, false); assert.match(response.error, /refuses configured Git hook/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  git(f.repo, ['config', '--unset', 'core.hooksPath']);
  for (const [key, value] of [['commit.gpgsign', 'true'], ['core.fsmonitor', 'echo attack']]) {
    git(f.repo, ['config', key, value]);
    const refused = await f.request({ operation: 'commit', name: 'candidate', expectedHead: f.baseHead, paths: ['feature.txt'], message: 'Refuse configured helper' });
    assert.equal(refused.ok, false, key); assert.match(refused.error, /refuses configured executable/);
    git(f.repo, ['config', '--unset', key]);
  }
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.baseHead);
});

test('selected mixed-case clean and process filters fail closed without host execution', async t => {
  const f = await fixture(t); const marker = path.join(f.repo, 'filter-executed.txt').replaceAll('\\', '/');
  for (const kind of ['clean', 'process']) {
    const created = await f.request({ operation: 'create', name: `filter-${kind}` }); assert.equal(created.ok, true, created.error);
    await fs.writeFile(path.join(created.result.path, '.gitattributes'), 'feature.txt filter=MyFilter\n');
    await fs.writeFile(path.join(created.result.path, 'feature.txt'), 'must not transform');
    git(f.repo, ['config', `filter.MyFilter.${kind}`, `sh -c "echo host-execution > '${marker}'; exit 1"`]);
    const response = await f.request({ operation: 'commit', name: `filter-${kind}`, expectedHead: f.baseHead, paths: ['.gitattributes', 'feature.txt'], message: 'Refuse required host filter' });
    assert.equal(response.ok, false); assert.match(response.error, /filter.*failed|clean filter/i);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    assert.equal(git(created.result.path, ['rev-parse', 'HEAD']), f.baseHead);
    git(f.repo, ['config', '--unset', `filter.MyFilter.${kind}`]);
  }
});

test('checkout selected smudge filter fails closed without running its executable', async t => {
  const f = await fixture(t); const marker = path.join(f.repo, 'smudge-executed.txt').replaceAll('\\', '/');
  await fs.writeFile(path.join(f.repo, '.gitattributes'), 'filtered.txt filter=MySmudge\n');
  await fs.writeFile(path.join(f.repo, 'filtered.txt'), 'unchanged');
  git(f.repo, ['add', '--', '.gitattributes', 'filtered.txt']); git(f.repo, ['commit', '-m', 'fixture filtered baseline']);
  git(f.repo, ['config', 'filter.MySmudge.smudge', `sh -c "echo host-execution > '${marker}'; exit 1"`]);
  const nextRun = path.join(f.context.stateDir, 'runs', randomUUID()); await fs.mkdir(nextRun);
  const next = await startGitBridge({ context: f.context, runDirectory: nextRun, initiativeId: 'fixture', planHash: digest('filtered baseline'), baseHead: git(f.repo, ['rev-parse', 'HEAD']) });
  try {
    const response = await requestGitBridge(next.descriptor.channelPath, { operation: 'create', name: 'filtered' });
    assert.equal(response.ok, false); assert.match(response.error, /filter.*failed|smudge filter/i);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  } finally { await next.close(); }
});

test('new approved plan can reuse candidate names without colliding with preserved branches', async t => {
  const f = await fixture(t); const first = await f.request({ operation: 'create', name: 'candidate' }); assert.equal(first.ok, true, first.error);
  const nextRun = path.join(f.context.stateDir, 'runs', randomUUID()); await fs.mkdir(nextRun);
  const next = await startGitBridge({ context: f.context, runDirectory: nextRun, initiativeId: 'fixture', planHash: digest('revised approved plan'), baseHead: f.baseHead });
  try {
    const second = await requestGitBridge(next.descriptor.channelPath, { operation: 'create', name: 'candidate' });
    assert.equal(second.ok, true, second.error); assert.notEqual(first.result.path, second.result.path); assert.notEqual(first.result.branch, second.result.branch);
  } finally { await next.close(); }
});

test('cancellation refuses new admission and close is idempotent', async t => {
  const f = await fixture(t); f.controller.abort(); await f.bridge.close(); await f.bridge.close();
  await assert.rejects(f.request({ operation: 'create', name: 'late' }), /closed/);
  assert.equal(git(f.repo, ['branch', '--list', '*late']).length, 0);
});

test('cancellation lets an already claimed Git operation settle without admitting another', async t => {
  const f = await fixture(t); const id = randomUUID();
  const first = f.request({ id, operation: 'create', name: 'in-flight' });
  const receipt = path.join(f.context.stateDir, 'git-receipts', 'fixture', planHash, `${id}.json`);
  const deadline = Date.now() + 10000; let claimed = false;
  while (Date.now() < deadline) {
    try { claimed = JSON.parse(await fs.readFile(receipt, 'utf8')).status === 'started'; if (claimed) break; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(claimed, true);
  f.controller.abort(); await f.bridge.close();
  const response = await first; assert.equal(response.ok, true, response.error);
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).status, 'complete');
  await assert.rejects(f.request({ operation: 'create', name: 'after-cancel' }), /closed/);
});

test('bridge-origin conflicts can be resolved only with frozen identity and uncontaminated exact paths', async t => {
  const f = await fixture(t);
  const source = await f.request({ operation: 'create', name: 'source' }); const target = await f.request({ operation: 'create', name: 'target' });
  await fs.writeFile(path.join(source.result.path, 'baseline.txt'), 'source change'); await fs.writeFile(path.join(target.result.path, 'baseline.txt'), 'target change');
  await fs.writeFile(path.join(source.result.path, 'automatic.txt'), 'automatic merge content');
  const sourceCommit = await f.request({ operation: 'commit', name: 'source', expectedHead: f.baseHead, paths: ['baseline.txt', 'automatic.txt'], message: 'Source conflict fixture' });
  const targetCommit = await f.request({ operation: 'commit', name: 'target', expectedHead: f.baseHead, paths: ['baseline.txt'], message: 'Target conflict fixture' });
  const conflict = await f.request({ operation: 'merge', source: 'source', target: 'target', sourceHead: sourceCommit.result.head, targetHead: targetCommit.result.head });
  assert.equal(conflict.ok, false); assert.match(conflict.error, /Git merge failed/);
  assert.equal(git(target.result.path, ['rev-parse', 'MERGE_HEAD']), sourceCommit.result.head);
  assert.equal(git(target.result.path, ['rev-parse', 'HEAD']), targetCommit.result.head);
  const refused = await f.request({ operation: 'commit', name: 'target', expectedHead: targetCommit.result.head, paths: ['baseline.txt'], message: 'Do not hide unfinished merge' });
  assert.equal(refused.ok, false); assert.match(refused.error, /unfinished Git operation/);
  assert.deepEqual(conflict.conflict.resolvePaths, ['baseline.txt']);
  const resolution = { operation: 'merge', ...conflict.conflict };
  const mismatched = await f.request({ ...resolution, resolvePaths: ['automatic.txt'] });
  assert.equal(mismatched.ok, false); assert.match(mismatched.error, /exactly the recorded/);
  const staleSource = await f.request({ ...resolution, sourceHead: f.baseHead });
  assert.equal(staleSource.ok, false); assert.match(staleSource.error, /HEAD changed/);
  const staleTarget = await f.request({ ...resolution, targetHead: f.baseHead });
  assert.equal(staleTarget.ok, false); assert.match(staleTarget.error, /HEAD changed/);
  git(source.result.path, ['update-ref', `refs/heads/${source.result.branch}`, f.baseHead, sourceCommit.result.head]);
  const movedSource = await f.request(resolution); assert.equal(movedSource.ok, false); assert.match(movedSource.error, /HEAD changed/);
  git(source.result.path, ['update-ref', `refs/heads/${source.result.branch}`, sourceCommit.result.head, f.baseHead]);
  git(target.result.path, ['update-ref', `refs/heads/${target.result.branch}`, f.baseHead, targetCommit.result.head]);
  const movedTarget = await f.request(resolution); assert.equal(movedTarget.ok, false); assert.match(movedTarget.error, /HEAD changed/);
  git(target.result.path, ['update-ref', `refs/heads/${target.result.branch}`, targetCommit.result.head, f.baseHead]);
  await fs.writeFile(path.join(target.result.path, 'baseline.txt'), 'reviewed source and target resolution');
  await fs.writeFile(path.join(target.result.path, 'unrelated.txt'), 'preserve untracked');
  const untracked = await f.request(resolution); assert.equal(untracked.ok, false); assert.match(untracked.error, /Untracked files/);
  assert.equal(await fs.readFile(path.join(target.result.path, 'unrelated.txt'), 'utf8'), 'preserve untracked');
  await fs.unlink(path.join(target.result.path, 'unrelated.txt'));
  await fs.writeFile(path.join(target.result.path, 'automatic.txt'), 'unrelated worktree edit');
  const dirty = await f.request(resolution); assert.equal(dirty.ok, false); assert.match(dirty.error, /Unrelated worktree changes/);
  git(target.result.path, ['add', '--', 'automatic.txt']);
  const indexed = await f.request(resolution); assert.equal(indexed.ok, false); assert.match(indexed.error, /Unrelated index entries/);
  await fs.writeFile(path.join(target.result.path, 'automatic.txt'), 'automatic merge content'); git(target.result.path, ['add', '--', 'automatic.txt']);
  const resolved = await f.request(resolution); assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(resolved.result.resolvedPaths, ['baseline.txt']);
  assert.equal(await fs.readFile(path.join(target.result.path, 'automatic.txt'), 'utf8'), 'automatic merge content');
  assert.equal(await fs.readFile(path.join(target.result.path, 'baseline.txt'), 'utf8'), 'reviewed source and target resolution');
  assert.equal(git(target.result.path, ['status', '--porcelain']), '');
  assert.deepEqual(git(target.result.path, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1), [targetCommit.result.head, sourceCommit.result.head]);
  const registry = await readState(f.context, `git-bridge-fixture-${planHash}`);
  assert.equal(registry.entries.find(entry => entry.name === 'target').pendingMerge, undefined);
  const replayResolution = await f.request(resolution); assert.equal(replayResolution.ok, false); assert.match(replayResolution.error, /HEAD changed/);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.baseHead);
});

test('stdin CLI uses the same constrained protocol', async t => {
  const f = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [f.bridge.descriptor.helperPath, f.bridge.descriptor.channelPath], { shell: false, windowsHide: true });
    let output = ''; let errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(errors)); else resolve(JSON.parse(output)); });
    child.stdin.end(JSON.stringify({ operation: 'create', name: 'cli-candidate' }));
  });
  assert.equal(response.ok, true); assert.ok(response.result.path.startsWith(f.bridge.descriptor.managedRoot));
});

test('deep imported-style candidate paths work without changing global Git configuration', async t => {
  const nestedFile = `backlog/docs/${'nested-'.repeat(10)}/long-contract-description-that-remains-readable.md`;
  const f = await fixture(t, { nestedFile });
  const response = await f.request({ operation: 'create', name: 'long-candidate' });
  assert.equal(response.ok, true, response.error);
  const file = path.join(response.result.path, nestedFile);
  assert.ok(file.length > 260); assert.equal(await fs.readFile(file, 'utf8'), 'nested baseline');
});

test('compact grant layout handles the actual deep state and UUID shape while retaining old failed branches', async t => {
  const initiativeId = 'df494fb1-902a-4555-8608-ac3057c0bafa';
  const f = await fixture(t, { initiativeId, targetStateDirLength: 146 });
  assert.equal(f.context.stateDir.length, 146);
  const oldPath = path.join(f.context.stateDir, 'candidates', initiativeId, planHash.slice(0, 16), 'hello-candidate');
  assert.equal(oldPath.length, 227);
  const oldBranch = `codex/switchflow-${initiativeId}-${planHash.slice(0, 16)}-hello-candidate`;
  if (process.platform === 'win32') {
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    assert.throws(() => git(f.repo, ['-c', 'core.longpaths=true', 'worktree', 'add', '-b', oldBranch, oldPath, f.baseHead]), /too big/);
    assert.equal(git(f.repo, ['rev-parse', oldBranch]), f.baseHead);
  }
  const response = await f.request({ operation: 'create', name: 'hello-retry' });
  assert.equal(response.ok, true, response.error);
  assert.ok(Buffer.byteLength(path.join(response.result.path, '.git')) <= 220);
  assert.equal(await fs.readFile(path.join(response.result.path, 'baseline.txt'), 'utf8'), 'baseline');
  if (process.platform === 'win32') assert.equal(git(f.repo, ['rev-parse', oldBranch]), f.baseHead);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.baseHead);
});

test('Windows Git-root preflight rejects an excessive root before creating any branch', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { targetStateDirLength: 195 });
  const before = git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const response = await f.request({ operation: 'create', name: 'candidate' });
  assert.equal(response.ok, false); assert.match(response.error, /220-byte setup limit/);
  assert.equal(git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)']), before);
});

test('legacy registered candidates keep their original paths across bridge restart', async t => {
  const f = await fixture(t); await f.bridge.close();
  const legacyRoot = path.join(f.context.stateDir, 'candidates', 'fixture', planHash.slice(0, 16));
  const candidatePath = path.join(legacyRoot, 'existing'); await fs.mkdir(legacyRoot, { recursive: true });
  const branch = `codex/switchflow-fixture-${planHash.slice(0, 16)}-existing`;
  git(f.repo, ['worktree', 'add', '-b', branch, candidatePath, f.baseHead]);
  await fs.writeFile(path.join(f.context.stateDir, `git-bridge-fixture-${planHash}.json`), JSON.stringify({
    schemaVersion: 1, initiativeId: 'fixture', planHash, baseHead: f.baseHead,
    entries: [{ name: 'existing', path: candidatePath, branch, baseHead: f.baseHead, lastHead: f.baseHead }],
  }));
  const nextRun = path.join(f.context.stateDir, 'runs', randomUUID()); await fs.mkdir(nextRun, { recursive: true });
  const next = await startGitBridge({ context: f.context, runDirectory: nextRun, initiativeId: 'fixture', planHash, baseHead: f.baseHead });
  try {
    assert.equal(next.descriptor.managedRoot, legacyRoot);
    await fs.writeFile(path.join(candidatePath, 'preserved.txt'), 'legacy continuation');
    const response = await requestGitBridge(next.descriptor.channelPath, { operation: 'commit', name: 'existing', expectedHead: f.baseHead, paths: ['preserved.txt'], message: 'Continue existing managed candidate' });
    assert.equal(response.ok, true, response.error);
    assert.equal((await readState(f.context, `git-bridge-fixture-${planHash}`)).entries[0].path, candidatePath);
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.baseHead);
  } finally { await next.close(); }
});
