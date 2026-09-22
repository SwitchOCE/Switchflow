import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createControlServer} from '../template/.switchflow/scripts/control/server.mjs';
import {resolveProject} from '../template/.switchflow/scripts/operations/storage.mjs';

test('production control server serves every imported UI module and stylesheet', async () => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'switchflow-ui-assets-'));
  const root=path.join(base,'repo'); await fs.mkdir(root);
  execFileSync('git',['init','-b','main',root],{windowsHide:true,stdio:'ignore'});
  const context=await resolveProject(root,{stateHome:path.join(base,'state')});
  let app;
  try {
    app=await createControlServer({context,capabilities:{codex:false},backlog:{list:async()=>[]},nativeFactory:()=>({close:async()=>{}}),runner:async()=>{throw new Error('No agents in UI asset fixture');}});
    const html=await (await fetch(app.url)).text();
    const pending=[...html.matchAll(/(?:src|href)="\/(\w[\w.-]*\.(?:js|css))"/g)].map(m=>m[1]);
    const checked=new Set();
    while(pending.length){
      const file=pending.shift(); if(checked.has(file))continue; checked.add(file);
      const response=await fetch(`${app.url}/${file}`); assert.equal(response.status,200,file);
      const source=await response.text();
      if(file.endsWith('.js'))for(const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g))pending.push(match[1]);
    }
    assert.ok(checked.has('overview-model.js')); assert.ok(checked.has('ui-date.js'));
    assert.equal((await fetch(app.url+'/missing-ui-module.js')).status,404);
  } finally {
    await app?.close(); assert.equal(path.dirname(base),path.resolve(os.tmpdir())); await fs.rm(base,{recursive:true,force:true});
  }
});
