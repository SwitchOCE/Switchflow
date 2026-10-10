import './git-test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readToolRoot,
  resolveToolRoot,
  serviceDir,
  withToolPath,
  workerBacklogCommand,
} from '../template/.switchflow/scripts/control/tool-root.mjs';
import { canonicalProject } from '../template/.switchflow/scripts/control/projects.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import { findBacklog } from '../template/.switchflow/scripts/control/backlog-adapter.mjs';
import { listSkills } from '../template/.switchflow/scripts/control/skills.mjs';
import { bashAllowlist, claudeArguments } from '../template/.switchflow/scripts/control/providers/claude-cli.mjs';
import { workerPrompt } from '../template/.switchflow/scripts/control/orchestration.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });

test('template mode keeps the project paths it always used', () => {
  const root = path.resolve('fixture-project');
  const tools = resolveToolRoot(root, {}, { platform: 'win32' });
  assert.deepEqual(tools, resolveToolRoot(root, { install: 'template' }, { platform: 'win32' }));
  assert.equal(tools.mode, 'template');
  assert.equal(tools.scriptsDir, path.join(root, '.switchflow', 'scripts'));
  assert.equal(tools.backlogPackageDir, path.join(root, '.switchflow', 'node_modules', 'backlog.md'));
  assert.equal(tools.checkReadyScript, path.join(root, '.switchflow', 'scripts', 'check-ready-dependencies.mjs'));
  assert.equal(tools.workflowSkillsDir, path.join(root, '.agents', 'skills'));
  assert.equal(tools.binDir, null);
  assert.deepEqual(tools.backlogCommand, [
    'powershell.exe',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, '.switchflow', 'scripts', 'backlog.ps1'),
  ]);
  assert.equal(resolveToolRoot(root, {}, { platform: 'linux' }).backlogCommand[0], 'pwsh');
  assert.equal(workerBacklogCommand(tools), '.switchflow/scripts/backlog.ps1');
});

test('plugin mode resolves from the service code, never the project', () => {
  const root = path.resolve('fixture-project');
  const tools = resolveToolRoot(root, { install: 'plugin' }, { env: {} });
  assert.equal(tools.mode, 'plugin');
  assert.equal(tools.scriptsDir, serviceDir);
  assert.equal(tools.checkReadyScript, path.join(serviceDir, 'check-ready-dependencies.mjs'));
  assert.equal(tools.workflowSkillsDir, path.join(serviceDir, 'workflow-skills'));
  assert.equal(tools.binDir, path.join(path.dirname(serviceDir), 'bin'));
  assert.deepEqual(tools.backlogCommand, [process.execPath, path.join(serviceDir, 'backlog.mjs')]);
  for (const value of [tools.scriptsDir, tools.backlogPackageDir, tools.workflowSkillsDir])
    assert.ok(!value.startsWith(root + path.sep), value);
  const override = path.resolve('elsewhere', 'backlog.md');
  assert.equal(
    resolveToolRoot(root, { install: 'plugin' }, { env: { SWITCHFLOW_BACKLOG_PACKAGE: override } }).backlogPackageDir,
    override,
  );
  assert.equal(workerBacklogCommand(tools), 'switchflow-backlog');
  assert.throws(() => resolveToolRoot(root, { install: 'global' }), /Unsupported install "global"/);
});

test('the plugin bin folder goes first on PATH, whatever case Windows gave it', () => {
  assert.deepEqual(withToolPath({ PATH: '/usr/bin' }, '/plugin/bin', 'linux'), { PATH: '/plugin/bin:/usr/bin' });
  assert.deepEqual(withToolPath({ Path: 'C:\\Windows' }, 'C:\\plugin\\bin', 'win32'), {
    Path: 'C:\\plugin\\bin;C:\\Windows',
  });
  assert.deepEqual(withToolPath({}, '/plugin/bin', 'linux'), { PATH: '/plugin/bin' });
  const env = { PATH: '/usr/bin' };
  assert.equal(withToolPath(env, null), env);
});

test('workers get switchflow-backlog in plugin mode and backlog.ps1 in template mode', () => {
  const plugin = resolveToolRoot(path.resolve('p'), { install: 'plugin' });
  const script = plugin.backlogScript.replaceAll('\\', '/');
  const writer = bashAllowlist({ write: true, gitHelperPath: path.resolve('helper.mjs'), toolRoot: plugin });
  assert.ok(writer.includes('Bash(switchflow-backlog *)'));
  assert.ok(writer.includes(`Bash(node ${script} *)`));
  assert.ok(writer.includes(`Bash(node ${plugin.scriptsDir.replaceAll('\\', '/')}/*)`));
  // No project-relative wrappers: a plugin project has no scripts of its own.
  assert.ok(!writer.some(rule => / \.?\/?\.switchflow\/scripts/.test(rule) || /powershell|pwsh/.test(rule)));
  const reader = bashAllowlist({ write: false, toolRoot: plugin });
  assert.ok(reader.includes('Bash(switchflow-backlog task view *)'));
  assert.ok(reader.includes(`Bash(node ${script} doc view *)`));
  assert.ok(!reader.some(rule => /switchflow-backlog(?! (task|doc) view)/.test(rule)));
  assert.ok(!reader.some(rule => / \.?\/?\.switchflow\/scripts/.test(rule) || rule.endsWith('/*)')));
  // Template mode: exactly the rules it always had.
  const template = resolveToolRoot(path.resolve('p'), {});
  for (const toolRoot of [undefined, template]) {
    const rules = bashAllowlist({ write: false, toolRoot });
    assert.ok(
      rules.includes(
        'Bash(powershell -NoProfile -ExecutionPolicy Bypass -File .switchflow/scripts/backlog.ps1 task view *)',
      ),
    );
    assert.ok(!rules.some(rule => rule.includes('switchflow-backlog')));
    assert.ok(bashAllowlist({ write: true, toolRoot }).includes('Bash(node .switchflow/scripts/*)'));
  }
  const args = claudeArguments({
    sessionId: '00000000-0000-4000-8000-000000000000',
    sandbox: 'read-only',
    temporaryRoot: path.resolve('tmp'),
    maxTurns: 5,
    toolRoot: plugin,
  });
  assert.ok(args.includes('Bash(switchflow-backlog task view *)'));
});

test('worker instructions name the Backlog command of the install', () => {
  const common = {
    kind: 'review',
    task: 'T-1',
    worktree: '/w',
    candidate: 'c',
    governanceRoot: '/g',
    gitBridge: {},
    instructions: 'Review.',
  };
  assert.match(workerPrompt(common), /use \.switchflow\/scripts\/backlog\.ps1 for task records/);
  assert.match(
    workerPrompt({ ...common, backlogCommand: workerBacklogCommand({ mode: 'plugin' }) }),
    /use switchflow-backlog for task records/,
  );
});

async function pluginProjects(run) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-plugin-projects-'));
  const previous = { ...process.env };
  process.env.SWITCHFLOW_BACKLOG_CACHE = path.join(base, 'no-fork');
  process.env.SWITCHFLOW_BACKLOG_PACKAGE = path.join(base, 'plugin', 'node_modules', 'backlog.md');
  try {
    await fs.mkdir(process.env.SWITCHFLOW_BACKLOG_PACKAGE, { recursive: true });
    await fs.writeFile(path.join(process.env.SWITCHFLOW_BACKLOG_PACKAGE, 'package.json'), '{"version":"1.50.1"}');
    await fs.writeFile(path.join(process.env.SWITCHFLOW_BACKLOG_PACKAGE, 'cli.js'), '');
    const roots = [];
    for (const name of ['Plugged', 'Second']) {
      const root = path.join(base, name);
      roots.push(root);
      await fs.mkdir(path.join(root, '.switchflow'), { recursive: true });
      await fs.mkdir(path.join(root, 'backlog', 'tasks'), { recursive: true });
      await fs.writeFile(
        path.join(root, '.switchflow', 'project.json'),
        JSON.stringify({ projectName: name, schemaVersion: 1, templateVersion: '0.5.0', install: 'plugin' }),
      );
      await fs.writeFile(path.join(root, 'backlog.config.yml'), `project_name: ${name}\n`);
      // A stray project skill must not stand in for the plugin's.
      await fs.mkdir(path.join(root, '.agents', 'skills', 'intake'), { recursive: true });
      await fs.writeFile(path.join(root, '.agents', 'skills', 'intake', 'SKILL.md'), '# Stray\n');
      git(root, 'init', '-b', 'main');
      git(root, 'add', '--', '.');
      git(root, 'commit', '-m', 'Plugin project');
    }
    await run({ base, roots, shared: { stateDir: path.join(base, 'state', 'control-service') } });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('a plugin-mode project with no .switchflow/scripts registers on the shared service', () =>
  pluginProjects(async ({ roots, shared }) => {
    const contexts = await Promise.all(roots.map(root => canonicalProject(root, shared)));
    for (const root of roots)
      await assert.rejects(fs.access(path.join(root, '.switchflow', 'scripts')), { code: 'ENOENT' });
    assert.equal((await readToolRoot(roots[0])).mode, 'plugin');
    assert.equal(await findBacklog(contexts[0]), path.join(process.env.SWITCHFLOW_BACKLOG_PACKAGE, 'cli.js'));
    const { skills, warnings } = await listSkills(contexts[0]);
    assert.ok(!skills.some(skill => skill.title === 'Stray'));
    assert.ok(skills.every(skill => skill.path.startsWith('workflow-skills/')));
    if (!skills.length) assert.ok(warnings.length);
    const adapter = { list: async () => [], view: async () => null };
    const app = await createControlServer({
      context: contexts[0],
      capabilities: { codex: false },
      backlogFactory: () => adapter,
      nativeFactory: () => ({ request: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), close() {} }),
      runner: async () => {
        throw new Error('No real agent in fixture');
      },
    });
    try {
      const registry = await (await fetch(app.url + '/api/projects')).json();
      const response = await fetch(app.url + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': registry.csrfToken },
        body: JSON.stringify({ projectRoot: roots[1] }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal((await response.json()).project.id, contexts[1].id);
    } finally {
      await app.close();
    }
  }));

test('an unknown install mode is refused at registration', () =>
  pluginProjects(async ({ roots, shared }) => {
    const file = path.join(roots[0], '.switchflow', 'project.json');
    const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...metadata, install: 'global' }));
    await assert.rejects(canonicalProject(roots[0], shared), /Unsupported install "global"/);
  }));
