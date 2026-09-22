import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlError } from './lifecycle.mjs';

// Only Switchflow's shipped roles belong in this inspector, not unrelated skills.
export const skillNames = ['intake', 'plan-milestone', 'orchestrate-project', 'orchestrate-phase', 'deliver-task', 'review-task', 'guided-uat', 'edit-milestone', 'edit-phase', 'create-human-task', 'review-framework'];
const MAX_FILE = 1024 * 1024;
async function safePath(context, parts) {
  const root = await fs.realpath(context.governanceRoot);
  let current = root;
  for (const part of ['.agents', 'skills', ...parts]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new ControlError('Linked skill paths are not supported.', 403);
    const relative = path.relative(root, await fs.realpath(current));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new ControlError('Skill is outside this project.', 403);
  }
  return current;
}
export async function readSkill(context, id) {
  const parts = typeof id === 'string' ? id.split('/') : [];
  if (!skillNames.includes(parts[0]) || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || ['.', '..'].includes(part)) ||
      !(parts.length === 2 && parts[1] === 'SKILL.md' || parts.length >= 3 && parts[1] === 'references' && /\.md$/i.test(parts.at(-1)))) throw new ControlError('Invalid skill path.');
  try {
    const file = await safePath(context, parts), stat = await fs.stat(file);
    if (!stat.isFile()) throw new ControlError('Skill file not found.', 404);
    if (stat.size > MAX_FILE) throw new ControlError('Skill exceeds the 1 MiB reader limit.', 413);
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_FILE) throw new ControlError('Skill exceeds the 1 MiB reader limit.', 413);
    let raw;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ControlError('Skill must be UTF-8 text.', 422); }
    if (raw.includes('\0')) throw new ControlError('Skill must be text.', 422);
    const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const markdown = front ? raw.slice(front[0].length) : raw;
    const description = front?.[1].match(/^description:[ \t]*(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/''/g, "'") || '';
    return { id, name: parts[0], title: markdown.match(/^#\s+(.+)$/m)?.[1] || parts[0], description, path: `.agents/skills/${id}`, markdown, raw };
  } catch (error) { if (error.code === 'ENOENT') throw new ControlError('Skill file not found.', 404); throw error; }
}
export async function listSkills(context) {
  const skills = [], warnings = [];
  for (const name of skillNames) {
    try {
      const { raw, markdown, ...skill } = await readSkill(context, `${name}/SKILL.md`);
      const references = [];
      let visited = 0;
      async function walk(parts, depth = 0) {
        if (depth > 5) throw new Error('Reference folders deeper than five levels are omitted.');
        let folder;
        try { folder = await safePath(context, parts); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          if (++visited > 100) throw new Error('Reference index limit reached.');
          const child = [...parts, entry.name];
          if (entry.isSymbolicLink()) { warnings.push(`${child.join('/')}: linked reference omitted.`); continue; }
          if (entry.isDirectory()) await walk(child, depth + 1);
          else if (entry.isFile() && /\.md$/i.test(entry.name)) references.push({ id: child.join('/'), title: child.slice(2).join('/') });
        }
      }
      try { await walk([name, 'references']); } catch (error) { warnings.push(`${name}: ${error.message}`); }
      skills.push({ ...skill, references: references.sort((a,b) => a.id.localeCompare(b.id)) });
    } catch (error) { warnings.push(`${name}: ${error.message}`); }
  }
  return { skills, warnings };
}
