import { randomUUID } from 'node:crypto';
import { readState, updateState } from './storage.mjs';
export async function recordIssue(context, issue) {
  if (!['clarification', 'permission', 'scope-change', 'issue', 'update'].includes(issue.kind)) throw new Error('Invalid issue kind');
  if (typeof issue.summary !== 'string' || !issue.summary.trim()) throw new Error('Issue summary required');
  const entry = { id: randomUUID(), createdAt: new Date().toISOString(), kind: issue.kind, summary: issue.summary, phase: issue.phase || null, taskId: issue.taskId || null, nextAction: issue.nextAction || null, status: 'open', dispatch: false };
  await updateState(context, 'issues', state => { state.entries.push(entry); }, { entries: [] });
  return entry;
}
export const listIssues = async context => (await readState(context, 'issues', { entries: [] })).entries;
export async function resolveIssue(context, id, resolution) {
  if (!resolution?.trim()) throw new Error('Resolution required');
  return updateState(context, 'issues', state => { const entry = state.entries.find(item => item.id === id); if (!entry) throw new Error('Unknown issue'); entry.status = 'resolved'; entry.resolution = resolution; entry.resolvedAt = new Date().toISOString(); }, { entries: [] });
}
export async function issueMetrics(context) {
  const entries = await listIssues(context);
  return { total: entries.length, open: entries.filter(e => e.status === 'open').length, byKind: Object.fromEntries(['clarification', 'permission', 'scope-change', 'issue', 'update'].map(kind => [kind, entries.filter(e => e.kind === kind).length])), automaticDispatches: 0 };
}
