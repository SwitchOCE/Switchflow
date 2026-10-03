# Claude and Codex in one control service

3 October 2026. Inputs: [best-practice research](research-best-practice.md), [protocol verification](protocol-verification.md) (generated schema: `codex app-server generate-json-schema --out <dir>`) and the runner map summarized below.

## Goal

Let the owner use Claude and Codex for their strengths from one Switchflow workspace, with the same guardrails for both and less hand-holding:

- Each role picks a provider. Default: Claude runs Intake, Planning, UAT and phase orchestration; Codex delivers tasks; review always uses a different provider from the author.
- A Claude orchestrator can delegate a task to Codex, watch it, send it a message mid-turn, interrupt it, and send review findings back. Theo's T3 Code uses the same shape.
- The owner can see every live session and steer or stop it from the browser.

Human gates do not change: Intake, Planning and UAT stay the only routine stops. A plan grant still does not authorize pushes, deployment, credentials or live data.

## Today

- `control/codex-runner.mjs` runs `codex exec --json --output-schema` once per stage. It uses approval `never`, a `workspace-write` sandbox and explicit writable roots. It cannot steer.
- `engine.mjs` admits one run per project and maps Codex event names (`thread.started`, `item.completed`/`agent_message`, `turn.completed`) into progress.
- The browser polls `/api/projects/<id>/state` every 3 s. There is no SSE.
- Execution is a single Codex process. Any workers it uses are Codex's internal subagents, which the host never sees.
- Review independence exists only as prose in the skills.

## Design

### 1. Provider adapters (`control/providers/`)

One module per provider, each exporting the same session interface:

```js
openSession({ role, cwd, sandbox: 'read-only'|'workspace-write', writableRoots, temporaryRoot,
              instructions, model, effort, limits: { timeoutMs, maxTurns }, onEvent, signal, mcpServers? })
  -> { id, provider, threadId,
       startTurn(text, { outputSchema }) -> Promise<{ turnId, result, usage }>,
       steer(text, { expectedTurnId }),
       interrupt(),
       close() }
```

- **Codex** (`codex-app-server.mjs`): spawn `codex app-server`, speak JSON-RPC over stdio, and use `thread/start`, `turn/start` (with output schema), `turn/steer` (with `expectedTurnId`) and `turn/interrupt`. Approval stays `never`, and the sandbox and writable roots stay exactly as `codexArguments()` sets them today. Keep `codex-runner.mjs` (exec) as the fallback when app-server fails its initialize handshake.
- **Claude** (`claude-cli.mjs`): spawn the installed `claude` CLI with `-p --input-format stream-json --output-format stream-json --verbose`, a JSON-schema result, `--max-turns`, and a model. Steering writes a user message to stdin; interrupt sends the protocol interrupt, or ends the process if that is unavailable.
  - Permissions: never use `bypassPermissions` or `--dangerously-skip-permissions`.
  - Allow only the tools the role needs: read and search tools, and edits confined to the writable roots via `--add-dir`.
  - Bash is limited to the Switchflow wrappers (`.switchflow/scripts/*.ps1`) and read-only git.
  - The CLI is used instead of the Agent SDK so the control service adds no new npm dependency and keeps the "fixed local executables" boundary in `docs/browser-control.md`.
- Both adapters normalize events into one vocabulary, recorded to `events.jsonl` and shown in the UI:
  `session.started`, `turn.started`, `message` (agent text, `final` flag), `tool` (name + one-line summary), `command`, `file_change`, `steer` (owner/orchestrator input), `interrupt`, `turn.completed` (`result`, `usage`), `turn.failed`, `stderr`.

### 2. Role routing

Per-project settings in `<stateDir>/agent-settings.json`, read and written through the engine's state lock:

```json
{ "roles": { "intake": "claude", "planning": "claude", "execution": "claude", "delivery": "codex", "review": "auto", "uat": "claude" },
  "models": { "claude": null, "codex": null },
  "limits": { "timeoutMinutes": 60, "maxWorkers": 2, "maxReviewRounds": 2 } }
```

- `execution` is the phase orchestrator, `delivery` the task worker. `review: auto` means the provider that did not author the work.
- If a provider is unavailable (`--version` or auth check fails), fall back to the other provider and record a visible event. Never fail silently.
- The capability probe reports both providers: `{ codex: { available, version }, claude: { available, version, loggedIn } }`.

### 3. Orchestrator → worker bridge

When the execution orchestrator runs, Switchflow gives it its own small MCP server: `control/orchestration-mcp.mjs`, stdio, started by the host per run with a per-run token. It forwards tool calls to the control service over the existing loopback HTTP server. Tools:

| Tool | Effect |
| --- | --- |
| `delegate_task({ task, kind: 'deliver'\|'review', instructions, worktree, provider? })` | The host opens a worker session for an existing Backlog task, in a bridge-managed worktree that belongs to this run, using the routed provider. Returns `workerId`. |
| `worker_status({ workerId? })` | State, last messages, usage and structured result. |
| `send_to_worker({ workerId, message })` | Steer mid-turn. If the turn has finished, start a follow-up turn on the same thread (this is how review findings go back to the author). |
| `interrupt_worker({ workerId })` | Stop the current turn. |
| `wait_for_workers({ workerIds, timeoutSeconds })` | Block until any worker finishes or the timeout passes. |

Host-enforced guardrails:

- The worktree must be one the git bridge created for this initiative's plan grant.
- At most `maxWorkers` live workers at once.
- Review workers are read-only and use a different provider than the task's author.
- At most `maxReviewRounds` review rounds per task, then the orchestrator must escalate.
- Every worker inherits the run's abort signal, so cancel and scope-change stop everything.
- Workers write their verdicts and envelopes through the normal Backlog wrapper, as the skills already require.

`orchestrate-phase` gains one paragraph: when the `switchflow` MCP tools are present, delegate through them rather than through host subagents. Without them, behavior is unchanged, so Codex-only installs keep working.

### 4. Owner steering and visibility (HTTP)

- `GET /api/projects/<id>/agents`: providers and capability, routing settings, and live plus recent sessions (orchestrator and workers, with parent links, role, provider, status, task, started/updated, usage, last message).
- `GET /api/projects/<id>/agents/<sessionId>/events?after=<seq>`: normalized events, paged.
- `POST /api/projects/<id>/agents/<sessionId>/steer` `{ message }` and `POST .../interrupt`.
- `PUT /api/projects/<id>/agents/settings` `{ roles, models, limits }`: refused while a run is active.

All writes keep the existing CSRF token, loopback and Origin checks. Steering text is appended to the owner message history, so it survives a restart.

### 5. UI (Agents view)

The sidebar's **Agents** view lists live sessions as a tree (orchestrator → workers), each with provider badge, role, task and status. Selecting a session shows its transcript as a readable feed and a composer to steer or stop it. Settings gains an **Agents** section for role routing. This is built in `public/agents.js` against the API above.

## Out of scope for this pass

- Moving the browser from polling to SSE.
- Token budgets in dollars.
- ACP, which cannot steer yet.
- Automatic updates of consumer projects.

## Deviations and follow-ups (implementation, 3 October 2026)

Implemented in `template/.switchflow/scripts/control/`: `providers/`, `agent-settings.mjs`, `agent-sessions.mjs`, `agent-host.mjs`, `orchestration.mjs`, `orchestration-mcp.mjs`. The HTTP contract is in `docs/browser-control.md` under "Agents: providers, routing and steering". Smoke evidence is in `smoke/`.

Deviations from the design above:

- **Claude permissions.** Instead of a host permission handler, Claude runs with `--restricted --strict-mcp-config --permission-prompts none`, `acceptEdits` for writing roles and `dontAsk` for read-only roles. `--restricted` (found in CLI 2.1.288) ignores user, project and local settings, confines file tools to the working directories and refuses bypass. Anything not pre-approved is denied without a prompt.
- **Claude process per schema.** `--json-schema` is fixed per process, so the CLI starts with the first turn and later turns must use the same schema. Workers keep one schema across follow-ups.
- **Settings.** `efforts` (per provider) and `limits.maxTurns` (Claude `--max-turns`) were added. Codex has no turn cap; it relies on the session timeout.
- **Reviewer verdicts.** Reviewers are truly read-only, so they cannot write the Backlog comment. They return the verdict comment in their result and the orchestrator records it verbatim. `review-task` says so in one sentence.
- **Delivery approach turn, enforced.** A delegated delivery worker's first turn returns its three-line approach; the orchestrator confirms with `send_to_worker` and `confirm: true` (the owner can confirm from the Agents view). Until then every turn of that worker is read-only, enforced by the host per provider: Codex app-server gets `sandboxPolicy: readOnly` on `turn/start` (the policy is per turn and is sent on every turn); `codex exec` runs the turn with `--sandbox read-only` and the confirmed turn resumes the thread writable; Claude runs the approach in a process with the reviewer's read-only tool set (no Edit/Write, read-only Bash rules, `dontAsk`) whose conversation is saved, and the confirmed turn ends it and continues the same conversation with `--resume` in a process with the write tools. Mid-session switching was rejected for Claude: `set_permission_mode` exists in CLI 2.1.288, but plan mode only turns non-read-only tools without an allow rule into prompts, so the write-capable Bash allowlist (Switchflow wrappers, Git helper) would still run. The saved conversation is removed when the session closes. Worker status reports `approval` (`drafting`, `awaiting-confirmation`, `confirmed`) and `writable`; `send_to_worker` reports `confirmed` and `writable`, and refuses `confirm` before an approach is returned, while a turn runs, after confirmation, or for a reviewer. This keeps `deliver-task`'s "wait for confirmation" rule and costs one extra short turn (plus, on Claude, a process restart).
- **Git helper argument.** `git-bridge-client.mjs` also accepts the JSON request as a single argument, because Claude's Bash allowlist approves single commands, not pipelines.
- **User MCP servers, apps and plugins.** Codex runs read `config/read` and disable every user MCP server for the thread; Claude runs use `--strict-mcp-config`. A zero-turn check with `mcpServerStatus/list` found two more tool sources the design missed: the built-in `codex_apps` connector (131 ChatGPT app tools on this account, including `supabase.execute_sql` and site deploys) and the bundled computer-use plugin. Both are now off for every run via `features.apps/plugins/computer_use=false` (process `-c` flags and thread config; also added to `codex exec`). Verified live: a run thread now lists only Switchflow's server, and the user's extra writable root no longer appears.
- **Steering modes (added at the parent's request).** `steer` or `queue`; the response reports `steer`, `queue` or `followup`. A message queued to a stage agent becomes an owner update for the next checkpoint, since a stage session has one turn.
- **Suite lock (added at the parent's request).** One project-wide lock (`acquire_suite_lock`, `release_suite_lock`) so parallel workers do not run the full suite at once. Workers get a second MCP server with only these two tools and their own token; the lock is released on request, when the holder's session ends, or after 30 minutes.
- **Waiting.** `wait_for_workers` waits at most 50 seconds per call so it stays under MCP client tool timeouts; the orchestrator calls again.
- **Review rounds** are counted per task within one run.
- **Owner interrupt of a stage agent** ends that run as failed with a retry message, rather than leaving a half-finished stage open.

Known gaps:

- Resolved (SF-27): worker processes are now part of the restart fence; see `docs/browser-control.md`, Recovery.
- Exercised live on 2026-10-03 (`smoke/real-runs-2026-10-03.md`): a Codex orchestrator calling the MCP tools (it needed `default_tools_approval_mode = "approve"`, now set), owner steer and interrupt over HTTP on both providers. Still not exercised live: Codex approval requests, a real Claude reviewer.
- Resolved: a Claude delivery worker edited its file during its approach turn, before the orchestrator confirmed. The approach turn is now read-only on every provider (above); live evidence in `smoke/real-runs-2026-10-03.md`, section 4.
- Sandboxes restrict writes, not reads. In the end-to-end smoke the Codex worker could not find skills in the throwaway repo and read skill files from the owner's other Codex worktrees. The exec runner has the same exposure today.
- Claude delivery workers can run only Switchflow wrappers and read-only Git, so project tests run through `operations.mjs check`. Widen the allowlist per project if that proves too narrow.
- Owner steering is recorded after delivery; if the turn ends in the same instant, the next run may see the steer again as new input.
- The browser's "agent runtime unavailable" notice still reads only `capabilities.codex`.
- Codex's `review/start` reviewer is not used; reviews run as ordinary read-only sessions.
- The `codex exec` fallback still loads the user's MCP servers (it has no per-thread config; `--ignore-user-config` would also drop the user's model defaults). This predates this change.
- The real smoke runs in `smoke/` ran before the apps and plugins fix; their Codex threads had those tools available but did not call them.
- Codex threads still load the user's global `~/.codex/AGENTS.md` and memories feature; Switchflow's prompt and the repository's AGENTS.md take precedence in practice, but they are not isolated.
