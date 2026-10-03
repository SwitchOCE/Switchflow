// Capped real-model smoke runs against a throwaway repository. Usage:
//   node real-runs.mjs orchestrate            Codex orchestrator -> Claude worker through the bridge
//   node real-runs.mjs steer <codex|claude>   steer then interrupt a working session over HTTP
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repository root, three levels above analysis/orchestration-2026-10-03/smoke/.
const WORKTREE = fileURLToPath(new URL('../../../', import.meta.url));
const control = name => import(pathToFileURL(path.join(WORKTREE, 'template/.switchflow/scripts', name)).href);
const { createControlServer } = await control('control/server.mjs');
const { resolveProject, updateState, readState } = await control('operations/storage.mjs');
const { startGitBridge } = await control('control/git-bridge.mjs');
const { requestGitBridge } = await control('control/git-bridge-client.mjs');
const { processStartTime } = await control('control/codex-runner.mjs');

const [mode, provider] = process.argv.slice(2);
// Short temp path: managed candidate Git roots must stay under the Windows 220-byte limit.
const resuming = mode === 'recover';
const base = resuming ? provider : path.join(os.tmpdir(), `sfsmoke-${mode}-${provider ?? 'codex'}-${Date.now()}`);
const out = path.join(base, 'out');
const root = path.join(base, 'repo');
await fs.mkdir(out, { recursive: true });
if (!resuming) await fs.mkdir(root);
const git = (...args) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
if (!resuming) {
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true });
  await fs.writeFile(path.join(root, 'notes.txt'), 'first line\n');
  for (let i = 1; i <= 6; i++) await fs.writeFile(path.join(root, `part-${i}.txt`), `Part ${i}: word${i * 7}\n`);
  git('add', '.');
  git('commit', '-m', 'Throwaway smoke baseline');
}
const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2));

const app = await createControlServer({
  context,
  backlog: {
    list: async () => [],
    view: async id => {
      if (id !== 'DEMO-1') throw new Error('missing');
      return { id };
    },
  },
  nativeFactory: () => ({ close: async () => {} }),
});
const session = app.projects.get(context.id);
const { agents, engine } = session;
const { csrfToken } = await (await fetch(`${app.url}/api/projects`)).json();
const api = `${app.url}/api/projects/${context.id}`;
const post = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
log('providers', JSON.stringify(agents.capabilities));

async function dumpSessions(prefix) {
  const { sessions } = await agents.list();
  await save(`${prefix}-sessions.json`, sessions);
  for (const s of sessions) await save(`${prefix}-${s.kind}-${s.provider}-events.json`, await agents.events(s.id, 0, 2000));
  return sessions;
}

try {
  if (mode === 'orchestrate') {
    await agents.updateSettings({
      roles: { execution: 'codex', delivery: 'claude' },
      models: { codex: 'gpt-5.6-luna', claude: 'haiku' },
      efforts: { codex: 'low', claude: 'low' },
      limits: { maxWorkers: 1, maxReviewRounds: 1, maxTurns: 12, timeoutMinutes: 6 },
    });
    const initiativeId = randomUUID();
    const runId = randomUUID();
    const planHash = 'b'.repeat(64);
    const baseHead = git('rev-parse', 'HEAD');
    const runDirectory = path.join(context.stateDir, 'runs', runId);
    const temporaryRoot = path.join(context.stateDir, 'scratch', runId, 'tmp');
    await fs.mkdir(runDirectory, { recursive: true });
    await fs.mkdir(temporaryRoot, { recursive: true });
    // Admission as the engine would hold it, so worker processes are fenced (SF-27).
    await engine.mutate(s => {
      s.activeRun = { id: runId, initiativeId, stage: 'execution', status: 'running', startedAt: new Date().toISOString() };
    });
    const controller = new AbortController();
    const bridge = await startGitBridge({ context, runDirectory, initiativeId, planHash, baseHead, signal: controller.signal });
    const created = await requestGitBridge(bridge.descriptor.channelPath, { operation: 'create', name: 'cand' });
    log('candidate', JSON.stringify(created));
    if (!created.ok) throw new Error(created.error);
    const candidatePath = created.result.path;
    const schemaPath = path.join(runDirectory, 'smoke-schema.json');
    await fs.writeFile(
      schemaPath,
      JSON.stringify({
        type: 'object',
        properties: {
          delegated: { type: 'boolean' },
          workerId: { type: 'string' },
          workerOutcome: { type: 'string' },
          toolsUsed: { type: 'array', items: { type: 'string' } },
        },
        required: ['delegated', 'workerId', 'workerOutcome', 'toolsUsed'],
        additionalProperties: false,
      }),
    );
    const prompt = [
      'You are the Switchflow phase orchestrator in a throwaway smoke test. Use only the switchflow MCP tools. Do not edit files and do not run shell commands yourself.',
      '1. Call delegate_task with task "DEMO-1", kind "deliver", worktree "cand", and these instructions exactly:',
      '   "Append exactly one line, added by worker, to notes.txt in your worktree. Do not commit and do not use the Git helper. This throwaway repository has no skill files: do not look for them and do not read anything outside your worktree. Your first reply is the approach (outcome approach, three short lines)."',
      '2. Call wait_for_workers with timeoutSeconds 50 until the worker is no longer working.',
      '3. If the worker result outcome is "approach", call send_to_worker with message "Approach confirmed. Implement it now, then reply with outcome handoff." and wait again the same way.',
      '4. Return the JSON: delegated true, the workerId, the final worker outcome, and the switchflow tool names you called in order.',
    ].join('\n');
    const watch = setInterval(async () => {
      const run = (await engine.read()).activeRun;
      for (const worker of run?.workers ?? [])
        if (worker.pid && !watch.seen?.has(worker.pid)) {
          (watch.seen ??= new Set()).add(worker.pid);
          const started = await processStartTime(worker.pid);
          watch.records = [...(watch.records ?? []), { ...worker, processStartedAt: started && new Date(started).toISOString() }];
          log('fence entry', JSON.stringify(watch.records.at(-1)));
        }
    }, 250);
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await agents.run({
        projectRoot: root,
        runDirectory,
        temporaryRoot,
        additionalWritableRoots: [],
        prompt,
        schemaPath,
        signal: controller.signal,
        stage: 'execution',
        runId,
        initiativeId,
        gitBridge: bridge.descriptor,
        onEvent: async entry => {
          if (['session.started', 'turn.completed', 'turn.failed', 'tool', 'notice'].includes(entry.kind))
            log('orchestrator', JSON.stringify(entry).slice(0, 300));
        },
      });
    } finally {
      clearInterval(watch);
      await bridge.close().catch(error => log('bridge close', error.message));
    }
    const after = (await engine.read()).activeRun;
    log('outcome', JSON.stringify(outcome), `${Math.round((Date.now() - startedAt) / 1000)} s`);
    const notes = await fs.readFile(path.join(candidatePath, 'notes.txt'), 'utf8');
    log('candidate notes.txt', JSON.stringify(notes));
    await save('orchestrate-summary.json', {
      outcome,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      notes,
      fenceEntries: watch.records ?? [],
      workersLeftAfterClose: after?.workers ?? [],
    });
    await engine.mutate(s => {
      s.activeRun = null;
    });
    await dumpSessions('orchestrate');
  } else if (mode === 'steer') {
    await agents.updateSettings({
      models: { codex: 'gpt-5.6-luna', claude: 'haiku' },
      efforts: { codex: 'low', claude: 'low' },
      limits: { maxTurns: 12, timeoutMinutes: 5 },
    });
    const runId = randomUUID();
    const runDirectory = path.join(context.stateDir, 'runs', runId);
    const temporaryRoot = path.join(context.stateDir, 'scratch', runId, 'tmp');
    await fs.mkdir(temporaryRoot, { recursive: true });
    const schemaPath = path.join(context.stateDir, 'steer-schema.json');
    const outputSchema = {
      type: 'object',
      properties: { marker: { type: 'string' }, filesRead: { type: 'integer' } },
      required: ['marker', 'filesRead'],
      additionalProperties: false,
    };
    await fs.writeFile(schemaPath, JSON.stringify(outputSchema));
    const opened = await agents.openSession({
      provider,
      role: 'intake',
      kind: 'stage',
      runId,
      initiativeId: null,
      cwd: root,
      sandbox: 'read-only',
      temporaryRoot,
      runDirectory,
    });
    const id = opened.meta.id;
    const slow =
      provider === 'codex'
        ? 'Run the shell command `powershell -NoProfile -Command Start-Sleep -Seconds 25` once, then read notes.txt.'
        : 'Read part-1.txt through part-6.txt one at a time, in order, with a separate Read tool call for each file.';
    const working = async () => {
      for (let i = 0; i < 400; i++) {
        const meta = agents.registry.get(id)?.meta;
        if (meta?.status === 'working' && opened.handle.activeTurnId) return;
        await pause(50);
      }
      throw new Error('Session never started working');
    };
    // Waits until the running turn has produced work (tool or command events), so the owner action lands mid-turn.
    const busy = async (count = 2) => {
      const from = agents.registry.get(id).meta.eventCount;
      for (let i = 0; i < 1200; i++) {
        const events = agents.registry.get(id).events.filter(e => e.seq > from);
        if (events.filter(e => e.kind === 'tool' || (e.kind === 'command' && e.status === 'started')).length >= count) return;
        await pause(50);
      }
      throw new Error('The turn produced no tool activity');
    };
    const results = {};
    // Turn 1: steer while working, then let the turn finish.
    const turn1 = opened.handle.startTurn(`${slow} Then return marker "PLAIN" and the number of files you read.`, {
      outputSchema,
      schemaPath,
    });
    await working();
    await busy(provider === 'codex' ? 1 : 2);
    results.steer = await post(`${api}/agents/${id}/steer`, {
      message: 'Owner steer: when you return, set marker to "STEERED" instead of "PLAIN".',
    });
    log('steer', JSON.stringify(results.steer));
    results.turn1 = await turn1.then(
      value => ({ ok: true, result: value.result, usage: value.usage ?? null }),
      error => ({ ok: false, error: error.message, interrupted: Boolean(error.interrupted) }),
    );
    log('turn1', JSON.stringify(results.turn1));
    // Turn 2: interrupt while working.
    const turn2Started = Date.now();
    const turn2 = opened.handle.startTurn(`${slow} Then return marker "SECOND" and the number of files you read.`, {
      outputSchema,
      schemaPath,
    });
    await working();
    await busy(provider === 'codex' ? 1 : 2);
    const before = await agents.registry.find(id);
    results.canInterrupt = before.canInterrupt;
    results.interrupt = await post(`${api}/agents/${id}/interrupt`, {});
    const interruptAt = Date.now();
    log('interrupt', JSON.stringify(results.interrupt));
    results.turn2 = await turn2.then(
      value => ({ ok: true, result: value.result }),
      error => ({ ok: false, error: error.message, interrupted: Boolean(error.interrupted) }),
    );
    results.turn2.msFromInterruptToSettled = Date.now() - interruptAt;
    results.turn2.msTurnTotal = Date.now() - turn2Started;
    log('turn2', JSON.stringify(results.turn2));
    results.pidAlive = opened.handle.pid ? (await processStartTime(opened.handle.pid)) !== null : null;
    await agents.closeSession(opened.meta, opened.handle, { status: 'completed' });
    await save(`steer-${provider}-summary.json`, results);
    await dumpSessions(`steer-${provider}`);
  } else if (mode === 'crash') {
    // A real worker mid-command, then a hard exit with no cleanup: the service "crashes".
    await agents.updateSettings({
      models: { codex: 'gpt-5.6-luna', claude: 'haiku' },
      efforts: { codex: 'low', claude: 'low' },
      limits: { timeoutMinutes: 5 },
    });
    await engine.create({ title: 'Crash fixture', request: 'Fence a live worker across a crash', start: false });
    const runId = randomUUID();
    let initiativeId;
    await engine.mutate(s => {
      const item = s.initiatives[0];
      initiativeId = item.id;
      item.status = 'running';
      item.runs.push({ id: runId, status: 'running', stage: 'execution' });
      // This process stands in for the stage agent: it dies in the crash too.
      s.activeRun = {
        id: runId,
        initiativeId,
        stage: 'execution',
        status: 'running',
        startedAt: new Date().toISOString(),
        provider: 'codex',
        pid: process.pid,
        processStartedAt: new Date().toISOString(),
      };
    });
    const runDirectory = path.join(context.stateDir, 'runs', runId);
    const temporaryRoot = path.join(context.stateDir, 'scratch', runId, 'tmp');
    await fs.mkdir(temporaryRoot, { recursive: true });
    const opened = await agents.openSession({
      provider,
      role: 'delivery',
      kind: 'deliver',
      runId,
      initiativeId,
      task: 'DEMO-1',
      cwd: root,
      sandbox: 'read-only',
      temporaryRoot,
      runDirectory,
    });
    const task =
      provider === 'codex'
        ? 'Run the shell command `powershell -NoProfile -Command Start-Sleep -Seconds 90` once, then reply DONE.'
        : 'Read part-1.txt through part-6.txt one at a time, in order, with a separate Read tool call for each file, then reply DONE.';
    void opened.handle.startTurn(task, {}).catch(() => {});
    for (let i = 0; i < 1200; i++) {
      const events = agents.registry.get(opened.meta.id)?.events ?? [];
      if (events.filter(e => (e.kind === 'command' && e.status === 'started') || e.kind === 'tool').length >= (provider === 'codex' ? 1 : 2))
        break;
      await pause(50);
    }
    const run = (await engine.read()).activeRun;
    await save('crash-before.json', { activeRun: run, workerPid: opened.handle.pid });
    log('crashing with worker', JSON.stringify(run.workers));
    process.exit(3);
  } else if (mode === 'recover') {
    const before = JSON.parse(await fs.readFile(path.join(out, 'crash-before.json'), 'utf8'));
    const pid = before.workerPid;
    const aliveAtRestart = (await processStartTime(pid)) !== null;
    const state = await (await fetch(`${api}/state`)).json();
    const item = state.initiatives[0];
    log('alive at restart', aliveAtRestart, 'held', JSON.stringify(state.activeRun?.held), 'next', item.nextAction);
    const sessions = (await agents.list()).sessions.map(s => ({ id: s.id, kind: s.kind, status: s.status, error: s.error }));
    log('sessions', JSON.stringify(sessions));
    const retry = await post(`${api}/initiatives/${item.id}/actions`, { action: 'retry', expectedRevision: item.revision });
    log('retry while held', JSON.stringify(retry));
    const stop = await post(`${api}/initiatives/${item.id}/actions`, {
      action: 'stop-processes',
      expectedRevision: item.revision,
    });
    const after = await (await fetch(`${api}/state`)).json();
    const aliveAfterStop = (await processStartTime(pid)) !== null;
    log('stop', stop.status, 'activeRun', JSON.stringify(after.activeRun), 'alive after stop', aliveAfterStop);
    await save('recover-summary.json', {
      pid,
      aliveAtRestart,
      heldAtRestart: state.activeRun?.held ?? null,
      nextAction: item.nextAction,
      sessions,
      retryWhileHeld: retry,
      stopStatus: stop.status,
      activeRunAfterStop: after.activeRun,
      lastEvents: after.initiatives[0].events.slice(-3),
      aliveAfterStop,
    });
  } else throw new Error('Unknown mode');
} finally {
  await app.close();
  log('evidence in', out);
}
