import './git-test-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { init, isPluginExcluded, mergeShareSettings } from '../plugin/tools/init.mjs';
import { toPluginAgents } from '../plugin/tools/lib.mjs';

const templateRoot = resolve('template');
const initScript = resolve('plugin/tools/init.mjs');
// init stamps the plugin's version, falling back to VERSION only without a plugin manifest.
const manifest = 'plugin/.claude-plugin/plugin.json';
const version = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, 'utf8')).version
  : readFileSync('VERSION', 'utf8').trim();

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'switchflow-plugin-init-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const run = (target, extra = {}) => init({ target, projectName: 'Safe', taskPrefix: 'SAFE', templateRoot, ...extra });
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const stages = root => readdirSync(root).filter(name => name.startsWith('.switchflow-import-'));
const quiet = fn => {
  const original = process.emitWarning;
  const warnings = [];
  process.emitWarning = message => warnings.push(String(message));
  try {
    fn();
  } finally {
    process.emitWarning = original;
  }
  return warnings;
};

test('init renders a data-only plugin project with every placeholder substituted', () =>
  fixture(root => {
    const target = join(root, 'project');
    const result = run(target, {
      projectName: `O'Neil "Q" \\ Co`,
      owner: "Ann O'Hara",
      repoUrl: 'https://example.com/repo',
      phase: 'Build',
    });
    assert.equal(result.version, version);
    for (const excluded of [
      '.switchflow/scripts',
      '.switchflow/package.json',
      '.switchflow/package-lock.json',
      '.switchflow/node_modules',
      '.agents',
      'Start Switchflow.cmd',
      '.github',
    ])
      assert.equal(existsSync(join(target, excluded)), false, excluded);
    for (const kept of ['AGENTS.md', 'backlog.config.yml', 'backlog/tasks/.gitkeep', '.switchflow/friction/README.md'])
      assert.ok(existsSync(join(target, kept)), kept);

    const config = JSON.parse(readFileSync(join(target, '.switchflow/project.json'), 'utf8'));
    assert.deepEqual(Object.keys(config), [
      'schemaVersion',
      'install',
      'templateVersion',
      'templateRevision',
      'templateDirty',
      'projectName',
      'taskPrefix',
      'ownerName',
      'repositoryUrl',
      'projectPhase',
    ]);
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.install, 'plugin');
    assert.equal(config.templateVersion, version);
    // Provenance is whatever Git reports here: unknown when Git refuses the checkout (for example a
    // folder another account owns, outside the test's private Git config's safe directories).
    const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
    if (head.status === 0) {
      assert.match(config.templateRevision ?? '', /^[0-9a-f]{40}$/);
      assert.equal(typeof config.templateDirty, 'boolean');
    } else {
      assert.equal(config.templateRevision, null);
      assert.equal(config.templateDirty, null);
    }
    assert.equal(config.projectName, `O'Neil "Q" \\ Co`);
    assert.equal(config.ownerName, "Ann O'Hara");
    assert.equal(config.projectPhase, 'Build');

    const yaml = readFileSync(join(target, 'backlog.config.yml'), 'utf8');
    assert.match(yaml, /^project_name: 'O''Neil "Q" \\ Co'$/m);
    const rendered = result.files
      .filter(file => !file.endsWith('.gitkeep'))
      .map(file => readFileSync(join(target, file), 'utf8'))
      .join('\n');
    assert.doesNotMatch(rendered, /\{\{[A-Z0-9_]+\}\}/);
    assert.match(rendered, /https:\/\/example\.com\/repo/);
    assert.match(rendered, /Ann O'Hara/);

    assert.equal(
      readFileSync(join(target, '.gitignore'), 'utf8'),
      '# Switchflow local tooling\n/.switchflow/node_modules/\n/backlog/milestones/*.scope-lock\n/backlog/milestones/*.tmp\n',
    );
    assert.equal(existsSync(join(target, '.claude')), false);
    assert.deepEqual(stages(root), []);
  }));

test('init writes the plugin-mode AGENTS.md without changing the template', () =>
  fixture(root => {
    const before = readFileSync(join(templateRoot, 'AGENTS.md'), 'utf8');
    const target = join(root, 'project');
    run(target);
    const agents = readFileSync(join(target, 'AGENTS.md'), 'utf8');
    assert.equal(readFileSync(join(templateRoot, 'AGENTS.md'), 'utf8'), before);
    assert.match(agents, /Use `switchflow-backlog` for every task and document read or mutation/);
    assert.match(agents, /^switchflow-backlog task view SAFE-02 --json$/m);
    assert.match(agents, /^switchflow-backlog doctor/m);
    assert.doesNotMatch(agents, /backlog\.ps1|npm --prefix|check-docs\.ps1/);
    assert.equal(agents.match(/^## Commands$/gm).length, 1);
    // Sections before Commands survive untouched.
    const head = before.slice(before.indexOf('## Roles'), before.indexOf('## Commands'));
    assert.ok(
      agents.includes(head.replaceAll('{{OWNER_NAME}}', 'Project owner').replaceAll('{{TASK_PREFIX}}', 'SAFE')),
    );
    assert.ok(agents.endsWith('\n') && !agents.endsWith('\n\n'));
  }));

test('the template still carries the anchors the plugin AGENTS.md rewrite depends on', () => {
  const template = readFileSync(join(templateRoot, 'AGENTS.md'), 'utf8');
  assert.match(template, /^## Commands$/m);
  assert.ok(template.includes('Use `.switchflow/scripts/backlog.ps1` for every task and document read or mutation'));
  const result = toPluginAgents(template, 'SAFE');
  assert.equal(result.commands, 'replaced');
  assert.equal(result.intro, true);
});

test('AGENTS.md rewrite keeps owner sections, appends when missing and is idempotent', () => {
  const middle = '# A\r\n\r\n## Commands\r\n\r\n.switchflow/scripts/backlog.ps1 doctor\r\n\r\n## After\r\n\r\nkeep\r\n';
  const replaced = toPluginAgents(middle, 'AB');
  assert.equal(replaced.commands, 'replaced');
  assert.match(replaced.text, /switchflow-backlog task view AB-02 --json\r\n/);
  assert.ok(replaced.text.endsWith('.\r\n\r\n## After\r\n\r\nkeep\r\n'));
  assert.doesNotMatch(replaced.text, /[^\r]\n/);
  assert.equal(toPluginAgents(replaced.text, 'AB').commands, 'unchanged');
  assert.equal(toPluginAgents(replaced.text, 'AB').text, replaced.text);

  const custom = '# A\n\n## Commands\n\nmake test\n';
  assert.deepEqual(toPluginAgents(custom, 'AB'), { text: custom, commands: 'kept', intro: false });

  const appended = toPluginAgents('# A\n\nbody\n', 'AB');
  assert.equal(appended.commands, 'appended');
  assert.match(appended.text, /^# A\n\nbody\n\n## Commands\n\n```bash\n/);
});

test('plugin exclusions cover the template-only runtime and nothing else', () => {
  for (const relative of [
    '.switchflow/scripts/backlog.ps1',
    join('.switchflow', 'scripts', 'control', 'server.mjs'),
    '.switchflow/node_modules/x/index.js',
    '.switchflow/package.json',
    '.switchflow/package-lock.json',
    '.agents/skills/intake/SKILL.md',
    'Start Switchflow.cmd',
    '.github/workflows/switchflow.yml',
  ])
    assert.equal(isPluginExcluded(relative), true, relative);
  for (const relative of [
    'AGENTS.md',
    '.switchflow/friction/README.md',
    '.switchflow/project.json',
    'docs/package.json',
    'backlog/docs/Start Switchflow.cmd',
    '.agents/README.md',
  ])
    assert.equal(isPluginExcluded(relative), false, relative);
});

test('binaries are copied unchanged and transient directories are skipped', () =>
  fixture(root => {
    const source = join(root, 'template');
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(source, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(source, '.switchflow', 'scripts'), { recursive: true });
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x7b, 0x7b, 0x50, 0x52, 0x4f, 0x7d, 0x7d, 0xff, 0xfe]);
    const binaryWithToken = Buffer.concat([Buffer.from('{{PROJECT_NAME}}'), Buffer.from([0, 1, 2])]);
    writeFileSync(join(source, 'assets', 'logo.png'), binary);
    writeFileSync(join(source, 'assets', 'data.bin'), binaryWithToken);
    writeFileSync(join(source, 'README.md'), '\uFEFF# {{PROJECT_NAME}} by {{OWNER_NAME}}\r\n');
    writeFileSync(join(source, 'node_modules', 'pkg', 'index.js'), '{{UNKNOWN}}');
    writeFileSync(join(source, '.switchflow', 'scripts', 'x.ps1'), '{{UNKNOWN}}');
    const target = join(root, 'project');
    const warnings = quiet(() => run(target, { templateRoot: source }));
    assert.match(warnings.join('\n'), /Skipped 1 file\(s\) in transient directories .*node_modules/);
    assert.deepEqual(readFileSync(join(target, 'assets', 'logo.png')), binary);
    assert.deepEqual(readFileSync(join(target, 'assets', 'data.bin')), binaryWithToken);
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '# Safe by Project owner\r\n');
    assert.equal(existsSync(join(target, 'node_modules')), false);
    assert.equal(existsSync(join(target, '.switchflow', 'scripts')), false);
  }));

test('unresolved tokens refuse the import before any write', () =>
  fixture(root => {
    const source = join(root, 'template');
    mkdirSync(source);
    writeFileSync(join(source, 'README.md'), '{{NOT_A_TOKEN}}');
    const target = join(root, 'project');
    assert.throws(() => run(target, { templateRoot: source }), /Unresolved template token in README\.md/);
    assert.equal(existsSync(target), false);
  }));

test('input validation refuses unsafe values', () =>
  fixture(root => {
    const target = join(root, 'project');
    assert.throws(() => run(target, { taskPrefix: 'safe' }), /TaskPrefix/);
    assert.throws(() => run(target, { taskPrefix: 'A' }), /TaskPrefix/);
    assert.throws(() => run(target, { projectName: '  ' }), /ProjectName must contain visible text/);
    assert.throws(() => run(target, { owner: 'a\nb' }), /OwnerName must be a single-line value/);
    assert.throws(() => run(target, { phase: '{{PROJECT_NAME}}' }), /reserved Switchflow template-token/);
    assert.throws(() => run(target, { repoUrl: 'ftp://example.com/x' }), /absolute HTTP or HTTPS URL/);
    assert.throws(() => run(target, { repoUrl: 'example.com/x' }), /absolute HTTP or HTTPS URL/);
    assert.throws(() => run(resolve('/')), /filesystem root/);
    assert.equal(existsSync(target), false);
  }));

test('init refuses to overwrite existing governance files', () =>
  fixture(root => {
    const target = join(root, 'project');
    mkdirSync(target);
    writeFileSync(join(target, 'AGENTS.md'), 'mine');
    assert.throws(() => run(target), /would overwrite existing governance files:\n- AGENTS\.md/);
    assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), 'mine');
    assert.deepEqual(readdirSync(target), ['AGENTS.md']);

    const second = join(root, 'second');
    mkdirSync(join(second, '.switchflow'), { recursive: true });
    writeFileSync(join(second, '.switchflow', 'project.json'), '{}');
    assert.throws(() => run(second), /project\.json/);
    assert.deepEqual(readdirSync(second), ['.switchflow']);
  }));

test('init rejects a file where a directory is needed before writing', () =>
  fixture(root => {
    const target = join(root, 'project');
    mkdirSync(target);
    writeFileSync(join(target, 'backlog'), 'preserve');
    assert.throws(() => run(target), /requires a directory but found a file/);
    assert.deepEqual(readdirSync(target), ['backlog']);
    assert.deepEqual(stages(root), []);
  }));

test('init refuses linked destinations without writing into their targets', () =>
  fixture(root => {
    const target = join(root, 'project'),
      outside = join(root, 'outside');
    mkdirSync(target);
    mkdirSync(outside);
    symlinkSync(outside, join(target, 'backlog'), 'junction');
    assert.throws(() => run(target), /linked path/);
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(readdirSync(target), ['backlog']);

    const linkedIgnore = join(root, 'ignore-project');
    mkdirSync(linkedIgnore);
    writeFileSync(join(outside, 'ignore'), 'outside\n');
    try {
      symlinkSync(join(outside, 'ignore'), join(linkedIgnore, '.gitignore'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return; // file links need Developer Mode
      throw error;
    }
    assert.throws(() => run(linkedIgnore), /linked path/);
    assert.equal(readFileSync(join(outside, 'ignore'), 'utf8'), 'outside\n');
  }));

test('init refuses the Switchflow repository itself', () => {
  assert.throws(() => run(resolve('.')), /not into the Switchflow repository/);
  assert.throws(() => run(resolve('docs', 'new-project')), /not into the Switchflow repository/);
  fixture(root => {
    const repo = join(root, 'Switchflow-fork');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'template'));
    writeFileSync(join(repo, 'scripts', 'import-switchflow.ps1'), '');
    writeFileSync(join(repo, 'template', 'AGENTS.md'), '');
    assert.throws(() => run(join(repo, 'sub')), /not into the Switchflow repository/);
    assert.equal(existsSync(join(repo, 'sub')), false);
  });
});

test('init refuses a linked worktree and accepts its primary checkout', () =>
  fixture(root => {
    const primary = join(root, 'primary'),
      linked = join(root, 'linked');
    mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    writeFileSync(join(primary, 'README.md'), 'x\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-q', '-m', 'init');
    git(primary, 'worktree', 'add', '-q', linked, '-b', 'code');
    assert.throws(() => run(linked), /primary checkout .*not linked code worktree/);
    assert.deepEqual(readdirSync(linked).sort(), ['.git', 'README.md']);
    run(primary);
    assert.equal(JSON.parse(readFileSync(join(primary, '.switchflow/project.json'), 'utf8')).install, 'plugin');
  }));

test('an interrupted import journal blocks a retry for the same target only', () =>
  fixture(root => {
    const target = join(root, 'project'),
      stage = join(root, '.switchflow-import-0123456789abcdef0123456789abcdef');
    mkdirSync(target);
    mkdirSync(stage);
    writeFileSync(join(stage, 'recovery.json'), JSON.stringify({ target: join(root, 'other'), files: [] }));
    run(join(root, 'unrelated'));
    writeFileSync(join(stage, 'recovery.json'), JSON.stringify({ target, files: [] }));
    assert.throws(() => run(target), /interrupted import needs reconciliation/);
    assert.deepEqual(readdirSync(target), []);
    assert.ok(existsSync(join(stage, 'recovery.json')));
  }));

test('a failure mid-install rolls back every moved file, restores .gitignore and permits retry', () =>
  fixture(root => {
    const target = join(root, 'project');
    mkdirSync(target);
    writeFileSync(join(target, '.gitignore'), 'keep-me\r\n');
    writeFileSync(join(target, 'unrelated.txt'), 'mine');
    let journal = null;
    let moves = 0;
    assert.throws(
      () =>
        init(
          { target, projectName: 'Safe', taskPrefix: 'SAFE', templateRoot, share: true },
          {
            beforeMove(entry) {
              journal = JSON.parse(readFileSync(join(root, stages(root)[0], 'recovery.json'), 'utf8'));
              // Fail after both replaceable files and several new files have moved.
              if (++moves === journal.files.length) throw new Error('injected failure');
            },
          },
        ),
      /injected failure/,
    );
    assert.equal(journal.target, target);
    assert.ok(journal.files.some(file => file.destination.endsWith('.gitignore') && file.originalHash));
    assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), 'keep-me\r\n');
    assert.equal(existsSync(join(target, 'AGENTS.md')), false);
    assert.equal(existsSync(join(target, '.switchflow', 'project.json')), false);
    assert.equal(existsSync(join(target, '.claude', 'settings.json')), false);
    assert.equal(readFileSync(join(target, 'unrelated.txt'), 'utf8'), 'mine');
    assert.deepEqual(stages(root), []);
    run(target);
    assert.ok(readFileSync(join(target, '.gitignore'), 'utf8').startsWith('keep-me\n# Switchflow local tooling\n'));
  }));

test('rollback preserves an installed file that changed and keeps the recovery journal', () =>
  fixture(root => {
    const target = join(root, 'project');
    let moves = 0;
    let firstDestination = null;
    const warnings = quiet(() =>
      assert.throws(
        () =>
          init(
            { target, projectName: 'Safe', taskPrefix: 'SAFE', templateRoot },
            {
              beforeMove(entry) {
                moves += 1;
                if (moves === 1) firstDestination = entry.destination;
                if (moves === 3) {
                  writeFileSync(firstDestination, 'owner edit');
                  throw new Error('injected failure');
                }
              },
            },
          ),
        /injected failure/,
      ),
    );
    assert.equal(readFileSync(firstDestination, 'utf8'), 'owner edit');
    assert.match(warnings.join('\n'), /Could not roll back/);
    assert.equal(stages(root).length, 1);
    assert.ok(existsSync(join(root, stages(root)[0], 'recovery.json')));
    assert.throws(() => run(target), /interrupted import needs reconciliation/);
  }));

test('--share merges the marketplace and plugin into existing project settings', () =>
  fixture(root => {
    const target = join(root, 'project');
    mkdirSync(join(target, '.claude'), { recursive: true });
    const existing = {
      permissions: { allow: ['Bash(npm test)'] },
      enabledPlugins: { 'other@market': true, 'switchflow@switchflow': false },
      extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'o/m' } } },
    };
    writeFileSync(join(target, '.claude', 'settings.json'), JSON.stringify(existing));
    run(target, { share: true });
    const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings, {
      permissions: { allow: ['Bash(npm test)'] },
      enabledPlugins: { 'other@market': true, 'switchflow@switchflow': true },
      extraKnownMarketplaces: {
        market: { source: { source: 'github', repo: 'o/m' } },
        switchflow: { source: { source: 'github', repo: 'SwitchOCE/Switchflow' } },
      },
    });
  }));

test('share merging keeps a differing marketplace entry and rejects malformed settings', () => {
  const warnings = [];
  const local = { source: { source: 'directory', path: 'C:\\dev\\Switchflow' } };
  const merged = mergeShareSettings(JSON.stringify({ extraKnownMarketplaces: { switchflow: local } }), warnings);
  assert.deepEqual(merged.extraKnownMarketplaces.switchflow, local);
  assert.equal(merged.enabledPlugins['switchflow@switchflow'], true);
  assert.match(warnings[0], /Kept the existing extraKnownMarketplaces\.switchflow/);
  assert.deepEqual(mergeShareSettings(null), {
    extraKnownMarketplaces: { switchflow: { source: { source: 'github', repo: 'SwitchOCE/Switchflow' } } },
    enabledPlugins: { 'switchflow@switchflow': true },
  });
  assert.throws(() => mergeShareSettings('{oops'), /not valid JSON/);
  assert.throws(() => mergeShareSettings('[]'), /JSON object/);
  assert.throws(() => mergeShareSettings('{"enabledPlugins":[]}'), /enabledPlugins must be an object/);
  fixture(root => {
    const target = join(root, 'project');
    mkdirSync(join(target, '.claude'), { recursive: true });
    writeFileSync(join(target, '.claude', 'settings.json'), '{oops');
    assert.throws(() => run(target, { share: true }), /not valid JSON/);
    assert.deepEqual(readdirSync(target), ['.claude']);
  });
});

test('the CLI initializes Git, reports success and fails with a message', () =>
  fixture(root => {
    const target = join(root, 'project');
    const args = ['--target', target, '--project-name', 'Cli', '--task-prefix', 'CLI'];
    const ok = spawnSync(
      process.execPath,
      [initScript, ...args, '--template-root', templateRoot, '--initialize-git', '--owner', 'Pat'],
      { encoding: 'utf8' },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Imported Switchflow .* \(plugin mode\)/);
    assert.ok(existsSync(join(target, '.git')));
    assert.equal(git(target, 'branch', '--show-current').trim(), 'main');
    assert.equal(JSON.parse(readFileSync(join(target, '.switchflow/project.json'), 'utf8')).ownerName, 'Pat');
    const again = spawnSync(process.execPath, [initScript, ...args, '--template-root', templateRoot], {
      encoding: 'utf8',
    });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /would overwrite existing governance files/);
    const bad = spawnSync(process.execPath, [initScript, '--bogus'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown argument --bogus/);
  }));
