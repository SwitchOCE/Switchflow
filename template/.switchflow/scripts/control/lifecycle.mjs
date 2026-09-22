import { randomUUID, createHash } from 'node:crypto';

export const now = () => new Date().toISOString();
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ControlError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, name, limit = 50000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new ControlError(`${name} must contain 1–${limit} characters.`);
  return value.trim();
}
export function event(item, type, message) {
  item.events.push({ id: randomUUID(), type, message, at: now() });
  item.events = item.events.slice(-200);
}
export function createInitiative(input) {
  return {
    id: randomUUID(), title: text(input.title, 'Title', 240), request: text(input.request, 'Request'),
    stage: 'intake', status: 'idle', revision: 1, reviewMode: input.reviewMode === true,
    summary: '', nextAction: input.start === false ? 'Start Intake.' : 'Intake is queued.', pending: input.start !== false,
    questions: [], scope: '', plan: [], uat: [], evidence: [], blockers: [], messages: [], runs: [], events: [],
    approvedScope: null, approvedPlan: null, approvedUat: null, approvalHistory: [], createdAt: now(), updatedAt: now(),
  };
}
function requireState(condition, message) { if (!condition) throw new ControlError(message, 409); }
function enqueue(item) {
  item.pending = true; item.status = 'idle'; item.nextAction = `${item.stage === 'delivery' ? 'Delivery' : item.stage} is queued.`;
}
export function applyAction(item, input) {
  requireState(input.expectedRevision === item.revision, 'This initiative changed. Refresh and review it before applying your action.');
  const action = input.action;
  const busy = item.status === 'running' || item.pending;
  if (!['cancel', 'scope-change', 'update'].includes(action)) requireState(!busy, 'Wait for this run to finish, or cancel it first.');
  switch (action) {
    case 'start': case 'retry':
      requireState(['idle', 'failed', 'blocked', 'cancelled'].includes(item.status), 'This initiative needs its displayed human decision.');
      requireState(item.stage !== 'complete', 'Accepted work cannot be restarted. Use a scope change.');
      if (item.stage === 'delivery') requireState(item.approvedPlan !== null, 'Approve the plan before delivery.');
      enqueue(item); break;
    case 'answer': {
      requireState(item.questions.length > 0 && ['awaiting-human', 'blocked'].includes(item.status), 'There are no pending questions.');
      const answers = input.answers;
      requireState(answers && typeof answers === 'object' && !Array.isArray(answers), 'Supply answers keyed by question ID.');
      const answered = item.questions.map(q => ({ ...q, answer: text(answers[q.id], q.prompt, 12000) }));
      item.messages.push({ type: 'answers', at: now(), answers: answered }); item.questions = []; enqueue(item); break;
    }
    case 'approve-scope':
      requireState(item.stage === 'intake' && item.status === 'awaiting-human' && !item.questions.length && item.scope.trim(), 'Finish Intake before approving its scope.');
      item.approvedScope = { text: item.scope, hash: hash(item.scope), approvedAt: now(), by: 'Human' };
      item.approvalHistory.push({ type: 'scope', ...item.approvedScope }); item.stage = 'planning'; enqueue(item); break;
    case 'approve-plan':
      requireState(item.stage === 'planning' && item.status === 'awaiting-human' && !item.questions.length && item.plan.length && item.approvedScope, 'Finish Planning before approving its plan.');
      item.approvedPlan = { tasks: structuredClone(item.plan), hash: hash(item.plan), scopeHash: item.approvedScope.hash, approvedAt: now(), by: 'Human', authority: 'All listed phases through independent review and UAT preparation. No remote publishing or protected external actions.' };
      item.approvalHistory.push({ type: 'plan', ...item.approvedPlan }); item.stage = 'delivery'; enqueue(item); break;
    case 'accept-uat': {
      requireState(item.stage === 'uat' && item.status === 'awaiting-human' && item.uat.length > 0 && item.approvedPlan && !item.approvedUat, 'Delivery must reach unaccepted UAT before acceptance.');
      const results = input.results;
      requireState(Array.isArray(results) && results.length === item.uat.length && results.every(r => r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string') && new Set(results.map(r => r.id)).size === item.uat.length, 'Record a result for every UAT step.');
      item.uat = item.uat.map(step => {
        const result = results.find(r => r.id === step.id);
        requireState(result?.status === 'passed', 'Every UAT step must pass before acceptance. Request rework for failures.');
        return { ...step, status: 'passed', notes: typeof result.notes === 'string' ? result.notes.slice(0, 12000) : '', by: 'Human', at: now() };
      });
      item.approvedUat = { type: 'uat', planHash: item.approvedPlan.hash, by: 'Human', approvedAt: now(), results: structuredClone(item.uat), candidateEvidence: structuredClone(item.evidence) };
      item.approvalHistory.push(structuredClone(item.approvedUat));
      enqueue(item); item.nextAction = 'Your acceptance is recorded. Agents will close the delivery records.'; break;
    }
    case 'request-rework': {
      requireState(item.stage === 'uat' && item.status === 'awaiting-human' && item.approvedPlan && !item.approvedUat, 'Rework starts from unaccepted UAT.');
      const feedback = text(input.feedback, 'Rework feedback');
      // Legacy clients may omit results; preserve their already-recorded observations too.
      const results = input.results === undefined ? item.uat : input.results;
      requireState(Array.isArray(results) && results.length === item.uat.length && results.every(r => r && typeof r === 'object' && typeof r.id === 'string') && new Set(results.map(r => r.id)).size === item.uat.length, 'Record a result for every UAT step.');
      const observations = item.uat.map(step => {
        const result = results.find(r => r.id === step.id);
        requireState(result && ['pending', 'passed', 'failed'].includes(result.status), 'Use a current UAT step and a valid result.');
        requireState(result.notes === undefined || (typeof result.notes === 'string' && result.notes.length <= 12000), 'UAT notes must contain at most 12000 characters.');
        const { by: previousAuthor, at: previousTime, ...check } = step;
        const observed = result.status !== 'pending' || !!result.notes?.trim();
        return { ...check, status: result.status, notes: result.notes || '', ...(observed ? { by: 'Human', at: now() } : {}) };
      });
      item.messages.push({ type: 'rework', message: feedback, results: observations, candidateEvidence: structuredClone(item.evidence), planHash: item.approvedPlan.hash, at: now() });
      item.stage = 'delivery'; item.uat = []; enqueue(item); break;
    }
    case 'scope-change':
      item.messages.push({ type: 'scope-change', message: text(input.request, 'Changed scope'), at: now() });
      item.approvedScope = null; item.approvedPlan = null; item.approvedUat = null; item.scope = ''; item.plan = []; item.uat = []; item.questions = [];
      item.stage = 'intake'; enqueue(item); break;
    case 'update':
      item.messages.push({ type: 'update', message: text(input.message, 'Update'), at: now() });
      break;
    case 'cancel':
      requireState(busy, 'There is no queued or running work to cancel.');
      item.pending = false; item.status = 'cancelled'; item.nextAction = 'Work stopped. Review the checkpoint before retrying.'; break;
    default: throw new ControlError('Unknown initiative action.');
  }
  event(item, action, action === 'approve-plan' ? 'Human approved every phase through UAT.' : `Human: ${action.replaceAll('-', ' ')}.`);
  item.revision++; item.updatedAt = now();
  return { interrupt: action === 'cancel' || action === 'scope-change' };
}

export function applyResult(item, result) {
  item.summary = result.summary; item.nextAction = result.nextAction;
  item.questions = result.questions.map((q, i) => typeof q === 'string' ? { id: `question-${i + 1}`, prompt: q } : q);
  item.evidence = result.evidence; item.blockers = result.blockers;
  if (item.stage === 'intake' && result.scope) item.scope = result.scope;
  if (item.stage === 'planning' && result.plan.length) item.plan = result.plan;
  if (result.status === 'blocked' || result.blockers.length) item.status = 'blocked';
  else if (item.questions.length || result.status === 'questions') item.status = 'awaiting-human';
  else if (item.stage === 'uat' && item.approvedUat && result.status === 'ready') {
    requireState(result.evidence.length > 0, 'Closing accepted delivery needs evidence that its records were updated.');
    item.stage = 'complete'; item.status = 'complete'; item.nextAction = 'Accepted and recorded. Start a new intake for another outcome.';
  }
  else if (item.stage === 'delivery' && result.status === 'ready_for_uat') {
    requireState(item.approvedPlan && result.evidence.length && result.uat.length, 'UAT needs an approved plan, recorded evidence, and a walkthrough.');
    item.stage = 'uat'; item.status = 'awaiting-human';
    item.uat = result.uat.map(title => ({ id: `uat-${randomUUID()}`, title, status: 'pending', notes: '' }));
  } else if (result.status === 'in_progress' || result.status === 'rework') enqueue(item);
  else if ((item.stage === 'intake' && item.scope.trim()) || (item.stage === 'planning' && item.plan.length)) item.status = 'awaiting-human';
  else throw new ControlError('The agent did not provide a complete result for this stage.');
  event(item, 'checkpoint', result.summary); item.updatedAt = now(); item.revision++;
}
