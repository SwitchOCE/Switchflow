import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateState, withLock, assertSafePath } from '../operations/storage.mjs';
import { recordIssue, listIssues, issueMetrics } from '../operations/issues.mjs';
import { inspectWorktrees, planRetention } from '../operations/workspaces.mjs';
import { ControlEngine } from './engine.mjs';
import { ControlError } from './lifecycle.mjs';
import { createBacklogAdapter } from './backlog-adapter.mjs';
import { startCodexRun, isRunProcessAlive } from './codex-runner.mjs';
import * as protocol from './agent-protocol.mjs';
import { previewUatArtifact } from './artifacts.mjs';
import { listSkills, readSkill } from './skills.mjs';
import { listDocuments, readDocument } from './documents.mjs';
import { sharedServiceContext, canonicalProject, acquireProjectService, ProjectRegistry } from './projects.mjs';
import { createNativeBacklog } from './native-backlog.mjs';

const exec = promisify(execFile);
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const staticFiles = Object.fromEntries(['index.html','app.js','styles.css','documents.js','documents.css','milestones.js','milestones.css','tasks.js','tasks-model.js','tasks-editor.js','tasks.css','initiative-tasks.js','knowledge.js','knowledge-model.js','knowledge.css','insights.js','insights.css','workspace-client.js','workspace-search.js','skills.js','skills.css'].map(file => [`/${file}`, [file, file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript']]));
staticFiles['/'] = staticFiles['/index.html'];
const MAX_BODY = 512 * 1024;
async function readBytes(req) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > MAX_BODY) throw new ControlError('Request is too large.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ControlError('JSON content type required.', 415);
  const bytes = await readBytes(req);
  try { const result = JSON.parse(bytes); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new ControlError('A JSON object is required.'); }
}
function headers(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

export async function createControlServer({ projectRoot, context: suppliedContext, port = 0, runner = startCodexRun, agentProtocol = protocol, backlog, backlogFactory = createBacklogAdapter, nativeFactory = createNativeBacklog, capabilities: suppliedCapabilities, persistProjects = false, lockProjects = false } = {}) {
  const context = suppliedContext || await canonicalProject(projectRoot);
  const sharedContext = sharedServiceContext(context);
  const registry = new ProjectRegistry(sharedContext);
  const projects = new Map();
  const unavailable = new Map();
  const csrfToken = randomBytes(32).toString('hex');
  const capabilities = suppliedCapabilities || await exec('codex', ['--version'], { windowsHide: true, timeout: 8000 }).then(r => ({ codex: true, version: r.stdout.trim(), authentication: 'Checked when a run starts.', diagnostic: r.stderr.trim() })).catch(error => ({ codex: false, diagnostic: error.message }));
  let baseUrl;
  let closed = false;
  let admission = Promise.resolve();
  const attach = async (candidate, customAdapter) => {
    if (closed) throw new ControlError('The service is stopping.', 503);
    if (projects.has(candidate.id)) return projects.get(candidate.id);
    const release = lockProjects ? await acquireProjectService(candidate) : async () => {};
    let engine;
    try {
      let projectConfig = {};
      try { projectConfig = JSON.parse(await fs.readFile(path.join(candidate.governanceRoot, '.switchflow', 'project.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const adapter = customAdapter || backlogFactory(candidate);
      engine = new ControlEngine(candidate, {
        runner, protocol: agentProtocol,
        recordIssue: issue => recordIssue(candidate, { kind: ({ intervention: 'update', blocker: 'issue' })[issue.type] || issue.type, summary: issue.summary, phase: issue.initiativeId, taskId: issue.runId || null }),
      });
      await engine.recover();
      const project = { id: candidate.id, name: projectConfig.projectName || path.basename(candidate.governanceRoot), root: candidate.sourceRoot, governanceRoot: candidate.governanceRoot, workspaceUrl: `/?project=${candidate.id}`, tasksUrl: `/?project=${candidate.id}&view=tasks` };
      const session = { context: candidate, adapter, engine, project, release, native: nativeFactory(candidate), taskCache: { at: 0, tasks: [], error: null } };
      session.tasks = async () => {
        if (Date.now() - session.taskCache.at < 2000) return session.taskCache;
        try { session.taskCache = { at: Date.now(), tasks: await adapter.list(), error: null }; }
        catch (error) { session.taskCache = { at: Date.now(), tasks: [], error: error.message }; }
        return session.taskCache;
      };
      if (persistProjects) await registry.remember(candidate, project.name);
      projects.set(candidate.id, session); unavailable.delete(candidate.id);
      if (baseUrl) engine.schedule();
      return session;
    } catch (error) { await engine?.close(); await release(); throw error; }
  };
  const register = projectPath => {
    const next = admission.then(async () => {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || projectPath.length > 4096) throw new ControlError('Enter an absolute local project folder.');
      return attach(await canonicalProject(projectPath, sharedContext));
    });
    admission = next.catch(() => {});
    return next;
  };
  const initial = await attach(context, backlog);
  if (persistProjects) {
    for (const saved of await registry.read()) {
      if (projects.has(saved.id)) continue;
      try {
        const candidate = await canonicalProject(saved.root, sharedContext);
        if (candidate.id !== saved.id) throw new Error('Repository identity changed. Add the project again after checking its location.');
        await attach(candidate);
      } catch (error) { unavailable.set(saved.id, { ...saved, available: false, error: error.message }); }
    }
  }
  const summaries = async () => [...await Promise.all([...projects.values()].map(async session => {
    try {
      const state = await session.engine.read();
      return { ...session.project, available: true, activeRun: Boolean(state.activeRun), attention: state.initiatives.filter(item => ['awaiting-human', 'failed', 'blocked', 'cancelled'].includes(item.status)).length, initiatives: state.initiatives.length };
    } catch (error) { return { ...session.project, available: false, error: error.message }; }
  })), ...unavailable.values()];
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      if (closed) throw new ControlError('The service is stopping.', 503);
      const allowedHosts = new Set([new URL(baseUrl).host, `localhost:${server.address().port}`]);
      if (!allowedHosts.has(req.headers.host)) throw new ControlError('Unrecognized Host.', 403);
      const origin = req.headers.origin;
      if (origin && origin !== baseUrl && origin !== `http://localhost:${server.address().port}`) throw new ControlError('Cross-origin access denied.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new ControlError('Cross-site access denied.', 403);
      const url = new URL(req.url, baseUrl);
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) throw new ControlError('Method not allowed.', 405);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const token = req.headers['x-switchflow-token'];
        if (typeof token !== 'string' || token.length !== csrfToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) throw new ControlError('Reload this board before submitting changes.', 403);
      }
      if (req.method === 'GET' && (url.pathname === '/control' || staticFiles[url.pathname])) {
        const [file, type] = staticFiles[url.pathname === '/control' ? '/index.html' : url.pathname];
        if (file === 'index.html' && !projects.has(url.searchParams.get('project') || context.id)) throw new ControlError('Project is unavailable. Open Switchflow from its primary checkout to reconnect it.', 404);
        const content = await fs.readFile(path.join(publicRoot, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      const previousPage = /^\/projects\/([a-f0-9]{64})\/backlog(?:\/(.*))?$/.exec(url.pathname);
      if (req.method === 'GET' && previousPage) {
        if (!projects.has(previousPage[1])) throw new ControlError('Project is unavailable.', 404);
        const [section = 'board', record] = (previousPage[2] || '').split('/');
        const views = { board: 'tasks', tasks: 'tasks', milestones: 'milestones', documentation: 'documents', decisions: 'decisions', drafts: 'drafts', statistics: 'statistics', settings: 'settings', switchflow: 'board' };
        const query = new URLSearchParams({ project: previousPage[1], view: views[section] || 'board' });
        if (record && section === 'tasks') query.set('task', record);
        if (record && ['documentation', 'decisions'].includes(section)) query.set('record', `${section === 'documentation' ? 'doc' : 'decision'}-${record.replace(/^(?:doc|decision)-/, '')}`);
        res.writeHead(302, { Location: `/?${query}` }); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { service: 'switchflow-control', apiVersion: 2, mode: 'multi-project', projectId: context.id, projectIds: [...projects.keys()], projectRoot: context.sourceRoot, pid: process.pid });
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, { csrfToken, defaultProjectId: context.id, projects: await summaries() });
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req);
        if (Object.keys(input).some(key => key !== 'projectRoot')) throw new ControlError('Only projectRoot can be supplied.');
        const session = await register(input.projectRoot);
        return json(res, 201, { project: session.project });
      }
      // Legacy URLs always target the launch project. Selection is explicit in
      // each scoped request; another browser tab cannot change its destination.
      const scoped = /^\/api\/projects\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);
      const session = scoped ? projects.get(scoped[1]) : initial;
      if (!session) throw new ControlError('Project is unavailable. Add its current folder to reconnect it.', 404);
      if (scoped) url.pathname = '/api' + scoped[2];
      const { context: selectedContext, adapter, engine, project, tasks } = session;
      const nativeApi = /^\/api\/native\/(.+)$/.exec(url.pathname);
      const nativeAsset = /^\/projects\/([a-f0-9]{64})\/backlog-assets\/(.+)$/.exec(url.pathname);
      if (nativeApi || nativeAsset) {
        // APIs must always name the project; the legacy unscoped API cannot
        // accidentally select a write destination for a native browser tab.
        if (nativeApi && !scoped) throw new ControlError('A project-scoped Backlog route is required.', 404);
        const target = nativeAsset ? projects.get(nativeAsset[1]) : session;
        if (!target) throw new ControlError('Project is unavailable.', 404);
        if (nativeAsset && !['GET', 'HEAD'].includes(req.method)) throw new ControlError('Assets are read-only.', 405);
        const route = `${nativeAsset ? '/assets/' + nativeAsset[2] : '/api/' + nativeApi[1]}${url.search}`;
        if (route.split('?')[0] === '/api/init') throw new ControlError('Initialize projects through Switchflow setup before registering them.', 409);
        const changes = !['GET', 'HEAD'].includes(req.method);
        const plainDecision = req.method === 'PUT' && /^\/api\/decisions\/[^/?]+$/.test(route) && /^text\/plain(?:;|$)/i.test(req.headers['content-type'] || '');
        let input;
        if (plainDecision) {
          const bytes = await readBytes(req);
          try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { throw new ControlError('Decision content must be UTF-8 text.'); }
        } else if (changes && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) input = await body(req);
        const send = () => target.native.request({ method: req.method, path: route, body: input, ...(plainDecision ? { contentType: 'text/plain' } : {}) });
        let result;
        if (changes) await target.engine.mutate(async state => {
          if (state.activeRun || state.initiatives.some(item => item.pending)) throw new ControlError('Pause active delivery with a scope change before editing project records.', 409);
          result = await send(); target.taskCache.at = 0;
        });
        else result = await send();
        const type = result.headers?.['content-type'] || 'application/json; charset=utf-8';
        if (nativeAsset) {
          // Repository attachments are content, never privileged application
          // code. In particular, opening an SVG/HTML document must not let it
          // read the registry token or act on another registered project.
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        }
        res.writeHead(result.status, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : result.body); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const [state, board] = await Promise.all([engine.read(), tasks()]);
        return json(res, 200, { ...state, csrfToken, project, capabilities, tasks: board.tasks, boardError: board.error, serviceError: engine.lastError || null });
      }
      if (req.method === 'GET' && url.pathname === '/api/operations') {
        const [issues, metrics, worktrees, retention] = await Promise.all([listIssues(selectedContext), issueMetrics(selectedContext), inspectWorktrees(selectedContext), planRetention(selectedContext)]);
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
        return json(res, 200, await previewUatArtifact(selectedContext, snapshot.initiatives.find(item => item.id === artifact[1]), { stepId: url.searchParams.get('stepId'), index: Number(index) }));
      }
      if (req.method === 'POST' && action) {
        const state = await engine.action(action[1], await body(req));
        return json(res, 200, { initiative: state.initiatives.find(i => i.id === action[1]) });
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') return json(res, 200, await listSkills(selectedContext));
      if (req.method === 'GET' && url.pathname === '/api/skills/content') return json(res, 200, await readSkill(selectedContext, url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/docs') return json(res, 200, await listDocuments(selectedContext, { query: url.searchParams.get('q') || '' }));
      if (req.method === 'GET' && url.pathname === '/api/docs/content') return json(res, 200, await readDocument(selectedContext, url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/milestones') return json(res, 200, { milestones: await adapter.listMilestones() });
      const milestone = /^\/api\/milestones\/(m-\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && milestone) return json(res, 200, { milestone: await adapter.viewMilestone(milestone[1]) });
      if (req.method === 'PATCH' && milestone) {
        const input = await body(req); let changed;
        await engine.mutate(async state => {
          if (state.activeRun || state.initiatives.some(item => item.pending)) throw new ControlError('Wait for active delivery to stop before editing its milestone contract.', 409);
          changed = await adapter.editMilestone(milestone[1], input);
        });
        return json(res, 200, { milestone: changed });
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
        session.taskCache.at = 0; return json(res, 200, { task: changed });
      }
      throw new ControlError('Route not found.', 404);
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 40000; server.headersTimeout = 10000;
  const closeSessions = async () => {
    const outcomes = await Promise.allSettled([...projects.values()].map(async session => {
      if (session.released) return;
      // Both writers must settle before admission is released. A rejected
      // native close does not prove its child stopped, so retain that fence.
      await session.engine.close();
      await session.native.close();
      await session.release();
      session.released = true;
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  };
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await closeSessions(); throw error; }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const session of projects.values()) session.engine.schedule();
  return { server, engine: initial.engine, context, projects, register, url: baseUrl, async close() {
    closed = true;
    try { await admission; await closeSessions(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--project', '--port'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: server.mjs --project <checkout> [--port <port>]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const context = await canonicalProject(options.project || process.cwd());
  const shared = sharedServiceContext(context);
  await fs.mkdir(shared.stateDir, { recursive: true });
  const lockPath = await assertSafePath(shared.stateDir, path.join(shared.stateDir, 'service.lock'));
  await withLock(shared, 'service-recovery', async () => {
    try {
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && !isRunProcessAlive(owner.pid)) await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, { timeoutMs: 1000 });
  await withLock(shared, 'service', async () => {
    const app = await createControlServer({ context, port, persistProjects: true, lockProjects: true });
    await updateState(shared, 'service-info', () => ({ pid: process.pid, url: app.url, apiVersion: 2, startedAt: new Date().toISOString() }));
    console.log(`Switchflow: ${app.url}/?project=${context.id}`);
    await new Promise(resolve => {
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await app.close(); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  }, { timeoutMs: 1000 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
