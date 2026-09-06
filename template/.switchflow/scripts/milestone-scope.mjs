import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const usage = 'Usage: backlog.ps1 milestone view <id> [--json] | milestone edit <id> --input-file <UTF-8 JSON file>';

function inside(root, path) {
  const actual = realpathSync(path);
  if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Milestone storage must stay inside the project.');
  return actual;
}

function locate(projectRoot, id) {
  if (!/^m-\d+$/.test(id ?? '')) throw new Error('Use an exact milestone ID, such as m-0.');
  const root = realpathSync(projectRoot);
  const directory = inside(root, join(root, 'backlog', 'milestones'));
  const matches = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => {
    const path = inside(root, join(directory, entry.name));
    const source = readFileSync(path, 'utf8');
    const header = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0];
    return header && new RegExp(`^id:[\\t ]*["']?${id}["']?[\\t ]*\\r?$`, 'm').test(header) ? path : null;
  }).filter(Boolean);
  if (matches.length !== 1) throw new Error(`Expected one active milestone ${id}; found ${matches.length}.`);
  return { root, path: matches[0] };
}

function split(source) {
  const header = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0];
  if (!header) throw new Error('Invalid milestone frontmatter.');
  const body = source.slice(header.length);
  const marker = /^## Description[\t ]*\r?\n/m.exec(body);
  return marker ? {
    prefix: header + body.slice(0, marker.index + marker[0].length),
    description: body.slice(marker.index + marker[0].length).trim(),
  } : { prefix: source.trimEnd() + '\n\n## Description\n', description: '' };
}

export function viewMilestone(projectRoot, id) {
  const { root, path } = locate(projectRoot, id);
  const content = readFileSync(path);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  const snapshotsPath = join(root, 'backlog', 'archive', 'milestone-revisions', id);
  const snapshots = existsSync(snapshotsPath) ? readdirSync(inside(root, snapshotsPath)).filter(name => name.endsWith('.json')).sort().map(name => relative(root, join(snapshotsPath, name))) : [];
  return { id, path: relative(root, path), revision: hash(content), description: split(source).description, snapshots };
}

export function editMilestone(projectRoot, id, input) {
  const keys = ['expectedRevision', 'description', 'reason', 'approval'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) ||
      keys.some(key => typeof input[key] !== 'string' || !input[key].trim()) || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new Error('Input requires expectedRevision (SHA-256), description, reason, and approval; no other fields.');
  }
  const { root, path } = locate(projectRoot, id);
  const lockPath = path + '.scope-lock';
  let lock;
  let staged;
  try {
    lock = openSync(lockPath, 'wx');
    const before = readFileSync(path);
    if (hash(before) !== input.expectedRevision) throw new Error('Stale milestone revision; read it again and reconcile the proposed change.');
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
    const parts = split(source);
    if (parts.description === input.description.trim()) return { ...viewMilestone(root, id), changed: false };
    const after = parts.prefix + '\n' + input.description.trim() + '\n';
    // Create each directory separately so a pre-existing link cannot redirect a write.
    let storage = root;
    for (const part of ['backlog', 'archive', 'milestone-revisions', id]) {
      storage = join(storage, part);
      if (!existsSync(storage)) mkdirSync(storage);
      inside(root, storage);
    }
    const snapshot = join(storage, `${Date.now()}-${randomUUID()}.json`);
    writeFileSync(snapshot, JSON.stringify({
      id, beforeRevision: input.expectedRevision, proposedRevision: hash(after),
      reason: input.reason, approval: input.approval, savedAt: new Date().toISOString(),
      previousContent: source,
    }, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    staged = path + '.' + randomUUID() + '.tmp';
    writeFileSync(staged, after, { flag: 'wx', encoding: 'utf8' });
    if (lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== input.expectedRevision) {
      throw new Error('Milestone changed during the edit; current content was preserved. Reconcile before retrying.');
    }
    renameSync(staged, path);
    staged = undefined;
    const saved = viewMilestone(root, id);
    if (saved.revision !== hash(after)) throw new Error('Milestone changed after replacement; inspect current state before retrying.');
    return { ...saved, changed: true, snapshot: relative(root, snapshot) };
  } finally {
    if (staged && existsSync(staged)) unlinkSync(staged);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, group, action, id, ...args] = process.argv.slice(2);
    if (group !== 'milestone') throw new Error(usage);
    if (action === 'view' && (args.length === 0 || args.length === 1 && args[0] === '--json')) {
      const result = viewMilestone(root, id);
      console.log(args.length ? JSON.stringify(result, null, 2) : `${id}\nRevision: ${result.revision}\n\n${result.description}\n\nRevision snapshots: ${result.snapshots.length}`);
    } else if (action === 'edit' && args.length === 2 && args[0] === '--input-file') {
      const input = JSON.parse(readFileSync(resolve(args[1]), 'utf8').replace(/^\uFEFF/, ''));
      console.log(JSON.stringify(editMilestone(root, id, input), null, 2));
    } else throw new Error(usage);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
