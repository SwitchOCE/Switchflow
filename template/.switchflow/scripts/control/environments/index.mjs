/**
 * Environments: where an agent runs. A provider (claude, codex) is who runs; an environment is
 * where. The orchestration bridge, reviews and the approach gate always stay on this host, so
 * remote work is reviewed and merged locally exactly like local work.
 *
 * Every environment has:
 *   id            owner-chosen name ("local" is reserved for this PC)
 *   kind          'local' | 'ssh' | 'claude-cloud' | 'codex-cloud'
 *   label         short display name
 *   capabilities  { stream, steer, interrupt, followUp, result }
 *                 result is 'local-worktree' (work happens in the candidate itself),
 *                 'remote-branch' (a branch on a git remote Switchflow fetches) or 'diff'.
 *                 Switchflow never pretends a missing capability exists.
 *   health()      Promise<{ ok, reason, providers? }>. reason is null when ok. providers, when
 *                 present, has the agent-settings capability shape ({ codex: {available, loggedIn},
 *                 claude: {...} }) for the CLIs on that environment. Never returns secrets.
 *
 * Interactive kinds (local, ssh) also provide, with stream/steer/interrupt/followUp all true:
 *   prepareWorkspace({ repo, branch, name }) -> Promise<workspace>
 *       repo is the local candidate worktree. workspace = { path, temporaryRoot, writableRoots,
 *       local } with paths in the environment's own form (POSIX for ssh).
 *   spawnFor(workspace, { onRemoteProcess }) -> spawn(executable, args, options)
 *       A function with child_process.spawn's shape, which providers take as spawnProcess.
 *       The returned child has stdin/stdout/stderr, pid, 'error'/'close' events, and may carry
 *       stopTree() (stopTree in codex-runner.mjs calls it) to stop the whole remote tree.
 *   executables   { codex, claude } names to run there, or null to keep the host defaults.
 *   collect(workspace, { into, message }) -> Promise<{ changed, head }>
 *       Commits the worker's changes there and fast-forwards the local candidate `into` via git.
 *   cleanup(workspace) -> Promise<void>
 *
 * Submit kinds (claude-cloud, codex-cloud) have stream/steer/interrupt false and provide:
 *   submit({ prompt, workspace }) -> Promise<ref>, poll(ref) -> Promise<{ status, summary }>,
 *   collect(ref, { into }) -> Promise<{ changed, head }>, cleanup(ref).
 *
 * A kind registers with registerEnvironmentKind(kind, { validate, create }). validate(config)
 * returns the normalized owner config or throws; create(config, deps) returns the environment.
 * deps = { stateDir }. Configs are owner settings stored service-side (agent-settings.mjs), never
 * in the agent-writable checkout, and never hold secrets.
 */
import { createLocalEnvironment } from './local.mjs';
import { createSshEnvironment, validateSshConfig } from './ssh.mjs';

export const ENVIRONMENT_KINDS = Object.freeze(['local', 'ssh', 'claude-cloud', 'codex-cloud']);
export const LOCAL_ID = 'local';
const ENV_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const kinds = new Map();

export function registerEnvironmentKind(kind, { validate, create }) {
  if (!ENVIRONMENT_KINDS.includes(kind) || kind === 'local') throw new Error(`Unknown environment kind: ${kind}`);
  if (typeof validate !== 'function' || typeof create !== 'function')
    throw new Error('An environment kind needs validate and create.');
  kinds.set(kind, { validate, create });
}
registerEnvironmentKind('ssh', { validate: validateSshConfig, create: createSshEnvironment });

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Validates one owner-supplied environment config and returns its normalized form. */
export function validateEnvironmentConfig(config) {
  if (!plainObject(config)) throw new Error('An environment must be an object.');
  if (typeof config.id !== 'string' || !ENV_ID.test(config.id))
    throw new Error('Environment id must be 1–32 lower-case letters, digits or dashes.');
  if (config.id === LOCAL_ID) throw new Error('The id "local" is reserved for this PC.');
  const kind = kinds.get(config.kind);
  if (!kind) throw new Error(`Unsupported environment kind: ${config.kind}.`);
  const label = config.label ?? config.id;
  if (typeof label !== 'string' || !label.trim() || label.length > 60)
    throw new Error('Environment label must be 1–60 characters.');
  const enabled = config.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
  return { ...kind.validate(config), id: config.id, kind: config.kind, label: label.trim(), enabled };
}

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Builds and caches environment objects from the owner's settings. A changed config builds a new
 * object; the local environment always exists.
 */
export class EnvironmentRegistry {
  constructor({ stateDir, local = createLocalEnvironment(), factories = {} } = {}) {
    this.stateDir = stateDir;
    this.local = local;
    this.factories = factories; // tests inject fakes per kind
    this.cache = new Map();
  }
  /** Returns the environment for id under the given settings, or throws with a reason. */
  get(id, settings) {
    if (!id || id === LOCAL_ID) return this.local;
    const config = (settings?.environments || []).find(item => item.id === id);
    if (!config) throw new Error(`Environment ${id} is not configured.`);
    if (config.enabled === false) throw new Error(`Environment ${id} is disabled by the owner.`);
    const cached = this.cache.get(id);
    if (cached && sameConfig(cached.config, config)) return cached.environment;
    const create = this.factories[config.kind] ?? kinds.get(config.kind)?.create;
    if (!create) throw new Error(`Unsupported environment kind: ${config.kind}.`);
    const environment = create(config, { stateDir: this.stateDir });
    this.cache.set(id, { config, environment });
    return environment;
  }
  /** Summaries for the browser: no functions, no paths beyond what the owner typed. */
  list(settings) {
    return [
      { id: LOCAL_ID, kind: 'local', label: this.local.label, enabled: true, capabilities: this.local.capabilities },
      ...(settings?.environments || []).map(config => ({
        ...config,
        capabilities: kinds.get(config.kind) ? this.capabilitiesOf(config, settings) : null,
      })),
    ];
  }
  /** Stops what environments started for themselves (an SSH box's keepAwake command). */
  close() {
    for (const { environment } of this.cache.values()) environment.close?.();
  }
  capabilitiesOf(config, settings) {
    try {
      return this.get(config.id, { environments: [{ ...config, enabled: true }] }).capabilities;
    } catch {
      return null;
    }
  }
}
