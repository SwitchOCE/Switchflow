import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readState, updateState, assertSafePath, git } from '../operations/storage.mjs';
import { createInitiative, applyAction, applyResult, ControlError, event, now, hash } from './lifecycle.mjs';
import { isRunProcessAlive } from './codex-runner.mjs';
import { startGitBridge } from './git-bridge.mjs';

const initial = { schemaVersion: 1, revision: 0, initiatives: [], activeRun: null };
export class ControlEngine {
  constructor(context, { runner, protocol, onChange = () => {}, recordIssue = async () => {}, processAlive = isRunProcessAlive, bridgeFactory = startGitBridge }) {
    this.context = context; this.runner = runner; this.protocol = protocol;
    this.onChange = onChange; this.recordIssue = recordIssue; this.current = null; this.closed = false;
    this.pumping = false;
    this.processAlive = processAlive;
    this.bridgeFactory = bridgeFactory;
  }
  async read() {
    const state = await readState(this.context, 'control', initial);
    if (state.schemaVersion !== 1 || !Array.isArray(state.initiatives)) throw new Error('Unsupported or damaged control state. Preserve the file before recovery.');
    return state;
  }
  async mutate(fn) {
    const result = await updateState(this.context, 'control', async state => {
      if (state.schemaVersion !== 1) throw new Error('Unsupported control state version.');
      await fn(state); state.revision++; return state;
    }, initial);
    this.onChange(result.revision); return result;
  }
  async recover() {
    const state = await this.read();
    if (!state.activeRun) return;
    // An uncertain run is never replayed after service restart.
    await this.mutate(s => {
      const item = s.initiatives.find(i => i.id === s.activeRun.initiativeId);
      if (item) {
        item.status = 'failed'; item.pending = false; item.revision++;
        item.nextAction = 'The service stopped during a run. Inspect its checkpoint and retry when the prior process has stopped.';
        const run = item.runs.find(r => r.id === s.activeRun.id);
        if (run) { run.status = 'interrupted'; run.finishedAt = now(); }
        event(item, 'interrupted', item.nextAction);
      }
      if (!s.activeRun.pid || this.processAlive(s.activeRun.pid)) {
        s.activeRun.status = 'interrupted';
        s.activeRun.unknownProcess = !s.activeRun.pid;
        if (item) item.nextAction = s.activeRun.unknownProcess ? 'The service stopped before recording the agent process identity. Confirm the previous process has stopped to release the recovery fence.' : `The prior agent process (${s.activeRun.pid}) is still running. Retry becomes available after it stops; its checkpoint is preserved.`;
      } else s.activeRun = null;
    });
  }
  async create(input) {
    const item = createInitiative(input);
    const state = await this.mutate(s => { s.initiatives.push(item); });
    this.schedule(); return state;
  }
  async action(id, input) {
    let interrupt = false;
    const state = await this.mutate(s => {
      if (s.activeRun?.status === 'interrupted') {
        if (s.activeRun.unknownProcess) {
          if (input.action !== 'recover-run' || input.confirmedStopped !== true || s.activeRun.initiativeId !== id) throw new ControlError('Confirm the unidentified prior process has stopped before releasing recovery.', 409);
          const item = s.initiatives.find(i => i.id === id);
          if (input.expectedRevision !== item.revision) throw new ControlError('The recovery state changed. Refresh first.', 409);
          event(item, 'recovery', 'Human confirmed the prior unrecorded process has stopped.');
          item.revision++; item.nextAction = 'Recovery released. Review the checkpoint and retry.'; s.activeRun = null;
          return;
        }
        if (this.processAlive(s.activeRun.pid)) throw new ControlError('The prior agent process is still running. Wait for it to stop before changing or restarting work.', 409);
        s.activeRun = null;
      }
      const item = s.initiatives.find(i => i.id === id);
      if (!item) throw new ControlError('Initiative not found.', 404);
      if (input.action === 'approve-plan' && input.expectedRevision === item.revision && item.stage === 'planning' && item.status === 'awaiting-human') {
        const head = git(this.context.sourceRoot, ['rev-parse', '--verify', 'HEAD']);
        if (head !== item.planningBaseline) {
          item.plan = []; item.status = 'idle'; item.pending = true; item.revision++;
          item.nextAction = 'The code baseline changed. Agents will refresh Planning before you approve it.';
          event(item, 'baseline-changed', item.nextAction);
          return;
        }
      }
      interrupt = applyAction(item, input).interrupt;
      if (input.action === 'approve-plan') {
        item.approvedPlan.baseHead = item.planningBaseline;
        item.approvedPlan.gitGrantHash = hash({ plan: item.approvedPlan.hash, scope: item.approvedPlan.scopeHash, baseHead: item.planningBaseline });
        item.approvalHistory.at(-1).baseHead = item.planningBaseline;
        item.approvalHistory.at(-1).gitGrantHash = item.approvedPlan.gitGrantHash;
      }
      if (interrupt && s.activeRun?.initiativeId === id) {
        s.activeRun.superseded = true;
        // Stop bridge admission in the same mutation that revokes this run.
        // Already-started Git operations settle before the next run is admitted.
        if (this.current?.initiativeId === id) this.current.controller.abort();
      }
    });
    if (interrupt && this.current?.initiativeId === id) this.current.controller.abort();
    if (['scope-change', 'update', 'request-rework'].includes(input.action)) {
      await this.recordIssue({ type: input.action === 'scope-change' ? 'scope-change' : 'intervention', summary: `Human ${input.action}`, initiativeId: id });
    }
    this.schedule(); return state;
  }
  schedule() { if (!this.closed) setImmediate(() => this.pump().catch(error => { this.lastError = error.message; })); }
  async pump() {
    if (this.closed || this.pumping || this.current) return;
    this.pumping = true;
    let releaseAdmission; let launched = false;
    try {
      let selected;
      const snapshot = await this.read();
      if (snapshot.activeRun || !snapshot.initiatives.some(i => i.pending)) return;
      await this.mutate(s => {
        if (s.activeRun || this.closed) return;
        const item = s.initiatives.find(i => i.pending);
        if (!item) return;
        const run = { id: randomUUID(), initiativeId: item.id, stage: item.stage, status: 'running', startedAt: now(), threadId: null };
        item.pending = false; item.status = 'running'; item.revision++; item.nextAction = 'Agents are working. You can review progress or add an update.';
        item.runs.push(run); item.runs = item.runs.slice(-100); s.activeRun = { ...run };
        event(item, 'started', `${item.stage} started.`); selected = { item: structuredClone(item), run };
        // Install the abort target before the durable admission lock is released.
        const controller = new AbortController();
        const promise = new Promise(resolve => { releaseAdmission = resolve; });
        this.current = { initiativeId: item.id, controller, promise };
      });
      if (!selected) return;
      if (this.closed) this.current.controller.abort();
      launched = true;
      void this.execute(selected, this.current.controller.signal).finally(releaseAdmission).catch(error => { this.lastError = error.message; });
    } catch (error) {
      if (!launched && this.current) { this.current.controller.abort(); this.current = null; releaseAdmission?.(); }
      throw error;
    } finally { this.pumping = false; }
  }
  async execute({ item, run }, signal) {
    const stage = item.stage === 'delivery' ? 'execution' : item.stage;
    let gitBridge;
    const closeBridge = async () => { const bridge = gitBridge; gitBridge = null; await bridge?.close(); };
    try {
      const runDirectory = await assertSafePath(this.context.stateDir, path.join(this.context.stateDir, 'runs', run.id));
      await fs.mkdir(runDirectory, { recursive: true });
      if (stage === 'uat' && !item.approvedUat) throw new Error('UAT record finalization requires the recorded human verdict.');
      if (stage === 'planning') {
        item.planningBaseline = git(this.context.sourceRoot, ['rev-parse', '--verify', 'HEAD']);
        await this.mutate(s => {
          if (s.activeRun?.id === run.id && !s.activeRun.superseded) s.initiatives.find(i => i.id === item.id).planningBaseline = item.planningBaseline;
        });
      }
      if (stage === 'execution') {
        if (!item.approvedPlan?.baseHead) throw new Error('This plan has no recorded Git baseline. Refresh Planning before delivery.');
        gitBridge = await this.bridgeFactory({ context: this.context, runDirectory, initiativeId: item.id, planHash: item.approvedPlan.gitGrantHash, baseHead: item.approvedPlan.baseHead, signal });
      }
      const agentState = Object.fromEntries(['id', 'title', 'request', 'stage', 'revision', 'reviewMode', 'summary', 'nextAction', 'questions', 'scope', 'plan', 'uat', 'evidence', 'blockers', 'approvedScope', 'approvedPlan', 'approvedUat'].map(key => [key, item[key]]));
      agentState.messages = item.messages.slice(item.messageCursor || 0);
      agentState.planningBaseline = item.planningBaseline;
      agentState.gitBridge = gitBridge?.descriptor;
      agentState.deliveryCapabilities = { managedGit: true, operations: ['create', 'commit', 'merge'], primaryProtected: true, candidateRoot: path.join(this.context.stateDir, 'candidates') };
      const agentDirectories = ['operations', 'scratch', 'governance'].map(name => path.join(this.context.stateDir, name));
      for (const directory of agentDirectories) await fs.mkdir(await assertSafePath(this.context.stateDir, directory), { recursive: true });
      const temporaryRoot = await assertSafePath(this.context.stateDir, path.join(this.context.stateDir, 'scratch', run.id, 'tmp'));
      await fs.mkdir(temporaryRoot, { recursive: true });
      const additionalWritableRoots = [this.context.governanceRoot, ...agentDirectories];
      if (gitBridge) additionalWritableRoots.push(gitBridge.descriptor.managedRoot, path.join(gitBridge.descriptor.channelPath, 'requests'));
      const result = await this.runner({
        projectRoot: this.context.sourceRoot, runDirectory, temporaryRoot,
        additionalWritableRoots: additionalWritableRoots.filter(Boolean),
        prompt: this.protocol.buildAgentPrompt({ stage, state: { ...agentState, projectRoot: this.context.sourceRoot, sourceRoot: this.context.sourceRoot, governanceRoot: this.context.governanceRoot, stateDir: this.context.stateDir }, input: agentState.messages }),
        schemaPath: this.protocol.schemaPathForStage(stage), signal,
        onEvent: async entry => {
          if (entry.type === 'runner.started' && entry.pid) {
            await this.mutate(s => {
              if (s.activeRun?.id !== run.id) return;
              s.activeRun.pid = entry.pid; s.activeRun.processStartedAt = entry.startedAt;
              const live = s.initiatives.find(i => i.id === item.id)?.runs.find(r => r.id === run.id);
              if (live) { live.pid = entry.pid; live.processStartedAt = entry.startedAt; }
            });
          }
          if (entry.type === 'thread.started' && entry.thread_id) {
            await this.mutate(s => {
              if (s.activeRun?.id !== run.id) return;
              s.activeRun.threadId = entry.thread_id;
              const live = s.initiatives.find(i => i.id === item.id)?.runs.find(r => r.id === run.id);
              if (live) live.threadId = entry.thread_id;
            });
          }
          // Only human-readable agent activity enters the browser, never shell output or hidden reasoning.
          const message = entry.type === 'item.completed' && entry.item?.type === 'agent_message' ? entry.item.text : null;
          if (typeof message === 'string' && message.length && message.length < 12000 && !message.trim().startsWith('{')) {
            await this.mutate(s => {
              if (s.activeRun?.id !== run.id || s.activeRun.superseded) return;
              const live = s.initiatives.find(i => i.id === item.id); event(live, 'progress', message); live.updatedAt = now();
            });
          }
        },
      });
      await closeBridge();
      result.result = this.protocol.validateAgentResult(stage, result.result);
      await this.mutate(s => {
        if (s.activeRun?.id !== run.id) return;
        const live = s.initiatives.find(i => i.id === item.id);
        const receipt = live.runs.find(r => r.id === run.id);
        Object.assign(receipt, { status: s.activeRun.superseded ? 'cancelled' : 'complete', threadId: result.threadId, exitCode: result.exitCode, finishedAt: now() });
        if (!s.activeRun.superseded) { applyResult(live, result.result); live.messageCursor = item.messages.length; }
        s.activeRun = null;
      });
      if (result.result.questions.length || result.result.blockers.length) {
        const permission = /permission|approval|credential|sandbox|access denied/i.test(result.result.blockers.join(' '));
        await this.recordIssue({ type: result.result.questions.length ? 'clarification' : permission ? 'permission' : 'blocker', summary: result.result.nextAction, initiativeId: item.id, runId: run.id });
      }
    } catch (error) {
      try { await closeBridge(); } catch (closingError) { error = new Error(`${error.message}; Git helper shutdown: ${closingError.message}`); }
      await this.mutate(s => {
        if (s.activeRun?.id !== run.id) return;
        const live = s.initiatives.find(i => i.id === item.id);
        const receipt = live.runs.find(r => r.id === run.id);
        Object.assign(receipt, { status: s.activeRun.superseded ? 'cancelled' : 'failed', error: error.message, finishedAt: now() });
        if (!s.activeRun.superseded) {
          live.status = signal.aborted ? 'cancelled' : 'failed'; live.pending = false; live.revision++;
          live.nextAction = /permission|access|codex home|credential|sign.in/i.test(error.message)
            ? 'Resolve the local access issue shown in run details, then retry this checkpoint.'
            : 'Inspect the failed run details, then retry this checkpoint. Your approvals and earlier work are preserved.';
          event(live, 'failed', error.message);
        }
        s.activeRun = null;
      });
    } finally {
      try { await closeBridge(); } finally { this.current = null; this.schedule(); }
    }
  }
  async close() {
    this.closed = true;
    if (this.current) { this.current.controller.abort(); await this.current.promise; }
  }
}
