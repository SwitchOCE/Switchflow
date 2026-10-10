import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath, digest, readState } from '../operations/storage.mjs';
import { createSafeGit } from './git-bridge-git.mjs';
import { ControlError } from './lifecycle.mjs';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (target, root) => {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const candidateName = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const requireState = (condition, message) => {
  if (!condition) throw new ControlError(message, 409);
};
export function uatFileReferences(item) {
  const references = [];
  for (const step of item.uat || []) {
    const expression = /\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g;
    let match;
    let index = 0;
    while ((match = expression.exec(step.title || ''))) {
      const reference = match[2];
      references.push({ stepId: step.id, index: index++, label: match[1], reference });
    }
  }
  return references;
}

/** The candidate registry the Git bridge keeps for this initiative's approved grant. No Git process runs here. */
export async function candidateGrant(context, item) {
  const { gitGrantHash: planHash, baseHead } = item.approvedPlan;
  requireState(
    /^[a-zA-Z0-9-]{1,80}$/.test(item.id) && /^[a-f0-9]{64}$/.test(planHash || '') && sha(baseHead),
    'The approved Git grant is invalid.',
  );
  const registry = await readState(context, `git-bridge-${item.id}-${planHash}`, null);
  requireState(
    registry &&
      registry.schemaVersion === 1 &&
      registry.initiativeId === item.id &&
      registry.planHash === planHash &&
      registry.baseHead === baseHead &&
      Array.isArray(registry.entries),
    'Candidate registry identity mismatch.',
  );
  const layout = registry.layoutVersion ?? 1;
  requireState([1, 2].includes(layout), 'Unsupported candidate registry layout.');
  const suffix = layout === 1 ? [item.id, planHash.slice(0, 16)] : [digest(`${item.id}:${planHash}`).slice(0, 16)];
  const managedRoot = await assertSafePath(context.stateDir, path.join(context.stateDir, 'candidates', ...suffix));
  const entries = registry.entries.filter(
    entry => entry && typeof entry.path === 'string' && candidateName.test(entry.name || ''),
  );
  return { itemId: item.id, planHash, registry, managedRoot, entries };
}

/** The recorded location, branch and HEAD of one registered entry, checked against its managed root. */
export async function candidateLocation(grant, entry) {
  const candidate = await assertSafePath(grant.managedRoot, path.join(grant.managedRoot, entry.name));
  await assertSafePath(candidate, path.join(candidate, '.git'));
  requireState(
    samePath(entry.path, candidate) && samePath(await fs.realpath(candidate), candidate),
    'Candidate path identity mismatch.',
  );
  const branch = `codex/switchflow-${grant.itemId}-${grant.planHash.slice(0, 16)}-${entry.name}`;
  requireState(entry.branch === branch && sha(entry.lastHead), 'Candidate branch or recorded HEAD is invalid.');
  return { name: entry.name, candidate, branch, head: entry.lastHead };
}

/** Proves the checkout is still the registered worktree of this repository at its recorded HEAD. */
export async function verifyCandidateCheckout(context, { candidate, branch, head }) {
  const source = await fs.realpath(context.sourceRoot);
  const common = await fs.realpath(context.commonDir);
  const git = createSafeGit(common, [source, context.governanceRoot, context.stateDir].filter(Boolean));
  requireState(
    samePath(await fs.realpath(path.resolve(source, await git(source, ['rev-parse', '--git-common-dir']))), common),
    'Primary repository identity changed.',
  );
  requireState(
    samePath(
      await fs.realpath(path.resolve(candidate, await git(candidate, ['rev-parse', '--git-common-dir']))),
      common,
    ),
    'Candidate repository identity changed.',
  );
  requireState(
    samePath(await fs.realpath(await git(candidate, ['rev-parse', '--show-toplevel'])), candidate),
    'Candidate worktree identity changed.',
  );
  requireState((await git(candidate, ['symbolic-ref', '--short', 'HEAD'])) === branch, 'Candidate branch changed.');
  requireState(
    (await git(candidate, ['rev-parse', 'HEAD'])) === head &&
      (await git(source, ['rev-parse', '--verify', `refs/heads/${branch}`])) === head,
    'Candidate HEAD changed since its recorded evidence.',
  );
  const registered = (await git(source, ['worktree', 'list', '--porcelain'])).split(/\r?\n\r?\n/).some(block => {
    const lines = block.split(/\r?\n/);
    const root = lines.find(line => line.startsWith('worktree '));
    return (
      root &&
      samePath(path.resolve(root.slice(9)), candidate) &&
      lines.includes(`HEAD ${head}`) &&
      lines.includes(`branch refs/heads/${branch}`)
    );
  });
  requireState(registered, 'Candidate is not registered with the approved repository.');
  return { git, source };
}

// The request selects an existing UAT link, never a client-supplied filesystem path.
export async function previewUatArtifact(context, item, { stepId, index }) {
  requireState(
    item && ['uat', 'complete'].includes(item.stage) && item.approvedPlan,
    'Artifact preview requires an approved delivery at UAT.',
  );
  requireState(Number.isSafeInteger(index) && index >= 0, 'Invalid UAT reference.');
  const reference = uatFileReferences(item).find(value => value.stepId === stepId && value.index === index);
  requireState(reference, 'This file is not an exact UAT reference.');
  const supplied = reference.reference;
  requireState(
    path.isAbsolute(supplied) &&
      !/[\x00-\x1f]/.test(supplied) &&
      !supplied.split(/[\\/]/).some(part => part === '.' || part === '..'),
    'Only absolute local UAT file references without traversal are supported.',
  );
  const grant = await candidateGrant(context, item);
  const target = path.resolve(supplied);
  const entry = grant.registry.entries.find(
    value => typeof value.path === 'string' && inside(target, path.resolve(value.path)),
  );
  requireState(
    entry && candidateName.test(entry.name),
    'The UAT file is not in a registered candidate for this grant.',
  );
  const location = await candidateLocation(grant, entry);
  const { candidate, branch } = location;
  const relative = path.relative(candidate, target).split(path.sep).join('/');
  requireState(
    relative &&
      !path.isAbsolute(relative) &&
      !relative
        .split('/')
        .some(
          part =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[ .]$/.test(part) ||
            ['.git', '.agents', '.codex'].includes(part.toLowerCase()),
        ) &&
      !/[\\:*?\x00-\x1f]/.test(relative),
    'Protected or unsafe artifact path.',
  );
  await assertSafePath(candidate, target);
  const { git, source } = await verifyCandidateCheckout(context, location);
  const tree = await git(source, ['ls-tree', '-z', entry.lastHead, '--', relative]);
  const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\0]+)\0$/.exec(tree);
  requireState(match && match[3] === relative, 'Artifact must be a tracked regular file; symlinks are not supported.');
  const size = Number(await git(source, ['cat-file', '-s', match[2]]));
  requireState(Number.isSafeInteger(size) && size <= 128 * 1024, 'Artifact exceeds the 128 KiB text preview limit.');
  const bytes = await git(source, ['cat-file', 'blob', match[2]], { buffer: true, maxBuffer: 128 * 1024 + 1 });
  requireState(bytes.length === size && !bytes.includes(0), 'Binary artifacts cannot be previewed as text.');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ControlError('Artifact is not valid UTF-8 text.', 415);
  }
  requireState(!/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(content), 'Binary artifacts cannot be previewed as text.');
  return { label: reference.label, path: relative, head: entry.lastHead, branch, content, bytes: size };
}
