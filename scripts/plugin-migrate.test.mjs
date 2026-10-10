import './git-test-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { migrate, migrationBranch, summary } from '../plugin/tools/migrate.mjs';

const migrateScript = resolve('plugin/tools/migrate.mjs');
const tokens = {
  PROJECT_NAME_YAML_SINGLE: 'Old',
  OWNER_NAME_YAML_SINGLE: 'Owner',
  PROJECT_NAME_YAML_DOUBLE: 'Old',
  PROJECT_NAME: 'Old',
  TASK_PREFIX: 'OLD',
  OWNER_NAME: 'Owner',
  PROJECT_PHASE: 'Discovery',
  REPOSITORY_DISPLAY: 'Not configured.',
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

// A template-mode project: the repository's template/ rendered in place and committed, the
// way scripts/import-switchflow.ps1 leaves it.
function templateProject(root) {
  const project = join(root, 'project');
  cpSync(resolve('template'), project, { recursive: true });
  const render = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) render(file);
      else if (statSync(file).size) {
        const text = readFileSync(file, 'utf8');
        const rendered = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => tokens[name] ?? match);
        if (rendered !== text) writeFileSync(file, rendered);
      }
    }
  };
  render(project);
  writeFileSync(
    join(project, '.switchflow', 'project.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        templateVersion: '0.6.0',
        templateRevision: null,
        templateDirty: null,
        projectName: 'Old',
        taskPrefix: 'OLD',
        ownerName: 'Owner',
        repositoryUrl: '',
        projectPhase: 'Discovery',
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(project, '.gitignore'), '# Switchflow local tooling\n/.switchflow/node_modules/\n');
  writeFileSync(join(project, 'backlog', 'tasks', 'old-01 - Keep-me.md'), '---\nid: OLD-01\n---\n');
  git(root, 'init', '-q', '-b', 'main', project);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Import Switchflow');
  return project;
}
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-plugin-migrate-'));
  try {
    return fn(root, templateProject(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const status = project => git(project, 'status', '--porcelain').split('\n').filter(Boolean);

test('migrate stages a plugin-mode project on its own branch without committing', () =>
  fixture((root, project) => {
    const before = git(project, 'rev-parse', 'HEAD').trim();
    const result = migrate({ target: project });
    assert.equal(git(project, 'branch', '--show-current').trim(), migrationBranch);
    assert.equal(git(project, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(result.commit, null);
    assert.deepEqual(
      result.removed.map(entry => entry.path),
      [
        '.switchflow/scripts',
        '.switchflow/package.json',
        '.switchflow/package-lock.json',
        '.agents/skills',
        'Start Switchflow.cmd',
        '.github/workflows/switchflow.yml',
      ],
    );
    assert.equal(result.workflowRemoved, true);
    for (const gone of [
      '.switchflow/scripts',
      '.switchflow/package.json',
      '.agents',
      'Start Switchflow.cmd',
      '.github',
    ])
      assert.equal(existsSync(join(project, gone)), false, gone);
    for (const kept of [
      'backlog/tasks/old-01 - Keep-me.md',
      'backlog/docs',
      'backlog.config.yml',
      '.switchflow/friction',
    ])
      assert.ok(existsSync(join(project, kept)), kept);

    const config = JSON.parse(readFileSync(join(project, '.switchflow', 'project.json'), 'utf8'));
    assert.deepEqual(Object.keys(config).slice(0, 3), ['schemaVersion', 'install', 'templateVersion']);
    assert.equal(config.install, 'plugin');
    assert.equal(config.projectName, 'Old');

    const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.equal(result.agents.commands, 'replaced');
    assert.match(agents, /^switchflow-backlog task view OLD-02 --json$/m);
    assert.match(agents, /Use `switchflow-backlog` for every task/);
    assert.doesNotMatch(agents, /npm --prefix|backlog\.ps1/);

    // Everything is staged; nothing is left unstaged or untracked.
    assert.ok(
      status(project).every(line => /^[MD] /.test(line)),
      status(project).join('\n'),
    );
    assert.ok(result.staleReferences.some(file => file.startsWith('backlog/docs/')));
    const text = summary(result);
    assert.match(text, /Removed \.github\/workflows\/switchflow\.yml/);
    assert.match(text, /Changes are staged, not committed/);
    assert.match(text, /still mention \.switchflow\/scripts/);
  }));

test('migrate --commit records one commit and the project is clean afterwards', () =>
  fixture((root, project) => {
    const result = migrate({ target: project, commit: true });
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(status(project), []);
    assert.equal(git(project, 'log', '-1', '--format=%s').trim(), 'Move Switchflow to plugin mode');
    assert.equal(git(project, 'rev-parse', 'main~0').trim(), git(project, 'rev-parse', 'HEAD~1').trim());
    assert.throws(() => migrate({ target: project }), /already in plugin mode/);
  }));

test('migrate refuses a dirty tree, an existing branch and a linked worktree', () =>
  fixture((root, project) => {
    writeFileSync(join(project, 'scratch.txt'), 'x');
    assert.throws(() => migrate({ target: project }), /Commit or stash these changes[\s\S]*scratch\.txt/);
    rmSync(join(project, 'scratch.txt'));

    const linked = join(root, 'linked');
    git(project, 'worktree', 'add', '-q', linked, '-b', 'code');
    assert.throws(() => migrate({ target: linked }), /primary checkout .*not linked code worktree/);
    assert.ok(existsSync(join(linked, '.switchflow', 'scripts')));

    git(project, 'branch', migrationBranch);
    assert.throws(() => migrate({ target: project }), /already exists/);
    assert.equal(git(project, 'branch', '--show-current').trim(), 'main');
    assert.deepEqual(status(project), []);
  }));

test('migrate refuses a folder that is not a Switchflow checkout', () =>
  fixture((root, project) => {
    assert.throws(() => migrate({ target: join(project, 'backlog') }), /not the root of a Git checkout/);
    git(project, 'rm', '-q', '.switchflow/project.json');
    git(project, 'commit', '-q', '-m', 'drop config');
    assert.throws(() => migrate({ target: project }), /not a Switchflow project/);
  }));

test('the migrate CLI prints the summary and reports refusals', () =>
  fixture((root, project) => {
    const ok = spawnSync(process.execPath, [migrateScript, '--commit'], { cwd: project, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Switchflow plugin migration on branch switchflow\/migrate-to-plugin \(from main\)/);
    assert.match(ok.stdout, /Committed [0-9a-f]{12}/);
    const again = spawnSync(process.execPath, [migrateScript, '--target', project], { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already in plugin mode/);
  }));
