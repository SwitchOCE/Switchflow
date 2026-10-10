// Moves a template-mode Switchflow project to plugin mode on a new branch. Project data
// (backlog, documents, state) stays; the copied runtime and skills leave the repository.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPrimaryCheckout, git, lstatOrNull, toPluginAgents, writeJsonText } from './lib.mjs';

export const migrationBranch = 'switchflow/migrate-to-plugin';
// Template-only paths, in the order they are reported.
export const templateOnlyPaths = [
  '.switchflow/scripts',
  '.switchflow/package.json',
  '.switchflow/package-lock.json',
  '.agents/skills',
  'Start Switchflow.cmd',
  '.github/workflows/switchflow.yml',
];

const usage = 'Usage: node migrate.mjs [--target <dir>] [--commit]';

export function parseArgs(argv) {
  const values = { target: process.cwd(), commit: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--commit') values.commit = true;
    else if (arg === '--help' || arg === '-h') values.help = true;
    else if (arg === '--target') {
      if (index + 1 >= argv.length) throw new Error(`--target needs a value.\n${usage}`);
      values.target = argv[++index];
    } else throw new Error(`Unknown argument ${arg}.\n${usage}`);
  }
  return values;
}

const lines = output => (output ?? '').split(/\r?\n/).filter(Boolean);

export function migrate({ target = process.cwd(), commit = false } = {}) {
  const root = path.resolve(target);
  if (!lstatOrNull(path.join(root, '.git'))) throw new Error(`${root} is not the root of a Git checkout.`);
  assertPrimaryCheckout(root, 'migrating');
  const configPath = path.join(root, '.switchflow', 'project.json');
  if (!lstatOrNull(configPath)?.isFile()) throw new Error(`${configPath} not found; this is not a Switchflow project.`);
  for (const file of [configPath, path.join(root, 'AGENTS.md')])
    if (lstatOrNull(file)?.isSymbolicLink()) throw new Error(`Refusing to write through linked path ${file}.`);
  const configText = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, '');
  const config = JSON.parse(configText);
  if (config.install === 'plugin') throw new Error('This project is already in plugin mode.');
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(config.taskPrefix ?? ''))
    throw new Error('.switchflow/project.json has no valid taskPrefix.');

  const dirty = lines(git(root, ['status', '--porcelain', '--untracked-files=all']));
  if (dirty.length)
    throw new Error(`Commit or stash these changes before migrating:\n- ${dirty.slice(0, 20).join('\n- ')}`);
  if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${migrationBranch}`], { allowFailure: true }) !== null)
    throw new Error(`Branch ${migrationBranch} already exists. Delete or rename it before migrating again.`);
  const startBranch = git(root, ['branch', '--show-current']).trim() || 'detached HEAD';
  const startSha = git(root, ['rev-parse', 'HEAD']).trim();

  git(root, ['switch', '-c', migrationBranch]);
  let removed, agents, staleReferences;
  try {
    removed = [];
    for (const relative of templateOnlyPaths) {
      const tracked = lines(git(root, ['ls-files', '--', relative]));
      if (!tracked.length) continue;
      git(root, ['rm', '-r', '--quiet', '--', relative]);
      removed.push({ path: relative, files: tracked.length });
    }

    const eol = configText.includes('\r\n') ? '\r\n' : '\n';
    const { schemaVersion, install, ...rest } = config;
    fs.writeFileSync(configPath, writeJsonText({ schemaVersion, install: 'plugin', ...rest }, eol));
    git(root, ['add', '--', path.join('.switchflow', 'project.json')]);

    agents = { commands: 'missing', intro: false };
    const agentsPath = path.join(root, 'AGENTS.md');
    if (lstatOrNull(agentsPath)?.isFile()) {
      const original = fs.readFileSync(agentsPath, 'utf8');
      const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
      agents = toPluginAgents(original.slice(bom.length), config.taskPrefix);
      if (bom + agents.text !== original) {
        fs.writeFileSync(agentsPath, bom + agents.text);
        git(root, ['add', '--', 'AGENTS.md']);
      }
    }

    // Documents are project data and stay as written; list the ones that still name copied scripts.
    staleReferences = (
      git(root, ['grep', '--cached', '-z', '-l', '-F', '-e', '.switchflow/scripts', '--', '.'], {
        allowFailure: true,
      }) ?? ''
    )
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    // The tree was clean, so restoring HEAD and returning to the start loses nothing.
    git(root, ['reset', '--quiet', '--hard', 'HEAD'], { allowFailure: true });
    if (startBranch === 'detached HEAD') git(root, ['switch', '--quiet', '--detach', startSha], { allowFailure: true });
    else git(root, ['switch', '--quiet', startBranch], { allowFailure: true });
    git(root, ['branch', '-D', migrationBranch], { allowFailure: true });
    throw error;
  }

  let commitSha = null;
  if (commit) {
    git(root, ['commit', '--quiet', '-m', 'Move Switchflow to plugin mode']);
    commitSha = git(root, ['rev-parse', 'HEAD']).trim();
  }
  return {
    root,
    startBranch,
    branch: migrationBranch,
    removed,
    workflowRemoved: removed.some(entry => entry.path === '.github/workflows/switchflow.yml'),
    agents,
    staleReferences,
    leftoverNodeModules: Boolean(lstatOrNull(path.join(root, '.switchflow', 'node_modules'))),
    commit: commitSha,
  };
}

export function summary(result) {
  const out = [`Switchflow plugin migration on branch ${result.branch} (from ${result.startBranch}).`];
  out.push('Removed template-only files:');
  if (!result.removed.length) out.push('  (none were tracked)');
  for (const entry of result.removed) out.push(`  ${entry.path} (${entry.files} file${entry.files === 1 ? '' : 's'})`);
  if (result.workflowRemoved)
    out.push(
      'Removed .github/workflows/switchflow.yml: it ran the copied validation scripts. Re-add CI checks through the plugin if you need them.',
    );
  out.push('Set "install": "plugin" in .switchflow/project.json.');
  const commands = {
    replaced: 'AGENTS.md Commands section now uses switchflow-backlog.',
    appended: 'AGENTS.md had no Commands section; a plugin-mode one was appended.',
    unchanged: 'AGENTS.md Commands section already used switchflow-backlog.',
    kept: 'AGENTS.md Commands section was customized and left as written; update it by hand.',
    missing: 'No AGENTS.md found; nothing rewritten.',
  };
  out.push(commands[result.agents.commands]);
  out.push('Kept backlog/, backlog.config.yml, documents and Switchflow state.');
  if (result.staleReferences.length)
    out.push(
      'These tracked files still mention .switchflow/scripts and may need edits:',
      ...result.staleReferences.map(file => `  ${file}`),
    );
  if (result.leftoverNodeModules)
    out.push(
      '.switchflow/node_modules is ignored and was left in place. Delete it once no board runs from this project copy.',
    );
  if (result.commit) out.push(`Committed ${result.commit.slice(0, 12)}.`);
  else
    out.push(
      'Changes are staged, not committed. Review with `git diff --cached`, then commit, or rerun with --commit.',
    );
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(summary(migrate(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
