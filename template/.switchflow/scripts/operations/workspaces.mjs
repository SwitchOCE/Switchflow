import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, digest, readState, updateState, assertSafePath, withLock } from './storage.mjs';

export async function inspectWorktrees(context) {
  const registry = await readState(context, 'worktrees', { entries: [] });
  return git(context.sourceRoot, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n'); const worktreePath = path.resolve(lines[0].slice(9));
    const registration = registry.entries.find(e => path.resolve(e.path) === path.resolve(worktreePath));
    let dirty = true;
    try { dirty = Boolean(git(worktreePath, ['status', '--porcelain'])); } catch {}
    return { path: worktreePath, head: lines.find(l => l.startsWith('HEAD '))?.slice(5), branch: lines.find(l => l.startsWith('branch '))?.slice(7), owner: registration?.owner || 'unknown', registered: Boolean(registration), dirty, cleanup: 'preserve; use cleanup-phase.ps1 for proven clean merged worktrees' };
  });
}
export async function registerWorktree(context, { path: worktreePath = context.sourceRoot, owner, purpose = '' }) {
  if (!['codex', 'orchestrator', 'human'].includes(owner)) throw new Error('Owner must be codex, orchestrator, or human');
  const real = await fs.realpath(worktreePath);
  if (!(await inspectWorktrees(context)).some(w => path.resolve(w.path) === real)) throw new Error('Worktree is not part of this project');
  const entry = { path: real, owner, purpose, registeredAt: new Date().toISOString() };
  await updateState(context, 'worktrees', state => { state.entries = state.entries.filter(e => e.path !== real); state.entries.push(entry); }, { entries: [] });
  return entry;
}
export async function writeScratch(context, { content, label = 'scratch', retentionDays = 30 }) {
  if (typeof content !== 'string' || !Number.isFinite(retentionDays) || retentionDays < 0) throw new Error('Content and nonnegative retentionDays required');
  return withLock(context, 'scratch-files', async () => {
    const id = randomUUID(); const relativePath = path.join('scratch', `${id}.txt`);
    const target = await assertSafePath(context.stateDir, path.join(context.stateDir, relativePath));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'wx' });
    const entry = { id, relativePath, label, digest: digest(content), createdAt: new Date().toISOString(), retainUntil: new Date(Date.now() + retentionDays * 86400000).toISOString(), referenced: false };
    await updateState(context, 'scratch', state => { state.entries.push(entry); }, { entries: [] });
    return entry;
  });
}
// Reading content requires this explicit promotion operation; inventory never ingests it.
export async function promoteScratch(context, id, governanceName) {
  if (!/^[a-zA-Z0-9_-]+$/.test(governanceName)) throw new Error('Invalid governance document name');
  return withLock(context, 'scratch-files', async () => {
    const entry = (await readState(context, 'scratch', { entries: [] })).entries.find(e => e.id === id);
    if (!entry || entry.deletedAt) throw new Error('Unknown scratch entry');
    const source = await assertSafePath(context.stateDir, path.join(context.stateDir, entry.relativePath));
    const content = await fs.readFile(source);
    if (digest(content) !== entry.digest) throw new Error('Scratch changed since registration');
    const destination = await assertSafePath(context.stateDir, path.join(context.stateDir, 'governance', `${governanceName}.txt`));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: 'wx' });
    await updateState(context, 'scratch', state => { const current = state.entries.find(e => e.id === id); current.referenced = true; current.promotedTo = path.relative(context.stateDir, destination); });
    return { id, destination };
  });
}
export async function planRetention(context, { now = Date.now() } = {}) {
  const entries = (await readState(context, 'scratch', { entries: [] })).entries;
  const candidates = []; const preserved = [];
  for (const entry of entries.filter(e => !e.deletedAt)) {
    let reason = entry.referenced ? 'referenced evidence' : Date.parse(entry.retainUntil) > now ? 'retention active' : null;
    try {
      if (!entry.relativePath.startsWith('scratch' + path.sep)) throw new Error('Not a managed scratch file');
      const target = await assertSafePath(context.stateDir, path.join(context.stateDir, entry.relativePath));
      const stat = await fs.lstat(target);
      if (!stat.isFile() || digest(await fs.readFile(target)) !== entry.digest) reason = 'modified or non-file';
    } catch (error) { reason = error.message; }
    (reason ? preserved : candidates).push(reason ? { ...entry, reason } : entry);
  }
  return { dryRun: true, candidates, preserved, worktrees: 'never deleted by operations retention', unknownFiles: 'preserved' };
}
export async function applyRetention(context, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Explicit scratch IDs required');
  return withLock(context, 'scratch-files', async () => {
    const plan = await planRetention(context);
    const selected = ids.map(id => { const entry = plan.candidates.find(e => e.id === id); if (!entry) throw new Error(`Scratch is not eligible: ${id}`); return entry; });
    for (const entry of selected) {
      const target = await assertSafePath(context.stateDir, path.join(context.stateDir, entry.relativePath));
      if (digest(await fs.readFile(target)) !== entry.digest) throw new Error('Scratch changed during cleanup');
      await fs.unlink(target);
      await updateState(context, 'scratch', state => { state.entries.find(e => e.id === entry.id).deletedAt = new Date().toISOString(); });
    }
    return { deleted: selected.map(e => e.id) };
  });
}
