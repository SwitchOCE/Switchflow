import test from 'node:test';
import assert from 'node:assert/strict';
import {moveTaskOrder, taskPayload, clearSavedDraft, filterTasks} from '../template/.switchflow/scripts/control/public/tasks-model.js';
const tasks = [{id:'A',status:'Ready',ordinal:1,title:'Alpha'},{id:'B',status:'Ready',ordinal:2,title:'Beta'},{id:'C',status:'Ready',ordinal:3,title:'Gamma'}];
test('self drop and unchanged before/after placement send no write',() => {assert.equal(moveTaskOrder(tasks,'A','Ready','A','after'),null); assert.equal(moveTaskOrder(tasks,'A','Ready','B','before'),null); assert.equal(moveTaskOrder(tasks,'B','Ready','A','after'),null);});
test('before and after preserve filtered-out siblings in canonical order',() => {assert.deepEqual(moveTaskOrder(tasks,'A','Ready','B','after').orderedTaskIds,['B','A','C']); assert.deepEqual(moveTaskOrder(tasks,'C','Ready','A','before').orderedTaskIds,['C','A','B']);});
test('top bottom and previously empty status are accessible move targets',() => {assert.deepEqual(moveTaskOrder(tasks,'C','Ready',null,'top').orderedTaskIds,['C','A','B']); assert.deepEqual(moveTaskOrder(tasks,'A','Ready',null,'bottom').orderedTaskIds,['B','C','A']); assert.deepEqual(moveTaskOrder(tasks,'A','Done',null,'bottom'),{taskId:'A',targetStatus:'Done',orderedTaskIds:['A']});});
test('check completion cannot remove retained indexed criteria',() => {const payload = taskPayload({dodKeep2:'on',dodCheck2:'on',acceptanceCriteriaItems:'[x] Accept it'}, {id:'A',revision:'r1',definitionOfDoneItems:[{index:2,text:'Done',checked:false}]}); assert.deepEqual(payload.definitionOfDoneRemove,[]); assert.deepEqual(payload.definitionOfDoneCheck,[2]); assert.equal(payload.expectedRevision,'r1'); assert.deepEqual(payload.acceptanceCriteriaItems,[{index:1,text:'Accept it',checked:true}]);});
test('save completion only clears its own recovery snapshot',() => {let value = 'newer'; const storage = {getItem:() => value,removeItem:() => {value = null;}}; clearSavedDraft(storage,'key','older'); assert.equal(value,'newer'); clearSavedDraft(storage,'key','newer'); assert.equal(value,null);});
test('filtered count derives from the same records rendered',() => {assert.equal(filterTasks(tasks,{search:'alpha'}).length,1); assert.equal(filterTasks(tasks,{status:'Done'}).length,0);});

import {taskBlockerText} from '../template/.switchflow/scripts/control/public/tasks-model.js';
import {mountTasks} from '../template/.switchflow/scripts/control/public/tasks.js';
test('reserved dependency blockers name prerequisite state and missing evidence',() => {
  assert.equal(taskBlockerText({blockReason:'dependent',dependencies:['A']},tasks),'Waiting for Alpha (Ready).');
  assert.equal(taskBlockerText({blockReason:'dependent',dependencies:['missing']},tasks),'Waiting for missing (status unavailable).');
  assert.equal(taskBlockerText({blockReason:'dependent'},tasks),'Waiting for a prerequisite; no prerequisite is recorded.');
  assert.equal(taskBlockerText({status:'Blocked'},tasks),'Blocked, but no reason is recorded.');
  assert.equal(taskBlockerText({status:'Ready'},tasks),'');
  assert.equal(taskBlockerText({blockReason:'Needs access'},tasks),'Needs access');
});
test('unchanged refresh keeps filtered count and operation feedback',async () => {
  const nodes = new Map(), handlers = new Map();
  const node = selector => {if (!nodes.has(selector)) nodes.set(selector,{textContent:'',value:'',innerHTML:'',setAttribute(){}}); return nodes.get(selector);};
  const container = {classList:{add(){}},dataset:{},addEventListener(type,handler){handlers.set(type,handler);},querySelector(selector){return selector === '.sf-task-board' ? null : node(selector);},querySelectorAll(){return [];},replaceChildren(){}};
  const api = async route => ({'/tasks':tasks,'/statuses':['Ready','Done'],'/config':{},'/milestones':[]})[route];
  const view = mountTasks(container,{api,projectId:'count-fixture'});
  await view.refresh();
  handlers.get('input')({target:{matches:selector => selector === '[data-search]',value:'Alpha'}});
  assert.equal(node('.sf-task-count').textContent,'1 of 3 tasks');
  node('.sf-task-notice').textContent = 'Moved A to Ready.';
  await view.refresh();
  assert.equal(node('.sf-task-count').textContent,'1 of 3 tasks');
  assert.equal(node('.sf-task-notice').textContent,'Moved A to Ready.');
  view.destroy();
});

import {captureTaskView,restoreTaskView} from '../template/.switchflow/scripts/control/public/tasks-view-state.js';
test('task detail snapshot restores linked focus identity and exact scroll after layout',() => {
  const control = (attributes = {}) => ({getAttribute:key => attributes[key] || null,closest:() => null,focus(options){this.focusOptions = options; root.scrollTop = 0;}});
  const expand = control(), dependency = control({'data-related':'DEMO-26'}), newControl = control();
  let controls = [expand,dependency]; const details = [{open:true},{open:false}];
  const root = {scrollTop:692,contains:item => controls.includes(item),querySelectorAll:selector => selector === 'details' ? details : controls};
  const snapshot = captureTaskView(root,dependency,{activity:false,expanded:true,commentCount:30,editing:false});
  root.scrollTop = 0; details[0].open = false; details[1].open = true; controls = [newControl,expand,dependency];
  restoreTaskView(root,snapshot);
  assert.equal(root.scrollTop,692);
  assert.deepEqual(dependency.focusOptions,{preventScroll:true});
  assert.deepEqual(details.map(item => item.open),[true,false]);
  assert.equal(snapshot.commentCount,30); assert.equal(snapshot.expanded,true); assert.equal(snapshot.editing,false);
});
test('task detail restore does not focus hidden or missing controls',() => {
  let focused = false;
  const root = {scrollTop:1,querySelectorAll:selector => selector === 'details' ? [] : [{getAttribute:() => 'missing',closest:() => ({}),focus(){focused = true;}}]};
  restoreTaskView(root,{scrollTop:200,identity:{attribute:'name',value:'missing'},disclosures:[]});
  assert.equal(focused,false); assert.equal(root.scrollTop,200);
});

test('task access refresh reports supplied offline cause and generic unavailable fallback',() => {
  const nodes = new Map();
  const node = selector => {if (!nodes.has(selector)) nodes.set(selector,{textContent:'',value:'',innerHTML:'',setAttribute(){}}); return nodes.get(selector);};
  const container = {classList:{add(){}},dataset:{},addEventListener(){},querySelector:node,querySelectorAll(){return [];},replaceChildren(){}};
  let writable = false, reason = 'Connection lost. Reconnect before saving.';
  const view = mountTasks(container,{api:async()=>[],projectId:'access-fixture',canWrite:() => writable,writeBlockedReason:() => reason});
  view.updateAccess();
  assert.match(node('.sf-task-count').textContent,/Connection lost/); assert.doesNotMatch(node('.sf-task-count').textContent,/agent/); assert.equal(node('[data-create]').disabled,true);
  reason = ''; view.updateAccess(); assert.match(node('.sf-task-count').textContent,/temporarily unavailable/);
  writable = true; view.updateAccess(); assert.equal(node('.sf-task-count').textContent,'0 of 0 tasks'); assert.equal(node('[data-create]').disabled,false);
  view.destroy();
});

test('repeated prose links restore exact visible discussion link then visible identity fallback',() => {
  const link = (hidden = false) => ({getAttribute:name => name === 'data-doc-link' ? 'guides/design.md' : null,closest:() => hidden ? {} : null,getClientRects:() => hidden ? [] : [{}],focus(){this.focused = true;}});
  const description = link(true), firstComment = link(), selectedComment = link();
  let controls = [description,firstComment,selectedComment];
  const root = {scrollTop:0,contains:node => controls.includes(node),querySelectorAll:selector => selector === 'details' ? [] : controls};
  const snapshot = captureTaskView(root,selectedComment,{activity:true});
  restoreTaskView(root,snapshot);
  assert.equal(selectedComment.focused,true); assert.equal(firstComment.focused,undefined); assert.equal(description.focused,undefined);
  selectedComment.focused = false; controls = [description,selectedComment];
  restoreTaskView(root,snapshot);
  assert.equal(selectedComment.focused,true); assert.equal(description.focused,undefined);
});
