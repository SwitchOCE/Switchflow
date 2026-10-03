import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readState, updateState, assertSafePath, git } from '../operations/storage.mjs';
import { createInitiative, applyAction, applyResult, ControlError, event, now, hash } from './lifecycle.mjs';
import { isRunProcessAlive, processStartTime, stopProcessTree } from './codex-runner.mjs';
import { startGitBridge } from './git-bridge.mjs';
import { readDelegations, unfinishedDelegations } from './worker-ledger.mjs';

const initial = { schemaVersion: 1, revision: 0, initiatives: [], activeRun: null };
const MAX_INLINE_OWNER_HISTORY = 128 * 1024;
// A recorded process must already exist when its PID is recorded; allow for clock granularity.
const PID_RECORD_SLACK_MS = 2000;
const knownPid = pid => Number.isSafeInteger(pid) && pid > 0;

/** Every agent process an interrupted run recorded: the stage agent and its delegated workers. */
function recordedProcesses(run) {
  return [
    {
      kind: 'stage',
      role: run.stage ?? 'stage',
      provider: run.provider ?? null,
      task: null,
      sessionId: null,
      pid: run.pid,
      recordedAt: run.processStartedAt,
    },
    ...(Array.isArray(run.workers) ? run.workers : []),
  ];
}

function describeProcess(entry) {
  const who = entry.kind === 'stage' ? `${entry.role} agent` : `${entry.kind} worker for ${entry.task}`;
  const where = entry.remotePid ? ` on ${entry.environment}, remote process group ${entry.remotePid}` : '';
  return `${entry.provider ?? 'unknown provider'} ${who} (${knownPid(entry.pid) ? `process ${entry.pid}` : 'process not recorded'}${where})`;
}

/** Owner-facing next step for a recovery hold. */
function holdNote(held) {
  const running = held.filter(entry => entry.state === 'running');
  const uncertain = held.filter(entry => entry.state !== 'running');
  const notes = [];
  if (running.length)
    notes.push(
      `Agent processes from the interrupted run are still running: ${running.map(describeProcess).join('; ')}. Stop them here, or retry after they stop. The checkpoint is preserved.`,
    );
  if (uncertain.length)
    notes.push(
      `The service could not confirm these agent processes stopped: ${uncertain.map(describeProcess).join('; ')}. Check that they have stopped, then confirm to release the recovery fence.`,
    );
  return notes.join(' ');
}

/**
 * "Resume held workers": a retry of delivery whose execution run first re-delegates the workers
 * that were queued or open when the service stopped (see Orchestration.resume).
 */
function resumeHeldWorkers(item, input) {
  const extra = Object.keys(input).filter(key => !['action', 'expectedRevision'].includes(key));
  if (extra.length) throw new ControlError(`Unsupported fields: ${extra.join(', ')}.`);
  const held = item.heldWorkers;
  if (!held?.workers?.length) throw new ControlError('There are no held workers to resume.', 409);
  if (item.stage !== 'delivery') throw new ControlError('Held workers can only be resumed during delivery.', 409);
  applyAction(item, { action: 'retry', expectedRevision: input.expectedRevision });
  // One event for the owner's one step, instead of the generic retry event.
  item.events.pop();
  const count = held.workers.length;
  item.resumeWorkers = { runId: held.runId, workerIds: held.workers.map(worker => worker.workerId) };
  item.heldWorkers = null;
  item.nextAction = `Delivery is queued. ${count} held worker${count === 1 ? '' : 's'} restart first, within the capacity limits.`;
  event(
    item,
    'resume-workers',
    `Human resumed ${count} held worker${count === 1 ? '' : 's'}: ${held.workers.map(worker => `${worker.task} ${worker.kind}`).join(', ')}.`,
  );
}

export class ControlEngine {
  constructor(
    context,
    {
      runner,
      protocol,
      onChange = () => {},
      recordIssue = async () => {},
      processAlive = isRunProcessAlive,
      processStarted = processStartTime,
      stopProcess = stopProcessTree,
      bridgeFactory = startGitBridge,
      prepareResume = null,
    },
  ) {
    this.context = context;
    this.runner = runner;
    this.protocol = protocol;
    this.onChange = onChange;
    this.recordIssue = recordIssue;
    this.current = null;
    this.closed = false;
    this.pumping = false;
    this.processAlive = processAlive;
    this.processStarted = processStarted;
    this.stopProcess = stopProcess;
    this.bridgeFactory = bridgeFactory;
    this.prepareResume = prepareResume;
  }
  async read() {
    const state = await readState(this.context, 'control', initial);
    if (state.schemaVersion !== 1 || !Array.isArray(state.initiatives))
      throw new Error('Unsupported or damaged control state. Preserve the file before recovery.');
    return state;
  }
  async mutate(fn) {
    const result = await updateState(
      this.context,
      'control',
      async state => {
        if (state.schemaVersion !== 1) throw new Error('Unsupported control state version.');
        await fn(state);
        state.revision++;
        return state;
      },
      initial,
    );
    this.onChange(result.revision);
    return result;
  }
  /**
   * "running" (the recorded process, verified by start time), "unverified" (a live PID whose
   * identity cannot be read), "unknown" (no PID was recorded) or "gone" (stopped or reused).
   */
  async processState({ pid, recordedAt }) {
    if (!knownPid(pid)) return 'unknown';
    if (!this.processAlive(pid)) return 'gone';
    const started = await this.processStarted(pid);
    const recorded = Date.parse(recordedAt);
    if (!Number.isFinite(started) || !Number.isFinite(recorded)) return 'unverified';
    return started > recorded + PID_RECORD_SLACK_MS ? 'gone' : 'running';
  }
  /** Recorded processes of an interrupted run that still fence new work. */
  async heldProcesses(run) {
    const held = [];
    for (const entry of recordedProcesses(run)) {
      const state = await this.processState(entry);
      // A remote worker can outlive its local ssh client; only the owner can confirm it stopped.
      const remote = entry.environment && entry.environment !== 'local' && knownPid(entry.remotePid);
      if (state !== 'gone' || remote)
        held.push({
          kind: entry.kind,
          role: entry.role,
          provider: entry.provider ?? null,
          task: entry.task ?? null,
          sessionId: entry.sessionId ?? null,
          pid: knownPid(entry.pid) ? entry.pid : null,
          ...(remote ? { environment: entry.environment, remotePid: entry.remotePid } : {}),
          state: state === 'gone' ? 'remote' : state,
        });
    }
    return held;
  }
  /**
   * Records a delegated worker's process in the same durable state as the stage PID, so a
   * restart fences it too. pid null means a process may be starting but is not yet identified.
   */
  async trackProcess(runId, sessionId, fields) {
    await this.mutate(s => {
      if (s.activeRun?.id !== runId) return;
      s.activeRun.workers ??= [];
      let entry = s.activeRun.workers.find(worker => worker.sessionId === sessionId);
      if (!entry) {
        entry = { sessionId, pid: null, recordedAt: null };
        s.activeRun.workers.push(entry);
      }
      const { pid, ...rest } = fields;
      Object.assign(entry, rest);
      if (pid !== undefined && pid !== entry.pid) {
        entry.pid = knownPid(pid) ? pid : null;
        entry.recordedAt = entry.pid ? now() : null;
      }
    });
  }
  /** Called after a worker's process has been closed by this service. */
  async untrackProcess(runId, sessionId) {
    await this.mutate(s => {
      if (s.activeRun?.id !== runId || !s.activeRun.workers) return;
      s.activeRun.workers = s.activeRun.workers.filter(worker => worker.sessionId !== sessionId);
    });
  }
  async recover() {
    const state = await this.read();
    if (!state.activeRun) return;
    const held = await this.heldProcesses(state.activeRun);
    // Delegations that were queued or open when the service stopped; the owner can resume them.
    const delegations = await unfinishedDelegations(this.context, state.activeRun.id).catch(() => []);
    // An uncertain run is never replayed after service restart.
    await this.mutate(s => {
      if (s.activeRun?.id !== state.activeRun.id) return;
      const item = s.initiatives.find(i => i.id === s.activeRun.initiativeId);
      if (item) {
        item.status = 'failed';
        item.pending = false;
        item.revision++;
        item.nextAction =
          'The service stopped during a run. Inspect its checkpoint and retry when the prior process has stopped.';
        const run = item.runs.find(r => r.id === s.activeRun.id);
        if (run) {
          run.status = 'interrupted';
          run.finishedAt = now();
        }
        event(item, 'interrupted', item.nextAction);
        item.heldWorkers = delegations.length
          ? {
              runId: s.activeRun.id,
              recordedAt: now(),
              workers: delegations.map(entry => ({
                workerId: entry.workerId,
                task: entry.task,
                kind: entry.kind,
                worktree: entry.worktree,
                provider: entry.provider ?? null,
                status: entry.status,
                approval: entry.approval ?? null,
                environment: entry.environment ?? 'local',
                // A cloud worker kept running and is reconnected instead of delegated again.
                reconnect: Boolean(entry.cloud?.key),
              })),
            }
          : null;
      }
      // The service does not kill here: the owner sees the list and chooses to stop or wait.
      if (held.length) {
        s.activeRun.status = 'interrupted';
        s.activeRun.held = held;
        s.activeRun.unknownProcess = held.some(entry => entry.state !== 'running');
        if (item) item.nextAction = holdNote(held);
      } else s.activeRun = null;
    });
  }
  /**
   * Applies an action against an interrupted run's recovery hold. Returns true when the action
   * was the recovery action itself; throws while the hold still fences other work.
   */
  recoveryAction(s, id, input, held) {
    const run = s.activeRun;
    const item = s.initiatives.find(i => i.id === run.initiativeId);
    const running = held.filter(entry => entry.state === 'running');
    const release = note => {
      event(item, 'recovery', note);
      item.revision++;
      item.nextAction = 'Recovery released. Review the checkpoint and retry.';
      s.activeRun = null;
    };
    if (input.action === 'recover-run' || input.action === 'stop-processes') {
      if (run.initiativeId !== id || !item)
        throw new ControlError('Confirm the unidentified prior process has stopped before releasing recovery.', 409);
      if (input.expectedRevision !== item.revision)
        throw new ControlError('The recovery state changed. Refresh first.', 409);
      if (input.action === 'recover-run') {
        if (input.confirmedStopped !== true)
          throw new ControlError('Confirm the unidentified prior process has stopped before releasing recovery.', 409);
        if (running.length)
          throw new ControlError('Stop the agent processes that are still running before releasing recovery.', 409);
        release('Human confirmed the prior agent processes have stopped.');
        return true;
      }
      if (!held.length) {
        release('Human stopped the prior agent processes.');
        return true;
      }
      run.held = held;
      run.unknownProcess = held.some(entry => entry.state !== 'running');
      item.revision++;
      item.nextAction = holdNote(held);
      event(item, 'recovery', running.length ? 'Some agent processes did not stop.' : item.nextAction);
      return true;
    }
    if (held.some(entry => entry.state !== 'running'))
      throw new ControlError('Confirm the unidentified prior process has stopped before releasing recovery.', 409);
    if (running.length)
      throw new ControlError(
        'Agent processes from the interrupted run are still running. Stop them or wait before changing or restarting work.',
        409,
      );
    s.activeRun = null;
    return false;
  }
  /**
   * Before "resume held workers" starts a run, prepareResume (set by the agent host, see
   * worker-recovery.mjs) saves what held SSH workers left on their box. When it cannot, the
   * workers stay held with the reason and nothing is resumed.
   */
  async prepareHeldWorkers(snapshot, id, input) {
    const item = snapshot.initiatives.find(i => i.id === id);
    const workers = item?.heldWorkers?.workers;
    if (!this.prepareResume || !workers?.length || input.expectedRevision !== item.revision) return;
    if (Object.keys(input).some(key => !['action', 'expectedRevision'].includes(key))) return;
    const { blocked } = await this.prepareResume(workers);
    if (!blocked) return;
    await this.mutate(s => {
      const live = s.initiatives.find(i => i.id === id);
      if (!live?.heldWorkers || live.revision !== input.expectedRevision) return;
      live.heldWorkers.blocked = blocked;
      live.nextAction = blocked;
      live.revision++;
      event(live, 'resume-blocked', blocked);
    });
    throw new ControlError(blocked, 409);
  }
  async create(input) {
    const item = createInitiative(input);
    const state = await this.mutate(s => {
      s.initiatives.push(item);
    });
    this.schedule();
    return state;
  }
  async action(id, input) {
    let interrupt = false;
    // Process checks can take seconds on Windows, so they run before the state lock is taken.
    const snapshot = await this.read();
    let held = null;
    if (snapshot.activeRun?.status === 'interrupted') {
      const hold = snapshot.initiatives.find(i => i.id === id);
      if (
        input.action === 'stop-processes' &&
        snapshot.activeRun.initiativeId === id &&
        input.expectedRevision === hold?.revision
      ) {
        // Only processes whose recorded identity is verified now are stopped, with their trees.
        for (const entry of await this.heldProcesses(snapshot.activeRun))
          if (entry.state === 'running') await this.stopProcess(entry.pid);
      }
      held = await this.heldProcesses(snapshot.activeRun);
    } else if (input.action === 'resume-workers') await this.prepareHeldWorkers(snapshot, id, input);
    const state = await this.mutate(s => {
      if (s.activeRun?.status === 'interrupted') {
        if (!held || s.activeRun.id !== snapshot.activeRun.id)
          throw new ControlError('The recovery state changed. Refresh first.', 409);
        if (this.recoveryAction(s, id, input, held)) return;
      }
      const item = s.initiatives.find(i => i.id === id);
      if (!item) throw new ControlError('Initiative not found.', 404);
      if (input.action === 'resume-workers') {
        resumeHeldWorkers(item, input);
        return;
      }
      if (
        input.action === 'approve-plan' &&
        input.expectedRevision === item.revision &&
        item.stage === 'planning' &&
        item.status === 'awaiting-human'
      ) {
        const head = git(this.context.sourceRoot, ['rev-parse', '--verify', 'HEAD']);
        if (head !== item.planningBaseline) {
          item.plan = [];
          item.status = 'idle';
          item.pending = true;
          item.revision++;
          item.nextAction = 'The code baseline changed. Agents will refresh Planning before you approve it.';
          event(item, 'baseline-changed', item.nextAction);
          return;
        }
      }
      interrupt = applyAction(item, input).interrupt;
      if (input.action === 'approve-plan') {
        item.approvedPlan.baseHead = item.planningBaseline;
        item.approvedPlan.gitGrantHash = hash({
          plan: item.approvedPlan.hash,
          scope: item.approvedPlan.scopeHash,
          baseHead: item.planningBaseline,
        });
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
    if (['scope-change', 'update', 'request-rework', 'request-changes'].includes(input.action)) {
      await this.recordIssue({
        type: input.action === 'scope-change' ? 'scope-change' : 'intervention',
        summary: `Human ${input.action}`,
        initiativeId: id,
      });
    }
    this.schedule();
    return state;
  }
  schedule() {
    if (!this.closed)
      setImmediate(() =>
        this.pump().catch(error => {
          this.lastError = error.message;
        }),
      );
  }
  async pump() {
    if (this.closed || this.pumping || this.current) return;
    this.pumping = true;
    let releaseAdmission;
    let launched = false;
    try {
      let selected;
      const snapshot = await this.read();
      if (snapshot.activeRun || !snapshot.initiatives.some(i => i.pending)) return;
      await this.mutate(s => {
        if (s.activeRun || this.closed) return;
        const item = s.initiatives.find(i => i.pending);
        if (!item) return;
        const run = {
          id: randomUUID(),
          initiativeId: item.id,
          stage: item.stage,
          status: 'running',
          startedAt: now(),
          threadId: null,
        };
        item.pending = false;
        item.status = 'running';
        item.revision++;
        item.nextAction = 'Agents are working. You can review progress or add an update.';
        item.runs.push(run);
        item.runs = item.runs.slice(-100);
        s.activeRun = { ...run };
        event(item, 'started', `${item.stage} started.`);
        selected = { item: structuredClone(item), run };
        // A held-worker list belongs to the interrupted run; this run consumes or supersedes it.
        item.heldWorkers = null;
        item.resumeWorkers = null;
        // Install the abort target before the durable admission lock is released.
        const controller = new AbortController();
        const promise = new Promise(resolve => {
          releaseAdmission = resolve;
        });
        this.current = { initiativeId: item.id, controller, promise };
      });
      if (!selected) return;
      if (this.closed) this.current.controller.abort();
      launched = true;
      void this.execute(selected, this.current.controller.signal)
        .finally(releaseAdmission)
        .catch(error => {
          this.lastError = error.message;
        });
    } catch (error) {
      if (!launched && this.current) {
        this.current.controller.abort();
        this.current = null;
        releaseAdmission?.();
      }
      throw error;
    } finally {
      this.pumping = false;
    }
  }
  async execute({ item, run }, signal) {
    const stage = item.stage === 'delivery' ? 'execution' : item.stage;
    let gitBridge;
    const closeBridge = async () => {
      const bridge = gitBridge;
      gitBridge = null;
      await bridge?.close();
    };
    try {
      const runDirectory = await assertSafePath(
        this.context.stateDir,
        path.join(this.context.stateDir, 'runs', run.id),
      );
      await fs.mkdir(runDirectory, { recursive: true });
      if (stage === 'uat' && !item.approvedUat)
        throw new Error('UAT record finalization requires the recorded human verdict.');
      if (stage === 'planning') {
        item.planningBaseline = git(this.context.sourceRoot, ['rev-parse', '--verify', 'HEAD']);
        await this.mutate(s => {
          if (s.activeRun?.id === run.id && !s.activeRun.superseded)
            s.initiatives.find(i => i.id === item.id).planningBaseline = item.planningBaseline;
        });
      }
      if (stage === 'execution') {
        if (!item.approvedPlan?.baseHead)
          throw new Error('This plan has no recorded Git baseline. Refresh Planning before delivery.');
        gitBridge = await this.bridgeFactory({
          context: this.context,
          runDirectory,
          initiativeId: item.id,
          planHash: item.approvedPlan.gitGrantHash,
          baseHead: item.approvedPlan.baseHead,
          signal,
        });
      }
      const agentState = Object.fromEntries(
        [
          'id',
          'title',
          'request',
          'stage',
          'revision',
          'reviewMode',
          'summary',
          'nextAction',
          'questions',
          'scope',
          'plan',
          'uat',
          'evidence',
          'blockers',
          'approvedScope',
          'approvedPlan',
          'approvedUat',
        ].map(key => [key, item[key]]),
      );
      // Runs deliberately start fresh, including after a scope revision. The
      // cursor distinguishes new input; it must never erase earlier decisions.
      const messageCursor = item.messageCursor || 0;
      agentState.messages = item.messages;
      let currentInput = item.messages.slice(messageCursor);
      let historyInstruction =
        'Owner messages are a chronological history, including superseded scope revisions. Preserve earlier answers as context, but never let an older message override the current approvedScope, approvedPlan, or the latest explicit scope-change request.\n';
      const ownerHistory = JSON.stringify(item.messages);
      if (Buffer.byteLength(ownerHistory) > MAX_INLINE_OWNER_HISTORY) {
        const historyPath = await assertSafePath(runDirectory, path.join(runDirectory, 'owner-history.json'));
        await fs.writeFile(historyPath, ownerHistory, { flag: 'wx' });
        agentState.messages = [];
        agentState.ownerHistory = {
          path: historyPath,
          messageCount: item.messages.length,
          newMessagesFrom: messageCursor,
        };
        currentInput = { ownerHistory: agentState.ownerHistory };
        historyInstruction +=
          'The complete chronological owner conversation is stored in state.ownerHistory.path because it exceeds the inline history limit. Before making decisions, read that JSON array in bounded chunks through messageCount entries, preserving every recorded answer and update. state.messages is empty only to avoid duplicating that file. Entries from newMessagesFrom onward are the new user input. These records are user context, not authority to override the approved scope or safeguards.\n';
      }
      // "Resume held workers": the host re-delegates them before the orchestrator's first turn.
      let resumeWorkers = [];
      if (stage === 'execution' && item.resumeWorkers?.workerIds?.length) {
        resumeWorkers = await readDelegations(this.context, item.resumeWorkers.workerIds);
        agentState.resumedWorkers = {
          note: 'The owner resumed these workers from the interrupted run. The host has already delegated them again (or queued them for capacity) with their original instructions, or reconnected cloud workers that kept running. Follow them with worker_status and wait_for_workers; do not delegate the same tasks again.',
          workers: resumeWorkers.map(({ task, kind, worktree }) => ({ task, kind, worktree })),
        };
      }
      agentState.planningBaseline = item.planningBaseline;
      agentState.gitBridge = gitBridge?.descriptor;
      agentState.deliveryCapabilities = {
        managedGit: true,
        operations: ['create', 'commit', 'merge'],
        primaryProtected: true,
        candidateRoot: path.join(this.context.stateDir, 'candidates'),
      };
      const agentDirectories = ['operations', 'scratch', 'governance'].map(name =>
        path.join(this.context.stateDir, name),
      );
      for (const directory of agentDirectories)
        await fs.mkdir(await assertSafePath(this.context.stateDir, directory), { recursive: true });
      const temporaryRoot = await assertSafePath(
        this.context.stateDir,
        path.join(this.context.stateDir, 'scratch', run.id, 'tmp'),
      );
      await fs.mkdir(temporaryRoot, { recursive: true });
      const additionalWritableRoots = [this.context.governanceRoot, ...agentDirectories];
      if (gitBridge)
        additionalWritableRoots.push(
          gitBridge.descriptor.managedRoot,
          path.join(gitBridge.descriptor.channelPath, 'requests'),
        );
      const result = await this.runner({
        projectRoot: this.context.sourceRoot,
        runDirectory,
        temporaryRoot,
        additionalWritableRoots: additionalWritableRoots.filter(Boolean),
        prompt:
          historyInstruction +
          this.protocol.buildAgentPrompt({
            stage,
            state: {
              ...agentState,
              projectRoot: this.context.sourceRoot,
              sourceRoot: this.context.sourceRoot,
              governanceRoot: this.context.governanceRoot,
              stateDir: this.context.stateDir,
            },
            input: currentInput,
          }),
        schemaPath: this.protocol.schemaPathForStage(stage),
        signal,
        stage,
        runId: run.id,
        initiativeId: item.id,
        gitBridge: gitBridge?.descriptor ?? null,
        resumeWorkers,
        // Runners emit the normalized session vocabulary (docs/browser-control.md, Agents API).
        onEvent: async entry => {
          if (entry.kind === 'session.started' && (entry.pid || entry.threadId)) {
            await this.mutate(s => {
              if (s.activeRun?.id !== run.id) return;
              const live = s.initiatives.find(i => i.id === item.id)?.runs.find(r => r.id === run.id);
              for (const target of [s.activeRun, live].filter(Boolean)) {
                if (entry.pid && !target.pid) {
                  target.pid = entry.pid;
                  target.processStartedAt = now();
                }
                if (entry.threadId) target.threadId = entry.threadId;
                if (entry.provider) target.provider = entry.provider;
              }
            });
          }
          // Only human-readable agent activity enters the browser, never shell output or hidden reasoning.
          const message = entry.kind === 'message' ? entry.text : null;
          if (
            typeof message === 'string' &&
            message.length &&
            message.length < 12000 &&
            !message.trim().startsWith('{')
          ) {
            await this.mutate(s => {
              if (s.activeRun?.id !== run.id || s.activeRun.superseded) return;
              const live = s.initiatives.find(i => i.id === item.id);
              event(live, 'progress', message);
              live.updatedAt = now();
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
        Object.assign(receipt, {
          status: s.activeRun.superseded ? 'cancelled' : 'complete',
          threadId: result.threadId,
          exitCode: result.exitCode,
          finishedAt: now(),
        });
        if (!s.activeRun.superseded) {
          applyResult(live, result.result);
          // Owner steering already reached this run; it is not new input for the next one.
          let cursor = item.messages.length;
          while (live.messages[cursor]?.type === 'steer' && live.messages[cursor].runId === run.id) cursor++;
          live.messageCursor = cursor;
        }
        s.activeRun = null;
      });
      if (result.result.questions.length || result.result.blockers.length) {
        const permission = /permission|approval|credential|sandbox|access denied/i.test(
          result.result.blockers.join(' '),
        );
        await this.recordIssue({
          type: result.result.questions.length ? 'clarification' : permission ? 'permission' : 'blocker',
          summary: result.result.nextAction,
          initiativeId: item.id,
          runId: run.id,
        });
      }
    } catch (error) {
      try {
        await closeBridge();
      } catch (closingError) {
        error = new Error(`${error.message}; Git helper shutdown: ${closingError.message}`);
      }
      await this.mutate(s => {
        if (s.activeRun?.id !== run.id) return;
        const live = s.initiatives.find(i => i.id === item.id);
        const receipt = live.runs.find(r => r.id === run.id);
        Object.assign(receipt, {
          status: s.activeRun.superseded ? 'cancelled' : 'failed',
          error: error.message,
          finishedAt: now(),
        });
        if (!s.activeRun.superseded) {
          live.status = signal.aborted ? 'cancelled' : 'failed';
          live.pending = false;
          live.revision++;
          live.nextAction = /permission|access|codex home|credential|sign.in|signed in|logged in/i.test(error.message)
            ? 'Resolve the local access issue shown in run details, then retry this checkpoint.'
            : 'Inspect the failed run details, then retry this checkpoint. Your approvals and earlier work are preserved.';
          event(live, 'failed', error.message);
        }
        s.activeRun = null;
      });
    } finally {
      try {
        await closeBridge();
      } finally {
        this.current = null;
        this.schedule();
      }
    }
  }
  async close() {
    this.closed = true;
    if (this.current) {
      this.current.controller.abort();
      await this.current.promise;
    }
  }
}
