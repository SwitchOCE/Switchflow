import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlError } from './lifecycle.mjs';

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 8 * MAX_FILE;
// IDs are relative paths, never filesystem capabilities supplied by the browser.
async function safeFile(context, id = '') {
  if (typeof id !== 'string' || id.includes('\\') || id.includes('\0') || id.startsWith('/') || id.split('/').some(p => p === '..' || p === '.' || p.includes(':'))) throw new ControlError('Invalid document path.');
  const base = await fs.realpath(context.governanceRoot);
  const parts = ['backlog', 'docs', ...id.split('/').filter(Boolean)];
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new ControlError('Linked documentation paths are not supported.', 403);
    const resolved = await fs.realpath(current);
    const relative = path.relative(base, resolved);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new ControlError('Document is outside governance.', 403);
  }
  return current;
}
function unpack(raw, id) {
  let markdown = raw.replace(/^\uFEFF/, ''); let title; let documentId;
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (front) {
    title = front[1].match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    documentId = front[1].match(/^id:\s*(doc-\d+)\s*$/m)?.[1];
    markdown = markdown.slice(front[0].length);
  }
  return { id, ...(documentId ? { documentId } : {}), title: title || markdown.match(/^#\s+(.+)$/m)?.[1] || path.posix.basename(id, '.md'), markdown };
}
export async function readDocument(context, id) {
  if (!id || !/\.md$/i.test(id)) throw new ControlError('Select a Markdown document.');
  let file;
  try { file = await safeFile(context, id); }
  catch (error) { if (error.code === 'ENOENT') throw new ControlError('Document not found.', 404); throw error; }
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new ControlError('Document not found.', 404);
  if (stat.size > MAX_FILE) throw new ControlError('Document exceeds the 1 MiB reader limit.', 413);
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_FILE) throw new ControlError('Document exceeds the 1 MiB reader limit.', 413);
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ControlError('Document must be UTF-8 text.', 422); }
  if (raw.includes('\0')) throw new ControlError('Document must be text.', 422);
  return unpack(raw, id);
}
export async function listDocuments(context, { query = '' } = {}) {
  if (typeof query !== 'string' || query.length > 200) throw new ControlError('Search must contain at most 200 characters.');
  const documents = []; const warnings = []; let total = 0; let visited = 0;
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  async function walk(folder = '', depth = 0) {
    if (depth > 12) { warnings.push('Folders deeper than 12 levels are omitted.'); return; }
    let directory;
    try { directory = await safeFile(context, folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (++visited > 2000 || total >= MAX_TOTAL || documents.length >= 500) { warnings.push('Documentation index limit reached (500 documents, 2,000 entries or 8 MiB).'); return; }
      const id = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { warnings.push(`Linked path omitted: ${id}`); continue; }
      if (entry.isDirectory()) { await walk(id, depth + 1); continue; }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      let doc;
      try { doc = await readDocument(context, id); } catch (error) { warnings.push(`${id}: ${error.message}`); continue; }
      total += Buffer.byteLength(doc.markdown);
      const searchable = `${doc.title}\n${id}\n${doc.markdown}`.toLocaleLowerCase();
      if (!terms.every(term => searchable.includes(term))) continue;
      const match = terms.length ? Math.max(0, doc.markdown.toLocaleLowerCase().indexOf(terms[0])) : 0;
      const excerpt = doc.markdown.slice(Math.max(0, match - 60), match + 180).replace(/\s+/g, ' ').trim();
      documents.push({ id, ...(doc.documentId ? { documentId: doc.documentId } : {}), title: doc.title, folder, excerpt });
    }
  }
  await walk();
  return { documents, warnings: [...new Set(warnings)] };
}
