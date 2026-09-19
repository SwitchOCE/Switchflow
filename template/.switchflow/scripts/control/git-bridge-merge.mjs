import { digest, updateState } from '../operations/storage.mjs';

/** Only bridge-origin conflicts can be finalized; no generic index/merge manipulation. */
export function createMergeHandler({ context, registryName, empty, git, managed, assertHead, clean, validatePaths, head, saveHead }) {
  const paths = text => text.split('\0').filter(Boolean);
  const indexDigest = async (entry, conflicts) => digest((await git(entry.path, ['ls-files', '--stage', '-z'])).split('\0').filter(line => line && !conflicts.includes(line.slice(line.indexOf('\t') + 1))).join('\0'));
  const recordPending = (name, pending) => updateState(context, registryName, state => {
    const entry = state.entries.find(item => item.name === name);
    if (!entry) throw new Error('Candidate registration disappeared');
    if (pending) entry.pendingMerge = pending; else delete entry.pendingMerge;
  }, empty);

  return async (request, registry) => {
    if (request.source === request.target) throw new Error('Merge needs distinct managed candidates');
    const source = await managed(request.source, registry); const target = await managed(request.target, registry);
    await assertHead(source, request.sourceHead); await assertHead(target, request.targetHead);
    await clean(source);

    if (request.resolvePaths !== undefined) {
      const pending = target.pendingMerge;
      if (!pending || pending.source !== request.source || pending.sourceHead !== request.sourceHead || pending.targetHead !== request.targetHead) throw new Error('Resolution does not match a bridge-recorded pending merge');
      if (await git(target.path, ['rev-parse', '--verify', 'MERGE_HEAD']) !== request.sourceHead) throw new Error('Pending merge identity changed');
      await validatePaths(target, request.resolvePaths);
      if (JSON.stringify([...request.resolvePaths].sort()) !== JSON.stringify([...pending.conflicts].sort())) throw new Error('Resolution must name exactly the recorded conflict paths');
      if (await indexDigest(target, pending.conflicts) !== pending.indexRestDigest) throw new Error('Unrelated index entries changed during conflict resolution');
      if (paths(await git(target.path, ['diff', '--name-only', '-z'])).some(file => !pending.conflicts.includes(file))) throw new Error('Unrelated worktree changes must be preserved outside merge resolution');
      if (await git(target.path, ['ls-files', '--others', '--exclude-standard', '-z'])) throw new Error('Untracked files must be preserved outside merge resolution');
      await git(target.path, ['add', '--', ...request.resolvePaths]);
      if (await git(target.path, ['diff', '--name-only', '--diff-filter=U', '-z'])) throw new Error('Merge still has unresolved index entries');
      if (await indexDigest(target, pending.conflicts) !== pending.indexRestDigest) throw new Error('Unrelated index entries changed while staging resolution');
      await git(target.path, ['commit', '--no-edit', '-m', `Merge managed candidate ${request.source} into ${request.target}`]);
      const merged = await head(target);
      const parents = (await git(target.path, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ');
      if (parents.length !== 3 || parents[1] !== request.targetHead || parents[2] !== request.sourceHead) {
        const error = new Error('Resolved merge commit parents did not match the frozen merge identity'); error.uncertain = true; throw error;
      }
      await saveHead(target.name, merged); await recordPending(target.name, null);
      return { name: target.name, path: target.path, branch: target.branch, head: merged, sourceHead: request.sourceHead, resolvedPaths: request.resolvePaths };
    }

    if (target.pendingMerge) throw new Error('Candidate has a recorded pending merge; use its exact resolvePaths contract');
    await clean(target);
    try { await git(target.path, ['merge', '--no-edit', '--', request.sourceHead]); }
    catch (error) {
      if (error.uncertain) throw error;
      let mergeHead;
      try { mergeHead = await git(target.path, ['rev-parse', '--verify', 'MERGE_HEAD']); } catch { throw error; }
      const conflicts = paths(await git(target.path, ['diff', '--name-only', '--diff-filter=U', '-z']));
      if (mergeHead !== request.sourceHead || !conflicts.length || await head(target) !== request.targetHead) throw error;
      const pending = { source: request.source, sourceHead: request.sourceHead, targetHead: request.targetHead, conflicts, indexRestDigest: await indexDigest(target, conflicts), recordedAt: new Date().toISOString() };
      await recordPending(target.name, pending);
      error.message += '\nThe bridge recorded this conflict. Resolve only the named files in the sandbox, review the resulting diff, then repeat merge with resolvePaths.';
      error.mergeConflict = { source: request.source, target: request.target, sourceHead: request.sourceHead, targetHead: request.targetHead, resolvePaths: conflicts };
      throw error;
    }
    const merged = await head(target); await saveHead(target.name, merged);
    return { name: target.name, path: target.path, branch: target.branch, head: merged, sourceHead: request.sourceHead };
  };
}
