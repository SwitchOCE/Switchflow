import './git-test-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// backlog.mjs, the Node port of backlog.ps1, runs on every platform: these mirror the routing cases
// of governance-routing.test.mjs for a template install and a plugin install.
const source = resolve('template/.switchflow/scripts');
const launcher = resolve('plugin/bin/switchflow-backlog');
const run = (cmd, args, cwd, env = {}) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, SWITCHFLOW_BACKLOG_PACKAGE: '', ...env },
  });
const ok = r => {
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
};

// The stub CLI records where and how it ran, in the cwd's backlog folder.
const stubCli = `const fs=require('fs');if(process.argv.includes('--version')){console.log('1.50.1');process.exit(0)}fs.writeFileSync('backlog/last-call.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));console.log(process.cwd());`;
// Helper scripts record their argv, and the content of a trailing input file.
const helper = name =>
  `import fs from 'node:fs';const args=process.argv.slice(2);let content=null;try{content=fs.readFileSync(args.at(-1),'utf8')}catch{}fs.writeFileSync('backlog/helper-call.json',JSON.stringify({script:${JSON.stringify(name)},cwd:process.cwd(),args,content}));`;
const HELPERS = [
  'update-document.mjs',
  'milestone-scope.mjs',
  'flow.mjs',
  'review-outcomes.mjs',
  'check-milestone-progress.mjs',
  'check-ready-dependencies.mjs',
];

/** Service files backlog.mjs needs, with stubbed helpers and a fork resolver pointing at cli. */
function installService(directory, cli) {
  mkdirSync(join(directory, 'control'), { recursive: true });
  mkdirSync(join(directory, 'backlog-fork'), { recursive: true });
  for (const file of ['backlog.mjs', 'cli-output.mjs', 'control/tool-root.mjs'])
    cpSync(join(source, file), join(directory, file));
  for (const file of HELPERS) writeFileSync(join(directory, file), helper(file));
  writeFileSync(join(directory, 'backlog-fork/resolve.mjs'), `console.log(${JSON.stringify(cli)})`);
}

function fixture(mode, fn) {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-wrapper-')),
    primary = join(root, 'primary'),
    linked = join(root, 'candidate');
  mkdirSync(join(primary, '.switchflow'), { recursive: true });
  mkdirSync(join(primary, 'backlog/tasks'), { recursive: true });
  writeFileSync(join(primary, 'backlog.config.yml'), 'project_name: Wrapper fixture\n');
  writeFileSync(
    join(primary, '.switchflow/project.json'),
    JSON.stringify({
      schemaVersion: 1,
      templateVersion: '0.5.0',
      taskPrefix: 'TEST',
      ...(mode === 'plugin' ? { install: 'plugin' } : {}),
    }),
  );
  let command, packageDir;
  if (mode === 'plugin') {
    // The generated plugin layout: service/, bin/ and node_modules/backlog.md, outside the project.
    const plugin = join(root, 'plugin');
    packageDir = join(plugin, 'node_modules/backlog.md');
    installService(join(plugin, 'service'), join(packageDir, 'cli.js'));
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    cpSync(launcher, join(plugin, 'bin/switchflow-backlog'));
    command = [join(plugin, 'bin/switchflow-backlog')];
  } else {
    const scripts = join(primary, '.switchflow/scripts');
    packageDir = join(primary, '.switchflow/node_modules/backlog.md');
    installService(scripts, join(packageDir, 'cli.js'));
    cpSync(join(source, 'backlog.ps1'), join(scripts, 'backlog.ps1'));
    writeFileSync(
      join(primary, '.switchflow/package.json'),
      JSON.stringify({ devDependencies: { 'backlog.md': '1.50.1' } }),
    );
    writeFileSync(join(primary, '.gitignore'), 'node_modules/\n');
    command = [join(linked, '.switchflow/scripts/backlog.mjs')];
  }
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), '{"version":"1.50.1"}');
  writeFileSync(join(packageDir, 'cli.js'), stubCli);
  ok(run('git', ['init', primary], root));
  ok(run('git', ['-C', primary, 'add', '.'], root));
  ok(run('git', ['-C', primary, 'commit', '-m', 'Fixture'], root));
  ok(run('git', ['-C', primary, 'worktree', 'add', '-b', 'candidate', linked], root));
  mkdirSync(join(linked, 'src/deep'), { recursive: true });
  const wrapper = (args, cwd = linked, env) => run(process.execPath, [...command, ...args], cwd, env);
  try {
    fn({ root, primary, linked, wrapper, packageDir });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'switchflow-wrapper-')));
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ['template', 'plugin']) {
  test(`${mode}: linked worktree commands, MCP and the native board use primary governance`, () =>
    fixture(mode, ({ primary, linked, wrapper }) => {
      for (const args of [
        ['task', 'edit', 'T-1', '--title', 'Changed'],
        ['task', 'view', 'T-1'],
        ['mcp', 'start'],
        ['browser-native', '--port', '6428'],
        ['milestone', 'edit', 'm-1', '--labels', 'ship'],
      ]) {
        ok(wrapper(args, join(linked, 'src/deep')));
        const observed = JSON.parse(readFileSync(join(primary, 'backlog/last-call.json'), 'utf8'));
        assert.equal(observed.cwd, primary);
        assert.deepEqual(observed.args, args[0] === 'browser-native' ? ['browser', ...args.slice(1)] : args);
      }
      assert.throws(() => readFileSync(join(linked, 'backlog/last-call.json')), { code: 'ENOENT' });
    }));

  test(`${mode}: content paths resolve in the caller's cwd and helpers run in primary governance`, () =>
    fixture(mode, ({ primary, linked, wrapper }) => {
      for (const [args, script] of [
        [['doc', 'update', 'doc-01', '--content-file'], 'update-document.mjs'],
        [['task', 'edit', 'T-1', '--description-file'], 'update-document.mjs'],
        [['milestone', 'edit', 'm-0', '--input-file'], 'milestone-scope.mjs'],
      ]) {
        const content =
          args[0] === 'milestone'
            ? JSON.stringify({ reason: 'Scope change', approval: 'Owner accepted' })
            : 'Exact candidate input';
        writeFileSync(join(linked, 'input with spaces.txt'), content);
        ok(wrapper([...args, 'input with spaces.txt']));
        const observed = JSON.parse(readFileSync(join(primary, 'backlog/helper-call.json'), 'utf8'));
        assert.equal(observed.script, script);
        assert.equal(observed.cwd, primary);
        assert.equal(observed.content, content);
        assert.equal(observed.args.at(-1), join(linked, 'input with spaces.txt'));
        assert.ok(observed.args.includes(primary));
      }
      // Plain milestone metadata goes to the CAS editor, --json and all.
      writeFileSync(join(linked, 'metadata.json'), JSON.stringify({ labels: ['ship'] }));
      ok(wrapper(['milestone', 'edit', 'm-0', '--input-file', 'metadata.json', '--json']));
      assert.deepEqual(JSON.parse(readFileSync(join(primary, 'backlog/last-call.json'), 'utf8')).args, [
        'milestone',
        'edit',
        'm-0',
        '--input-file',
        join(linked, 'metadata.json'),
        '--json',
      ]);
      const usage = wrapper(['doc', 'update', 'doc-01', '--content-file', 'a', 'b']);
      assert.notEqual(usage.status, 0);
      assert.match(usage.stderr, /Usage: backlog\.mjs doc update/);
      for (const [args, script] of [
        [['flow', 'status'], 'flow.mjs'],
        [['reviews', 'list'], 'review-outcomes.mjs'],
        [['milestone', 'list'], 'check-milestone-progress.mjs'],
      ]) {
        ok(wrapper(args));
        const observed = JSON.parse(readFileSync(join(primary, 'backlog/helper-call.json'), 'utf8'));
        assert.equal(observed.script, script);
        assert.equal(observed.args.at(-1), args.at(-1));
      }
    }));

  test(`${mode}: doctor runs the Ready dependency check after the CLI`, () =>
    fixture(mode, ({ primary, wrapper, packageDir }) => {
      ok(wrapper(['doctor']));
      assert.deepEqual(JSON.parse(readFileSync(join(primary, 'backlog/last-call.json'), 'utf8')).args, ['doctor']);
      const observed = JSON.parse(readFileSync(join(primary, 'backlog/helper-call.json'), 'utf8'));
      assert.equal(observed.script, 'check-ready-dependencies.mjs');
      assert.deepEqual(observed.args, [join(packageDir, 'cli.js'), primary]);
    }));

  test(`${mode}: missing primary governance fails closed`, () =>
    fixture(mode, ({ primary, linked, wrapper }) => {
      renameSync(join(primary, 'backlog.config.yml'), join(primary, 'backlog.config.unavailable'));
      const result = wrapper(['task', 'list']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Canonical governance is unavailable/);
      assert.throws(() => readFileSync(join(linked, 'backlog/last-call.json')), { code: 'ENOENT' });
    }));

  test(`${mode}: a missing fork permits reads but rejects mutations and MCP`, () =>
    fixture(mode, ({ root, primary, wrapper }) => {
      const resolver =
        mode === 'plugin'
          ? join(root, 'plugin/service/backlog-fork/resolve.mjs')
          : join(primary, '.switchflow/scripts/backlog-fork/resolve.mjs');
      rmSync(resolver);
      ok(wrapper(['task', 'list']));
      assert.equal(JSON.parse(readFileSync(join(primary, 'backlog/last-call.json'), 'utf8')).cwd, primary);
      for (const args of [
        ['task', 'edit', 'TEST-1', '--title', 'Unsafe'],
        ['mcp', 'start'],
        ['doc', 'create', 'New'],
      ]) {
        const result = wrapper(args);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /verified Switchflow Backlog fork is required/);
      }
    }));
}

test(
  'the plugin launcher runs as an executable from Git Bash style shells',
  { skip: process.platform === 'win32' },
  () =>
    fixture('plugin', ({ root, primary, linked }) => {
      const bin = join(root, 'plugin/bin');
      chmodSync(join(bin, 'switchflow-backlog'), 0o755);
      const result = spawnSync('sh', ['-c', 'switchflow-backlog task view T-9'], {
        cwd: linked,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(primary, 'backlog/last-call.json'), 'utf8')).args, [
        'task',
        'view',
        'T-9',
      ]);
    }),
);

test('a plugin install refuses the Backlog package when the plugin is missing it', () =>
  fixture('plugin', ({ root, wrapper, packageDir }) => {
    rmSync(join(root, 'plugin/service/backlog-fork/resolve.mjs'));
    rmSync(join(packageDir, 'cli.js'));
    const result = wrapper(['task', 'list']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plugin's Backlog package is unavailable/);
  }));
