import test from 'node:test';
import assert from 'node:assert/strict';
import {draftFrom, knowledgePayload, recordFingerprint, decisionSeed} from '../template/.switchflow/scripts/control/public/knowledge-model.js';

test('document edit preserves body, tags, type and nested folder in native payload', () => {
  const record = {id:'doc-12', title:'Existing title',type:'specification',tags:['UI','API'],path:'Guides/Authoring/doc-12 - Existing title.md',rawContent:'## Original\n\n```html\n<script>alert(1)</script>\n```'};
  const draft = draftFrom(record,'documents');
  draft.title = 'Renamed';
  assert.deepEqual(knowledgePayload(draft,'documents'),{title:'Renamed',content:record.rawContent,type:'specification',tags:['UI','API'],path:'Guides/Authoring'});
});
test('document root move is explicit null and folder cannot escape the project', () => {
  const draft = {...draftFrom(null,'documents'),title:'New',tags:' a, b, a '};
  assert.deepEqual(knowledgePayload(draft,'documents').tags,['a','b']);
  assert.equal(knowledgePayload(draft,'documents').path,'');
  assert.equal(knowledgePayload({...draft,id:'doc-1'},'documents').path,null);
  for (const folder of ['../outside','/absolute','C:/outside','guide/../outside']) assert.throws(() => knowledgePayload({...draft,folder},'documents'));
});
test('decision edit retains raw body including optional and additional sections', () => {
  const content = decisionSeed + '\n### Evidence\n\nPreserve this section.\n';
  const draft = draftFrom({id:'decision-1',title:'Decision',rawContent:content,status:'accepted',date:'2026-01-01'},'decisions');
  assert.deepEqual(knowledgePayload(draft,'decisions'),{title:'Decision',content});
  assert.throws(() => knowledgePayload({...draft,content:'## Decision\nMissing context'},'decisions'),/Context/);
  assert.throws(() => knowledgePayload({...draft,content:content+'\n## Unsupported\ntext'},'decisions'),/additional headings/);
  assert.equal(knowledgePayload({...draft,content:content+'\n```md\n## Code example\n```'},'decisions').content, content+'\n```md\n## Code example\n```');
});
test('comparison catches metadata and body changes without claiming CAS revision', () => {
  const record = {id:'doc-1', title:'Title',rawContent:'Body',type:'guide',tags:['old']};
  for (const patch of [{rawContent:'changed'},{title:'changed'},{tags:['new']},{path:'new/file.md'}]) assert.notEqual(recordFingerprint(record),recordFingerprint({...record,...patch}));
  assert.equal(recordFingerprint(record),recordFingerprint({...record,unrelated:'ignored'}));
});

test('decision examples retain nested shorter fences and fence-like text', () => {
  for (const example of ['````md\n```md\n## Example heading\n```\n````', '```md\n```not-a-closing-fence\n## Example heading\n```']) {
    const content = `## Context\n\n${example}\n\n## Decision\n\nChosen\n\n## Consequences\n\nImpact`;
    assert.equal(knowledgePayload({title:'Example',content}, 'decisions').content, content);
  }
});
