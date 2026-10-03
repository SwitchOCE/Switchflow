// Shared fakes for agent tests. Not a test file: importing it registers no tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveProject } from '../template/.switchflow/scripts/operations/storage.mjs';

export function intakeResult(stage = 'intake') {
  return {
    stage,
    status: 'ready',
    summary: `${stage} checkpoint`,
    nextAction: 'Review the checkpoint.',
    questions: [],
    scope: 'Fixture scope',
    plan: [],
    evidence: [],
    blockers: [],
    uat: [],
  };
}

/**
 * In-process provider with the session interface. A turn waits until it is steered with FINISH-NOW
 * (or ends at once when the prompt contains it), so tests control timing.
 */
export function fakeProvider(name, log = [], respond = null) {
  return async options => {
    const opened = { name, options, steers: [] };
    log.push(opened);
    let active = null;
    let closed = false;
    const emit = event => options.onEvent(event);
    await emit({ kind: 'session.started', provider: name, transport: 'fake', threadId: `${name}-thread`, pid: 4242 });
    const handle = {
      provider: name,
      threadId: `${name}-thread`,
      get activeTurnId() {
        return active?.id ?? null;
      },
      get closed() {
        return closed;
      },
      async startTurn(text, { outputSchema } = {}) {
        if (active) throw new Error('busy');
        const id = randomUUID();
        opened.prompt ??= text;
        opened.outputSchema = outputSchema;
        await emit({ kind: 'turn.started', turnId: id });
        await emit({ kind: 'message', text: `${name} is working`, final: false });
        return new Promise((resolve, reject) => {
          active = { id, resolve, reject };
          const cancel = () => {
            active = null;
            reject(new Error('Agent session cancelled'));
          };
          if (options.signal?.aborted) return cancel();
          if (closed) {
            active = null;
            return reject(new Error('Agent session closed'));
          }
          options.signal?.addEventListener('abort', cancel);
          if (/FINISH-NOW/.test(text)) handle.finish(text);
          options.onTurn?.(handle, text);
        });
      },
      finish(text) {
        const turn = active;
        active = null;
        const result = respond ? respond(text, options) : intakeResult();
        void emit({ kind: 'message', text: 'done', final: true })
          .then(() => emit({ kind: 'turn.completed', turnId: turn.id, status: 'completed', usage: { totalTokens: 3 } }))
          .then(() => turn.resolve({ turnId: turn.id, result, text: JSON.stringify(result) }));
      },
      async steer(text, { by }) {
        if (!active) throw new Error('No active turn to steer');
        opened.steers.push(text);
        await emit({ kind: 'steer', text, by, mode: 'steer', turnId: active.id });
        if (/FINISH-NOW/.test(text)) handle.finish(text);
        return { turnId: active?.id };
      },
      async interrupt({ by }) {
        if (!active) return false;
        const turn = active;
        active = null;
        await emit({ kind: 'interrupt', by, turnId: turn.id });
        await emit({ kind: 'turn.completed', turnId: turn.id, status: 'interrupted' });
        turn.reject(Object.assign(new Error('interrupted'), { interrupted: true }));
        return true;
      },
      async close() {
        closed = true;
        if (active) {
          const turn = active;
          active = null;
          turn.reject(new Error('Agent session closed'));
        }
        await emit({ kind: 'session.closed' });
      },
    };
    opened.handle = handle;
    return handle;
  };
}

export async function fixture(fn) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'switchflow-agents-test-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore', windowsHide: true });
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Base',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const context = await resolveProject(root, { stateHome: path.join(base, 'state') });
  try {
    await fn(context);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for test condition');
}
