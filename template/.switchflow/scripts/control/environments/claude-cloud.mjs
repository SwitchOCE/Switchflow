import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { claudeExecutable } from '../providers/claude-cli.mjs';
import { oneLine, readLines, stopTree } from '../providers/process.mjs';

/**
 * Claude Code cloud (claude.ai/code) as a Switchflow environment. Verified on 2026-10-04 with
 * Claude Code 2.1.288 (see docs/browser-control.md "Claude cloud workers"):
 *
 * - `claude -p --cloud "<task>"` is refused ("interactive only"), so sessions start as one-off
 *   routines. A local headless `claude -p --tools RemoteTrigger` turn calls the routines API
 *   with the CLI's own sign-in; Switchflow never sees an OAuth token. The tool result carries the
 *   raw API JSON in the stream; the relaying model's call is checked against the request.
 * - `claude -p "<message>" --cloud <session_id>` delivers a message into a running or finished
 *   routine session in about two seconds; the session answers it as its next turn. That is the
 *   follow-up and steering channel.
 * - `get_run_log` returns a condensed text log (tool calls, messages, result), read by polling.
 * - A routine's allowed_tools does not restrict the session (a probe wrote and pushed), so the
 *   read-only approach turn is enforced by instruction plus a host check that nothing was pushed.
 * - There is no interrupt and no routine delete: cancel tells the worker to stop. So that routines do
 *   not pile up, each environment reuses one routine: `update` replaces its job (verified: the
 *   stored session request follows it) and `run` starts a new session from it. Running sessions
 *   keep the job they started with.
 */

export const KIND = 'claude-cloud';
export const ENVIRONMENT_ID = /^env_[A-Za-z0-9]{8,64}$/;
export const SESSION_ID = /^(?:cse|session)_[A-Za-z0-9]{6,80}$/;
export const TRIGGER_ID = /^trig_[A-Za-z0-9]{6,80}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const KEY = /^[a-z0-9][a-z0-9-]{2,62}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_MESSAGE = 100000;
const MAX_PAGES = 20;

export const CAPABILITIES = Object.freeze({
  stream: false, // the run log is polled (pollSeconds, default 60)
  steer: 'message', // delivered in seconds; the session takes it at its next turn boundary
  interrupt: false, // no supported call stops a cloud turn
  followUp: 'same-session', // a confirmed approach or correction continues the same session
  result: 'remote-branch', // claude/sf-<key>, fetched into the local candidate by collect()
});

/** Listed for the approach turn. Not enforced by the service; the host checks for pushes. */
export const READ_ONLY_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Bash(git fetch:*)', 'Bash(git show:*)']);
export const WRITE_TOOLS = Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']);

const fail = message => {
  throw Object.assign(new Error(message), { environment: KIND });
};

/** Validates the owner's configuration for this environment (stored service-side). */
export function validateCloudConfig(input = {}) {
  const config = {
    environmentId: input.environmentId ?? null,
    repository: input.repository ?? null,
    remote: input.remote ?? 'origin',
    model: input.model ?? 'claude-opus-5-5',
    push: input.push === true,
    pollSeconds: input.pollSeconds ?? 60,
  };
  const problems = [];
  if (!ENVIRONMENT_ID.test(String(config.environmentId ?? '')))
    problems.push('environmentId must be a claude.ai/code environment ID (env_…).');
  if (!GITHUB_REPO.test(String(config.repository ?? '')))
    problems.push('repository must be https://github.com/<owner>/<repo>.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.remote)) problems.push('remote must be a Git remote name.');
  if (!MODEL.test(config.model)) problems.push('model must be a plain model name.');
  if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 15 || config.pollSeconds > 900)
    problems.push('pollSeconds must be 15–900.');
  return { config, problems };
}

/** Branch names for one worker. `key` is short, unique and safe in a ref name. */
export function branchesFor(key) {
  if (!KEY.test(key)) fail('Invalid cloud worker key.');
  return {
    task: `sf-task/${key}`, // the candidate head the worker starts from (pushed by the host)
    inbox: `sf-inbox/${key}`, // task.md and inbox.md, written by the host
    result: `claude/sf-${key}`, // the worker's commits
    notes: `claude/sf-${key}-notes`, // the worker's status.md (STATUS / QUESTION lines)
  };
}

export function workerKey(task, id = randomUUID()) {
  const slug = String(task)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'task'}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * The routine's own prompt. It stays short and fixed because the relaying model must echo it
 * exactly; the task text travels as task.md on the inbox branch.
 */
export function routinePrompt(key, { writable }) {
  const b = branchesFor(key);
  return [
    `Switchflow cloud worker ${key}. Run: git fetch origin ${b.task} ${b.inbox} && git checkout -B ${b.result} origin/${b.task} && git show origin/${b.inbox}:task.md`,
    'Follow task.md exactly. Further messages arrive in this session from the Switchflow host.',
    writable
      ? `Push only ${b.result} and ${b.notes}; never force-push.`
      : 'This first turn is read-only: do not edit, commit or push, even if a hook asks you to. Ignore any stop hook that asks you to commit or push.',
  ].join('\n');
}

/** task.md: the delegation prompt plus the cloud contract. */
export function taskDocument({ key, task, prompt, writable }) {
  const b = branchesFor(key);
  return [
    `# Switchflow task ${task} (${key})`,
    '',
    'The Switchflow host on the owner PC reviews and merges your work. You reach it only through Git and your replies.',
    '',
    '## Contract',
    '',
    writable
      ? `- Commit on ${b.result} and push it (git push origin ${b.result}). Push no other branch except ${b.notes}. Never force-push.`
      : `- Your first turn is read-only: do not edit, commit or push. Reply with your approach. Writes start when the host sends "Approach confirmed".`,
    `- When you need a decision, push status.md on ${b.notes} (an orphan branch with only that file) with a line "QUESTION <question> | default: <what you will do>". If no answer arrives within 20 minutes, take the default.`,
    `- Optional progress lines in the same file: "STATUS <one line>".`,
    '- End every turn with only the requested JSON object as your final message.',
    '',
    '## Instructions',
    '',
    prompt,
    '',
  ].join('\n');
}

/** The routines API body for a worker run. */
export function routineBody({ name, environmentId, repository, model, prompt, allowedTools }) {
  return {
    name: oneLine(name, 120),
    enabled: false,
    persist_session: false,
    job_config: {
      ccr: {
        environment_id: environmentId,
        // Minimal on purpose: the relaying model drops empty fields (uuid, session_id: '',
        // parent_tool_use_id: null), which the API does not need.
        events: [{ data: { message: { role: 'user', content: prompt }, type: 'user' } }],
        session_context: {
          allowed_tools: [...allowedTools],
          model,
          sources: [{ git_repository: { url: repository } }],
        },
      },
    },
  };
}

/** Runs a process and collects bounded output. */
export function runProcess(command, args, { cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Path of the first difference between two JSON values, for a refusal message. */
export function firstDifference(expected, actual, at = '$') {
  if (isDeepStrictEqual(expected, actual)) return null;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object')
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const found = firstDifference(expected[key], actual[key], `${at}.${key}`);
      if (found) return found;
    }
  return at;
}

/**
 * Calls the routines API through a local headless Claude Code turn with only the RemoteTrigger
 * tool. The CLI signs the request; the host reads the tool result's raw JSON from the stream and
 * ignores a result whose call differs from the request.
 */
export function createDispatcher({
  executable = claudeExecutable(),
  cwd = process.cwd(),
  model = 'haiku',
  timeoutMs = 120000,
  spawnImpl = spawn,
} = {}) {
  return async function dispatch(input) {
    if (!executable) fail('Claude Code is not installed, so the cloud routines API is unreachable.');
    const prompt = `Call the RemoteTrigger tool exactly once with exactly this input, unchanged: ${JSON.stringify(input)}\nThen reply with only the word DONE. Do nothing else.`;
    const args = ['-p', '--model', model, '--tools', 'RemoteTrigger', '--allowedTools', 'RemoteTrigger'];
    args.push('--strict-mcp-config', '--output-format', 'stream-json', '--verbose');
    const child = spawnImpl(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    child.stdin.end(prompt);
    const closed = new Promise(resolve => child.once('close', resolve));
    const timer = setTimeout(() => stopTree(child), timeoutMs);
    let stderr = '';
    child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-4000)));
    const calls = new Map();
    let outcome = null;
    try {
      await readLines(child.stdout, line => {
        let message;
        try {
          message = JSON.parse(line.replace(/^﻿/, ''));
        } catch {
          return;
        }
        if (message.type === 'assistant')
          for (const part of message.message?.content ?? [])
            if (part.type === 'tool_use' && part.name === 'RemoteTrigger') calls.set(part.id, part.input);
        if (message.type === 'user' && message.tool_use_result && typeof message.tool_use_result === 'object') {
          const use = (message.message?.content ?? []).find(part => part.type === 'tool_result');
          outcome = { input: calls.get(use?.tool_use_id), ...message.tool_use_result };
        }
      });
      const code = await closed;
      if (calls.size !== 1) fail(`The routines dispatcher made ${calls.size} calls instead of one.`);
      if (!outcome) fail(`The routines dispatcher returned no result (exit ${code}): ${oneLine(stderr, 300)}`);
      if (!isDeepStrictEqual(outcome.input, input))
        fail(
          `The routines dispatcher changed the ${input.action} request at ${firstDifference(input, outcome.input)}; its result is ignored.${input.action === 'create' ? ' A routine may have been created; check claude.ai/code/routines.' : ''}`,
        );
      let body = null;
      try {
        body = outcome.json ? JSON.parse(outcome.json) : {};
      } catch {
        body = {};
      }
      if (!(outcome.status >= 200 && outcome.status < 300))
        fail(`Routines API ${input.action} failed (HTTP ${outcome.status}): ${oneLine(outcome.json ?? '', 300)}`);
      // get_run_log condenses the session's events into a text summary beside the JSON.
      if (typeof outcome.summary === 'string')
        Object.defineProperty(body, 'summary', { value: outcome.summary, enumerable: false });
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Sends a message into an existing cloud session through the CLI. Returns once it is delivered. */
export function createMessenger({ executable = claudeExecutable(), cwd = process.cwd(), run = runProcess } = {}) {
  return async function send(sessionId, text) {
    if (!SESSION_ID.test(String(sessionId))) fail('Invalid cloud session ID.');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE) fail('Invalid cloud message.');
    if (!executable) fail('Claude Code is not installed.');
    let stdout;
    try {
      ({ stdout } = await run(executable, ['-p', '--cloud', sessionId, '--output-format', 'json'], {
        cwd,
        input: text,
        timeoutMs: 60000,
      }));
    } catch (error) {
      stdout = error.stdout;
      if (!stdout) fail(`Could not message cloud session ${sessionId}: ${oneLine(error.stderr || error.message, 300)}`);
    }
    let reply = null;
    try {
      reply = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
    } catch {
      reply = null;
    }
    if (reply?.ok !== true)
      fail(`Cloud session ${sessionId} did not accept the message: ${oneLine(reply?.error ?? stdout, 300)}`);
    return { sessionId, url: reply.url ?? null };
  };
}

/** Git helpers. Host writes go through plumbing so no worktree or index is touched. */
export function createGit({ run = runProcess } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = async (cwd, args, options = {}) => (await run('git', args, { cwd, env, ...options })).stdout.trim();
  return {
    git,
    async lsRemote(cwd, remote, branch) {
      const out = await git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { timeoutMs: 30000 });
      return out ? out.split(/\s+/)[0] : null;
    },
    async push(cwd, remote, source, branch) {
      await git(cwd, ['push', remote, `${source}:refs/heads/${branch}`]);
    },
    async deleteRemote(cwd, remote, branch) {
      await git(cwd, ['push', remote, '--delete', branch]);
    },
    /** Fetches a remote branch into a private ref; null when it does not exist (yet). */
    async fetch(cwd, remote, branch, ref) {
      try {
        await git(cwd, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`]);
        return await git(cwd, ['rev-parse', ref]);
      } catch (error) {
        if (/couldn't find remote ref|not found/i.test(`${error.stderr}`)) return null;
        throw error;
      }
    },
    async show(cwd, ref, file) {
      try {
        return await git(cwd, ['show', `${ref}:${file}`]);
      } catch {
        return null;
      }
    },
    /** Commits files as one new root commit without a checkout; returns the commit. */
    async commitFiles(cwd, files, message) {
      const entries = [];
      for (const [name, content] of Object.entries(files)) {
        const blob = await git(cwd, ['hash-object', '-w', '--stdin'], { input: content });
        entries.push(`100644 blob ${blob}\t${name}\n`);
      }
      const tree = await git(cwd, ['mktree'], { input: entries.join('') });
      const identity = { GIT_AUTHOR_NAME: 'Switchflow', GIT_AUTHOR_EMAIL: 'switchflow@localhost' };
      Object.assign(identity, { GIT_COMMITTER_NAME: 'Switchflow', GIT_COMMITTER_EMAIL: 'switchflow@localhost' });
      return (
        await run('git', ['commit-tree', tree, '-m', message], { cwd, env: { ...env, ...identity } })
      ).stdout.trim();
    },
    async isAncestor(cwd, ancestor, descendant) {
      try {
        await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Pulls the last JSON object out of a worker's message. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const candidate of [...fenced.reverse(), text]) {
    const end = candidate.lastIndexOf('}');
    for (let start = candidate.lastIndexOf('{', end); start >= 0; start = candidate.lastIndexOf('{', start - 1)) {
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch {
        // widen to the previous brace
      }
    }
  }
  return null;
}

const LOG_LINE = /^\[([0-9T:.\-+Z]+)\] ([^:]+?): ?(.*)$/;
const RESULT_LINE = /^(\w+) is_error=(true|false)(?: turns=(\d+))?(?: duration=(\S+))?\s*(?:\S\s*)?(.*)$/;

/** Parses get_run_log's text summary into {at, kind, text} lines. */
export function parseRunLog(summary) {
  return String(summary ?? '')
    .split(/\r?\n/)
    .map(line => line.match(LOG_LINE))
    .filter(Boolean)
    .map(([, at, kind, text]) => ({ at, kind: kind.trim(), text }));
}

/** Maps one run-log line into Switchflow's session event vocabulary (or null). */
export function normalizeLogLine({ kind, text }) {
  if (kind === 'assistant')
    return text === '[thinking]' || !text.trim() ? null : { kind: 'message', text, final: false };
  if (kind.startsWith('tool_use ')) {
    const name = kind.slice('tool_use '.length);
    let input = null;
    try {
      input = JSON.parse(text);
    } catch {
      input = null;
    }
    if (name === 'Bash') return { kind: 'command', command: oneLine(input?.command ?? text, 2000), status: 'started' };
    return { kind: 'tool', name, summary: oneLine(input ?? text) };
  }
  if (kind === 'result') {
    const match = text.match(RESULT_LINE);
    const failed = !match || match[2] === 'true' || match[1] !== 'success';
    const body = match ? match[5] : text;
    if (failed) return { kind: 'turn.failed', turnId: null, error: oneLine(body || text, 2000) };
    return { kind: 'turn.completed', turnId: null, status: 'completed', result: body, usage: null };
  }
  if (/^env\[(error|warn)/.test(kind) || kind === 'system/notification')
    return { kind: 'notice', level: 'warning', text: oneLine(`${kind}: ${text}`, 500) };
  return null;
}

/** Status lines a worker pushed to its notes branch. */
export function parseStatus(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim().match(/^(STATUS|QUESTION)\b\s*:?\s*(.*)$/))
    .filter(Boolean)
    .map(([, type, rest]) => ({ type, text: rest }));
}

const sleep = (ms, signal) =>
  new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The environment adapter. `config` is the owner's stored configuration (validateCloudConfig);
 * `projectRoot` is a local checkout whose remote is the configured GitHub repository.
 */
export function createClaudeCloudEnvironment({
  config: input = {},
  projectRoot,
  dispatch = createDispatcher({ cwd: projectRoot }),
  send = createMessenger({ cwd: projectRoot }),
  git = createGit(),
  run = runProcess,
  executable = claudeExecutable(),
  stateDir = null,
} = {}) {
  const { config, problems } = validateCloudConfig(input);
  const remote = config.remote;
  const ref = (key, name) => `refs/switchflow/cloud/${key}/${name}`;

  // The environment's one reusable routine, recorded per cloud environment ID.
  const routineFile = stateDir && path.join(stateDir, 'environments', 'claude-cloud-routines.json');
  const readRoutines = async () => {
    if (!routineFile) return {};
    try {
      return JSON.parse(await readFile(routineFile, 'utf8'));
    } catch {
      return {};
    }
  };
  let routineId = null;
  async function recordRoutine(id) {
    routineId = id;
    if (!routineFile) return;
    const routines = { ...(await readRoutines()), [config.environmentId]: id };
    await mkdir(path.dirname(routineFile), { recursive: true });
    await writeFile(`${routineFile}.tmp`, `${JSON.stringify(routines, null, 2)}\n`);
    await rename(`${routineFile}.tmp`, routineFile);
  }
  // Updating the shared routine and running it must not interleave with another worker's start.
  let starting = Promise.resolve();
  function startRun(body) {
    const next = starting.then(async () => {
      routineId ??= (await readRoutines())[config.environmentId] ?? null;
      // A bare [] is ignored by the API; clear_mcp_connections removes the account's connectors.
      const job = { ...body, mcp_connections: [], clear_mcp_connections: true };
      let triggerId = null;
      if (TRIGGER_ID.test(String(routineId))) {
        // A routine the owner deleted (or any failed update) is replaced rather than retried.
        const updated = await dispatch({ action: 'update', trigger_id: routineId, body: job }).catch(() => null);
        if (updated) triggerId = routineId;
      }
      if (!triggerId) {
        const created = await dispatch({ action: 'create', body });
        triggerId = created?.id ?? created?.trigger?.id;
        if (!TRIGGER_ID.test(String(triggerId))) fail('The routines API did not return a routine ID.');
        await recordRoutine(triggerId);
        await dispatch({
          action: 'update',
          trigger_id: triggerId,
          body: { mcp_connections: [], clear_mcp_connections: true },
        });
      }
      const fired = await dispatch({ action: 'run', trigger_id: triggerId });
      const sessionId = fired?.session_id;
      if (!SESSION_ID.test(String(sessionId))) fail(`Routine ${triggerId} ran but returned no session ID.`);
      return { triggerId, sessionId };
    });
    starting = next.catch(() => {});
    return next;
  }

  const adapter = {
    id: KIND,
    kind: KIND,
    label: 'Claude cloud',
    capabilities: CAPABILITIES,
    remote: true, // memory admission does not apply; leases on shared remote resources still do
    config,

    async health({ branch = null } = {}) {
      const checks = [];
      const check = (name, ok, detail) => checks.push({ name, ok, detail });
      check('configured', problems.length === 0, problems.join(' ') || `environment ${config.environmentId}`);
      if (!executable) check('claude', false, 'Claude Code is not installed.');
      else {
        const status = await run(executable, ['auth', 'status'], { timeoutMs: 15000 }).catch(error => error);
        let loggedIn = false;
        try {
          loggedIn = JSON.parse(status.stdout).loggedIn === true;
        } catch {
          loggedIn = false;
        }
        check('claude', loggedIn, loggedIn ? 'signed in' : 'Claude Code is not signed in: run claude /login');
      }
      try {
        const url = await git.git(projectRoot, ['remote', 'get-url', remote]);
        const same = url.replace(/\.git$/, '').toLowerCase() === String(config.repository).toLowerCase();
        check(
          'remote',
          same,
          same ? `${remote} is ${config.repository}` : `${remote} is ${url}, not ${config.repository}`,
        );
        await git.git(projectRoot, ['ls-remote', '--heads', remote, 'refs/heads/sf-health-check'], {
          timeoutMs: 30000,
        });
        check('reachable', true, `${config.repository} answers`);
      } catch (error) {
        check('reachable', false, oneLine(error.stderr || error.message, 200));
      }
      if (branch) {
        const head = await git.lsRemote(projectRoot, remote, branch).catch(() => null);
        check(
          'branch',
          Boolean(head),
          head ? `${branch} is on ${remote} at ${head.slice(0, 12)}` : `${branch} is not on ${remote}`,
        );
      }
      check(
        'push',
        config.push,
        config.push
          ? 'pushes of sf-task/* and sf-inbox/* granted'
          : 'no push grant: cloud placement is refused until the owner grants it',
      );
      return { ok: checks.every(entry => entry.ok || entry.name === 'branch'), checks };
    },

    /** Pushes the start commit and the task, then starts the routine. Returns the worker handle. */
    async submit({ key, task, prompt, head, cwd = projectRoot, writable = false }) {
      if (problems.length) fail(`Claude cloud is not configured: ${problems.join(' ')}`);
      if (!config.push)
        fail(
          'Claude cloud needs the owner to grant Switchflow pushes of sf-task/* and sf-inbox/* to the configured repository.',
        );
      if (!/^[0-9a-f]{40}$/.test(String(head))) fail('submit needs the candidate head commit.');
      const b = branchesFor(key);
      const handle = { key, task, cwd, head, branches: b, runs: [], seen: 0, results: 0, statusSeen: 0, cursor: null };
      if ((await git.lsRemote(cwd, remote, b.task)) !== head) await git.push(cwd, remote, head, b.task);
      const inbox = await git.commitFiles(
        cwd,
        { 'task.md': taskDocument({ key, task, prompt, writable }) },
        `Switchflow task ${task}`,
      );
      await git.push(cwd, remote, inbox, b.inbox);
      const { triggerId, sessionId } = await startRun(
        routineBody({
          name: `Switchflow workers (${config.environmentId})`,
          environmentId: config.environmentId,
          repository: config.repository,
          model: config.model,
          prompt: routinePrompt(key, { writable }),
          allowedTools: writable ? WRITE_TOOLS : READ_ONLY_TOOLS,
        }),
      );
      Object.assign(handle, { triggerId, sessionId, url: `https://claude.ai/code/${sessionId}` });
      handle.runs.push({ triggerId, sessionId });
      return handle;
    },

    /** Sends a follow-up or steering message into the worker's session. */
    async message(handle, text) {
      await send(handle.sessionId, text);
      return { delivery: 'session', note: 'Delivered; the cloud worker takes it at its next turn boundary.' };
    },

    /** New log events and worker status lines since the last poll; `results` counts finished turns. */
    async poll(handle) {
      const events = [];
      try {
        // Re-read the last page each time and skip the lines already seen on it.
        for (let page = 0; page < MAX_PAGES; page++) {
          const cursor = handle.cursor;
          const body = await dispatch({
            action: 'get_run_log',
            session_id: handle.sessionId,
            ...(cursor ? { cursor } : {}),
          });
          const lines = parseRunLog(body.summary);
          for (const line of lines.slice(handle.seen)) {
            const entry = normalizeLogLine(line);
            if (!entry) continue;
            if (entry.kind === 'turn.completed' || entry.kind === 'turn.failed') handle.results++;
            events.push(entry);
          }
          handle.seen = Math.max(handle.seen, lines.length);
          if (!body.next_cursor) break;
          Object.assign(handle, { cursor: body.next_cursor, seen: 0 });
        }
      } catch (error) {
        events.push({
          kind: 'notice',
          level: 'warning',
          text: `Could not read the cloud run log: ${oneLine(error.message, 300)}`,
        });
      }
      const notesHead = await git
        .fetch(handle.cwd, remote, handle.branches.notes, ref(handle.key, 'notes'))
        .catch(() => null);
      if (notesHead) {
        const status = parseStatus(await git.show(handle.cwd, ref(handle.key, 'notes'), 'status.md'));
        for (const line of status.slice(handle.statusSeen))
          events.push({
            kind: 'notice',
            level: line.type === 'QUESTION' ? 'warning' : 'info',
            text: `${line.type === 'QUESTION' ? 'Cloud worker asks' : 'Cloud worker'}: ${oneLine(line.text, 1000)}`,
            ...(line.type === 'QUESTION' ? { needs: 'orchestrator' } : {}),
          });
        handle.statusSeen = Math.max(handle.statusSeen, status.length);
      }
      return { events, results: handle.results };
    },

    /** The approach turn must not push. Returns the offending branch heads, if any. */
    async pushedDuringApproach(handle) {
      const pushed = [];
      for (const branch of [handle.branches.result, handle.branches.notes])
        if (await git.lsRemote(handle.cwd, remote, branch)) pushed.push(branch);
      return pushed;
    },

    /** No call stops a running cloud turn: ask the worker to stop. The shared routine stays. */
    async cancel(handle) {
      const problemsSeen = [];
      await adapter
        .message(
          handle,
          'STOP. Switchflow cancelled this worker. Do not start new steps; push what you have committed and end now.',
        )
        .catch(error => problemsSeen.push(oneLine(error.message, 200)));
      return {
        stopped: false,
        note: `Asked the cloud worker to stop. It ends at its next step; archive ${handle.url} to stop it at once.`,
        problems: problemsSeen,
      };
    },

    /**
     * Fetches the result branch and fast-forwards the local candidate when it is clean and the
     * result descends from it. Otherwise the result stays at refs/switchflow/cloud/<key>/result.
     */
    async collect(handle, { cwd = handle.cwd } = {}) {
      const head = await git.fetch(cwd, remote, handle.branches.result, ref(handle.key, 'result'));
      if (!head) return { collected: false, head: null, reason: `${handle.branches.result} was not pushed.` };
      const local = await git.git(cwd, ['rev-parse', 'HEAD']);
      if (local === head) return { collected: true, head, fastForwarded: false };
      const clean = !(await git.git(cwd, ['status', '--porcelain']));
      if (clean && (await git.isAncestor(cwd, local, head))) {
        await git.git(cwd, ['merge', '--ff-only', head]);
        return { collected: true, head, fastForwarded: true };
      }
      return {
        collected: false,
        head,
        ref: ref(handle.key, 'result'),
        reason: clean
          ? 'The cloud result does not descend from the candidate head.'
          : 'The candidate has uncommitted changes.',
      };
    },

    /** Deletes the start, inbox and notes branches (and the result if asked). The routine is reused. */
    async cleanup(handle, { keepResult = true } = {}) {
      const problemsSeen = [];
      const branches = [handle.branches.task, handle.branches.inbox, handle.branches.notes];
      if (!keepResult) branches.push(handle.branches.result);
      for (const branch of branches)
        if (await git.lsRemote(handle.cwd, remote, branch).catch(() => null))
          await git
            .deleteRemote(handle.cwd, remote, branch)
            .catch(error => problemsSeen.push(oneLine(error.message, 200)));
      for (const name of ['notes', 'result'])
        await git.git(handle.cwd, ['update-ref', '-d', ref(handle.key, name)]).catch(() => {});
      return { problems: problemsSeen };
    },
  };
  return adapter;
}

/**
 * A provider-compatible session handle (startTurn / steer / interrupt / close) over the adapter,
 * so orchestration places a worker on Claude cloud without a separate code path. The first turn
 * starts the routine; later turns (a confirmed approach, a correction) are messages into the same
 * session. Each turn ends when the run log shows one more result.
 */
export async function openCloudSession({
  adapter,
  task,
  key = workerKey(task),
  cwd,
  limits = {},
  onEvent = async () => {},
  signal,
  pollMs = (adapter.config?.pollSeconds ?? 60) * 1000,
  git = createGit(),
}) {
  let handle = null;
  let active = null;
  let closed = false;
  const session = {
    provider: 'claude',
    transport: KIND,
    environment: KIND,
    canSteer: true,
    get threadId() {
      return handle?.sessionId ?? null;
    },
    get activeTurnId() {
      return active ? (handle?.sessionId ?? 'cloud') : null;
    },
    get closed() {
      return closed;
    },
    get cloud() {
      return handle;
    },
    async startTurn(text, { sandbox } = {}) {
      if (active) throw new Error('A turn is already running in this session');
      if (closed) throw new Error('This cloud session has closed');
      const writable = sandbox !== 'read-only';
      active = {};
      try {
        await onEvent({ kind: 'turn.started', turnId: handle?.sessionId ?? null });
        const before = handle?.results ?? 0;
        if (!handle) {
          const head = await git.git(cwd, ['rev-parse', 'HEAD']);
          handle = await adapter.submit({ key, task, prompt: text, head, cwd, writable });
          await onEvent({ kind: 'session.started', provider: 'claude', transport: KIND, threadId: handle.sessionId });
          await onEvent({
            kind: 'notice',
            level: 'info',
            text: `Claude cloud session ${handle.sessionId} started${writable ? '' : ' (approach turn, read-only by instruction)'}: ${handle.url}`,
            url: handle.url,
          });
        } else
          await adapter.message(
            handle,
            writable
              ? `${text}\n\nWrites are now allowed. Commit on ${handle.branches.result} and push it. End with only the requested JSON object.`
              : `${text}\n\nThis turn is read-only: do not edit, commit or push. End with only the requested JSON object.`,
          );
        const deadline = Date.now() + (limits.timeoutMs ?? 60 * 60 * 1000);
        let finished = null;
        let lastMessage = null;
        while (!finished) {
          if (signal?.aborted || active.cancelled)
            throw Object.assign(new Error('The cloud turn was cancelled.'), { interrupted: !signal?.aborted });
          if (Date.now() > deadline)
            throw new Error(
              'The cloud turn did not finish within the turn time limit; the session may still be running.',
            );
          await sleep(pollMs, signal);
          if (signal?.aborted || active.cancelled) continue;
          const polled = await adapter.poll(handle);
          let count = before;
          for (const entry of polled.events) {
            if (entry.kind === 'message') lastMessage = entry.text;
            if (entry.kind === 'turn.completed' || entry.kind === 'turn.failed') {
              if (++count > before) finished = entry;
              continue;
            }
            await onEvent(entry);
          }
        }
        if (finished.kind === 'turn.failed') throw new Error(`The cloud turn failed: ${finished.error}`);
        const result = extractJson(lastMessage) ?? extractJson(finished.result);
        if (!result) throw new Error('The cloud turn ended without the requested JSON result.');
        if (!writable) {
          const pushed = await adapter.pushedDuringApproach(handle);
          if (pushed.length)
            throw new Error(`The cloud worker pushed ${pushed.join(', ')} during its read-only approach turn.`);
        } else {
          const collected = await adapter.collect(handle, { cwd });
          await onEvent({
            kind: 'notice',
            level: collected.collected ? 'info' : 'warning',
            text: collected.collected
              ? `Collected ${handle.branches.result} at ${String(collected.head).slice(0, 12)} into the candidate.`
              : `Cloud result not collected: ${collected.reason}`,
          });
          if (collected.collected && typeof result.head === 'string') result.head = collected.head;
        }
        await onEvent({ kind: 'turn.completed', turnId: handle.sessionId, status: 'completed', usage: null });
        return { turnId: handle.sessionId, result, text: lastMessage ?? '', exitCode: 0 };
      } catch (error) {
        await onEvent({ kind: 'turn.failed', turnId: handle?.sessionId ?? null, error: oneLine(error.message, 2000) });
        throw error;
      } finally {
        active = null;
      }
    },
    async steer(text, { by = 'orchestrator' } = {}) {
      if (!handle) throw new Error('The cloud session has not started yet.');
      const sent = await adapter.message(handle, `Message from the ${by}: ${text}`);
      return { turnId: handle.sessionId, ...sent };
    },
    async interrupt() {
      if (!active || !handle) return false;
      const outcome = await adapter.cancel(handle);
      active.cancelled = true;
      await onEvent({ kind: 'interrupt', by: 'owner', turnId: handle.sessionId });
      await onEvent({ kind: 'notice', level: 'warning', text: outcome.note });
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (active) active.cancelled = true;
      if (handle) {
        const cleaned = await adapter.cleanup(handle).catch(error => ({ problems: [error.message] }));
        for (const problem of cleaned.problems) await onEvent({ kind: 'notice', level: 'warning', text: problem });
      }
      await onEvent({ kind: 'session.closed' });
    },
  };
  return session;
}
