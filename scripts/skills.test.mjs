import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSkills, readSkill, skillNames } from '../template/.switchflow/scripts/control/skills.mjs';

test('skill catalogue reads the shipped roles and reference notes without changing their source', async () => {
  const context = { governanceRoot: path.resolve('template') };
  const result = await listSkills(context);
  assert.equal(result.skills.length, 11); assert.deepEqual(result.warnings, []);
  const intake = result.skills.find(skill => skill.name === 'intake');
  assert.match(intake.description, /Start or resume/);
  assert.deepEqual(intake.references, [{id:'intake/references/discovery.md',title:'discovery.md'}]);
  for (const name of skillNames) {
    const doc = await readSkill(context, `${name}/SKILL.md`);
    assert.equal(doc.raw, await fs.readFile(path.join(context.governanceRoot, doc.path), 'utf8'));
    assert.doesNotMatch(doc.markdown, /^---/);
  }
  assert.match((await readSkill(context, intake.references[0].id)).markdown, /discovery/i);
});

test('skill reader rejects traversal, unrelated skills, non-text, oversized and linked paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-skills-'));
  const context = { governanceRoot: root }, folder = path.join(root, '.agents/skills/intake');
  try {
    await fs.mkdir(folder, { recursive: true });
    for (const id of ['../secret.md','intake/../SKILL.md','intake\\SKILL.md','other/SKILL.md','intake/agents/openai.yaml','intake/references/../../secret.md','intake/references/a:b.md']) await assert.rejects(readSkill(context,id), error => error.status === 400);
    const file = path.join(folder, 'SKILL.md');
    await fs.writeFile(file, Buffer.from([255])); await assert.rejects(readSkill(context,'intake/SKILL.md'), error => error.status === 422);
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1)); await assert.rejects(readSkill(context,'intake/SKILL.md'), error => error.status === 413);
    const external = path.join(root, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external,'note.md'), 'private');
    await fs.symlink(external,path.join(folder,'references'),process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readSkill(context,'intake/references/note.md'), error => error.status === 403);
    await fs.writeFile(file, '---\nname: intake\ndescription: "Installed description"\n---\n# Installed intake');
    const result = await listSkills(context); assert.equal(result.skills.length,1); assert.match(result.warnings.join(' '),/Linked skill/);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
