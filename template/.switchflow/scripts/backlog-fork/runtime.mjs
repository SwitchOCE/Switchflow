import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function forkIdentity() {
  const inputs = await Promise.all(['manifest.json', 'backlog-cas.patch', 'runtime.mjs', 'setup.mjs'].map(file => fs.readFile(path.join(directory, file))));
  return sha256(inputs.map(value => value.toString('utf8').replaceAll('\r\n', '\n')).join('\0')).slice(0, 24);
}
export const defaultCache = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Switchflow', 'backlog-fork')
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'switchflow', 'backlog-fork');
export async function forkPaths(cache = process.env.SWITCHFLOW_BACKLOG_CACHE || defaultCache) {
  const identity = await forkIdentity();
  const root = path.resolve(cache, `${identity}-${process.platform}-${process.arch}`);
  return { root, identity, executable: path.join(root, process.platform === 'win32' ? 'backlog.exe' : 'backlog'), cliPath: path.join(root, 'cli.cjs') };
}
export function launcherFiles(location) {
  const executable = JSON.stringify(path.basename(location.executable));
  return {
    'cli.cjs': `const {spawnSync}=require('node:child_process');const path=require('node:path');const r=spawnSync(path.join(__dirname,${executable}),process.argv.slice(2),{stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exit(r.status??1);\n`,
    'resolveBinary.cjs': `exports.resolveBinaryPath=()=>require('node:path').join(__dirname,${executable});\n`,
  };
}
export async function resolveBacklogFork(options = {}) {
  const location = await forkPaths(options.cache);
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(location.root, 'receipt.json'), 'utf8'));
    if (receipt.identity !== location.identity || receipt.executableSha256 !== sha256(await fs.readFile(location.executable))) throw new Error('Runtime integrity mismatch');
    for (const [file, expected] of Object.entries(launcherFiles(location))) {
      if (await fs.readFile(path.join(location.root, file), 'utf8') !== expected) throw new Error(`Launcher integrity mismatch: ${file}`);
    }
    return location;
  } catch (error) {
    throw new Error(`Set up the pinned CAS runtime first: node "${path.join(directory, 'setup.mjs')}". ${error.message}`);
  }
}
