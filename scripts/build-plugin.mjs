// Writes the generated plugin folders from the template, which stays the source of truth:
//   template/.switchflow/scripts/**  -> plugin/service/
//   template/.agents/skills/**       -> plugin/service/workflow-skills/
//   the rest of template/            -> plugin/project-template/
// Usage: node scripts/build-plugin.mjs [--check]
// --check writes nothing and exits 1 listing every file that differs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const outputs = ['plugin/service', 'plugin/project-template'];
const projectExclusions = [
  '.switchflow/scripts',
  '.switchflow/node_modules',
  '.switchflow/package.json',
  '.switchflow/package-lock.json',
  '.agents/skills',
  'Start Switchflow.cmd',
  '.github',
];

const toPosix = value => value.split(path.sep).join('/');
const under = (relative, prefix) => relative === prefix || relative.startsWith(prefix + '/');
const ignoredFolder = relative => relative.split('/').includes('node_modules');

async function walk(directory, base = directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push(toPosix(path.relative(base, full)));
  }
  return files;
}

// Tracked and untracked files that Git does not ignore, so local build products never ship.
// Outside a Git checkout every file is taken.
async function sourceFiles(root, relative) {
  const directory = path.join(root, relative);
  let listed;
  try {
    listed = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z', '--', relative], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean)
      .map(file => path.posix.relative(toPosix(relative), file));
  } catch {
    listed = await walk(directory);
  }
  const files = [];
  for (const file of new Set(listed)) {
    if (ignoredFolder(file)) continue;
    try {
      if ((await fs.lstat(path.join(directory, file))).isFile()) files.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

// Returns Map<output-relative path, absolute source path>, sorted.
export async function planBuild(root = defaultRoot) {
  const plan = new Map();
  for (const file of await sourceFiles(root, 'template/.switchflow/scripts'))
    plan.set(`plugin/service/${file}`, path.join(root, 'template', '.switchflow', 'scripts', file));
  for (const file of await sourceFiles(root, 'template/.agents/skills'))
    plan.set(`plugin/service/workflow-skills/${file}`, path.join(root, 'template', '.agents', 'skills', file));
  for (const file of await sourceFiles(root, 'template')) {
    if (projectExclusions.some(prefix => under(file, prefix))) continue;
    plan.set(`plugin/project-template/${file}`, path.join(root, 'template', file));
  }
  return new Map([...plan].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function readOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Lists { kind: 'missing' | 'changed' | 'stale', file } for every output file that differs.
export async function diffBuild(root = defaultRoot, plan) {
  plan ||= await planBuild(root);
  const differences = [];
  for (const [file, source] of plan) {
    const current = await readOrNull(path.join(root, file));
    if (!current) differences.push({ kind: 'missing', file });
    else if (!current.equals(await fs.readFile(source))) differences.push({ kind: 'changed', file });
  }
  for (const output of outputs)
    for (const file of await walk(path.join(root, output))) {
      const relative = `${output}/${file}`;
      if (!plan.has(relative)) differences.push({ kind: 'stale', file: relative });
    }
  return differences.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

async function removeEmptyFolders(directory, keep) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries)
    if (entry.isDirectory()) await removeEmptyFolders(path.join(directory, entry.name), false);
  if (!keep && (await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
}

export async function build(root = defaultRoot) {
  const plan = await planBuild(root);
  const differences = await diffBuild(root, plan);
  for (const { kind, file } of differences) {
    const target = path.join(root, file);
    if (kind === 'stale') {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(plan.get(file), target);
  }
  for (const output of outputs) await removeEmptyFolders(path.join(root, output), true);
  return differences;
}

export async function main(argv = process.argv.slice(2), root = defaultRoot) {
  if (argv.some(arg => arg !== '--check')) throw new Error('Usage: node scripts/build-plugin.mjs [--check]');
  if (argv.includes('--check')) {
    const differences = await diffBuild(root);
    if (!differences.length) {
      console.log('Plugin output is up to date.');
      return 0;
    }
    for (const { kind, file } of differences) console.log(`${kind}: ${file}`);
    console.log(`Plugin output is out of date (${differences.length}). Run: node scripts/build-plugin.mjs`);
    return 1;
  }
  const differences = await build(root);
  console.log(`Plugin output written (${differences.length} change${differences.length === 1 ? '' : 's'}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    code => (process.exitCode = code),
    error => {
      console.error(error.message);
      process.exitCode = 2;
    },
  );
