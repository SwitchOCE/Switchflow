# One agent steering another: best practice (2026-10-03)

Scope: how to let Claude orchestrate or steer Codex inside Switchflow. Switchflow today drives Codex only through `codex exec --json --output-schema`, with `approval_policy="never"` and `workspace-write` (`template/.switchflow/scripts/control/codex-runner.mjs`). Local tools: codex-cli 0.153.4 and Claude Code 2.1.288. Bracketed numbers point to the Sources list.

## 1. Theo / T3: what his method actually is

There are two layers, and they are different things.

**Personal method (prompt level).** Theo's tweet of 2 Jul 2026 [1] lists it: Fable on "high" effort, never xhigh or max. Claude Code is taught to use Codex "as a fallback for lots of implementation tasks" ("GPT-5.5 is incredibly steerable, and Fable can learn how to steer it"). A CLAUDE.md section ranks which model gets which work. Token-hungry work such as computer use and codebase analysis goes to other models, which report back. A third-party summary of his video of 6 Jul [2] adds detail. Claude shells out to the Codex CLI through three skills: `codex-review`, `codex-implementation` and `codex-computer-use`. Codex gets bulk, mechanical and token-heavy work plus independent reviews. Fable keeps "taste" work (UI copy, API design) and final decisions. The summary also mentions worktrees per fix and human-gated merges. *I could not watch the video, so the details from [2] are unverified.* The "claudex" tweet [3] is a separate trick: a proxy that runs GPT models inside the Claude Code harness. It is not orchestration.

**Product method (T3 Code, MIT, about 24k stars) [4][5].** Read from source:
- **Provider abstraction:** `ProviderAdapterV2`, with `ensureThread/resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest` (approvals), `readThreadSnapshot`, `rollbackThread` and `forkThread`. It emits a typed event stream ending in `turn.terminal` (`completed|interrupted|cancelled|failed`). One runtime policy (mode, cwd, approval, sandbox) is mapped per provider.
- **Codex:** `codex app-server` over JSON-RPC. It uses `thread/start|resume|fork|read`, `turn/start`, `turn/steer {threadId, expectedTurnId, input}`, `turn/interrupt` and the `item/*/requestApproval` server requests.
- **Claude:** the `@anthropic-ai/claude-agent-sdk` `query()` call in streaming-input mode. Steering offers a new `SDKUserMessage` with `priority: "now"` into the live input queue, and interrupt calls `query.interrupt()`. Permissions go through `canUseTool`.
- **Cross-agent control (the "Codex subagents via Claude" branch [6], now shipped):** T3 injects its own `t3-code` MCP server into every agent, with `delegate_task` (provider and model per child, `async` or `wait`, task prompt only), `task_status`, `task_cancel`, `t3_thread_send` (`queue | steer | restart`), `t3_thread_wait` and `t3_thread_interrupt`. A child's result is steered back into the parent's active turn, or queued. The **host app**, not the agent, owns threads, worktrees and git-ref checkpoints.

## 2. Codex integration surfaces

| Surface | Steer mid-turn | Interrupt | Approvals to client | Structured output | Fit |
|---|---|---|---|---|---|
| `codex app-server` (JSON-RPC, stdio) [7] | `turn/steer` (needs `expectedTurnId`; no overrides) | `turn/interrupt` | Yes: `item/commandExecution\|fileChange\|permissions/requestApproval` | `outputSchema` per `turn/start` | OpenAI: "deep integration inside your own product" |
| `codex exec --json` [8] | No | Kill the process | No (sandbox only) | `--output-schema`, `-o`; `exec resume <id>` | CI and one-shot runs |
| TS SDK `@openai/codex-sdk` [9] | No | Not documented | No | `outputSchema` | Wraps `codex exec` JSONL |
| Python SDK `openai-codex` [10] | `TurnHandle.steer()` | Yes | `approval_mode` | `output_schema` | Built on app-server |
| `codex mcp-server` [11] | No (`codex-reply` = new turn) | No | Policy params only | No | Simplest agent-to-agent bridge |

Also available: `review/start` (a built-in reviewer, inline or detached) and `codex app-server generate-ts|generate-json-schema` for typed bindings. Switchflow already has these in `codex-protocol/`; `turn/steer` is in the stable, non-experimental schema of 0.153.4. **Recommended in 2026:** use app-server for programmatic orchestration. OpenAI's own Claude Code plugin wraps app-server, not exec [12].

## 3. Claude surfaces

- **Agent SDK `query()` in streaming-input mode.** Anthropic calls this "the preferred way" [13]. It supports queued messages, `interrupt()` (which returns a receipt of pending messages), `setPermissionMode()` and `setModel()` mid-session [14].
- **Steering via `priority` on `SDKUserMessage`** [14]:
  - `next` (default): read inside the same turn once the running tools finish.
  - `later`: held until the turn ends.
  - `now`: interrupts the turn, or with `origin.kind: "human"` moves running work to the background.
  - `shouldQuery: false` injects context without spending a turn.
- **Guardrails in the SDK** [14]: `canUseTool`, `permissionPrompts: 'none'` (deny anything that would prompt), `allowedTools`/`disallowedTools`, hooks, `maxTurns`, `maxBudgetUsd`, `outputFormat: {type:'json_schema'}`, plus subagents and in-process MCP servers.
- **`claude -p --output-format stream-json --input-format stream-json`** carries the same protocol without the SDK. Bare mode ignores the subscription login and needs `ANTHROPIC_API_KEY` [15].
- **Auth for a personal local tool.** The SDK runs the local Claude Code binary. Anthropic bars *third-party products* from offering claude.ai login [13]. A split with a separate SDK/`-p` credit was announced for 15 Jun 2026 but is **paused**: SDK and `-p` usage "still draw from your subscription's usage limits" [16]. Using the owner's own login in a personal local tool therefore appears permitted. *That conclusion is inferred, not stated by Anthropic; re-check before relying on it.*

## 4. Patterns in other tools

- **OpenAI `codex-plugin-cc` (official, about 34k stars) [12]:** read-only `/codex:review` and `/codex:adversarial-review`; `/codex:rescue` (a forward-only subagent, write access only with `--write`) plus status, result and cancel. An optional **Stop-hook review gate** lets Codex block Claude's stop when it finds issues; the plugin warns this can loop and burn limits. Defaults are `approvalPolicy: never` and `sandbox: read-only`, and reviews use a JSON schema.
- **Conductor, Vibe Kanban, Claude Squad:** one git worktree and branch per task, a diff/review step before merge, and an executor-per-agent abstraction (Vibe Kanban) [17][18]. Sculptor uses a Docker container per agent instead of worktrees [19].
- **Community skills:** "Fable plans → Codex builds → Fable reviews," with bounded loops (at most 5 planning rounds, at most 2 review rounds), falling back to Claude if Codex fails [20]. The same split is in [21].
- **ACP (Zed):** adapters exist for both agents (`codex-acp`, `claude-agent-acp`) [22]. But ACP turns can only be **cancelled**; mid-turn input is still an open RFD [23][24], and adapters lag their native protocols. T3 itself uses native protocols for Claude and Codex and ACP only for long-tail agents. ACP is **not** a good common layer for Switchflow yet.

Common guardrails across these tools:
1. Isolation per task (a worktree or container).
2. A sandbox at least as strict as the role needs; review is read-only.
3. Reviewer model ≠ author model.
4. Structured verdicts via JSON schema.
5. Bounded loops, turn caps and budget caps.
6. A human gate on merge.

## 5. Relative strengths (weak evidence; mostly practitioner reports)

- **Claude (Fable/Opus):** taste (UI, API design, copy), planning, long-session context retention, final judgement [2][21][25].
- **Codex (GPT-5.5/5.6):** highly steerable, token-efficient bulk implementation, migrations, log and spec digestion, computer use, and independent review (`/review`) [1][2][21].

Benchmarks are mixed [25][26]. Treat the split as a default routing table, not a law.

## 6. Recommendation for Switchflow

**Protocols.**
- **Codex:** move from `exec` to `codex app-server` over stdio, using bindings generated from the pinned CLI. Keep `exec` only as a fallback for reviewers that need no steering.
- **Claude:** use the TypeScript Agent SDK `query()` in streaming-input mode. Do not use ACP.

**Minimal provider abstraction** (a subset of T3's adapter):
```
openSession(policy) → Session
Session.startTurn(text, {outputSchema?}) → turnId
Session.steer(turnId, text)           // Codex turn/steer; Claude priority:"next"
Session.interrupt(turnId)             // turn/interrupt; query.interrupt()
Session.respond(requestId, decision)  // approvals / user input
Session.events: started | item | approval_request | completed{status, structuredResult, usage}
Session.resume(threadId) / close()
```
The policy fields are `{role, cwd (worktree), sandbox: read-only|workspace-write, approval: never|on-request, maxTurns, budget}`. Never pass `dangerFullAccess` or `bypassPermissions`.

**Steering, in order of preference:**
1. **Message mid-turn** for course corrections. On Codex use `turn/steer` with `expectedTurnId`. On Claude use `priority: "next"`.
2. **Interrupt and redirect** when the work is going the wrong way. Call `interrupt`, wait for the terminal event, then start a new turn on the same thread with the correction. Claude's `now` does both steps.
3. **Review and return** as the default loop. The author finishes; a different-model reviewer runs read-only (Codex `review/start` or a Claude SDK reviewer) and returns a JSON-schema verdict; blocking findings go back to the author as a new turn. Cap it at two rounds, then escalate to the owner.

Claude should steer through **Switchflow-owned MCP tools** (`delegate`, `status`, `send{queue|steer|restart}`, `interrupt`, `wait`), as T3 does. Claude should not shell out to `codex`. That keeps worktrees, sandbox policy, budgets and the event log in Switchflow, not in the model's hands.

**Guardrails.**
- One worktree per delivery task; author and reviewer are different models; reviewers are read-only.
- `approval: never` plus a tight sandbox and the existing writable-root allow-list. On Claude, `canUseTool` (or `permissionPrompts:'none'`) is the policy hook.
- Turn and budget caps per task, bounded steering loops, and every verdict stored as structured output.
- `expectedTurnId` so a stale turn is never steered.
- Human gates stay at Intake, Planning, UAT and merge.

**Not verified:** the details of Theo's video and of the CLAUDE.md section (secondary summary only), the exact current subscription terms for SDK use, and how mature the Python `steer()` is.

## Sources
1. https://x.com/theo/status/2072481845363822914 (read via api.fxtwitter.com)
2. https://uiuo.nl/youtube-summaries/8GRmLR__OGQ.html (summary of https://www.youtube.com/watch?v=8GRmLR__OGQ)
3. https://x.com/theo/status/2076114415368482854
4. https://github.com/pingdotgg/t3code (`apps/server/src/orchestration-v2/ProviderAdapter.ts`, `Adapters/CodexAdapterV2.ts`, `Adapters/ClaudeAdapterV2.ts`, `mcp/toolkits/orchestrator/tools.ts`, `provider/T3OrchestrationInstructions.ts`)
5. https://raw.githubusercontent.com/pingdotgg/t3code/main/AGENTS.md
6. https://x.com/theo/status/2072869036615155735
7. https://learn.chatgpt.com/docs/app-server
8. https://learn.chatgpt.com/docs/non-interactive-mode
9. https://github.com/openai/codex/blob/main/sdk/typescript/README.md
10. https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md
11. https://developers.openai.com/codex/guides/agents-sdk
12. https://github.com/openai/codex-plugin-cc
13. https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode ; https://code.claude.com/docs/en/agent-sdk/overview
14. https://code.claude.com/docs/en/agent-sdk/typescript
15. https://code.claude.com/docs/en/headless
16. https://support.claude.com/en/articles/15036540
17. https://www.conductor.build/workflows
18. https://virtuslab.com/blog/ai/vibe-kanban/
19. https://docs.imbue.com/features/containers
20. https://www.chaseai.io/blog/combine-fable-5-and-soul-5-6-skill
21. https://x.com/MatthewBerman/status/2073475032274338119
22. https://github.com/zed-industries/codex-acp ; https://github.com/agentclientprotocol/claude-agent-acp
23. https://agentclientprotocol.com/protocol/prompt-turn
24. https://github.com/agentclientprotocol/agent-client-protocol/pull/2255
25. https://composio.dev/content/claude-code-vs-openai-codex
26. https://agents-last-exam.org/blogs/agent-showdown
