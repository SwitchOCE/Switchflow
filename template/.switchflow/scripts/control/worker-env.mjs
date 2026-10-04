// Environment caps the capacity profile injects into every agent process (see capacity.mjs and
// docs/browser-control.md "Capacity"). Agents can write the governance checkout that holds the
// profile, so the policy here is enforced again where processes are spawned: a profile can only
// add plain resource caps, never redirect tools, credentials, sandboxes or configuration.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export const MAX_ENV_VALUE = 1024;
export const MAX_ENV_VARS = 32;

/** Exact names (case-insensitive) that select programs, homes, temp folders, proxies or loaders. */
export const DENIED_ENV_NAMES = Object.freeze([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PSMODULEPATH',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'NO_COLOR',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS4',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'KUBECONFIG',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'BROWSER',
]);
/** Prefixes (case-insensitive) owned by the agents, Git, package managers, loaders or cloud credentials. */
export const DENIED_ENV_PREFIXES = Object.freeze([
  'CLAUDE',
  'ANTHROPIC',
  'OPENAI',
  'CODEX',
  'SWITCHFLOW',
  'GIT_',
  'SSH_',
  'GPG',
  'GNUPG',
  'NPM_CONFIG',
  'YARN_',
  'PNPM_',
  'BUN_',
  'LD_',
  'DYLD_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCLOUD',
  'GH_',
  'GITHUB_',
]);
/** Any name containing one of these parts looks like a secret and is refused. */
const SECRET_PART = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH|KEY|KEYS|APIKEY|COOKIE|SESSION)(_|$)/i;
/** NODE_OPTIONS may only size the heap; --require, --import and loaders would run code in every Node process. */
const NODE_OPTION = /^--max-(old|semi)-space-size=\d{1,6}$/;

/**
 * Set by the host for each worker (its port block and Docker Compose project, worker-resources.mjs),
 * never by a profile. Only values of exactly this shape pass.
 */
export const HOST_ENV = Object.freeze({
  SWITCHFLOW_PORT_BASE: /^[1-9]\d{3,4}$/,
  SWITCHFLOW_PORT_COUNT: /^[1-9]\d{0,3}$/,
  COMPOSE_PROJECT_NAME: /^sf-[0-9a-f]{8}$/,
});
const hostEnvAllowed = (name, value) =>
  Object.hasOwn(HOST_ENV, name) && typeof value === 'string' && HOST_ENV[name].test(value);

/** Why a workerEnv entry is refused, or null when it may be injected. */
export function workerEnvRefusal(name, value) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'must be a plain variable name';
  const upper = name.toUpperCase();
  if (Object.hasOwn(HOST_ENV, upper)) return 'is set by the host for each worker';
  if (DENIED_ENV_NAMES.includes(upper)) return 'is reserved for the host and agents';
  if (DENIED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix)))
    return 'belongs to an agent, Git, a package manager, a loader or a cloud credential';
  if (SECRET_PART.test(upper)) return 'looks like a secret; secrets are never injected';
  if (typeof value !== 'string' || value.length > MAX_ENV_VALUE || CONTROL.test(value))
    return `must be a single-line string of at most ${MAX_ENV_VALUE} characters`;
  if (
    upper === 'NODE_OPTIONS' &&
    !value
      .trim()
      .split(/\s+/)
      .every(option => NODE_OPTION.test(option))
  )
    return 'may only contain --max-old-space-size=<MB> and --max-semi-space-size=<MB>';
  return null;
}

/**
 * The subset of env that passes the policy. Spawn sites call this even for a validated profile.
 * The host's own per-worker variables (HOST_ENV) pass when their values have the host's shape.
 */
export function safeWorkerEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const entries = Object.entries(env);
  const profile = entries.filter(([name, value]) => workerEnvRefusal(name, value) === null);
  const host = entries.filter(([name, value]) => hostEnvAllowed(name, value));
  return Object.fromEntries([...profile.slice(0, MAX_ENV_VARS), ...host]);
}

/**
 * Adds workerEnv to a copy of base. On Windows variable names are case-insensitive, so an
 * existing spelling of the same name is replaced rather than duplicated.
 */
export function withWorkerEnv(base, env, platform = process.platform) {
  const next = { ...base };
  for (const [name, value] of Object.entries(safeWorkerEnv(env))) {
    if (platform === 'win32')
      for (const key of Object.keys(next)) if (key.toUpperCase() === name.toUpperCase()) delete next[key];
    next[name] = value;
  }
  return next;
}
