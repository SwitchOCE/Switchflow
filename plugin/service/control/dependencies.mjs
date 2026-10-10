// Shared dependency folders for candidate worktrees: the opt-in `dependencies` setting of
// .switchflow/capacity.json. See docs/browser-control.md "Capacity".
//
// A worktree whose npm lockfile matches a store gets its node_modules from that store instead of
// an install. A store is one copy of the primary checkout's folders for one lockfile, made once,
// sealed read-only and checked against its manifest before each use. The worktree keeps a real
// node_modules folder of its own whose entries are junctions (Windows) or symlinks into the store,
// so caches and new entries stay in the worktree. Nothing ever links to the primary's own folder,
// so no worktree can change the primary's dependencies. Anything unexpected leaves the worktree
// for a normal install, with the reason.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSafePath, readState, updateState } from '../operations/storage.mjs';

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];
/** Caches tools write into node_modules. Never shared: each worktree starts without them, as after an install. */
const CACHES = new Set(['.cache', '.vite', '.vite-temp', '.vitest']);
const FOLDER = /^(?:[A-Za-z0-9._@-]+\/)*node_modules$/;
const NAME = /^[A-Za-z0-9._@-]{1,214}$/;
const STORE_ID = /^[a-f0-9]{16}-[a-f0-9]{8}$/;
const STATE = 'dependency-stores';
const EMPTY = { schemaVersion: 1, stores: {} };
/** How long a create waits for a new store before the worktree falls back to an install. */
export const BUILD_WAIT_MS = 45000;
/** How often a store's files are re-checked in full; its listing is checked before every use. */
const FULL_CHECK_MS = 10 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
const windows = process.platform === 'win32';
const execFile = promisify(execFileCallback);
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const join = (root, relative) => path.join(root, ...relative.split('/'));
const posix = value => value.split(path.sep).join('/');
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const NOTE =
  'node_modules links to a shared read-only copy; caches are written inside the worktree as usual. To change dependencies, delete node_modules first (only the links go), then install.';

class Refusal extends Error {}
/** POSIX permissions do not stop root, so a service running as root never shares. */
const rootUser = () => !windows && process.getuid?.() === 0;
const ROOT = 'the service runs as root, which read-only permissions cannot stop, so nothing is shared';

/** Validates capacity.json `dependencies`; `invalid` builds the profile error. */
export function validateDependencies(value, invalid) {
  if (!plain(value)) throw invalid('dependencies must be an object.');
  const extra = Object.keys(value).filter(key => !['mode', 'paths', 'private'].includes(key));
  if (extra.length) throw invalid(`unsupported field dependencies.${extra[0]}.`);
  if (!['link', 'off'].includes(value.mode)) throw invalid('dependencies.mode must be "link" or "off".');
  const paths = value.paths ?? ['node_modules'];
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 8 ||
    new Set(paths).size !== paths.length ||
    !paths.includes('node_modules') ||
    paths.some(
      item =>
        typeof item !== 'string' ||
        item.length > 200 ||
        !FOLDER.test(item) ||
        item.split('/').some(part => part === '.' || part === '..'),
    )
  )
    throw invalid(
      'dependencies.paths must list 1 to 8 distinct relative folders named node_modules, including "node_modules".',
    );
  const names = value.private ?? [];
  if (
    !Array.isArray(names) ||
    names.length > 32 ||
    names.some(name => typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..')
  )
    throw invalid('dependencies.private must list at most 32 top-level names in node_modules.');
  return { mode: value.mode, paths: [...paths], private: [...new Set(names)] };
}

async function readLockfile(root) {
  for (const name of LOCKFILES)
    try {
      const bytes = await fs.readFile(path.join(root, name));
      // Git may check a lockfile out with CRLF while npm wrote the primary's with LF.
      return { name, text: bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n') };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  return null;
}

const sorted = value =>
  Array.isArray(value)
    ? value.map(sorted)
    : plain(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, sorted(value[key])]),
        )
      : value;

/**
 * Whether an installed tree is what its lockfile describes: npm's hidden lockfile
 * (node_modules/.package-lock.json, written after each install) must agree with every entry, and
 * only optional packages (other platforms' binaries) may be absent. Returns the reason when not.
 */
export function installedTreeMismatch(lockText, hiddenText) {
  let lock;
  let hidden;
  try {
    lock = JSON.parse(lockText);
    hidden = JSON.parse(hiddenText);
  } catch {
    return 'the lockfile or node_modules/.package-lock.json is not valid JSON';
  }
  if (!plain(lock?.packages) || !plain(hidden?.packages))
    return 'the lockfile has no "packages" section (npm 7 or later writes one)';
  const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  for (const [key, entry] of Object.entries(hidden.packages))
    if (key && !same(entry, lock.packages[key])) return `the installed ${key} differs from the lockfile`;
  for (const [key, entry] of Object.entries(lock.packages))
    if (key && !(key in hidden.packages) && !entry?.optional && !entry?.devOptional)
      return `${key} is in the lockfile but not installed`;
  return null;
}

/**
 * Identifies the primary's current install. Its hidden lockfile must match the lockfile; a
 * reinstall writes a new one, which makes a new store generation.
 */
async function sourceStamp(primary, lockfile) {
  const current = await readLockfile(primary);
  if (current?.name !== lockfile.name || current.text !== lockfile.text)
    throw new Refusal("the worktree's lockfile differs from the primary checkout's");
  const hiddenPath = path.join(primary, 'node_modules', '.package-lock.json');
  let hidden;
  let info;
  try {
    if (!(await fs.lstat(path.join(primary, 'node_modules'))).isDirectory())
      throw new Refusal("the primary checkout's node_modules is not a folder");
    [hidden, info] = await Promise.all([fs.readFile(hiddenPath, 'utf8'), fs.stat(hiddenPath)]);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (missing(error)) throw new Refusal('the primary checkout has no npm install (node_modules/.package-lock.json)');
    throw error;
  }
  const mismatch = installedTreeMismatch(lockfile.text, hidden);
  if (mismatch) throw new Refusal(`the primary checkout's install is out of date: ${mismatch}`);
  return sha(`${hidden}\0${info.mtimeMs}`).slice(0, 8);
}

/** Runs fs calls with bounded concurrency; recursion itself never holds a slot. */
function limiter(size = 48) {
  let active = 0;
  const waiting = [];
  return async work => {
    while (active >= size) await new Promise(resolve => waiting.push(resolve));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Junctions need no privilege on Windows and take absolute targets. */
const link = (target, location) => fs.symlink(target, location, windows ? 'junction' : 'dir');
const linkTarget = async location => path.resolve(path.dirname(location), await fs.readlink(location));

/**
 * A store folder's seal. `listing` covers every entry's name and kind and every link's target;
 * with `full`, `manifest` adds file sizes and `problems` names anything writable (files, and on
 * POSIX folders). A listing reads only folders (about 0.5 s for 67,000 files on Windows); the
 * full check also reads every file's metadata (about 3 s).
 */
async function manifestOf(root, prefix, { full = false, run = limiter() } = {}) {
  const lines = [];
  const problems = [];
  const visit = async (directory, relative) => {
    if (full && !windows && ((await run(() => fs.lstat(directory))).mode & 0o222) !== 0)
      problems.push(`${relative} is writable`);
    const entries = await run(() => fs.readdir(directory, { withFileTypes: true }));
    await Promise.all(
      entries.map(async entry => {
        const location = path.join(directory, entry.name);
        const name = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) lines.push([`${name}\0l\0${posix(await run(() => fs.readlink(location)))}`]);
        else if (entry.isDirectory()) {
          lines.push([`${name}\0d`]);
          await visit(location, name);
        } else if (!entry.isFile()) problems.push(`${name} is not a file, folder or link`);
        else if (!full) lines.push([`${name}\0f`]);
        else {
          const info = await run(() => fs.lstat(location));
          if ((info.mode & 0o222) !== 0) problems.push(`${name} is writable`);
          lines.push([`${name}\0f`, info.size]);
        }
      }),
    );
  };
  await visit(root, prefix);
  const digest = values => sha(values.sort().join('\n'));
  return {
    listing: digest(lines.map(([line]) => line)),
    manifest: full ? digest(lines.map(([line, size]) => (size === undefined ? line : `${line}\0${size}`))) : null,
    bytes: lines.reduce((total, [, size]) => total + (size ?? 0), 0),
    problems,
  };
}

/**
 * Copies one dependency folder of the primary into a new store, read-only. Links inside the
 * folder are re-pointed into the store (at its final location); package entries linking
 * elsewhere in the checkout (npm workspaces) are left out and re-created per worktree; a link
 * leaving the checkout refuses the store.
 */
async function copyFolder({ source, destination, final, primary, folder, workspaceLinks, stats, run }) {
  const readOnly = async (output, mode) => {
    await run(() => fs.chmod(output, mode & 0o7555));
    stats.files++;
  };
  const visit = async (from, to, parts) => {
    await fs.mkdir(to);
    const entries = await run(() => fs.readdir(from, { withFileTypes: true }));
    await Promise.all(
      entries.map(async entry => {
        const name = [...parts, entry.name];
        const label = `${folder}/${name.join('/')}`;
        if (parts.length === 0 && CACHES.has(entry.name)) return;
        const input = path.join(from, entry.name);
        const output = path.join(to, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await run(() => linkTarget(input));
          if (inside(source, target)) {
            const info = await run(() => fs.stat(target));
            const mapped = path.join(final, path.relative(source, target));
            if (!info.isDirectory()) {
              await run(() => fs.copyFile(target, output, constants.COPYFILE_FICLONE));
              return readOnly(output, info.mode);
            }
            // POSIX links stay relative, so they survive the rename from the temporary folder.
            const relative = path.relative(path.join(final, path.relative(destination, to)), mapped);
            await run(() => link(windows ? mapped : relative, output));
            return;
          }
          const packageEntry = parts.length === 0 || (parts.length === 1 && parts[0].startsWith('@'));
          if (packageEntry && inside(primary, target)) {
            workspaceLinks.push({ folder, entry: name.join('/'), target: posix(path.relative(primary, target)) });
            return;
          }
          throw new Refusal(`${label} links outside the checkout`);
        }
        if (entry.isDirectory()) return visit(input, output, name);
        if (!entry.isFile()) throw new Refusal(`${label} is not a file, folder or link`);
        // Windows has only the read-only attribute; POSIX keeps each file's execute bits.
        const mode = windows ? 0o444 : (await run(() => fs.lstat(input))).mode;
        await run(() => fs.copyFile(input, output, constants.COPYFILE_FICLONE));
        return readOnly(output, mode);
      }),
    );
  };
  await visit(source, destination, []);
}

async function folders(root) {
  const found = [root];
  for (const entry of await fs.readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) found.push(...(await folders(path.join(root, entry.name))));
  return found;
}

/**
 * Windows read-only attributes protect file contents only: a folder still accepts new entries and
 * renames (npm's install renames package folders aside, which would rename them in the store),
 * and tools clear the attribute before deleting. So the store's folders also get an inherited
 * deny entry for Everyone on writing, appending, attributes, deleting and adding entries. Reading
 * is unaffected. `grant: false` removes it again. About 15 s for 67,000 files.
 */
export function protect(folder, grant = true) {
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const args = grant
    ? [folder, '/deny', '*S-1-1-0:(OI)(CI)(WD,AD,WEA,WA,DE,DC)', '/Q']
    : [folder, '/remove:d', '*S-1-1-0', '/Q'];
  return execFile(icacls, args, { windowsHide: true, timeout: 10 * 60 * 1000 });
}

/** Makes a sealed store deletable again and deletes it. Links are removed, never followed. */
export async function removeStore(directory, paths = ['node_modules']) {
  try {
    if (windows)
      for (const folder of paths)
        await protect(join(directory, folder), false).catch(error => {
          if (!/cannot find|not find/i.test(`${error.stdout}${error.stderr}`)) throw error;
        });
    const all = await folders(directory);
    const run = limiter();
    if (!windows) await Promise.all(all.map(folder => run(() => fs.chmod(folder, 0o755))));
    for (const folder of all)
      for (const entry of await fs.readdir(folder, { withFileTypes: true }))
        if (entry.isFile()) await run(() => fs.chmod(path.join(folder, entry.name), 0o644));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

/** Copies a store entry into a worktree as its own writable copy. */
async function copyWritable(input, output) {
  const info = await fs.lstat(input);
  if (info.isSymbolicLink()) return link(await linkTarget(input), output);
  if (info.isDirectory()) {
    await fs.mkdir(output);
    for (const name of await fs.readdir(input)) await copyWritable(path.join(input, name), path.join(output, name));
    return;
  }
  await fs.copyFile(input, output, constants.COPYFILE_FICLONE);
  await fs.chmod(output, (info.mode & 0o777) | 0o200);
}

const projects = new Map();
/** The service's one store set per project, so concurrent creates share a build. */
export function dependencyStores(context) {
  if (!projects.has(context.stateDir)) projects.set(context.stateDir, createDependencyStores(context));
  return projects.get(context.stateDir);
}

/** The project's dependency stores, in <stateDir>/dependencies/<lockfile hash>-<random>. */
export function createDependencyStores(context, { buildWaitMs = BUILD_WAIT_MS, fullCheckMs = FULL_CHECK_MS } = {}) {
  const root = path.join(context.stateDir, 'dependencies');
  const building = new Map(); // `${lockHash}-${stamp}` -> promise of the store, or { error }
  const linking = new Set(); // store ids being linked into a worktree right now
  const update = mutate =>
    updateState(
      context,
      STATE,
      value => {
        if (!plain(value.stores)) value.stores = {};
        mutate(value.stores);
      },
      EMPTY,
    );

  const readStore = async id => {
    try {
      const info = JSON.parse(await fs.readFile(path.join(root, id, 'store.json'), 'utf8'));
      return info.schemaVersion === 1 && info.id === id ? info : null;
    } catch {
      return null;
    }
  };
  /** Sealed, undamaged stores for a lockfile, newest first. */
  const generations = async lockHash => {
    let names = [];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const { stores = {} } = await readState(context, STATE, EMPTY);
    const found = [];
    for (const name of names)
      if (STORE_ID.test(name) && name.startsWith(`${lockHash}-`) && !stores[name]?.damaged) {
        const info = await readStore(name);
        if (info) found.push(info);
      }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const seal = async (directory, paths, full) => {
    const run = limiter();
    const results = await Promise.all(paths.map(folder => manifestOf(join(directory, folder), folder, { full, run })));
    const combine = key => sha(results.map(result => result[key]).join('\n'));
    return {
      listing: combine('listing'),
      manifest: full ? combine('manifest') : null,
      bytes: results.reduce((total, result) => total + result.bytes, 0),
      problems: results.flatMap(result => result.problems),
    };
  };
  const checked = new Map(); // store id -> when its full check last passed
  /**
   * Checks a store against its seal before each use: its listing every time, and every file's
   * size and read-only state at most every FULL_CHECK_MS. A damaged store is never used again;
   * worktrees already linked to it keep it until they are gone, then pruning deletes it.
   */
  const verify = async info => {
    const full = !(Date.now() - (checked.get(info.id) ?? -Infinity) < fullCheckMs);
    const result = await seal(path.join(root, info.id), info.paths, full);
    const problem =
      result.problems[0] ??
      (result.listing !== info.listing || (full && result.manifest !== info.manifest)
        ? 'its files changed after it was sealed'
        : null);
    if (problem) await update(stores => void (stores[info.id] = { ...stores[info.id], damaged: problem }));
    else if (full) checked.set(info.id, Date.now());
    return problem;
  };

  async function build({ primary, settings, lockfile, lockHash, stamp }) {
    await fs.mkdir(root, { recursive: true });
    await assertSafePath(context.stateDir, root);
    for (const name of await fs.readdir(root))
      if (name.includes('.tmp-')) {
        const info = await fs.lstat(path.join(root, name)).catch(() => null);
        if (info && Date.now() - info.mtimeMs > STALE_MS)
          await removeStore(path.join(root, name), settings.paths).catch(() => {});
      }
    const id = `${lockHash}-${randomUUID().slice(0, 8)}`;
    const final = path.join(root, id);
    const temporary = `${final}.tmp-${randomUUID()}`;
    await fs.mkdir(temporary);
    const stats = { files: 0 };
    const workspaceLinks = [];
    const run = limiter();
    const started = Date.now();
    try {
      for (const folder of settings.paths) {
        const destination = join(temporary, folder);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await copyFolder({
          source: join(primary, folder),
          destination,
          final: join(final, folder),
          primary,
          folder,
          workspaceLinks,
          stats,
          run,
        });
      }
      // The primary must not have been reinstalled while it was copied.
      if ((await sourceStamp(primary, lockfile)) !== stamp)
        throw new Refusal("the primary checkout's dependencies changed while they were copied");
      if (!windows)
        for (const folder of settings.paths)
          for (const directory of await folders(join(temporary, folder))) await fs.chmod(directory, 0o555);
      const sealed = await seal(temporary, settings.paths, true);
      if (sealed.problems.length) throw new Refusal(`the copy could not be sealed: ${sealed.problems[0]}`);
      const info = {
        schemaVersion: 1,
        id,
        stamp,
        lockfile: lockfile.name,
        paths: settings.paths,
        workspaceLinks,
        listing: sealed.listing,
        manifest: sealed.manifest,
        files: stats.files,
        bytes: sealed.bytes,
        createdAt: new Date().toISOString(),
        buildMs: Date.now() - started,
      };
      // Before the rename, so the store is protected from the moment it can be found.
      if (windows)
        for (const folder of settings.paths)
          await protect(join(temporary, folder)).catch(error => {
            throw new Refusal(`the copy could not be protected (${error.message.split('\n')[0]})`);
          });
      const record = path.join(temporary, 'store.json');
      await fs.writeFile(record, JSON.stringify(info, null, 2), { flag: 'wx' });
      await fs.chmod(record, 0o444);
      if (!windows) for (const folder of await folders(temporary)) await fs.chmod(folder, 0o555);
      await fs.rename(temporary, final);
      checked.set(id, Date.now());
      return info;
    } catch (error) {
      await removeStore(temporary, settings.paths).catch(() => {});
      throw error;
    }
  }

  /** Whether a worktree still links into a store. */
  const linksInto = async (worktree, directory) => {
    const folder = path.join(worktree, 'node_modules');
    try {
      for (const entry of await fs.readdir(folder, { withFileTypes: true }))
        if (entry.isSymbolicLink() && inside(directory, await linkTarget(path.join(folder, entry.name)))) return true;
    } catch {}
    return false;
  };
  /** Deletes every store, other than the newest of each lockfile, that no registered worktree uses. */
  async function prune() {
    const { stores = {} } = await readState(context, STATE, EMPTY);
    const names = (await fs.readdir(root)).filter(name => STORE_ID.test(name));
    const newest = new Map();
    const infos = new Map();
    for (const name of names) {
      const info = await readStore(name);
      infos.set(name, info);
      if (!info || stores[name]?.damaged) continue;
      const lockHash = name.slice(0, 16);
      if (!newest.has(lockHash) || newest.get(lockHash).createdAt < info.createdAt) newest.set(lockHash, info);
    }
    const kept = new Set([...newest.values()].map(info => info.id));
    for (const name of names) {
      if (kept.has(name) || linking.has(name)) continue;
      const directory = path.join(root, name);
      let used = false;
      for (const worktree of stores[name]?.users ?? []) if ((used = await linksInto(worktree, directory))) break;
      if (used) continue;
      try {
        await removeStore(directory, infos.get(name)?.paths);
        await update(entries => void delete entries[name]);
      } catch {
        /* Tried again at the next prune. */
      }
    }
  }

  /**
   * The usable stores for a lockfile, and a store being made from the primary when the primary
   * matches the lockfile and none was made from its current install.
   */
  async function ensure(primary, settings, lockfile) {
    const lockHash = sha(lockfile.text).slice(0, 16);
    const stores = (await generations(lockHash)).filter(
      info => JSON.stringify(info.paths) === JSON.stringify(settings.paths),
    );
    let stamp;
    try {
      stamp = await sourceStamp(primary, lockfile);
    } catch (error) {
      const why = error instanceof Refusal ? error.message : `the primary checkout could not be read: ${error.message}`;
      return { stores, pending: null, why };
    }
    const key = `${lockHash}-${stamp}`;
    if (stores.some(info => info.stamp === stamp)) return { stores, pending: null, why: null };
    if (!building.has(key))
      building.set(
        key,
        build({ primary, settings, lockfile, lockHash, stamp })
          .then(info => prune().then(() => info))
          .catch(error => ({ error }))
          .finally(() => building.delete(key)),
      );
    return { stores, pending: building.get(key), why: null };
  }

  async function materialise(info, worktree, settings) {
    const store = path.join(root, info.id);
    const owned = new Set(settings.private);
    const created = [];
    linking.add(info.id);
    try {
      for (const folder of info.paths) {
        const from = join(store, folder);
        const to = await assertSafePath(worktree, join(worktree, folder));
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.mkdir(to);
        created.push(to);
        const workspace = info.workspaceLinks.filter(item => item.folder === folder);
        const scopes = new Set(
          workspace.filter(item => item.entry.includes('/')).map(item => item.entry.split('/')[0]),
        );
        for (const entry of await fs.readdir(from, { withFileTypes: true })) {
          const input = path.join(from, entry.name);
          const output = path.join(to, entry.name);
          if (owned.has(entry.name) || entry.isFile()) await copyWritable(input, output);
          else if (scopes.has(entry.name)) {
            await fs.mkdir(output);
            for (const child of await fs.readdir(input)) await link(path.join(input, child), path.join(output, child));
          } else if (entry.isSymbolicLink()) await link(await linkTarget(input), output);
          else if (entry.isDirectory()) await link(input, output);
        }
        for (const item of workspace) {
          const output = join(to, item.entry);
          await fs.mkdir(path.dirname(output), { recursive: true });
          await link(join(worktree, item.target), output);
        }
      }
      await update(stores => {
        const entry = (stores[info.id] ??= {});
        entry.users = [...new Set([...(entry.users ?? []), worktree])].slice(-200);
        entry.lastUsedAt = new Date().toISOString();
      });
    } catch (error) {
      // Removing the folder removes only its links; the store is untouched.
      for (const folder of created) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      linking.delete(info.id);
    }
  }

  return {
    root,
    /**
     * Gives a fresh worktree its dependency folders. Never throws; returns
     * { mode, status: "linked" | "install" | "present", store?, reason?, note?, ms }.
     */
    async prepare({ worktree, primary, settings }) {
      const started = Date.now();
      const done = (status, extra) => ({ mode: settings.mode, status, ...extra, ms: Date.now() - started });
      const install = reason => done('install', { reason });
      try {
        for (const folder of settings.paths)
          try {
            await fs.lstat(join(worktree, folder));
            return done('present', { reason: `${folder} already exists in the worktree` });
          } catch (error) {
            if (!missing(error)) throw error;
          }
        const lockfile = await readLockfile(worktree);
        if (!lockfile) return install('the worktree has no package-lock.json or npm-shrinkwrap.json');
        if (rootUser()) return install(ROOT);
        let { stores, pending, why } = await ensure(primary, settings, lockfile);
        let damaged = false;
        for (const info of stores) {
          if (await verify(info)) {
            damaged = true;
            continue;
          }
          await materialise(info, worktree, settings);
          return done('linked', { store: info.id, note: NOTE });
        }
        // A damaged store no longer counts, so the primary's install is copied again.
        if (damaged && !pending) ({ pending, why } = await ensure(primary, settings, lockfile));
        if (!pending) return install(why ?? 'no shared copy exists for this lockfile');
        let timer;
        const made = await Promise.race([
          pending,
          new Promise(resolve => (timer = setTimeout(() => resolve({ timeout: true }), buildWaitMs))),
        ]).finally(() => clearTimeout(timer));
        if (made.timeout)
          return install('the shared copy is still being made from the primary checkout; later worktrees link it');
        if (made.error)
          return install(
            made.error instanceof Refusal
              ? made.error.message
              : `the shared copy could not be made: ${made.error.message}`,
          );
        await materialise(made, worktree, settings);
        return done('linked', { store: made.id, note: NOTE });
      } catch (error) {
        return install(`linking failed: ${error.message}`);
      }
    },
    /** Starts making the primary's store ahead of the first create, when it has none. Never throws. */
    async warm({ primary, settings }) {
      try {
        const lockfile = await readLockfile(primary);
        if (lockfile && !rootUser()) await ensure(primary, settings, lockfile);
      } catch {}
    },
    /** Waits for stores still being made. */
    settle: () => Promise.all(building.values()),
  };
}
