import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProject, readState, updateState, withLock, assertSafePath } from '../operations/storage.mjs';
import { isRunProcessAlive } from './codex-runner.mjs';
import { ControlError } from './lifecycle.mjs';

export function sharedServiceContext(context) {
  return { stateDir: path.join(path.dirname(path.dirname(context.stateDir)), 'control-service') };
}

// A code worktree is an alias for its primary governance checkout, never a
// second board or a second orchestration context.
export async function canonicalProject(projectRoot, serviceContext) {
  const options = serviceContext ? { stateHome: path.dirname(serviceContext.stateDir) } : {};
  const found = await resolveProject(projectRoot, options);
  const context = await resolveProject(found.governanceRoot, options);
  const root = context.governanceRoot;
  for (const relative of ['.switchflow/project.json']) {
    try { await assertSafePath(root, path.join(root, relative)); await fs.access(path.join(root, relative)); }
    catch { throw new ControlError(`The primary checkout is missing ${relative}. Restore its governance installation before opening this project.`, 409); }
  }
  const metadata = JSON.parse(await fs.readFile(path.join(root, '.switchflow', 'project.json'), 'utf8'));
  if (!/^0\.5\.\d+$/.test(metadata.templateVersion || '')) {
    throw new ControlError('Update this project to Switchflow 0.5.x before adding it to the shared workspace. Mixing older task writers would bypass dependency and milestone rules.', 409);
  }
  let configured = false;
  for (const relative of ['backlog.config.yml', 'backlog/config.yml']) {
    try { await assertSafePath(root, path.join(root, relative)); if ((await fs.stat(path.join(root, relative))).isFile()) configured = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!configured) throw new ControlError('The primary checkout is missing its Backlog configuration. Restore its governance installation before opening this project.', 409);
  return context;
}

export async function acquireProjectService(context) {
  const lockPath = await assertSafePath(context.stateDir, path.join(context.stateDir, 'service.lock'));
  return withLock(context, 'service-recovery', async () => {
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || isRunProcessAlive(owner.pid)) {
        throw new ControlError('This project already has a running service, or its owner is uncertain. Stop the prior service before attaching it to the shared board.', 409);
      }
      await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return async () => { await handle.close(); await fs.unlink(lockPath); };
  });
}

export class ProjectRegistry {
  constructor(context) { this.context = context; }
  async read() {
    const value = await readState(this.context, 'projects', { schemaVersion: 1, projects: [] });
    if (value.schemaVersion !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported project registry. Preserve it before recovery.');
    return value.projects;
  }
  async remember(context, name) {
    await updateState(this.context, 'projects', value => {
      if (value.schemaVersion !== 1 || !Array.isArray(value.projects)) throw new Error('Unsupported project registry.');
      const entry = { id: context.id, root: context.governanceRoot, name };
      const index = value.projects.findIndex(project => project.id === context.id);
      if (index < 0) value.projects.push(entry); else value.projects[index] = entry;
      return value;
    }, { schemaVersion: 1, projects: [] });
  }
}
