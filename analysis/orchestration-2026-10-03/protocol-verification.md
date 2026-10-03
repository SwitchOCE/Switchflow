# Protocol verification: Codex and Claude (2026-10-03, Windows 11, Node 24.19.0)

Binaries checked:

- **codex-cli 0.153.4.** It is a native exe at `C:\Users\keech\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` and is signed in (ChatGPT, pro plan).
- **Claude Code 2.1.288.** The npm shim `%APPDATA%\npm\claude.cmd` wraps the native `node_modules\@anthropic-ai\claude-code\bin\claude.exe`. It is **not signed in**: `claude auth status` returns `loggedIn:false`, and `ANTHROPIC_API_KEY` is unset.

Artifacts:

- `codex-protocol/schema/`, `schema-experimental/`: output of `codex app-server generate-json-schema --out <dir> [--experimental]`.
- `codex-protocol/ts/`, `ts-experimental/`: output of `codex app-server generate-ts --out <dir> [--experimental]`. The v2 types are in `ts/v2/*.ts`.
- `codex-protocol/transcripts/`: exact JSONL exchanged. `>` marks client to server, `<` marks server to client, and deltas are trimmed to 3 per method. Email addresses are redacted.
  - `transcript-run.jsonl`: 4 real Codex turns plus a resume.
  - `run-summary.txt`: the observed event sequences.
  - `transcript-probe.jsonl`: model/list and account/read.
  - `transcript-mcp.jsonl`: `codex mcp-server` tools/list.
  - `transcript-claude-*.jsonl`: Claude stream-json and control protocol, without auth.
- Scripts are in the session scratch dir (`...\scratchpad\protocol\`): `rpc.mjs` (a JSON-RPC client of about 50 lines), `run.mjs`, `probe.mjs`, `mcp.mjs`, `claude-probe.mjs`, `claude-control.mjs`.

---

## 1. Codex: `codex app-server` (recommended transport)

### Wire format

- Spawn `codex app-server` (stdio is the default). The protocol is JSON-RPC 2.0 shaped, newline-delimited JSON, **without the `"jsonrpc":"2.0"` field**, both ways. That was observed and accepted.
- Requests: `{"method","id","params"}`. Responses: `{"id","result"}` or `{"id","error":{"code","message"}}`.
- Notifications: `{"method","params","emittedAtMs"}`.
- Server-to-client requests carry both `id` and `method`. Answer them with `{"id":<same>,"result":{...}}`.
- Use only v2 methods. v1 `applyPatchApproval` and `execCommandApproval` are legacy.
- `--experimental` schema methods require `initialize.capabilities.experimentalApi:true`.

### Handshake (verified)

```json
> {"method":"initialize","id":1,"params":{"clientInfo":{"name":"switchflow_probe","title":"Switchflow probe","version":"0.0.1"},"capabilities":{"experimentalApi":false,"requestAttestation":false}}}
< {"id":1,"result":{"userAgent":"switchflow_probe/0.153.4 (Windows 10.0.26200; x86_64) ...","codexHome":"C:\\Users\\keech\\.codex","platformFamily":"windows","platformOs":"windows"}}
> {"method":"initialized"}
```

- `capabilities.optOutNotificationMethods: string[]` suppresses noisy notifications, for example `mcpServer/startupStatus/updated`, `account/rateLimits/updated`, `remoteControl/status/changed`.
- Useful zero-cost calls:
  - `model/list {}`: models with `supportedReasoningEfforts` and `defaultReasoningEffort`. This account lists gpt-6-astra (default), gpt-5.6-sol/terra/luna, and gpt-5.5.
  - `account/read {}`: `{account:{type:"chatgpt",planType}, requiresOpenaiAuth}`.
  - `windowsSandbox/readiness`: returned `{"status":"ready"}`.

### Start or resume a thread (verified)

`thread/start` params (`ThreadStartParams`): `model, modelProvider, serviceTier, cwd, approvalPolicy, approvalsReviewer, sandbox, config, baseInstructions, developerInstructions, personality, ephemeral, serviceName, sessionStartSource, threadSource`. Value types:

- `sandbox`: `"read-only" | "workspace-write" | "danger-full-access"`.
- `approvalPolicy`: `"untrusted" | "on-request" | "never" | {"granular":{sandbox_approval,rules,skill_approval,request_permissions,mcp_elicitations}}`.
- `approvalsReviewer`: `"user" | "auto_review" | "guardian_subagent"`.
- `config`: arbitrary config.toml overrides, for example `{"model_reasoning_effort":"low"}`.
- `thread/start` has no `effort` field. Pass effort through `config` or per turn.

```json
> {"method":"thread/start","id":4,"params":{"cwd":"C:\\...\\repo","model":"gpt-5.6-luna","sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","developerInstructions":"You are being driven by an automated protocol test. Keep every reply minimal.","config":{"model_reasoning_effort":"low"}}}
< {"id":4,"result":{"thread":{"id":"01a1000a-546c-...","status":{"type":"idle"},"path":"C:\\Users\\keech\\.codex\\sessions\\2026\\10\\03\\rollout-...jsonl",...},"model":"gpt-5.6-luna","cwd":"...","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"readOnly","networkAccess":false},"reasoningEffort":"low",...}}
< {"method":"thread/started","params":{"thread":{...}}}
```

- **Set `approvalsReviewer:"user"` explicitly.** The user's `~/.codex/config.toml` sets `approvals_reviewer="auto_review"`, and every config.toml default leaks into app-server threads unless overridden. That includes the model (`gpt-6-sol`), the granular approval policy, `notify`, and MCP servers.
- `thread/resume {threadId, cwd?, sandbox?, approvalPolicy?, approvalsReviewer?, model?, baseInstructions?, developerInstructions?, config?, excludeTurns?}` was verified in a fresh process. It returned `thread.turns` with 4 completed turns and their items. Resume works across app-server restarts because threads persist to `~/.codex/sessions/...rollout-*.jsonl` unless `ephemeral:true`.
- Other thread methods: `thread/fork`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/rollback`, `thread/archive`, `thread/unsubscribe`, `thread/compact/start`.

### Start a turn (verified)

`turn/start` params (`TurnStartParams`): `threadId, input: UserInput[], cwd?, approvalPolicy?, approvalsReviewer?, sandboxPolicy?, model?, effort?, summary?, personality?, serviceTier?, outputSchema?, clientUserMessageId?`.

- Overrides apply to this turn **and later turns**.
- `sandboxPolicy` here is the object form: `{"type":"readOnly","networkAccess":false}`, `{"type":"workspaceWrite","writableRoots":[...],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}`, or `{"type":"dangerFullAccess"}`.
- `UserInput` text form is `{"type":"text","text":"...","text_elements":[]}`. `text_elements` is required in the type, and I always sent `[]`. Other forms: `image{url}`, `localImage{path}`, `skill{name,path}`, `mention{name,path}`.

```json
> {"method":"turn/start","id":5,"params":{"threadId":"01a1000a-546c-...","input":[{"type":"text","text":"Reply with the word OK. Do not run commands.","text_elements":[]}],"model":"gpt-5.6-luna","effort":"low"}}
< {"id":5,"result":{"turn":{"id":"01a1000a-5a8b-...","items":[],"status":"inProgress",...}}}
```

### Observed event sequence (T1, plain reply)

```
warning (config warning) -> mcpServer/startupStatus/updated x11 (user's MCP servers) -> thread/status/changed{active}
-> turn/started -> item/started(userMessage) -> item/completed(userMessage)
-> [item/started(reasoning) -> item/reasoning/summaryPartAdded/summaryTextDelta -> item/completed(reasoning)]  (T2-T4)
-> item/started(agentMessage, phase:"final_answer") -> item/agentMessage/delta* -> item/completed(agentMessage)
-> thread/tokenUsage/updated -> account/rateLimits/updated -> thread/status/changed{idle} -> turn/completed{turn.status:"completed"}
```

- **Final message:** read it from `item/completed` where `item.type=="agentMessage" && item.phase=="final_answer"`. `turn/completed.params.turn.items` also contains exactly the final agentMessage(s), with `itemsView:"summary"`. Interim text arrives as `phase:"commentary"` (seen in T4). Treat `phase:null` as unknown, since the schema says providers are inconsistent.
- **Token usage:** `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total,last,modelContextWindow}}`. The breakdown fields are `inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens`. T1 used about 21.1k input tokens: the base prompt plus tools, with nothing cached on the first turn.
- **Turn end:** `turn/completed {threadId, turn:{id,status:"completed"|"interrupted"|"failed",error:TurnError|null,durationMs}}`. Errors also arrive as the `error` notification `{error:TurnError, willRetry, threadId, turnId}`.
- **Diff:** `turn/diff/updated {threadId, turnId, diff}` carries the aggregated unified diff for the turn. It is in the schema but not observed, because the sandbox was read-only.
- **File-change items:** `item/*(fileChange){changes:[{path,kind:{type:add|delete|update,move_path},diff}],status}`, plus `item/fileChange/patchUpdated` and `outputDelta`. Schema only.
- **Command items:** `item/*(commandExecution){command,cwd,status,aggregatedOutput,exitCode,durationMs,commandActions}`, plus `item/commandExecution/outputDelta {itemId,delta}`. Schema only, because no commands ran.
- **Plan updates:** `turn/plan/updated`, `item/plan/delta`.

### Steer an in-progress turn (verified, works)

`turn/steer {threadId, expectedTurnId, input: UserInput[]}` returns `{turnId}`. It fails if `expectedTurnId` is not the active turn.

```json
> {"method":"turn/steer","id":6,"params":{"threadId":"01a1000a-546c-...","expectedTurnId":"01a1000a-8065-...","input":[{"type":"text","text":"Change of plan: stop after 3, then write the word STEERED on its own line.","text_elements":[]}]}}
< {"id":6,"result":{"turnId":"01a1000a-8065-..."}}
```

Observed in T2. The steer was sent right after `turn/started` while the first answer (1..60) was streaming.

- The in-flight sampling was **not** cut off: the full 1..60 answer completed as a `final_answer` item.
- Codex then emitted `item/started/completed(userMessage)` with the steer text **in the same turnId**, sampled again, and produced `"1\n2\n3\nSTEERED"`, followed by one `turn/completed`.
- Steering therefore takes effect at the next model-call boundary inside the same turn. To get the last word, take the **last** `final_answer` item.

Not exercised:

- The `TurnStartParams` doc says some fields are "ignored when this request steers an already-active turn". This implies `turn/start` on a busy thread also steers.
- Experimental queueing (needs `experimentalApi:true`): `thread/queue/add {threadId,input,clientUserMessageId}`, `thread/queue/list|update|delete|reorder|start`, `thread/queue/changed` notification.
- Experimental per-turn setting change: `turn/settings/update {threadId,turnId,model?,effort?,...}`.

### Interrupt

`turn/interrupt {threadId, turnId}`. The expected result is `turn/completed` with `turn.status:"interrupted"`.

**Not verified live.** In T4 the turn had already completed when the call was sent, and it returned:

```json
< {"error":{"code":-32600,"message":"no active turn to interrupt"},"id":9}
```

Treat this error as benign when racing completion.

### Structured output (verified)

`turn/start` takes `outputSchema` (JSON Schema). The result arrives as the `final_answer` agentMessage `text`, which is a JSON string.

```json
> {"method":"turn/start","id":7,"params":{...,"outputSchema":{"type":"object","properties":{"answer":{"type":"string"},"n":{"type":"integer"}},"required":["answer","n"],"additionalProperties":false}}}
... item/completed(agentMessage) text = "{\"answer\":\"OK\\n7\",\"n\":7}"
```

The text must be parsed with `JSON.parse`. Validate the parsed object yourself, because the shape was enforced but the semantics were sloppy: the cheap model put `"OK\n7"` in `answer`.

### Approvals (server to client requests; schema only, not triggered live)

| Server request `method` | Key params | Reply `result` |
|---|---|---|
| `item/commandExecution/requestApproval` | `threadId, turnId, itemId, approvalId?, command, cwd, reason, commandActions, proposedExecpolicyAmendment` | `{"decision":"accept"\|"acceptForSession"\|"decline"\|"cancel"\|{"acceptWithExecpolicyAmendment":{...}}\|{"applyNetworkPolicyAmendment":{...}}}` |
| `item/fileChange/requestApproval` | `threadId, turnId, itemId, reason, grantRoot?` | `{"decision":"accept"\|"acceptForSession"\|"decline"\|"cancel"}` |
| `item/permissions/requestApproval` | permission profile request | `{"permissions":GrantedPermissionProfile,"scope":...}` |
| `item/tool/requestUserInput` | question(s) | `ToolRequestUserInputResponse` |
| `mcpServer/elicitation/request` | MCP elicitation | `McpServerElicitationRequestResponse` |

- After the client answers, the server emits `serverRequest/resolved {threadId, requestId}`.
- While a request is pending, `thread/status/changed` reports `{type:"active",activeFlags:["waitingOnApproval"]}`.
- Approvals only reach the client when `approvalsReviewer:"user"`.

T4 asked the model to create `hello.txt` under the read-only sandbox with `on-request`. gpt-5.6-luna replied "I can't create `hello.txt` because the workspace is read-only." It made no tool call and sent **no approval request**. A cheap model may decline on its own instead of escalating, so Switchflow should not assume an escalation will happen.

### Codex quirks found

- **User config bleeds into every app-server thread.** Pass explicit overrides: `-c notify=[]` (the user has a computer-use notify hook), and the model, sandbox, approvalPolicy and approvalsReviewer per thread.
- **The user's MCP servers start on every thread.** These are supabase, codex_apps, open-design, and a dead `http://127.0.0.1:3333/mcp`. They add about 11 status notifications and ANSI-coloured `ERROR` lines on stderr. `codex exec` has `--ignore-user-config` (auth still comes from `CODEX_HOME`). `app-server --help` has no equivalent; use `-c` overrides or a dedicated `CODEX_HOME` with copied auth.
- **A `warning` notification arrives on the first turn:** "Under-development features enabled: default_mode_request_user_input". This comes from the user's config.
- **stderr carries ANSI escape codes.** Strip them, or set `NO_COLOR=1` / `RUST_LOG` (untested).
- **`thread.source` reported `"vscode"`** for an app-server client. Do not rely on it.
- **Line endings:** `codex.exe` is native, so `spawn('codex', args)` works without `shell`. Paths in JSON come back with escaped backslashes, and stdout was UTF-8 (the curly apostrophe in "can’t" was intact).
- **Version skew:** npm `@openai/codex` is at 0.160.0, while the installed desktop-bundled CLI is 0.153.4. Pin the protocol to the binary you spawn, and regenerate the schema per version.

## 2. Codex: other surfaces (brief)

`codex exec` flags (from help, not run):

- `--json` (JSONL events on stdout)
- `--output-schema <FILE>`, `-o/--output-last-message <FILE>`
- `-m`, `-s read-only|workspace-write|danger-full-access`, `-C <dir>`, `--add-dir`
- `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `-c key=value`
- Subcommands `exec resume [SESSION_ID|--last] [PROMPT]`, `exec fork`, `exec review`

`exec` is fire-and-forget: there is no steer or approval channel. The JSONL event names were not verified here. Prior knowledge says `thread.started`, `turn.started`, `item.started|updated|completed`, `turn.completed`, `turn.failed`, `error`; confirm before relying on them.

`codex mcp-server` (verified via `tools/list`, `protocolVersion 2025-06-18`):

- `codex`: required `prompt`; optional `approval-policy, base-instructions, compact-prompt, config, cwd, developer-instructions, model, sandbox`. Output `{threadId, content}`.
- `codex-reply`: required `prompt`; optional `threadId` (or legacy `conversationId`). Output `{threadId, content}`.
- It has no steer or interrupt tool. app-server is the richer choice.

## 3. Claude Code CLI 2.1.288 (`claude -p` stream-json)

**Not signed in, so no real model round trip was run.** Every flag and the control protocol below were verified locally with no auth; model calls returned an auth error. Re-run `scratchpad/protocol/claude-probe.mjs` after `claude auth login` (user action) to capture a real transcript.

### Flags (all accepted by the parser in one invocation)

- `-p --input-format stream-json --output-format stream-json --verbose` (`--verbose` is required for stream-json output)
- `--include-partial-messages` (token deltas as `stream_event`), `--replay-user-messages` (echo stdin user messages with `isReplay:true`)
- `--model haiku|sonnet|opus|fable|<full id>`, `--effort low|medium|high|xhigh|max`, `--fallback-model`
- `--max-turns N` is **hidden from `--help` but accepted**. `--max-budget-usd` also exists.
- `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`. This version has no `default` choice in help, but `default` was accepted.
- `--permission-prompt-tool stdio` (hidden) routes permission prompts to the host as `can_use_tool` control requests. `--permission-prompts host|none` is the default host; `none` auto-denies.
- `--allowedTools / --disallowedTools "Bash(git *) Edit"`, `--tools "Read,Edit"` (restricts the built-in set; `""` means none)
- `--json-schema '<schema>'` adds a `StructuredOutput` tool, which showed up in init `tools`.
- `--session-id <uuid>` (honoured: init echoed it), `-r/--resume <id>`, `-c/--continue`, `--fork-session`, `--no-session-persistence`
- `--append-system-prompt`, `--system-prompt[-file]`
- Isolation flags: `--bare`, `--safe-mode`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`, `--settings`
- Other: `--add-dir`, `--name`

### Input messages (stdin, one JSON per line, verified)

```json
{"type":"user","message":{"role":"user","content":"Reply with the word OK."},"parent_tool_use_id":null,"session_id":""}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Now reply with the word STEERED."}]},"parent_tool_use_id":null,"session_id":""}
```

Each user message produced its own turn: `system/init`, then `system/status{requesting}`, then `user` (replay), then `assistant`, then `result`. A second message sent mid-run was accepted and run after the first. Its true mid-turn behaviour, meaning a queue versus injection at a tool boundary, could not be observed without auth. The init capabilities `msg_lifecycle_v1`, `interrupt_cancel_queued_v1` and `interrupt_send_now_v1` suggest queued messages that can be cancelled or sent now.

### Control protocol (stdin/stdout, verified without auth)

```json
> {"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}
< {"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{"commands":[...],"agents":[...],"models":[...],"account":{"tokenSource":"none",...},"current_permission_mode":"default","session_state":"idle",...}}}
> {"type":"control_request","request_id":"req_2","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
< {"type":"control_response","response":{"subtype":"success","request_id":"req_2","response":{"mode":"acceptEdits"}}}
> {"type":"control_request","request_id":"req_3","request":{"subtype":"interrupt"}}
< {"type":"control_response","response":{"subtype":"success","request_id":"req_3","response":{"still_queued":[]}}}
```

- Other subtypes are present in the binary: `set_model`, `set_max_thinking_tokens`, `mcp_status`, `mcp_message`, `hook_callback`, `rewind_files`, `get_context_usage`, `stop_task`, `cancel_async_message`, `end_session`, `apply_flag_settings`.
- **Approvals:** with `--permission-prompt-tool stdio`, the CLI sends `{"type":"control_request","request_id":X,"request":{"subtype":"can_use_tool","tool_name","display_name","input","permission_suggestions","blocked_path","decision_reason","tool_use_id","agent_id",...}}`.
  - The host replies `{"type":"control_response","response":{"subtype":"success","request_id":X,"response":{"behavior":"allow","updatedInput":{...}}}}` or `{"behavior":"deny","message":"..."}`.
  - These field names come from strings in the binary. The flow was not exercised live.

### Output shapes (observed)

- `{"type":"system","subtype":"init","cwd","session_id","tools":["Read","StructuredOutput"],"mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode","claude_code_version":"2.1.288","capabilities":[...],...}`
- `{"type":"assistant","message":{...,"content":[{"type":"text","text":"..."}]},"session_id","uuid","error":"authentication_failed","is_api_error_message":true}`. The `error` and `is_api_error_message` fields appear only on error.
- `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error","session_id","num_turns":1,"total_cost_usd":0,"usage":{...},"modelUsage":{},"permission_denials":[],"duration_ms":269}`.
  - **`subtype:"success"` appears even when `is_error:true`**, so check `is_error` and `terminal_reason`.
  - With `--json-schema`, the structured result is expected in a `structured_output` field on `result`. That was not observed (no auth).
- Process exit code was `1` when not logged in.

### Windows quirks (verified)

- `spawn('...\\claude.cmd', args)` without a shell fails with **`EINVAL`** on Node 24 (the CVE-2024-27980 hardening). `shell:true` works, but it triggers DEP0190 and cmd.exe quoting hazards for JSON arguments like `--json-schema`.
- **Spawn `claude.exe` directly instead:** `path.join(npm prefix -g, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe')`. That needs no shell, and its argv is passed verbatim.
- `codex.exe` is already native.
- **Large argv:** to keep long system prompts and schemas off the command line, use `--system-prompt-file`. `--json-schema` takes a string; whether it also takes a path is untested.
- `-p` skips the workspace-trust dialog, and init loads the user's skills, plugins and memory. Use `--bare`, `--safe-mode` or `--setting-sources` for a clean worker.

## 4. SDK packages (`npm view`, not installed)

| Package | latest | Notes |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.288 (modified 2026-10-02) | Tracks CLI 2.1.288. It drives the same stream-json and control protocol. |
| `@openai/codex-sdk` | 0.160.0 (alpha 0.162.0-alpha.9) | Newer than the installed CLI 0.153.4. |
| `@openai/codex` | 0.160.0 | |
| `@anthropic-ai/claude-code` | 2.1.288 | Matches the installed version. |

## 5. What failed or was not verified

- **Claude real round trip:** not run because the CLI is not logged in. Not verified: the shape of a real `assistant` message, `stream_event` deltas, a `can_use_tool` request, `structured_output`, and how a mid-turn user message is handled.
- **Codex `turn/interrupt`:** not exercised on a live turn. Only the "no active turn" error was captured.
- **Codex approval request:** not triggered. The model declined on its own under the read-only sandbox.
- **Codex `turn/diff/updated`, fileChange and commandExecution items:** schema only, because the sandbox was read-only and no commands ran.
- **Codex exec `--json` event names:** not confirmed from the binary.
- **Real Codex usage:** 4 turns on gpt-5.6-luna at low effort, about 85k input tokens (mostly cached after the first turn) and 128 output tokens.
