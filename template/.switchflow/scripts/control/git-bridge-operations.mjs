import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath, digest, readState, updateState } from '../operations/storage.mjs';
import { createSafeGit } from './git-bridge-git.mjs';
import { createMergeHandler } from './git-bridge-merge.mjs';

export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function requireFields(request, required, optional = []) {
  if (required.some(key => !(key in request)) || Object.keys(request).some(key => !['id', 'operation', ...required, ...optional].includes(key))) throw new Error('Missing or unsupported Git bridge fields');
}

export function validateBridgeIdentity({ initiativeId, planHash, baseHead }) {
  if (typeof initiativeId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(initiativeId)) throw new Error('Invalid initiative ID');
  if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) throw new Error('Invalid approved plan hash');
  if (!isSha(baseHead)) throw new Error('An immutable approved Git baseline is required');
}

export async function createGitOperations({ context, initiativeId, planHash, baseHead }) {
  validateBridgeIdentity({ initiativeId, planHash, baseHead });
  const registryName = `git-bridge-${initiativeId}-${planHash}`;
  const existing = await readState(context, registryName, null);
  // Existing registered candidates retain their original location. New grants use a
  // compact composite identity: Windows Git rejects GIT_DIR above PATH_MAX - 40
  // even when core.longpaths permits longer filenames inside the working tree.
  const layoutVersion = existing ? existing.layoutVersion ?? 1 : 2;
  if (![1, 2].includes(layoutVersion)) throw new Error('Unsupported managed candidate layout');
  const grantPath = layoutVersion === 1 ? [initiativeId, planHash.slice(0, 16)] : [digest(`${initiativeId}:${planHash}`).slice(0, 16)];
  const managedRoot = await assertSafePath(context.stateDir, path.join(context.stateDir, 'candidates', ...grantPath));
  await fs.mkdir(managedRoot, { recursive: true });
  const sourceRoot = await fs.realpath(context.sourceRoot);
  const commonDir = await fs.realpath(context.commonDir);
  const git = createSafeGit(commonDir, [sourceRoot, context.governanceRoot, context.stateDir].filter(Boolean).map(value => path.resolve(value)));
  if (await git(sourceRoot, ['rev-parse', '--verify', `${baseHead}^{commit}`]) !== baseHead) throw new Error('Baseline is not an existing commit');
  const empty = { schemaVersion: 1, layoutVersion, initiativeId, planHash, baseHead, entries: [] };
  const readRegistry = async () => {
    const registry = await readState(context, registryName, empty);
    if (registry.schemaVersion !== 1 || registry.initiativeId !== initiativeId || registry.planHash !== planHash || registry.baseHead !== baseHead || !Array.isArray(registry.entries)) throw new Error('Git bridge registry identity mismatch');
    return registry;
  };
  await readRegistry();

  const managed = async (name, registry) => {
    if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('Invalid managed candidate name');
    const entry = registry.entries.find(item => item.name === name);
    if (!entry) throw new Error('Unknown managed candidate');
    if (entry.branch !== `codex/switchflow-${initiativeId}-${planHash.slice(0, 16)}-${name}`) throw new Error('Managed candidate branch identity mismatch');
    const expected = await assertSafePath(managedRoot, path.join(managedRoot, name));
    if (!samePath(entry.path, expected) || !samePath(await fs.realpath(entry.path), expected)) throw new Error('Managed candidate path changed');
    if (samePath(expected, sourceRoot) || samePath(expected, context.governanceRoot)) throw new Error('Primary checkout is not a managed candidate');
    const actualCommon = await fs.realpath(path.resolve(expected, await git(expected, ['rev-parse', '--git-common-dir'])));
    if (!samePath(actualCommon, commonDir)) throw new Error('Candidate repository changed');
    if (!samePath(await fs.realpath(await git(expected, ['rev-parse', '--show-toplevel'])), expected)) throw new Error('Candidate worktree root changed');
    if (await git(expected, ['symbolic-ref', '--short', 'HEAD']) !== entry.branch) throw new Error('Candidate branch changed');
    return entry;
  };
  const head = entry => git(entry.path, ['rev-parse', 'HEAD']);
  const assertHead = async (entry, expectedHead) => { if (!isSha(expectedHead) || await head(entry) !== expectedHead) throw new Error('Candidate HEAD changed; inspect before retrying'); };
  const noOperation = async entry => {
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const markerPath = await git(entry.path, ['rev-parse', '--git-path', marker]);
      try { await fs.lstat(path.resolve(entry.path, markerPath)); throw new Error('Candidate has an unfinished Git operation'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const clean = async entry => {
    await noOperation(entry);
    if (await git(entry.path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Candidate must be clean before merge');
  };
  const saveHead = async (name, value) => updateState(context, registryName, registry => {
    const entry = registry.entries.find(item => item.name === name);
    if (!entry) throw new Error('Candidate registration disappeared');
    entry.lastHead = value;
  }, empty);
  const validatePaths = async (entry, files) => {
    if (!Array.isArray(files) || !files.length || files.length > 300 || new Set(files).size !== files.length) throw new Error('Exact unique file paths required');
    for (const relative of files) {
      if (typeof relative !== 'string' || !relative || relative.length > 1000 || relative.includes('\\') || /[:*?\x00-\x1f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || ['.git', '.agents', '.codex'].includes(part.toLowerCase()))) throw new Error('Unsafe commit file path');
      const file = await assertSafePath(entry.path, path.join(entry.path, relative));
      try { if (!(await fs.lstat(file)).isFile()) throw new Error('Commit paths must be regular files'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await git(entry.path, ['ls-files', '--error-unmatch', '--', relative]); }
      if ((await git(entry.path, ['ls-files', '--stage', '--', relative])).split('\n').some(line => line.startsWith('120000 '))) throw new Error('Tracked symlink paths are not accepted');
    }
  };
  const merge = createMergeHandler({ context, registryName, empty, git, managed, assertHead, clean, validatePaths, head, saveHead });

  return {
    managedRoot,
    async perform(request) {
      const registry = await readRegistry();
      if (request.operation === 'create') {
        requireFields(request, ['name'], ['baseHead']);
        if (typeof request.name !== 'string' || !namePattern.test(request.name)) throw new Error('Invalid managed candidate name');
        if (registry.entries.some(entry => entry.name === request.name)) throw new Error('Candidate name already registered; reuse its recorded path');
        const base = request.baseHead ?? baseHead;
        if (!isSha(base)) throw new Error('Create requires an immutable base HEAD');
        let allowed = base === baseHead;
        if (!allowed) for (const existing of registry.entries) if (await head(await managed(existing.name, registry)) === base) { allowed = true; break; }
        if (!allowed) throw new Error('Base must be the approved baseline or a managed candidate HEAD');
        const candidatePath = await assertSafePath(managedRoot, path.join(managedRoot, request.name));
        if (process.platform === 'win32' && Buffer.byteLength(path.join(candidatePath, '.git')) > 220) throw new Error('Managed candidate Git root exceeds the Windows Git 220-byte setup limit. Use a shorter candidate name or shorter host state-home; no branch was created.');
        try { await fs.lstat(candidatePath); throw new Error('Candidate destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const branch = `codex/switchflow-${initiativeId}-${planHash.slice(0, 16)}-${request.name}`;
        await git(sourceRoot, ['worktree', 'add', '-b', branch, candidatePath, base]);
        if (!samePath(await fs.realpath(await git(candidatePath, ['rev-parse', '--show-toplevel'])), candidatePath)) throw new Error('Created candidate root mismatch');
        if (!samePath(await fs.realpath(path.resolve(candidatePath, await git(candidatePath, ['rev-parse', '--git-common-dir']))), commonDir)) throw new Error('Created candidate repository mismatch');
        const entry = { name: request.name, path: candidatePath, branch, baseHead: base, lastHead: base, createdAt: new Date().toISOString() };
        // Use the existing operations registry, after hardened Git verification. The general
        // registerWorktree helper probes arbitrary sibling worktrees with their own Git config.
        await updateState(context, 'worktrees', state => {
          state.entries = state.entries.filter(item => !samePath(item.path, candidatePath));
          state.entries.push({ path: candidatePath, owner: 'orchestrator', purpose: `Approved initiative ${initiativeId}, plan ${planHash}`, registeredAt: entry.createdAt });
        }, { entries: [] });
        await updateState(context, registryName, state => { state.entries.push(entry); }, empty);
        return { ...entry, head: base };
      }
      if (request.operation === 'commit') {
        requireFields(request, ['name', 'expectedHead', 'paths', 'message']);
        const entry = await managed(request.name, registry);
        await assertHead(entry, request.expectedHead); await noOperation(entry);
        if (typeof request.message !== 'string' || request.message.trim().length < 5 || request.message.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(request.message)) throw new Error('Meaningful bounded commit message required');
        await validatePaths(entry, request.paths);
        if (await git(entry.path, ['diff', '--cached', '--name-only'])) throw new Error('Preexisting staged changes must be resolved first');
        await git(entry.path, ['add', '--', ...request.paths]);
        const staged = (await git(entry.path, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
        if (!staged.length || staged.some(file => !request.paths.includes(file))) throw new Error('Staged file set does not match the requested commit');
        await git(entry.path, ['commit', '-m', request.message, '--only', '--', ...request.paths]);
        const committed = await head(entry); await saveHead(entry.name, committed);
        return { name: entry.name, path: entry.path, branch: entry.branch, head: committed, paths: staged };
      }
      if (request.operation === 'merge') {
        requireFields(request, ['source', 'target', 'sourceHead', 'targetHead'], ['resolvePaths']);
        return merge(request, registry);
      }
      throw new Error('Unsupported Git bridge operation');
    },
  };
}
