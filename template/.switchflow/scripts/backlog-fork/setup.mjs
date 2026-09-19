import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { directory, forkPaths, resolveBacklogFork, sha256, launcherFiles, forkIdentity } from './runtime.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--cache')) throw new Error('Usage: node setup.mjs [--cache <external directory>]');
const location = await forkPaths(args[1]);
try { await resolveBacklogFork({ cache: args[1] }); console.log(JSON.stringify(location)); process.exit(0); } catch {}
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const platform = manifest.bun.platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`No pinned Bun toolchain for ${process.platform}-${process.arch}`);
await fs.mkdir(location.root, { recursive: true });
// An interrupted build leaves an explicit lock for inspection; never delete an unknown process's build.
const lockPath = path.join(location.root, 'setup.lock');
const lock = await fs.open(lockPath, 'wx');
const run = (command, argv, cwd, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, argv, { cwd, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
async function download(url, destination, algorithm, expected, encoding = 'hex') {
  const response = await fetch(url); if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash(algorithm).update(bytes).digest(encoding) !== expected) throw new Error(`Integrity mismatch: ${url}`);
  await fs.writeFile(destination, bytes);
}
try {
  const source = path.join(location.root, 'source'); const toolchain = path.join(location.root, 'toolchain');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(toolchain, { recursive: true });
  const sourceArchive = path.join(location.root, 'source.tar.gz'); const bunArchive = path.join(location.root, 'bun.tgz');
  await download(manifest.source.url, sourceArchive, 'sha256', manifest.source.sha256);
  await download(platform.url, bunArchive, 'sha512', platform.integrity.slice('sha512-'.length), 'base64');
  await run('tar', ['-xzf', sourceArchive, '--strip-components=1', '--exclude=*/.claude/skills', '--exclude=*/CLAUDE.md', '--exclude=*/src/guidelines/project-manager-backlog.md', '-C', source], location.root);
  // Materialize the build's one required upstream symlink without Windows symlink privileges.
  await fs.copyFile(path.join(source, '.claude', 'agents', 'project-manager-backlog.md'), path.join(source, 'src', 'guidelines', 'project-manager-backlog.md'));
  await run('tar', ['-xzf', bunArchive, '--strip-components=1', '-C', toolchain], location.root);
  // Git checkout line endings may differ from the pinned source archive. Normalize
  // only patch transport CRLF, exactly as identity inputs are normalized.
  const patchFile = path.join(location.root, 'backlog-cas.patch');
  await fs.writeFile(patchFile, (await fs.readFile(path.join(directory, 'backlog-cas.patch'), 'utf8')).replaceAll('\r\n', '\n'));
  await run('git', ['apply', '--check', patchFile], source);
  await run('git', ['apply', patchFile], source);
  const bun = path.join(toolchain, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const env = { BUN_INSTALL_CACHE_DIR: path.join(location.root, 'dependency-cache'), BACKLOG_BUILD_VERSION: manifest.version, BACKLOG_BUILD_OUTFILE: location.executable };
  await run(bun, ['install', '--frozen-lockfile', '--ignore-scripts'], source, env);
  await run(bun, ['scripts/build.ts'], source, env);
  await run(location.executable, ['--version'], location.root);
  for (const [file, contents] of Object.entries(launcherFiles(location))) await fs.writeFile(path.join(location.root, file), contents);
  if (await forkIdentity() !== location.identity) throw new Error('Fork inputs changed during setup; rerun setup for the new version.');
  await fs.writeFile(path.join(location.root, 'receipt.json'), JSON.stringify({ identity: location.identity, version: manifest.version, executableSha256: sha256(await fs.readFile(location.executable)), builtAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(location));
} finally { await lock.close(); await fs.unlink(lockPath); }
