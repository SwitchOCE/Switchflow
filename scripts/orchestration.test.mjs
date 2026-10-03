import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updateState } from '../template/.switchflow/scripts/operations/storage.mjs';
import { AgentHost } from '../template/.switchflow/scripts/control/agent-host.mjs';
import { createControlServer } from '../template/.switchflow/scripts/control/server.mjs';
import {
  Orchestration,
  WORKER_SCHEMAS,
  createOrchestrationFactory,
} from '../template/.switchflow/scripts/control/orchestration.mjs';
import { TOOL_NAMES, handleMessage } from '../template/.switchflow/scripts/control/orchestration-mcp.mjs';
import { fakeProvider, fixture, until } from './agent-fakes.mjs';

const both = { codex: { available: true }, claude: { available: true, loggedIn: true } };
const planHash = 'a'.repeat(64);
const mcpScript = fileURLToPath(
  new URL('../template/.switchflow/scripts/control/orchestration-mcp.mjs', import.meta.url),
);

// Delivery workers return an approach from a read-only turn and hand off from a writable one;
// reviewers block until told the fix landed, then accept.
function respond(text, options, sandbox) {
  if (options.sandbox === 'read-only')
    return {
      task: 'DEMO-1',
      verdict: /ACCEPT/.test(text) ? 'accept' : 'block',
      findings: /ACCEPT/.test(text) ? [] : ['Missing test'],
      blastRadius: 'none',
      comment: /ACCEPT/.test(text) ? 'Verdict: accept' : 'Verdict: block\nMissing test',
      envelope: 'task: DEMO-1',
    };
  return {
    task: 'DEMO-1',
    outcome: sandbox === 'read-only' ? (/NO-APPROACH/.test(text) ? 'blocked' : 'approach') : 'handoff',
    approach: 'files / approach / stop',
    head: 'abc',
    envelope: 'task: DEMO-1',
    summary: 'done',
    blockers: [],
  };
}

async function setup(context, { providers, capabilities = both } = {}) {
  const initiativeId = randomUUID();
  const managedRoot = path.join(context.stateDir, 'candidates', 'grant');
  const candidate = path.join(managedRoot, 'cand');
  await fs.mkdir(candidate, { recursive: true });
  const real = await fs.realpath(candidate);
  await updateState(context, `git-bridge-${initiativeId}-${planHash}`, () => ({
    schemaVersion: 1,
    initiativeId,
    planHash,
    entries: [{ name: 'cand', path: real, branch: 'codex/x' }],
  }));
  const log = [];
  const host = new AgentHost(context, {
    capabilities,
    providers: providers ?? {
      codex: fakeProvider('codex', log, respond),
      claude: fakeProvider('claude', log, respond),
    },
  });
  await host.init();
  const runId = randomUUID();
  const controller = new AbortController();
  const gitBridge = {
    initiativeId,
    planHash,
    managedRoot: await fs.realpath(managedRoot),
    channelPath: path.join(context.stateDir, 'runs', runId, 'git-channel'),
    helperPath: path.join(context.stateDir, 'helper.mjs'),
  };
  const orchestrator = await host.registry.create({ runId, initiativeId, role: 'execution', provider: 'claude' });
  return { host, log, runId, controller, gitBridge, orchestrator, candidate: real, initiativeId };
}

test('MCP server speaks initialize, tools/list and tools/call and reports host refusals as tool errors', async () => {
  const calls = [];
  const forward = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === 'interrupt_worker') throw new Error('Unknown worker for this run.');
    return { workers: [] };
  };
  const init = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { forward },
  );
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { forward }), null);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { forward });
  assert.deepEqual(
    list.result.tools.map(tool => tool.name),
    ['delegate_task', 'worker_status', 'send_to_worker', 'interrupt_worker', 'wait_for_workers'],
  );
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['task', 'kind', 'instructions', 'worktree']);
  const ok = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worker_status', arguments: {} } },
    { forward },
  );
  assert.deepEqual(ok.result.structuredContent, { workers: [] });
  assert.equal(ok.result.isError, false);
  const refused = await handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'interrupt_worker', arguments: { workerId: 'x' } } },
    { forward },
  );
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Unknown worker/);
  const unknown = await handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'shell', arguments: {} } },
    { forward },
  );
  assert.equal(unknown.error.code, -32602);
  assert.equal(
    (await handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, { forward })).error.code,
    -32601,
  );
  assert.equal(calls.length, 2);
});

test('delegate, steer, review return, round cap and cancel stay inside host guardrails', () =>
  fixture(async context => {
    const { host, log, runId, controller, gitBridge, orchestrator, candidate, initiativeId } = await setup(context);
    const orchestration = new Orchestration({
      host,
      runId,
      initiativeId,
      runDirectory: path.join(context.stateDir, 'runs', runId),
      gitBridge,
      signal: controller.signal,
      orchestratorProvider: 'claude',
      serviceUrl: 'http://127.0.0.1:9',
      projectId: context.id,
      taskExists: async task => {
        if (!['DEMO-1', 'DEMO-2', 'DEMO-3'].includes(task)) throw new Error('missing');
      },
    });
    await orchestration.prepare();
    orchestration.setOrchestrator(orchestrator.id);
    assert.equal(host.orchestrations.get(runId), orchestration);
    const call = (tool, args) => orchestration.call(tool, args);
    const refuse = (promise, status, pattern) =>
      assert.rejects(promise, error => error.status === status && pattern.test(error.message));

    // Input and worktree validation.
    await refuse(
      call('delegate_task', { task: 'DEMO-9', kind: 'deliver', instructions: 'x', worktree: 'cand' }),
      404,
      /not found/,
    );
    await refuse(
      call('delegate_task', { task: 'DEMO-1', kind: 'deliver', instructions: 'x', worktree: context.sourceRoot }),
      409,
      /Git helper created/,
    );
    await refuse(
      call('delegate_task', { task: 'DEMO-1', kind: 'merge', instructions: 'x', worktree: 'cand' }),
      400,
      /kind/,
    );
    await refuse(
      call('delegate_task', { task: 'DEMO-1', kind: 'deliver', instructions: 'x', worktree: 'cand', shell: 'rm' }),
      400,
      /Unsupported/,
    );
    await refuse(call('run_shell', {}), 404, /Unknown orchestration tool/);

    // Delegate delivery: routed to Codex, writable only in the candidate and governance roots.
    const delivered = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'Use the accepted base. Return your approach first.',
      worktree: 'cand',
    });
    assert.equal(delivered.provider, 'codex');
    assert.equal(delivered.status, 'working');
    const deliverSession = log.at(-1);
    assert.equal(deliverSession.options.cwd, candidate);
    assert.equal(deliverSession.options.sandbox, 'workspace-write');
    assert.ok(deliverSession.options.writableRoots.includes(candidate));
    assert.ok(!deliverSession.options.writableRoots.includes(context.stateDir));
    assert.deepEqual(deliverSession.outputSchema, WORKER_SCHEMAS.deliver);
    assert.match(deliverSession.prompt, /deliver-task/);
    const listed = (await host.list()).sessions.find(session => session.id === delivered.workerId);
    assert.equal(listed.parentId, orchestrator.id);
    assert.equal(listed.task, 'DEMO-1');
    assert.equal(listed.kind, 'deliver');
    assert.equal(listed.role, 'delivery');

    // The approach turn is read-only although the session may write; nothing confirms it yet.
    assert.equal(delivered.approval, 'drafting');
    assert.equal(delivered.writable, false);
    assert.equal(deliverSession.turns[0].sandbox, 'read-only');
    assert.equal(listed.approval, 'drafting');
    await refuse(
      call('send_to_worker', { workerId: delivered.workerId, message: 'Go', confirm: true }),
      409,
      /not returned an approach yet/,
    );
    await refuse(
      call('send_to_worker', { workerId: delivered.workerId, message: 'Go', confirm: 'yes' }),
      400,
      /confirm must be true or false/,
    );

    // Steer mid-turn, then wait for the approach.
    const steered = await call('send_to_worker', { workerId: delivered.workerId, message: 'Approach FINISH-NOW' });
    assert.equal(steered.mode, 'steer');
    assert.equal(steered.confirmed, false);
    assert.equal(steered.writable, false);
    let waited = await call('wait_for_workers', { workerIds: [delivered.workerId], timeoutSeconds: 5 });
    assert.equal(waited.timedOut, false);
    assert.equal(waited.workers[0].status, 'idle');
    assert.equal(waited.workers[0].result.outcome, 'approach');
    assert.equal(waited.workers[0].approval, 'awaiting-confirmation');
    assert.equal(waited.workers[0].writable, false);
    assert.match(waited.workers[0].note, /confirm:true/);
    assert.equal((await host.registry.find(delivered.workerId)).approval, 'awaiting-confirmation');

    // A message without confirm corrects the approach: another read-only turn, writes stay locked.
    const corrected = await call('send_to_worker', {
      workerId: delivered.workerId,
      message: 'Use a smaller change. Approach again. FINISH-NOW',
    });
    assert.deepEqual([corrected.mode, corrected.confirmed, corrected.writable], ['followup', false, false]);
    assert.match(corrected.note, /Writes stay locked/);
    waited = await call('wait_for_workers', { workerIds: [delivered.workerId], timeoutSeconds: 5 });
    assert.equal(waited.workers[0].approval, 'awaiting-confirmation');
    assert.equal(deliverSession.turns[1].sandbox, 'read-only');

    // Confirm the approach: the follow-up turn on the same thread may write.
    const confirmed = await call('send_to_worker', {
      workerId: delivered.workerId,
      message: 'Confirmed. FINISH-NOW',
      confirm: true,
    });
    assert.deepEqual([confirmed.mode, confirmed.confirmed, confirmed.writable], ['followup', true, true]);
    assert.equal(deliverSession.turns[2].sandbox, undefined);
    waited = await call('wait_for_workers', { timeoutSeconds: 5 });
    assert.equal(waited.workers[0].result.outcome, 'handoff');
    assert.equal(waited.workers[0].approval, 'confirmed');
    assert.equal(waited.workers[0].writable, true);
    assert.equal(waited.workers[0].note, undefined);
    await refuse(
      call('send_to_worker', { workerId: delivered.workerId, message: 'Again', confirm: true }),
      409,
      /already confirmed/,
    );
    assert.deepEqual(deliverSession.steers, ['Approach FINISH-NOW']);
    const deliverEvents = (await host.events(delivered.workerId, 0, 500)).events;
    const steerEvents = deliverEvents.filter(e => e.kind === 'steer');
    assert.equal(steerEvents[0].by, 'orchestrator');
    assert.deepEqual(
      steerEvents.map(e => [e.mode, e.confirm ?? false]),
      [
        ['steer', false],
        ['followup', false],
        ['followup', true],
      ],
    );
    assert.ok(deliverEvents.some(e => e.kind === 'notice' && /confirmed by orchestrator/.test(e.text)));

    // Review: read-only and a different provider from the author.
    await refuse(
      call('delegate_task', { task: 'DEMO-1', kind: 'review', instructions: 'x', worktree: 'cand', provider: 'codex' }),
      409,
      /different provider/,
    );
    const review1 = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'review',
      instructions: 'Review the handoff. FINISH-NOW',
      worktree: 'cand',
    });
    assert.equal(review1.provider, 'claude');
    assert.equal(review1.reviewRound, 1);
    assert.equal(log.at(-1).options.sandbox, 'read-only');
    assert.deepEqual(log.at(-1).options.writableRoots, []);
    // Reviews have no approach gate.
    assert.equal(review1.approval, null);
    assert.equal(review1.writable, false);
    await refuse(
      call('send_to_worker', { workerId: review1.workerId, message: 'Go', confirm: true }),
      409,
      /Only a delegated delivery worker/,
    );
    waited = await call('wait_for_workers', { workerIds: [review1.workerId], timeoutSeconds: 5 });
    assert.equal(waited.workers[0].status, 'completed');
    assert.equal(waited.workers[0].result.verdict, 'block');

    // Findings go back to the author as a follow-up; a fresh review accepts and closes the author.
    await call('send_to_worker', { workerId: delivered.workerId, message: 'Fix: Missing test. FINISH-NOW' });
    await call('wait_for_workers', { workerIds: [delivered.workerId], timeoutSeconds: 5 });
    const review2 = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'review',
      instructions: 'Re-review. ACCEPT FINISH-NOW',
      worktree: 'cand',
    });
    assert.equal(review2.reviewRound, 2);
    await until(
      async () => (await call('worker_status', { workerId: delivered.workerId })).workers[0].status === 'completed',
    );
    await refuse(call('send_to_worker', { workerId: delivered.workerId, message: 'more' }), 409, /finished/);
    // Round cap: maxReviewRounds defaults to 2.
    await refuse(
      call('delegate_task', { task: 'DEMO-1', kind: 'review', instructions: 'again', worktree: 'cand' }),
      409,
      /Review round limit \(2\) reached for DEMO-1/,
    );

    // Worker limit: two running workers, the third is refused.
    const a = await call('delegate_task', { task: 'DEMO-2', kind: 'deliver', instructions: 'slow', worktree: 'cand' });
    const b = await call('delegate_task', { task: 'DEMO-3', kind: 'deliver', instructions: 'slow', worktree: 'cand' });
    await refuse(
      call('delegate_task', { task: 'DEMO-3', kind: 'deliver', instructions: 'slow', worktree: 'cand' }),
      409,
      /At most 2 workers/,
    );
    const timed = await call('wait_for_workers', { workerIds: [a.workerId], timeoutSeconds: 1 });
    assert.equal(timed.timedOut, true);
    assert.equal((await call('interrupt_worker', { workerId: b.workerId })).interrupted, true);
    await until(async () => (await call('worker_status', { workerId: b.workerId })).workers[0].status === 'idle');

    // Cancel: the run's abort reaches every worker.
    controller.abort();
    await orchestration.close();
    await refuse(call('worker_status', {}), 409, /ended/);
    assert.equal(host.orchestrations.has(runId), false);
    const sessions = (await host.list()).sessions;
    assert.equal(sessions.find(s => s.id === a.workerId).status, 'cancelled');
    assert.equal(sessions.find(s => s.id === b.workerId).status, 'completed');
    assert.ok(sessions.filter(s => s.parentId === orchestrator.id).every(s => !s.live));
  }));

test('queued messages run as the next turn, and the suite lock admits one worker at a time', () =>
  fixture(async context => {
    const { host, log, runId, controller, gitBridge, orchestrator, initiativeId } = await setup(context);
    const orchestration = await new Orchestration({
      host,
      runId,
      initiativeId,
      runDirectory: path.join(context.stateDir, 'runs', runId),
      gitBridge,
      signal: controller.signal,
      orchestratorProvider: 'claude',
      serviceUrl: 'http://127.0.0.1:9',
      projectId: context.id,
    }).prepare();
    orchestration.setOrchestrator(orchestrator.id);
    const call = (tool, args, principal) => orchestration.call(tool, args, principal);
    const first = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'slow',
      worktree: 'cand',
    });
    const second = await call('delegate_task', {
      task: 'DEMO-2',
      kind: 'deliver',
      instructions: 'slow',
      worktree: 'cand',
    });

    // Workers get a suite-only MCP server with their own token.
    const workerServer = log[0].options.mcpServers.switchflow;
    assert.equal(workerServer.env.SWITCHFLOW_ORCHESTRATION_TOOLS, 'suite');
    const workerToken = workerServer.env.SWITCHFLOW_ORCHESTRATION_TOKEN;
    assert.notEqual(workerToken, orchestration.token);
    assert.equal(orchestration.authorize(workerToken), first.workerId);
    assert.equal(orchestration.authorize(orchestration.token), 'orchestrator');
    await assert.rejects(
      call('delegate_task', { task: 'DEMO-3', kind: 'deliver', instructions: 'x', worktree: 'cand' }, first.workerId),
      error => error.status === 403,
    );

    // Suite lock: one holder; others wait or time out; release and session end free it.
    assert.equal((await call('acquire_suite_lock', { timeoutSeconds: 1 }, first.workerId)).acquired, true);
    assert.equal((await call('acquire_suite_lock', { timeoutSeconds: 1 }, first.workerId)).acquired, true);
    const blocked = await call('acquire_suite_lock', { timeoutSeconds: 1 }, second.workerId);
    assert.deepEqual(blocked, { acquired: false, heldBy: first.workerId });
    const waiting = call('acquire_suite_lock', { timeoutSeconds: 5 }, second.workerId);
    assert.deepEqual(await call('release_suite_lock', {}, second.workerId), { released: false });
    assert.deepEqual(await call('release_suite_lock', {}, first.workerId), { released: true });
    assert.equal((await waiting).acquired, true);
    await assert.rejects(call('acquire_suite_lock', { timeoutSeconds: 99 }, first.workerId), /1–50/);

    // Queue: held during the turn, then sent as the next turn's input.
    const queued = await call('send_to_worker', { workerId: first.workerId, message: 'Also log it', mode: 'queue' });
    assert.equal(queued.mode, 'queue');
    assert.deepEqual(log[0].steers, []);
    await call('send_to_worker', { workerId: first.workerId, message: 'Approach FINISH-NOW' });
    await until(() => log[0].handle.activeTurnId && log[0].steers.length === 1);
    // The queued message started a new turn on the same session.
    const events = (await host.events(first.workerId, 0, 500)).events;
    assert.deepEqual(
      events.filter(e => e.kind === 'steer').map(e => e.mode),
      ['queue', 'steer'],
    );
    assert.equal(events.filter(e => e.kind === 'turn.started').length, 2);
    await assert.rejects(
      call('send_to_worker', { workerId: first.workerId, message: 'x', mode: 'now' }),
      /mode must be steer or queue/,
    );

    // Ending the worker that holds the lock releases it.
    assert.equal(host.suiteLock.holder, second.workerId);
    controller.abort();
    await orchestration.close();
    assert.equal(host.suiteLock, null);
    assert.equal(orchestration.authorize(workerToken), null);
  }));

test('only a confirmed approach unlocks writes; the owner can confirm too', () =>
  fixture(async context => {
    const { host, log, runId, controller, gitBridge, orchestrator, initiativeId } = await setup(context);
    const orchestration = await new Orchestration({
      host,
      runId,
      initiativeId,
      runDirectory: path.join(context.stateDir, 'runs', runId),
      gitBridge,
      signal: controller.signal,
      orchestratorProvider: 'claude',
      serviceUrl: 'http://127.0.0.1:9',
      projectId: context.id,
    }).prepare();
    orchestration.setOrchestrator(orchestrator.id);
    const call = (tool, args) => orchestration.call(tool, args);
    const refuse = (promise, pattern) =>
      assert.rejects(promise, error => error.status === 409 && pattern.test(error.message));
    const worker = await call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'NO-APPROACH FINISH-NOW',
      worktree: 'cand',
    });
    const session = log[0];
    // A read-only turn that returns no approach leaves nothing to confirm.
    let [status] = (await call('wait_for_workers', { timeoutSeconds: 5 })).workers;
    assert.equal(status.result.outcome, 'blocked');
    assert.equal(status.approval, 'drafting');
    await refuse(host.steer(worker.workerId, { message: 'Go', confirm: true }), /not returned an approach/);

    // A correction without confirm runs read-only; confirming while it runs is refused.
    await call('send_to_worker', { workerId: worker.workerId, message: 'Return your approach.' });
    await until(() => session.handle.activeTurnId);
    await refuse(
      call('send_to_worker', { workerId: worker.workerId, message: 'Go', confirm: true }),
      /not returned an approach yet/,
    );
    await call('send_to_worker', { workerId: worker.workerId, message: 'FINISH-NOW' });
    [status] = (await call('wait_for_workers', { timeoutSeconds: 5 })).workers;
    assert.equal(status.approval, 'awaiting-confirmation');
    assert.deepEqual(
      session.turns.map(turn => turn.sandbox),
      ['read-only', 'read-only'],
    );

    // The owner confirms from the browser; the steer and history say so.
    await assert.rejects(host.steer(worker.workerId, { message: 'Go', confirm: 1 }), /confirm must be true or false/);
    const confirmed = await host.steer(worker.workerId, { message: 'Approved. FINISH-NOW', confirm: true });
    assert.deepEqual([confirmed.mode, confirmed.confirmed, confirmed.writable], ['followup', true, true]);
    assert.equal(session.turns[2].sandbox, undefined);
    [status] = (await call('wait_for_workers', { timeoutSeconds: 5 })).workers;
    assert.equal(status.result.outcome, 'handoff');
    const events = (await host.events(worker.workerId, 0, 500)).events;
    assert.ok(events.some(e => e.kind === 'steer' && e.by === 'owner' && e.confirm === true));
    assert.ok(events.some(e => e.kind === 'notice' && /confirmed by owner/.test(e.text)));
    controller.abort();
    await orchestration.close();
  }));

test('review needs the other provider; without it the host refuses instead of self-review', () =>
  fixture(async context => {
    const { host, runId, controller, gitBridge, orchestrator, initiativeId } = await setup(context, {
      capabilities: { codex: { available: true }, claude: { available: true, loggedIn: false } },
    });
    const orchestration = await new Orchestration({
      host,
      runId,
      initiativeId,
      runDirectory: path.join(context.stateDir, 'runs', runId),
      gitBridge,
      signal: controller.signal,
      orchestratorProvider: 'codex',
      serviceUrl: 'http://127.0.0.1:9',
      projectId: context.id,
    }).prepare();
    orchestration.setOrchestrator(orchestrator.id);
    await assert.rejects(
      orchestration.call('delegate_task', { task: 'DEMO-1', kind: 'review', instructions: 'x', worktree: 'cand' }),
      /Independent review needs claude, but claude is not signed in/,
    );
    const worker = await orchestration.call('delegate_task', {
      task: 'DEMO-1',
      kind: 'deliver',
      instructions: 'x',
      worktree: 'cand',
      provider: 'claude',
    });
    // Delivery may fall back visibly; review independence may not.
    assert.equal(worker.provider, 'codex');
    assert.equal(worker.fallback.from, 'claude');
    await orchestration.close();
  }));

test('either provider can orchestrate: Codex gets per-thread MCP config, Claude an MCP config file', () =>
  fixture(async context => {
    for (const orchestratorProvider of ['codex', 'claude']) {
      const seen = [];
      const capture = name => async options => {
        seen.push(options);
        return fakeProvider(name, [], () => ({ ...respond('', options) }))(options);
      };
      const { host, runId, gitBridge, initiativeId } = await setup(context, {
        providers: { codex: capture('codex'), claude: capture('claude') },
      });
      await host.updateSettings({ roles: { execution: orchestratorProvider } });
      host.orchestrationFactory = createOrchestrationFactory({
        serviceUrl: () => 'http://127.0.0.1:9',
        projectId: context.id,
      });
      const runDirectory = path.join(context.stateDir, 'runs', runId);
      const schemaPath = path.join(runDirectory, 'schema.json');
      await fs.mkdir(runDirectory, { recursive: true });
      await fs.writeFile(schemaPath, '{"type":"object"}');
      await host.run({
        projectRoot: context.sourceRoot,
        runDirectory,
        temporaryRoot: path.join(context.stateDir, 'tmp'),
        prompt: 'Current stage: execution FINISH-NOW',
        schemaPath,
        stage: 'execution',
        runId,
        initiativeId,
        gitBridge,
      });
      const options = seen[0];
      if (orchestratorProvider === 'codex') {
        const server = options.mcpServers.switchflow;
        assert.equal(server.command, process.execPath);
        assert.equal(server.args[0], mcpScript);
        assert.match(server.env.SWITCHFLOW_ORCHESTRATION_URL, new RegExp(`/orchestration/${runId}$`));
        assert.match(server.env.SWITCHFLOW_ORCHESTRATION_TOKEN, /^[a-f0-9]{64}$/);
      } else {
        const config = JSON.parse(await fs.readFile(options.mcpConfigPath, 'utf8'));
        assert.equal(config.mcpServers.switchflow.type, 'stdio');
        assert.equal(config.mcpServers.switchflow.args[0], mcpScript);
      }
      if (orchestratorProvider === 'claude') assert.equal(options.gitHelperPath, gitBridge.helperPath);
      // The run's token stops working when the run ends.
      assert.equal(host.orchestrations.has(runId), false);
    }
  }));

test('the stdio MCP helper reaches the run over HTTP with the run token only', () =>
  fixture(async context => {
    const app = await createControlServer({
      context,
      capabilities: both,
      backlog: { list: async () => [], view: async () => ({}) },
      providers: { codex: fakeProvider('codex', [], respond), claude: fakeProvider('claude', [], respond) },
    });
    let child;
    try {
      const { agents } = app.projects.get(context.id);
      const { runId, controller, gitBridge, initiativeId } = await setup(context);
      const orchestration = await createOrchestrationFactory({
        serviceUrl: () => app.url,
        projectId: context.id,
        adapter: { view: async () => ({}) },
      })({
        host: agents,
        runId,
        initiativeId,
        runDirectory: path.join(context.stateDir, 'runs', runId),
        gitBridge,
        signal: controller.signal,
        orchestratorProvider: 'claude',
      });
      const endpoint = orchestration.endpoint;
      const post = (url, token, body = {}) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Switchflow-Run-Token': token } : {}) },
          body: JSON.stringify(body),
        });
      assert.equal((await post(`${endpoint}/worker_status`)).status, 403);
      assert.equal((await post(`${endpoint}/worker_status`, 'f'.repeat(64))).status, 403);
      assert.equal(
        (await post(endpoint.replace(runId, randomUUID()) + '/worker_status', orchestration.token)).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${endpoint}/worker_status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Switchflow-Run-Token': orchestration.token,
              Origin: 'https://evil.example',
            },
            body: '{}',
          })
        ).status,
        403,
      );
      const direct = await post(`${endpoint}/worker_status`, orchestration.token);
      assert.deepEqual(await direct.json(), { result: { workers: [] } });

      child = spawn(process.execPath, [mcpScript], {
        env: { ...process.env, ...orchestration.mcpServers.switchflow.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const replies = new Map();
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          replies.set(message.id, message);
        }
      });
      const rpc = async (id, method, params) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return until(() => replies.get(id));
      };
      assert.equal(
        (await rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name,
        'switchflow',
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      assert.deepEqual(
        (await rpc(2, 'tools/list', {})).result.tools.map(tool => tool.name),
        TOOL_NAMES,
      );
      const delegated = await rpc(3, 'tools/call', {
        name: 'delegate_task',
        arguments: { task: 'DEMO-1', kind: 'deliver', instructions: 'Approach FINISH-NOW', worktree: 'cand' },
      });
      assert.equal(delegated.result.isError, false);
      const workerId = delegated.result.structuredContent.workerId;
      const waited = await rpc(4, 'tools/call', {
        name: 'wait_for_workers',
        arguments: { workerIds: [workerId], timeoutSeconds: 5 },
      });
      assert.equal(waited.result.structuredContent.workers[0].result.outcome, 'approach');
      const refused = await rpc(5, 'tools/call', {
        name: 'delegate_task',
        arguments: { task: 'DEMO-1', kind: 'deliver', instructions: 'x', worktree: context.sourceRoot },
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /Git helper created/);
      // The worker is visible to the owner as a child session.
      const listed = await (await fetch(`${app.url}/api/projects/${context.id}/agents`)).json();
      assert.ok(listed.sessions.some(session => session.id === workerId && session.kind === 'deliver'));
      controller.abort();
      await orchestration.close();
      assert.equal((await post(`${endpoint}/worker_status`, orchestration.token)).status, 403);
    } finally {
      child?.stdin.end();
      child?.kill();
      await app.close();
    }
  }));
