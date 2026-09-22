import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeClient,workspaceLocation} from '../template/.switchflow/scripts/control/public/workspace-client.js';
import {documentImageUrl} from '../template/.switchflow/scripts/control/public/documents.js';

test('native client binds every request to its captured project and does not retry a failed write', async () => {
  const calls = [], pending = [];
  const api = createNativeClient({projectId:'alpha',token:()=>'token',onWrite:delta=>pending.push(delta),fetcher:async (...args) => {calls.push(args);return {ok:false,status:409,json:async()=>({error:'Agent is active'})};}});
  await assert.rejects(api('/tasks/T-1',{method:'PUT',body:{title:'Draft'}}),error=>error.status===409 && error.message==='Agent is active');
  assert.equal(calls.length,1); assert.equal(calls[0][0],'/api/projects/alpha/native/tasks/T-1');
  assert.equal(calls[0][1].headers['X-Switchflow-Token'],'token'); assert.deepEqual(pending,[1,-1]);
});
test('native client rejects writes while disconnected and traversal before fetching', async () => {
  let calls = 0;
  const api = createNativeClient({projectId:'alpha',token:()=>'',canWrite:()=>false,fetcher:async()=>{calls++;}});
  await assert.rejects(api('/tasks',{method:'POST'}),/paused/);
  for (const route of ['//other/api','/../config','/%2e%2e/config','/tasks\\other']) await assert.rejects(api(route),/Invalid/);
  assert.equal(calls,0);
});

test('lost response and server failure require reconciliation without an automatic retry', async () => {
  for (const fetcher of [async()=>{throw new Error('Connection closed');},async()=>({ok:false,status:500,json:async()=>({error:'Refresh failed'})})]) {
    let attempts=0;
    const api=createNativeClient({projectId:'alpha',token:()=>'',fetcher:async(...args)=>{attempts++;return fetcher(...args);}});
    await assert.rejects(api('/tasks/T-1',{method:'PUT',body:{title:'Draft'}}),error=>error.outcome==='unknown'&&error.requiresReconciliation&&/Check the saved record/.test(error.message));
    assert.equal(attempts,1);
  }
});
test('record bookmarks retain explicit project identity and known workspace views', () => {
  assert.deepEqual(workspaceLocation('http://localhost/?project=p&view=tasks&task=T-1'),{project:'p',view:'tasks',task:'T-1',record:null});
  assert.equal(workspaceLocation('http://localhost/?view=unsupported').view,'board');
  assert.deepEqual(workspaceLocation('http://localhost/?project=p&view=skills&record=intake%2FSKILL.md'),{project:'p',view:'skills',task:null,record:'intake/SKILL.md'});
});
test('documentation images resolve only selected-project asset paths', () => {
  const project = 'a'.repeat(64), prefix = `/projects/${project}/backlog-assets/`;
  assert.equal(documentImageUrl('../assets/diagram.png','guide.md',project),prefix+'diagram.png');
  assert.equal(documentImageUrl('../../assets/diagram.svg','Guides/guide.md',project),prefix+'diagram.svg');
  assert.equal(documentImageUrl('/assets/diagram.webp','guide.md',project),prefix+'diagram.webp');
  for (const href of ['https://tracker.invalid/a.png','//tracker.invalid/a.png','/assets/../secret.png','../../secret.png','/assets/%252e%252e/private.png','/assets/a.html','javascript:alert(1)']) assert.equal(documentImageUrl(href,'guide.md',project),null,href);
});
