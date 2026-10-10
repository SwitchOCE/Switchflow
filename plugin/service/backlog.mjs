// Node port of backlog.ps1: runs the pinned Backlog CLI against the primary checkout's governance,
// whichever worktree it is called from. Template installs run it from their .switchflow/scripts
// copy; plugin installs run the plugin's copy through bin/switchflow-backlog, from the project's
// cwd. Helper scripts come from the governance checkout's tool root (control/tool-root.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMode, resolveToolRoot } from './control/tool-root.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

class UsageError extends Error {}
// PowerShell compares strings without case; routing keeps that.
const same = (value, ...options) =>
  typeof value === 'string' && options.some(option => value.toLowerCase() === option.toLowerCase());
const contains = (args, value) => args.some(arg => same(arg, value));
const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const isDirectory = file => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true, ...options });
const exitCode = result => {
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** The primary checkout of the repository holding projectRoot, through the Git common dir. */
export function primaryCheckoutRoot(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  let commonGitDir = null;
  if (isDirectory(dotGit)) commonGitDir = dotGit;
  else if (isFile(dotGit)) {
    const line = fs.readFileSync(dotGit, 'utf8').replace(/^﻿/, '').trim();
    if (line.startsWith('gitdir: ')) {
      const gitDir = path.resolve(projectRoot, line.slice(8));
      const commonDirFile = path.join(gitDir, 'commondir');
      if (fs.existsSync(commonDirFile))
        commonGitDir = path.join(gitDir, fs.readFileSync(commonDirFile, 'utf8').replace(/^﻿/, '').trim());
    }
  }
  if (commonGitDir === null) {
    const result = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
    commonGitDir = result.stdout.trim();
  }
  commonGitDir = path.resolve(commonGitDir.trim());
  if (path.basename(commonGitDir) !== '.git') return null;
  return path.dirname(commonGitDir);
}

/** This checkout first, then the primary checkout when it differs. */
export function toolingRoots(projectRoot) {
  const roots = [path.resolve(projectRoot)];
  const primary = primaryCheckoutRoot(projectRoot);
  if (primary !== null && !roots.includes(primary)) roots.push(primary);
  return roots;
}

function readMetadata(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.switchflow', 'project.json'), 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The tool root of a governance checkout (absent project.json means a template install). */
export const governanceTools = root => resolveToolRoot(root, readMetadata(root) ?? {});

/** The primary checkout that holds canonical governance. Copied worktree governance is never used. */
export function resolveGovernanceRoot(projectRoot) {
  const root = path.resolve(projectRoot);
  const primary = primaryCheckoutRoot(root);
  if (primary === null) {
    if (fs.existsSync(path.join(root, '.git')))
      throw new Error(
        `Cannot resolve the primary governance checkout for ${root}. Repair the Git worktree registration; do not use its copied board.`,
      );
    // Standalone imports are supported before Git initialization.
    return root;
  }
  const hasConfig =
    isFile(path.join(primary, 'backlog.config.yml')) || isFile(path.join(primary, 'backlog', 'config.yml'));
  let installed = false;
  try {
    const metadata = readMetadata(primary);
    // A plugin install holds only data; a template install carries its own wrapper.
    installed =
      metadata !== null && installMode(metadata) === 'plugin'
        ? true
        : isFile(path.join(primary, '.switchflow', 'scripts', 'backlog.ps1'));
  } catch {
    installed = false;
  }
  if (!hasConfig || !isDirectory(path.join(primary, 'backlog')) || !installed)
    throw new Error(
      `Canonical governance is unavailable in primary checkout ${primary}. Restore that checkout's Switchflow configuration and backlog; copied worktree governance is never a fallback.`,
    );
  return primary;
}

/** The pinned fork CLI, or for reads only the pinned original Backlog package. */
export function resolveBacklogCli(projectRoot, { requireFork = false } = {}) {
  const tools = governanceTools(projectRoot);
  const forkResolver = path.join(tools.scriptsDir, 'backlog-fork', 'resolve.mjs');
  if (isFile(forkResolver)) {
    // Existing imports retain readable original tooling until explicit fork setup.
    const result = spawnSync(process.execPath, [forkResolver], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const forkCli = (result.stdout ?? '').trim();
    if (!result.error && result.status === 0 && forkCli && isFile(forkCli)) return forkCli;
  }
  if (requireFork) {
    const setup =
      tools.mode === 'plugin'
        ? `node "${path.join(tools.scriptsDir, 'backlog-fork', 'setup.mjs')}"`
        : `'npm --prefix .switchflow run setup:backlog-fork' in canonical governance ${projectRoot}`;
    throw new Error(
      `The verified Switchflow Backlog fork is required for mutations, MCP and the native board. Run ${setup}. The official fallback is read-only.`,
    );
  }
  const works = cliPath => {
    const result = spawnSync(process.execPath, [cliPath, '--version'], { stdio: 'ignore', windowsHide: true });
    return !result.error && result.status === 0;
  };
  if (tools.mode === 'plugin') {
    // The plugin ships the Backlog package it was built and tested with.
    const cliPath = path.join(tools.backlogPackageDir, 'cli.js');
    if (isFile(cliPath) && isFile(path.join(tools.backlogPackageDir, 'package.json')) && works(cliPath)) return cliPath;
    throw new Error(
      `The Switchflow plugin's Backlog package is unavailable at ${tools.backlogPackageDir}. Reinstall the plugin.`,
    );
  }
  const projectPackage = JSON.parse(fs.readFileSync(tools.backlogPackageJson, 'utf8').replace(/^﻿/, ''));
  const expectedVersion = String(projectPackage.devDependencies?.['backlog.md'] ?? '');
  if (!expectedVersion.trim()) throw new Error('.switchflow/package.json does not pin Backlog.md.');
  for (const root of toolingRoots(projectRoot)) {
    const directory = resolveToolRoot(root, {}).backlogPackageDir;
    const cliPath = path.join(directory, 'cli.js');
    const installedPath = path.join(directory, 'package.json');
    if (!fs.existsSync(cliPath) || !fs.existsSync(installedPath)) continue;
    let installed;
    try {
      installed = JSON.parse(fs.readFileSync(installedPath, 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
    if (String(installed.version) === expectedVersion && works(cliPath)) return cliPath;
  }
  throw new Error(
    `Backlog.md ${expectedVersion} is unavailable in this worktree and the primary checkout. Run 'npm --prefix .switchflow ci --ignore-scripts' in the primary checkout; do not run an unpinned install.`,
  );
}

/** The project this invocation is for: the install holding this script, else the caller's checkout. */
export function invocationRoot(cwd = process.cwd()) {
  if (path.basename(scriptDir) === 'scripts' && path.basename(path.dirname(scriptDir)) === '.switchflow')
    return path.dirname(path.dirname(scriptDir));
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return !result.error && result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : cwd;
}

async function matchingService(infoPath) {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8').replace(/^﻿/, ''));
    const url = new URL(info.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
    const health = await (await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) })).json();
    if (
      health.service === 'switchflow-control' &&
      health.apiVersion === 2 &&
      health.mode === 'multi-project' &&
      health.pid === info.pid
    )
      return info.url;
  } catch {
    return null;
  }
  return null;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The printed URL remains. */
  }
}

/** Port of start-control.ps1: reuse or start the shared board service and register the project. */
export async function startControl(projectRoot, { port = 0, noOpen = false } = {}) {
  const root = resolveGovernanceRoot(projectRoot);
  const scripts = governanceTools(root).scriptsDir;
  const context = spawnSync(process.execPath, [path.join(scripts, 'operations', 'operations.mjs'), 'context', root], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (context.error || context.status !== 0)
    throw new Error('Cannot identify the project. Initialize its Git repository before starting Switchflow.');
  const { stateDir } = JSON.parse(context.stdout);
  const sharedDir = path.join(path.dirname(path.dirname(stateDir)), 'control-service');
  fs.mkdirSync(sharedDir, { recursive: true });
  const infoPath = path.join(sharedDir, 'service-info.json');
  let url = await matchingService(infoPath);
  if (!url) {
    const launchId = randomUUID().replaceAll('-', '');
    const stderrPath = path.join(sharedDir, `service.${launchId}.stderr.log`);
    const stdout = fs.openSync(path.join(sharedDir, `service.${launchId}.stdout.log`), 'a');
    const stderr = fs.openSync(stderrPath, 'a');
    const child = spawn(
      process.execPath,
      [path.join(scripts, 'control', 'server.mjs'), '--project', root, '--port', String(port)],
      { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] },
    );
    child.on('error', () => {});
    child.unref();
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    // A simultaneous launcher can win the shared lock; wait for its receipt. Do not fail early when
    // this child loses: the winning launcher can still be probing Codex or recovering projects.
    const deadline = Date.now() + 30000;
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      url = await matchingService(infoPath);
    } while (!url && Date.now() < deadline);
    if (!url) throw new Error(`Switchflow is still starting or needs recovery. Inspect ${stderrPath}`);
  }
  if (port !== 0 && Number(new URL(url).port) !== port)
    throw new Error(
      `The shared board already uses ${url}. Omit -Port to reuse it, or stop that service before changing its port.`,
    );
  const registry = await (await fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(10000) })).json();
  const response = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Switchflow-Token': registry.csrfToken },
    body: JSON.stringify({ projectRoot: root }),
    signal: AbortSignal.timeout(30000),
  });
  const registered = await response.json();
  if (!response.ok) throw new Error(registered.error || `Registration failed with HTTP ${response.status}.`);
  const projectUrl = `${url}/?project=${registered.project.id}`;
  console.log(`Switchflow: ${projectUrl}`);
  if (!noOpen) openBrowser(projectUrl);
  return 0;
}

/** Runs one wrapper invocation; returns its exit code. */
export async function main(argv, { cwd = process.cwd() } = {}) {
  let args = [...argv];
  let projectRoot = invocationRoot(cwd);
  if (args.length >= 1 && same(args[0], 'control', 'browser')) {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      if (same(args[i], '--no-open', '-NoOpen')) options.noOpen = true;
      else if (same(args[i], '--port', '-Port') && i + 1 < args.length) {
        options.port = Number.parseInt(args[++i], 10);
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
          throw new UsageError(`Invalid port ${args[i]}.`);
      } else
        throw new UsageError(
          `Unsupported board option ${args[i]}. Use -Port <port> or -NoOpen; browser-native explicitly opens the legacy board.`,
        );
    }
    return startControl(projectRoot, options);
  }
  if (args.length >= 1 && same(args[0], 'browser-native')) args[0] = 'browser';
  projectRoot = resolveGovernanceRoot(projectRoot);
  const governanceScripts = governanceTools(projectRoot).scriptsDir;
  const readOnlyCommand =
    args.length === 0 ||
    same(args[0], 'doctor', 'flow', 'reviews', '--version', '-V', '--help', '-h', 'help') ||
    (args.length >= 2 &&
      same(args[0], 'task', 'tasks', 'doc', 'docs', 'milestone', 'milestones') &&
      same(args[1], 'view', 'list', 'search'));
  const cliPath = resolveBacklogCli(projectRoot, { requireFork: !readOnlyCommand });

  const isMilestoneList = args.length >= 2 && same(args[0], 'milestone', 'milestones') && same(args[1], 'list');
  const isDocumentFile = args.length >= 2 && same(args[0], 'doc') && contains(args, '--content-file');
  const isTaskDescriptionFile = args.length >= 2 && same(args[0], 'task') && contains(args, '--description-file');
  let isMilestoneScope =
    args.length >= 2 &&
    same(args[0], 'milestone') &&
    (same(args[1], 'view') || (same(args[1], 'edit') && contains(args, '--input-file')));

  if (isMilestoneScope && same(args[1], 'edit')) {
    if (
      ![5, 6].includes(args.length) ||
      !same(args[3], '--input-file') ||
      (args.length === 6 && !same(args[5], '--json'))
    )
      throw new UsageError('Usage: backlog.mjs milestone edit <id> --input-file <UTF-8 JSON file> [--json]');
    args[4] = path.resolve(cwd, args[4]);
    const milestoneInput = JSON.parse(fs.readFileSync(args[4], 'utf8').replace(/^﻿/, ''));
    // Legacy scope revisions carry approval evidence; ordinary metadata JSON uses
    // the native CAS editor directly and shares its task/milestone mutation lock.
    isMilestoneScope =
      milestoneInput !== null &&
      typeof milestoneInput === 'object' &&
      (Object.hasOwn(milestoneInput, 'reason') || Object.hasOwn(milestoneInput, 'approval'));
    if (isMilestoneScope && args.length === 6) args = args.slice(0, 5);
  }

  // Resolve file paths before changing directory, so callers can use their own cwd.
  if (isDocumentFile) {
    if (args.length !== 5 || !same(args[1], 'update') || !same(args[3], '--content-file'))
      throw new UsageError('Usage: backlog.mjs doc update <id> --content-file <UTF-8 body file> (no other options)');
    args[4] = path.resolve(cwd, args[4]);
  }
  if (isTaskDescriptionFile) {
    if (args.length !== 5 || !same(args[1], 'edit') || !same(args[3], '--description-file'))
      throw new UsageError('Usage: backlog.mjs task edit <id> --description-file <UTF-8 body file> (no other options)');
    args[4] = path.resolve(cwd, args[4]);
  }

  const run = (script, ...rest) =>
    exitCode(node([path.join(governanceScripts, script), ...rest], { cwd: projectRoot }));
  if (isMilestoneScope) return run('milestone-scope.mjs', projectRoot, ...args);
  if (isDocumentFile || isTaskDescriptionFile) return run('update-document.mjs', cliPath, projectRoot, ...args);
  if (args.length >= 1 && same(args[0], 'flow')) return run('flow.mjs', cliPath, projectRoot, ...args.slice(1));
  if (args.length >= 1 && same(args[0], 'reviews')) return run('review-outcomes.mjs', projectRoot, ...args.slice(1));
  if (isMilestoneList) return run('check-milestone-progress.mjs', cliPath, projectRoot, ...args);

  // SF-28: outside Windows the fork CLI can lose redirected output beyond 64 KiB, so a one-shot
  // command's output goes through files. MCP keeps its pipes; Windows is unchanged.
  const status =
    process.platform !== 'win32' && !process.stdout.isTTY && !(args.length >= 1 && same(args[0], 'mcp'))
      ? run('cli-output.mjs', cliPath, ...args)
      : exitCode(node([cliPath, ...args], { cwd: projectRoot }));
  if (status === 0 && args.length === 1 && same(args[0], 'doctor'))
    return run('check-ready-dependencies.mjs', cliPath, projectRoot);
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).then(
    code => (process.exitCode = code),
    error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
