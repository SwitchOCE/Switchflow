import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { previewUatArtifact } from '../template/.switchflow/scripts/control/artifacts.mjs';
import { digest, updateState } from '../template/.switchflow/scripts/operations/storage.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, layout = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-art-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  git(repo, ['init', '--initial-branch=main']); git(repo, ['config', 'user.name', 'Artifact tests']); git(repo, ['config', 'user.email', 'artifact@example.invalid']);
  const exact = '  # Delivered text\n\nContent with trailing spaces.  \n\n';
  await fs.writeFile(path.join(repo, 'HELLO.md'), exact);
  await fs.writeFile(path.join(repo, 'binary'), Buffer.from([0, 1, 2])); await fs.writeFile(path.join(repo, 'invalid'), Buffer.from([0xc3, 0x28]));
  await fs.writeFile(path.join(repo, 'large'), 'x'.repeat(128 * 1024 + 1));
  await fs.mkdir(path.join(repo, '.agents')); await fs.writeFile(path.join(repo, '.agents', 'secret'), 'protected');
  git(repo, ['add', '.']);
  const linkBlob = git(repo, ['hash-object', '-w', 'HELLO.md']); git(repo, ['update-index', '--add', '--cacheinfo', `120000,${linkBlob},tracked-link`]);
  git(repo, ['commit', '-m', 'Artifact baseline']); const head = git(repo, ['rev-parse', 'HEAD']);
  const context = { sourceRoot: repo, governanceRoot: repo, commonDir: await fs.realpath(path.join(repo, '.git')), stateDir: path.join(root, 's') };
  const id = 'fixture'; const grant = digest('approved-grant'); const name = 'candidate'; const branch = `codex/switchflow-${id}-${grant.slice(0, 16)}-${name}`;
  const candidate = path.join(context.stateDir, 'candidates', ...(layout === 1 ? [id, grant.slice(0, 16)] : [digest(`${id}:${grant}`).slice(0, 16)]), name);
  await fs.mkdir(path.dirname(candidate), { recursive: true }); git(repo, ['worktree', 'add', '-b', branch, candidate, head]);
  const registryName = `git-bridge-${id}-${grant}`;
  const registry = { schemaVersion: 1, ...(layout === 1 ? {} : { layoutVersion: layout }), initiativeId: id, planHash: grant, baseHead: head, entries: [{ name, path: candidate, branch, baseHead: head, lastHead: head }] };
  await updateState(context, registryName, () => registry);
  const item = { id, stage: 'uat', approvedPlan: { gitGrantHash: grant, baseHead: head }, uat: [] };
  const reference = file => { item.uat = [{ id: 'step', title: `Open [artifact](${file}).` }]; return previewUatArtifact(context, item, { stepId: 'step', index: 0 }); };
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, candidate, context, item, head, exact, registry, registryName, reference };
}

for (const layout of [1, 2]) test(`fixed committed UTF-8 preview preserves bytes and ignores working edits (layout ${layout})`, async t => {
  const f = await fixture(t, layout);
  await fs.writeFile(path.join(f.candidate, 'HELLO.md'), 'uncommitted replacement');
  const result = await f.reference(path.join(f.candidate, 'HELLO.md'));
  assert.equal(result.content, f.exact); assert.equal(result.head, f.head); assert.equal(result.bytes, Buffer.byteLength(f.exact));
  if (process.platform === 'win32') {
    const alternateDriveCase = path.join(f.candidate, 'HELLO.md').replace(/^[A-Za-z]/, value => value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase());
    assert.equal((await f.reference(alternateDriveCase)).content, f.exact);
  }
  f.item.stage = 'complete'; assert.equal((await f.reference(path.join(f.candidate, 'HELLO.md'))).content, f.exact);
  f.item.stage = 'delivery'; await assert.rejects(f.reference(path.join(f.candidate, 'HELLO.md')), /requires an approved delivery/);
});

test('rejects arbitrary references, other grants, registry mismatch, paths outside candidates, and protected/traversal paths', async t => {
  const f = await fixture(t); await f.reference(path.join(f.candidate, 'HELLO.md'));
  await assert.rejects(previewUatArtifact(f.context, f.item, { stepId: 'invented', index: 0 }), /not an exact UAT/);
  await assert.rejects(f.reference(path.join(f.repo, 'HELLO.md')), /not in a registered candidate/);
  for (const file of ['.git/config', '.agents/secret', '.codex/settings', '../candidate/HELLO.md']) await assert.rejects(f.reference(`${f.candidate}/${file}`), /Protected|traversal/);
  await fs.writeFile(path.join(f.candidate, 'untracked'), 'not committed'); await assert.rejects(f.reference(path.join(f.candidate, 'untracked')), /tracked regular file/);
  const original = f.item.approvedPlan.gitGrantHash; f.item.approvedPlan.gitGrantHash = digest('other grant');
  await assert.rejects(f.reference(path.join(f.candidate, 'HELLO.md')), /registry identity/); f.item.approvedPlan.gitGrantHash = original;
  await updateState(f.context, f.registryName, state => { state.planHash = digest('mismatch'); });
  await assert.rejects(f.reference(path.join(f.candidate, 'HELLO.md')), /registry identity/);
});

test('rejects stale HEAD, redirected candidate identity, and linked paths', async t => {
  const f = await fixture(t);
  await fs.symlink(f.repo, path.join(f.candidate, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.reference(path.join(f.candidate, 'linked', 'HELLO.md')), /Linked paths/);
  await updateState(f.context, f.registryName, state => { state.entries[0].branch = 'main'; });
  await assert.rejects(f.reference(path.join(f.candidate, 'HELLO.md')), /branch or recorded HEAD/);
  await updateState(f.context, f.registryName, () => structuredClone(f.registry));
  await fs.writeFile(path.join(f.candidate, 'HELLO.md'), 'new commit'); git(f.candidate, ['add', 'HELLO.md']); git(f.candidate, ['commit', '-m', 'Unregistered commit']);
  await assert.rejects(f.reference(path.join(f.candidate, 'HELLO.md')), /HEAD changed/);
});

test('refuses binary, invalid UTF-8 and oversized committed blobs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reference(path.join(f.candidate, 'binary')), /Binary/);
  await assert.rejects(f.reference(path.join(f.candidate, 'tracked-link')), /tracked regular file|Linked paths/);
  await assert.rejects(f.reference(path.join(f.candidate, 'invalid')), /valid UTF-8/);
  await assert.rejects(f.reference(path.join(f.candidate, 'large')), /128 KiB/);
});
