import './git-test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startGitBridge } from '../template/.switchflow/scripts/control/git-bridge.mjs';
import { requestGitBridge } from '../template/.switchflow/scripts/control/git-bridge-client.mjs';
import { validateCapacityProfile } from '../template/.switchflow/scripts/control/capacity.mjs';
import {
  createDependencyStores,
  installedTreeMismatch,
  protect,
  removeStore,
} from '../template/.switchflow/scripts/control/dependencies.mjs';
import { digest, resolveProject } from '../template/.switchflow/scripts/operations/storage.mjs';

const windows = process.platform === 'win32';
const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const settings = { mode: 'link', paths: ['node_modules'], private: ['.prisma'] };
const packages = {
  '': { name: 'fixture', workspaces: ['packages/*'] },
  'node_modules/alpha': { version: '1.0.0', resolved: 'https://registry.invalid/alpha.tgz', integrity: 'sha512-a' },
  'node_modules/alpha/node_modules/beta': { version: '2.0.0', integrity: 'sha512-b' },
  'node_modules/@scope/gamma': { version: '1.0.0', integrity: 'sha512-g' },
  'node_modules/@scope/shared': { resolved: 'packages/shared', link: true },
  'packages/shared': { name: '@scope/shared', version: '0.0.0' },
  'node_modules/other-platform': { version: '1.0.0', optional: true },
};
const lockfile = JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages }, null, 2) + '\n';
const hidden = (changes = {}) => {
  const installed = { ...packages, ...changes };
  delete installed[''];
  delete installed['node_modules/other-platform'];
  return JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages: installed });
};

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
const symlink = (target, location) => fs.symlink(target, location, windows ? 'junction' : 'dir');

/** A primary checkout with an npm workspace, a nested package, a cache and generated code. */
async function primary(root) {
  await write(path.join(root, 'package-lock.json'), lockfile);
  await write(path.join(root, '.gitignore'), 'node_modules\n');
  await write(path.join(root, 'packages/shared/index.js'), "module.exports = 'shared';\n");
  const modules = path.join(root, 'node_modules');
  await write(path.join(modules, 'alpha/index.js'), "module.exports = require('beta');\n");
  await write(path.join(modules, 'alpha/node_modules/beta/index.js'), "module.exports = 'beta 2';\n");
  await write(path.join(modules, '@scope/gamma/index.js'), "module.exports = 'gamma';\n");
  await write(path.join(modules, '.bin/alpha'), '#!/bin/sh\n');
  await write(path.join(modules, '.cache/tool/entry'), 'cache');
  await write(path.join(modules, '.prisma/client/index.js'), 'generated');
  await write(path.join(modules, '.package-lock.json'), hidden());
  await symlink(path.join(root, 'packages/shared'), path.join(modules, '@scope/shared'));
}

async function storeDirectories(stateDir) {
  const root = path.join(stateDir, 'dependencies');
  return (await fs.readdir(root).catch(() => [])).map(name => path.join(root, name));
}
async function cleanup(base, stateDir) {
  for (const directory of await storeDirectories(stateDir)) await removeStore(directory).catch(() => {});
  await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('capacity.json validates the dependencies setting strictly', () => {
  assert.equal(validateCapacityProfile({ schemaVersion: 1 }).dependencies, undefined);
  assert.deepEqual(validateCapacityProfile({ schemaVersion: 1, dependencies: { mode: 'link' } }).dependencies, {
    mode: 'link',
    paths: ['node_modules'],
    private: [],
  });
  assert.deepEqual(
    validateCapacityProfile({
      schemaVersion: 1,
      dependencies: { mode: 'link', paths: ['node_modules', 'packages/web/node_modules'], private: ['.prisma'] },
    }).dependencies.paths,
    ['node_modules', 'packages/web/node_modules'],
  );
  for (const [dependencies, message] of [
    [{ mode: 'copy-on-match' }, /mode must be "link" or "off"/],
    [{ mode: 'link', extra: true }, /unsupported field dependencies.extra/],
    [{ mode: 'link', paths: ['packages/web/node_modules'] }, /including "node_modules"/],
    [{ mode: 'link', paths: ['node_modules', '../node_modules'] }, /paths must list/],
    [{ mode: 'link', paths: ['node_modules', 'vendor'] }, /paths must list/],
    [{ mode: 'link', private: ['../x'] }, /private must list/],
  ])
    assert.throws(() => validateCapacityProfile({ schemaVersion: 1, dependencies }), message);
});

test("the primary's install must match its lockfile, apart from other platforms' optional packages", () => {
  assert.equal(installedTreeMismatch(lockfile, hidden()), null);
  assert.match(
    installedTreeMismatch(lockfile, hidden({ 'node_modules/alpha': { version: '1.0.1' } })),
    /installed node_modules\/alpha differs/,
  );
  const missing = JSON.parse(hidden());
  delete missing.packages['node_modules/@scope/gamma'];
  assert.match(installedTreeMismatch(lockfile, JSON.stringify(missing)), /@scope\/gamma is in the lockfile but not/);
  assert.match(installedTreeMismatch('{"lockfileVersion":1}', hidden()), /no "packages" section/);
});

test('a candidate links a sealed copy of the primary dependencies that it cannot change', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-dependencies-'));
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  git(repo, ['init', '--initial-branch=main']);
  await primary(repo);
  git(repo, ['add', '--', 'package-lock.json', '.gitignore', 'packages']);
  git(repo, ['commit', '-m', 'fixture']);
  await write(
    path.join(repo, '.switchflow/capacity.json'),
    JSON.stringify({ schemaVersion: 1, dependencies: { mode: 'link', private: ['.prisma'] } }),
  );
  const context = await resolveProject(repo, { stateHome: path.join(base, 'state') });
  const runDirectory = path.join(context.stateDir, 'runs', randomUUID());
  await fs.mkdir(runDirectory, { recursive: true });
  const bridge = await startGitBridge({
    context,
    runDirectory,
    initiativeId: 'fixture',
    planHash: digest('approved plan'),
    baseHead: git(repo, ['rev-parse', 'HEAD']),
  });
  t.after(async () => {
    await bridge.close();
    await cleanup(base, context.stateDir);
  });
  const create = async name => {
    const response = await requestGitBridge(
      bridge.descriptor.channelPath,
      { operation: 'create', name },
      { timeoutMs: 60000 },
    );
    assert.equal(response.ok, true, response.error);
    return response.result;
  };

  const first = await create('one');
  assert.equal(first.dependencies.status, 'linked', first.dependencies.reason);
  const modules = path.join(first.path, 'node_modules');
  const store = path.join(context.stateDir, 'dependencies', first.dependencies.store);
  assert.ok((await fs.realpath(path.join(modules, 'alpha'))).startsWith(await fs.realpath(store)));
  // The worktree's own folder is real; caches start empty and generated code is its own copy.
  assert.equal((await fs.lstat(modules)).isSymbolicLink(), false);
  await assert.rejects(fs.lstat(path.join(modules, '.cache')), { code: 'ENOENT' });
  assert.equal((await fs.lstat(path.join(modules, '.prisma'))).isSymbolicLink(), false);
  await fs.appendFile(path.join(modules, '.prisma/client/index.js'), ' changed');
  await fs.mkdir(path.join(modules, '.vite'));
  // The workspace package resolves to the candidate's own source, not the primary's.
  assert.equal(
    await fs.realpath(path.join(modules, '@scope/shared')),
    await fs.realpath(path.join(first.path, 'packages/shared')),
  );
  assert.equal((await fs.lstat(path.join(modules, '@scope'))).isSymbolicLink(), false);
  assert.equal(
    execFileSync(process.execPath, ['-p', "require('alpha') + ' ' + require('@scope/shared')"], {
      cwd: first.path,
      encoding: 'utf8',
    }).trim(),
    'beta 2 shared',
  );

  // Writing, deleting, renaming and adding through the links are all refused.
  const refused = { code: /^(EPERM|EACCES)$/ };
  await assert.rejects(fs.appendFile(path.join(modules, 'alpha/index.js'), 'x'), refused);
  await assert.rejects(fs.unlink(path.join(modules, 'alpha/index.js')), refused);
  await assert.rejects(
    fs.rename(path.join(modules, 'alpha/node_modules/beta'), path.join(modules, 'alpha/x')),
    refused,
  );
  await assert.rejects(fs.writeFile(path.join(modules, 'alpha/new.js'), 'x'), refused);
  // POSIX lets a file's owner make it writable again; Windows' deny entry also covers attributes.
  if (windows) await assert.rejects(fs.chmod(path.join(modules, 'alpha/index.js'), 0o666), refused);

  // A second candidate reuses the store; removing a candidate's folder removes only links.
  const second = await create('two');
  assert.equal(second.dependencies.status, 'linked');
  assert.equal(second.dependencies.store, first.dependencies.store);
  await fs.rm(modules, { recursive: true, force: true });
  assert.equal(
    await fs.readFile(path.join(store, 'node_modules/alpha/index.js'), 'utf8'),
    "module.exports = require('beta');\n",
  );
  assert.equal(
    await fs.readFile(path.join(repo, 'node_modules/alpha/index.js'), 'utf8'),
    "module.exports = require('beta');\n",
  );
  assert.equal(await fs.readFile(path.join(repo, 'node_modules/.prisma/client/index.js'), 'utf8'), 'generated');
  const third = await create('three');
  assert.equal(third.dependencies.status, 'linked');
  assert.equal(third.dependencies.store, first.dependencies.store);
});

test('a worktree installs normally, with the reason, when nothing safe can be shared', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-dependencies-'));
  const stateDir = path.join(base, 'state');
  t.after(() => cleanup(base, stateDir));
  const repo = path.join(base, 'primary');
  await primary(repo);
  const stores = createDependencyStores({ stateDir }, { buildWaitMs: 60000 });
  let count = 0;
  const worktree = async (lock = lockfile) => {
    const directory = path.join(base, `worktree-${count++}`);
    await write(path.join(directory, 'packages/shared/index.js'), "module.exports = 'shared';\n");
    if (lock) await write(path.join(directory, 'package-lock.json'), lock.replace(/\n/g, '\r\n'));
    return directory;
  };
  const prepare = async directory => stores.prepare({ worktree: directory, primary: repo, settings });

  assert.match((await prepare(await worktree(null))).reason, /no package-lock.json/);
  const changed = lockfile.replace('"1.0.0"', '"1.0.9"');
  assert.match((await prepare(await worktree(changed))).reason, /lockfile differs from the primary/);
  const present = await worktree();
  await fs.mkdir(path.join(present, 'node_modules'));
  assert.equal((await prepare(present)).status, 'present');
  await write(
    path.join(repo, 'node_modules/.package-lock.json'),
    hidden({ 'node_modules/alpha': { version: '0.9.0' } }),
  );
  assert.match((await prepare(await worktree())).reason, /install is out of date: the installed node_modules\/alpha/);
  assert.deepEqual(await storeDirectories(stateDir), []);

  // A lockfile checked out with CRLF still matches; a link leaving the checkout refuses the store.
  await write(path.join(repo, 'node_modules/.package-lock.json'), hidden());
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await symlink(outside, path.join(repo, 'node_modules/escape'));
  assert.match((await prepare(await worktree())).reason, /node_modules\/escape links outside the checkout/);
  await fs.rm(path.join(repo, 'node_modules/escape'), { recursive: true });
  const linked = await prepare(await worktree());
  assert.equal(linked.status, 'linked', linked.reason);
});

test('a store changed after sealing is never used again and is made afresh', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-dependencies-'));
  const stateDir = path.join(base, 'state');
  t.after(() => cleanup(base, stateDir));
  const repo = path.join(base, 'primary');
  await primary(repo);
  const stores = createDependencyStores({ stateDir }, { buildWaitMs: 60000 });
  const prepare = async name => {
    const directory = path.join(base, name);
    await write(path.join(directory, 'package-lock.json'), lockfile);
    return stores.prepare({ worktree: directory, primary: repo, settings });
  };
  const first = await prepare('one');
  assert.equal(first.status, 'linked', first.reason);
  // Simulate a tool that got past the protection and added a package folder.
  const folder = path.join(stateDir, 'dependencies', first.store, 'node_modules');
  if (windows) await protect(folder, false);
  else await fs.chmod(folder, 0o755);
  await fs.mkdir(path.join(folder, 'intruder'));
  const second = await prepare('two');
  assert.equal(second.status, 'linked', second.reason);
  assert.notEqual(second.store, first.store);
  // The damaged store stays while the first worktree links it.
  assert.equal((await storeDirectories(stateDir)).length, 2);
});
