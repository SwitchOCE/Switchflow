import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {milestoneState, milestoneSummary, sortMilestones} from '../template/.switchflow/scripts/control/public/milestones.js';
import {knowledgeFieldComparison, draftFrom} from '../template/.switchflow/scripts/control/public/knowledge-model.js';

test('zero linked tasks cannot imply completed delivery or establish order', () => {
  const milestone = {id:'m-1',title:'Launch'};
  const state = milestoneState(milestone, [{milestone:'m-10',status:'Done'}]);
  assert.equal(state.group,'Order not established');
  assert.equal(state.linked.length,0);
  assert.equal(state.done,0);
  assert.equal(milestoneState({...milestone,executionOrder:0},[]).group,'Ordered upcoming work');
});

test('milestone grouping describes task evidence without changing records or sequence', () => {
  const milestone = Object.freeze({id:'m-1',title:'Launch',executionOrder:7});
  const tasks = Object.freeze([Object.freeze({milestone:'m-1',status:'Done'}),Object.freeze({milestone:'Launch',status:'Blocked'})]);
  const state = milestoneState(milestone,tasks);
  assert.equal(state.group,'Active work'); assert.equal(state.blocked,1); assert.equal(state.done,1);
  assert.equal(milestoneState(milestone,[tasks[0]]).group,'Delivery tasks complete');
  assert.equal(sortMilestones([milestone,{id:'m-99',executionOrder:0}])[0].id,'m-99');
  assert.equal(milestone.executionOrder,7);
});

test('scope summary omits heading syntax, bounds long prose and retains scope source', () => {
  const scope = '## Outcome\n\nDeliver **readable** [scope](guide.md).\n\n## Evidence\n\n' + 'x'.repeat(900);
  assert.equal(milestoneSummary(scope),'Deliver readable scope.');
  assert.ok(milestoneSummary('a'.repeat(900)).length <= 220);
  assert.ok(scope.includes('## Evidence'));
});

test('document conflict exposes changed editable fields and preserves both full bodies', () => {
  const saved = {id:'doc-1',title:'Saved',rawContent:'Long saved body\n'.repeat(500),type:'guide',tags:['saved'],path:'Guides/doc-1.md'};
  const draft = {...draftFrom(saved,'documents'),title:'My title',content:'My long body\n'.repeat(600),tags:'mine'};
  const before = JSON.stringify(draft);
  const rows = knowledgeFieldComparison(draft,saved,'documents');
  assert.deepEqual(rows.map(row => row.field),['title','content','tags']);
  assert.equal(rows[1].mine,draft.content); assert.equal(rows[1].saved,saved.rawContent);
  assert.equal(JSON.stringify(draft),before);
  assert.equal(knowledgeFieldComparison(draftFrom(saved,'documents'),saved,'documents').length,0);
});

test('decision comparison does not introduce editable status or date fields', () => {
  const saved = {id:'decision-1',title:'Decision',rawContent:'saved',status:'accepted',date:'2026-09-22'};
  const rows = knowledgeFieldComparison({...draftFrom(saved,'decisions'),content:'mine'},saved,'decisions');
  assert.deepEqual(rows.map(row => row.field),['content']);
});

test('milestone and knowledge UI sources are valid UTF-8 without replacement glyphs', () => {
  for (const file of ['milestones.js','milestones.css','knowledge.js','knowledge.css','knowledge-model.js']) {
    const bytes = readFileSync(new URL(`../template/.switchflow/scripts/control/public/${file}`,import.meta.url));
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    assert.equal(text.includes('\ufffd'),false,file);
  }
});
