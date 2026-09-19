import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafePath, digest, stable, withLock } from '../operations/storage.mjs';
import { createGitOperations, validateBridgeIdentity } from './git-bridge-operations.mjs';

const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
async function readJson(root, file) {
  await assertSafePath(root, file);
  if ((await fs.lstat(file)).size > 128 * 1024) throw new Error('Git bridge input exceeds limit');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomicJson(root, file, value) {
  await assertSafePath(root, file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await fs.rename(temporary, file);
}

/** Host-owned capability, created only after the controller records approval for this exact plan. */
export async function startGitBridge({ context, runDirectory, initiativeId, planHash, baseHead, signal }) {
  if (signal?.aborted) throw new Error('Git bridge run is cancelled');
  validateBridgeIdentity({ initiativeId, planHash, baseHead });
  const receiptsRoot = await assertSafePath(context.stateDir, path.join(context.stateDir, 'git-receipts', initiativeId, planHash));
  await fs.mkdir(receiptsRoot, { recursive: true });
  const allReceipts = path.join(context.stateDir, 'git-receipts');
  async function inspectReceipts(directory) {
    await assertSafePath(context.stateDir, directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = await assertSafePath(context.stateDir, path.join(directory, entry.name));
      if (entry.isDirectory()) await inspectReceipts(file);
      else if (entry.name.endsWith('.json')) {
        const receipt = await readJson(context.stateDir, file);
        if (receipt.status !== 'complete') throw new Error(`Uncertain prior Git operation ${receipt.id || entry.name}; inspect its outcome and process before explicit recovery. This project is fenced.`);
      }
    }
  }
  await inspectReceipts(allReceipts);
  const operations = await createGitOperations({ context, initiativeId, planHash, baseHead });
  const channelPath = await assertSafePath(context.stateDir, path.join(runDirectory, 'git-channel'));
  await fs.mkdir(channelPath);
  for (const name of ['requests', 'responses', 'claimed']) await fs.mkdir(path.join(channelPath, name));
  const sessionId = randomUUID();
  const activePath = path.join(channelPath, 'active.json');
  await atomicJson(channelPath, activePath, { sessionId, active: true, pid: process.pid });
  let admitting = true; let running = null; let fatalError = null; let closePromise;
  const descriptor = { helperPath: fileURLToPath(new URL('./git-bridge-client.mjs', import.meta.url)), channelPath, managedRoot: operations.managedRoot, initiativeId, planHash, baseHead };
  const respond = (id, response) => atomicJson(channelPath, path.join(channelPath, 'responses', `${id}.json`), response);
  const stopAdmission = () => { admitting = false; };
  signal?.addEventListener('abort', stopAdmission, { once: true });
  if (signal?.aborted) stopAdmission();

  async function processRequest(id) {
    const incoming = path.join(channelPath, 'requests', `${id}.json`);
    await assertSafePath(channelPath, incoming);
    const claimed = path.join(channelPath, 'claimed', `${id}.${randomUUID()}.json`);
    // Claim before inspecting/performing the operation; never perform directly from a mutable queue entry.
    try { await fs.rename(incoming, claimed); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let response; let requestHash; let operationClaimed = false;
    try {
      const envelope = await readJson(channelPath, claimed);
      if (envelope.sessionId !== sessionId || !envelope.request || typeof envelope.request !== 'object' || Array.isArray(envelope.request) || envelope.request.id !== id) throw new Error('Stale or invalid Git bridge request');
      const request = envelope.request;
      requestHash = digest(stable(request));
      if (!admitting || signal?.aborted) throw new Error('Git bridge is closed or superseded');
      const receiptPath = await assertSafePath(receiptsRoot, path.join(receiptsRoot, `${id}.json`));
      response = await withLock(context, `git-operation-${initiativeId}-${planHash}`, async () => {
        // Cancellation while waiting for another operation does not admit new work.
        if (!admitting || signal?.aborted) throw new Error('Git bridge is closed or superseded');
        let handle;
        try { handle = await fs.open(receiptPath, 'wx'); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const receipt = await readJson(receiptsRoot, receiptPath);
          if (receipt.requestHash !== requestHash) throw new Error('Request ID was already used with different content');
          if (receipt.status !== 'complete') return { id, ok: false, uncertain: true, error: 'Prior Git operation outcome is uncertain. Inspect its receipt and repository; do not replay it.' };
          return receipt.response;
        }
        operationClaimed = true;
        try { await handle.writeFile(JSON.stringify({ id, requestHash, request, status: 'started', startedAt: new Date().toISOString(), pid: process.pid })); await handle.sync(); }
        finally { await handle.close(); }
        let outcome;
        try { outcome = { id, ok: true, result: await operations.perform(request) }; }
        catch (error) { outcome = { id, ok: false, error: error.message, ...(error.uncertain ? { uncertain: true } : {}), ...(error.mergeConflict ? { conflict: error.mergeConflict } : {}) }; }
        await atomicJson(receiptsRoot, receiptPath, { id, requestHash, request, status: outcome.uncertain ? 'uncertain' : 'complete', response: outcome, finishedAt: new Date().toISOString() });
        return outcome;
      });
    } catch (error) { response = { id, ok: false, error: error.message, ...(operationClaimed ? { uncertain: true } : {}) }; }
    await respond(id, { ...response, requestHash });
    if (response.uncertain) {
      admitting = false;
      await atomicJson(channelPath, activePath, { sessionId, active: false, pid: process.pid, recoveryRequired: true });
    }
  }

  async function drain() {
    const requestsPath = await assertSafePath(channelPath, path.join(channelPath, 'requests'));
    for (const file of (await fs.readdir(requestsPath)).sort()) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!validId(id)) continue;
      await processRequest(id);
    }
  }
  const tick = () => {
    if (running || !admitting) return;
    running = drain().catch(error => { fatalError = error; admitting = false; }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 40);
  return {
    descriptor,
    close() {
      if (closePromise) return closePromise;
      stopAdmission(); clearInterval(timer); signal?.removeEventListener('abort', stopAdmission);
      closePromise = (async () => {
        await atomicJson(channelPath, activePath, { sessionId, active: false, pid: process.pid });
        await running;
        // Queued requests receive a terminal refusal after the in-flight mutation settles.
        await drain();
        if (fatalError) throw fatalError;
      })();
      return closePromise;
    },
  };
}
