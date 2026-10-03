// Real run of one delegated delivery worker on the SSH environment (WSL box), driven through the
// same Orchestration and AgentHost the service uses. Throwaway repo under %TEMP%.
// Usage: node analysis/environments-2026-10-03/ssh-real-run.mjs [codex|claude]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { updateState } from '../../template/.switchflow/scripts/operations/storage.mjs';
import { AgentHost } from '../../template/.switchflow/scripts/control/agent-host.mjs';
import { Orchestration } from '../../template/.switchflow/scripts/control/orchestration.mjs';
import { fixture, roomyPool, until } from '../../scripts/agent-fakes.mjs';

const provider = process.argv[2] || 'codex';
const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...parts);

await fixture(async context => {
  const planHash = 'e'.repeat(64);
  const initiativeId = randomUUID();
  const managedRoot = path.join(context.stateDir, 'candidates', 'grant');
  const candidate = path.join(managedRoot, 'cand');
  await fs.mkdir(managedRoot, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', candidate]);
  await fs.writeFile(path.join(candidate, 'README.md'), '# Greeter\n\nA throwaway fixture.\n');
  await fs.writeFile(path.join(candidate, 'greet.js'), "export const greet = name => `Hello, ${name}`;\n");
  git(candidate, 'add', '-A');
  git(candidate, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Base');
  const real = await fs.realpath(candidate);
  await updateState(context, `git-bridge-${initiativeId}-${planHash}`, () => ({
    schemaVersion: 1,
    initiativeId,
    planHash,
    entries: [{ name: 'cand', path: real, branch: 'codex/x' }],
  }));
  const host = new AgentHost(context, {
    capabilities: { codex: { available: true }, claude: { available: true, loggedIn: true } },
    capacity: { pool: roomyPool() },
  });
  await host.init();
  await host.updateSettings({
    roles: { delivery: provider },
    models: { claude: 'haiku' },
    efforts: { codex: 'low' },
    limits: { maxTurns: 30, timeoutMinutes: 15 },
    environments: [
      {
        id: 'wsl',
        kind: 'ssh',
        label: 'WSL Ubuntu',
        host: 'localhost',
        port: 2222,
        user: 'keech',
        identityFile: path.join(process.env.USERPROFILE, '.ssh', 'switchflow_wsl_ed25519'),
        workRoot: '/home/keech/sf-envtest',
        wake: 'wsl.exe -d Ubuntu -- true',
        keepAwake: 'wsl.exe -d Ubuntu -- sleep infinity',
      },
    ],
    placement: { delivery: 'wsl' },
  });
  log('health', JSON.stringify(await host.testEnvironment('wsl')));
  const runId = randomUUID();
  const controller = new AbortController();
  const orchestration = new Orchestration({
    host,
    runId,
    initiativeId,
    runDirectory: path.join(context.stateDir, 'runs', runId),
    gitBridge: {
      initiativeId,
      planHash,
      managedRoot: await fs.realpath(managedRoot),
      channelPath: path.join(context.stateDir, 'runs', runId, 'git-channel'),
      helperPath: path.join(context.stateDir, 'helper.mjs'),
    },
    signal: controller.signal,
    orchestratorProvider: provider === 'codex' ? 'claude' : 'codex',
    serviceUrl: 'http://127.0.0.1:9',
    projectId: context.id,
  });
  await orchestration.prepare();
  const orchestrator = await host.registry.create({ runId, initiativeId, role: 'execution', provider: 'claude' });
  orchestration.setOrchestrator(orchestrator.id);
  const call = (tool, args) => orchestration.call(tool, args);
  try {
    const delivered = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      worktree: 'cand',
      instructions:
        'Task: add a function `shout(name)` to greet.js that returns the greeting in upper case. Keep it to that one change. Skip skills and Backlog; this is a fixture repo. Be brief.',
    });
    log('delegated', delivered.workerId, delivered.provider, 'on', delivered.environment, delivered.status);
    const id = delivered.workerId;
    const entry = () => host.registry.get(id);
    await until(() => entry()?.handle?.activeTurnId, 120000);
    // Steer once the agent is visibly working, so the steer lands mid-turn.
    await until(async () => (await host.events(id, 0, 500)).events.some(event => ['tool', 'command', 'message'].includes(event.kind)), 120000);
    log('approach turn running; steering');
    const steer = await call('send_to_worker', {
      workerId: id,
      message: 'Steer: in your approach, also name the exact file you will touch.',
    }).catch(error => ({ error: error.message }));
    log('steer', JSON.stringify(steer));
    let waited;
    do waited = await call('wait_for_workers', { workerIds: [id], timeoutSeconds: 50 });
    while (waited.timedOut);
    log('approach', waited.workers[0].status, waited.workers[0].approval, JSON.stringify(waited.workers[0].result?.approach ?? waited.workers[0].error));
    if (waited.workers[0].status === 'idle' && waited.workers[0].approval === 'drafting') {
      // The approach gate lets the orchestrator correct a draft: another read-only turn.
      await call('send_to_worker', { workerId: id, message: 'Return your three-line approach for the shout(name) task now.' });
      do waited = await call('wait_for_workers', { workerIds: [id], timeoutSeconds: 50 });
      while (waited.timedOut);
      log('approach (corrected)', waited.workers[0].approval, JSON.stringify(waited.workers[0].result?.approach));
    }
    if (waited.workers[0].status !== 'idle') {
      for (const event of (await host.events(id, 0, 500)).events.slice(-15)) log('  ', JSON.stringify(event).slice(0, 400));
      throw new Error('worker did not return an approach');
    }

    // Confirm, then interrupt the writing turn once it is running.
    await call('send_to_worker', {
      workerId: id,
      confirm: true,
      message: 'Approach confirmed. Before editing, run the shell command `sleep 45` and wait for it, then implement.',
    });
    await until(() => entry()?.handle?.activeTurnId, 60000);
    const events = async () => (await host.events(id, 0, 500)).events;
    await until(async () => (await events()).some(event => event.kind === 'command'), 90000).catch(() => null);
    log('interrupting the writing turn');
    log('interrupt', JSON.stringify(await call('interrupt_worker', { workerId: id })));
    do waited = await call('wait_for_workers', { workerIds: [id], timeoutSeconds: 50 });
    while (waited.timedOut);
    log('after interrupt', waited.workers[0].status, JSON.stringify(waited.workers[0].collected ?? null));

    await call('send_to_worker', {
      workerId: id,
      message: 'Skip the sleep. Implement shout(name) in greet.js now and hand off.',
    });
    do waited = await call('wait_for_workers', { workerIds: [id], timeoutSeconds: 50 });
    while (waited.timedOut);
    const summary = waited.workers[0];
    log('handoff', summary.status, summary.result?.outcome, JSON.stringify(summary.collected), JSON.stringify(summary.usage));
    log('local candidate log:\n' + git(real, 'log', '--oneline', '-5'));
    log('local greet.js:\n' + (await fs.readFile(path.join(real, 'greet.js'), 'utf8')));
    const all = await events();
    const counts = {};
    for (const event of all) counts[event.kind] = (counts[event.kind] || 0) + 1;
    log('event kinds', JSON.stringify(counts));
    for (const event of all.filter(event => ['notice', 'steer', 'interrupt', 'session.started'].includes(event.kind)))
      log('  ', event.kind, JSON.stringify(event.text ?? event.threadId ?? event.by ?? ''));
    const meta = await host.registry.find(id);
    log('session environment', meta.environment, 'pid fence', JSON.stringify(orchestration.workers.get(id)?.handle?.pid ?? null));
    await orchestration.finishWorker(orchestration.workers.get(id), 'completed');
    log('finished; remote worktree cleaned');
  } finally {
    await orchestration.close();
    await host.close();
  }
});
