import { spawn } from 'node:child_process';

/**
 * This PC: today's behaviour. Providers spawn their CLIs exactly as before, the worker works in
 * the local candidate worktree itself, so there is nothing to collect or clean up.
 */
export function createLocalEnvironment({ spawnProcess = spawn } = {}) {
  return Object.freeze({
    id: 'local',
    kind: 'local',
    label: 'This PC',
    capabilities: Object.freeze({
      stream: true,
      steer: true,
      interrupt: true,
      followUp: true,
      result: 'local-worktree',
    }),
    executables: null,
    async health() {
      return { ok: true, reason: null };
    },
    async prepareWorkspace({ repo }) {
      return { path: repo, temporaryRoot: null, writableRoots: [repo], local: true };
    },
    /** The providers' own default; returned so callers can treat every interactive kind alike. */
    spawnFor() {
      return spawnProcess;
    },
    async collect() {
      return { changed: false, head: null };
    },
    async cleanup() {},
  });
}
