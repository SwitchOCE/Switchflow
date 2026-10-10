import { oneLine } from '../providers/process.mjs';
import { createGit, extractJson, runProcess, workerKey } from './claude-cloud.mjs';

/**
 * Codex cloud as a Switchflow environment: opt-in and fire-and-forget. Checked on 2026-10-04
 * against the installed codex-cli 0.153.4 help and the CLI source (codex-rs/cloud-tasks):
 *
 * - `codex cloud exec --env <ENV_ID> --branch <BRANCH> <QUERY>` submits one task and prints only
 *   the task URL; the task ID is its last path segment. The branch must exist on GitHub, so the
 *   host pushes the candidate head first, and only under the owner's push grant.
 * - `codex cloud status <TASK_ID>` prints "[STATUS] title", the environment and diff stats, and
 *   exits 0 only when the task is READY. `codex cloud list --json` carries the same status and
 *   diff stats per task. Neither, nor any other command, returns the assistant's messages.
 * - `codex cloud diff <TASK_ID>` prints the unified diff. `codex cloud apply` runs `git apply` in
 *   whatever directory it is started in and can leave a partial apply behind, so collect() takes
 *   the diff and applies it with `git apply --check` first instead.
 * - There is no follow-up, steering, cancel or environment listing from the CLI.
 *
 * So the worker's final JSON travels in the diff, as RESULT_FILE, which is never applied. There
 * is no approach turn: a confirmed approach could only start a second, unrelated task, so the
 * kind declares approachGate: false and orchestration refuses it for delivery (every delivery
 * worker has the gate). Read-only work (reviews) is host-enforced: its diff is never applied.
 */

export const KIND = 'codex-cloud';
export const RESULT_FILE = '.switchflow-result.json';
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,119}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const KEY = /^[a-z0-9][a-z0-9-]{2,62}$/;
// The prompt travels in argv; Windows caps a command line near 32K characters.
export const MAX_PROMPT = 24000;
const ANSI = /\u001b\[[0-9;]*m/g;

export const CAPABILITIES = Object.freeze({
  stream: false, // status is polled (pollSeconds, default 60); no events arrive in between
  steer: false,
  interrupt: false, // no cancel from the CLI; Switchflow can only stop waiting
  followUp: false, // follow-ups exist in the ChatGPT UI only
  result: 'diff', // applied into the local candidate and committed there by collect()
  approachGate: false, // no read-only first turn; see the header
});

const fail = message => {
  throw Object.assign(new Error(message), { environment: KIND });
};

/** Validates the owner's configuration for this environment (stored service-side). */
export function validateCodexCloudConfig(input = {}) {
  const config = {
    environmentId: input.environmentId ?? null,
    repository: input.repository ?? null,
    remote: input.remote ?? 'origin',
    push: input.push === true,
    pollSeconds: input.pollSeconds ?? 60,
    experimental: input.experimental === true,
  };
  const problems = [];
  if (!config.experimental)
    problems.push('Codex cloud is experimental: set experimental to true to opt in to this environment.');
  if (!ENVIRONMENT_ID.test(String(config.environmentId ?? '')))
    problems.push(
      'environmentId must be the Codex cloud environment ID (copy it from `codex cloud` or chatgpt.com/codex).',
    );
  if (!GITHUB_REPO.test(String(config.repository ?? '')))
    problems.push('repository must be https://github.com/<owner>/<repo>.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.remote)) problems.push('remote must be a Git remote name.');
  if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 15 || config.pollSeconds > 900)
    problems.push('pollSeconds must be 15–900.');
  return { config, problems };
}

export const taskBranch = key => {
  if (!KEY.test(key)) fail('Invalid cloud worker key.');
  return `sf-task/${key}`;
};

/** The task ID from exec's output (the task URL) or from a URL the owner pasted. */
export function parseTaskId(text) {
  const line = String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
    .pop();
  const id = String(line ?? '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .split('/')
    .pop();
  return TASK_ID.test(id) ? id : null;
}

/** "[READY] title" plus detail lines from `codex cloud status`. */
export function parseStatus(text) {
  const lines = String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const match = lines[0]?.match(/^\[([A-Za-z_]+)\]\s*(.*)$/);
  if (!match) return null;
  return { status: match[1].toLowerCase(), title: match[2], detail: lines.slice(1).join(' • ') };
}

/** Files a unified diff touches, by their new path (old path for deletions). */
export function diffFiles(diff) {
  return [...String(diff ?? '').matchAll(/^diff --git a\/(\S+) b\/(\S+)\s*$/gm)].map(([, a, b]) => b || a);
}

/** The worker's result object: the added lines of RESULT_FILE in the diff, parsed as JSON. */
export function resultFromDiff(diff) {
  const sections = String(diff ?? '').split(/^(?=diff --git )/m);
  const section = sections.find(part => part.startsWith(`diff --git a/${RESULT_FILE} b/${RESULT_FILE}`));
  if (!section) return null;
  const added = section
    .split(/\r?\n/)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
  return extractJson(added);
}

/** The cloud task's prompt: the cloud contract, then the delegation prompt. */
export function taskPrompt({ key, task, prompt, writable }) {
  return [
    `Switchflow task ${task} (${key}), run in Codex cloud on branch ${taskBranch(key)}. The Switchflow host on the owner PC takes your diff, reviews it and merges it; nothing you push, commit or open as a pull request is used.`,
    writable
      ? `Make your changes in the working tree. The host applies your diff to its candidate and commits it; ${RESULT_FILE} is removed first.`
      : `This task is read-only: change no file except ${RESULT_FILE}. The host never applies this task's diff.`,
    `When you finish, write your final JSON object, and nothing else, to ${RESULT_FILE} at the repository root. That file is your reply: the host cannot read your messages.`,
    '',
    prompt,
  ].join('\n');
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
 * The environment adapter. `config` is the owner's stored configuration (validateCodexCloudConfig);
 * `projectRoot` is a local checkout whose remote is the configured GitHub repository.
 */
export function createCodexCloudEnvironment({
  config: input = {},
  projectRoot,
  run = runProcess,
  git = createGit(),
  executable = 'codex',
} = {}) {
  const { config, problems } = validateCodexCloudConfig(input);
  const remote = config.remote;
  const env = { ...process.env, NO_COLOR: '1' };
  const codex = (args, options = {}) => run(executable, ['cloud', ...args], { cwd: projectRoot, env, ...options });
  // status and diff exit non-zero for "not ready" and "no diff yet"; their stdout still answers.
  const answer = (args, options) =>
    codex(args, options).then(
      ({ stdout }) => ({ ok: true, stdout }),
      error => {
        if (error.code === 'ENOENT') fail('The Codex CLI is not installed.');
        return { ok: false, stdout: `${error.stdout ?? ''}`, stderr: `${error.stderr ?? error.message}` };
      },
    );

  const adapter = {
    id: KIND,
    kind: KIND,
    label: 'Codex cloud',
    provider: 'codex', // only Codex runs here; orchestration refuses any other provider
    capabilities: CAPABILITIES,
    remote: true, // memory admission does not apply
    config,

    async health({ branch = null } = {}) {
      const checks = [];
      const check = (name, ok, detail) => checks.push({ name, ok, detail });
      check('configured', problems.length === 0, problems.join(' ') || `environment ${config.environmentId}`);
      const version = await run(executable, ['--version'], { env, timeoutMs: 15000 }).catch(() => null);
      check('codex', Boolean(version), version ? oneLine(version.stdout, 80) : 'The Codex CLI is not installed.');
      if (version) {
        // Every cloud command needs ChatGPT sign-in; list is the cheapest read-only one.
        const listed = await codex(['list', '--json', '--env', String(config.environmentId), '--limit', '1'], {
          timeoutMs: 30000,
        }).catch(error => error);
        let ok = false;
        try {
          ok = Array.isArray(JSON.parse(listed.stdout).tasks);
        } catch {
          ok = false;
        }
        check(
          'cloud',
          ok,
          ok
            ? 'signed in with ChatGPT; cloud tasks answer'
            : `codex cloud list failed: ${oneLine(listed.stderr || listed.message || listed.stdout, 200)} (sign in with codex login, using ChatGPT)`,
        );
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
          ? 'Codex cloud starts from GitHub: Switchflow pushes the candidate head to sf-task/* (push granted)'
          : 'Codex cloud starts from GitHub, so the candidate head must be pushed; with no push grant, placement here is refused',
      );
      const failed = checks.filter(entry => !entry.ok && entry.name !== 'branch');
      return {
        ok: failed.length === 0,
        ...(failed.length ? { reason: failed.map(entry => entry.detail).join(' ') } : {}),
        checks,
      };
    },

    /** Pushes the candidate head to sf-task/<key>, then submits the task. Returns the handle. */
    async submit({ key, task, prompt, head, cwd = projectRoot, writable = false }) {
      if (problems.length) fail(`Codex cloud is not configured: ${problems.join(' ')}`);
      if (!config.push)
        fail(
          'Codex cloud works from the GitHub repository, so the candidate head must be pushed first. Switchflow pushes sf-task/* only when the owner grants pushes for this environment.',
        );
      if (!/^[0-9a-f]{40}$/.test(String(head))) fail('submit needs the candidate head commit.');
      const text = taskPrompt({ key, task, prompt, writable });
      if (text.length > MAX_PROMPT)
        fail(`The Codex cloud prompt is ${text.length} characters; the command line allows ${MAX_PROMPT}.`);
      const branch = taskBranch(key);
      if ((await git.lsRemote(cwd, remote, branch)) !== head) await git.push(cwd, remote, head, branch);
      const handle = { key, task, cwd, head, branch, writable, taskId: null, url: null, status: null, pushed: true };
      let submitted;
      try {
        submitted = await codex(['exec', '--env', config.environmentId, '--branch', branch, text], {
          cwd,
          timeoutMs: 120000,
        });
      } catch (error) {
        await adapter.cleanup(handle).catch(() => {});
        fail(`codex cloud exec failed: ${oneLine(error.stderr || error.message, 300)}`);
      }
      const taskId = parseTaskId(submitted.stdout);
      if (!taskId) {
        await adapter.cleanup(handle).catch(() => {});
        fail(`codex cloud exec printed no task URL: ${oneLine(submitted.stdout, 200)}`);
      }
      const url = String(submitted.stdout).replace(ANSI, '').trim().split(/\r?\n/).pop().trim();
      return Object.assign(handle, { taskId, url: /^https:\/\//.test(url) ? url : null });
    },

    /** The task's status: pending, ready, applied or error. */
    async poll(handle) {
      const answered = await answer(['status', handle.taskId], { timeoutMs: 60000 });
      const parsed = parseStatus(answered.stdout);
      if (!parsed) fail(`codex cloud status gave no status: ${oneLine(answered.stderr || answered.stdout, 300)}`);
      handle.status = parsed.status;
      return parsed;
    },

    async diff(handle) {
      const answered = await answer(['diff', handle.taskId], { timeoutMs: 120000 });
      if (!answered.ok) fail(`codex cloud diff failed: ${oneLine(answered.stderr || answered.stdout, 300)}`);
      return answered.stdout;
    },

    /** No cancel exists in the CLI: the task keeps running until it ends or the owner stops it. */
    async cancel(handle) {
      return {
        stopped: false,
        note: `Codex cloud has no cancel from the CLI. Switchflow stopped waiting; stop the task at ${handle.url ?? 'chatgpt.com/codex'} if it should not finish.`,
      };
    },

    /**
     * Applies the task's diff (without RESULT_FILE) to the clean local candidate and commits it
     * there. Refuses a dirty candidate or a diff that does not apply; nothing is half-applied.
     */
    async collect(handle, { cwd = handle.cwd, diff = null, message = null } = {}) {
      const text = diff ?? (await adapter.diff(handle));
      const local = await git.git(cwd, ['rev-parse', 'HEAD']);
      const files = diffFiles(text).filter(file => file !== RESULT_FILE);
      if (!files.length) return { collected: true, changed: false, head: local };
      if (await git.git(cwd, ['status', '--porcelain']))
        return { collected: false, changed: false, head: local, reason: 'The candidate has uncommitted changes.' };
      const patch = text.endsWith('\n') ? text : `${text}\n`;
      const apply = ['apply', '--index', '--whitespace=nowarn', `--exclude=${RESULT_FILE}`];
      try {
        await git.git(cwd, [...apply, '--check', '-'], { input: patch });
      } catch (error) {
        return {
          collected: false,
          changed: false,
          head: local,
          reason: `The Codex cloud diff does not apply to the candidate: ${oneLine(error.stderr || error.message, 300)}`,
        };
      }
      const identity = {
        GIT_AUTHOR_NAME: 'Switchflow',
        GIT_AUTHOR_EMAIL: 'switchflow@localhost',
        GIT_COMMITTER_NAME: 'Switchflow',
        GIT_COMMITTER_EMAIL: 'switchflow@localhost',
      };
      try {
        await git.git(cwd, [...apply, '-'], { input: patch });
        await git.git(
          cwd,
          [
            'commit',
            '--no-verify',
            '-q',
            '-m',
            message ?? `${handle.task}: work from Codex cloud task ${handle.taskId}`,
          ],
          {
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...identity },
          },
        );
      } catch (error) {
        // The candidate was clean before the apply, so this only undoes it.
        await git.git(cwd, ['reset', '-q', '--hard', local]).catch(() => {});
        return {
          collected: false,
          changed: false,
          head: local,
          reason: `Could not commit the Codex cloud diff: ${oneLine(error.stderr || error.message, 300)}`,
        };
      }
      return { collected: true, changed: true, head: await git.git(cwd, ['rev-parse', 'HEAD']), files };
    },

    /** Deletes the pushed start branch. The cloud task itself stays listed in ChatGPT. */
    async cleanup(handle) {
      const problemsSeen = [];
      if (handle.pushed && (await git.lsRemote(handle.cwd, remote, handle.branch).catch(() => null)))
        await git
          .deleteRemote(handle.cwd, remote, handle.branch)
          .catch(error => problemsSeen.push(oneLine(error.message, 200)));
      return { tasks: handle.taskId ? [handle.taskId] : [], problems: problemsSeen };
    },
  };
  return adapter;
}

/**
 * A provider-compatible session handle over the adapter. It runs exactly one turn, which is one
 * cloud task; a second turn is refused (no follow-up), as are steering and interrupt.
 *
 * Restarts: onHandle(record) receives the handle as plain JSON when the task is submitted, when
 * its status changes and when its diff was collected (taskId, url, branch, status, `turn` and
 * `collectedHead`). openCodexCloudSession({ resume: record }) reattaches to the task by its ID,
 * and resumeTurn() goes on polling it; a diff already collected is not applied twice.
 */
export async function openCodexCloudSession({
  adapter,
  task,
  key = workerKey(task),
  cwd,
  sandbox: sessionSandbox = 'workspace-write',
  limits = {},
  onEvent = async () => {},
  onHandle = async () => {},
  resume = null,
  signal,
  pollMs = (adapter.config?.pollSeconds ?? 60) * 1000,
  git = createGit(),
}) {
  let handle = resume ? { ...structuredClone(resume), cwd: cwd ?? resume.cwd } : null;
  let active = null;
  let closed = false;
  const record = () => onHandle(structuredClone(handle));
  if (handle) {
    await onEvent({ kind: 'session.started', provider: 'codex', transport: KIND, threadId: handle.taskId });
    await onEvent({
      kind: 'notice',
      level: 'info',
      text: `Reconnected to Codex cloud task ${handle.taskId}, which kept running while the service was stopped${handle.url ? `: ${handle.url}` : '.'}`,
      ...(handle.url ? { url: handle.url } : {}),
    });
  }

  /** The one turn: begin() submits the task (or nothing, when reattached), then its status is polled. */
  async function runTurn(writable, begin) {
    if (active) throw new Error('A turn is already running in this session');
    if (closed) throw new Error('This cloud session has closed');
    active = {};
    try {
      await onEvent({ kind: 'turn.started', turnId: handle?.taskId ?? null });
      await begin();
      const deadline = Date.now() + (limits.timeoutMs ?? 60 * 60 * 1000);
      let state = null;
      while (!['ready', 'applied', 'error'].includes(state?.status)) {
        if (signal?.aborted || active.cancelled)
          throw Object.assign(new Error('Stopped waiting for the Codex cloud task.'), {
            interrupted: !signal?.aborted,
          });
        if (Date.now() > deadline)
          throw new Error('The Codex cloud task did not finish within the turn time limit; it may still be running.');
        await sleep(pollMs, signal);
        if (signal?.aborted || active.cancelled) continue;
        const previous = state?.status;
        // A failed poll (network, sign-in) is reported and retried until the turn time limit.
        const polled = await adapter.poll(handle).catch(error => error);
        if (polled instanceof Error) {
          await onEvent({
            kind: 'notice',
            level: 'warning',
            text: `Could not read the Codex cloud status: ${oneLine(polled.message, 300)}`,
          });
          continue;
        }
        state = polled;
        if (state.status !== previous) {
          await record();
          await onEvent({
            kind: 'notice',
            level: 'info',
            text: `Codex cloud task ${state.status}${state.detail ? `: ${oneLine(state.detail, 300)}` : ''}`,
          });
        }
      }
      if (state.status === 'error') throw new Error(`The Codex cloud task failed: ${state.title || handle.taskId}`);
      const diff = await adapter.diff(handle);
      const result = resultFromDiff(diff);
      if (!result) throw new Error(`The Codex cloud task ended without ${RESULT_FILE}, so it returned no result.`);
      const files = diffFiles(diff).filter(file => file !== RESULT_FILE);
      if (!writable) {
        if (files.length)
          await onEvent({
            kind: 'notice',
            level: 'warning',
            text: `The read-only Codex cloud task changed ${files.length} file(s); the host discarded them.`,
          });
      } else if (handle.collectedHead) {
        // Collected before a restart: the candidate already has it.
        if (typeof result.head === 'string') result.head = handle.collectedHead;
      } else {
        const collected = await adapter.collect(handle, { cwd, diff });
        if (!collected.collected)
          throw new Error(
            `The Codex cloud diff was not collected: ${collected.reason} The task stays at ${handle.url}.`,
          );
        handle.collectedHead = collected.head;
        await record();
        await onEvent({
          kind: 'notice',
          level: 'info',
          text: collected.changed
            ? `Applied the Codex cloud diff (${collected.files.length} file(s)) and committed it at ${collected.head.slice(0, 12)}.`
            : 'The Codex cloud task changed no files.',
        });
        if (typeof result.head === 'string') result.head = collected.head;
      }
      Object.assign(handle, { turn: { open: false, writable }, lastResult: result });
      await record();
      await onEvent({ kind: 'turn.completed', turnId: handle.taskId, status: 'completed', usage: null });
      return { turnId: handle.taskId, result, text: '', exitCode: 0 };
    } catch (error) {
      if (handle?.turn?.open) {
        handle.turn = { open: false, writable };
        await record().catch(() => {});
      }
      await onEvent({ kind: 'turn.failed', turnId: handle?.taskId ?? null, error: oneLine(error.message, 2000) });
      throw error;
    } finally {
      active = null;
    }
  }

  const session = {
    provider: 'codex',
    transport: KIND,
    environment: KIND,
    canSteer: false,
    get threadId() {
      return handle?.taskId ?? null;
    },
    get activeTurnId() {
      return active ? (handle?.taskId ?? 'cloud') : null;
    },
    get closed() {
      return closed;
    },
    get cloud() {
      return handle;
    },
    async startTurn(text, { sandbox } = {}) {
      if (active) throw new Error('A turn is already running in this session');
      if (handle)
        throw new Error(
          `Codex cloud has no follow-up turns. Continue in ChatGPT at ${handle.url ?? 'chatgpt.com/codex'}, or delegate a new worker.`,
        );
      const writable = sessionSandbox !== 'read-only' && sandbox !== 'read-only';
      return runTurn(writable, async () => {
        const head = await git.git(cwd, ['rev-parse', 'HEAD']);
        handle = await adapter.submit({ key, task, prompt: text, head, cwd, writable });
        handle.turn = { open: true, writable };
        await record();
        await onEvent({ kind: 'session.started', provider: 'codex', transport: KIND, threadId: handle.taskId });
        await onEvent({
          kind: 'notice',
          level: 'info',
          text: `Codex cloud task ${handle.taskId} submitted from ${handle.branch}${writable ? '' : ' (read-only: its diff is never applied)'}. It cannot be steered or interrupted from here${handle.url ? `: ${handle.url}` : '.'}`,
          ...(handle.url ? { url: handle.url } : {}),
        });
      });
    },
    /** After a restart: goes on polling the task that was running when the service stopped. */
    async resumeTurn() {
      if (!handle?.turn?.open) throw new Error('No Codex cloud task was running when the service stopped.');
      const writable = sessionSandbox !== 'read-only' && handle.turn.writable;
      return runTurn(writable, async () => {});
    },
    async steer() {
      throw new Error('Codex cloud tasks cannot be steered. Continue in ChatGPT, or delegate a new worker.');
    },
    /** Stops waiting only: the cloud task keeps running (no cancel exists in the CLI). */
    async interrupt() {
      if (!active || !handle) return false;
      active.cancelled = true;
      const outcome = await adapter.cancel(handle);
      await onEvent({ kind: 'notice', level: 'warning', text: outcome.note });
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (active) active.cancelled = true;
      if (handle) {
        const cleaned = await adapter.cleanup(handle).catch(error => ({ problems: [error.message], tasks: [] }));
        for (const problem of cleaned.problems) await onEvent({ kind: 'notice', level: 'warning', text: problem });
      }
      await onEvent({ kind: 'session.closed' });
    },
  };
  return session;
}
