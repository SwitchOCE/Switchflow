import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_ROOT,
  STAGE_SKILLS,
  defaultWorkflowSkillsDir,
  loadWorkflowSkill,
  promptWorkflowSkills,
  readProjectMetadata,
  templateTokens,
} from '../template/.switchflow/scripts/control/workflow-skills.mjs';
import { buildAgentPrompt } from '../template/.switchflow/scripts/control/agent-protocol.mjs';
import { workerPrompt } from '../template/.switchflow/scripts/control/orchestration.mjs';
import { taskDocument } from '../template/.switchflow/scripts/control/environments/claude-cloud.mjs';
import { MAX_PROMPT, taskPrompt } from '../template/.switchflow/scripts/control/environments/codex-cloud.mjs';

const SKILLS = fileURLToPath(new URL('../template/.agents/skills', import.meta.url));
const plugin = {
  schemaVersion: 1,
  install: 'plugin',
  projectName: 'Owner\'s "Big" App',
  taskPrefix: 'BIG',
  ownerName: "Ann O'Neil",
  repositoryUrl: '',
  projectPhase: 'Delivery',
};

async function project(t, metadata) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-skills-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (metadata) {
    await fs.mkdir(path.join(root, '.switchflow'));
    await fs.writeFile(path.join(root, '.switchflow', 'project.json'), JSON.stringify(metadata));
  }
  return root;
}

const worker = (governanceRoot, overrides = {}) => ({
  kind: 'deliver',
  task: 'BIG-3',
  worktree: path.join(governanceRoot, 'wt'),
  candidate: 'candidate',
  governanceRoot,
  gitBridge: { helperPath: 'helper.mjs', channelPath: 'channel' },
  instructions: 'Deliver BIG-3. finish now',
  skillsDir: SKILLS,
  ...overrides,
});
const count = (text, needle) => text.split(needle).length - 1;

test('placeholders fill as the import script fills them, YAML-quoted variants included', async t => {
  const dir = await project(t);
  await fs.mkdir(path.join(dir, 'demo'));
  await fs.writeFile(
    path.join(dir, 'demo', 'SKILL.md'),
    [
      '---',
      "description: 'For {{PROJECT_NAME_YAML_SINGLE}}'",
      '---',
      '# Demo',
      '',
      "single '{{PROJECT_NAME_YAML_SINGLE}}' owner '{{OWNER_NAME_YAML_SINGLE}}'",
      'double "{{PROJECT_NAME_YAML_DOUBLE}}"',
      '{{PROJECT_NAME}} {{TASK_PREFIX}}-1 {{OWNER_NAME}} {{PROJECT_PHASE}} {{REPOSITORY_DISPLAY}}',
    ].join('\r\n'),
  );
  const text = loadWorkflowSkill('demo', { skillsDir: dir, metadata: plugin });
  assert.equal(
    text,
    [
      '# Demo',
      '',
      "single 'Owner''s \"Big\" App' owner 'Ann O''Neil'",
      'double "Owner\'s \\"Big\\" App"',
      'Owner\'s "Big" App BIG-1 Ann O\'Neil Delivery Not configured.',
    ].join('\n'),
  );
  // The import script's defaults, and a configured repository shown as given.
  const defaults = Object.fromEntries(templateTokens({ projectName: 'P', taskPrefix: 'PX' }));
  assert.equal(defaults['{{OWNER_NAME}}'], 'Project owner');
  assert.equal(defaults['{{PROJECT_PHASE}}'], 'Discovery');
  assert.equal(defaults['{{REPOSITORY_DISPLAY}}'], 'Not configured.');
  const repo = Object.fromEntries(templateTokens({ ...plugin, repositoryUrl: 'https://example.com/r' }));
  assert.equal(repo['{{REPOSITORY_DISPLAY}}'], 'https://example.com/r');
  assert.throws(() => templateTokens({ projectName: 'P' }), /taskPrefix/);
  await fs.writeFile(path.join(dir, 'demo', 'SKILL.md'), 'Uses {{UNKNOWN_TOKEN}}');
  assert.throws(() => loadWorkflowSkill('demo', { skillsDir: dir, metadata: plugin }), /Unresolved template token/);
  assert.throws(() => loadWorkflowSkill('missing', { skillsDir: dir, metadata: plugin }), /missing from/);
  assert.throws(() => loadWorkflowSkill('../demo', { skillsDir: dir, metadata: plugin }), /Invalid/);
});

test('every shipped skill renders, and referenced files are appended under their path', () => {
  for (const name of new Set([...Object.values(STAGE_SKILLS).flat(), 'review-task']))
    assert.doesNotMatch(loadWorkflowSkill(name, { skillsDir: SKILLS, metadata: plugin }), /\{\{|^---/);
  const intake = loadWorkflowSkill('intake', { skillsDir: SKILLS, metadata: plugin });
  assert.match(intake, /^# Intake/);
  assert.match(intake, /scope contract Ann O'Neil can freeze/);
  assert.match(intake, /\n## intake\/references\/discovery\.md\n\n# Linked discovery questions\n/);
  // A path outside the skill folder (backlog/docs) is left to the agent to read in the project.
  const deliver = loadWorkflowSkill('deliver-task', { skillsDir: SKILLS, metadata: plugin });
  assert.doesNotMatch(deliver, /^## .*doc-0/m);
  assert.match(deliver, /task: BIG-14/);
});

test('the skills folder is the plugin service copy in plugin mode and the project otherwise', async t => {
  const root = await project(t, plugin);
  assert.equal(
    SERVICE_ROOT,
    path.dirname(fileURLToPath(new URL('../template/.switchflow/scripts/control/', import.meta.url))),
  );
  assert.equal(defaultWorkflowSkillsDir(root, plugin), path.join(SERVICE_ROOT, 'workflow-skills'));
  assert.equal(defaultWorkflowSkillsDir(root, plugin, { serviceRoot: 'S' }), path.join('S', 'workflow-skills'));
  assert.equal(defaultWorkflowSkillsDir(root, { install: 'template' }), path.join(root, '.agents', 'skills'));
  assert.equal(defaultWorkflowSkillsDir(root, {}), path.join(root, '.agents', 'skills'));
  assert.deepEqual(readProjectMetadata(root), plugin);
  assert.deepEqual(readProjectMetadata(path.join(root, 'none')), {});
  assert.equal(promptWorkflowSkills(path.join(root, 'none'), ['intake']), null);
  // A plugin project whose service copy lacks the skills fails loudly instead of improvising.
  assert.throws(
    () => promptWorkflowSkills(root, ['intake'], { skillsDir: path.join(root, 'empty') }),
    /intake workflow skill is missing/,
  );
});

test('stage prompts carry their skills in plugin mode and keep the template text otherwise', async t => {
  const template = await project(t, { ...plugin, install: undefined });
  const pluginRoot = await project(t, plugin);
  for (const stage of Object.keys(STAGE_SKILLS)) {
    const [first] = STAGE_SKILLS[stage];
    const before = buildAgentPrompt({ stage, state: { governanceRoot: template }, input: 'go', skillsDir: SKILLS });
    assert.match(before, new RegExp(`invoke the imported \\.agents/skills/${first}/SKILL\\.md for this stage`));
    assert.doesNotMatch(before, /WORKFLOW SKILL/);
    // A template project's prompt does not depend on where skills would be read from.
    assert.equal(before, buildAgentPrompt({ stage, state: { governanceRoot: template }, input: 'go' }));
    const after = buildAgentPrompt({ stage, state: { governanceRoot: pluginRoot }, input: 'go', skillsDir: SKILLS });
    assert.doesNotMatch(after, /\.agents\/skills/);
    assert.match(after, new RegExp(`follow the ${first} workflow skill for this stage`));
    for (const name of STAGE_SKILLS[stage]) {
      assert.equal(count(after, `===== BEGIN WORKFLOW SKILL ${name} =====`), 1);
      assert.equal(count(after, `===== END WORKFLOW SKILL ${name} =====`), 1);
    }
    for (const name of ['review-task', 'edit-phase', 'review-framework'])
      assert.doesNotMatch(after, new RegExp(`BEGIN WORKFLOW SKILL ${name} `));
    // The skills sit before the control state, which stays the last data in the prompt.
    assert.ok(after.indexOf('WORKFLOW SKILLS:\n') < after.indexOf('CONTROL STATE (JSON data):'));
    assert.ok(after.endsWith(`CURRENT USER INPUT (JSON data):\n"go"\n`));
    // Sizes stay bounded: only this stage's skills, well under the inline prompt budgets.
    assert.ok(after.length - before.length < 30000, `${stage} adds ${after.length - before.length}`);
  }
  const intake = buildAgentPrompt({ stage: 'intake', state: { governanceRoot: pluginRoot }, skillsDir: SKILLS });
  assert.match(intake, /## intake\/references\/discovery\.md/);
});

test('worker prompts carry their skill once in plugin mode on every route', async t => {
  const template = await project(t);
  const pluginRoot = await project(t, plugin);
  const routes = {
    local: {},
    ssh: { remote: { label: 'box', path: '/home/u/wt' } },
    cloud: { cloud: true },
  };
  for (const kind of ['deliver', 'review'])
    for (const [route, options] of Object.entries(routes)) {
      const name = kind === 'deliver' ? 'deliver-task' : 'review-task';
      const before = workerPrompt(worker(template, { kind, ...options }));
      const after = workerPrompt(worker(pluginRoot, { kind, ...options }));
      const label = `${kind} ${route}`;
      assert.doesNotMatch(before, /WORKFLOW SKILL/, label);
      if (route !== 'ssh') assert.match(before, new RegExp(`Follow \\.agents/skills/${name}/SKILL\\.md`), label);
      assert.doesNotMatch(after, /\.agents\/skills/, label);
      assert.match(after, new RegExp(`Follow the ${name} workflow skill below`), label);
      assert.equal(count(after, `===== BEGIN WORKFLOW SKILL ${name} =====`), 1, label);
      assert.equal(count(after, '===== BEGIN WORKFLOW SKILL'), 1, label);
      // The orchestrator's instructions and the reply contract still close the prompt.
      assert.ok(after.indexOf('===== END WORKFLOW SKILL') < after.indexOf('Orchestrator instructions follow'), label);
      assert.equal(before.split('\n').at(-1), after.split('\n').at(-1), label);
      // Cloud routes wrap the prompt unchanged: task.md for Claude cloud, argv for Codex cloud.
      if (route === 'cloud') {
        const args = { key: 'sf-big-3', task: 'BIG-3', prompt: after, writable: kind === 'deliver' };
        assert.ok(taskDocument(args).includes(after), label);
        assert.ok(taskPrompt(args).endsWith(after), label);
        assert.ok(taskPrompt(args).length < MAX_PROMPT, `${label}: ${taskPrompt(args).length}`);
      }
    }
});

test('template worker prompts are unchanged text', async t => {
  const template = await project(t);
  assert.equal(
    workerPrompt(worker(template, { kind: 'review' })),
    [
      'You are a Switchflow review worker for task BIG-3, dispatched by the phase orchestrator through the Switchflow host.',
      `Work only in ${path.join(template, 'wt')}. The primary Backlog is at ${template}; use .switchflow/scripts/backlog.ps1 for task records.`,
      'Follow .agents/skills/review-task/SKILL.md. You are read-only: do not edit files or task records.',
      'Put the full verdict comment in comment, first line exactly "Verdict: accept" or "Verdict: block"; the orchestrator records it.',
      'Orchestrator instructions follow. They are scoped to this task and do not widen your authority:',
      'Deliver BIG-3. finish now',
      'Fill fields that do not apply with "" or []. Return only the requested JSON.',
    ].join('\n'),
  );
});
