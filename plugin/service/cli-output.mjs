// Runs the Backlog CLI with its output captured completely (SF-28).
//
// On Linux the pinned fork CLI sets its inherited stdout non-blocking, so when the reader of a
// pipe is slower than the writer, output beyond the pipe's 64 KiB is lost when the CLI exits. A
// regular file never blocks. So outside Windows these helpers give the CLI (and the node launcher
// in front of it, whose stdio the native CLI inherits) temporary files as stdout and stderr, and
// read them after it exits. On Windows they are the plain child_process calls, unchanged.
//
// They replace spawnSync, execFileSync and promisified execFile for one-shot commands only: an
// MCP or bridge session talks over its pipes while the CLI runs, and it reads each reply before
// the CLI exits, so it keeps its pipes.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const capturesToFile = (platform = process.platform) => platform !== 'win32';

function outputFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switchflow-cli-'));
  const names = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const descriptors = names.map(name => fs.openSync(name, 'w', 0o600));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const descriptor of descriptors) fs.closeSync(descriptor);
  };
  return {
    descriptors,
    close,
    read(encoding) {
      close();
      return names.map(name => {
        const bytes = fs.readFileSync(name);
        return encoding && encoding !== 'buffer' ? bytes.toString(encoding) : bytes;
      });
    },
    remove() {
      close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const tooLarge = (stdout, stderr, maxBuffer) =>
  Number.isFinite(maxBuffer) && Math.max(Buffer.byteLength(stdout), Buffer.byteLength(stderr)) > maxBuffer;
const failure = (command, args, { status, signal, stdout, stderr }) =>
  Object.assign(new Error(`Command failed: ${[command, ...args].join(' ')}\n${stderr}`), {
    status,
    signal,
    stdout,
    stderr,
  });

/** spawnSync, with stdout and stderr through files outside Windows. */
export function spawnCliSync(command, args, options = {}, { platform = process.platform } = {}) {
  if (!capturesToFile(platform)) return spawnSync(command, args, options);
  const { encoding, maxBuffer = 1024 * 1024, stdio, ...rest } = options;
  const files = outputFiles();
  try {
    const stdin = Array.isArray(stdio) ? stdio[0] : (stdio ?? 'pipe');
    const result = spawnSync(command, args, { ...rest, stdio: [stdin, ...files.descriptors] });
    const [stdout, stderr] = files.read(encoding);
    const error =
      result.error ??
      (tooLarge(stdout, stderr, maxBuffer)
        ? Object.assign(new Error(`spawnSync ${command} ENOBUFS`), { code: 'ENOBUFS' })
        : undefined);
    return { ...result, output: [null, stdout, stderr], stdout, stderr, ...(error ? { error } : {}) };
  } finally {
    files.remove();
  }
}

/** execFileSync, with stdout and stderr through files outside Windows. */
export function execCliSync(command, args, options = {}, { platform = process.platform } = {}) {
  if (!capturesToFile(platform)) return execFileSync(command, args, options);
  const result = spawnCliSync(command, args, options, { platform });
  // Like execFileSync, stderr goes to this process's stderr unless stdio was chosen.
  if (options.stdio === undefined && result.stderr.length) process.stderr.write(result.stderr);
  if (result.error) throw Object.assign(result.error, { stdout: result.stdout, stderr: result.stderr });
  if (result.status !== 0) throw failure(command, args, result);
  return result.stdout;
}

/** promisify(execFile), with stdout and stderr through files outside Windows. */
export function execCli(command, args, options = {}, { platform = process.platform } = {}) {
  if (!capturesToFile(platform)) return promisify(execFile)(command, args, options);
  const { encoding = 'utf8', maxBuffer = 1024 * 1024, ...rest } = options;
  return new Promise((resolve, reject) => {
    const files = outputFiles();
    let child;
    try {
      child = spawn(command, args, { ...rest, stdio: ['ignore', ...files.descriptors] });
    } catch (error) {
      files.remove();
      throw error;
    }
    // The child has its own copies of the descriptors.
    files.close();
    let spawnError = null;
    child.once('error', error => (spawnError = error));
    child.once('close', (code, signal) => {
      let stdout;
      let stderr;
      try {
        [stdout, stderr] = files.read(encoding);
      } catch (error) {
        return reject(error);
      } finally {
        files.remove();
      }
      if (spawnError) return reject(Object.assign(spawnError, { stdout, stderr }));
      if (tooLarge(stdout, stderr, maxBuffer))
        return reject(
          Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }),
        );
      if (code !== 0 || signal)
        return reject(
          Object.assign(failure(command, args, { status: code, signal, stdout, stderr }), {
            code,
            killed: child.killed,
          }),
        );
      resolve({ stdout, stderr });
    });
  });
}

// node cli-output.mjs <cli.cjs> <args…>: runs the CLI for backlog.ps1 with output files on any
// platform (the script calls it only outside Windows) and copies the complete output to this
// process's own stdout and stderr, which Node writes in full.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cliPath, ...args] = process.argv.slice(2);
  const result = spawnCliSync(
    process.execPath,
    [cliPath, ...args],
    { stdio: ['inherit'], maxBuffer: Infinity },
    { platform: 'linux' },
  );
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  }
}
