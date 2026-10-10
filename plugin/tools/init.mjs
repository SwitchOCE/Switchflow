// Creates a plugin-mode Switchflow project: a port of scripts/import-switchflow.ps1 and
// scripts/install-rendered-template.ps1 that installs project data only. The control service,
// backlog runtime and workflow skills stay in the plugin.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPrimaryCheckout,
  git,
  isInside,
  lstatOrNull,
  pluginRoot,
  pluginVersion,
  samePath,
  toPluginAgents,
  writeJsonText,
} from './lib.mjs';

export const marketplaceName = 'switchflow';
export const marketplaceSource = { source: { source: 'github', repo: 'SwitchOCE/Switchflow' } };
export const pluginId = 'switchflow@switchflow';

// Transient build and tooling directories are never part of the template.
const excludedDirectories = ['node_modules', '.git', '.venv', '__pycache__', '.tmp'];
// Template-mode runtime that plugin projects never hold. Applied here so the generated
// plugin/project-template and the repository's template/ both work as roots.
export function isPluginExcluded(relative) {
  const parts = relative.split(/[\\/]+/);
  const [first, second] = parts;
  if (first === '.github') return true;
  if (parts.length === 1 && first === 'Start Switchflow.cmd') return true;
  if (first === '.agents' && second === 'skills') return true;
  if (first === '.switchflow') {
    if (second === 'scripts' || second === 'node_modules') return true;
    if (parts.length === 2 && /^package.*\.json$/.test(second)) return true;
  }
  return false;
}

const gitignoreMarker = '# Switchflow local tooling';
const gitignoreBlock = [
  '# Switchflow local tooling',
  '/.switchflow/node_modules/',
  '/backlog/milestones/*.scope-lock',
  '/backlog/milestones/*.tmp',
].join('\n');

const usage =
  'Usage: node init.mjs --target <dir> --project-name <name> --task-prefix <PREFIX> [--owner <name>] [--repo-url <url>] [--phase <phase>] [--initialize-git] [--share] [--template-root <dir>]';

export function parseArgs(argv) {
  const values = { owner: 'Project owner', repoUrl: '', phase: 'Discovery', initializeGit: false, share: false };
  const names = {
    '--target': 'target',
    '--project-name': 'projectName',
    '--task-prefix': 'taskPrefix',
    '--owner': 'owner',
    '--repo-url': 'repoUrl',
    '--phase': 'phase',
    '--template-root': 'templateRoot',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--initialize-git') values.initializeGit = true;
    else if (arg === '--share') values.share = true;
    else if (arg === '--help' || arg === '-h') values.help = true;
    else if (names[arg]) {
      if (index + 1 >= argv.length) throw new Error(`${arg} needs a value.\n${usage}`);
      values[names[arg]] = argv[++index];
    } else throw new Error(`Unknown argument ${arg}.\n${usage}`);
  }
  return values;
}

function assertTemplateText(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must contain visible text.`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new Error(`${name} must be a single-line value without control characters.`);
  if (/\{\{[A-Z0-9_]+\}\}/.test(value)) throw new Error(`${name} contains reserved Switchflow template-token syntax.`);
}

const isBinary = buffer => buffer.subarray(0, 8192).includes(0);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(root) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk('');
  return files.sort();
}

// Looks like the Switchflow source repository: the maintainer importer next to the template.
function switchflowRepositoryAncestor(target) {
  for (let cursor = path.resolve(target); ; cursor = path.dirname(cursor)) {
    if (
      lstatOrNull(path.join(cursor, 'scripts', 'import-switchflow.ps1')) &&
      lstatOrNull(path.join(cursor, 'template', 'AGENTS.md'))
    )
      return cursor;
    if (path.dirname(cursor) === cursor) return null;
  }
}

function templateProvenance(sourceRoot) {
  // Archives and unavailable Git leave provenance unknown. Never attribute an unpacked copy to
  // an enclosing repository, or label dirty input clean.
  if (!lstatOrNull(path.join(sourceRoot, '.git'))) return { templateRevision: null, templateDirty: null };
  const revision = git(sourceRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })?.trim();
  if (!revision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))
    return { templateRevision: null, templateDirty: null };
  const status = git(
    sourceRoot,
    ['status', '--porcelain', '--untracked-files=all', '--', 'plugin', 'template', 'scripts', 'VERSION'],
    { allowFailure: true },
  );
  return { templateRevision: revision, templateDirty: status === null ? null : status.trim().length > 0 };
}

function readExisting(file) {
  const stat = lstatOrNull(file);
  if (!stat) return null;
  return fs.readFileSync(file);
}

export function mergeShareSettings(existingText, warnings = []) {
  let settings = {};
  if (existingText !== null && existingText.trim()) {
    try {
      settings = JSON.parse(existingText);
    } catch (error) {
      throw new Error(`.claude/settings.json is not valid JSON; fix it before sharing: ${error.message}`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('.claude/settings.json must hold a JSON object.');
  }
  const objectKey = key => {
    const value = settings[key];
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`.claude/settings.json ${key} must be an object.`);
    return value;
  };
  const marketplaces = objectKey('extraKnownMarketplaces');
  const enabled = objectKey('enabledPlugins');
  if (marketplaces[marketplaceName] === undefined) marketplaces[marketplaceName] = marketplaceSource;
  else if (JSON.stringify(marketplaces[marketplaceName]) !== JSON.stringify(marketplaceSource))
    warnings.push(
      `Kept the existing extraKnownMarketplaces.${marketplaceName} entry; it points somewhere other than SwitchOCE/Switchflow.`,
    );
  enabled[pluginId] = true;
  return { ...settings, extraKnownMarketplaces: marketplaces, enabledPlugins: enabled };
}

function checkDestinations(targetRoot, destinations) {
  // Validate every existing ancestor before the first write. A leaf-only collision check misses
  // files where directories are needed and links that redirect writes outside the project.
  const checked = new Set();
  for (const destination of destinations) {
    let cursor = destination;
    let leaf = true;
    while (cursor) {
      const key = process.platform === 'win32' ? cursor.toLowerCase() : cursor;
      if (!checked.has(key)) {
        checked.add(key);
        const stat = lstatOrNull(cursor);
        if (stat) {
          if (stat.isSymbolicLink()) throw new Error(`Import destination uses a linked path: ${cursor}`);
          if (!leaf && !stat.isDirectory()) throw new Error(`Import requires a directory but found a file: ${cursor}`);
          if (leaf && stat.isDirectory()) throw new Error(`Import requires a file but found a directory: ${cursor}`);
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
      leaf = false;
    }
  }
}

function assertNotLinked(destination) {
  for (let cursor = destination; ; cursor = path.dirname(cursor)) {
    if (lstatOrNull(cursor)?.isSymbolicLink()) throw new Error(`Import destination uses a linked path: ${cursor}`);
    if (path.dirname(cursor) === cursor) return;
  }
}

// Port of install-rendered-template.ps1. Files are staged beside the target on the same volume
// so each leaf installs by an atomic rename; a journal written before the first move survives a
// killed process, and a failure rolls back every file that still matches what was installed.
export function installRenderedFiles(targetRoot, files, hooks = {}) {
  const parent = path.dirname(targetRoot);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, '.switchflow-import-' + crypto.randomUUID().replaceAll('-', ''));
  fs.mkdirSync(stage);
  const entries = [];
  const installed = [];
  let keepRecovery = false;
  try {
    for (const [index, file] of files.entries()) {
      const source = path.join(stage, 'files', file.relativePath);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, file.bytes ?? file.content);
      const destination = path.join(targetRoot, file.relativePath);
      let originalHash = null;
      let original = null;
      if (lstatOrNull(destination)) {
        if (!file.replaces) throw new Error(`Import destination appeared during staging: ${destination}`);
        if (file.originalBytes === null || !fs.readFileSync(destination).equals(file.originalBytes))
          throw new Error(`Destination changed during rendering: ${destination}`);
        originalHash = hash(destination);
        original = path.join(stage, 'originals', String(index));
        fs.mkdirSync(path.dirname(original), { recursive: true });
        fs.copyFileSync(destination, original);
      } else if (file.replaces && file.originalBytes !== null)
        throw new Error(`Destination removed during rendering: ${destination}`);
      entries.push({ source, destination, hash: hash(source), originalHash, original });
    }
    const manifest = {
      target: targetRoot,
      createdAt: new Date().toISOString(),
      files: entries,
      recovery:
        'Compare destination hashes before removing imported files. Preserve differing files. Restore an original only when the destination matches its staged hash. Empty directories may remain. Never remove unrelated files.',
    };
    fs.writeFileSync(path.join(stage, 'recovery.json'), JSON.stringify(manifest, null, 2));
    for (const entry of entries) {
      hooks.beforeMove?.(entry, installed.length);
      assertNotLinked(entry.destination);
      fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
      assertNotLinked(entry.destination);
      if (entry.originalHash !== null) {
        if (hash(entry.destination) !== entry.originalHash)
          throw new Error(`Destination changed during import: ${entry.destination}`);
        fs.renameSync(entry.source, entry.destination);
      } else {
        if (lstatOrNull(entry.destination))
          throw new Error(`Import destination appeared during staging: ${entry.destination}`);
        fs.renameSync(entry.source, entry.destination);
      }
      installed.push(entry);
    }
  } catch (failure) {
    for (const entry of [...installed].sort((a, b) => b.destination.localeCompare(a.destination))) {
      try {
        assertNotLinked(entry.destination);
        if (hash(entry.destination) !== entry.hash) throw new Error('Imported file changed; preserving it.');
        if (entry.originalHash !== null) {
          const restore = entry.original + '.restore';
          fs.copyFileSync(entry.original, restore);
          fs.renameSync(restore, entry.destination);
        } else fs.unlinkSync(entry.destination);
      } catch (error) {
        keepRecovery = true;
        process.emitWarning(`Could not roll back ${entry.destination}: ${error.message}`);
      }
    }
    if (keepRecovery) process.emitWarning(`Import recovery files retained at ${stage}`);
    throw failure;
  } finally {
    if (!keepRecovery) {
      const resolved = path.resolve(stage);
      if (
        !samePath(path.dirname(resolved), parent) ||
        !/^\.switchflow-import-[a-f0-9]{32}$/.test(path.basename(resolved))
      )
        throw new Error('Unsafe staging cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

export function init(options, hooks = {}) {
  const {
    target,
    projectName,
    taskPrefix,
    owner = 'Project owner',
    repoUrl = '',
    phase = 'Discovery',
    initializeGit = false,
    share = false,
  } = options;
  if (!target) throw new Error(`--target is required.\n${usage}`);
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(taskPrefix ?? ''))
    throw new Error('TaskPrefix must be 2 to 8 capital letters or digits, starting with a letter.');
  assertTemplateText('ProjectName', projectName);
  assertTemplateText('OwnerName', owner);
  assertTemplateText('ProjectPhase', phase);
  if (repoUrl.trim()) assertTemplateText('RepoUrl', repoUrl);

  const templateRoot = path.resolve(options.templateRoot ?? path.join(pluginRoot, 'project-template'));
  if (!lstatOrNull(templateRoot)?.isDirectory()) throw new Error(`Template root not found: ${templateRoot}`);
  const targetRoot = path.resolve(target);
  if (path.dirname(targetRoot) === targetRoot) throw new Error('The target may not be a filesystem root.');

  const sourceRoot = path.dirname(pluginRoot);
  const repository = switchflowRepositoryAncestor(targetRoot);
  if (
    repository !== null ||
    isInside(targetRoot, pluginRoot) ||
    isInside(targetRoot, templateRoot) ||
    (lstatOrNull(path.join(sourceRoot, '.claude-plugin', 'marketplace.json')) && isInside(targetRoot, sourceRoot))
  )
    throw new Error('Import into a separate project, not into the Switchflow repository.');

  const targetParent = path.dirname(targetRoot);
  if (lstatOrNull(targetParent)?.isDirectory()) {
    for (const prior of fs.readdirSync(targetParent, { withFileTypes: true })) {
      if (!prior.isDirectory() || !prior.name.startsWith('.switchflow-import-')) continue;
      const journal = path.join(targetParent, prior.name, 'recovery.json');
      if (!lstatOrNull(journal)?.isFile()) continue;
      let recovery = null;
      try {
        recovery = JSON.parse(fs.readFileSync(journal, 'utf8').replace(/^﻿/, ''));
      } catch {
        // An unreadable journal could belong to this target; treat it as one.
      }
      if (recovery === null || samePath(String(recovery.target ?? ''), targetRoot))
        throw new Error(
          `An interrupted import needs reconciliation before retrying. Inspect ${journal} and preserve files whose hashes differ.`,
        );
    }
  }

  // Governance belongs to the checkout owning the common Git directory. Importing into a linked
  // code worktree would create a second mutable board.
  if (lstatOrNull(path.join(targetRoot, '.git'))) assertPrimaryCheckout(targetRoot, 'importing governance');

  if (repoUrl.trim()) {
    let url = null;
    try {
      url = new URL(repoUrl);
    } catch {
      // Reported below.
    }
    if (!url || !['http:', 'https:'].includes(url.protocol))
      throw new Error('RepoUrl must be an absolute HTTP or HTTPS URL.');
  }

  const version = pluginVersion();
  const { templateRevision, templateDirty } = templateProvenance(sourceRoot);
  const tokens = [
    ['{{PROJECT_NAME_YAML_SINGLE}}', projectName.replaceAll("'", "''")],
    ['{{OWNER_NAME_YAML_SINGLE}}', owner.replaceAll("'", "''")],
    ['{{PROJECT_NAME_YAML_DOUBLE}}', JSON.stringify(projectName).slice(1, -1)],
    ['{{PROJECT_NAME}}', projectName],
    ['{{TASK_PREFIX}}', taskPrefix],
    ['{{OWNER_NAME}}', owner],
    ['{{PROJECT_PHASE}}', phase],
    ['{{REPOSITORY_DISPLAY}}', repoUrl.trim() ? repoUrl : 'Not configured.'],
  ];

  const files = [];
  const transient = [];
  const notes = [];
  for (const relativePath of listFiles(templateRoot)) {
    const segments = relativePath.split(/[\\/]+/);
    const transientSegment = segments.find(segment => excludedDirectories.includes(segment));
    if (transientSegment) {
      transient.push(transientSegment);
      continue;
    }
    if (isPluginExcluded(relativePath)) continue;
    const bytes = fs.readFileSync(path.join(templateRoot, relativePath));
    // Binary files are copied verbatim; substitution would corrupt them.
    if (isBinary(bytes)) {
      files.push({ relativePath, bytes });
      continue;
    }
    let content = bytes.toString('utf8').replace(/^﻿/, '');
    for (const [token, value] of tokens) content = content.replaceAll(token, value);
    if (/\{\{[A-Z0-9_]+\}\}/.test(content)) throw new Error(`Unresolved template token in ${relativePath}`);
    if (relativePath === 'AGENTS.md') {
      const agents = toPluginAgents(content, taskPrefix);
      content = agents.text;
      if (agents.commands === 'kept') notes.push('AGENTS.md Commands section was left as written in the template.');
    }
    files.push({ relativePath, content });
  }
  if (transient.length)
    process.emitWarning(
      `Skipped ${transient.length} file(s) in transient directories under the template (${[...new Set(transient)].sort().join(', ')}). These are never imported.`,
    );
  if (!files.length) throw new Error(`No template files were found under ${templateRoot}.`);

  const projectConfigRelative = path.join('.switchflow', 'project.json');
  const collisions = files
    .map(file => file.relativePath)
    .filter(relative => lstatOrNull(path.join(targetRoot, relative)));
  if (lstatOrNull(path.join(targetRoot, projectConfigRelative))) collisions.push(projectConfigRelative);
  if (collisions.length)
    throw new Error(`Import would overwrite existing governance files:\n- ${collisions.join('\n- ')}`);

  const gitignorePath = path.join(targetRoot, '.gitignore');
  const settingsRelative = path.join('.claude', 'settings.json');
  const settingsPath = path.join(targetRoot, settingsRelative);
  checkDestinations(targetRoot, [
    ...files.map(file => path.join(targetRoot, file.relativePath)),
    path.join(targetRoot, projectConfigRelative),
    gitignorePath,
    ...(share ? [settingsPath] : []),
  ]);

  const projectConfig = {
    schemaVersion: 1,
    install: 'plugin',
    templateVersion: version,
    templateRevision,
    templateDirty,
    projectName,
    taskPrefix,
    ownerName: owner,
    repositoryUrl: repoUrl,
    projectPhase: phase,
  };
  files.push({ relativePath: projectConfigRelative, content: writeJsonText(projectConfig) });

  const originalGitignore = readExisting(gitignorePath);
  const existingGitignore = originalGitignore ? originalGitignore.toString('utf8').replace(/^﻿/, '') : '';
  if (!existingGitignore.includes(gitignoreMarker)) {
    const separator = existingGitignore.trim() ? '\n' : '';
    files.push({
      relativePath: '.gitignore',
      content: existingGitignore.replace(/[\r\n]+$/, '') + separator + gitignoreBlock + '\n',
      replaces: true,
      originalBytes: originalGitignore,
    });
  }

  const warnings = [];
  if (share) {
    const originalSettings = readExisting(settingsPath);
    const merged = mergeShareSettings(
      originalSettings ? originalSettings.toString('utf8').replace(/^﻿/, '') : null,
      warnings,
    );
    files.push({
      relativePath: settingsRelative,
      content: writeJsonText(merged),
      replaces: true,
      originalBytes: originalSettings,
    });
  }

  if (initializeGit && !lstatOrNull(path.join(targetRoot, '.git'))) {
    fs.mkdirSync(targetRoot, { recursive: true });
    git(targetRoot, ['init', '-b', 'main']);
  }

  installRenderedFiles(targetRoot, files, hooks);
  return { targetRoot, version, files: files.map(file => file.relativePath), warnings: [...warnings, ...notes] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      const result = init(options);
      for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
      console.log(`Imported Switchflow ${result.version} (plugin mode) into ${result.targetRoot}`);
      console.log(
        'Next: edit the project profile in backlog/docs, then run `switchflow-backlog doctor` and `switchflow-backlog check-docs`.',
      );
      if (options.share)
        console.log('Commit .claude/settings.json so collaborators are offered the Switchflow plugin.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
