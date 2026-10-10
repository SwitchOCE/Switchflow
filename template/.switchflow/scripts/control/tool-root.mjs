// Where a project's Switchflow tooling lives. A template install carries its own copy in
// .switchflow/ (scripts, the pinned Backlog package, .agents/skills). A plugin install holds only
// data: its tooling is this service's own code, so paths resolve from this file's location.
//
// Generated plugin layout (see workstream A's build): <plugin>/service is a copy of
// .switchflow/scripts, <plugin>/service/workflow-skills holds the skills, <plugin>/bin the
// launchers, and <plugin>/node_modules/backlog.md the Backlog package.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const INSTALL_MODES = Object.freeze(['template', 'plugin']);
export const serviceDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const pluginDir = path.dirname(serviceDir);

/** The install mode `.switchflow/project.json` declares; absent means template. */
export function installMode(metadata) {
  const mode = metadata?.install ?? 'template';
  if (!INSTALL_MODES.includes(mode))
    throw new Error(`Unsupported install "${mode}" in .switchflow/project.json. Use "plugin" or "template".`);
  return mode;
}

function pluginBacklogPackage(env) {
  if (env.SWITCHFLOW_BACKLOG_PACKAGE) return path.resolve(env.SWITCHFLOW_BACKLOG_PACKAGE);
  try {
    return path.dirname(createRequire(import.meta.url).resolve('backlog.md/package.json'));
  } catch {
    // Reported where the package is used, with this expected location.
    return path.join(pluginDir, 'node_modules', 'backlog.md');
  }
}

/** The argv that runs a Backlog wrapper script on this platform. */
export function wrapperCommand(script, platform = process.platform) {
  if (script.endsWith('.mjs')) return [process.execPath, script];
  return platform === 'win32'
    ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
    : ['pwsh', '-NoProfile', '-File', script];
}

/**
 * Tooling paths for a project. backlogCommand is the argv workers and the service use to run
 * Backlog; binDir (plugin only) holds the switchflow-backlog launcher workers get on PATH.
 */
export function resolveToolRoot(projectRoot, metadata, { env = process.env, platform = process.platform } = {}) {
  const mode = installMode(metadata);
  if (mode === 'template') {
    const tooling = path.join(path.resolve(projectRoot), '.switchflow');
    const scriptsDir = path.join(tooling, 'scripts');
    const backlogScript = path.join(scriptsDir, 'backlog.ps1');
    return {
      mode,
      backlogPackageDir: path.join(tooling, 'node_modules', 'backlog.md'),
      backlogPackageJson: path.join(tooling, 'package.json'),
      backlogScript,
      backlogCommand: wrapperCommand(backlogScript, platform),
      checkReadyScript: path.join(scriptsDir, 'check-ready-dependencies.mjs'),
      scriptsDir,
      workflowSkillsDir: path.join(path.resolve(projectRoot), '.agents', 'skills'),
      binDir: null,
    };
  }
  const backlogScript = path.join(serviceDir, 'backlog.mjs');
  return {
    mode,
    backlogPackageDir: pluginBacklogPackage(env),
    backlogPackageJson: null,
    backlogScript,
    backlogCommand: wrapperCommand(backlogScript, platform),
    checkReadyScript: path.join(serviceDir, 'check-ready-dependencies.mjs'),
    scriptsDir: serviceDir,
    workflowSkillsDir: path.join(serviceDir, 'workflow-skills'),
    binDir: path.join(pluginDir, 'bin'),
  };
}

/** Reads `.switchflow/project.json` (absent means a template install) and resolves the tool root. */
export async function readToolRoot(projectRoot, options) {
  let metadata = {};
  try {
    metadata = JSON.parse(await fs.readFile(path.join(projectRoot, '.switchflow', 'project.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolveToolRoot(projectRoot, metadata, options);
}

/** The Backlog command a worker types in its shell. */
export const workerBacklogCommand = toolRoot =>
  toolRoot?.mode === 'plugin' ? 'switchflow-backlog' : '.switchflow/scripts/backlog.ps1';

/** env with binDir first on PATH (whatever case Windows gave the key). */
export function withToolPath(env, binDir, platform = process.platform) {
  if (!binDir) return env;
  const key = Object.keys(env).find(name => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH'));
  const current = key ? env[key] : '';
  const delimiter = platform === 'win32' ? ';' : ':';
  return { ...env, [key || 'PATH']: current ? `${binDir}${delimiter}${current}` : binDir };
}
