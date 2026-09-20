import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveBacklogFork, forkPaths, launcherFiles, sha256 } from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';

const runtime = await resolveBacklogFork();
function mcp(root, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, ['mcp', 'start'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false; const timer = setTimeout(() => finish(new Error('MCP timeout')), 30000);
    function finish(error, value) { if(done) return; done=true;clearTimeout(timer);child.stdin.end();child.kill(); error ? reject(error) : resolve(value); }
    const send = value => child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
    child.on('error', finish);child.stderr.resume();child.on('exit',code=>{if(!done)finish(new Error(`MCP exited ${code}`));});
    createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);if(r.error) return finish(new Error(r.error.message));if(r.id===1){send({method:'notifications/initialized'});send({id:2,method:'tools/call',params:{name,arguments:args}});}if(r.id===2){if(r.result.isError)finish(new Error(JSON.stringify(r.result)));else finish(null,r.result);}}catch(error){finish(error);}});
    send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'cas-test',version:'1'}}});
  });
}

test('pinned native CAS: fresh edits, Unicode stdin, preservation, concurrent writer and stale rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-cas-test-'));
  let writer; let browser;
  const run = (...args) => execFileSync(runtime.executable,args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const view = () => JSON.parse(run('task','view','CAS-2','--json')).task;
  try {
    run('init','CAS fixture','--defaults','--no-git','--integration-mode','none','--task-prefix','CAS');
    run('task','create','Dependency','--plain');
    run('task','create','Concurrent edit','--status','In Progress','--labels','preserved','--dep','CAS-1','--plain');
    run('task','create','Terminal task','--status','Done','--plain');
    run('task','edit','CAS-2','--comment','Preserve comment ✓','--comment-author','Alex','--plain');
    const before=view(); const file=path.join(root,before.path);
    assert.equal(before.revision,createHash('sha256').update(await fs.readFile(file)).digest('hex'));
    const viewed=await mcp(root,'task_view',{id:'CAS-2'});assert.match(JSON.stringify(viewed),new RegExp(before.revision));
    const description=('Unicode 日本語 café 🦊\n').repeat(420);
    const edited = await mcp(root,'task_edit',{id:'CAS-2',expectedRevision:before.revision,description});
    const fresh=view();assert.match(JSON.stringify(edited),new RegExp(fresh.revision));assert.equal(fresh.description,description.trim());assert.notEqual(fresh.revision,before.revision);
    for(const key of ['status','labels','dependencies','comments','assignees','acceptanceCriteria','definitionOfDone'])assert.deepEqual(fresh[key],before[key],key);
    const saved=await fs.readFile(file);
    await assert.rejects(mcp(root,'task_edit',{id:'CAS-2',expectedRevision:before.revision,title:'Stale'}),/REVISION_CONFLICT/);
    assert.deepEqual(await fs.readFile(file),saved);
    run('task','edit','CAS-2','--expected-revision',fresh.revision,'--title','Fresh CLI','--plain');
    const snapshot=view();
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    browser = spawn(runtime.executable, ['browser', '--port', String(port), '--no-open', '--non-interactive'], {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let browserOutput=''; browser.stderr.on('data', b => browserOutput += b);
    const url = await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('Native browser startup timeout: '+browserOutput)),15000);
      browser.on('error',error=>{clearTimeout(timeout);reject(error);});
      browser.on('exit',code=>{clearTimeout(timeout);reject(new Error('Native browser exited '+code+': '+browserOutput));});
      browser.stdout.on('data', b=>{browserOutput+=b;const found=browserOutput.match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timeout);resolve(found[0]);}});
    });
    const reorder=()=>fetch(url+'/api/tasks/reorder',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:'CAS-2',targetStatus:'In Progress',orderedTaskIds:['CAS-1','CAS-2']}),signal:AbortSignal.timeout(10000)});
    const helper=path.join(root,'native-writer.ts');
    await fs.writeFile(helper,`import { Core } from ${JSON.stringify(pathToFileURL(path.join(runtime.root,'source/src/core/backlog.ts')).href)};\nconst core=new Core(${JSON.stringify(root)});const task=await core.fs.loadTask('CAS-2');const terminal=await core.fs.loadTask('CAS-3');await core.fs.withTaskLock(task,()=>core.fs.withTaskLock(terminal,async()=>{console.log('LOCKED');for await(const _ of Bun.stdin.stream()){break;}task.status='Done';await core.updateTask(task,false);}));`);
    const bun=path.join(runtime.root,'toolchain/bin',process.platform==='win32'?'bun.exe':'bun');
    writer=spawn(bun,[helper],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const exited=new Promise((resolve,reject)=>{writer.on('error',reject);writer.on('exit',code=>code===0?resolve():reject(new Error(`writer exited ${code}`)));});
    exited.catch(() => {}); await new Promise((resolve,reject)=>{let stderr='';writer.stderr.on('data',b=>stderr+=b);writer.on('exit',()=>reject(new Error(stderr)));createInterface({input:writer.stdout}).on('line',line=>{if(line==='LOCKED')resolve();});});
    await assert.rejects(mcp(root,'task_edit',{id:'CAS-2',expectedRevision:snapshot.revision,title:'Contending edit'}),/lock|editing|being edited|being modified/i);
    for(const operation of [['archive','CAS-2'],['archive','CAS-1'],['complete','CAS-3'],['demote','CAS-2']]) {
      assert.throws(()=>run('task',...operation),error=>/being modified|lock/i.test(error.stderr || error.message),operation.join(' '));
    }
    assert.ok(JSON.parse(run('task','view','CAS-1','--json')).task);
    const rawBeforeReorder=await fs.readFile(file);
    const blockedReorder=await reorder(); assert.equal(blockedReorder.status,409,await blockedReorder.text());
    assert.deepEqual(await fs.readFile(file),rawBeforeReorder);
    writer.stdin.end('continue\n');await exited;
    assert.equal(view().status,'Done');
    await assert.rejects(mcp(root,'task_edit',{id:'CAS-2',expectedRevision:snapshot.revision,title:'Lost update'}),/REVISION_CONFLICT/);
    const done=view();await mcp(root,'task_edit',{id:'CAS-2',expectedRevision:done.revision,title:'Preserved status'});assert.equal(view().status,'Done');
    const beforeReorder=view();const reordered=await reorder();assert.equal(reordered.status,200,await reordered.text());
    const afterReorder=view();assert.equal(afterReorder.status,'In Progress');assert.equal(afterReorder.description,beforeReorder.description);assert.deepEqual(afterReorder.comments,beforeReorder.comments);
    await assert.rejects(mcp(root,'task_edit',{id:'CAS-2',expectedRevision:beforeReorder.revision,title:'Stale after native reorder'}),/REVISION_CONFLICT/);
    run('task','complete','CAS-3');assert.match(JSON.parse(run('task','view','CAS-3','--json')).task.path,/completed/);
    run('task','archive','CAS-1');assert.deepEqual(view().dependencies,[]);assert.equal(view().description,afterReorder.description);
    run('task','demote','CAS-2');await assert.rejects(fs.stat(file),{code:'ENOENT'});
  } finally {
    if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve=>browser.once('exit',resolve)); }
    if (writer && writer.exitCode === null) { writer.stdin.end(); writer.kill(); }
    const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});
  }
});




test('runtime rejects changed CLI and MCP launcher files', async () => {
  const cache=await fs.mkdtemp(path.join(os.tmpdir(),'switchflow-launcher-integrity-'));
  try {
    const location=await forkPaths(cache);await fs.mkdir(location.root,{recursive:true});
    const bytes=Buffer.from('isolated integrity fixture');await fs.writeFile(location.executable,bytes);
    await fs.cp(runtime.webRoot,location.webRoot,{recursive:true});
    const receipt=JSON.parse(await fs.readFile(path.join(runtime.root,'receipt.json'),'utf8'));
    await fs.writeFile(path.join(location.root,'receipt.json'),JSON.stringify({identity:location.identity,executableSha256:sha256(bytes),webSha256:receipt.webSha256}));
    for(const [file,value]of Object.entries(launcherFiles(location))) await fs.writeFile(path.join(location.root,file),value);
    await resolveBacklogFork({cache});
    for(const [file,value]of Object.entries(launcherFiles(location))){
      await fs.writeFile(path.join(location.root,file),value+'// changed');
      await assert.rejects(resolveBacklogFork({cache}),/Launcher integrity mismatch/);
      await fs.writeFile(path.join(location.root,file),value);
    }
    await fs.writeFile(location.executable,'changed');await assert.rejects(resolveBacklogFork({cache}),/Runtime integrity mismatch/);
  } finally {
    assert.ok(path.resolve(cache).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(cache,{recursive:true,force:true});
  }
});

test('released native lock ownership cannot leak into delayed async work', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'switchflow-lock-lease-'));
  try {
    execFileSync(runtime.executable,['init','Lease fixture','--defaults','--no-git','--integration-mode','none','--task-prefix','CAS'],{cwd:root,windowsHide:true});
    execFileSync(runtime.executable,['task','create','Lease task','--plain'],{cwd:root,windowsHide:true});
    const helper=path.join(root,'lease.ts');
    await fs.writeFile(helper,`import assert from 'node:assert/strict';import { Core } from ${JSON.stringify(pathToFileURL(path.join(runtime.root,'source/src/core/backlog.ts')).href)};const core=new Core(${JSON.stringify(root)});const task=await core.fs.loadTask('CAS-1');let release;const go=new Promise(resolve=>release=resolve);let delayed;await core.fs.withTaskLock(task,async()=>{delayed=(async()=>{await go;task.title='Delayed stale owner';await core.updateTask(task,false);})();});await core.fs.withTaskLock(task,async()=>{release();await assert.rejects(delayed,/being modified|lock/i);});assert.equal((await core.fs.loadTask('CAS-1')).title,'Lease task');`);
    execFileSync(path.join(runtime.root,'toolchain/bin',process.platform==='win32'?'bun.exe':'bun'),[helper],{cwd:root,windowsHide:true,timeout:15000});
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});
  }
});
