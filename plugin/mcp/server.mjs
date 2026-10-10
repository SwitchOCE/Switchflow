// Switchflow tools for Claude in the owner's session: a minimal MCP server over stdio
// (newline-delimited JSON-RPC 2.0), like control/orchestration-mcp.mjs. Each tool maps to the
// control service's HTTP API, the same requests the browser board sends. No third-party dependency.
//
// Approvals are owner button presses only. This server never sends approve-scope, approve-plan,
// request-changes, accept-uat, request-rework, recover-run, resume-workers or stop-processes, and
// never confirms a worker's approach (steer confirm: true).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LINE = 200;

/** Initiative actions that are the owner's decision alone; no tool may send them. */
export const OWNER_ONLY_ACTIONS = Object.freeze([
  'approve-scope',
  'approve-plan',
  'request-changes',
  'accept-uat',
  'request-rework',
  'recover-run',
  'resume-workers',
  'stop-processes',
]);

export class ServiceDownError extends Error {
  constructor(detail) {
    super(
      `The Switchflow service is not running${detail ? ` (${detail})` : ''}. Start a new Claude Code session to start it, or run .switchflow/scripts/start-control.ps1 in a template project.`,
    );
    this.code = 'SWITCHFLOW_DOWN';
  }
}

/** The shared state folder: SWITCHFLOW_HOME, else %LOCALAPPDATA%\Switchflow, else ~/.local/state/switchflow. */
export function switchflowHome(env = process.env) {
  return path.resolve(
    env.SWITCHFLOW_HOME ||
      (env.LOCALAPPDATA
        ? path.join(env.LOCALAPPDATA, 'Switchflow')
        : path.join(os.homedir(), '.local', 'state', 'switchflow')),
  );
}

/** A client of the running control service, found through its service-info.json receipt. */
export function serviceClient({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const projectRoot = path.resolve(env.CLAUDE_PROJECT_DIR || cwd);
  let service = null;
  let token = null;
  let projectId = null;

  const call = async (url, init = {}) => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error(`Switchflow did not answer within ${timeoutMs / 1000} s.`);
      service = null;
      token = null;
      throw new ServiceDownError(error.cause?.code || error.code || error.message);
    }
  };
  const discover = async () => {
    if (service) return service;
    const file = path.join(switchflowHome(env), 'control-service', 'service-info.json');
    let info;
    try {
      info = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      throw new ServiceDownError(error.code === 'ENOENT' ? `no receipt at ${file}` : error.message);
    }
    let url;
    try {
      url = new URL(info.url);
    } catch {
      throw new ServiceDownError('its receipt has no URL');
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new ServiceDownError('not a loopback URL');
    const base = url.origin;
    const health = await (await call(`${base}/api/health`)).json().catch(() => ({}));
    // Same identity check as start-control.ps1: the receipt may be left over from a stopped service.
    if (health.service !== 'switchflow-control' || health.apiVersion !== 2 || health.pid !== info.pid)
      throw new ServiceDownError('its receipt is stale');
    service = { url: base };
    return service;
  };
  const refreshToken = async () => {
    const { url } = await discover();
    const registry = await (await call(`${url}/api/projects`)).json();
    token = registry.csrfToken;
    return registry;
  };
  const send = async (method, route, body, retried = false) => {
    const { url } = await discover();
    const write = method !== 'GET';
    if (write && !token) await refreshToken();
    const response = await call(`${url}${route}`, {
      method,
      headers: write ? { 'Content-Type': 'application/json', 'X-Switchflow-Token': token } : {},
      ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const result = await response.json().catch(() => ({}));
    // A restarted service has a new page token: fetch it once and try again.
    if (response.status === 403 && write && !retried) {
      token = null;
      return send(method, route, body, true);
    }
    if (!response.ok) {
      const error = new Error(result.error || `Switchflow returned ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return result;
  };
  const project = async () => {
    if (projectId) return projectId;
    // Registering is idempotent: an attached project is returned as it is (start-control.ps1 does the same).
    const { project: registered } = await send('POST', '/api/projects', { projectRoot });
    projectId = registered.id;
    return projectId;
  };
  return {
    projectRoot,
    // Finds the service, so every tool reports a stopped service before anything else.
    ready: discover,
    get: route => send('GET', route),
    post: (route, body) => send('POST', route, body),
    put: (route, body) => send('PUT', route, body),
    project,
    async scoped(method, route, body) {
      return send(method, `/api/projects/${await project()}${route}`, body);
    },
    async boardUrl(view) {
      const id = await project();
      const { url } = await discover();
      const query = new URLSearchParams({ project: id, ...(view ? { view } : {}) });
      return `${url}/?${query}`;
    },
  };
}

/** One line for an event, worded like the Agents view feed (control/summary.mjs eventLine). */
export function eventLine(event) {
  if (!event) return null;
  const kind = event.kind || event.type;
  const text =
    kind === 'command'
      ? `$ ${event.command || event.text || ''}`
      : kind === 'tool'
        ? [event.name, event.summary].filter(Boolean).join(' · ') || event.text || kind
        : event.text ||
          {
            'session.started': 'Session started',
            'turn.started': 'Turn started',
            'turn.completed': 'Turn finished',
            'turn.failed': `Turn failed${event.error ? `: ${event.error}` : ''}`,
            interrupt: event.by === 'orchestrator' ? 'Stopped by the orchestrator' : 'Stopped',
            'session.closed': 'Session closed',
          }[kind] ||
          kind;
  const line =
    String(text)
      .split(/\r?\n/)
      .find(part => part.trim()) || '';
  return line.length > LINE ? `${line.slice(0, LINE - 1)}…` : line;
}

const id = description => ({ type: 'string', description });
const initiativeId = id('Initiative ID from status or list_initiatives.');
const workerId = id('Worker (agent session) ID from status.');
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const readOnly = { readOnlyHint: true };

export const TOOLS = [
  {
    name: 'status',
    description:
      "This project's Switchflow summary: initiatives with the owner decision each waits on (needsOwner; approvals are the owner's buttons, never a tool), the active run's workers with their last event, capacity, environments and holds. Pass since (a previous version) to get {unchanged:true} when nothing changed.",
    inputSchema: object({ since: id('version from an earlier status call.') }),
    annotations: readOnly,
  },
  {
    name: 'list_initiatives',
    description:
      'Every initiative of this project: id, title, stage, status, revision, open questions and needsOwner. needsOwner.actions lists the buttons the owner can press; of those, only answering questions has a tool (answer).',
    inputSchema: object(),
    annotations: readOnly,
  },
  {
    name: 'start_initiative',
    description:
      "Create an initiative from the owner's request and queue its intake. Intake proposes a scope that only the owner can approve.",
    inputSchema: object(
      {
        title: { type: 'string', description: 'Short title, at most 240 characters.' },
        request: { type: 'string', description: 'The outcome the owner asked for, in their words.' },
        reviewMode: { type: 'boolean', description: 'Ask for review-only delivery (default false).' },
        start: { type: 'boolean', description: 'Queue intake now (default true).' },
      },
      ['title', 'request'],
    ),
  },
  {
    name: 'answer',
    description:
      "Send the owner's answers to an initiative's open intake or planning questions (see list_initiatives questions). Every question needs an answer. Use only answers the owner gave.",
    inputSchema: object(
      {
        initiativeId,
        answers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Answers keyed by question ID.',
        },
      },
      ['initiativeId', 'answers'],
    ),
  },
  {
    name: 'worker_feed',
    description:
      "A page of a worker's transcript, one line per event. Pass after (nextAfter of the previous page) to continue.",
    inputSchema: object(
      {
        workerId,
        after: { type: 'integer', minimum: 0, description: 'Sequence number to read after (default 0).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Events per page (default 50).' },
      },
      ['workerId'],
    ),
    annotations: readOnly,
  },
  {
    name: 'steer_worker',
    description:
      'Send the owner\'s message to a worker. mode "steer" (default) reaches a running turn; "queue" waits for the turn to end. An idle worker gets a follow-up turn. This never confirms a delivery worker\'s approach: that is the owner\'s button in Switchflow.',
    inputSchema: object({ workerId, message: { type: 'string' }, mode: { type: 'string', enum: ['steer', 'queue'] } }, [
      'workerId',
      'message',
    ]),
  },
  {
    name: 'interrupt_worker',
    description: "Stop a worker's current turn. Its transcript is kept and it can take a follow-up message.",
    inputSchema: object({ workerId }, ['workerId']),
  },
  {
    name: 'list_environments',
    description:
      'Where workers can run (this PC, SSH boxes, Claude or Codex cloud), with the last health check of each and the placement per role.',
    inputSchema: object(),
    annotations: readOnly,
  },
  {
    name: 'add_environment',
    description:
      'Add an SSH, Claude cloud or Codex cloud environment to the owner settings, with the fields the Agents view asks for (id, label, kind, and host/user/identityFile/workRoot for ssh, or environmentId/repository for cloud). Refused while a run is active. Placement stays as it is.',
    inputSchema: object(
      {
        environment: {
          type: 'object',
          description: 'The environment entry, for example {"id":"wsl-box","kind":"ssh","host":"localhost",...}.',
        },
      },
      ['environment'],
    ),
  },
  {
    name: 'test_environment',
    description: 'Check that an environment answers. Starts no agent.',
    inputSchema: object({ id: id('Environment ID from list_environments.') }, ['id']),
  },
  {
    name: 'pause_local_workers',
    description:
      'Pause (default) or resume new workers on this PC. Running workers continue; SSH and cloud workers are not affected. Resuming starts queued workers in order.',
    inputSchema: object({ paused: { type: 'boolean', description: 'true pauses, false resumes (default true).' } }),
  },
  {
    name: 'open_board',
    description:
      "The browser board's URL for this project, for the owner to open (approvals, UAT checks and recovery live there and in the Switchflow pane).",
    inputSchema: object({
      view: {
        type: 'string',
        enum: ['overview', 'tasks', 'milestones', 'documents', 'agents', 'insights'],
        description: 'Optional board view.',
      },
    }),
    annotations: readOnly,
  },
];
export const TOOL_NAMES = Object.freeze(TOOLS.map(tool => tool.name));

const need = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};
const segment = value => encodeURIComponent(need(value, 'An ID'));

/** Tool handlers over a service client. Each request has the exact shape app.js or agents.js sends. */
export function toolHandlers(client) {
  const summary = since => client.scoped('GET', `/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  const initiative = async idValue => {
    const state = await client.scoped('GET', '/state');
    const item = state.initiatives.find(entry => entry.id === idValue);
    if (!item) throw new Error('Initiative not found.');
    return item;
  };
  const action = async (idValue, name, payload) => {
    // Defence in depth: the owner's decisions never leave this server, whatever a caller asks.
    if (OWNER_ONLY_ACTIONS.includes(name)) throw new Error(`${name} is the owner's decision.`);
    const item = await initiative(idValue);
    return client.scoped('POST', `/initiatives/${segment(idValue)}/actions`, {
      action: name,
      expectedRevision: item.revision,
      ...payload,
    });
  };
  const settings = async () => (await client.scoped('GET', '/agents')).settings;
  const handlers = {
    status: ({ since } = {}) => summary(since),
    list_initiatives: async () => {
      const { initiatives, activeRun, version } = await summary();
      return { version, activeRun, initiatives };
    },
    start_initiative: async ({ title, request, reviewMode = false, start = true }) => {
      const { initiative: created } = await client.scoped('POST', '/initiatives', {
        title,
        request,
        reviewMode: reviewMode === true,
        start: start !== false,
      });
      return {
        initiative: { id: created.id, title: created.title, stage: created.stage, status: created.status },
        next: start === false ? 'Created. Intake starts when the owner starts it.' : 'Intake is queued.',
      };
    },
    answer: async ({ initiativeId: target, answers }) => {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers))
        throw new Error('Supply answers keyed by question ID.');
      const { initiative: updated } = await action(need(target, 'initiativeId'), 'answer', { answers });
      return { initiative: { id: updated.id, stage: updated.stage, status: updated.status, pending: updated.pending } };
    },
    worker_feed: async ({ workerId: target, after = 0, limit = 50 }) => {
      const page = await client.scoped(
        'GET',
        `/agents/${segment(target)}/events?after=${Number(after)}&limit=${Number(limit)}`,
      );
      return {
        workerId: page.sessionId,
        status: page.status,
        live: page.live,
        nextAfter: page.nextAfter,
        more: page.more,
        events: page.events.map(event => ({
          seq: event.seq,
          at: event.at,
          kind: event.kind,
          ...(event.by ? { by: event.by } : {}),
          line: eventLine(event),
        })),
      };
    },
    // confirm is never sent: approving a worker's approach is the owner's action.
    steer_worker: ({ workerId: target, message, mode }) =>
      client.scoped('POST', `/agents/${segment(target)}/steer`, { message, ...(mode ? { mode } : {}) }),
    interrupt_worker: ({ workerId: target }) => client.scoped('POST', `/agents/${segment(target)}/interrupt`, {}),
    list_environments: async () => {
      const [{ environments }, agents] = await Promise.all([summary(), client.scoped('GET', '/agents')]);
      return { environments, placement: agents.settings?.placement ?? {} };
    },
    add_environment: async ({ environment }) => {
      if (!environment || typeof environment !== 'object' || Array.isArray(environment))
        throw new Error('environment must be an object.');
      const current = await settings();
      const existing = current.environments || [];
      if (existing.some(entry => entry.id === environment.id))
        throw new Error(`An environment named ${environment.id} already exists.`);
      const saved = await client.scoped('PUT', '/agents/settings', {
        environments: [...existing, environment],
        ...(Number.isInteger(current.revision) ? { expectedRevision: current.revision } : {}),
      });
      return {
        environments: saved.settings.environments.map(({ id: key, kind, label }) => ({ id: key, kind, label })),
      };
    },
    test_environment: ({ id: target }) => client.scoped('POST', `/agents/environments/${segment(target)}/test`, {}),
    pause_local_workers: async ({ paused = true } = {}) => {
      const current = await settings();
      const saved = await client.scoped('PUT', '/agents/settings', {
        pauseLocalWorkers: paused !== false,
        ...(Number.isInteger(current.revision) ? { expectedRevision: current.revision } : {}),
      });
      return { pauseLocalWorkers: saved.settings.pauseLocalWorkers === true };
    },
    open_board: async ({ view } = {}) => ({ url: await client.boardUrl(view) }),
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async args => {
        await client.ready?.();
        return handler(args);
      },
    ]),
  );
}

/** Handles one JSON-RPC message; returns the response object or null for notifications. */
export async function handleMessage(message, { handlers, tools = TOOLS }) {
  const { id: requestId, method, params = {} } = message || {};
  const reply = result => (requestId === undefined ? null : { jsonrpc: '2.0', id: requestId, result });
  const error = (code, text) =>
    requestId === undefined ? null : { jsonrpc: '2.0', id: requestId, error: { code, message: text } };
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'switchflow', version: '1.0.0' },
        instructions:
          "Switchflow runs this project's initiatives (intake, planning, delivery, UAT) with Claude and Codex workers. Use these tools to read status, start initiatives, pass on the owner's answers, steer workers and manage where they run. Approving scope or plans, accepting UAT, rework and recovery are the owner's buttons in the Switchflow pane or board; tell the owner when one waits and never claim to have done it.",
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const handler = tools.some(tool => tool.name === params.name) ? handlers[params.name] : null;
      if (!handler) return error(-32602, `Unknown tool: ${params.name}`);
      try {
        const result = await handler(params.arguments ?? {});
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (failure) {
        return reply({ content: [{ type: 'text', text: failure.message }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/')) return null;
      return error(-32601, `Method not found: ${method}`);
  }
}

/** Serves MCP over newline-delimited JSON on the given streams. */
export function serve({ input = process.stdin, output = process.stdout, handlers }) {
  let buffer = '';
  let chain = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      process.stderr.write('Input line too long.\n');
      process.exit(1);
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
        );
        continue;
      }
      // Calls run concurrently; replies carry their own IDs.
      const pending = handleMessage(message, { handlers }).then(response => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      });
      chain = chain.then(() => pending);
    }
  });
  return new Promise(resolve => input.on('end', () => chain.finally(resolve)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  serve({ handlers: toolHandlers(serviceClient()) }).then(() => process.exit(0));
