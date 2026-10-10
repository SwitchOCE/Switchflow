// Durable record of every delegation (task, kind, candidate, provider and the orchestrator's
// instructions), kept in external project state so "resume held workers" can re-delegate the
// workers that were queued or open when the service stopped. Agents cannot write this file.
import { readState, updateState } from '../operations/storage.mjs';

const NAME = 'worker-ledger';
const EMPTY = { schemaVersion: 1, entries: [] };
const MAX_ENTRIES = 300;

export async function recordDelegation(context, entry) {
  await updateState(
    context,
    NAME,
    state => {
      state.entries = state.entries.filter(item => item.workerId !== entry.workerId);
      state.entries.push({ ...entry, status: entry.status ?? 'queued', updatedAt: new Date().toISOString() });
      if (state.entries.length > MAX_ENTRIES) {
        // Drop the oldest finished entries first; open ones are what recovery needs.
        const finished = state.entries.filter(item => item.status === 'finished');
        const drop = new Set(finished.slice(0, state.entries.length - MAX_ENTRIES).map(item => item.workerId));
        state.entries = state.entries.filter(item => !drop.has(item.workerId)).slice(-MAX_ENTRIES);
      }
    },
    EMPTY,
  );
}

export async function updateDelegation(context, workerId, patch) {
  await updateState(
    context,
    NAME,
    state => {
      const entry = state.entries.find(item => item.workerId === workerId);
      if (entry) Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    },
    EMPTY,
  );
}

/** Delegations of a run that had not finished: queued, or with a session that was open. */
export async function unfinishedDelegations(context, runId) {
  const state = await readState(context, NAME, EMPTY);
  return (state.entries || []).filter(item => item.runId === runId && item.status !== 'finished');
}

export async function readDelegations(context, workerIds) {
  const state = await readState(context, NAME, EMPTY);
  const wanted = new Set(workerIds);
  return (state.entries || []).filter(item => wanted.has(item.workerId));
}
