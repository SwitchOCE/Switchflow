import test from 'node:test';
import assert from 'node:assert/strict';
import {checklist,checklistText,filterTasks,taskPayload,escapeHTML,clearSavedDraft} from '../template/.switchflow/scripts/control/public/tasks-model.js';

test('task writes preserve captured revision and native indexed DoD operations',() => {
  const original = {id:'TASK-1',revision:'captured-sha',definitionOfDoneItems:[{index:2,text:'Remove',checked:true},{index:4,text:'Check',checked:false},{index:6,text:'Uncheck',checked:true}]};
  const payload = taskPayload({title:'Example',status:'Ready',assignee:'Alex, Jo',labels:'one\ntwo',milestone:'',dodKeep4:'on',dodCheck4:'on',dodKeep6:'on',definitionOfDoneAdd:'New item\n\nSecond',acceptanceCriteriaItems:'[x] Complete\n[ ] Pending',comment:' Evidence attached ',commentAuthor:'Alex'},original);
  assert.equal(payload.expectedRevision,'captured-sha');
  assert.deepEqual(payload.definitionOfDoneRemove,[2]);
  assert.deepEqual(payload.definitionOfDoneCheck,[4]);
  assert.deepEqual(payload.definitionOfDoneUncheck,[6]);
  assert.deepEqual(payload.definitionOfDoneAdd,['New item','Second']);
  assert.deepEqual(payload.assignee,['Alex','Jo']);
  assert.deepEqual(payload.commentsAppend,['Evidence attached']);
  assert.equal(payload.milestone,null);
  assert.equal(payload.acceptanceCriteriaItems[0].checked,true);
});
test('filters combine owner, labels, milestone and case-insensitive text without mutation',() => {
  const tasks = [{id:'TASK-1',title:'Fix import',assignee:['Alex'],labels:['bug'],milestone:'m-1',status:'Ready'},{id:'TASK-2',title:'Fix import',assignee:['Jo'],labels:['bug'],milestone:'m-2',status:'Ready'}];
  assert.deepEqual(filterTasks(tasks,{search:'FIX',assignee:'Alex',labels:'bug',milestone:'m-1',status:'Ready'}),[tasks[0]]);
  assert.equal(filterTasks(tasks,{search:'missing'}).length,0);
  assert.equal(tasks.length,2);
});
test('criteria checked states round trip and untrusted card text is escaped',() => {
  const items = checklist('- [x] Done\n[ ] Pending\nPlain');
  assert.deepEqual(checklist(checklistText(items)),items);
  assert.equal(escapeHTML('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
});

test('a delayed successful save cannot erase edits from a reopened task editor', () => {
  const drafts = new Map([['task', 'newer recovery snapshot']]);
  const storage = {getItem:key => drafts.get(key), removeItem:key => drafts.delete(key)};
  clearSavedDraft(storage, 'task', 'submitted snapshot');
  assert.equal(drafts.get('task'), 'newer recovery snapshot');
  clearSavedDraft(storage, 'task', null);
  assert.equal(drafts.size, 1);
  clearSavedDraft(storage, 'task', 'newer recovery snapshot');
  assert.equal(drafts.size, 0);
});
