import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capturesToFile, execCli, execCliSync, spawnCliSync } from '../template/.switchflow/scripts/cli-output.mjs';

// The file path is what Linux and macOS take (SF-28); forcing it here runs it on any platform.
const files = { platform: 'linux' };
const wrapper = fileURLToPath(new URL('../template/.switchflow/scripts/cli-output.mjs', import.meta.url));
const big = 'x'.repeat(1024 * 1024);

async function stub(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-cli-output-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'cli.cjs');
  // Writes N KiB to stdout, a line to stderr, and exits with the given code; or hangs.
  await fs.writeFile(
    script,
    `const [kib, code] = process.argv.slice(2).map(Number);
if (kib < 0) setInterval(() => {}, 1000);
else {
  process.stdout.write('x'.repeat(kib * 1024));
  process.stderr.write('note\\n');
  process.exitCode = code;
}
`,
  );
  return script;
}

test('only Windows keeps the pipes', () => {
  assert.equal(capturesToFile('win32'), false);
  assert.equal(capturesToFile('linux'), true);
  assert.equal(capturesToFile('darwin'), true);
});

test('spawnCliSync and execCliSync return the complete output through files', async t => {
  const cli = await stub(t);
  const result = spawnCliSync(process.execPath, [cli, '1024', '3'], { encoding: 'utf8', maxBuffer: 4 << 20 }, files);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, big);
  assert.equal(result.stderr, 'note\n');
  assert.equal(result.error, undefined);
  const buffers = spawnCliSync(process.execPath, [cli, '1', '0'], {}, files);
  assert.ok(Buffer.isBuffer(buffers.stdout));
  assert.equal(spawnCliSync(process.execPath, [cli, '1100', '0'], { encoding: 'utf8' }, files).error.code, 'ENOBUFS');

  assert.equal(
    execCliSync(process.execPath, [cli, '1024', '0'], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 4 << 20 }, files),
    big,
  );
  assert.throws(
    () => execCliSync(process.execPath, [cli, '1', '2'], { encoding: 'utf8', stdio: 'pipe' }, files),
    error => error.status === 2 && error.stdout === 'x'.repeat(1024) && error.stderr === 'note\n',
  );
  // The temporary files are gone.
  const left = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('switchflow-cli-'));
  assert.deepEqual(
    left.filter(name => !name.startsWith('switchflow-cli-output-')),
    [],
  );
});

test('execCli matches promisified execFile through files', async t => {
  const cli = await stub(t);
  const { stdout, stderr } = await execCli(process.execPath, [cli, '1024', '0'], { maxBuffer: 4 << 20 }, files);
  assert.equal(stdout, big);
  assert.equal(stderr, 'note\n');
  await assert.rejects(
    execCli(process.execPath, [cli, '2', '5'], {}, files),
    error => error.code === 5 && error.stdout === 'x'.repeat(2048) && /Command failed/.test(error.message),
  );
  await assert.rejects(execCli(process.execPath, [cli, '1100', '0'], {}, files), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
  await assert.rejects(execCli(process.execPath, [cli, '-1', '0'], { timeout: 300 }, files), error => error.killed);
  await assert.rejects(execCli(path.join(os.tmpdir(), 'switchflow-missing-cli'), [], {}, files), { code: 'ENOENT' });
});

test('the backlog.ps1 wrapper passes the complete output, stderr and exit code through', async t => {
  const cli = await stub(t);
  const result = spawnSync(process.execPath, [wrapper, cli, '2048', '4'], { encoding: 'utf8', maxBuffer: 8 << 20 });
  assert.equal(result.status, 4);
  assert.equal(result.stdout.length, 2048 * 1024);
  assert.equal(result.stderr, 'note\n');
});
