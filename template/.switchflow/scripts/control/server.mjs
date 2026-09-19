import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveProject, readState, updateState, withLock, assertSafePath } from '../operations/storage.mjs';
import { recordIssue, listIssues, issueMetrics } from '../operations/issues.mjs';
import { inspectWorktrees, planRetention } from '../operations/workspaces.mjs';
import { ControlEngine } from './engine.mjs';
import { ControlError } from './lifecycle.mjs';
import { createBacklogAdapter } from './backlog-adapter.mjs';
import { startCodexRun, isRunProcessAlive } from './codex-runner.mjs';
import * as protocol from './agent-protocol.mjs';
import { previewUatArtifact } from './artifacts.mjs';

const exec = promisify(execFile);
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const MAX_BODY = 512 * 1024;
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ControlError('JSON content type required.', 415);
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > MAX_BODY) throw new ControlError('Request is too large.', 413); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks)); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new ControlError('A JSON object is required.'); }
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

export async function createControlServer({ projectRoot, context: suppliedContext, port = 0, runner = startCodexRun, agentProtocol = protocol, backlog, capabilities: suppliedCapabilities } = {}) {
  const context = suppliedContext || await resolveProject(projectRoot);
  const adapter = backlog || createBacklogAdapter(context);
  const csrfToken = randomBytes(32).toString('hex');
  let projectConfig = {};
  try { projectConfig = JSON.parse(await fs.readFile(path.join(context.sourceRoot, '.switchflow', 'project.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const capabilities = suppliedCapabilities || await exec('codex', ['--version'], { windowsHide: true, timeout: 8000 }).then(r => ({ codex: true, version: r.stdout.trim(), authentication: 'Checked when a run starts.', diagnostic: r.stderr.trim() })).catch(error => ({ codex: false, diagnostic: error.message }));
  const engine = new ControlEngine(context, {
    runner, protocol: agentProtocol,
    recordIssue: issue => recordIssue(context, { kind: ({ intervention: 'update', blocker: 'issue' })[issue.type] || issue.type, summary: issue.summary, phase: issue.initiativeId, taskId: issue.runId || null }),
  });
  await engine.recover();
  let baseUrl;
  let taskCache = { at: 0, tasks: [], error: null };
  const tasks = async () => {
    if (Date.now() - taskCache.at < 2000) return taskCache;
    try { taskCache = { at: Date.now(), tasks: await adapter.list(), error: null }; }
    catch (error) { taskCache = { at: Date.now(), tasks: [], error: error.message }; }
    return taskCache;
  };
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const allowedHosts = new Set([new URL(baseUrl).host, `localhost:${server.address().port}`]);
      if (!allowedHosts.has(req.headers.host)) throw new ControlError('Unrecognized Host.', 403);
      const origin = req.headers.origin;
      if (origin && origin !== baseUrl && origin !== `http://localhost:${server.address().port}`) throw new ControlError('Cross-origin access denied.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new ControlError('Cross-site access denied.', 403);
      const url = new URL(req.url, baseUrl);
      if (['POST', 'PATCH'].includes(req.method)) {
        const token = req.headers['x-switchflow-token'];
        if (typeof token !== 'string' || token.length !== csrfToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) throw new ControlError('Reload this board before submitting changes.', 403);
      }
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await fs.readFile(path.join(publicRoot, file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { service: 'switchflow-control', projectId: context.id, projectRoot: context.sourceRoot, pid: process.pid });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const [state, board] = await Promise.all([engine.read(), tasks()]);
        return json(res, 200, { ...state, csrfToken, project: { name: projectConfig.projectName || path.basename(context.sourceRoot), root: context.sourceRoot, governanceRoot: context.governanceRoot, backlogUrl: null }, capabilities, tasks: board.tasks, boardError: board.error, serviceError: engine.lastError || null });
      }
      if (req.method === 'GET' && url.pathname === '/api/operations') {
        const [issues, metrics, worktrees, retention] = await Promise.all([listIssues(context), issueMetrics(context), inspectWorktrees(context), planRetention(context)]);
        return json(res, 200, { issues, metrics, worktrees, retention });
      }
      if (req.method === 'POST' && url.pathname === '/api/initiatives') {
        const input = await body(req);
        const state = await engine.create(input); return json(res, 201, { initiative: state.initiatives.at(-1) });
      }
      const action = /^\/api\/initiatives\/([a-f0-9-]{36})\/actions$/.exec(url.pathname);
      const artifact = /^\/api\/initiatives\/([a-f0-9-]{36})\/artifacts$/.exec(url.pathname);
      if (req.method === 'GET' && artifact) {
        const snapshot = await engine.read();
        const index = url.searchParams.get('index');
        if (!/^\d+$/.test(index || '') || [...url.searchParams.keys()].some(key => !['stepId', 'index'].includes(key))) throw new ControlError('Invalid UAT reference.');
        return json(res, 200, await previewUatArtifact(context, snapshot.initiatives.find(item => item.id === artifact[1]), { stepId: url.searchParams.get('stepId'), index: Number(index) }));
      }
      if (req.method === 'POST' && action) {
        const state = await engine.action(action[1], await body(req));
        return json(res, 200, { initiative: state.initiatives.find(i => i.id === action[1]) });
      }
      const task = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && task) return json(res, 200, { task: await adapter.view(decodeURIComponent(task[1])) });
      if (req.method === 'PATCH' && task) {
        const input = await body(req);
        // Serialize against run admission so agents cannot start while a human edit is being applied.
        let changed;
        await engine.mutate(async state => {
          if (state.activeRun || state.initiatives.some(i => i.pending)) throw new ControlError('Pause active delivery with a scope change before editing task instructions.', 409);
          changed = await adapter.edit(decodeURIComponent(task[1]), input);
        });
        taskCache.at = 0; return json(res, 200, { task: changed });
      }
      throw new ControlError('Route not found.', 404);
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 40000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  engine.schedule();
  return { server, engine, context, url: baseUrl, async close() { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--project', '--port'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: server.mjs --project <checkout> [--port <port>]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const context = await resolveProject(options.project || process.cwd());
  const lockPath = await assertSafePath(context.stateDir, path.join(context.stateDir, 'service.lock'));
  await withLock(context, 'service-recovery', async () => {
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && !isRunProcessAlive(owner.pid)) await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, { timeoutMs: 1000 });
  await withLock(context, 'service', async () => {
    const app = await createControlServer({ context, port });
    await updateState(context, 'service-info', () => ({ pid: process.pid, url: app.url, projectId: context.id, sourceRoot: context.sourceRoot, startedAt: new Date().toISOString() }));
    console.log(`Switchflow: ${app.url}`);
    await new Promise(resolve => {
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await app.close(); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  }, { timeoutMs: 1000 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
