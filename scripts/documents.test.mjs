import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDocuments, readDocument } from '../template/.switchflow/scripts/control/documents.mjs';
import { renderMarkdown, renderDocument, resolveDocumentLink } from '../template/.switchflow/scripts/control/public/documents.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-docs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = { governanceRoot: path.join(root, 'primary'), sourceRoot: path.join(root, 'candidate') };
  const docs = path.join(context.governanceRoot, 'backlog', 'docs');
  await fs.mkdir(path.join(docs, 'Guides'), { recursive: true });
  await fs.writeFile(path.join(docs, 'doc-01 - Overview.md'), '---\nid: doc-01\ntitle: "Project overview"\n---\n# Start\n\nAuthoritative primary documentation.');
  await fs.writeFile(path.join(docs, 'Guides', 'Setup.md'), '# Setup\n\nRun the frobnicator command.');
  await fs.mkdir(path.join(context.sourceRoot, 'backlog', 'docs'), { recursive: true });
  await fs.writeFile(path.join(context.sourceRoot, 'backlog', 'docs', 'Wrong.md'), '# Wrong worktree documentation');
  return { root, context, docs };
}
test('documentation uses canonical governance, nested hierarchy and full text search without exposing frontmatter', async t => {
  const { context } = await fixture(t);
  const index = await listDocuments(context);
  assert.equal(index.documents.length, 2); assert.deepEqual(index.warnings, []);
  const overview = index.documents.find(d => d.id.startsWith('doc-01'));
  assert.equal(overview.title, 'Project overview'); assert(!overview.excerpt.includes('title:'));
  const found = await listDocuments(context, { query: 'setup FROBNICATOR' });
  assert.equal(found.documents.length, 1); assert.equal(found.documents[0].folder, 'Guides');
  assert.match(found.documents[0].excerpt, /frobnicator/);
  assert.equal((await listDocuments(context, { query: 'wrong' })).documents.length, 0);
  const doc = await readDocument(context, overview.id); assert(doc.markdown.startsWith('# Start'));
});
test('documentation rejects traversal, linked escape, oversized and invalid text', async t => {
  const { root, context, docs } = await fixture(t);
  for (const id of ['../secret.md', '/secret.md', 'C:/secret.md', 'Guides\\Setup.md', 'Guides/../../secret.md', 'Setup.md\0', 'not.txt']) await assert.rejects(readDocument(context, id));
  await fs.writeFile(path.join(docs, 'large.md'), 'x'.repeat(1024 * 1024 + 1));
  await fs.writeFile(path.join(docs, 'bad.md'), Buffer.from([0xff]));
  await fs.writeFile(path.join(docs, 'null.md'), 'a\0b');
  await assert.rejects(readDocument(context, 'large.md'), { status: 413 });
  await assert.rejects(readDocument(context, 'bad.md'), { status: 422 });
  await assert.rejects(readDocument(context, 'null.md'), { status: 422 });
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
  await fs.symlink(outside, path.join(docs, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readDocument(context, 'linked/secret.md'), { status: 403 });
  const result = await listDocuments(context); assert(!result.documents.some(d => d.id.includes('secret'))); assert.equal(result.warnings.length, 4);
});
test('missing docs directory is empty and missing document is an actionable 404', async t => {
  const { context, docs } = await fixture(t); await fs.rm(docs, { recursive: true });
  assert.deepEqual(await listDocuments(context), { documents: [], warnings: [] });
  await assert.rejects(readDocument(context, 'missing.md'), { status: 404 });
});
test('Markdown renders headings, nested lists, tables and inert code with unique anchors', () => {
  const result = renderMarkdown('# Intro\n\n## Setup\n\n## Setup\n\n- First\n  - Nested\n- [x] Done\n\n| Name | Value |\n| --- | --- |\n| **Safe** | `one` |\n\n```js\n<script>alert(1)</script>\n```\n\n> Note\n\nText *emphasis* and [guide](Guides/Setup.md).');
  assert.deepEqual(result.headings.map(h => h.id), ['intro', 'setup', 'setup-1']);
  assert.match(result.html, /<ul><li><p>First<\/p><ul>/); assert.match(result.html, /disabled checked/);
  assert.match(result.html, /<th scope="col">Name/); assert.match(result.html, /<strong>Safe<\/strong>/);
  assert.match(result.html, /data-copy-code/); assert.match(result.html, /&lt;script&gt;/); assert(!result.html.includes('<script>'));
  assert.match(result.html, /<blockquote>/); assert.match(result.html, /data-doc-link="Guides\/Setup.md"/);
});
test('untrusted Markdown never creates raw markup or active URL attributes', () => {
  const { html } = renderMarkdown('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![bad](https://tracker.invalid/pixel)\n\n# <svg/onload=alert(1)>\n\n```\n</code><script>bad</script>\n```');
  assert(!/<(?:img|svg|script)(?:\s|>)/.test(html)); assert(!html.includes('href="javascript:'));
  assert(!html.includes('src="')); assert.match(html, /\[Image: bad\]/);
  assert.doesNotThrow(() => renderMarkdown('>'.repeat(10000) + ' deep'));
});
test('matching leading Markdown title is displayed once with its original anchor and focus target', () => {
  const same = renderDocument({ id: 'Overview.md', title: 'Project overview', markdown: '# Project overview\n\n## Next steps' });
  assert.equal((same.html.match(/class="docs-page-title"/g) || []).length, 1);
  assert.match(same.html, /<h1 class="docs-page-title" id="doc-heading-project-overview" tabindex="-1">/);
  assert(!same.html.includes('<h2 class="docs-page-title"'));
  assert.deepEqual(same.headings.map(h => h.id), ['project-overview', 'next-steps']);
  const different = renderDocument({ id: 'Overview.md', title: 'Overview', markdown: '# Product purpose' });
  assert.match(different.html, /<h2 class="docs-page-title" tabindex="-1">Overview<\/h2>/);
  assert.match(different.html, /id="doc-heading-product-purpose"/);
});
test('links resolve exact nested documents and Backlog routes, rejecting arbitrary local paths and unsafe schemes', () => {
  const docs = [{ id: 'doc-01 - Overview.md' }, { id: 'Guides/Setup.md' }, { id: 'Guides/More.md' }];
  assert.deepEqual(resolveDocumentLink('../doc-01%20-%20Overview.md#start', 'Guides/Setup.md', docs), { id: 'doc-01 - Overview.md', anchor: 'start' });
  assert.deepEqual(resolveDocumentLink('/documentation/01/project-overview', 'Guides/Setup.md', docs), { id: 'doc-01 - Overview.md', anchor: '' });
  assert.deepEqual(resolveDocumentLink('More.md', 'Guides/Setup.md', docs), { id: 'Guides/More.md', anchor: '' });
  assert.deepEqual(resolveDocumentLink('#setup', 'Guides/Setup.md', docs), { id: 'Guides/Setup.md', anchor: 'setup' });
  assert.deepEqual(resolveDocumentLink('https://example.com/a', 'Guides/Setup.md', docs), { external: 'https://example.com/a' });
  for (const link of ['../../secret.md', 'file:///C:/secret.md', 'javascript:alert(1)', 'data:text/html,bad', '//evil.invalid', '/etc/passwd', '%2e%2e/%2e%2e/secret.md', 'missing.md', '\\server\\secret', ' https://example.com']) assert.equal(resolveDocumentLink(link, 'Guides/Setup.md', docs), null, link);
});
