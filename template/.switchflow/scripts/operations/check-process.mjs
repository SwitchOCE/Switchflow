import { spawn } from 'node:child_process';

// Stop the owned check tree so inherited stdout/stderr cannot keep its receipt open.
export function stopCheckTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return;
  }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
  killer.once('error', () => child.kill());
  killer.once('close', code => { if (code !== 0) child.kill(); });
}
