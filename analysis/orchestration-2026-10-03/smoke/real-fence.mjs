// Real-process check of the SF-27 fence on Windows, no model calls: a live "worker" (node with a
// child) recorded at its start, and a live process recorded an hour before it started (a reused PID).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repository root, three levels above analysis/orchestration-2026-10-03/smoke/.
const WORKTREE = fileURLToPath(new URL('../../../', import.meta.url));
const load = name => import(pathToFileURL(path.join(WORKTREE, 'template/.switchflow/scripts', name)).href);
const { createControlServer } = await load('control/server.mjs');
const { resolveProject, updateState } = await load('operations/storage.mjs');
const { createInitiative } = await load('control/lifecycle.mjs');
const { processStartTime, isRunProcessAlive } = await load('control/codex-runner.mjs');

const base = path.join(os.tmpdir(), `sfsmoke-fence-${Date.now()}`);
const root = path.join(base, 'repo');
await fs.mkdir(root, { recursive: true });
execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
execFileSync('git', ['-C', root, '-c', 'user.name=S', '-c', 'user.email=s@localhost', 'commit', '--allow-empty', '-m', 'b'], {
  stdio: 'ignore',
});
const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
// The worker has a grandchild, like an agent running a shell command.
const sleeper = 'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" }); setTimeout(() => {}, 300000);';
const worker = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore', detached: true, windowsHide: true });
const reused = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore', detached: true, windowsHide: true });
worker.unref();
reused.unref();
await new Promise(resolve => setTimeout(resolve, 1500));
const children = () =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${worker.pid}").ProcessId`], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
const grandchildren = children();
const item = createInitiative({ title: 'Fence', request: 'Fence', start: false });
item.status = 'running';
item.runs = [{ id: 'old', status: 'running' }];
const now = new Date().toISOString();
await updateState(context, 'control', () => ({
  schemaVersion: 1,
  revision: 1,
  initiatives: [item],
  activeRun: {
    id: 'old',
    initiativeId: item.id,
    stage: 'execution',
    provider: 'codex',
    pid: 999999,
    processStartedAt: now,
    workers: [
      { sessionId: 'w-live', kind: 'deliver', role: 'delivery', provider: 'claude', task: 'DEMO-1', pid: worker.pid, recordedAt: now },
      {
        sessionId: 'w-reused',
        kind: 'review',
        role: 'review',
        provider: 'codex',
        task: 'DEMO-1',
        pid: reused.pid,
        recordedAt: new Date(Date.now() - 3600000).toISOString(),
      },
    ],
  },
}));
const app = await createControlServer({ context, backlog: { list: async () => [] }, nativeFactory: () => ({ close: async () => {} }) });
const api = `${app.url}/api/projects/${context.id}`;
const { csrfToken } = await (await fetch(`${app.url}/api/projects`)).json();
const post = async body =>
  (
    await fetch(`${api}/initiatives/${item.id}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': csrfToken },
      body: JSON.stringify(body),
    })
  ).status;
try {
  let state = await (await fetch(`${api}/state`)).json();
  const report = {
    worker: { pid: worker.pid, startedAt: new Date(await processStartTime(worker.pid)).toISOString(), grandchildren },
    reused: { pid: reused.pid, startedAt: new Date(await processStartTime(reused.pid)).toISOString() },
    held: state.activeRun.held,
    nextAction: state.initiatives[0].nextAction,
    retryStatus: await post({ action: 'retry', expectedRevision: state.initiatives[0].revision }),
  };
  report.stopStatus = await post({ action: 'stop-processes', expectedRevision: state.initiatives[0].revision });
  await new Promise(resolve => setTimeout(resolve, 500));
  state = await (await fetch(`${api}/state`)).json();
  report.activeRunAfterStop = state.activeRun;
  report.lastEvent = state.initiatives[0].events.at(-1);
  report.aliveAfterStop = {
    worker: isRunProcessAlive(worker.pid),
    grandchildren: grandchildren.map(isRunProcessAlive),
    reused: isRunProcessAlive(reused.pid),
  };
  console.log(JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(base, 'fence-report.json'), JSON.stringify(report, null, 2));
} finally {
  await app.close();
  // Clean up only the processes this script started.
  for (const pid of [worker.pid, reused.pid, ...grandchildren])
    if (isRunProcessAlive(pid)) execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}
