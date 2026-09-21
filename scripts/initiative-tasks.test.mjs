import test from 'node:test';
import assert from 'node:assert/strict';
import {initiativeTasks} from '../template/.switchflow/scripts/control/public/initiative-tasks.js';
import {createInitiative,applyAction,applyResult} from '../template/.switchflow/scripts/control/lifecycle.mjs';
import {resolveBacklogFork} from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const tasks = [
  {id:'DEMO-1',title:'Deliver export',status:'Ready'},
  {id:'DEMO-10',title:'Deliver export',status:'Done'},
  {id:'DEMO-1.1',title:'Build serializer',status:'In Progress'},
];
test('structured plan task IDs select native Backlog records without synthetic metadata', () => {
  const item = {id:'initiative-1',plan:[{phase:'Export',task:'DEMO-1',outcome:'CSV export works',evidence:'Export checks'},
    {phase:'Export',task:' demo-1.1 ',outcome:'Serializer works',evidence:'Unit checks'}]};
  assert.deepEqual(initiativeTasks(item,tasks),[tasks[0],tasks[2]]);
  assert.equal(initiativeTasks({...item,plan:[...item.plan,item.plan[0]]},tasks).length,2);
});
test('title-only plans, mentions and shared prefixes cannot associate unrelated tasks', () => {
  for (const task of ['Deliver export','Deliver DEMO-1','DEMO-','DEMO-100','DEMO-1 and DEMO-10','[DEMO-1](url)']) {
    assert.deepEqual(initiativeTasks({id:'initiative-1',plan:[{task}]},tasks),[],task);
  }
  assert.deepEqual(initiativeTasks({id:'initiative-1',plan:[]},tasks),[]);
});
test('explicit legacy links remain valid and missing records are not invented', () => {
  const linked = {...tasks[1],initiativeId:'initiative-1'};
  assert.deepEqual(initiativeTasks({id:'initiative-1',taskIds:['DEMO-1','DEMO-404']},[tasks[0],linked]),[tasks[0],linked]);
});

test('normal planning approval links a real native task and freezes association against later proposals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'switchflow-initiative-links-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const runtime = await resolveBacklogFork();
  const run = (...args) => execFileSync(runtime.executable,args,{cwd:root,encoding:'utf8',windowsHide:true});
  run('init','Delivery task fixture','--defaults','--no-git','--integration-mode','none','--task-prefix','DEMO');
  run('task','create','Deliver export','--plain');run('task','create','Unrelated work','--plain');
  const native = JSON.parse(run('task','list','--json')).tasks;
  const item = createInitiative({title:'Export initiative',request:'Deliver export',start:false});
  const result = {stage:'intake',status:'ready',summary:'Scope ready',nextAction:'Review scope',questions:[],scope:'CSV export',plan:[],evidence:[],blockers:[],uat:[]};
  applyResult(item,result);
  applyAction(item,{action:'approve-scope',expectedRevision:item.revision});item.pending=false;
  applyResult(item,{...result,stage:'planning',plan:[{phase:'Export',task:'DEMO-1',outcome:'CSV export works',evidence:'Export checks'}]});
  applyAction(item,{action:'approve-plan',expectedRevision:item.revision});
  assert.equal(item.stage,'delivery');assert.equal(item.taskIds,undefined);
  assert.deepEqual(initiativeTasks(item,native).map(task=>task.id),['DEMO-1']);
  item.plan=[{task:'DEMO-2'}];
  assert.deepEqual(initiativeTasks(item,native).map(task=>task.id),['DEMO-1']);
});
