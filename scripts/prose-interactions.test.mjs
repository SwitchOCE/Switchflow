import test from 'node:test';
import assert from 'node:assert/strict';
import {bindProseInteractions,resolveProseLink} from '../template/.switchflow/scripts/control/public/documents.js';
const records = [{id:'guides/design.md',record:'doc-7',documentId:'doc-7',view:'documents'},{id:'decisions/decision-2.md',record:'decision-2',decisionId:'decision-2',view:'decisions'}];
function fixture(hrefs) {
  const listeners = {}, nodes = hrefs.map(href => ({dataset:{docLink:href},attrs:{href:'#'},removeAttribute(name){delete this.attrs[name];delete this[name];},setAttribute(name,value){this.attrs[name]=value;},hasAttribute(name){return name === 'data-doc-link' ? this.dataset.docLink !== undefined : name === 'data-doc-anchor' ? this.dataset.docAnchor !== undefined : name === 'data-copy-code' ? this.copy : name in this.attrs;},closest(selector){return selector === '.docs-prose' ? root : selector === '.docs-code' ? {querySelector:()=>({textContent:'const safe = true;'})} : this;}}));
  const heading={id:'doc-heading-proof',scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;}};
  const root={querySelectorAll(selector){return selector === '[data-doc-link]' ? nodes.filter(node=>node.dataset.docLink !== undefined) : selector === '[id]' ? [heading] : [];},addEventListener(name,fn){listeners[name]=fn;},removeEventListener(name){delete listeners[name];},contains(node){return nodes.includes(node);}};
  return {root,nodes,heading,listeners,click:node=>listeners.click({target:node,preventDefault(){}})};
}
test('prose resolver uses unique actual records and existing safe route conventions',()=>{
  assert.equal(resolveProseLink('guides/design.md','',records).record,'doc-7');
  assert.equal(resolveProseLink('../guides/design.md','notes/current.md',records).record,'doc-7');
  assert.equal(resolveProseLink('docs/guides/design.md','',records).record,'doc-7');
  assert.equal(resolveProseLink('/documentation/7','',records).record,'doc-7');
  assert.equal(resolveProseLink('/decisions/decision-2','',records).record,'decision-2');
  assert.equal(resolveProseLink('guides/design.md','',[...records, {...records[0],record:'doc-8'}]),null);
  for (const path of ['javascript:alert(1)','data:text/html,hello','file:///etc/passwd','//example.com','../guides/design.md','https%3A%2F%2Fevil.test','%2e%2e/outside.md','C:\\outside.md']) assert.equal(resolveProseLink(path,'',records),null,path);
});
test('safe external evidence stays usable after internal index hydration; internal navigation uses record identity',async()=>{
  const f=fixture(['https://example.com/proof','guides/design.md#proof']); let opened;
  bindProseInteractions(f.root,{api:async endpoint=>endpoint==='/docs'?[{id:'doc-7',path:'guides/design.md'}]:[],onOpenRecord:target=>{opened=target;}});
  assert.equal(f.nodes[0].href,'https://example.com/proof'); assert.equal(f.nodes[0].target,'_blank'); assert.equal(f.nodes[0].rel,'noopener noreferrer');
  await f.click(f.nodes[1]);
  assert.equal(opened.record,'doc-7'); assert.equal(opened.anchor,'proof');
  assert.equal(f.nodes[0].href,'https://example.com/proof'); assert.equal(f.nodes[0].attrs['aria-disabled'],undefined);
});
test('scoped fragments focus the rendered heading without changing URL or loading records',async()=>{
  const f=fixture(['#proof']);
  bindProseInteractions(f.root,{api:()=>assert.fail('local anchor must not fetch')});
  await f.click(f.nodes[0]); assert.equal(f.heading.scrolled,true); assert.equal(f.heading.focused,true);
  delete f.nodes[0].dataset.docLink; f.nodes[0].dataset.docAnchor='proof'; f.heading.focused=false;
  await f.click(f.nodes[0]); assert.equal(f.heading.focused,true);
});
test('unresolved and failed-index evidence reports an explanation instead of following placeholder href',async()=>{
  const f=fixture(['unknown.md','javascript:alert(1)']);const messages=[];
  bindProseInteractions(f.root,{api:async()=>{throw new Error('Offline');},report:text=>messages.push(text),onOpenRecord:()=>assert.fail('must not navigate')});
  await f.click(f.nodes[0]); assert.match(messages[0],/could not be loaded/); assert.equal(f.nodes[0].href,undefined); assert.equal(f.nodes[0].attrs['aria-disabled'],'true');
  await f.click(f.nodes[1]); assert.equal(f.nodes[1].href,undefined);
});
test('destroyed readers reject late index responses and queued navigation',async()=>{
  const second=fixture(['guides/design.md']); const resolves=[];
  const stop=bindProseInteractions(second.root,{api:()=>new Promise(resolve=>resolves.push(resolve)),onOpenRecord:()=>assert.fail('stale reader navigated')});
  await Promise.resolve(); const click=second.click(second.nodes[0]);stop();resolves.forEach(resolve=>resolve([{id:'doc-7',path:'guides/design.md'}]));await click;
  assert.equal(second.nodes[0].href,undefined);
});
test('code copy uses scoped code text and reports outcome',async()=>{
  const f=fixture(['#proof']);delete f.nodes[0].dataset.docLink;f.nodes[0].copy=true;let copied,message;
  const prior=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{copied=text;}}}});
  try {bindProseInteractions(f.root,{report:text=>{message=text;}});await f.click(f.nodes[0]);assert.equal(copied,'const safe = true;');assert.equal(message,'Code copied.');}
  finally {if(prior) Object.defineProperty(globalThis,'navigator',prior);else delete globalThis.navigator;}
});
