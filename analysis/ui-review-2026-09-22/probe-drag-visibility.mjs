// Read-only handler probe: real Switchflow module, minimal container/API doubles.
// This does not prove browser gesture, hit-testing, or accessibility behavior.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {mountTasks} from '../../template/.switchflow/scripts/control/public/tasks.js';

const handlers = new Map();
const nodes = new Map();
let resultWrites = 0;
const results = {
  html: '',
  set innerHTML(value) { this.html = value; resultWrites++; },
  get innerHTML() { return this.html; },
};
const node = selector => {
  if (selector === '.sf-task-results') return results;
  if (!nodes.has(selector)) nodes.set(selector, {textContent:'',innerHTML:'',disabled:false});
  return nodes.get(selector);
};
const container = {
  classList: {add() {}},
  innerHTML: '',
  querySelector: node,
  addEventListener(type, handler) { handlers.set(type, handler); },
  replaceChildren() {},
};
const fixtures = {
  '/tasks': [
    {id:'DEMO-1',title:'Disposable task',status:'Ready',ordinal:1},
    {id:'DEMO-2',title:'Second disposable task',status:'Ready',ordinal:2},
  ],
  '/statuses': ['Ready','Done'],
  '/config': {hideEmptyColumns:true},
  '/milestones': [],
};
const reorderRequests = [];
const board = mountTasks(container, {
  projectId:'read-only-review-fixture',
  api: async (route, options) => {
    if (route === '/tasks/reorder') {
      reorderRequests.push(structuredClone(options.body));
      return {};
    }
    assert.ok(route in fixtures, `Unexpected API request: ${route}`);
    return structuredClone(fixtures[route]);
  },
});
await board.refresh();
const columns = () => [...results.innerHTML.matchAll(/data-status="([^"]+)"/g)].map(x => x[1]);
const before = columns();
const writesBefore = resultWrites;
handlers.get('dragstart')({
  target:{closest:() => ({dataset:{id:'DEMO-1'}})},
  dataTransfer:{setData() {}},
  preventDefault() { throw new Error('Fixture drag unexpectedly rejected'); },
});
const during = columns();
await board.refresh();
const afterUnchangedRefresh = columns();
assert.deepEqual(before,['Ready']);
assert.deepEqual(during,['Ready']);
assert.deepEqual(afterUnchangedRefresh,['Ready']);
assert.equal(resultWrites,writesBefore);
await handlers.get('drop')({
  target:{closest:selector => selector === '[data-status]' ? {dataset:{status:'Ready'}} : {dataset:{id:'DEMO-1'}}},
  preventDefault() {},
});
assert.deepEqual(reorderRequests[0].orderedTaskIds,['DEMO-2','DEMO-1']);
handlers.get('dragend')();
board.destroy();
const evidence = {
  scope:'Actual mountTasks and dragstart handler with minimal DOM/API doubles; not a browser drag test',
  fixture:{hideEmptyColumns:true,statuses:fixtures['/statuses'],taskStatus:'Ready'},
  beforeDrag:before,
  duringDrag:during,
  afterUnchangedRefresh,
  additionalResultRenders:resultWrites-writesBefore,
  selfDropRequest:reorderRequests[0],
  conclusion:'Starting a drag does not reveal the hidden empty Done destination; an unchanged refresh does not reveal it either. A drop on the lifted card requests moving it to the end.',
  productionWrites:0,
};
await writeFile(new URL('drag-visibility-probe.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
