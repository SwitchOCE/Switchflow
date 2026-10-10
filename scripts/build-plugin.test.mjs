import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, diffBuild, main } from './build-plugin.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async (...parts) => JSON.parse(await fs.readFile(path.join(root, ...parts), 'utf8'));

async function fixture(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-build-plugin-'));
  const write = async (relative, content) => {
    await fs.mkdir(path.dirname(path.join(base, relative)), { recursive: true });
    await fs.writeFile(path.join(base, relative), content);
  };
  try {
    for (const file of [
      'template/.switchflow/scripts/control/server.mjs',
      'template/.switchflow/scripts/operations/storage.mjs',
      'template/.switchflow/scripts/node_modules/dep/index.js',
      'template/.switchflow/node_modules/backlog.md/cli.js',
      'template/.switchflow/package.json',
      'template/.switchflow/package-lock.json',
      'template/.switchflow/friction/README.md',
      'template/.agents/skills/intake/SKILL.md',
      'template/.github/workflows/switchflow.yml',
      'template/Start Switchflow.cmd',
      'template/AGENTS.md',
      'template/backlog.config.yml',
      'template/backlog/tasks/.gitkeep',
    ])
      await write(file, `${file}\n`);
    await run({ base, write });
  } finally {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true });
  }
}

const listing = async directory => {
  const files = [];
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      files.push(path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  return files.sort();
};

test('the committed plugin output matches the template', () => {
  const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'build-plugin.mjs'), '--check'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(output, /up to date/);
});

test('build maps the template into service and project-template, then check finds every difference', () =>
  fixture(async ({ base, write }) => {
    await build(base);
    assert.deepEqual(await listing(path.join(base, 'plugin', 'service')), [
      'control/server.mjs',
      'operations/storage.mjs',
      'workflow-skills/intake/SKILL.md',
    ]);
    assert.deepEqual(await listing(path.join(base, 'plugin', 'project-template')), [
      '.switchflow/friction/README.md',
      'AGENTS.md',
      'backlog.config.yml',
      'backlog/tasks/.gitkeep',
    ]);
    assert.equal(
      await fs.readFile(path.join(base, 'plugin', 'service', 'control', 'server.mjs'), 'utf8'),
      'template/.switchflow/scripts/control/server.mjs\n',
    );
    assert.deepEqual(await diffBuild(base), []);
    assert.equal(await main(['--check'], base), 0);

    await write('template/.switchflow/scripts/control/server.mjs', 'changed\n');
    await write('template/.agents/skills/review/SKILL.md', 'new\n');
    await write('plugin/service/old/removed.mjs', 'stale\n');
    await fs.rm(path.join(base, 'template', 'AGENTS.md'));
    assert.deepEqual(await diffBuild(base), [
      { kind: 'stale', file: 'plugin/project-template/AGENTS.md' },
      { kind: 'changed', file: 'plugin/service/control/server.mjs' },
      { kind: 'stale', file: 'plugin/service/old/removed.mjs' },
      { kind: 'missing', file: 'plugin/service/workflow-skills/review/SKILL.md' },
    ]);
    const log = console.log;
    const lines = [];
    console.log = line => lines.push(line);
    try {
      assert.equal(await main(['--check'], base), 1);
    } finally {
      console.log = log;
    }
    assert.ok(lines.includes('changed: plugin/service/control/server.mjs'));
    assert.ok(lines.includes('stale: plugin/service/old/removed.mjs'));

    await build(base);
    assert.deepEqual(await diffBuild(base), []);
    await assert.rejects(fs.stat(path.join(base, 'plugin', 'service', 'old')), { code: 'ENOENT' });
    const first = await listing(path.join(base, 'plugin'));
    assert.equal((await build(base)).length, 0);
    assert.deepEqual(await listing(path.join(base, 'plugin')), first);
    await assert.rejects(main(['--force'], base), /Usage/);
  }));

test('plugin manifests, hook and dependency pin agree with the template', async () => {
  const marketplace = await readJson('.claude-plugin', 'marketplace.json');
  assert.equal(marketplace.name, 'switchflow');
  assert.deepEqual(marketplace.owner, { name: 'SwitchOCE' });
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: 'switchflow', source: './plugin' }],
  );
  const manifest = await readJson('plugin', '.claude-plugin', 'plugin.json');
  assert.equal(manifest.name, 'switchflow');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);

  const pinned = (await readJson('template', '.switchflow', 'package.json')).devDependencies['backlog.md'];
  const pkg = await readJson('plugin', 'package.json');
  assert.deepEqual(pkg.dependencies, { 'backlog.md': pinned });
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.overrides, undefined);
  const lock = await readJson('plugin', 'package-lock.json');
  assert.ok([2, 3].includes(lock.lockfileVersion));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.equal(lock.packages['node_modules/backlog.md'].version, pinned);
  // Plugin installs run npm without lifecycle scripts; the platform binary is a plain optional package.
  for (const platform of ['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64']) {
    const entry = lock.packages[`node_modules/backlog.md-${platform}`];
    assert.equal(entry?.version, pinned, platform);
    assert.equal(entry.optional, true);
    assert.match(entry.resolved, /^https:\/\//);
    assert.ok(!entry.hasInstallScript);
  }
  assert.ok(!lock.packages['node_modules/backlog.md'].hasInstallScript);

  const hooks = await readJson('plugin', 'hooks', 'hooks.json');
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart']);
  const [group] = hooks.hooks.SessionStart;
  assert.equal(group.hooks.length, 1);
  const [hook] = group.hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, [
    '${CLAUDE_PLUGIN_ROOT}/service/control/launch.mjs',
    '--data',
    '${CLAUDE_PLUGIN_DATA}',
    '--project',
    '${CLAUDE_PROJECT_DIR}',
    '--upgrade-if-idle',
  ]);
  assert.ok(hook.timeout > 0 && hook.timeout <= 120);
  await fs.access(path.join(root, 'plugin', 'service', 'control', 'launch.mjs'));
});
