import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(process.argv[2] ?? join(scriptDirectory, '..', '..'));
const backlogCli = process.argv[3] ? resolve(process.argv[3]) : null;
const docsRoot = join(projectRoot, 'backlog', 'docs');
const errors = [];
const documents = [];

function collectMarkdown(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdown(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function readFrontmatter(path, content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    errors.push(`${relative(projectRoot, path)}: missing YAML frontmatter`);
    return null;
  }

  const value = (key) => {
    const field = new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, 'm').exec(match[1]);
    return field?.[1]?.trim() ?? '';
  };
  const id = value('id');
  const title = value('title');
  const type = value('type');
  if (!/^doc-\d+$/.test(id)) errors.push(`${relative(projectRoot, path)}: invalid or missing document id`);
  if (!title) errors.push(`${relative(projectRoot, path)}: missing title`);
  if (!type) errors.push(`${relative(projectRoot, path)}: missing type`);
  if (id && !basename(path).startsWith(`${id} - `)) {
    errors.push(`${relative(projectRoot, path)}: filename must start with "${id} - "`);
  }
  return { id, title, path, content };
}

function slugifyHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function checkHeading(sourcePath, targetDocument, encodedFragment, rawTarget) {
  if (!encodedFragment) return;
  const headings = [...targetDocument.content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slugifyHeading(heading[1]));
  if (!headings.includes(decodeURIComponent(encodedFragment).toLowerCase())) {
    errors.push(`${relative(projectRoot, sourcePath)}: missing heading for ${rawTarget}`);
  }
}

function checkLinks(sourceDocument) {
  const links = sourceDocument.content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
    const [encodedPath, encodedFragment = ''] = rawTarget.split('#', 2);
    const routeMatch = /^\/documentation\/(\d+)\/([a-z0-9-]+)$/.exec(encodedPath);
    if (routeMatch) {
      const targetDocument = documents.find((document) => document.id === `doc-${routeMatch[1]}`);
      if (!targetDocument || slugifyHeading(targetDocument.title) !== routeMatch[2]) {
        errors.push(`${relative(projectRoot, sourceDocument.path)}: broken Backlog document route ${rawTarget}`);
        continue;
      }
      checkHeading(sourceDocument.path, targetDocument, encodedFragment, rawTarget);
      continue;
    }

    const decodedPath = decodeURIComponent(encodedPath);
    if (decodedPath.toLowerCase().endsWith('.md')) {
      errors.push(`${relative(projectRoot, sourceDocument.path)}: Markdown document links must use a /documentation/<id>/<slug> browser route: ${rawTarget}`);
      continue;
    }

    const targetPath = resolve(dirname(sourceDocument.path), decodedPath);
    if (!existsSync(targetPath)) {
      errors.push(`${relative(projectRoot, sourceDocument.path)}: broken link ${rawTarget}`);
      continue;
    }
  }
}

const paths = collectMarkdown(docsRoot);
if (paths.length === 0) errors.push('backlog/docs: no Backlog documents found');

for (const path of paths) {
  const content = readFileSync(path, 'utf8');
  const document = readFrontmatter(path, content);
  if (document) documents.push(document);
  if (/^(?:!!!|\?\?\?)\s+/m.test(content)) {
    errors.push(`${relative(projectRoot, path)}: MkDocs-only admonition syntax is not supported`);
  }
}

const idCounts = new Map();
for (const document of documents) idCounts.set(document.id, (idCounts.get(document.id) ?? 0) + 1);
for (const [id, count] of idCounts) {
  if (id && count > 1) errors.push(`backlog/docs: duplicate document id ${id}`);
}

for (const document of documents) checkLinks(document);

if (backlogCli && errors.length === 0) {
  for (const document of documents) {
    const result = spawnSync(process.execPath, [backlogCli, 'doc', 'view', document.id, '--plain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      errors.push(`${relative(projectRoot, document.path)}: Backlog could not read ${document.id}: ${(result.stderr || result.stdout).trim()}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${documents.length} Backlog documents, browser routes, and local links.`);
