import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, updateState } from '../operations/storage.mjs';
import { ControlError } from './lifecycle.mjs';
import { claudeExecutable } from './providers/claude-cli.mjs';

const exec = promisify(execFile);
export const PROVIDERS = Object.freeze(['claude', 'codex']);
/** execution = phase orchestrator; delivery = task worker; review = independent reviewer. */
export const ROLES = Object.freeze(['intake', 'planning', 'execution', 'delivery', 'review', 'uat']);
const LIMITS = Object.freeze({
  timeoutMinutes: [1, 1440],
  maxWorkers: [1, 8],
  maxReviewRounds: [1, 5],
  maxTurns: [1, 1000],
});
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;
const SAFE_EFFORT = /^[a-z]{2,10}$/;

export function defaultAgentSettings() {
  return {
    schemaVersion: 1,
    revision: 0,
    roles: {
      intake: 'claude',
      planning: 'claude',
      execution: 'claude',
      delivery: 'codex',
      review: 'auto',
      uat: 'claude',
    },
    models: { claude: null, codex: null },
    efforts: { claude: null, codex: null },
    limits: { timeoutMinutes: 60, maxWorkers: 2, maxReviewRounds: 2, maxTurns: 200 },
  };
}

function mergeStored(stored) {
  const base = defaultAgentSettings();
  if (!stored || stored.schemaVersion !== 1) return base;
  return {
    ...base,
    revision: Number.isSafeInteger(stored.revision) ? stored.revision : 0,
    roles: { ...base.roles, ...stored.roles },
    models: { ...base.models, ...stored.models },
    efforts: { ...base.efforts, ...stored.efforts },
    limits: { ...base.limits, ...stored.limits },
  };
}

export async function readAgentSettings(context) {
  return mergeStored(await readState(context, 'agent-settings', null));
}

const fail = message => {
  throw new ControlError(message);
};
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Applies a partial browser update. Unknown keys and values are refused rather than ignored. */
export function applySettingsPatch(current, input) {
  if (!plainObject(input)) fail('A settings object is required.');
  const allowed = ['roles', 'models', 'efforts', 'limits', 'expectedRevision'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail(`Only ${allowed.join(', ')} can be supplied.`);
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision)
    throw new ControlError('Agent settings changed. Refresh and review them before saving.', 409);
  const next = structuredClone(current);
  if (input.roles !== undefined) {
    if (!plainObject(input.roles)) fail('roles must be an object.');
    for (const [role, provider] of Object.entries(input.roles)) {
      if (!ROLES.includes(role)) fail(`Unknown role: ${role}.`);
      const choices = role === 'review' ? [...PROVIDERS, 'auto'] : PROVIDERS;
      if (!choices.includes(provider)) fail(`${role} must be one of ${choices.join(', ')}.`);
      next.roles[role] = provider;
    }
  }
  for (const [key, pattern] of [
    ['models', SAFE_MODEL],
    ['efforts', SAFE_EFFORT],
  ]) {
    if (input[key] === undefined) continue;
    if (!plainObject(input[key])) fail(`${key} must be an object.`);
    for (const [provider, value] of Object.entries(input[key])) {
      if (!PROVIDERS.includes(provider)) fail(`Unknown provider in ${key}: ${provider}.`);
      if (value !== null && (typeof value !== 'string' || !pattern.test(value)))
        fail(`${key}.${provider} must be null or a plain name.`);
      next[key][provider] = value;
    }
  }
  if (input.limits !== undefined) {
    if (!plainObject(input.limits)) fail('limits must be an object.');
    for (const [key, value] of Object.entries(input.limits)) {
      if (!LIMITS[key]) fail(`Unknown limit: ${key}.`);
      const [min, max] = LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max)
        fail(`limits.${key} must be an integer from ${min} to ${max}.`);
      next.limits[key] = value;
    }
  }
  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

export async function writeAgentSettings(context, input) {
  let saved;
  await updateState(context, 'agent-settings', stored => {
    saved = applySettingsPatch(mergeStored(stored), input);
    return saved;
  });
  return saved;
}

/** Accepts legacy injected capabilities ({ codex: false }) and the current per-provider shape. */
export function normalizeCapabilities(capabilities = {}) {
  const one = value =>
    value === true
      ? { available: true }
      : plainObject(value)
        ? { ...value, available: value.available !== false }
        : { available: false };
  return { codex: one(capabilities.codex), claude: one(capabilities.claude) };
}

export function providerUsable(capabilities, provider) {
  const entry = normalizeCapabilities(capabilities)[provider];
  return entry.available && (provider !== 'claude' || entry.loggedIn !== false);
}

const unusableReason = (capabilities, provider) => {
  const entry = normalizeCapabilities(capabilities)[provider];
  if (!entry.available) return `${provider} is not installed or did not report a version`;
  if (provider === 'claude' && entry.loggedIn === false) return 'claude is not signed in';
  return `${provider} is unavailable`;
};

/**
 * Picks the provider for a role. Unavailable providers fall back to the other one, and the
 * caller must record the returned fallback visibly. Review must differ from the author.
 */
export function resolveProvider({ role, settings, capabilities, author = null, requested = null }) {
  if (!ROLES.includes(role)) throw new Error(`Unknown agent role: ${role}`);
  const other = provider => (provider === 'claude' ? 'codex' : 'claude');
  if (role === 'review') {
    if (!PROVIDERS.includes(author)) throw new ControlError('Review needs the author provider.', 409);
    const configured = settings.roles.review;
    const wanted = requested ?? (configured === 'auto' ? other(author) : configured);
    if (wanted === author)
      throw new ControlError(`Review must use a different provider from the author (${author}).`, 409);
    if (!providerUsable(capabilities, wanted))
      throw new ControlError(
        `Independent review needs ${wanted}, but ${unusableReason(capabilities, wanted)}. Escalate or review through the host.`,
        409,
      );
    return { provider: wanted, fallback: null };
  }
  const wanted = requested ?? settings.roles[role];
  if (!PROVIDERS.includes(wanted)) throw new ControlError(`Unknown provider: ${wanted}.`);
  if (providerUsable(capabilities, wanted)) return { provider: wanted, fallback: null };
  const alternative = other(wanted);
  if (!providerUsable(capabilities, alternative))
    throw new ControlError(
      `No agent provider is available: ${unusableReason(capabilities, wanted)}; ${unusableReason(capabilities, alternative)}.`,
      503,
    );
  return {
    provider: alternative,
    fallback: { from: wanted, to: alternative, reason: unusableReason(capabilities, wanted) },
  };
}

/** Checks both installed CLIs without starting a model turn. */
export async function probeCapabilities({ run = exec, claudePath = claudeExecutable() } = {}) {
  const options = { windowsHide: true, timeout: 8000 };
  const codex = await run('codex', ['--version'], options)
    .then(r => ({ available: true, version: r.stdout.trim(), transport: 'app-server', diagnostic: r.stderr.trim() }))
    .catch(error => ({ available: false, diagnostic: error.message }));
  if (!claudePath)
    return { codex, claude: { available: false, loggedIn: false, diagnostic: 'Claude Code is not installed.' } };
  const claude = await run(claudePath, ['--version'], options)
    .then(r => ({ available: true, version: r.stdout.trim().replace(/\s*\(Claude Code\)$/, ''), transport: 'cli' }))
    .catch(error => ({ available: false, loggedIn: false, diagnostic: error.message }));
  if (claude.available) {
    // `auth status` exits non-zero when signed out but still prints JSON.
    const status = await run(claudePath, ['auth', 'status'], options).catch(error => error);
    try {
      const parsed = JSON.parse(status.stdout);
      claude.loggedIn = parsed.loggedIn === true;
      claude.authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
    } catch {
      claude.loggedIn = false;
      claude.diagnostic = 'Could not read `claude auth status`.';
    }
  }
  return { codex, claude };
}
