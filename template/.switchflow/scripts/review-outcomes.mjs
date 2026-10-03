// Read-only review outcome report. Counts the structured verdict line that
// review-task writes as the first line of its findings comment.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERDICT = /^verdict:[\t ]*(accept|block)[\t ]*$/i;

function frontmatterOf(source) {
  return /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1] ?? null;
}

function scalar(frontmatter, field) {
  const match = new RegExp(`^${field}:[\\t ]*(.*?)[\\t ]*$`, 'm').exec(frontmatter);
  if (!match) return null;
  const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  return value === '' ? null : value;
}

// Backlog.md writes non-empty lists as block sequences; older records may use the inline form.
function list(frontmatter, field) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^${field}:`).test(line));
  if (start < 0) return [];
  const inline = /^[^:]+:[\t ]*\[(.*)\][\t ]*$/.exec(lines[start]);
  if (inline)
    return inline[1]
      .split(',')
      .map(item => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter(Boolean);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^[\t ]*-[\t ]+(.*?)[\t ]*$/.exec(line);
    if (!item) break;
    items.push(item[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return items;
}

// The pinned fork writes each comment as metadata lines, a '---' line, the body, and a closing '---' line.
export function parseComments(source) {
  const section = /<!-- COMMENTS:BEGIN -->\r?\n([\s\S]*?)<!-- COMMENTS:END -->/.exec(source)?.[1];
  if (section === undefined) return [];
  const lines = section.split(/\r?\n/);
  const comments = [];
  let index = 0;
  while (index < lines.length) {
    const metadata = [];
    while (index < lines.length && lines[index].trim() !== '---') metadata.push(lines[index++]);
    if (index++ >= lines.length) break;
    const body = [];
    while (index < lines.length && lines[index].trim() !== '---') body.push(lines[index++]);
    if (index++ >= lines.length) break;
    const field = name => metadata.map(line => new RegExp(`^${name}:\\s*(.*)$`).exec(line)?.[1]).find(Boolean) ?? null;
    comments.push({ author: field('author'), created: field('created'), body: body.join('\n').trim() });
  }
  return comments;
}

export function verdictOf(body) {
  const firstLine = body.split('\n').find(line => line.trim() !== '') ?? '';
  return VERDICT.exec(firstLine.trim())?.[1].toLowerCase() ?? null;
}

export function parseTaskRecord(source) {
  const frontmatter = frontmatterOf(source);
  if (frontmatter === null) return null;
  const id = scalar(frontmatter, 'id');
  if (id === null) return null;
  return {
    id,
    title: scalar(frontmatter, 'title') ?? id,
    status: scalar(frontmatter, 'status'),
    type: scalar(frontmatter, 'type'),
    parentTaskId: scalar(frontmatter, 'parent_task_id'),
    labels: list(frontmatter, 'labels'),
    verdicts: parseComments(source)
      .map(comment => ({ verdict: verdictOf(comment.body), created: comment.created }))
      .filter(entry => entry.verdict !== null),
  };
}

const share = (part, whole) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

export function summarizeReviews(tasks, { since = null } = {}) {
  const parentIds = new Set(tasks.map(task => task.parentTaskId).filter(Boolean));
  const workers = tasks.filter(
    task => !parentIds.has(task.id) && !task.labels.includes('coordination') && !task.labels.includes('discovery'),
  );
  const reviewed = workers.filter(task => task.verdicts.length > 0 && (!since || task.verdicts[0].created >= since));
  const firstAccepted = reviewed.filter(task => task.verdicts[0].verdict === 'accept');
  const byType = {};
  for (const task of reviewed) {
    const entry = (byType[task.type ?? 'unset'] ??= { reviewed: 0, firstPassAccepted: 0 });
    entry.reviewed += 1;
    if (task.verdicts[0].verdict === 'accept') entry.firstPassAccepted += 1;
  }
  const rounds = reviewed.map(task => task.verdicts.length);
  const unstructured = workers.filter(task => ['Review', 'Done'].includes(task.status) && task.verdicts.length === 0);
  return {
    since,
    reviewedTasks: reviewed.length,
    firstPass: {
      accepted: firstAccepted.length,
      blocked: reviewed.length - firstAccepted.length,
      acceptedPercent: share(firstAccepted.length, reviewed.length),
    },
    reviewRounds: {
      mean: rounds.length ? Math.round((rounds.reduce((a, b) => a + b, 0) / rounds.length) * 100) / 100 : null,
      max: rounds.length ? Math.max(...rounds) : null,
    },
    byType,
    blockedFirst: reviewed
      .filter(task => task.verdicts[0].verdict === 'block')
      .map(task => ({ id: task.id, title: task.title, rounds: task.verdicts.length, status: task.status })),
    unstructured: { count: unstructured.length, ids: unstructured.map(task => task.id) },
  };
}

export function renderReviews(summary) {
  const pct = value => (value === null ? 'n/a' : `${value}%`);
  const lines = [`Review outcomes${summary.since ? ` (first verdict on or after ${summary.since})` : ''}`];
  lines.push(`Reviewed tasks: ${summary.reviewedTasks}`);
  lines.push(
    `Accepted on first review: ${summary.firstPass.accepted} (${pct(summary.firstPass.acceptedPercent)}); blocked first: ${summary.firstPass.blocked}`,
  );
  lines.push(`Review rounds: mean ${summary.reviewRounds.mean ?? 'n/a'}, max ${summary.reviewRounds.max ?? 'n/a'}`);
  lines.push('\nBy task type (reviewed / accepted first)');
  for (const [type, entry] of Object.entries(summary.byType).sort())
    lines.push(`- ${type}: ${entry.reviewed} / ${entry.firstPassAccepted}`);
  lines.push('\nBlocked on first review');
  for (const task of summary.blockedFirst)
    lines.push(`- ${task.title} [${task.id}] — ${task.rounds} round(s), now ${task.status}`);
  lines.push(
    `\nReview or Done tasks without a structured verdict line: ${summary.unstructured.count} (not counted above; not inferred)`,
  );
  return lines.join('\n');
}

export function readTaskRecords(root) {
  const records = [];
  for (const folder of ['tasks', 'completed']) {
    const directory = path.join(root, 'backlog', folder);
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.filter(name => name.endsWith('.md'))) {
      const record = parseTaskRecord(readFileSync(path.join(directory, name), 'utf8'));
      if (record) records.push(record);
    }
  }
  return records;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...args] = process.argv.slice(2);
  const json = args.includes('--json');
  const sinceIndex = args.indexOf('--since');
  const since = sinceIndex >= 0 ? args[sinceIndex + 1] : null;
  const known = args.every((arg, i) => arg === '--json' || arg === '--since' || (i > 0 && args[i - 1] === '--since'));
  if (!root || !known || (sinceIndex >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(since ?? ''))) {
    console.error('Usage: backlog.ps1 reviews [--since YYYY-MM-DD] [--json]');
    process.exitCode = 1;
  } else {
    const summary = summarizeReviews(readTaskRecords(root), { since });
    console.log(json ? JSON.stringify(summary, null, 2) : renderReviews(summary));
  }
}
