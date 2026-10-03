import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import { stopTree } from '../codex-runner.mjs';
import { claudeProjectFolder } from '../providers/claude-cli.mjs';

/**
 * A Linux box reached over ssh (home server, VPS, WSL). The same CLIs Switchflow drives locally
 * run there over ssh stdio, so streaming, steering, interrupt and follow-ups all work.
 *
 * Workspace: a bare mirror under workRoot that the local candidate pushes its branch to, a remote
 * worktree per worker, and the result fetched back into the local candidate with a fast-forward.
 * No GitHub or other shared remote is needed.
 *
 * Remote commands are built as argv and single-quoted word by word; nothing from a task or a model
 * reaches the remote shell unquoted. Each agent CLI runs under a small wrapper that starts it in
 * its own session (setsid) and records its PID, so close and restart recovery can kill the whole
 * remote process group over a second connection.
 */
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const POSIX_ROOT = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const WAKE_WORD = /^[A-Za-z0-9._:\\/=-]{1,200}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RECOVERY_REF = /^refs\/switchflow\/recovery\/[A-Za-z0-9._-]{1,100}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Never forwarded: these describe this PC, not the box. */
const LOCAL_ONLY = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PWD',
  'SHELL',
  'USER',
  'LOGNAME',
]);
const CONFIG_KEYS = [
  'id',
  'kind',
  'label',
  'enabled',
  'host',
  'port',
  'user',
  'identityFile',
  'workRoot',
  'wake',
  'keepAwake',
  'maxWorkers',
];
export const DEFAULT_MAX_WORKERS = 2;
const CONNECT_TIMEOUT_SECONDS = 10;
const PID_MARK = 'SWITCHFLOW_REMOTE_PID ';

/** POSIX single-quote escaping: the result is one shell word whatever the input. */
export const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
/** One remote command line from argv. ssh joins its arguments with spaces, so quote here. */
export const remoteCommand = argv => argv.map(shellQuote).join(' ');

/** Splits an owner-typed wake command on spaces. No shell, no quoting: plain words only. */
export function parseWake(value, field = 'wake', example = 'wsl.exe -d Ubuntu -- true') {
  if (value === undefined || value === null || value === '') return null;
  const words = Array.isArray(value) ? value : String(value).trim().split(/\s+/);
  if (!words.length || words.length > 20 || words.some(word => typeof word !== 'string' || !WAKE_WORD.test(word)))
    throw new Error(`${field} must be a plain command such as "${example}" (no quotes or shell syntax).`);
  return words;
}

export function validateSshConfig(config) {
  const extra = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key));
  if (extra.length)
    throw new Error(`Unsupported SSH environment fields: ${extra.join(', ')}. Secrets are never stored inline.`);
  const { host, user, identityFile, workRoot } = config;
  const port = config.port ?? 22;
  if (typeof host !== 'string' || !HOST.test(host)) throw new Error('host must be a host name or IPv4 address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535.');
  if (typeof user !== 'string' || !USER.test(user)) throw new Error('user must be a plain Linux user name.');
  if (typeof identityFile !== 'string' || !path.isAbsolute(identityFile) || /["\r\n]/.test(identityFile))
    throw new Error('identityFile must be an absolute path to a private key file.');
  let isFile = false;
  try {
    isFile = statSync(identityFile).isFile();
  } catch {}
  if (!isFile) throw new Error('identityFile does not exist or is not a file.');
  if (typeof workRoot !== 'string' || !POSIX_ROOT.test(workRoot) || workRoot.split('/').some(part => part === '..'))
    throw new Error('workRoot must be an absolute Linux path of plain names, such as /home/me/switchflow.');
  const wake = parseWake(config.wake);
  // WSL stops a distro with no wsl.exe client attached, even with ssh sessions open: a long-running
  // local command (for example "wsl.exe -d Ubuntu -- sleep infinity") holds it up while agents run.
  const keepAwake = parseWake(config.keepAwake, 'keepAwake', 'wsl.exe -d Ubuntu -- sleep infinity');
  // Workers running on the box at once (they skip this PC's memory admission and worker limit).
  const maxWorkers = config.maxWorkers ?? DEFAULT_MAX_WORKERS;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16) throw new Error('maxWorkers must be 1–16.');
  return {
    host,
    port,
    user,
    identityFile,
    workRoot,
    ...(wake ? { wake } : {}),
    ...(keepAwake ? { keepAwake } : {}),
    ...(config.maxWorkers !== undefined ? { maxWorkers } : {}),
  };
}

export function defaultSshExecutable(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'ssh';
  const system = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  return existsSync(system) ? system : 'ssh.exe';
}

const forward = file => file.replaceAll('\\', '/');

/** ssh options. -F none keeps the user's ssh config (ProxyCommand, aliases) out of it. */
export function sshOptions({ identityFile, knownHostsPath }) {
  return [
    '-F',
    'none',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile="${forward(knownHostsPath)}"`,
    '-o',
    'GlobalKnownHostsFile=none',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `IdentityFile="${forward(identityFile)}"`,
    '-o',
    'LogLevel=ERROR',
  ];
}

export function sshArguments(config, knownHostsPath, remote) {
  return [
    ...sshOptions({ identityFile: config.identityFile, knownHostsPath }),
    '-T',
    '-p',
    String(config.port),
    '-l',
    config.user,
    '--',
    config.host,
    remote,
  ];
}

/**
 * Runs the agent in its own session so its whole process group can be signalled, keeps stdin
 * attached (an asynchronous list would otherwise read /dev/null), records the PID in a file and
 * on stderr, and forwards HUP/TERM to the group.
 */
export const WRAPPER = [
  'p=$1; d=$2; shift 2',
  'mkdir -p "${p%/*}" && cd "$d" || exit 97',
  'exec 3<&0',
  'setsid "$@" 0<&3 3<&- & c=$!',
  'exec 3<&-',
  'echo "$c" > "$p"',
  `echo "${PID_MARK}$c" >&2`,
  "trap 'kill -TERM -- -$c 2>/dev/null' HUP TERM",
  'wait $c; s=$?',
  'rm -f "$p"',
  'exit $s',
].join('; ');

/** Variables the provider added or changed for the agent; the service's own environment stays home. */
export function remoteEnvironment(env = {}, base = process.env) {
  const pairs = [];
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || LOCAL_ONLY.has(name) || typeof value !== 'string') continue;
    if (base[name] === value) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs;
}

/** Removes the wrapper's PID line from stderr and reports the PID. */
function pidFilter(source, onPid) {
  const output = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const flush = final => {
    let index;
    while ((index = buffer.indexOf('\n')) !== -1 || (final && buffer)) {
      const end = index === -1 ? buffer.length : index + 1;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end);
      if (line.startsWith(PID_MARK)) {
        const pid = Number(line.slice(PID_MARK.length).trim());
        if (Number.isSafeInteger(pid) && pid > 1) onPid(pid);
      } else output.write(line);
    }
  };
  source.on('data', chunk => {
    buffer += decoder.write(chunk);
    flush(false);
  });
  source.on('end', () => {
    buffer += decoder.end();
    flush(true);
    output.end();
  });
  source.on('error', error => output.destroy(error));
  return output;
}

function run(spawnProcess, executable, args, { input, timeoutMs = 60000, env } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnProcess(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${Math.round(timeoutMs / 1000)} s.`.trim() });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', error => done({ code: -1, stdout, stderr: error.message }));
    child.once('close', code => done({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const firstLine = text =>
  String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';

const HEALTH_SCRIPT = [
  'v() { "$@" 2>/dev/null | head -n 1; }',
  'printf "git=%s\\n" "$(v git --version)"',
  'printf "node=%s\\n" "$(v node --version)"',
  'printf "setsid=%s\\n" "$(command -v setsid)"',
  'printf "codex=%s\\n" "$(v codex --version)"',
  'if codex login status >/dev/null 2>&1; then echo codexLogin=yes; else echo codexLogin=no; fi',
  'printf "claude=%s\\n" "$(v claude --version)"',
  'printf "claudeAuth=%s\\n" "$(claude auth status 2>/dev/null | tr -d "\\n")"',
  'if mkdir -p "$1" && test -w "$1"; then echo workRoot=ok; else echo workRoot=no; fi',
].join('; ');

/**
 * $1 worktree, $2 workspace name, $3 message, $4/$5 author, $6 "commit" or "check". Commits all
 * uncommitted changes (a detached HEAD mid-rebase too) and pins HEAD at
 * refs/switchflow/recovery/<name> in the mirror, so the host can fetch it.
 */
const RECOVER_SCRIPT = [
  'set -e; w=$1',
  'if [ ! -d "$w" ]; then echo state=missing; exit 0; fi',
  'if [ "$6" = commit ]; then git -C "$w" add -A',
  'if git -C "$w" diff --cached --quiet; then echo changed=no; else git -C "$w" -c user.name="$4" -c user.email="$5" commit -q --no-verify -m "$3"; echo changed=yes; fi',
  'git -C "$w" update-ref "refs/switchflow/recovery/$2" HEAD; fi',
  'h=$(git -C "$w" rev-parse HEAD); echo "head=$h"',
].join('; ');

/**
 * $1 worktree, $2 its Claude projects folder name (claudeProjectFolder). Removes that one folder
 * unless a conversation in it ran outside the worktree: two paths can share a folder name, so
 * the recorded "cwd" values decide, and any other value keeps the folder.
 */
const TRANSCRIPT_SCRIPT = [
  'w=$1; d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$2"',
  '[ -d "$d" ] || exit 0',
  `cwds=$(cat "$d"/*.jsonl 2>/dev/null | grep -o '"cwd":"[^"]*"' | sed 's/^"cwd":"//; s/"$//' | sort -u)`,
  'set -f',
  'for c in $cwds; do case "$c" in "$w"|"$w"/*) ;; *) echo kept=foreign; exit 0;; esac; done',
  'rm -rf -- "$d" && echo removed=yes',
].join('\n');

export function parseHealth(stdout) {
  const values = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  let claudeLoggedIn = false;
  try {
    claudeLoggedIn = JSON.parse(values.claudeAuth || '{}').loggedIn === true;
  } catch {}
  const providers = {
    codex: values.codex
      ? { available: true, version: values.codex, loggedIn: values.codexLogin === 'yes', transport: 'app-server' }
      : { available: false, diagnostic: 'codex is not installed on the box' },
    claude: values.claude
      ? {
          available: true,
          version: values.claude.replace(/\s*\(Claude Code\)$/, ''),
          loggedIn: claudeLoggedIn,
          transport: 'cli',
        }
      : { available: false, loggedIn: false, diagnostic: 'claude is not installed on the box' },
  };
  // A Codex that is installed but signed out cannot run either.
  if (providers.codex.available && !providers.codex.loggedIn) providers.codex.available = false;
  const missing = [];
  if (!values.git) missing.push('git');
  if (!values.setsid) missing.push('setsid');
  if (values.workRoot !== 'ok') missing.push('a writable work root');
  if (!providers.codex.available && !(providers.claude.available && providers.claude.loggedIn))
    missing.push('a signed-in codex or claude');
  return {
    ok: missing.length === 0,
    reason: missing.length ? `The box is missing ${missing.join(', ')}.` : null,
    providers,
    versions: { git: values.git || null, node: values.node || null },
  };
}

export function createSshEnvironment(
  config,
  { stateDir, spawnProcess = spawn, sshExecutable = defaultSshExecutable(), gitExecutable = 'git' } = {},
) {
  if (!stateDir) throw new Error('An SSH environment needs the service state directory.');
  const directory = path.join(stateDir, 'environments');
  const knownHostsPath = path.join(directory, `${config.id}.known_hosts`);
  const mirror = `${config.workRoot}/mirror.git`;
  const mirrorUrl = `ssh://${config.user}@${config.host}:${config.port}${mirror}`;
  const ensureDirectory = () => fs.mkdir(directory, { recursive: true });
  const ssh = async (argv, options = {}) => {
    await ensureDirectory();
    return run(spawnProcess, sshExecutable, sshArguments(config, knownHostsPath, remoteCommand(argv)), options);
  };
  const script = (body, ...args) => ssh(['sh', '-c', body, 'switchflow', ...args]);
  const must = async (promise, what) => {
    const result = await promise;
    if (result.code !== 0)
      throw new Error(
        `${what} failed on ${config.label ?? config.id}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
      );
    return result;
  };
  // git runs the ssh command through its own sh; every word is single-quoted.
  const gitSsh = remoteCommand([
    forward(sshExecutable),
    ...sshOptions({ identityFile: config.identityFile, knownHostsPath }),
  ]);
  const git = async (cwd, args, what) => {
    await ensureDirectory();
    return must(
      run(spawnProcess, gitExecutable, ['-C', cwd, ...args], {
        env: { ...process.env, GIT_SSH_COMMAND: gitSsh, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 300000,
      }),
      what,
    );
  };
  let wakeRun = null;
  const wake = async () => {
    if (!config.wake) return;
    // One wake at a time; WSL keeps the distro up while connections are open.
    wakeRun ??= run(spawnProcess, config.wake[0], config.wake.slice(1), { timeoutMs: 90000 }).finally(() => {
      wakeRun = null;
    });
    const result = await wakeRun;
    if (result.code !== 0)
      throw new Error(`The wake command failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
  };
  // keepAwake runs while any agent process is open on the box, and stops with the last one.
  let holders = 0;
  let keeper = null;
  const hold = () => {
    holders++;
    if (!config.keepAwake || keeper) return;
    try {
      const started = spawnProcess(config.keepAwake[0], config.keepAwake.slice(1), {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      keeper = started;
      started.once('error', () => {});
      // An older keeper that exits late must not forget the current one.
      started.once('close', () => {
        if (keeper === started) keeper = null;
      });
    } catch {
      keeper = null;
    }
  };
  const release = () => {
    holders = Math.max(0, holders - 1);
    if (holders === 0 && keeper) {
      // wsl.exe starts a child wsl.exe; stop the whole tree this environment started.
      void stopTree(keeper);
      keeper = null;
    }
  };
  const killRemote = async pid => {
    if (!Number.isSafeInteger(pid) || pid < 2) return;
    await script('kill -TERM -- "-$1" 2>/dev/null; sleep 2; kill -KILL -- "-$1" 2>/dev/null; true', String(pid));
  };

  // Only a worktree this environment made: <workRoot>/worktrees/<name>.
  const ownWorkspace = workspace =>
    NAME.test(String(workspace?.name)) && workspace.path === `${config.workRoot}/worktrees/${workspace.name}`;

  const environment = {
    id: config.id,
    kind: 'ssh',
    label: config.label ?? config.id,
    config,
    maxWorkers: config.maxWorkers ?? DEFAULT_MAX_WORKERS,
    capabilities: Object.freeze({
      stream: true,
      steer: true,
      interrupt: true,
      followUp: true,
      result: 'remote-branch',
    }),
    executables: { codex: 'codex', claude: 'claude' },
    knownHostsPath,
    mirrorUrl,

    async health() {
      try {
        await wake();
      } catch (error) {
        return { ok: false, reason: error.message };
      }
      const result = await script(HEALTH_SCRIPT, config.workRoot);
      if (result.code !== 0)
        return {
          ok: false,
          reason: `Cannot reach ${config.user}@${config.host}:${config.port}: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        };
      return parseHealth(result.stdout);
    },

    /**
     * Pushes the local candidate's HEAD (or `base`, a recovered commit) to the box and opens a
     * fresh remote worktree on it.
     */
    async prepareWorkspace({ repo, name, base = 'HEAD' }) {
      if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid remote workspace name');
      if (base !== 'HEAD' && !COMMIT.test(String(base))) throw new Error('Invalid workspace base commit');
      await wake();
      const branch = `switchflow/${name}`;
      const worktree = `${config.workRoot}/worktrees/${name}`;
      const temporaryRoot = `${config.workRoot}/tmp/${name}`;
      await must(
        script(
          [
            'set -e; m=$1; w=$2; t=$3',
            'mkdir -p "${m%/*}" "${w%/*}" "$t"',
            '[ -d "$m" ] || git init --bare -q "$m"',
            // A stale worktree on this branch would refuse the push.
            'if [ -e "$w" ]; then git -C "$m" worktree remove --force "$w" 2>/dev/null || rm -rf "$w"; fi',
            'git -C "$m" worktree prune',
          ].join('; '),
          mirror,
          worktree,
          temporaryRoot,
        ),
        'Preparing the remote mirror',
      );
      await git(repo, ['push', '-q', '--force', mirrorUrl, `${base}:refs/heads/${branch}`], 'Pushing the task branch');
      await must(
        script('set -e; git -C "$1" worktree add -q "$2" "$3"', mirror, worktree, branch),
        'Creating the remote worktree',
      );
      return { path: worktree, temporaryRoot, writableRoots: [worktree], branch, name, local: false, repo };
    },

    /** child_process.spawn's shape, running the CLI on the box in the workspace. */
    spawnFor(workspace, { onRemoteProcess = () => {} } = {}) {
      return (executable, args, options = {}) => {
        if (typeof executable !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(executable))
          throw new Error('Invalid remote executable');
        const pidFile = `${config.workRoot}/run/${workspace.name}-${randomBytes(6).toString('hex')}.pid`;
        const remote = remoteCommand([
          'sh',
          '-c',
          WRAPPER,
          'switchflow',
          pidFile,
          workspace.path,
          'env',
          ...remoteEnvironment(options.env),
          executable,
          ...args,
        ]);
        const child = spawnProcess(sshExecutable, sshArguments(config, knownHostsPath, remote), {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.remotePid = null;
        child.environmentId = config.id;
        hold();
        let released = false;
        const done = () => {
          if (released) return;
          released = true;
          release();
        };
        child.once('close', done);
        child.once('error', done);
        const stderr = pidFilter(child.stderr, pid => {
          child.remotePid = pid;
          Promise.resolve(onRemoteProcess(pid)).catch(() => {});
        });
        Object.defineProperty(child, 'stderr', { value: stderr, configurable: true });
        // Called by stopTree(): the remote group first, then the local ssh client.
        child.stopTree = async () => {
          if (child.remotePid) await killRemote(child.remotePid).catch(() => {});
          if (child.exitCode === null && child.signalCode === null) child.kill();
        };
        return child;
      };
    },
    killRemote,
    /** Stops the keepAwake command if this environment started it. */
    close() {
      holders = 0;
      release();
    },

    /**
     * Commits whatever the worker changed on the box (the host commits, not the worker) and
     * fast-forwards the local candidate to it. A candidate that moved meanwhile is reported, not
     * overwritten.
     */
    async collect(workspace, { into, message, author = {} }) {
      await wake();
      const name = author.name || 'Switchflow';
      const email = author.email || 'switchflow@localhost';
      const result = await must(
        script(
          [
            'set -e; w=$1',
            'git -C "$w" add -A',
            'if ! git -C "$w" diff --cached --quiet; then git -C "$w" -c user.name="$3" -c user.email="$4" commit -q -m "$2"; fi',
            'git -C "$w" rev-parse HEAD',
          ].join('; '),
          workspace.path,
          String(message).slice(0, 2000),
          name,
          email,
        ),
        'Committing the remote work',
      );
      const remoteHead = firstLine(result.stdout);
      const localHead = firstLine((await git(into, ['rev-parse', 'HEAD'], 'Reading the candidate')).stdout);
      if (remoteHead === localHead) return { changed: false, head: localHead };
      await git(into, ['fetch', '-q', mirrorUrl, `refs/heads/${workspace.branch}`], 'Fetching the remote work');
      await git(into, ['merge', '--ff-only', '-q', 'FETCH_HEAD'], 'Fast-forwarding the candidate');
      return { changed: true, head: remoteHead };
    },

    /**
     * After a restart: commits whatever an interrupted worker left uncommitted in its remote
     * worktree (`commit: true`), fetches that head into the local `ref`, then removes the remote
     * worktree. Throws when the box cannot be reached or the work cannot be saved, leaving the
     * worktree in place.
     */
    async recover(workspace, { into, ref, message, commit = true, author = {} }) {
      if (!ownWorkspace(workspace)) throw new Error('Not a workspace of this environment');
      if (commit && !RECOVERY_REF.test(String(ref))) throw new Error('Invalid recovery ref');
      await wake();
      const result = await must(
        script(
          RECOVER_SCRIPT,
          workspace.path,
          workspace.name,
          String(message ?? 'Recovered uncommitted work').slice(0, 2000),
          author.name || 'Switchflow',
          author.email || 'switchflow@localhost',
          commit ? 'commit' : 'check',
        ),
        'Recovering the remote work',
      );
      const values = Object.fromEntries(
        String(result.stdout)
          .split(/\r?\n/)
          .map(line => line.trim().split('='))
          .filter(([key, value]) => key && value !== undefined),
      );
      if (values.state === 'missing') return { found: false, changed: false, head: null, ref: null };
      const head = COMMIT.test(values.head ?? '') ? values.head : null;
      if (commit) {
        if (!head) throw new Error(`Recovering the remote work failed on ${config.label ?? config.id}: no head`);
        await git(
          into,
          ['fetch', '-q', '--no-tags', mirrorUrl, `+refs/switchflow/recovery/${workspace.name}:${ref}`],
          'Fetching the recovered work',
        );
      }
      await environment.cleanup(workspace);
      return { found: true, changed: values.changed === 'yes', head, ref: commit ? ref : null };
    },

    async cleanup(workspace) {
      await wake().catch(() => {});
      await script(
        'git -C "$1" worktree remove --force "$2" 2>/dev/null || rm -rf "$2"; rm -rf "$3"; rm -f "$4"/"$5"-*.pid; git -C "$1" worktree prune; true',
        mirror,
        workspace.path,
        workspace.temporaryRoot,
        `${config.workRoot}/run`,
        workspace.name,
      );
      // Claude's saved conversations for this worktree, and nothing else (see TRANSCRIPT_SCRIPT).
      const folder = ownWorkspace(workspace) ? claudeProjectFolder(workspace.path) : null;
      if (folder) await script(TRANSCRIPT_SCRIPT, workspace.path, folder);
    },
  };
  return environment;
}
