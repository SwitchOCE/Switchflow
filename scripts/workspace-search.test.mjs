import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchMatches, matchedSnippet } from '../template/.switchflow/scripts/control/public/workspace-search.js';

test('workspace search models preserve record routes and distinguish matches with excerpts', () => {
  const matches = buildSearchMatches([
    { type: 'task', task: { id: 'SF-19', title: 'Shared title', status: 'Ready', description: 'Before the needle after it' } },
    { type: 'document', document: { id: 'doc-2', title: 'Shared title', content: '# Context\nA different needle appears here.' } },
  ], [{ id: 'initiative-1', title: 'Needle initiative', request: 'Outcome' }], 'needle');
  assert.deepEqual(matches.map(item => [item.type, item.view]), [['initiative', 'board'], ['task', 'tasks'], ['document', 'documents']]);
  assert.equal(matches[1].task, 'SF-19'); assert.equal(matches[2].record, 'doc-2');
  assert.match(matchedSnippet(matches[2].item, 'needle'), /different needle/i);
});

test('workspace snippets are bounded and prefer text around the match', () => {
  const value = `${'prefix '.repeat(40)}needle ${'suffix '.repeat(40)}`;
  const snippet = matchedSnippet({ description: value }, 'needle', 90);
  assert.ok(snippet.length <= 92); assert.match(snippet, /needle/); assert.match(snippet, /^…/);
});

test('workspace snippets include native document raw content', () => {
  assert.match(matchedSnippet({ rawContent: '# Body\nA document-only phrase.' }, 'document-only'), /document-only phrase/);
});
