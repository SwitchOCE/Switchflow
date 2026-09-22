import test from 'node:test';
import assert from 'node:assert/strict';
import {mountKnowledge} from '../template/.switchflow/scripts/control/public/knowledge.js';
test('knowledge open reports successful, failed and stale navigation without throwing', async()=>{
  const oldWindow=globalThis.window, oldStorage=globalThis.sessionStorage;
  globalThis.window={matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})};
  globalThis.sessionStorage={getItem(){return null;},removeItem(){},setItem(){}};
  const nodes=new Map(); const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',innerHTML:'',querySelectorAll(){return [];},setAttribute(){}});return nodes.get(selector);};
  const container={classList:{add(){}},querySelector:node,querySelectorAll(){return [];},addEventListener(){},removeEventListener(){},replaceChildren(){}};
  const navigated=[];let resolveSlow;
  const panel=mountKnowledge(container,{projectId:'test',onNavigate:route=>navigated.push(route),api:async route=>{
    if(route==='/docs'||route==='/decisions')return [];
    if(route==='/docs/missing')throw new Error('Not found');
    if(route==='/docs/slow')return new Promise(resolve=>{resolveSlow=resolve;});
    return {id:'doc-1',title:'Readable',rawContent:'# Proof'};
  }});
  try {
    await panel.refresh();
    assert.equal(await panel.open('doc-1'),true);assert.equal(navigated.at(-1).record,'doc-1');
    assert.equal(await panel.open('missing'),false);assert.equal(node('.docs-status').textContent,'Not found');
    const stale=panel.open('slow');await panel.open('doc-1');resolveSlow({id:'slow',title:'Stale',rawContent:'old'});
    assert.equal(await stale,false);assert.equal(navigated.at(-1).record,'doc-1');
  } finally {panel.destroy();globalThis.window=oldWindow;globalThis.sessionStorage=oldStorage;}
});
