import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const hookNames = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'];

export function safeGitEnvironment() {
  // Routing and command environment must never redirect host operations out of the verified checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };
}

export function createSafeGit(commonDir, forbiddenRoots = []) {
  let executable;
  async function gitExecutable() {
    if (executable) return executable;
    // Do not let Windows resolve a candidate-controlled git.exe in the command cwd.
    const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
    for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, executableName);
      try {
        if ((await fs.stat(candidate)).isFile()) {
          const real = await fs.realpath(candidate);
          const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
          if (forbiddenRoots.some(root => normalize(real) === normalize(root) || normalize(real).startsWith(normalize(root) + path.sep))) continue;
          executable = real; return executable;
        }
      }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    throw new Error('Git executable was not found in an absolute host PATH entry');
  }
  async function raw(cwd, args, { harden = false, filterGuards = [], buffer = false, maxBuffer = 1024 * 1024 } = {}) {
    // Configuration discovery itself does not run hooks, filters, signing, or filesystem monitors.
    const hooksSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const safeguards = harden ? ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${hooksSink}`, '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...filterGuards] : [];
    try {
      const platformConfig = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
      const { stdout } = await execute(await gitExecutable(), ['-C', cwd, '--no-pager', '--literal-pathspecs', ...platformConfig, '-c', `safe.directory=${await fs.realpath(cwd)}`, ...safeguards, ...args], {
        encoding: buffer ? 'buffer' : 'utf8', maxBuffer, windowsHide: true, shell: false, env: safeGitEnvironment(),
      });
      return buffer || args.includes('-z') || args.includes('--null') ? stdout : stdout.trim();
    } catch (error) {
      const failure = new Error(`Git ${args[0]} failed: ${String([error.stderr, error.stdout].filter(Boolean).join('\n') || error.message).slice(0, 8000)}`);
      failure.uncertain = Boolean(error.killed || error.signal || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      throw failure;
    }
  }
  return async (cwd, args, output = {}) => {
    if (Object.keys(output).length && (output.buffer !== true || Object.keys(output).some(key => !['buffer', 'maxBuffer'].includes(key)) || !Number.isSafeInteger(output.maxBuffer) || output.maxBuffer < 1 || output.maxBuffer > 128 * 1024 + 1 || args.length !== 3 || args[0] !== 'cat-file' || args[1] !== 'blob' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(args[2]))) throw new Error('Binary Git output is restricted to bounded immutable blob reads');
    const config = await raw(cwd, ['config', '--null', '--list', '--includes']);
    const originalEntries = config.split('\0').filter(Boolean).map(record => {
      const split = record.indexOf('\n'); return [record.slice(0, split), record.slice(split + 1)];
    });
    const entries = config.split('\0').filter(Boolean).map(record => {
      const split = record.indexOf('\n'); return [record.slice(0, split).toLowerCase(), record.slice(split + 1)];
    });
    const effective = new Map(entries);
    for (const [key, value] of entries) {
      if (key === 'include.path' || /^includeif\..*\.path$/.test(key)) throw new Error('Host Git bridge refuses included config files whose executable helpers could change between validation and use');
      const helper = args[0] === 'merge' && (/^merge\..*\.driver$/.test(key) || /^branch\..*\.mergeoptions$/.test(key));
      const enabledSigning = /^(commit|merge|tag)\.gpgsign$/.test(key) && !/^(false|no|off|0)$/i.test(value);
      const enabledVerification = key === 'merge.verifysignatures' && !/^(false|no|off|0)$/i.test(value);
      if (helper || enabledSigning || enabledVerification || (key === 'core.fsmonitor' && !/^(false|no|off|0)$/i.test(value))) throw new Error(`Host Git bridge refuses configured executable helper or signing policy: ${key}. Run required checks in the sandbox and resolve this policy explicitly; they were not skipped.`);
    }
    const hooksRoot = effective.has('core.hookspath') ? path.resolve(cwd, await raw(cwd, ['config', '--path', '--get', 'core.hooksPath'])) : path.join(commonDir, 'hooks');
    for (const name of hookNames) {
      try { await fs.lstat(path.join(hooksRoot, name)); throw new Error(`Host Git bridge refuses configured Git hook: ${name}. Required project hooks must not run outside the sandbox or be silently skipped.`); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    // Dormant drivers (including Git for Windows' default LFS configuration) do not
    // block unrelated work. If attributes select a filter, required=true and empty
    // commands fail closed without executing the host driver or changing content.
    const filterNames = new Set(originalEntries.map(([key]) => /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key)?.[1]).filter(Boolean));
    const filterGuards = [...filterNames].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=true`]);
    const safeArgs = args[0] === 'diff' ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
    return raw(cwd, safeArgs, { harden: true, filterGuards, ...output });
  };
}
