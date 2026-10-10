import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workflow skills reach agents two ways. A template install keeps them in the project's
// .agents/skills and prompts point there. A plugin install keeps no copy in the project, so the
// needed skill text travels inside the prompt, which also reaches SSH and cloud workers.

/** The folder above control/: the template's .switchflow/scripts, or the plugin's runtime copy. */
export const SERVICE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Skills each stage agent and worker kind follows. The first is the one it is invoked with. */
export const STAGE_SKILLS = Object.freeze({
  intake: ['intake'],
  planning: ['plan-milestone', 'create-human-task'],
  execution: ['orchestrate-project', 'orchestrate-phase', 'deliver-task'],
  uat: ['guided-uat', 'orchestrate-project'],
});
export const WORKER_SKILLS = Object.freeze({ deliver: ['deliver-task'], review: ['review-task'] });

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_BYTES = 256 * 1024;

export function isPluginInstall(metadata) {
  return metadata?.install === 'plugin';
}

/** The project's .switchflow/project.json, or {} when there is none to read. */
export function readProjectMetadata(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) return {};
  let text;
  try {
    text = fs.readFileSync(path.join(projectRoot, '.switchflow', 'project.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {};
    throw error;
  }
  const metadata = JSON.parse(text.replace(/^﻿/, ''));
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

export function defaultWorkflowSkillsDir(projectRoot, metadata, { serviceRoot = SERVICE_ROOT } = {}) {
  return isPluginInstall(metadata)
    ? path.join(serviceRoot, 'workflow-skills')
    : path.join(projectRoot, '.agents', 'skills');
}

/**
 * The same tokens, values and order as scripts/import-switchflow.ps1, so a skill reads the same
 * whether it was rendered into a project or into a prompt.
 */
export function templateTokens(metadata = {}) {
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value : fallback);
  const projectName = text(metadata.projectName, '');
  const ownerName = text(metadata.ownerName, 'Project owner');
  const repositoryUrl = typeof metadata.repositoryUrl === 'string' ? metadata.repositoryUrl : '';
  if (!projectName) throw new Error('The project metadata has no projectName.');
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(metadata.taskPrefix ?? ''))
    throw new Error('The project metadata has no valid taskPrefix.');
  return [
    ['{{PROJECT_NAME_YAML_SINGLE}}', projectName.replaceAll("'", "''")],
    ['{{OWNER_NAME_YAML_SINGLE}}', ownerName.replaceAll("'", "''")],
    ['{{PROJECT_NAME_YAML_DOUBLE}}', JSON.stringify(projectName).slice(1, -1)],
    ['{{PROJECT_NAME}}', projectName],
    ['{{TASK_PREFIX}}', metadata.taskPrefix],
    ['{{OWNER_NAME}}', ownerName],
    ['{{PROJECT_PHASE}}', text(metadata.projectPhase, 'Discovery')],
    ['{{REPOSITORY_DISPLAY}}', repositoryUrl.trim() ? repositoryUrl : 'Not configured.'],
  ];
}

export function renderTemplate(content, metadata, label = 'workflow skill') {
  let rendered = content;
  for (const [token, value] of templateTokens(metadata)) rendered = rendered.replaceAll(token, value);
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) throw new Error(`Unresolved template token in ${label}`);
  return rendered;
}

function readText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error(`Not a readable skill file: ${file}`);
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * One skill as prompt text: SKILL.md without its frontmatter and with project values filled in,
 * followed by each file inside the skill folder that it refers to (such as references/discovery.md),
 * headed by its path relative to the skills folder.
 */
export function loadWorkflowSkill(name, { skillsDir, metadata = {} } = {}) {
  if (!SKILL_NAME.test(name ?? '')) throw new Error('Invalid workflow skill name');
  if (typeof skillsDir !== 'string' || !skillsDir) throw new Error('A workflow skills folder is required');
  const skillRoot = path.join(skillsDir, name);
  let body;
  try {
    body = readText(path.join(skillRoot, 'SKILL.md'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`The ${name} workflow skill is missing from ${skillsDir}.`);
    throw error;
  }
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').replace(/\r\n/g, '\n');
  const sections = [renderTemplate(body, metadata, `${name}/SKILL.md`).trim()];
  const seen = new Set();
  for (const [, reference] of body.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.md)`/g)) {
    const file = path.resolve(skillRoot, reference);
    if (seen.has(file) || !inside(skillRoot, file) || path.basename(file) === 'SKILL.md') continue;
    if (!fs.existsSync(file)) continue;
    seen.add(file);
    const heading = path.relative(skillsDir, file).split(path.sep).join('/');
    const text = renderTemplate(readText(file).replace(/\r\n/g, '\n'), metadata, heading).trim();
    sections.push(`## ${heading}\n\n${text}`);
  }
  return sections.join('\n\n');
}

/** Plainly delimited blocks, one per skill. */
export function workflowSkillBlocks(names, options) {
  return names
    .map(name =>
      [
        `===== BEGIN WORKFLOW SKILL ${name} =====`,
        loadWorkflowSkill(name, options),
        `===== END WORKFLOW SKILL ${name} =====`,
      ].join('\n'),
    )
    .join('\n');
}

/**
 * The skill text a prompt carries for this project, or null for a template install, whose
 * prompts keep pointing at .agents/skills.
 */
export function promptWorkflowSkills(projectRoot, names, { skillsDir, metadata } = {}) {
  metadata ??= readProjectMetadata(projectRoot);
  if (!isPluginInstall(metadata)) return null;
  return workflowSkillBlocks(names, {
    skillsDir: skillsDir ?? defaultWorkflowSkillsDir(projectRoot, metadata),
    metadata,
  });
}
