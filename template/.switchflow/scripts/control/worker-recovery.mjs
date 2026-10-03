// Before "resume held workers" starts a run: saves what interrupted SSH workers left on their box.
// The remote agent died with its ssh connection, but its worktree survives there, so each held
// delivery worker's uncommitted changes are committed on the box, fetched to this PC under
// refs/switchflow/recovery/<worker> and recorded in the worker ledger; the resumed worker starts
// from that commit (Orchestration.resume). Cloud workers need nothing here: they are reconnected.
import { readDelegations, updateDelegation } from './worker-ledger.mjs';

export const recoveryRef = workerId => `refs/switchflow/recovery/${workerId}`;

/**
 * Returns { blocked: null } when every held SSH worker's work is saved (or there was none), or
 * { blocked: reason } when a box cannot be reached or its work cannot be saved. Then nothing is
 * resumed, so no work is lost; the owner resumes again once the box answers. Idempotent: a
 * worker already recovered is skipped.
 */
export async function recoverHeldWorkers(host, held) {
  const entries = await readDelegations(
    host.context,
    held.map(worker => worker.workerId),
  );
  const settings = await host.settings();
  for (const entry of entries) {
    if (!entry.environment || entry.environment === 'local' || entry.cloud?.key || entry.recovery) continue;
    let environment;
    try {
      environment = await host.environment(entry.environment, settings);
    } catch {
      // Removed or disabled: re-delegation reports why for that worker alone.
      continue;
    }
    if (typeof environment?.recover !== 'function') continue;
    const label = environment.label ?? environment.id;
    try {
      let recovery;
      if (entry.workspace) {
        const deliver = entry.kind === 'deliver';
        recovery = await environment.recover(entry.workspace, {
          into: host.context.sourceRoot,
          ref: recoveryRef(entry.workerId),
          message: `${entry.task}: uncommitted work of the worker interrupted by a service restart`,
          // A reviewer is read-only: its worktree is only removed.
          commit: deliver,
        });
      } else {
        // It never got a worktree; only check that the box answers before delegating again.
        const health = await environment.health();
        if (!health.ok) throw new Error(health.reason ?? `${label} is unavailable`);
        recovery = { found: false, changed: false, head: null, ref: null };
      }
      await updateDelegation(host.context, entry.workerId, {
        recovery: { ...recovery, at: new Date().toISOString() },
      });
    } catch (error) {
      return {
        blocked: `Held workers were not resumed: ${entry.task} ${entry.kind} on ${label} could not be recovered (${error.message}). Its work stays on the box. Resume again once ${label} answers.`,
      };
    }
  }
  return { blocked: null };
}
