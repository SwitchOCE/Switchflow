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
      'Start a worker for an existing Backlog task in a managed candidate worktree of this run. kind "deliver" implements; kind "review" reviews read-only with a different provider from the author. Returns workerId immediately; the worker runs in the background. When the machine lacks memory for another worker, or limits.maxWorkers are running, the worker is queued instead (status "queued", queue.position and queue.reason such as "needs 1.5 GB, 0.8 GB available"); it starts by itself, first in first out, when capacity frees.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Backlog task ID, for example DEMO-12.' },
        kind: { type: 'string', enum: ['deliver', 'review'] },
        instructions: { type: 'string', description: 'Dispatch note: environment receipt, base, scope reminders.' },
        worktree: { type: 'string', description: 'Candidate name or absolute path created by the Git helper.' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Optional override of role routing.' },
        environment: {
          type: 'string',
          description:
            'Optional override of where the worker runs: "local", an SSH box, or a cloud environment such as "claude-cloud", if the owner configured and enabled it. Defaults to the owner placement for the role. SSH workers stream and steer like local ones; cloud workers skip memory admission, start at once and report through polling (about a minute of lag). Codex cloud takes reviews only: one fire-and-forget task with no steering, follow-up or approach turn. An unconfigured or unavailable environment is refused with its reason, never replaced by this PC.',
        },
        leases: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 8,
          description:
            'Optional leases the host takes for this worker before it starts and holds for its whole session (up to each lease\'s maxMinutes), released when the session ends. Workers on SSH boxes and in the cloud cannot call acquire_lease, so name their heavy steps here, for example ["gate"] or ["e2e"]. Names come from the pool of the machine the worker runs on: this PC\'s leases for local workers, the environment\'s own declared leases otherwise (list_leases shows both). While a lease is taken the worker stays queued with the reason.',
        },
      },
      required: ['task', 'kind', 'instructions', 'worktree'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_status',
    description:
      'State (queued, starting, working, idle, completed, failed, cancelled; a queued worker has queue.position and queue.reason), approach gate (approval: drafting, awaiting-confirmation or confirmed; writable), last message, usage and structured result of one worker, or all workers of this run.',
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
    description:
      "Stop a worker's current turn. The worker stays available for a follow-up message. A queued worker is cancelled instead.",
    inputSchema: { type: 'object', properties: { workerId }, required: ['workerId'], additionalProperties: false },
  },
  {
    name: 'wait_for_workers',
    description:
      'Block until a listed worker (default: all) finishes a turn you have not seen, or none is running or queued, or the timeout passes (1-50 seconds; call again to keep waiting).',
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
const timeoutSeconds = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  description: 'How long to wait (default 30). Returns acquired:false after it; call again to keep waiting.',
};
/**
 * Tools for workers (and the orchestrator): leases on the project's shared resources, so heavy
 * steps and singletons such as an e2e Docker stack are taken in turn instead of colliding.
 */
export const LEASE_TOOLS = [
  {
    name: 'acquire_lease',
    description:
      'Take a lease on a named shared resource before using it: "gate" before the full test, lint or build gate, "e2e" before end-to-end tests, or a project resource such as "docker-stack" (list_leases shows them). Waits first in, first out; a gating lease also waits for memory. Returns { acquired: true, id, expiresAt } or { acquired: false, reason }. Re-acquiring a lease you hold renews it. A lease is released by release_lease, when your session ends for any reason, or when ttlMinutes pass.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lease name, for example gate or e2e.' },
        ttlMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: 480,
          description: 'Time limit (default 30, at most the lease maxMinutes). Renew by acquiring again.',
        },
        timeoutSeconds,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'release_lease',
    description: 'Release a lease as soon as the step that needed it finishes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Lease ID returned by acquire_lease.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_leases',
    description:
      "The project's lease names on this PC with their counts, current holders, time left and waiters, and (environments) each environment's own lease pool for delegate_task leases.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'acquire_suite_lock',
    description:
      'Compatibility alias: acquire_lease for the lease "suite". Prefer acquire_lease with "gate" or "e2e". Returns acquired:false after the timeout (call again). Released by release_suite_lock, when your session ends, or after 30 minutes.',
    inputSchema: { type: 'object', properties: { timeoutSeconds }, additionalProperties: false },
  },
  {
    name: 'release_suite_lock',
    description: 'Compatibility alias: release your "suite" lease.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
/** Earlier name of the worker tool set. */
export const SUITE_TOOLS = LEASE_TOOLS;
export const TOOL_NAMES = Object.freeze([...TOOLS, ...LEASE_TOOLS].map(tool => tool.name));

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
          tools === LEASE_TOOLS
            ? 'Hold a lease only while you use its resource: "gate" for the full test, lint or build gate, "e2e" for end-to-end tests. Release it as soon as the step ends.'
            : 'Delegate task delivery and independent review to workers. The host enforces worktrees, worker limits, memory admission (workers may queue), review independence and review rounds. Leases share heavy steps and singleton resources.',
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
  // Workers get only the lease tools; the orchestrator gets delegation and leases.
  const tools = process.env.SWITCHFLOW_ORCHESTRATION_TOOLS === 'suite' ? LEASE_TOOLS : [...TOOLS, ...LEASE_TOOLS];
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
