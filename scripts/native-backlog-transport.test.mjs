import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
