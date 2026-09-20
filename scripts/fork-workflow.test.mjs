import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveBacklogFork } from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';

const executable = process.env.SWITCHFLOW_TEST_FORK_EXE || (await resolveBacklogFork()).executable;
const mcp = (root, name, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, ['mcp', 'start'], { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let finished = false;
  const timer = setTimeout(() => finish(new Error('MCP timeout')), 30000);
  const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); child.stdin.end(); child.kill(); error ? reject(error) : resolve(value); };
  child.stderr.resume(); child.on('error', finish); child.on('exit', code => { if (!finished) finish(new Error(`MCP exited ${code}`)); });
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    try { const response = JSON.parse(line);
      if (response.error) return finish(new Error(response.error.message));
      if (response.id === 1) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/call', params: { name, arguments: args } }); }
      if (response.id === 2) response.result.isError ? finish(new Error(JSON.stringify(response.result))) : finish(null, response.result);
    } catch (error) { finish(error); }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workflow-test', version: '1' } } });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-fork-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  run('init', 'Workflow fixture', '--defaults', '--no-git', '--integration-mode', 'none', '--task-prefix', 'WF');
  const configFile = path.join(root, 'backlog/config.yml');
  const config = await fs.readFile(configFile, 'utf8');
  await fs.writeFile(configFile, config.replace(/statuses:.*(?:\r?\n[ \t]+[^\r\n]*)*/m, 'statuses: [Backlog, Ready, Blocked, In Progress, Review, Done]'));
  const task = id => JSON.parse(run('task','view',id,'--json')).task;
  const milestone = id => JSON.parse(run('milestone','view',id,'--json'));
  return { root, run, task, milestone };
}

test('milestone CLI/MCP editing preserves identity, custom fields and body with exact revision CAS', async t => {
  const { root, run, milestone } = await fixture(t);
  run('milestone','add','First'); run('milestone','add','Second');
  let first = milestone('m-0'); const second = milestone('m-1');
  const directory = path.join(root,'backlog/milestones');
  const file = path.join(directory, (await fs.readdir(directory)).find(name => name.startsWith('m-0 ')));
  let bytes = await fs.readFile(file,'utf8');
  await fs.writeFile(file, bytes.replace('---\n','---\ncustom: preserve-me\n') + '\n## Evidence\n\nPreserve this section.\n');
  first = milestone('m-0');
  assert.equal(first.revision, createHash('sha256').update(await fs.readFile(file)).digest('hex'));
  const result = await mcp(root,'milestone_edit',{ id:'m-0',expectedRevision:first.revision,title:'Updated',description:'Unicode café 日本語\n\nScope.',labels:['release','release','UI'],executionOrder:7 });
  const updated = milestone('m-0'); assert.equal(updated.id,'m-0'); assert.equal(updated.title,'Updated');
  assert.equal(updated.description,'Unicode café 日本語\n\nScope.'); assert.deepEqual(updated.labels,['release','UI']); assert.equal(updated.executionOrder,7);
  assert.match(await fs.readFile(file,'utf8'),/custom: preserve-me/); assert.match(updated.rawContent,/Preserve this section/);
  assert.equal(result.structuredContent.milestone.revision,updated.revision);
  const persisted = await fs.readFile(file); await assert.rejects(mcp(root,'milestone_edit',{id:'m-0',expectedRevision:first.revision,title:'stale'}),/revision conflict/i); assert.deepEqual(await fs.readFile(file),persisted);
  run('milestone','edit','m-1','--expected-revision',second.revision,'--execution-order','1','--labels','early','--json');
  assert.deepEqual(JSON.parse(run('milestone','list','--json')).map(m => m.id),['m-1','m-0']);
  assert.equal((await mcp(root,'milestone_view',{id:'m-0'})).structuredContent.milestone.executionOrder,7);
  assert.equal((await mcp(root,'milestone_list',{})).structuredContent.milestones.length,2);
  await mcp(root,'milestone_edit',{id:'m-0',expectedRevision:updated.revision,executionOrder:null,labels:[]});
  assert.equal(milestone('m-0').executionOrder,undefined); assert.deepEqual(milestone('m-0').labels,[]);
  const fresh=milestone('m-0'); await assert.rejects(mcp(root,'milestone_edit',{id:'m-0',expectedRevision:fresh.revision,executionOrder:1.5}),/integer/);
  const inputFile = path.join(root,'edit.json'); const long = 'A long readable scope.\n'.repeat(5000);
  await fs.writeFile(inputFile,JSON.stringify({expectedRevision:fresh.revision,description:long}));
  run('milestone','edit','m-0','--input-file',inputFile,'--json'); assert.equal(milestone('m-0').description,long.trim());
});

test('dependency reconciliation promotes only dependency-blocked tasks, preserves manual gates and updates CAS', async t => {
  const { root,run,task } = await fixture(t);
  run('task','create','First prerequisite','--status','Ready','--plain');
  run('task','create','Second prerequisite','--status','Ready','--plain');
  for(const [title,status,reason] of [['Dependent','Ready',''],['Manual','Blocked','waiting for Alex'],['Unscheduled','Backlog',''],['Active','In Progress',''],['Review','Review',''],['Legacy','Blocked','']]) {
    const args=['task','create',title,'--status',status,'--dep','WF-1,WF-2','--plain']; if(reason) args.push('--block-reason',reason); run(...args);
  }
  const before=task('WF-3'); assert.equal(before.status,'Blocked'); assert.equal(before.blockReason,'dependent');
  assert.equal(JSON.parse(run('task','list','--json')).tasks.find(task=>task.id==='WF-3').blockReason,'dependent');
  assert.match(JSON.stringify(await mcp(root,'task_list',{})),/Block reason: dependent/);
  run('task','edit','WF-1','--status','Done','--plain'); assert.equal(task('WF-3').status,'Blocked');
  await mcp(root,'task_edit',{id:'WF-2',expectedRevision:task('WF-2').revision,status:'Done'});
  const after=task('WF-3'); assert.equal(after.status,'Ready'); assert.equal(after.blockReason,null); assert.notEqual(after.revision,before.revision);
  assert.equal(task('WF-4').blockReason,'waiting for Alex'); assert.equal(task('WF-4').status,'Blocked');
  assert.match(JSON.stringify(await mcp(root,'task_view',{id:'WF-4'})),/Block reason: waiting for Alex/);
  assert.ok(!JSON.parse(run('task','list','--ready','--json')).tasks.some(task=>task.id==='WF-4'));
  assert.doesNotMatch(JSON.stringify(await mcp(root,'task_list',{ready:true})),/Manual|WF-4/);
  assert.equal(task('WF-5').status,'Backlog'); assert.equal(task('WF-6').status,'In Progress'); assert.equal(task('WF-7').status,'Review'); assert.equal(task('WF-8').status,'Blocked');
  await mcp(root,'task_edit',{id:'WF-8',expectedRevision:task('WF-8').revision,blockReason:''}); assert.equal(task('WF-8').status,'Ready');
  await assert.rejects(mcp(root,'task_edit',{id:'WF-3',expectedRevision:before.revision,title:'stale'}),/REVISION_CONFLICT/);
  run('task','edit','WF-1','--status','Ready','--plain'); assert.equal(task('WF-3').status,'Blocked'); assert.equal(task('WF-3').blockReason,'dependent');
  run('task','edit','WF-1','--status','Done','--plain'); run('task','complete','WF-1'); assert.equal(task('WF-3').status,'Ready');
  await mcp(root,'task_edit',{id:'WF-3',expectedRevision:task('WF-3').revision,blockReason:'external approval'});
  assert.equal(task('WF-3').status,'Blocked'); assert.equal(task('WF-3').blockReason,'external approval');
  await mcp(root,'task_edit',{id:'WF-3',expectedRevision:task('WF-3').revision,blockReason:''});
  assert.equal(task('WF-3').status,'Ready'); assert.equal(task('WF-3').blockReason,null);
  assert.deepEqual(JSON.parse(run('task','reconcile','--json')).changed,[]);
});

test('missing and cyclic prerequisites remain dependency-blocked while terminal tasks stay done', async t => {
  const { root,run,task } = await fixture(t);
  run('task','create','Missing','--status','Ready','--plain'); run('task','create','Cycle','--status','Ready','--plain'); run('task','create','Finished','--status','Done','--plain');
  for(const [id,deps] of [['WF-1',['WF-2','WF-999']],['WF-2',['WF-1']],['WF-3',['WF-999']]]) {
    const file=path.join(root,task(id).path); const body=await fs.readFile(file,'utf8'); await fs.writeFile(file,body.replace('dependencies: []','dependencies: ['+deps.join(', ')+']'));
  }
  run('task','reconcile','--json'); assert.equal(task('WF-1').status,'Blocked'); assert.equal(task('WF-2').status,'Blocked'); assert.equal(task('WF-3').status,'Done');
  run('task','reconcile','--json'); assert.equal(task('WF-1').blockReason,'dependent');
});

test('archiving a prerequisite with multiple dependents reconciles after the graph batch', async t => {
  const { run,task } = await fixture(t);
  run('task','create','Prerequisite','--status','Done','--plain');
  run('task','create','First child','--status','Ready','--dep','WF-1','--plain');
  run('task','create','Second child','--status','Ready','--dep','WF-1','--plain');
  // Archive CLI intentionally rejects Done; a nonterminal prerequisite models the same
  // multi-snapshot mutation while the children already carry dependency blocks.
  run('task','edit','WF-1','--status','Ready','--plain');
  run('task','archive','WF-1');
  for(const id of ['WF-2','WF-3']) { assert.equal(task(id).status,'Ready'); assert.equal(task(id).blockReason,null); assert.deepEqual(task(id).dependencies,[]); }
});

test('milestone rename normalizes legacy title task references and preserves other task data', async t => {
  const { root,run,task,milestone } = await fixture(t);
  run('milestone','add','Legacy release'); run('task','create','Legacy task','--status','Backlog','--labels','preserve','--plain');
  const file=path.join(root,task('WF-1').path); const body=await fs.readFile(file,'utf8'); await fs.writeFile(file,body.replace('---\n','---\nmilestone: Legacy release\n'));
  const before=task('WF-1'); const version=milestone('m-0');
  run('milestone','edit','m-0','--title','New release','--expected-revision',version.revision,'--json');
  assert.equal(task('WF-1').milestone,'m-0'); assert.equal(task('WF-1').status,before.status); assert.deepEqual(task('WF-1').labels,before.labels);
});

test('real Core completion and archive batches reconcile graph without stale sibling writes', async t => {
  const { root,run,task } = await fixture(t);
  run('task','create','Location completion','--status','Ready','--plain');
  run('task','create','Location dependent','--status','Ready','--dep','WF-1','--plain');
  run('task','create','Archive source','--status','Done','--plain');
  run('task','create','Archive first','--status','Ready','--dep','WF-3','--plain');
  run('task','create','Archive second','--status','Ready','--dep','WF-3','--plain');
  const runtimeRoot=path.dirname(executable);
  const localSource=path.join(runtimeRoot,'src/core/backlog.ts');
  const source=await fs.access(localSource).then(()=>localSource,()=>path.join(runtimeRoot,'source/src/core/backlog.ts'));
  const bun=process.env.SWITCHFLOW_TEST_BUN || path.join(runtimeRoot,'toolchain/bin',process.platform==='win32'?'bun.exe':'bun');
  const helper=path.join(root,'core-workflow.ts');
  await fs.writeFile(helper,`import { Core } from ${JSON.stringify(pathToFileURL(source).href)};\nconst core=new Core(${JSON.stringify(root)});\nif(!await core.completeTask('WF-1',false))throw new Error('completion failed');\nif(!await core.archiveTask('WF-3',false))throw new Error('archive failed');\n`);
  execFileSync(bun,[helper],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.equal(task('WF-2').status,'Ready'); assert.equal(task('WF-2').blockReason,null);
  for(const id of ['WF-4','WF-5']) { assert.equal(task(id).status,'Ready'); assert.equal(task(id).blockReason,null); assert.deepEqual(task(id).dependencies,[]); }
});

test('milestone edit rejects ambiguous archived title references without changing bytes', async t => {
  const { root,run,task,milestone } = await fixture(t);
  run('milestone','add','Shared title'); run('milestone','archive','m-0'); run('milestone','add','Shared title');
  run('task','create','Ambiguous legacy task','--status','Backlog','--plain');
  const taskFile=path.join(root,task('WF-1').path); await fs.writeFile(taskFile,(await fs.readFile(taskFile,'utf8')).replace('---\n','---\nmilestone: Shared title\n'));
  const before=milestone('m-1'); const taskBytes=await fs.readFile(taskFile);
  await assert.rejects(mcp(root,'milestone_edit',{id:'m-1',expectedRevision:before.revision,title:'Changed'}),/ambiguous/i);
  assert.equal(milestone('m-1').revision,before.revision); assert.deepEqual(await fs.readFile(taskFile),taskBytes);
});
