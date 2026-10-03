/**
 * Environments: where an agent runs. A provider (claude, codex) is who runs; an environment is
 * where. The orchestration bridge, reviews and the approach gate always stay on this host, so
 * remote work is reviewed and merged locally exactly like local work.
 *
 * Every environment has:
 *   id            owner-chosen name ("local" is reserved for this PC)
 *   kind          'local' | 'ssh' | 'claude-cloud' | 'codex-cloud'
 *   label         short display name
 *   remote        true when no agent process runs on this PC (cloud kinds)
 *   capabilities  { stream, steer, interrupt, followUp, result }
 *                 result is 'local-worktree' (work happens in the candidate itself),
 *                 'remote-branch' (a branch on a git remote Switchflow fetches) or 'diff'.
 *                 Switchflow never pretends a missing capability exists.
 *   health()      Promise<{ ok, reason?, providers?, checks? }>. providers, when present, has the
 *                 agent-settings capability shape ({ codex: {available, loggedIn}, claude: {...} })
 *                 for the CLIs on that environment. Never returns secrets.
 *
 * Process kinds (local, ssh) run the same provider CLIs and also provide:
 *   prepareWorkspace({ repo, name }) -> Promise<workspace>
 *       repo is the local candidate worktree. workspace = { path, temporaryRoot, writableRoots,
 *       local } with paths in the environment's own form (POSIX for ssh).
 *   spawnFor(workspace, { onRemoteProcess }) -> spawn(executable, args, options)
 *       A function with child_process.spawn's shape, which providers take as spawnProcess.
 *       The returned child has stdin/stdout/stderr, pid, 'error'/'close' events, and may carry
 *       stopTree() (stopTree in codex-runner.mjs calls it) to stop the whole remote tree.
 *   executables   { codex, claude } names to run there, or null to keep the host defaults.
 *   collect(workspace, { into, message }) -> Promise<{ changed, head }>
 *       Commits the worker's changes there and fast-forwards the local candidate `into` via git.
 *   cleanup(workspace) -> Promise<void>;  close() stops anything the environment started itself.
 *
 * Submit kinds (claude-cloud, codex-cloud) have no local process and provide
 *   submit / poll / collect / cancel / cleanup (see environments/claude-cloud.mjs) and
 *   openSession(options), which wraps them in the usual session handle for orchestration.
 *
 * A kind registers with registerEnvironmentKind(kind, { validate, create }). validate(config)
 * returns the normalized owner config or throws; create(config, deps) returns the environment.
 * deps = { stateDir, projectRoot }. Configs are owner settings stored service-side
 * (agent-settings.mjs `environments`), never in the agent-writable checkout, and hold no secrets.
 */
import { createLocalEnvironment } from './local.mjs';
import { createSshEnvironment, validateSshConfig } from './ssh.mjs';
import { createClaudeCloudEnvironment, openCloudSession, validateCloudConfig } from './claude-cloud.mjs';

export const ENVIRONMENT_KINDS = Object.freeze(['local', 'ssh', 'claude-cloud', 'codex-cloud']);
export const LOCAL_ID = 'local';
const ENV_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMMON_KEYS = ['id', 'kind', 'label', 'enabled'];
const kinds = new Map();

export function registerEnvironmentKind(kind, { validate, create }) {
  if (!ENVIRONMENT_KINDS.includes(kind) || kind === 'local') throw new Error(`Unknown environment kind: ${kind}`);
  if (typeof validate !== 'function' || typeof create !== 'function')
    throw new Error('An environment kind needs validate and create.');
  kinds.set(kind, { validate, create });
}

/** Claude Code cloud: owner config is the routine environment, repository and push grant. */
function validateClaudeCloud(config) {
  const allowed = [...COMMON_KEYS, 'environmentId', 'repository', 'remote', 'model', 'push', 'pollSeconds'];
  const extra = Object.keys(config).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`Unsupported Claude cloud fields: ${extra.join(', ')}.`);
  const { config: valid, problems } = validateCloudConfig(config);
  if (problems.length) throw new Error(problems.join(' '));
  return valid;
}
export function createClaudeCloudAdapter(config, deps = {}) {
  const { stateDir, projectRoot, ...rest } = deps;
  const adapter = createClaudeCloudEnvironment({ config, projectRoot, ...rest });
  adapter.openSession = options => openCloudSession({ adapter, ...options });
  return Object.assign(adapter, { id: config.id ?? adapter.id ?? 'claude-cloud', remote: true });
}

registerEnvironmentKind('ssh', { validate: validateSshConfig, create: createSshEnvironment });
registerEnvironmentKind('claude-cloud', { validate: validateClaudeCloud, create: createClaudeCloudAdapter });

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
 * The one environment registry. Owner-configured environments are built (and cached) from the
 * agent settings passed to get()/list(); entries registered directly (tests, prebuilt adapters)
 * take precedence. The local environment always exists.
 *
 * new EnvironmentRegistry({ stateDir, projectRoot, factories, deps }) or
 * new EnvironmentRegistry([entry, ...]) for a fixed set of prebuilt entries.
 */
export class EnvironmentRegistry {
  constructor(options = {}) {
    const fixed = Array.isArray(options) ? options : (options.entries ?? []);
    const {
      stateDir,
      projectRoot,
      local = createLocalEnvironment(),
      factories = {},
      deps = {},
    } = Array.isArray(options) ? {} : options;
    Object.assign(this, { stateDir, projectRoot, local, factories, deps });
    this.fixed = new Map();
    this.cache = new Map();
    for (const entry of fixed) this.register(entry);
  }
  register(entry) {
    if (!entry?.id || !entry.kind || !entry.capabilities || typeof entry.health !== 'function')
      throw new Error('An environment needs id, kind, capabilities and health().');
    this.fixed.set(entry.id, entry);
    return entry;
  }
  /** Returns the environment for id under the given settings, or throws with a reason. */
  get(id, settings) {
    if (!id || id === LOCAL_ID) return this.local;
    if (this.fixed.has(id)) return this.fixed.get(id);
    const config = (settings?.environments || []).find(item => item.id === id);
    if (!config) throw new Error(`Environment ${id} is not configured.`);
    if (config.enabled === false) throw new Error(`Environment ${id} is disabled by the owner.`);
    const cached = this.cache.get(id);
    if (cached && sameConfig(cached.config, config)) return cached.environment;
    const create = this.factories[config.kind] ?? kinds.get(config.kind)?.create;
    if (!create) throw new Error(`Unsupported environment kind: ${config.kind}.`);
    const environment = create(config, { stateDir: this.stateDir, projectRoot: this.projectRoot, ...this.deps });
    cached?.environment.close?.();
    this.cache.set(id, { config, environment });
    return environment;
  }
  /** Summaries for the browser: no functions, no paths beyond what the owner typed. */
  list(settings) {
    const summary = ({ id, kind, label, capabilities, remote }) => ({
      id,
      kind,
      label,
      enabled: true,
      capabilities,
      remote: Boolean(remote),
    });
    return [
      summary(this.local),
      ...[...this.fixed.values()].map(summary),
      ...(settings?.environments || [])
        .filter(config => !this.fixed.has(config.id))
        .map(config => ({
          ...config,
          remote: config.kind === 'claude-cloud' || config.kind === 'codex-cloud',
          capabilities: kinds.get(config.kind) ? this.capabilitiesOf(config) : null,
        })),
    ];
  }
  /** Stops what environments started for themselves (an SSH box's keepAwake command). */
  close() {
    for (const { environment } of this.cache.values()) environment.close?.();
  }
  capabilitiesOf(config) {
    try {
      return this.get(config.id, { environments: [{ ...config, enabled: true }] }).capabilities;
    } catch {
      return null;
    }
  }
}

/**
 * A registry of prebuilt entries from a settings map { environments: { "<id>": { kind, ...config } } }.
 * Unknown kinds are skipped. The service itself builds environments from agent settings instead.
 */
export function createEnvironmentRegistry({ settings = {}, projectRoot, factories = {}, ...rest } = {}) {
  const registry = new EnvironmentRegistry({ projectRoot });
  for (const [id, entry] of Object.entries(settings.environments ?? {})) {
    const create = factories[entry?.kind] ?? (entry?.kind === 'ssh' ? null : kinds.get(entry?.kind)?.create);
    if (!create) continue;
    registry.register(Object.assign(create({ ...entry, id }, { projectRoot, ...rest }), { id }));
  }
  return registry;
}
