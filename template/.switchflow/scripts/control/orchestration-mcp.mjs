// Switchflow orchestration tools for the execution orchestrator: a minimal MCP server over
// stdio (newline-delimited JSON-RPC 2.0). Each call is forwarded to the local control service
// with the per-run token; the host enforces every guardrail. No third-party dependency.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const workerId = { type: 'string', description: 'Worker ID returned by delegate_task.' };

export const TOOLS = [
  {
    name: 'delegate_task',
    description:
      'Start a worker for an existing Backlog task in a managed candidate worktree of this run. kind "deliver" implements; kind "review" reviews read-only with a different provider from the author. Returns workerId immediately; the worker runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Backlog task ID, for example DEMO-12.' },
        kind: { type: 'string', enum: ['deliver', 'review'] },
        instructions: { type: 'string', description: 'Dispatch note: environment receipt, base, scope reminders.' },
        worktree: { type: 'string', description: 'Candidate name or absolute path created by the Git helper.' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Optional override of role routing.' },
      },
      required: ['task', 'kind', 'instructions', 'worktree'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_status',
    description:
      'State, approach gate (approval: drafting, awaiting-confirmation or confirmed; writable), last message, usage and structured result of one worker, or all workers of this run.',
    inputSchema: { type: 'object', properties: { workerId }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_to_worker',
    description:
      'Send a message to a worker. mode "steer" (default) reaches a running turn mid-turn; "queue" holds it until the current turn ends and sends it as the next turn. An idle worker starts a follow-up turn either way (use this to return review findings to the author). A delivery worker is read-only until you confirm its returned approach: set confirm true to approve it and unlock writes for its follow-up turn; without confirm the worker stays read-only (use that to correct the approach). The reply says whether it confirmed and whether the worker can now write.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId,
        message: { type: 'string' },
        mode: { type: 'string', enum: ['steer', 'queue'] },
        confirm: {
          type: 'boolean',
          description:
            'true approves the approach of a delivery worker whose status shows approval "awaiting-confirmation" and unlocks its writes.',
        },
      },
      required: ['workerId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt_worker',
    description: "Stop a worker's current turn. The worker stays available for a follow-up message.",
    inputSchema: { type: 'object', properties: { workerId }, required: ['workerId'], additionalProperties: false },
  },
  {
    name: 'wait_for_workers',
    description:
      'Block until a listed worker (default: all) finishes a turn you have not seen, or none is running, or the timeout passes (1-50 seconds; call again to keep waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        workerIds: { type: 'array', items: { type: 'string' } },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
/** Tools for workers: one project-wide lock so parallel workers do not run the heavy suite at once. */
export const SUITE_TOOLS = [
  {
    name: 'acquire_suite_lock',
    description:
      "Wait for the project's suite lock before running the full test or build suite. Returns acquired:false after the timeout (1-50 seconds; call again). The lock is released when you call release_suite_lock, when your session ends, or after 30 minutes.",
    inputSchema: {
      type: 'object',
      properties: { timeoutSeconds: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'release_suite_lock',
    description: 'Release the suite lock as soon as the suite finishes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
export const TOOL_NAMES = Object.freeze([...TOOLS, ...SUITE_TOOLS].map(tool => tool.name));

/** Handles one JSON-RPC message; returns the response object or null for notifications. */
export async function handleMessage(message, { forward, tools = TOOLS }) {
  const names = tools.map(tool => tool.name);
  const { id, method, params = {} } = message || {};
  const reply = result => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  const error = (code, text) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'switchflow', version: '1.0.0' },
        instructions:
          tools === SUITE_TOOLS
            ? 'Hold the suite lock only while running the full test or build suite.'
            : 'Delegate task delivery and independent review to workers. The host enforces worktrees, worker limits, review independence and review rounds.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      if (!names.includes(params.name)) return error(-32602, `Unknown tool: ${params.name}`);
      try {
        const result = await forward(params.name, params.arguments ?? {});
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

export function httpForwarder({ url, token, fetchImpl = fetch }) {
  return async (tool, args) => {
    const response = await fetchImpl(`${url}/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Switchflow-Run-Token': token },
      body: JSON.stringify(args),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Switchflow returned ${response.status}`);
    return body.result;
  };
}

async function main() {
  const url = process.env.SWITCHFLOW_ORCHESTRATION_URL;
  const token = process.env.SWITCHFLOW_ORCHESTRATION_TOKEN;
  if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url) || !token) {
    process.stderr.write('Switchflow orchestration needs a loopback URL and run token.\n');
    process.exitCode = 1;
    return;
  }
  const forward = httpForwarder({ url, token });
  // Workers get only the suite lock; the orchestrator gets delegation and the lock.
  const tools = process.env.SWITCHFLOW_ORCHESTRATION_TOOLS === 'suite' ? SUITE_TOOLS : [...TOOLS, ...SUITE_TOOLS];
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
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
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
        );
        continue;
      }
      // Calls run concurrently (a wait must not block status); replies carry their own IDs.
      const pending = handleMessage(message, { forward, tools }).then(response => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
      chain = chain.then(() => pending);
    }
  });
  process.stdin.on('end', () => chain.finally(() => process.exit(0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
