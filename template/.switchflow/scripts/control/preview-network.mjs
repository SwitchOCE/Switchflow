import { execFile } from 'node:child_process';

// The service asks a preview to bind loopback (HOST=127.0.0.1) but cannot force it. This finds the
// TCP addresses the preview's process tree actually listens on, so the board can warn or stop it.

// One PowerShell call lists every process (for the descendant walk) and every TCP listener.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)',
  'foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate) {',
  '  $created = 0',
  '  if ($p.CreationDate) { $created = [long]($p.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds }',
  "  'P {0} {1} {2}' -f $p.ProcessId, $p.ParentProcessId, $created",
  '}',
  'foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {',
  "  'L {0} {1} {2}' -f $c.OwningProcess, $c.LocalPort, $c.LocalAddress",
  '}',
].join('\n');

function runCommand(file, args, { timeout, signal }) {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout, signal, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve(String(stdout))),
    ),
  );
}

/** True for 127.0.0.0/8 and ::1 (including IPv4-mapped loopback); wildcards and LAN addresses are not. */
export function isLoopbackAddress(address) {
  const value = String(address)
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  return /^127\.\d+\.\d+\.\d+$/.test(value) || value === '::1' || /^::ffff:127\.\d+\.\d+\.\d+$/.test(value);
}

/** `0.0.0.0:5173`, `[::]:5173`, `*:5173`. */
export function formatListener({ address, port }) {
  const host = String(address).replace(/^\[|\]$/g, '');
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** The root and every process descended from it. */
export function descendantPids(rootPid, processes) {
  const children = new Map();
  const created = new Map();
  for (const entry of processes) {
    created.set(entry.pid, entry.created || 0);
    if (entry.pid === entry.ppid) continue;
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      // Windows keeps a dead parent's ID; a "child" older than its parent belongs to an earlier process with that ID.
      if (found.has(child.pid) || (created.get(parent) && child.created && child.created < created.get(parent)))
        continue;
      found.add(child.pid);
      queue.push(child.pid);
    }
  }
  return found;
}

export function parseWindowsListing(text) {
  const processes = [];
  const listeners = [];
  for (const line of String(text).split(/\r?\n/)) {
    let match = /^P (\d+) (\d+) (-?\d+)$/.exec(line.trim());
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]) });
    else if ((match = /^L (\d+) (\d+) (\S+)$/.exec(line.trim())))
      listeners.push({ pid: Number(match[1]), port: Number(match[2]), address: match[3] });
  }
  return { processes, listeners };
}

export function parsePs(text) {
  return String(text)
    .split(/\r?\n/)
    .map(line => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid), created: 0 }));
}

const splitAddress = value => {
  const match = /^(.*):(\d+)$/.exec(value);
  // Drop an interface suffix such as `127.0.0.1%lo` or `[fe80::1%eth0]`.
  return match && { address: match[1].replace(/%[^\]]*/, ''), port: Number(match[2]) };
};

/** `lsof -F pn` output: `p<pid>` starts a process, `n<address>:<port>` names a socket. */
export function parseLsof(text) {
  const listeners = [];
  let pid = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const parts = splitAddress(line.slice(1));
      if (parts) listeners.push({ pid, ...parts });
    }
  }
  return listeners;
}

/** `ss -ltnpH` output: the fourth column is the local address; pids come from users:(...). */
export function parseSs(text) {
  const listeners = [];
  for (const line of String(text).split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const parts = columns.length >= 4 && splitAddress(columns[3]);
    if (!parts) continue;
    for (const [, pid] of line.matchAll(/pid=(\d+)/g)) listeners.push({ pid: Number(pid), ...parts });
  }
  return listeners;
}

/**
 * Lists the TCP listeners owned by `rootPid` or its descendants. Throws when they cannot be read.
 * Each call is bounded by `timeoutMs` and can be cancelled with `signal`.
 */
export async function previewListeners(
  rootPid,
  { platform = process.platform, run = runCommand, timeoutMs = 10000, signal } = {},
) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('The preview has no process ID.');
  const options = { timeout: timeoutMs, signal };
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
    const { processes, listeners } = parseWindowsListing(output);
    if (!processes.length) throw new Error('The process list was empty.');
    const tree = descendantPids(rootPid, processes);
    return listeners.filter(entry => tree.has(entry.pid));
  }
  const tree = [...descendantPids(rootPid, parsePs(await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], options)))];
  try {
    const output = await run(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', tree.join(','), '-F', 'pn'],
      options,
    ).catch(error => {
      // lsof exits 1 when none of the processes has a listening socket.
      if (error.code === 1 && !String(error.stdout || '').trim()) return '';
      throw error;
    });
    return parseLsof(output).filter(entry => tree.includes(entry.pid));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const wanted = new Set(tree);
  return parseSs(await run('ss', ['-ltnpH'], options)).filter(entry => wanted.has(entry.pid));
}
