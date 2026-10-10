// Shared helpers for the plugin's project tools. Node built-ins only: these run from the
// plugin cache before any Switchflow runtime exists in the project.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const trimSeparators = value => value.replace(/[\\/]+$/, '');
export const samePath = (a, b) => {
  const left = trimSeparators(path.resolve(a)),
    right = trimSeparators(path.resolve(b));
  return foldCase ? left.toLowerCase() === right.toLowerCase() : left === right;
};
export const isInside = (child, parent) => {
  if (samePath(child, parent)) return true;
  const prefix = trimSeparators(path.resolve(parent)) + path.sep;
  const candidate = path.resolve(child);
  return foldCase ? candidate.toLowerCase().startsWith(prefix.toLowerCase()) : candidate.startsWith(prefix);
};

export function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) {
    if (allowFailure) return null;
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

// Port of Get-PrimaryCheckoutRoot in tooling.ps1: the checkout that owns the common Git
// directory, or null when the registration cannot be read.
export function primaryCheckoutRoot(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  const stat = lstatOrNull(dotGit);
  let commonGitDir = null;
  if (stat?.isDirectory()) commonGitDir = dotGit;
  else if (stat?.isFile()) {
    const line = fs.readFileSync(dotGit, 'utf8').replace(/^﻿/, '').trim();
    if (line.startsWith('gitdir: ')) {
      const gitDir = path.resolve(projectRoot, line.slice(8));
      const commonDirFile = path.join(gitDir, 'commondir');
      if (lstatOrNull(commonDirFile)) commonGitDir = path.join(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
    }
  }
  if (commonGitDir === null) {
    const output = git(projectRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      allowFailure: true,
    });
    if (!output?.trim()) return null;
    commonGitDir = output.trim();
  }
  commonGitDir = path.resolve(commonGitDir);
  if (path.basename(commonGitDir) !== '.git') return null;
  return path.dirname(commonGitDir);
}

export function assertPrimaryCheckout(targetRoot, action) {
  const primary = primaryCheckoutRoot(targetRoot);
  if (primary === null)
    throw new Error(
      `Cannot identify the primary checkout for this Git target. Repair its Git registration before ${action}.`,
    );
  if (!samePath(targetRoot, primary))
    throw new Error(
      `Run this in the primary checkout ${primary}, not linked code worktree ${targetRoot}. Existing governance copies were preserved.`,
    );
}

export function pluginVersion(root = pluginRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version.trim()) return manifest.version.trim();
  } catch {
    // The manifest is optional for development copies; fall back to VERSION.
  }
  for (const candidate of [path.join(root, 'VERSION'), path.join(root, '..', 'VERSION')]) {
    try {
      const version = fs.readFileSync(candidate, 'utf8').trim();
      if (version) return version;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`Cannot determine the Switchflow plugin version from ${root}.`);
}

// The template AGENTS.md describes the copied PowerShell wrappers and npm setup. Plugin
// projects reach the same backlog through the plugin's switchflow-backlog command, so the
// Commands section is replaced as a whole and the one intro sentence naming the wrapper is
// retargeted. Anchors are matched exactly; anything else the owner wrote stays as it is.
const wrapperSentence = 'Use `.switchflow/scripts/backlog.ps1` for every task and document read or mutation';
const pluginSentence = 'Use `switchflow-backlog` for every task and document read or mutation';

export function pluginCommandsSection(taskPrefix, eol = '\n') {
  return [
    '## Commands',
    '',
    '```bash',
    `switchflow-backlog task view ${taskPrefix}-02 --json`,
    'switchflow-backlog browser             # shared project board and documents',
    'switchflow-backlog doctor              # after task mutations',
    'switchflow-backlog check-docs          # after documentation changes',
    '```',
    '',
    'The Switchflow Claude Code plugin supplies `switchflow-backlog` and the backlog runtime. This project holds only Switchflow data: no `.switchflow/scripts`, no npm setup and no `node_modules`. The command resolves the primary checkout and routes governance reads and writes there, so it behaves the same from a linked code worktree. If the command is missing, enable the `switchflow` plugin; do not copy Switchflow scripts into the project.',
    '',
  ].join(eol);
}

export function toPluginAgents(text, taskPrefix) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^## Commands\s*$/.test(line));
  let commands = 'appended';
  let result;
  if (start === -1) {
    result = text.replace(/(\r?\n)*$/, '') + eol + eol + pluginCommandsSection(taskPrefix, eol);
  } else {
    let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
    if (end === -1) end = lines.length;
    const section = lines.slice(start, end).join('\n');
    if (section.includes('switchflow-backlog') && !section.includes('.switchflow/scripts/')) {
      commands = 'unchanged';
      result = text;
    } else if (!section.includes('.switchflow/scripts/backlog.ps1')) {
      // An owner-written section that names neither runtime is left for the owner to edit.
      commands = 'kept';
      result = text;
    } else {
      commands = 'replaced';
      const replacement = pluginCommandsSection(taskPrefix, eol).split(eol);
      result = [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join(eol);
    }
  }
  const intro = result.includes(wrapperSentence);
  if (intro) result = result.replace(wrapperSentence, pluginSentence);
  return { text: result, commands, intro };
}

export function writeJsonText(value, eol = '\n') {
  return JSON.stringify(value, null, 2).replaceAll('\n', eol) + eol;
}
