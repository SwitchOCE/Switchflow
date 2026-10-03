import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { safeWorkerEnv, withWorkerEnv } from '../worker-env.mjs';
export { stopTree } from '../codex-runner.mjs';

export const MAX_LINE = 2 * 1024 * 1024;
export const MAX_RAW_LOG = 16 * 1024 * 1024;
export const MAX_PROMPT = 1024 * 1024;
export const SANDBOXES = Object.freeze(['workspace-write', 'read-only']);

/** A finished turn that the owner or orchestrator stopped. It is an outcome, not a crash. */
export class TurnInterruptedError extends Error {
  constructor(message = 'The turn was interrupted.') {
    super(message);
    this.interrupted = true;
  }
}

export const stripAnsi = text => String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

export function oneLine(value, limit = 240) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Same policy as codexArguments(): only two sandboxes and absolute, host-approved roots. */
export function validatePolicy({ sandbox, writableRoots = [], temporaryRoot }) {
  if (!SANDBOXES.includes(sandbox)) throw new Error('Unsafe sandbox mode');
  if (!Array.isArray(writableRoots) || writableRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))
    throw new Error('Writable roots must be absolute host-approved paths');
  if (temporaryRoot !== undefined && (typeof temporaryRoot !== 'string' || !path.isAbsolute(temporaryRoot)))
    throw new Error('Temporary root must be an absolute host-approved path');
  // A read-only session never receives extra write grants, including the private temp folder.
  if (sandbox === 'read-only') return [];
  return temporaryRoot ? [...writableRoots, temporaryRoot] : [...writableRoots];
}

/** A turn may narrow its session's sandbox to read-only, never widen it. */
export function turnSandbox(session, requested) {
  if (requested === undefined || requested === null) return session;
  if (!SANDBOXES.includes(requested)) throw new Error('Unsafe sandbox mode');
  if (session === 'read-only' && requested !== 'read-only') throw new Error('A turn cannot widen its session sandbox');
  return requested;
}

export function validatePrompt(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_PROMPT)
    throw new Error('Invalid or oversized prompt');
}

/**
 * The agent's environment: the service's own, plus the capacity profile's worker caps, plus the
 * host's fixed values, which always win. workerEnv passes the worker-env policy again here.
 */
export function childEnvironment(temporaryRoot, extra = {}, workerEnv = {}) {
  const env = { ...withWorkerEnv(process.env, workerEnv), NO_COLOR: '1', ...extra };
  if (temporaryRoot) Object.assign(env, { TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot });
  return env;
}

/** Codex shell commands get the caps through its environment policy too, whatever config.toml says. */
export function codexEnvironmentOverrides(workerEnv = {}) {
  return Object.entries(safeWorkerEnv(workerEnv)).flatMap(([name, value]) => [
    '-c',
    `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
  ]);
}

/** Reads newline-delimited text with a bounded line length. */
export async function readLines(stream, onLine, { maxLine = MAX_LINE } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      if (newline > maxLine) throw new Error('Agent output line limit exceeded');
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) await onLine(line);
    }
    if (buffer.length > maxLine) throw new Error('Agent output line limit exceeded');
  }
  buffer += decoder.end();
  if (buffer.trim()) await onLine(buffer);
}

/** Bounded raw protocol log for diagnosis. Never exposed through the web API. */
export async function openRawLog(file) {
  if (!file) return { write: async () => {}, close: async () => {} };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'wx');
  let bytes = 0;
  let truncated = false;
  let chain = Promise.resolve();
  return {
    write(direction, value) {
      const line = `${direction} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
      chain = chain
        .then(async () => {
          if (truncated) return;
          bytes += Buffer.byteLength(line);
          if (bytes > MAX_RAW_LOG) {
            truncated = true;
            await handle.write('# raw log limit reached\n');
            return;
          }
          await handle.write(line);
        })
        .catch(() => {});
      return chain;
    },
    async close() {
      await chain;
      await handle.close();
    },
  };
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: null,
  };
}
