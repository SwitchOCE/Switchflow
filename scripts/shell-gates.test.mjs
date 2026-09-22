import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewGroups, runPresentation, historyPage, approvedNextWork, milestoneOrderSummary, reworkReviewSummary } from '../template/.switchflow/scripts/control/public/overview-model.js';
import { createInitiative, applyAction } from '../template/.switchflow/scripts/control/lifecycle.mjs';

test('overview separates human readiness, authority, queued work and real running evidence', () => {
  const initiatives = [{id:'stale',status:'running',stage:'delivery'},{id:'queued',status:'idle',pending:true,stage:'delivery',approvedPlan:{hash:'approved'}},{id:'human',status:'awaiting-human',stage:'planning'},{id:'hold',status:'running'}];
  const state = {initiatives,tasks:Array.from({length:5},(_,i) => ({id:`T-${i}`,status:'Ready',assignee:['Human']})),activeRun:{initiativeId:'hold',status:'interrupted'}};
  const result = overviewGroups(state);
  assert.equal(result.humanTasks.length,5);
  assert.equal(result.decisions.length,1);
  assert.equal(result.groups.find(g => g.title === 'Agent working').items.length,0);
  assert.deepEqual(result.groups.find(g => g.title === 'Next eligible').items.map(i => i.id),[]);
  assert.match(result.groups[0].items[1].reason,/authority/);
  assert.equal(runPresentation(initiatives[0],state.activeRun).label,'Run state unresolved');
  assert.equal(runPresentation(initiatives[3],state.activeRun).label,'Recovery hold');
  state.activeRun = {initiativeId:'stale',status:'running'};
  assert.equal(overviewGroups(state).groups[1].items.length,1);
});

test('retained histories expose oldest of 26 events and 50 runs without unbounded first render', () => {
  for (const count of [26,50]) {
    const records = Array.from({length:count},(_,id) => ({id}));
    assert.equal(historyPage(records).items.length,10);
    const all = Array.from({length:Math.ceil(count/10)},(_,page) => historyPage(records,page).items).flat();
    assert.equal(all.length,count); assert.equal(all.at(-1).id,0);
    assert.equal(new Set(all.map(r => r.id)).size,count);
  }
});

function uat() {
  return {...createInitiative({title:'Fixture',request:'Fixture',start:false}),stage:'uat',status:'awaiting-human',approvedPlan:{hash:'plan'},evidence:['candidate commit'],uat:[{id:'one',title:'Expected screen',status:'pending',notes:''},{id:'two',title:'Expected save',status:'pending',notes:''}]};
}
test('rework retains check association, observations and candidate for correction workflow without accepting', () => {
  const item = uat();
  applyAction(item,{action:'request-rework',expectedRevision:item.revision,feedback:'Correct screen',results:[{id:'one',status:'failed',notes:'Missing button after reload'},{id:'two',status:'passed',notes:'Saved successfully'}]});
  const reopened = JSON.parse(JSON.stringify(item));
  assert.equal(reopened.stage,'delivery'); assert.equal(reopened.approvedUat,null); assert.equal(reopened.pending,true);
  const review = reopened.messages.at(-1);
  assert.deepEqual(review.results.map(r => [r.id,r.title,r.status,r.notes]),[['one','Expected screen','failed','Missing button after reload'],['two','Expected save','passed','Saved successfully']]);
  assert.deepEqual(review.candidateEvidence,['candidate commit']);assert.equal(review.planHash,'plan');
});

test('stale or invalid check observations reject without partial lifecycle changes', () => {
  for (const results of [[{id:'old',status:'failed'},{id:'two',status:'pending'}],[{id:'one',status:'accepted'},{id:'two',status:'pending'}],[{id:'one',status:'failed',notes:'x'.repeat(12001)},{id:'two',status:'pending'}]]) {
    const item = uat(), before = JSON.stringify(item);
    assert.throws(() => applyAction(item,{action:'request-rework',expectedRevision:item.revision,feedback:'Fix',results}));
    assert.equal(JSON.stringify(item),before);
  }
});

test('older rework clients retain existing observations when omitting results', () => {
  const item = uat(); item.uat[0].notes = 'Existing detail'; item.uat[0].status = 'failed';
  applyAction(item,{action:'request-rework',expectedRevision:item.revision,feedback:'Fix'});
  assert.equal(item.messages.at(-1).results[0].notes,'Existing detail');
});


test('next task requires current approved scope, exact ordered IDs and completed prerequisites', () => {
  const item = {id:'i',title:'Delivery',stage:'delivery',approvedScope:{hash:'scope'},approvedPlan:{hash:'plan',scopeHash:'scope',tasks:[{task:'TASK-1'},{task:'TASK-2'},{task:'TASK-3'}]}};
  const tasks = [{id:'TASK-1',title:'First',status:'Done'},{id:'TASK-2',title:'Second',status:'Ready',dependencies:['TASK-1']},{id:'TASK-3',title:'Third',status:'Ready'}];
  assert.deepEqual(approvedNextWork([item],tasks).eligible.map(t => t.id),['TASK-2']);
  tasks[0].status = 'Blocked';
  assert.equal(approvedNextWork([item],tasks).eligible.length,0);
  tasks[0].status = 'Done';tasks[1].dependencies = ['TASK-4'];
  assert.match(approvedNextWork([item],tasks).waiting[0].reason,/Unavailable prerequisite.*TASK-4.*Unknown/);
  tasks.push({id:'TASK-4',title:'Review contract',status:'Review'});
  assert.match(approvedNextWork([item],tasks).waiting[0].reason,/Review contract.*Review/);
  item.approvedPlan.scopeHash = 'old';assert.match(approvedNextWork([item],tasks).waiting[0].reason,/authority is unresolved/);
  item.approvedPlan.scopeHash = 'scope';item.approvedPlan.tasks[0].task = 'Human-readable plan prose';
  assert.match(approvedNextWork([item],tasks).waiting[0].reason,/unique ordered list/);
});


test('overview retains recorded In Progress without claiming runtime execution and explains milestone ambiguity', () => {
  const groups = overviewGroups({initiatives:[],tasks:[{id:'TASK-1',title:'Recorded work',status:'In Progress'}]}).groups;
  assert.equal(groups.find(g => g.title === 'Agent working').items.length,0);
  assert.match(groups.find(g => g.title === 'Recorded task state').items[0].reason,/execution is unverified/);
  assert.match(milestoneOrderSummary(Array.from({length:40},(_,id) => ({id}))),/40 of 40 milestones are unsequenced/);
  assert.match(milestoneOrderSummary([{executionOrder:1},{executionOrder:1}]),/ties/);
  assert.match(milestoneOrderSummary([{executionOrder:1},{executionOrder:2}]),/approved plans and dependencies/);
});


test('rework attributes only actual results or notes and projects compact review history', () => {
  const item = uat(); item.uat = Array.from({length:20},(_,i) => ({id:`check-${i}`,title:`Check ${i}`,status:'pending',notes:''}));
  const results = item.uat.map(check => ({id:check.id,status:'pending',notes:''}));
  results[0] = {id:'check-0',status:'failed',notes:'Detailed failure remains attached'};
  results[1].notes = 'Attempt interrupted before verdict';
  applyAction(item,{action:'request-rework',expectedRevision:item.revision,feedback:'Fix the failure',results});
  const review = JSON.parse(JSON.stringify(item)).messages.at(-1);
  assert.equal(review.results[0].by,'Human');assert.ok(review.results[0].at);
  assert.equal(review.results[1].by,'Human');
  assert.equal('by' in review.results[2],false);assert.equal('at' in review.results[2],false);
  const summary = reworkReviewSummary(review);
  assert.equal(summary.observed.length,2);assert.equal(summary.unchecked.length,18);assert.equal(summary.checked,1);assert.equal(summary.failed,1);
  assert.equal(summary.observed[0].notes,'Detailed failure remains attached');assert.equal(item.approvedUat,null);
});
