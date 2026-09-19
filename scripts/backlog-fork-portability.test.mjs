import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { directory, forkIdentity, resolveBacklogFork, sha256 } from '../template/.switchflow/scripts/backlog-fork/runtime.mjs';

const inputs = ['manifest.json', 'backlog-cas.patch', 'runtime.mjs', 'setup.mjs'];

test('LF and CRLF checkouts share the runtime and setup applies only normalized patch transport', async () => {
  const runtime = await resolveBacklogFork();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-fork-portability-'));
  try {
    const copied = {};
    for (const format of ['lf', 'crlf']) {
      const target = path.join(scratch, format); await fs.mkdir(target);
      for (const file of inputs) {
        const lf = (await fs.readFile(path.join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
        await fs.writeFile(path.join(target, file), format === 'crlf' ? lf.replaceAll('\n', '\r\n') : lf);
      }
      copied[format] = await import(pathToFileURL(path.join(target, 'runtime.mjs')));
      assert.equal(await copied[format].forkIdentity(), await forkIdentity());
      assert.equal((await copied[format].resolveBacklogFork()).executable, runtime.executable);
    }
    const source = path.join(scratch, 'source'); await fs.mkdir(source);
    const archive = path.join(runtime.root, 'source.tar.gz');
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(sha256(await fs.readFile(archive)), manifest.source.sha256, 'archive integrity uses original bytes');
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '--exclude=*/.claude/skills', '--exclude=*/CLAUDE.md', '--exclude=*/src/guidelines/project-manager-backlog.md', '-C', source], { windowsHide: true });
    // This file is written by real setup, not synthesized by the test.
    const installedPatch = path.join(runtime.root, 'backlog-cas.patch');
    const patchBytes = await fs.readFile(installedPatch);
    assert.equal(patchBytes.toString('utf8'), (await fs.readFile(path.join(scratch, 'crlf', 'backlog-cas.patch'), 'utf8')).replaceAll('\r\n', '\n'));
    execFileSync('git', ['apply', '--check', installedPatch], { cwd: source, windowsHide: true });
    execFileSync('git', ['apply', installedPatch], { cwd: source, windowsHide: true });
    assert.match(await fs.readFile(path.join(source, 'src/core/backlog.ts'), 'utf8'), /REVISION_CONFLICT/);
    assert.notEqual(sha256(Buffer.from('a\r\nb')), sha256(Buffer.from('a\nb')), 'binary hashes never normalize line endings');
  } finally {
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
