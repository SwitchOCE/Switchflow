import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
const source = resolve('template/.switchflow/scripts');
const run = (cmd,args,cwd) => spawnSync(cmd,args,{cwd,encoding:'utf8',windowsHide:true,timeout:30000});
const ok = r => {assert.ifError(r.error);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;};
const ps = (file,args,cwd) => run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],cwd);
function fixture(fn) {
 const root=mkdtempSync(join(tmpdir(),'switchflow-governance-')), primary=join(root,'primary'), linked=join(root,'candidate');
 mkdirSync(join(primary,'.switchflow/scripts'),{recursive:true});mkdirSync(join(primary,'backlog/tasks'),{recursive:true});
 writeFileSync(join(primary,'backlog.config.yml'),'project_name: Governance fixture\n');
 for(const file of ['tooling.ps1','backlog.ps1','check-docs.ps1','check-worktree-tools.ps1','cleanup-phase.ps1'])cpSync(join(source,file),join(primary,'.switchflow/scripts',file));
 writeFileSync(join(primary,'.switchflow/project.json'),JSON.stringify({schemaVersion:1,templateVersion:'0.4.0',taskPrefix:'TEST'}));
 writeFileSync(join(primary,'.switchflow/package.json'),JSON.stringify({devDependencies:{'backlog.md':'1.50.1'}}));
 mkdirSync(join(primary,'.switchflow/node_modules/backlog.md'),{recursive:true});
 writeFileSync(join(primary,'.switchflow/node_modules/backlog.md/package.json'),' {"version":"1.50.1"}');
 const trace = `const fs=require('fs');if(process.argv.includes('--version')){console.log('1.50.1');process.exit(0)}fs.writeFileSync('backlog/last-call.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));console.log(process.cwd());`;
 writeFileSync(join(primary,'.switchflow/node_modules/backlog.md/cli.js'),trace);
 mkdirSync(join(primary,'.switchflow/scripts/backlog-fork'),{recursive:true});writeFileSync(join(primary,'.switchflow/scripts/backlog-fork/resolve.mjs'),`console.log(${JSON.stringify(join(primary,'.switchflow/node_modules/backlog.md/cli.js'))})`);
 const helper=`import fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(args.find(x=>x.endsWith('primary'))+'/backlog/helper-call.json',JSON.stringify({args,content:fs.readFileSync(args.at(-1),'utf8')}));`;
 for(const file of ['update-document.mjs','milestone-scope.mjs'])writeFileSync(join(primary,'.switchflow/scripts',file),helper);
 writeFileSync(join(primary,'.switchflow/scripts/check-docs.mjs'),`console.log(process.argv[2]);`);
 ok(run('git',['init',primary],root));ok(run('git',['-C',primary,'add','.'],root));ok(run('git',['-C',primary,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture'],root));
 ok(run('git',['-C',primary,'worktree','add','-b','candidate',linked],root));
 try{fn({root,primary,linked,wrapper:join(linked,'.switchflow/scripts/backlog.ps1')});}
 finally {assert.ok(root.startsWith(join(tmpdir(),'switchflow-governance-')));rmSync(root,{recursive:true,force:true});}
}
test('linked worktree task, native browser, MCP and milestone CLI all use primary governance',()=>fixture(({primary,linked,wrapper})=>{
 for(const args of [['task','edit','T-1','--title','Changed'],['task','view','T-1'],['mcp','start'],['browser-native','--port','6428'],['milestone','edit','m-1','--labels','ship']]){
  ok(ps(wrapper,args,linked));const observed=JSON.parse(readFileSync(join(primary,'backlog/last-call.json'),'utf8'));
  assert.equal(observed.cwd,primary);assert.equal(observed.args[0],args[0]==='browser-native'?'browser':args[0]);
 }
 assert.throws(()=>readFileSync(join(linked,'backlog/last-call.json')),{code:'ENOENT'});
 assert.equal(ok(ps(join(linked,'.switchflow/scripts/check-docs.ps1'),[],linked)).trim(),primary);
}));
test('content paths resolve in caller cwd before canonical document and scope mutations',()=>fixture(({primary,linked,wrapper})=>{
 writeFileSync(join(linked,'input with spaces.txt'),'Exact candidate input');
 for(const args of [['doc','update','doc-01','--content-file'],['task','edit','T-1','--description-file'],['milestone','edit','m-0','--input-file']]){
  const content=args[0]==='milestone'?JSON.stringify({reason:'Scope change',approval:'Owner accepted'}):'Exact candidate input';writeFileSync(join(linked,'input with spaces.txt'),content);
  ok(ps(wrapper,[...args,'input with spaces.txt'],linked));const observed=JSON.parse(readFileSync(join(primary,'backlog/helper-call.json'),'utf8'));
  assert.equal(observed.content,content);assert.equal(observed.args.at(-1),join(linked,'input with spaces.txt'));
 }
}));
test('missing primary governance fails closed despite intact copied candidate governance',()=>fixture(({primary,linked,wrapper})=>{
 renameSync(join(primary,'backlog.config.yml'),join(primary,'backlog.config.unavailable'));
 const result=ps(wrapper,['task','list'],linked);assert.notEqual(result.status,0);assert.match(result.stderr,/Canonical governance is unavailable/);
 assert.throws(()=>readFileSync(join(linked,'backlog/last-call.json')),{code:'ENOENT'});
}));

test('worktree preflight ignores stale copied governance but validates candidate application dependencies',()=>fixture(({primary,linked})=>{
 writeFileSync(join(linked,'.switchflow/project.json'),JSON.stringify({schemaVersion:1,templateVersion:'old',taskPrefix:'OLD'}));
 const script=join(linked,'.switchflow/scripts/check-worktree-tools.ps1');
 const ready=ok(ps(script,['-Worktree',linked,'-TaskId','TEST-1','-RequireDocs'],linked));assert.ok(ready.includes(`governance: ${primary}`));
 writeFileSync(join(primary,'package.json'),'{}');mkdirSync(join(primary,'node_modules'),{recursive:true});writeFileSync(join(primary,'node_modules/.package-lock.json'),'{}');
 const missing=ps(script,['-Worktree',linked,'-TaskId','TEST-1','-RequireNode'],linked);assert.notEqual(missing.status,0);assert.match(missing.stderr,/candidate has no package.json/);
}));

test('missing fork permits reads but rejects mutation and MCP fallback',()=>fixture(({primary,linked,wrapper})=>{
 rmSync(join(primary,'.switchflow/scripts/backlog-fork/resolve.mjs'));
 ok(ps(wrapper,['task','list'],linked));
 for(const args of [['task','edit','TEST-1','--title','Unsafe fallback'],['mcp','start'],['browser-native'],['doc','create','New']]){
  const result=ps(wrapper,args,linked);assert.notEqual(result.status,0);assert.match(result.stderr,/verified Switchflow Backlog fork is required/);
 }
}));

test('import refuses linked code worktrees before writing governance copies',()=>fixture(({primary,linked})=>{
 const before=readFileSync(join(linked,'backlog.config.yml'));
 const result=ps(resolve('scripts/import-switchflow.ps1'),['-TargetPath',linked,'-ProjectName','Duplicate','-TaskPrefix','DUP'],linked);
 assert.notEqual(result.status,0);assert.match(result.stderr,/Import Switchflow into the primary checkout/);
 assert.deepEqual(readFileSync(join(linked,'backlog.config.yml')),before);assert.equal(readFileSync(join(primary,'backlog.config.yml'),'utf8'),'project_name: Governance fixture\n');
}));

test('legacy backlog/config.yml primary remains supported',()=>fixture(({primary,linked,wrapper})=>{
 renameSync(join(primary,'backlog.config.yml'),join(primary,'backlog/config.yml'));
 ok(ps(wrapper,['task','list'],linked));
 assert.equal(JSON.parse(readFileSync(join(primary,'backlog/last-call.json'),'utf8')).cwd,primary);
}));

test('fresh Git import resolves its actual root configuration through the wrapper',()=>{
 const root=mkdtempSync(join(tmpdir(),'switchflow-import-routing-'));
 try {
  ok(ps(resolve('scripts/import-switchflow.ps1'),['-TargetPath',root,'-ProjectName','Routing import','-TaskPrefix','IMP','-InitializeGit'],root));
  const installed=resolve('template/.switchflow/node_modules/backlog.md');
  const target=join(root,'.switchflow/node_modules/backlog.md');mkdirSync(target,{recursive:true});
  for(const file of ['package.json','cli.js'])cpSync(join(installed,file),join(target,file));
  writeFileSync(join(target,'resolveBinary.cjs'),`module.exports = require(${JSON.stringify(join(installed,'resolveBinary.cjs'))});`);
  assert.ok(readFileSync(join(root,'backlog.config.yml'),'utf8').includes('Routing import'));
  const listed=JSON.parse(ok(ps(join(root,'.switchflow/scripts/backlog.ps1'),['task','list','--json'],root)));
  assert.deepEqual(listed.tasks,[]);
  ok(run('git',['-C',root,'add','.'],root));ok(run('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Imported governance'],root));
  const candidate=join(root,'candidate-code');ok(run('git',['-C',root,'worktree','add','-b','code',candidate],root));
  ok(ps(join(candidate,'.switchflow/scripts/backlog.ps1'),['task','create','Canonical task from code worktree','--plain'],candidate));
  const after=JSON.parse(ok(ps(join(root,'.switchflow/scripts/backlog.ps1'),['task','list','--json'],root)));
  assert.equal(after.tasks.length,1);assert.equal(after.tasks[0].title,'Canonical task from code worktree');
  assert.equal(readdirSync(join(candidate,'backlog/tasks')).filter(name=>name.endsWith('.md')).length,0);
 } finally {assert.ok(root.startsWith(join(tmpdir(),'switchflow-import-routing-')));rmSync(root,{recursive:true,force:true});}
});

test('worktree preflight rejects a different Git project even with identical governance metadata',()=>fixture(({root,primary,linked})=>{
 const other=join(root,'other');mkdirSync(other);
 cpSync(join(primary,'.switchflow'),join(other,'.switchflow'),{recursive:true});mkdirSync(join(other,'backlog'));cpSync(join(primary,'backlog.config.yml'),join(other,'backlog.config.yml'));
 ok(run('git',['init',other],root));
 const result=ps(join(linked,'.switchflow/scripts/check-worktree-tools.ps1'),['-Worktree',other,'-TaskId','TEST-1'],linked);
 assert.notEqual(result.status,0);assert.match(result.stderr,/different Git project/);
}));

test('cleanup eligibility reads current primary task status rather than copied Done state',()=>fixture(({primary,linked})=>{
 const name='TEST-1 - clean.md';const task=status=>`---\nid: TEST-1\nstatus: ${status}\nlabels: [phase-clean]\n---\n`;
 mkdirSync(join(linked,'backlog/tasks'),{recursive:true});
 writeFileSync(join(primary,'backlog/tasks',name),task('Blocked'));writeFileSync(join(linked,'backlog/tasks',name),task('Done'));
 ok(run('git',['-C',primary,'branch','task/TEST-1'],primary));
 const integration=ok(run('git',['-C',primary,'branch','--show-current'],primary)).trim();
 const result=ok(ps(join(linked,'.switchflow/scripts/cleanup-phase.ps1'),['-PhaseLabel','phase-clean','-IntegrationBranch',integration,'-WhatIf'],linked));
 assert.match(result,/is Blocked, not Done/);assert.doesNotMatch(result,/Performing the operation/);
 assert.ok(ok(run('git',['-C',primary,'branch','--list','task/TEST-1'],primary)).includes('task/TEST-1'));
}));
