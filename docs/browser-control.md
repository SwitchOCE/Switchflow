# Browser control

The browser is the owner workspace. Its routine decisions are Intake, Planning, and UAT. Delivery phases and independent technical acceptance stay with agents under the approved plan.

## Run the board

After the setup steps, double-click `Start Switchflow.cmd`, run `npm --prefix .switchflow run board`, or use `.switchflow/scripts/backlog.ps1 control`. The service binds only `127.0.0.1` and chooses a free port. Its launcher validates the shared service protocol and PID before reuse, then registers the canonical Git project. The project selector observes all registered projects on that port, including running and attention counts. Switching is local to the browser tab: every API request carries an explicit project ID. `board:native` retains the pinned Backlog browser.

New initiative starts Intake in one click. The form accepts typed text and offers dictation when the browser exposes it. Microphone access remains a normal browser decision; unsupported or denied dictation leaves the text form usable.

Intake inspects existing capabilities, asks material questions, and returns proposed scope. Scope approval starts Planning. Plan approval records the exact plan and scope hashes and starts delivery across every listed phase. A checkpoint marked in progress continues automatically. UAT is shown only after the execution result includes evidence, no blockers, and a walkthrough; every step needs a human pass before acceptance. The service validates record shape and authorization, while independent reviewers establish the evidence's meaning.

UAT acceptance saves the human verdict and candidate evidence immediately, then queues an agent to mirror that existing decision into the primary Backlog task and milestone records. The initiative becomes Complete when that record update has evidence. A failed update can be retried without another acceptance decision; it does not grant main-branch integration or publication.

Walkthrough file references can open a committed-text preview in the board. The service accepts only the exact file reference already in that initiative's UAT, within a candidate registered to its approved grant. It verifies the candidate identity and reads the recorded commit's blob, preserving its whitespace; working-file edits cannot change the displayed acceptance artifact. Binary, oversized, linked, protected and unrelated files are refused. Application walkthroughs use their real HTTP or HTTPS links and still require the owner to try the product.

## Scope, concurrency and interruptions

The service admits one agent run per Git project at a time. Other initiatives can queue. Each human action carries the initiative revision actually displayed; stale actions fail and the browser retains typed drafts. Updates enter the next checkpoint. A scope change stops the current run, retains the old approvals for audit, revokes the current grant, and returns to Intake. New work waits for the stopped process to settle.

Plan approval covers its listed phases, local candidate delivery, and independent technical review. It does not grant remote pushes, deployment, live-data changes, credentials, or shared-history changes. Those unavailable actions become named exceptions; the local runner never bypasses its sandbox or approval controls. Framework friction is recorded without automatically dispatching unrelated work.

Planning records the committed source baseline. If that baseline changes before approval, the controller refreshes Planning and presents the revised plan before granting delivery. Each delivery grant binds the scope, plan, and baseline. Uncommitted source changes are preserved; they are not silently copied into a candidate.

The sandbox keeps Git metadata protected. During approved delivery, a local host helper accepts only three fixed operations: create a registered candidate worktree, commit explicitly named files in it, and merge a frozen managed candidate into another managed candidate. A file request/reply channel works without granting the agent network access. Candidates live under the external project state and use dedicated `codex/` branches. The helper has no operation for changing the primary checkout, pushing, resetting, deploying, deleting worktrees, or changing Git configuration. Required hooks, active filters, signing policies and custom merge drivers that would execute outside the sandbox stop the operation with a named exception; they are not silently skipped. Dormant diff/filter configuration does not prevent unrelated work. Cancellation stops admitting requests and lets an already-started Git operation settle; uncertain interrupted operations require inspection and are never replayed automatically.

Task edits use Backlog's partial-update path and the CAS fork's expected revision. They preserve unrelated fields and reject stale records. Native editing remains available when the project's agent-admission fence permits it; changes to an approved initiative's scope use the scope-change path. Direct manual Markdown writes remain outside Backlog's locking contract.

An ordinary conflict between managed candidates stays with the agents. The helper records both frozen heads and the exact conflicted paths. After correcting and reviewing those files in the sandbox, the agent resubmits the same merge with those paths. The helper rejects changed heads, additional edits, mismatched paths or altered unrelated index entries, then commits and verifies the two merge parents. Conflicts that cannot meet those constraints remain named exceptions. Windows Git calls enable long paths for that command only. New candidate roots use a compact hash of the full initiative and grant; existing registrations retain their recorded layout. Git's separate Windows root-length limit is checked before creating a branch. If an unusually long state-home still exceeds it, use a shorter host state-home for a new project or a shorter candidate name; never move a registered candidate or rewrite its records to bypass the check.

## Agents: providers, routing and steering

Each stage runs one agent session through a provider adapter in `scripts/control/providers/`: `codex-app-server.mjs` (`codex app-server`, JSON-RPC over stdio) or `claude-cli.mjs` (the installed `claude` CLI in stream-json mode). If app-server fails its initialize handshake, Codex falls back to `codex exec` (`codex-runner.mjs`), which cannot be steered. Both adapters keep the exec guardrails: approval `never` with no approval prompts, only the `workspace-write` or `read-only` sandbox, the host's explicit writable roots, a private temp folder, no sandbox network, and no bypass mode.

- **Codex** gets the policy twice: as `-c` process overrides (including `notify=[]`) and as explicit per-thread and per-turn settings (`approvalPolicy: never`, `approvalsReviewer: user`, `sandboxPolicy`), so `~/.codex/config.toml` cannot loosen it. The user's own MCP servers, ChatGPT apps (the `codex_apps` connector, which can reach live services and deploy) and bundled plugins such as computer use are disabled for runs (`features.apps`, `features.plugins`, `features.computer_use` set to false); runs see only servers Switchflow supplies. The `codex exec` fallback gets the same feature overrides and switches off each server `codex mcp list` reports; if that list cannot be read, the fallback refuses to run.
- **Claude** runs with `--restricted --strict-mcp-config --permission-prompts none`: user, project and local settings are ignored, file tools are confined to the working directory and `--add-dir` roots, and anything not pre-approved is denied. Writing roles use `acceptEdits` with `Read, Grep, Glob, Edit, Write, NotebookEdit, Bash`; read-only roles get no edit tools. Bash is limited to read-only Git and the Switchflow wrappers (`.switchflow/scripts/*`, plus the Git helper during delivery). Each session has `--max-turns`, a `--json-schema` result and an `is_error` check.

### Role routing

Settings live in `<stateDir>/agent-settings.json`. Defaults: Claude for `intake`, `planning`, `execution` (the phase orchestrator) and `uat`; Codex for `delivery` (task workers); `review: auto` (the provider that did not author the work). If the routed provider is unavailable (not installed, or Claude not signed in), the other one runs and the session records a `notice` and a `fallback`. Review never falls back to the author's provider; it fails with 409 instead.

### Agents API

All routes are project-scoped: prefix `/api/projects/<projectId>`. Writes need the page's `X-Switchflow-Token`, a loopback Host and a same-origin (or absent) Origin, like every other write. Errors are `{ "error": "<message>" }` with 400 (invalid input), 403 (token or origin), 404 (unknown session), 409 (state conflict) or 503.

**`GET /agents`** returns:

```json
{
  "providers": {
    "codex": { "available": true, "version": "codex-cli 0.153.4", "transport": "app-server", "diagnostic": "" },
    "claude": { "available": true, "version": "2.1.288", "transport": "cli", "loggedIn": true, "authMethod": "claude.ai" }
  },
  "settings": {
    "schemaVersion": 1,
    "revision": 0,
    "roles": { "intake": "claude", "planning": "claude", "execution": "claude", "delivery": "codex", "review": "auto", "uat": "claude" },
    "models": { "claude": null, "codex": null },
    "efforts": { "claude": null, "codex": null },
    "limits": { "timeoutMinutes": 60, "maxWorkers": 2, "maxReviewRounds": 2, "maxTurns": 200 }
  },
  "routing": {
    "intake": { "provider": "claude", "fallback": null },
    "execution": { "provider": "codex", "fallback": { "from": "claude", "to": "codex", "reason": "claude is not signed in" } },
    "review": { "provider": null, "fallback": null, "error": "Independent review needs claude, but ..." }
  },
  "activeRun": { "id": "<uuid>", "initiativeId": "<uuid>", "stage": "execution", "status": "running" },
  "sessions": ["<Session>"]
}
```

`routing` has one entry per role (`intake`, `planning`, `execution`, `delivery`, `review`, `uat`), each `{ provider, fallback }` or `{ provider: null, fallback: null, error }`; `review` is computed against the routed delivery provider. A provider is `{ "available": false, "diagnostic": "..." }` when its CLI is missing. `activeRun` is `null` when idle. `sessions` lists live and recent sessions (up to 200), newest first.

A **Session** object:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | Session ID used in the routes below. |
| `parentId` | uuid or null | Orchestrator session for a worker; `null` for stage sessions. |
| `runId`, `initiativeId` | uuid | The run and initiative it belongs to. |
| `role` | `intake`, `planning`, `execution`, `delivery`, `review`, `uat` | Routed role. |
| `kind` | `stage`, `deliver`, `review` | Stage agent, or a delegated worker. |
| `provider` | `claude`, `codex` | |
| `transport` | `app-server`, `exec`, `cli` or null | `exec` cannot be steered. |
| `model`, `threadId` | string or null | Provider model and thread or session ID. |
| `task`, `worktree`, `reviewRound` | string, string, number, or null | Worker task ID, candidate path and review round (workers only). |
| `sandbox` | `workspace-write`, `read-only` | |
| `status` | `starting`, `working`, `idle`, `completed`, `failed`, `cancelled` | `working`: a turn is running. `idle`: open and waiting for a follow-up (workers). |
| `lastTurn` | `{ id, status, at }` or absent | Most recent finished turn; `status` is `completed`, `interrupted` or `failed`. |
| `startedAt`, `updatedAt`, `endedAt` | ISO time or null | |
| `usage` | `{ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, costUsd }` or null | Cumulative for the session; `costUsd` is Claude only. |
| `lastMessage` | string or null | Latest agent text, at most 4,000 characters. |
| `result` | object or null | Structured result once completed. |
| `error` | string or null | Failure or stop reason. |
| `fallback` | `{ from, to, reason }` or null | Provider substitution. |
| `eventCount` | number | Highest event `seq`. |
| `live` | boolean | The service holds the process. Only live sessions can be steered. |
| `canSteer`, `canInterrupt` | boolean | Whether the two write routes will currently be accepted. |

**`GET /agents/<sessionId>/events?after=<seq>&limit=<n>`** (`after` defaults to 0; `limit` is 1–500, default 200) returns events with `seq > after`, oldest first:

```json
{
  "sessionId": "<uuid>",
  "status": "working",
  "live": true,
  "events": [{ "seq": 1, "at": "2026-10-03T12:00:00.000Z", "kind": "session.started", "provider": "codex", "transport": "app-server", "threadId": "...", "pid": 1234, "model": "gpt-5.6-luna" }],
  "nextAfter": 1,
  "more": false
}
```

Poll with `after=nextAfter`. Every event has `seq`, `at` and `kind`:

| `kind` | Fields |
| --- | --- |
| `session.started` | `provider`, `transport`, `threadId`, `pid`, `model`. Exec may send it twice: pid first, then threadId. |
| `turn.started` | `turnId` (null on exec) |
| `message` | `text`, `final` (true for the turn's answer), `phase` (Codex only) |
| `tool` | `name`, `summary` (one line) |
| `command` | `command`, `status` (`started`, `completed`, `failed`, ...), `exitCode` |
| `file_change` | `paths[]`, `status` |
| `steer` | `text`, `by` (`owner` or `orchestrator`), `mode` (`steer`, `queue` or `followup`), `turnId` |
| `interrupt` | `by`, `turnId` |
| `turn.completed` | `turnId`, `status` (`completed` or `interrupted`), `usage` |
| `turn.failed` | `turnId`, `error` |
| `stderr` | `text`, ANSI stripped |
| `notice` | `level` (`warning` or `error`), `text`: fallbacks, declined requests, denied tools |
| `session.closed` | none |

Text fields are capped at 20,000 characters. Shell output and hidden reasoning are not included.

**`POST /agents/<sessionId>/steer`** takes `{ "message": "<1–20000 characters>", "mode": "steer" | "queue" }`; `mode` is optional and defaults to `steer`. No other fields.

- `steer` reaches a running turn mid-turn: Codex through `turn/steer` with the active turn ID, Claude as a user message with `priority: "next"`, read at its next tool boundary.
- `queue` holds the message until the current turn ends. A worker then runs it as its next turn (several queued messages are joined in order). A stage agent has no next turn in this run, so a queued message becomes an ordinary owner update for the next checkpoint.
- An idle worker receives the message as a follow-up turn in either mode.

Returns 202:

```json
{ "ok": true, "sessionId": "<uuid>", "mode": "steer", "turnId": "<id or null>" }
```

`mode` is the effective mode: `steer`, `queue` or `followup`. The session's `steer` event carries the same `mode`. Returns 400 for an unknown mode, and 409 when the session is not live, has no running turn, or uses `exec` with `mode: "steer"`. Owner messages are appended to the initiative's message history as `{ "type": "steer", "message", "sessionId", "runId", "role", "provider", "mode", "at" }` (type `update` for a message queued to a stage agent) with a `steer` activity event, so they survive restarts. A steer delivered to a run is not repeated as new input to the next run.

**`POST /agents/<sessionId>/interrupt`** takes `{}` or no body and returns 202 `{ "sessionId": "<uuid>", "interrupted": true }`, or 409 when no turn is running. Interrupting a stage agent ends that run as failed with "The owner interrupted this agent. Add an update or retry." Interrupting a worker leaves it `idle` for its orchestrator.

**`PUT /agents/settings`** takes any subset of `{ "roles", "models", "efforts", "limits", "expectedRevision" }`. Roles take `claude` or `codex`, and `review` also takes `auto`. Models and efforts take `null` or a plain name. Limits are integers: `timeoutMinutes` 1–1440, `maxWorkers` 1–8, `maxReviewRounds` 1–5, `maxTurns` 1–1000. Unknown keys return 400, a stale `expectedRevision` returns 409, and so does any change while a run holds admission (`activeRun` is set). Returns 200 `{ "settings", "routing" }`.

### Orchestrator and workers

During Execution, the orchestrator session (either provider) gets a `switchflow` MCP server (`scripts/control/orchestration-mcp.mjs`, stdio, no dependencies). Claude receives it through `--mcp-config`; Codex through per-thread `mcp_servers` config. The server forwards each call to `POST /api/projects/<projectId>/orchestration/<runId>/<tool>` with a per-run `X-Switchflow-Run-Token` instead of the page token; the token stops working when the run ends. Tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `delegate_task` | `task`, `kind` (`deliver` or `review`), `instructions`, `worktree` (candidate name or path), optional `provider` | Worker summary: `workerId`, `task`, `kind`, `provider`, `worktree`, `reviewRound`, `status`, `lastTurn`, `lastMessage`, `usage`, `result`, `error`, `fallback` |
| `worker_status` | optional `workerId` | `{ workers: [summary] }` |
| `send_to_worker` | `workerId`, `message`, optional `mode` (`steer` or `queue`) | `{ ok, sessionId, mode, turnId }` as for owner steering |
| `interrupt_worker` | `workerId` | `{ workerId, interrupted }` |
| `wait_for_workers` | optional `workerIds`, `timeoutSeconds` (1–50, default 30) | `{ timedOut, workers: [summary] }`; returns when a listed worker finishes a turn the orchestrator has not seen, or none is running |
| `acquire_suite_lock` | optional `timeoutSeconds` (1–50) | `{ acquired: true, expiresAt }` or `{ acquired: false, heldBy }` |
| `release_suite_lock` | none | `{ released }` |

The host enforces:

- The worktree must be a candidate the Git helper registered for this initiative's plan grant, and the task must exist in Backlog.
- At most `limits.maxWorkers` workers run at once.
- Delivery workers get `workspace-write` with the candidate, governance root, operations, scratch and Git request inbox as writable roots. Their first turn returns the three-line approach; the orchestrator confirms it with `send_to_worker`.
- Reviewers are `read-only`, use a different provider from the task's latest author (the orchestrator's provider when it delivered directly), and return their verdict comment for the orchestrator to record. A blocked review is not retried on the author's provider.
- At most `limits.maxReviewRounds` reviews per task in a run; the next is refused with "Escalate to the owner."
- The run's cancel or scope change aborts every worker. Workers appear in `GET /agents` with `parentId` set to the orchestrator and `kind` `deliver` or `review`. Owner steering and interrupts work on them too.

The suite lock is one project-wide lock so parallel workers do not run the full test or build suite at the same time. Each worker gets its own MCP server with only the two lock tools and its own token. The lock is released explicitly, when its holder's session ends, or after 30 minutes.

`GET /state` keeps its shape; `capabilities` is now `{ "codex": <provider>, "claude": <provider> }`. After a restart, sessions that were open are listed as `failed` (under Needs you) with an error naming their process, and their events stay readable. Their processes are fenced as described in [Recovery](#recovery).

## Where data lives

| Data | Owner/location |
| --- | --- |
| Code | Accepted project checkout and explicitly managed candidate worktrees |
| Active governance rules and documentation | Primary checkout; copies in code worktrees are historical snapshots |
| Shared browser service and project registry | External `control-service/`; one port per state-home |
| Delivery tasks, milestones, accepted product documents | Primary checkout's Backlog; worker worktrees use the same governance root |
| Browser scope/plan approvals, revision history, sessions and run receipts | External project state, `control.json` and `runs/<id>/` |
| Agent routing settings and the agent session index | External `agent-settings.json` and `agent-sessions.json`; per-session events in `runs/<id>/sessions/` |
| Friction/issues, check evidence, worktree registrations | Separate external JSON ledgers in `operations/` |
| Investigation output | Managed external scratch; agents read only explicitly referenced material |
| Selected durable scratch output | Explicit promotion into the governance collection; never automatic ingestion |

External state defaults to `%LOCALAPPDATA%/Switchflow/projects/<SHA-256 of canonical Git common directory>`. `SWITCHFLOW_HOME` selects another external base. All worktrees sharing that Git common directory share the state. The `operations.mjs context <project>` command reports exact source, governance and state locations. Treat run prompts and tool logs as local project data when backing up or sharing; the web API only exposes human-facing activity and receipts.

Agent tools receive only the project/governance checkout, informational operations, scratch/promoted output, their managed candidate directory, and their Git request inbox as writable locations. Controller approvals, run records, responses, Git receipts and registries stay outside those grants. The runner excludes broad temporary-directory write access and supplies a dedicated temporary folder under its scratch area. Earlier local-candidate operations ledgers remain readable; the first update writes a separated copy without deleting the original. Stop older services before updating to this layout.

Scratch's default write-only use is a role boundary, not an operating-system ACL. Retention previews select only registered, expired, unpromoted scratch files. Applying cleanup rechecks exact ownership, hash and path containment; it leaves changed, unknown or promoted artifacts alone. It does not remove worktrees. Existing `cleanup-phase.ps1` retains its clean-and-merged predicate.

## Recovery

A normal cancel stops the owned process tree and records the interruption. Restart never treats an interrupted process as completed. Retry is an explicit action after recovery, not automatic replay of uncertain work.

The restart fence covers every agent process of the active run: the stage agent and each delegated worker or reviewer. A worker gets a durable entry in `control.json` (`activeRun.workers`: session, kind, provider, task, PID, time recorded) before its provider starts, and its PID is written as soon as the process exists: Codex app-server before its handshake, Claude CLI before its first input, `codex exec` at each turn's start. A cleanly closed worker's entry is removed. On restart each recorded process is classified:

| State | Meaning | Effect |
| --- | --- | --- |
| `running` | PID is alive and its start time is no later than when it was recorded | Holds the run until it stops or the owner stops it |
| `unverified` | PID is alive but its start time cannot be read | Holds the run until the owner confirms it stopped |
| `unknown` | No PID was recorded, for example a crash during startup | Holds the run until the owner confirms it stopped |
| gone | PID is not alive, or a later process reused it | No hold |

The hold lists each process (provider, stage or worker kind, task, PID) in `activeRun.held` and in the initiative's next action, and the Agents view lists those sessions as `failed`. Owner actions on the initiative:

- `stop-processes` ends the tree (`taskkill /T /F` on Windows, the process group elsewhere) of each process whose identity is verified again at that moment. Unverified and unknown entries are never stopped by the service. The hold is released when nothing remains.
- `recover-run` with `confirmedStopped: true` releases a hold whose remaining entries are unverified or unknown. It is refused while a verified process is still running.
- Any other action is refused while the hold remains; once every recorded process has stopped, the next action releases it.

The service does not stop these processes on its own at startup. Recovery runs whenever a project attaches, possibly without the owner present, and acts on state written by a previous service; stopping is irreversible and the owner may want to inspect the worker's work first. When the service dies its agents' stdin closes; idle Codex app-server and Claude CLI processes exit on that (checked 2026-10-03), so the hold usually clears by itself once any running turn ends. Start-time verification makes a stop request safe against PID reuse; it costs one PowerShell `Get-Process` call (about 0.3 s) per live PID, only during recovery.

Native Backlog and MCP editing timeouts and invalid transport responses retain their request and write-admission lock until the owned child emits closure. Sending a termination signal alone does not establish that the writer stopped. If termination cannot be confirmed, the request remains pending and new writes remain fenced; inspect and stop that exact child before recovery. No replacement child starts while its predecessor is uncertain.

Agent checkpoints start with the complete chronological owner history and identify new input separately. Earlier answers survive fresh sessions and service restarts. Long histories are retained in a run-local `owner-history.json` that the agent is instructed to read before deciding; superseded scope requests do not override current approvals.

Planning returns the exact native Backlog ID in each plan entry's `task` field, with its readable title and result in `outcome`. The initiative's Delivery tasks section uses those IDs from the approved plan; it never guesses associations from matching titles or ID fragments in prose. Older plans without explicit IDs remain usable and display an unlinked state with access to the project's task list.

Malformed state and unexplained stale data locks fail closed. Stop the service, back up its external state, inspect the lock's owner, and remove only a proven stale lock. Do not delete `control.json` or approve work to bypass a recovery failure. Service-lock recovery itself is serialized so simultaneous launches cannot steal a replacement lock.

## Verification and security boundaries

The server accepts only its loopback Host and same-origin browser requests. Every mutation requires a per-service token; JSON payloads and native decision-editor UTF-8 text are bounded. It launches fixed local executables with argument arrays and stdin, never browser-supplied shell commands. Native Backlog request handlers run through a private process pipe per canonical project, with no additional HTTP listeners. All writes share the agent-admission fence. Repository attachment responses are sandboxed and cannot execute scripts with workspace authority. The native web bundle is hashed alongside the executable in the fork receipt. Only local users and processes that can access this host should use this service; it is not a remotely authenticated multi-user server.

Agent results, events and completion receipts are bounded and persisted. A malformed final result, missing durable session, failed turn, timeout or process error cannot advance to UAT. Each agent runs under the owner's existing local Codex or Claude login with sandboxing and no approval bypass. Success in adapter tests is not real agent proof; a successful agent run is not human UAT.

`operations.mjs check` reuses only the latest successful matching attempt, with identical tracked/untracked source content, Git HEAD, command/arguments, working directory, declared scope and environment digest. Include digests for ignored dependencies, fixtures, external services and container images in `inputs`, or disable reuse when those inputs are not known. Container availability alone is not a container test result. Workers and reviewers reuse applicable evidence; the integrated changed candidate still gets its required gate.

## Milestones and documentation

Switchflow's Milestones view supports atomic creation, task assignment, removal and archive workflows, and edits an existing ID's title, description, labels and optional non-negative execution order. Revision conflicts retain the draft. Unspecified order remains unspecified; numeric identifiers never grant scheduling priority. The Switchflow task editor exposes an optional block reason and the fork updates dependency readiness on cooperating task mutations.

Documents and Decisions have Switchflow readers and editors, folder navigation, full-text search, Markdown previews, code copy and project-bound links. Local documentation images resolve only from canonical backlog/assets. Raw HTML stays inert; Mermaid is shown as code. Task and milestone edits use captured revisions. Document/decision saves compare the latest record before writing but their native APIs do not provide atomic compare-and-swap. See [workspace details](workspace-0.5.0.md) and the [full functionality review](backlog-ui-review.md).
