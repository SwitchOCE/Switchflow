import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativeBacklog } from '../template/.switchflow/scripts/control/native-backlog.mjs';

async function fixture(t, source, timeoutMs = 5000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-native-pipe-'));
  const file = path.join(root, 'bridge.mjs'); await fs.writeFile(file, source);
  const bridge = createNativeBacklog({ governanceRoot: root }, { timeoutMs, resolveRuntime: async () => ({ executable: process.execPath, bridgeArgs: [file] }) });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { bridge, root };
}

test('native pipe correlates concurrent replies and uses only canonical governance cwd', async t => {
  const { bridge, root } = await fixture(t, `
    import {createInterface} from 'node:readline';
    const input = createInterface({input:process.stdin});
    input.on('line', line => {
      const request=JSON.parse(line);
      setTimeout(()=>process.stdout.write(JSON.stringify({id:request.id,status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({cwd:process.cwd(),...request})).toString('base64')})+'\\n'), request.id===1?30:0);
    });
  `);
  const results = await Promise.all(['first', 'second'].map(title => bridge.request({ method: 'PUT', path: '/api/tasks/SAME-1', body: { title } })));
  assert.deepEqual(results.map(result => JSON.parse(result.body).body.title), ['first', 'second']);
  assert.equal(JSON.parse(results[0].body).cwd, root);
  await assert.rejects(bridge.request({ method: 'GET', path: '/outside' }), /Invalid Backlog request/);
  await bridge.close();
  await assert.rejects(bridge.request({ method: 'GET', path: '/api/tasks' }), /stopping/);
});

test('native pipe fails uncertain writes explicitly when the child exits or times out', async t => {
  const exited = await fixture(t, `process.stdin.once('data',()=>process.exit(7));`);
  await assert.rejects(exited.bridge.request({ method: 'PUT', path: '/api/tasks/SAME-1', body: { title: 'Uncertain' } }), /Inspect the saved record before retrying/);
  const hung = await fixture(t, `process.stdin.resume();`, 200);
  await assert.rejects(hung.bridge.request({ method: 'PUT', path: '/api/tasks/SAME-1', body: {} }), /may have completed/);
});

test('native pipe rejects corrupt transport instead of returning a false successful mutation', async t => {
  const { bridge } = await fixture(t, `process.stdin.once('data',()=>process.stdout.write('not-json\\n'));`);
  await assert.rejects(bridge.request({ method: 'PUT', path: '/api/tasks/SAME-1', body: {} }), /invalid response/);
});

function controlledBridge(killResult = true, timeoutMs = 5000) {
  const processes = [];
  const bridge = createNativeBacklog({governanceRoot:'.'}, {
    timeoutMs, resolveRuntime:async () => ({executable:'controlled-child'}),
    spawnChild:() => {
      const process = new EventEmitter();
      Object.assign(process, {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,killed:false,kills:0});
      process.requests = [];
      process.stdin.on('data',chunk => process.requests.push(JSON.parse(String(chunk))));
      process.kill = () => {
        process.kills++; process.emit('kill-requested');
        if (killResult === 'throw') throw new Error('termination unavailable');
        if (killResult === 'error') { process.emit('error',new Error('termination denied')); return false; }
        process.killed = killResult; return killResult;
      };
      process.reply = value => process.stdout.write(JSON.stringify(value)+'\n');
      processes.push(process); return process;
    },
  });
  return {bridge,processes};
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const mutation = bridge => bridge.request({method:'PUT',path:'/api/tasks/SAME-1',body:{title:'A write'}});

test('timeout retains caller admission and rejects replacement while termination is uncertain', async () => {
  for (const killResult of [true, false, 'throw', 'error']) {
    const {bridge,processes} = controlledBridge(killResult, 20);
    let settled = false;
    const request = mutation(bridge).finally(() => {settled = true;});
    const rejected = assert.rejects(request, /timed out/);
    await nextTurn(); const process = processes[0];
    await new Promise(resolve => process.once('kill-requested', resolve));
    await nextTurn();
    assert.equal(process.kills,1, 'kill failure must not recursively request termination');
    assert.equal(settled,false, 'original caller must retain admission until close');
    assert.equal(process.exitCode,null);
    await assert.rejects(mutation(bridge), /still stopping/);
    assert.equal(processes.length,1, 'no overlapping replacement child');
    process.reply({id:process.requests[0].id,status:200,body:''});
    await nextTurn(); assert.equal(settled,false,'late success cannot release the uncertainty fence');
    process.emit('exit',0); await nextTurn(); assert.equal(settled,false,'exit is not close');
    process.emit('close',0); await rejected;
    const replacement = mutation(bridge); await nextTurn();
    assert.equal(processes.length,2);
    processes[1].reply({id:processes[1].requests[0].id,status:200,body:''}); await replacement;
    const closing = bridge.close(); await nextTurn(); processes[1].emit('close',0); await closing;
  }
});

test('transport corruption and exit fence every concurrent caller until child close', async () => {
  const failures = [
    process => process.stdout.write('not-json\n'),
    ...[null, true, 42, 'response', []].map(value => process => process.reply(value)),
    process => process.reply({id:process.requests[0].id,status:99,body:''}),
    process => process.reply({id:process.requests[0].id,status:200,body:42}),
    process => process.reply({id:process.requests[0].id,status:200,body:'invalid base64'}),
    process => process.stdin.emit('error',new Error('disconnected')),
    process => process.emit('exit',7),
  ];
  for (const fail of failures) {
    const {bridge,processes} = controlledBridge(false);
    let settled = 0;
    const requests = [mutation(bridge),mutation(bridge)].map(request => request.finally(() => settled++));
    const rejections = requests.map(request => assert.rejects(request, /Backlog/));
    await nextTurn(); const process = processes[0]; fail(process); await nextTurn();
    assert.equal(settled,0); await assert.rejects(mutation(bridge), /still stopping/);
    assert.equal(processes.length,1); process.emit('close',7); await Promise.all(rejections);
    await bridge.close();
  }
});

test('workspace shutdown retains pending writer admission through late responses and exit', async () => {
  const {bridge,processes} = controlledBridge(false);
  let settled = false, shutdown = false;
  const rejected = assert.rejects(mutation(bridge).finally(() => {settled = true;}),/workspace stopped/);
  await nextTurn(); const process = processes[0];
  const closing = bridge.close().then(() => {shutdown = true;}); await nextTurn();
  process.reply({id:process.requests[0].id,status:200,body:''});process.emit('exit',0);
  await nextTurn();assert.equal(settled,false);assert.equal(shutdown,false);
  await assert.rejects(mutation(bridge), /stopping/);
  process.emit('close',0);await rejected;await closing;
});
