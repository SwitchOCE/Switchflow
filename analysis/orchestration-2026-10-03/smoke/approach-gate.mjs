// Capped real run of the approach gate against a throwaway repository. Usage:
//   node approach-gate.mjs <claude|codex> [--attempt]
// Delegates one delivery task straight through the Orchestration (no orchestrator model), checks
// that the approach turn leaves the worktree unchanged, confirms, and checks the edit lands.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKTREE = fileURLToPath(new URL('../../../', import.meta.url));
const control = name => import(pathToFileURL(path.join(WORKTREE, 'template/.switchflow/scripts', name)).href);
const { createControlServer } = await control('control/server.mjs');
const { resolveProject } = await control('operations/storage.mjs');
const { startGitBridge } = await control('control/git-bridge.mjs');
const { requestGitBridge } = await control('control/git-bridge-client.mjs');
const { openClaudeSession } = await control('control/providers/claude-cli.mjs');
const { openCodexSession } = await control('control/providers/codex-app-server.mjs');

const provider = process.argv[2];
const attempt = process.argv.includes('--attempt');
if (!['claude', 'codex'].includes(provider)) throw new Error('Usage: node approach-gate.mjs <claude|codex>');
const base = path.join(os.tmpdir(), `sfgate-${provider}${attempt ? '-attempt' : ''}-${Date.now()}`);
const out = path.join(base, 'out');
const root = path.join(base, 'repo');
await fs.mkdir(out, { recursive: true });
await fs.mkdir(root);
const git = (...args) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true });
await fs.writeFile(path.join(root, 'notes.txt'), 'first line\n');
git('add', '.');
git('commit', '-m', 'Throwaway smoke baseline');
const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2));

// Record each provider process's arguments so the evidence shows the permission set per process.
const spawned = [];
const recordSpawn = (exe, args, options) => {
  const child = spawn(exe, args, options);
  spawned.push({ at: new Date().toISOString(), pid: child.pid, args });
  return child;
};
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
  providers: {
    claude: options => openClaudeSession({ ...options, spawnProcess: recordSpawn }),
    codex: options => openCodexSession({ ...options, spawnProcess: recordSpawn }),
  },
});
const { agents, engine } = app.projects.get(context.id);
log('providers', JSON.stringify(agents.capabilities));
const controller = new AbortController();
let bridge;
let orchestration;
try {
  await agents.updateSettings({
    roles: { delivery: provider, review: provider === 'claude' ? 'codex' : 'claude' },
    models: { codex: 'gpt-5.6-luna', claude: 'haiku' },
    efforts: { codex: 'low', claude: 'low' },
    limits: { maxWorkers: 1, maxTurns: 12, timeoutMinutes: 6 },
  });
  const initiativeId = randomUUID();
  const runId = randomUUID();
  const runDirectory = path.join(context.stateDir, 'runs', runId);
  await fs.mkdir(runDirectory, { recursive: true });
  // Admission as the engine holds it, so the worker's processes are fenced (SF-27).
  await engine.mutate(s => {
    s.activeRun = { id: runId, initiativeId, stage: 'execution', status: 'running', startedAt: new Date().toISOString() };
  });
  bridge = await startGitBridge({
    context,
    runDirectory,
    initiativeId,
    planHash: 'c'.repeat(64),
    baseHead: git('rev-parse', 'HEAD'),
    signal: controller.signal,
  });
  const created = await requestGitBridge(bridge.descriptor.channelPath, { operation: 'create', name: 'cand' });
  if (!created.ok) throw new Error(created.error);
  const notesPath = path.join(created.result.path, 'notes.txt');
  orchestration = await agents.orchestrationFactory({
    host: agents,
    runId,
    initiativeId,
    runDirectory,
    gitBridge: bridge.descriptor,
    signal: controller.signal,
    orchestratorProvider: provider === 'claude' ? 'codex' : 'claude',
  });
  const call = (tool, args) => orchestration.call(tool, args);
  const fence = [];
  const watch = setInterval(async () => {
    const pid = (await engine.read()).activeRun?.workers?.[0]?.pid ?? null;
    if (fence.at(-1)?.pid !== pid) fence.push({ at: new Date().toISOString(), pid });
  }, 100);
  const waitIdle = async () => {
    for (;;) {
      const waited = await call('wait_for_workers', { timeoutSeconds: 50 });
      if (waited.workers[0].status !== 'working') return waited.workers[0];
    }
  };
  const startedAt = Date.now();
  const delegated = await call('delegate_task', {
    task: 'DEMO-1',
    kind: 'deliver',
    worktree: 'cand',
    instructions: [
      'Append exactly one line, the text added by worker, to notes.txt in your worktree; make the edit as early as you can.',
      // --attempt: ask outright for a write in the approach turn, to show the sandbox refusing it.
      ...(attempt
        ? ['Smoke check: in your first turn, before replying, try once to append the line with a shell command and put whether it worked in summary.']
        : []),
      'Do not commit and do not use the Git helper. This throwaway repository has no skill files: do not look for them and do not read anything outside your worktree.',
    ].join(' '),
  });
  log('delegated', delegated.workerId, delegated.provider, delegated.approval);
  const approach = await waitIdle();
  const notesAfterApproach = await fs.readFile(notesPath, 'utf8');
  log('approach turn', JSON.stringify({ approval: approach.approval, writable: approach.writable, note: approach.note }));
  log('notes.txt after approach', JSON.stringify(notesAfterApproach));
  const confirm = await call('send_to_worker', {
    workerId: delegated.workerId,
    message: 'Approach confirmed. Implement it now, then reply with outcome handoff.',
    confirm: true,
  });
  log('confirm', JSON.stringify(confirm));
  const handoff = await waitIdle();
  const notesAfterConfirm = await fs.readFile(notesPath, 'utf8');
  log('handoff', JSON.stringify({ outcome: handoff.result?.outcome, approval: handoff.approval }));
  log('notes.txt after confirm', JSON.stringify(notesAfterConfirm));
  clearInterval(watch);
  const events = (await agents.events(delegated.workerId, 0, 2000)).events;
  await orchestration.close();
  const after = (await engine.read()).activeRun;
  const tag = `gate-${provider}${attempt ? '-attempt' : ''}`;
  await save(`${tag}-summary.json`, {
    seconds: Math.round((Date.now() - startedAt) / 1000),
    delegated: { approval: delegated.approval, writable: delegated.writable },
    approach: { status: approach.status, approval: approach.approval, writable: approach.writable, note: approach.note, result: approach.result },
    notesAfterApproach,
    confirm,
    handoff: { status: handoff.status, approval: handoff.approval, writable: handoff.writable, result: handoff.result, usage: handoff.usage },
    notesAfterConfirm,
    processes: spawned,
    fence,
    workersLeftAfterClose: after?.workers ?? [],
  });
  await save(`${tag}-events.json`, events);
  await engine.mutate(s => {
    s.activeRun = null;
  });
} finally {
  controller.abort();
  await orchestration?.close().catch(() => {});
  await bridge?.close().catch(error => log('bridge close', error.message));
  await app.close();
  log('evidence in', out);
}
