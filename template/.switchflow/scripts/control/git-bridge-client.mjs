import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafePath, digest, stable } from '../operations/storage.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function requestGitBridge(channelPath, request, { timeoutMs = 120000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid bridge timeout');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Git bridge request must be an object');
  const id = request.id ?? randomUUID();
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid Git bridge request ID');
  const activePath = await assertSafePath(channelPath, path.join(channelPath, 'active.json'));
  const active = JSON.parse(await fs.readFile(activePath, 'utf8'));
  if (!active.active) throw new Error('Git bridge is closed');
  const data = JSON.stringify({ sessionId: active.sessionId, request: { ...request, id } });
  const requestHash = digest(stable({ ...request, id }));
  if (Buffer.byteLength(data) > 128 * 1024) throw new Error('Git bridge request exceeds limit');
  const incoming = await assertSafePath(channelPath, path.join(channelPath, 'requests', `${id}.json`));
  const temporary = `${incoming}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { flag: 'wx' });
  await fs.rename(temporary, incoming);
  const responsePath = path.join(channelPath, 'responses', `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertSafePath(channelPath, responsePath);
    try {
      if ((await fs.lstat(responsePath)).size > 128 * 1024) throw new Error('Git bridge response exceeds limit');
      const response = JSON.parse(await fs.readFile(responsePath, 'utf8'));
      if (response.id !== id) throw new Error('Git bridge response identity mismatch');
      if (response.requestHash === requestHash) return response;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(40);
  }
  throw new Error(`Git bridge response timed out for ${id}. The outcome may be uncertain; inspect the receipt before retrying and retain this request ID.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Input exceeds limit'); }
    const response = await requestGitBridge(process.argv[2], JSON.parse(input));
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (!response.ok) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
