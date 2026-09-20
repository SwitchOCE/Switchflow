import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const snapshots = existsSync(snapshotsPath) ? readdirSync(inside(root, snapshotsPath)).filter(name => name.endsWith('.json') && !name.endsWith('.applied.json')).sort().map(name => relative(root, join(snapshotsPath, name))) : [];
  return { id, path: relative(root, path), revision: hash(content), description: split(source).description, snapshots };
}

export function editMilestone(projectRoot, id, input) {
  const keys = ['expectedRevision', 'description', 'reason', 'approval'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) ||
      keys.some(key => typeof input[key] !== 'string' || !input[key].trim()) || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new Error('Input requires expectedRevision (SHA-256), description, reason, and approval; no other fields.');
  }
  const { root, path } = locate(projectRoot, id);
  const before = readFileSync(path);
  if (hash(before) !== input.expectedRevision) throw new Error('Stale milestone revision; read it again and reconcile the proposed change.');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
  if (split(source).description === input.description.trim()) return { ...viewMilestone(root, id), changed: false };
  // Native CAS owns the mutation lock. A separate scope lock cannot protect against
  // native UI/MCP writers, so the adapter never replaces milestone bytes itself.
  const resolver = fileURLToPath(new URL('./backlog-fork/resolve.mjs', import.meta.url));
  const resolved = spawnSync(process.execPath, [resolver], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (resolved.error || resolved.status !== 0) throw new Error(resolved.error?.message || resolved.stderr || 'Set up the pinned milestone CAS runtime first.');
  const cli = resolved.stdout.trim();
  let storage = root;
  for (const part of ['backlog', 'archive', 'milestone-revisions', id]) {
    storage = join(storage, part);
    if (!existsSync(storage)) mkdirSync(storage);
    inside(root, storage);
  }
  const receiptId = `${Date.now()}-${randomUUID()}`;
  const snapshot = join(storage, `${receiptId}.json`);
  const request = join(storage, `${receiptId}.request.tmp`);
  const record = { id, beforeRevision: input.expectedRevision, description: input.description,
    reason: input.reason, approval: input.approval, savedAt: new Date().toISOString(),
    previousContent: source, status: 'prepared' };
  writeFileSync(snapshot, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
  try {
    writeFileSync(request, JSON.stringify({ expectedRevision: input.expectedRevision, description: input.description.trim() }), { flag: 'wx', encoding: 'utf8' });
    const result = spawnSync(process.execPath, [cli, 'milestone', 'edit', id, '--input-file', request, '--json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'Milestone edit failed.');
    const applied = JSON.parse(result.stdout);
    const saved = viewMilestone(root, id);
    // Append a separate receipt; a prepared snapshot alone never asserts success.
    writeFileSync(join(storage, `${receiptId}.applied.json`), JSON.stringify({ id, status: 'applied', beforeRevision: input.expectedRevision,
      proposedRevision: applied.revision, observedRevision: saved.revision, snapshot: relative(root, snapshot) }, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    if (saved.revision !== applied.revision) throw new Error('Milestone changed after native CAS succeeded; inspect current state and the applied receipt before retrying.');
    return { ...saved, changed: true, snapshot: relative(root, snapshot) };
  } finally {
    if (existsSync(request)) unlinkSync(request);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, group, action, id, ...args] = process.argv.slice(2);
    if (group !== 'milestone') throw new Error(usage);
    if (action === 'view' && (args.length === 0 || args.length === 1 && args[0] === '--json')) {
      let result = viewMilestone(root, id);
      const resolved = spawnSync(process.execPath, [fileURLToPath(new URL('./backlog-fork/resolve.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (resolved.status === 0) {
        const viewed = spawnSync(process.execPath, [resolved.stdout.trim(), 'milestone', 'view', id, '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
        if (viewed.status !== 0) throw new Error(viewed.stderr || viewed.stdout || 'Milestone read failed.');
        result = { ...result, ...JSON.parse(viewed.stdout) };
      }
      console.log(args.length ? JSON.stringify(result, null, 2) : `${id}\nRevision: ${result.revision}\n\n${result.description}\n\nRevision snapshots: ${result.snapshots.length}`);
    } else if (action === 'edit' && args.length === 2 && args[0] === '--input-file') {
      const input = JSON.parse(readFileSync(resolve(args[1]), 'utf8').replace(/^\uFEFF/, ''));
      console.log(JSON.stringify(editMilestone(root, id, input), null, 2));
    } else throw new Error(usage);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
