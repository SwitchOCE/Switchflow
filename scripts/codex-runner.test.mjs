import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexArguments, isRunProcessAlive, startCodexRun } from '../template/.switchflow/scripts/control/codex-runner.mjs';
import { buildAgentPrompt, schemaPathForStage, validateAgentResult } from '../template/.switchflow/scripts/control/agent-protocol.mjs';

const thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const result = { stage: 'intake', status: 'ready', summary: 'Scope prepared', nextAction: 'Owner: approve scope', questions: [], scope: 'Deliver a project board', plan: [], evidence: [], blockers: [], uat: [] };

async function fixture(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'switchflow-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'fake-cli.cjs');
  await writeFile(scriptPath, script);
  return { projectRoot: root, runDirectory: path.join(root, 'run'), prompt: 'A prompt with $(literal) and `literal`', spawnProcess: (_exe, args, options) => spawn(process.execPath, [scriptPath, ...args], options) };
}

const success = `const fs=require('fs');const args=process.argv.slice(2);let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(result)}));console.log(JSON.stringify({type:'thread.started',thread_id:'${thread}'}));console.log(JSON.stringify({type:'turn.completed'}));});`;

test('fresh and resumed commands enforce sandbox and noninteractive approvals', () => {
  for (const resumeThreadId of [undefined, thread]) {
    const args = codexArguments({ outputPath: 'out.json', resumeThreadId });
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
    assert.ok(args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
    assert.equal(args.at(-1), '-');
    assert.ok(!args.some((a) => a.includes('bypass')));
  }
  assert.throws(() => codexArguments({ sandboxMode: 'danger-full-access' }));
  assert.throws(() => codexArguments({ resumeThreadId: '--last' }));
  assert.throws(() => codexArguments({ temporaryRoot: 'relative-path' }));
  const temporaryRoot = path.resolve(os.tmpdir(), 'bounded-scratch');
  const scoped = codexArguments({ outputPath: 'out.json', temporaryRoot });
  assert.ok(scoped.includes(`shell_environment_policy.set.TEMP=${JSON.stringify(temporaryRoot)}`));
  assert.ok(scoped.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([temporaryRoot])}`));
});

test('streams events, saves thread ID, and parses final structured result', async (t) => {
  const options = await fixture(t, success);
  const events = [];
  const actual = await startCodexRun({ ...options, onEvent: async (event) => { events.push(event); } });
  assert.deepEqual(actual, { threadId: thread, result, exitCode: 0 });
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'runner.started');
  assert.ok(events[0].pid > 0);
  const completion = JSON.parse(await readFile(path.join(options.runDirectory, 'completion.json')));
  assert.equal(completion.status, 'completed');
  await assert.rejects(startCodexRun(options), /EEXIST/);
});

for (const [name, script, pattern] of [
  ['turn failure even with exit zero', success.replace("type:'turn.completed'", "type:'turn.failed',error:'approval unavailable'"), /turn.failed/],
  ['missing completion', success.replace("console.log(JSON.stringify({type:'turn.completed'}));", ''), /without a completed turn/],
  ['malformed JSONL', "console.log('not json');", /Malformed/],
  ['oversized line', "console.log('x'.repeat(3*1024*1024));", /line limit/],
  ['nonzero exit', 'process.exit(7);', /code 7/],
]) {
  test(`rejects ${name} and persists failure`, async (t) => {
    const options = await fixture(t, script);
    await assert.rejects(startCodexRun(options), pattern);
    const completion = JSON.parse(await readFile(path.join(options.runDirectory, 'completion.json')));
    assert.equal(completion.status, 'failed');
  });
}

test('cancellation and timeout terminate active process', async (t) => {
  const options = await fixture(t, 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(startCodexRun({ ...options, signal: controller.signal }), /cancelled/);
  await assert.rejects(startCodexRun({ ...options, runDirectory: path.join(options.projectRoot, 'timeout'), timeoutMs: 150 }), /timed out/);
});

test('event persistence failure fails the run and recovery probes are conservative', async (t) => {
  const options = await fixture(t, success);
  await assert.rejects(startCodexRun({ ...options, onEvent: async () => { throw new Error('state persistence unavailable'); } }), /state persistence unavailable/);
  assert.equal(isRunProcessAlive(process.pid), true);
  assert.equal(isRunProcessAlive(-1), false);
  assert.equal(isRunProcessAlive('123'), false);
});

test('stage validation protects human gates and evidence claims', async () => {
  assert.deepEqual(validateAgentResult('intake', result), result);
  assert.throws(() => validateAgentResult('intake', { ...result, scope: '' }), /scope required/);
  assert.throws(() => validateAgentResult('planning', { ...result, stage: 'planning' }), /plan required/);
  assert.throws(() => validateAgentResult('execution', { ...result, stage: 'execution', status: 'ready_for_uat' }), /evidence/);
  assert.throws(() => validateAgentResult('intake', { ...result, approved: true }), /fields/);
  for (const stage of ['intake', 'planning', 'execution', 'uat']) {
    const schema = JSON.parse(await readFile(schemaPathForStage(stage)));
    assert.deepEqual(schema.properties.stage.enum, [stage]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.summary.minLength, 1);
    assert.equal(schema.properties.nextAction.minLength, 1);
    assert.equal(schema.properties.scope.minLength, undefined);
    for (const field of ['evidence', 'blockers', 'uat']) assert.equal(schema.properties[field].items.minLength, 1);
  }
  assert.match(buildAgentPrompt({ stage: 'execution', state: { approvedScope: 'approved' } }), /orchestrate-project/);
  assert.match(buildAgentPrompt({ stage: 'execution' }), /plus resolvePaths from that conflict object/);
  assert.match(buildAgentPrompt({ stage: 'execution' }), /not a new human gate/);
  const finalization = buildAgentPrompt({ stage: 'uat', state: { approvedUat: { accepted: true, candidate: 'candidate-head' } } });
  assert.match(finalization, /\.agents\/skills\/guided-uat\/SKILL\.md/);
  assert.match(finalization, /state\.approvedUat contains the owner's recorded acceptance/);
  assert.match(finalization, /Do not ask for UAT acceptance again/);
  assert.match(finalization, /does not authorize primary\/main integration/);
});

test('normalizes only blank text-array entries without mutating source or weakening UAT evidence', () => {
  const source = { ...result, evidence: [' ', 'actual evidence'], blockers: [''], uat: ['guidance', '\t\n'] };
  const normalized = validateAgentResult('intake', source);
  assert.notEqual(normalized, source);
  assert.deepEqual(normalized.evidence, ['actual evidence']);
  assert.deepEqual(normalized.blockers, []);
  assert.deepEqual(normalized.uat, ['guidance']);
  assert.deepEqual(source.uat, ['guidance', '\t\n']);
  const execution = { ...result, stage: 'execution', status: 'ready_for_uat', evidence: ['real test record'], uat: ['walkthrough'] };
  assert.throws(() => validateAgentResult('execution', { ...execution, evidence: [''] }), /evidence/);
  assert.throws(() => validateAgentResult('execution', { ...execution, uat: [' \t'] }), /evidence/);
  for (const field of ['evidence', 'blockers', 'uat']) {
    assert.throws(() => validateAgentResult('intake', { ...result, [field]: [null] }), /bounded strings/);
  }
  assert.throws(() => validateAgentResult('intake', { ...result, status: 'blocked', blockers: [''] }), /blockers required/);
});
