# Running Switchflow agents off the local PC: Codex cloud and remote machines

Date: 2026-10-03. Local CLI checked: `codex-cli 0.153.4`, signed in with ChatGPT. No cloud task was started; `codex cloud list --json` returned no tasks. Nothing in `~/.codex` was changed.

## Bottom line

- **Codex cloud can be driven from Switchflow today only through the experimental `codex cloud` CLI.** It is fire-and-forget: submit a task, poll it, fetch the diff, apply it. There is no public API for cloud tasks, no follow-up or steering, and no cancel from the CLI. The app-server protocol has no cloud-task methods.
- **Codex Cloud was relaunched on 2026-09-29.** The new version has reusable "published" environments, a VM per task, and task state kept for 7 days. The old version is now labelled "Codex Cloud (Legacy)". Which of the two the CLI targets is not documented. Treat the cloud adapter as unstable.
- **A remote Linux box running the same stack Switchflow already drives locally is the sensible main path.** That means `codex app-server` and the Claude CLI, plus worktrees. It keeps streaming, steering, interrupt, both providers, and the existing event model. You change transport only: stdio over SSH, or an app-server WebSocket over a private network.
- **Codex has an experimental split mode in the CLI.** The model and thread stay in the local app-server, and shell/file tools run on a remote `codex exec-server` (`environment/add`, plus `environments` on `thread/start`/`turn/start`). It is promising but undocumented and gated behind `experimentalApi`. Watch it; don't build on it first.

---

## 1. Codex cloud

### 1.1 What it is now (post 2026-09-29 relaunch)

- You **publish** an environment once. It holds the GitHub repos, the installed tools and dependencies, env vars, network secrets, and the internet access policy. Each task starts in its own isolated workspace copied from that prepared filesystem. Sources: [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), [TechCrunch](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/), [SiliconANGLE](https://siliconangle.com/2026/09/29/openais-codex-gets-reusable-cloud-environments-that-follow-developers-across-devices/).
- **VM size depends on the plan.** Plus gets 2 vCPU, 8 GiB RAM and 8 GiB disk. Pro, Business, Enterprise and Edu get 4 vCPU, 16 GiB RAM and 32 GiB disk. Enterprise can ask for larger VMs. A task's VM state can be recovered for up to 7 days after its last turn. Source: [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments).
- **Network.** The default preset is "Package managers", which allows npm, PyPI, crates, Go, Maven, GitHub source and LFS. You can add more domains under "Additional allowed domains". Admins can enforce workspace-level policy. Source: same page.
- **Where tasks can start:** web, the desktop app, mobile (published environments only), Slack, Teams (Enterprise), and the CLI (`codex cloud`). Sources: same page, [nerdschalk](https://nerdschalk.com/codex-cloud-code-review-security-cloud/).
- **Not supported yet:** GitLab, GitHub Enterprise Server, and computer/browser use. GitHub.com is required.
- **The legacy model is still documented.** It uses a setup script, which has internet access, and an optional maintenance script. It distinguishes env vars, which last for the whole task, from secrets, which are only available to the setup script. Agent internet is off by default, with "limited" or "unrestricted" options behind a proxy. Containers are cached for up to 12 hours, and the cache is cleared when scripts, env vars or secrets change. The base image is [`codex-universal`](https://github.com/openai/codex-universal). Source: [Codex Cloud (Legacy)](https://learn.chatgpt.com/docs/environments/cloud-environment). The legacy version still powers code review and the GitHub, GitLab and Linear integrations ([agent37 write-up](https://www.agent37.com/blog/codex-cloud)).
- **The migration is unfinished.** Environments created in the desktop app don't show on chatgpt.com, which lists only legacy environments ([openai/codex#49966](https://github.com/openai/codex/issues/49966)).

### 1.2 Auth and billing

- **ChatGPT sign-in only.** Plus or higher is required. API-key users get no cloud chats or environments ([Pricing](https://learn.chatgpt.com/docs/pricing.md)). In the CLI source, every `codex cloud` command requires ChatGPT backend auth ([cloud-tasks/src/lib.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/lib.rs)).
- **Usage comes from the same plan allowance as local Codex.** "Cloud tasks may use more of your allowance than local messages." Since April 2026, billing has been token-based credits ([Pricing](https://learn.chatgpt.com/docs/pricing.md), [verdent](https://www.verdent.ai/guides/codex-pricing-2026)). The docs list no separate VM charge. Some third-party posts quote container fees per 20 minutes; they are unconfirmed.
- **No published concurrency cap for cloud tasks.** `--attempts` (best-of-N) is capped at 4 according to [this guide](https://codex.danielvaughan.com/2026/05/19/codex-cli-cloud-delegation-workflows-plan-locally-execute-remotely-apply-diffs/).

### 1.3 CLI surface (from the installed 0.153.4 help)

`codex cloud` is marked `[EXPERIMENTAL]`. Running it with no subcommand opens the TUI browser.

| Command | Purpose | Flags / output |
|---|---|---|
| `codex cloud exec --env <ENV_ID> [QUERY]` | Submit a task | `--attempts <N>` (best-of-N, default 1). `--branch <BRANCH>` defaults to the current branch, then the default branch, then `main`. The branch must exist on GitHub. Prints the **task URL** only. `--env` matches an ID, then a case-insensitive label. |
| `codex cloud status <TASK_ID>` | Show status | Plain text with no `--json`. **Exit code 0 only when Ready, otherwise 1.** |
| `codex cloud list` | List tasks | `--env`, `--limit 1-20`, `--cursor`, `--json`. The JSON has `tasks[]` with `id, url, title, status, updated_at, environment_id, environment_label, summary, is_review, attempt_total`, plus `cursor`. |
| `codex cloud diff <TASK_ID>` | Show the unified diff | `--attempt <N>` |
| `codex cloud apply <TASK_ID>` | `git apply` the diff locally | `--attempt <N>`. Exit code 0 on success, 1 on partial apply or conflict. |
| `codex apply <TASK_ID>` | Older alias | Applies the latest diff |

Task IDs can be given as URLs; the CLI strips the extra parts. Source for the output and exit codes: [cloud-tasks/src/lib.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/lib.rs). Docs: [CLI reference](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli).

**What the CLI cannot do.** The underlying client trait ([cloud-tasks-client/src/api.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks-client/src/api.rs)) has these methods: `list_tasks`, `get_task_summary`, `get_task_diff`, `get_task_messages`, `get_task_text`, `list_sibling_attempts`, `apply_task_preflight`, `apply_task`, and `create_task(env, prompt, git_ref, qa_mode, best_of_n)`.

- It has **no follow-up, steer, cancel, PR creation, or environment listing.**
- Task status is one of `Pending | Ready | Applied | Error`. Attempt status is one of `Pending | InProgress | Completed | Failed | Cancelled`.
- You can't discover environment IDs from the CLI, except through the TUI. An open request asks for `env list/resolve`, `wait`, `logs`, `message`, `cancel` and `env create` ([openai/codex#24777](https://github.com/openai/codex/issues/24777), opened 2026-05-27).
- Follow-ups, "Create PR" and commits happen in the web or desktop UI only.

**Is there a programmatic API?** No public one.

- The CLI calls private ChatGPT backend endpoints (`https://chatgpt.com/backend-api`, "wham" paths, overridable with `CODEX_CLOUD_TASKS_BASE_URL`). Calling those directly is undocumented and could break at any time.
- One SEO article describes a "`/v1/codex/cloud/tasks`" API with `openai.beta.codex.cloud.create()`. Nothing in OpenAI docs supports it, so treat it as fabricated.
- The Codex SDK only controls *local* agents ([Codex SDK](https://learn.chatgpt.com/docs/codex-sdk.md)).

**Can app-server target cloud?** Not for cloud tasks. The full method list, generated with `codex app-server generate-json-schema --experimental`, has `thread/*`, `turn/start|steer|interrupt`, `review/start`, `command/exec`, `fs/*` and so on. None of them is a cloud-task method. It does have two related remote features:

- **Experimental remote execution environments.** You start `codex exec-server --listen ws://IP:PORT` on another machine. The local app-server registers it with `environment/add {environmentId, execServerUrl}`, checks it with `environment/info` and `environment/status`, and selects it with `environments: [{environmentId, cwd}]` on `thread/start`/`turn/start`. It also emits the notifications `thread/environment/connected|disconnected`. Inference stays local; commands and file I/O run remotely. This needs `capabilities.experimentalApi: true`; Switchflow currently sends `false`. Added in [openai/codex#21323](https://github.com/openai/codex/pull/21323), merged 2026-05-08, aimed at "downstream services". The public [App Server docs](https://learn.chatgpt.com/docs/app-server.md) mention only `environment/info`.
- **Remote transport for the whole app-server.** Options are `--listen ws://...` with `--ws-auth capability-token|signed-bearer-token`, `codex app-server daemon bootstrap` ("for SSH-driven use"), and `codex remote-control`. The ChatGPT desktop app uses this to run Codex on SSH hosts ([Remote connections](https://learn.chatgpt.com/docs/remote-connections.md)). OpenAI warns not to expose these transports to a public network; use a VPN or mesh network instead.

### 1.4 How a Switchflow "codex-cloud" adapter would work

1. **Preflight.** Push the task branch to GitHub; cloud checks out from GitHub, never from local files.
2. **Start.** Run `codex cloud exec --env <id> --branch <b> [--attempts N] "<prompt>"` and parse the task ID from the URL it prints.
3. **Poll.** Every 30–60 s, run `codex cloud list --json --env <id>` and match on `id`. This gives `status`, `summary` and `updated_at`, and is easier to parse than `status`. Use `status`'s exit code as a quick check for Ready. There is no event stream.
4. **Result.** Run `codex cloud diff <id> [--attempt N]`, then `git apply` it into a fresh local worktree on a new branch. This lets Switchflow's normal review and gate run against it. Prefer this over `codex cloud apply`, which writes into whatever directory you are in.
5. **Steer, interrupt, PR.** None are available from the CLI. Show a "continue in ChatGPT" link instead (the task URL).
6. **Prompt size.** Prompts go in argv, so watch the Windows command-line length limit (about 32K characters). Send long prompts as a file in the repo, for example `TASK.md` on the pushed branch, and use a short pointer prompt.
7. **Environment ID.** It must be configured once by hand, by copying it from the TUI or web. It cannot be discovered by script yet.

---

## 2. Remote machines (run the existing stack elsewhere)

What it takes in every case:

- Install Node, git, `codex` and `claude` on Linux.
- Clone the repo and create worktrees there.
- Switchflow on the PC spawns the CLIs remotely, either as `ssh host -- codex app-server` with the same JSON-RPC over stdio, or as `ssh host -- claude -p ... --output-format stream-json`.
- Results come back as a **git branch pushed to the shared remote**, which Switchflow fetches into a local worktree for review and UAT. For small changes you could also stream `git diff` over the same channel.

**Credentials on the remote side:**

- **Codex:** ChatGPT sign-in with `codex login --device-auth`, or copy `~/.codex/auth.json`, which must be treated as a password ([Codex auth](https://developers.openai.com/codex/auth)). `CODEX_API_KEY` also works, but bills to the API.
- **Claude:** `claude setup-token` makes a token valid for about 1 year; set it as `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max) ([guide](https://codeongrass.com/blog/how-to-run-claude-code-on-a-remote-server/)). Otherwise use `ANTHROPIC_API_KEY`.
- **GitHub:** a fine-grained PAT or deploy key limited to the repo, for push.
- **Sandboxes:** pass all of these in as env vars or secrets per sandbox. Never bake them into images.

| Option | Setup effort | Cost ballpark (Oct 2026) | How Switchflow drives it | Notes |
|---|---|---|---|---|
| **Home server / spare PC** (Linux or WSL) | Low–medium (SSH keys, Tailscale) | Electricity only | SSH + CLI (stdio app-server), or app-server WS over Tailscale | Best match for "resource-limited PC". Always on, files persist, no per-minute billing. |
| **VPS** (for example Hetzner) | Low–medium | about €6.49/mo for 4 vCPU / 8 GB (CX33); about $24/mo CPX31 ([bitdoze](https://www.bitdoze.com/md/hetzner-cloud-cost-optimized-plans.md), [sparecores](https://sparecores.com/server/hcloud/cpx31)) | Same as above | Cheapest always-on option. You maintain it and harden SSH. |
| **GitHub Codespaces** | Low (devcontainer.json) | 120 free core-hours/mo (Free), 180 (Pro). Then $0.18/h for 2-core, $0.36/h for 4-core, plus $0.07/GB-month storage ([GitHub docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)) | `gh codespace create/ssh/stop/delete`, then SSH + CLI | Repo and GitHub auth already set up. Idle timeout stops it, and stopped codespaces keep their disk. Good for burst use. |
| **Dev Container / Docker on a remote host** | Medium | Same as the host | `docker -H ssh://host exec` or the devcontainer CLI | Gives reproducible per-repo images on a VPS or home server. One container per task gives isolation. |
| **E2B** | Medium (SDK + template) | about $0.05/vCPU-h + $0.016/GiB-h (2 vCPU / 4 GiB ≈ $0.17/h). $100 free credit, Pro plan $150/mo ([morphllm](https://www.morphllm.com/e2b-pricing)) | TS SDK: create sandbox, `commands.run` with streaming, files API, kill | Per-second billing, fast start, session length limits depend on tier. |
| **Daytona** | Medium | About the same as E2B per vCPU/GiB. $200 free credit ([beri.net](https://www.beri.net/tools/daytona)) | TS/Python SDK, SSH access | Sandboxes can be stopped and resumed with state kept. |
| **Modal Sandboxes** | Medium | About $0.14/physical core-h (sandbox rate), plus $0.024/GiB-h ([beam.cloud](https://www.beam.cloud/blog/modal-pricing-explained)) | Python/JS SDK `Sandbox.create/exec` | gVisor isolation, good for many short tasks. |
| **Cloudflare Sandbox** | Medium–high (Workers + DO + container image) | Workers Paid $5/mo. Then $0.000020/vCPU-s, $0.0000025/GiB-s ([Cloudflare docs](https://developers.cloudflare.com/sandbox/platform)) | A Worker you write exposes exec/stream/files; Switchflow calls it over HTTPS/WS | Most custom code. Worth it only if you want a hosted control plane. |

**Rough per-task cost.** At about 30 minutes on 2 vCPU / 4 GiB, a sandbox costs a few cents to $0.10 in compute. The model usage is the same as it would be locally, through the ChatGPT or Claude plan or API. At steady use, a €7–25/mo VPS or a home box costs less than per-second sandboxes. Sandboxes are better for bursty work and many tasks at once.

**Claude's own cloud.** Claude Code on the web runs cloud sessions, uses `&` background tasks, and can teleport a session to local ([dev.to](https://dev.to/proflead/claude-code-tutorial-syncing-web-sessions-to-local-cli-34e0)). Like Codex cloud, it is driven from the UI or CLI rather than a stable task API. If you add it, treat it as a "vendor cloud" adapter with the same limits.

---

## 3. Recommended "environments" abstraction for Switchflow

Today a provider (`codex` = `openCodexSession`, `claude` = `openClaudeSession`) returns a session handle with `startTurn`, `steer`, `interrupt` and close, and emits normalized events. Keep that, and add **environment** as a separate axis. **Agent = provider × environment.** The one exception is a vendor-cloud environment, which bundles its own agent.

### 3.1 Environment adapter contract

```
interface EnvironmentAdapter {
  id, kind: 'local' | 'ssh' | 'codespace' | 'sandbox' | 'codex-cloud'
  capabilities(): {
    providers: ['codex','claude'] | ['codex-cloud'],
    stream: boolean, steer: boolean, interrupt: boolean, followUp: boolean,
    resultKind: 'worktree' | 'branch' | 'diff',
    maxConcurrent?: number, costModel: 'none'|'plan'|'metered',
  }
  health(): {ready, detail}              // reachability, CLI versions, auth present (never values)
  prepare({repo, baseBranch, taskBranch}): Workspace  // worktree / clone / push branch for cloud
  spawn(argv, {cwd, env}): ChildLike     // stdio pipe; local=child_process, ssh=ssh -T, sandbox=SDK exec
     // providers keep their JSON-RPC / stream-json code unchanged on top of spawn()
  submit?({prompt, workspace, attempts}): RemoteTaskRef   // only for vendor-cloud kinds
  poll?(ref): {status, summary, updatedAt}
  collect(workspace|ref): {branch?, diff, files, summary}  // always lands in a LOCAL review worktree
  cleanup(workspace|ref, {keepBranch})
  usage?(): {spentMinutes?, credits?, limit?}
}
```

Rules that keep the current safety model:

- **Sandbox policy is unchanged.** `workspace-write`/`read-only`, absolute approved roots, and no `danger-full-access` still apply. Remote paths are checked against the remote workspace root, not Windows paths.
- **Results always become a local worktree and branch.** Review, gates and UAT then run unchanged, whichever environment produced the work.
- **Secrets come from Switchflow's own store or the remote's own login.** They are never written into prompts, logs or URLs. `health()` reports only whether auth is present.
- **Cost and limit tracking per environment.** Cap concurrent tasks and minutes per run, and kill or stop sandboxes and codespaces on cleanup or idle.

### 3.2 Capability matrix

| Environment | Codex | Claude | Stream events | Steer | Interrupt | Follow-up turns | Result |
|---|---|---|---|---|---|---|---|
| local (today) | app-server + exec | stream-json | yes | yes | yes | yes | local worktree |
| ssh (home box / VPS / WSL) | app-server over `ssh -T` | `ssh -T claude -p` | yes | yes | yes | yes | pushed branch, then fetch |
| codespace | same as ssh, via `gh codespace ssh` | same | yes | yes | yes | yes | pushed branch |
| sandbox (E2B/Daytona/Modal) | SDK exec of app-server stdio | SDK exec | yes (if the exec stream is bidirectional) | yes | yes | yes | pushed branch or diff |
| codex-cloud | `codex cloud exec` | n/a | **no** (poll) | **no** | **no** | **no** (UI only) | diff, then local worktree |
| codex exec-server split (experimental) | local app-server, remote tools | n/a | yes | yes | yes | yes | files live remotely; push branch |

### 3.3 Minimum viable slice (build in this order)

1. **Refactor for `spawn()`.** Pull process spawning out of `providers/codex-app-server.mjs` and `providers/claude-cli.mjs` into an `environment.spawn(argv, {cwd, env})`, and make `local` the default. This changes no behaviour and keeps existing tests green.
2. **Add an `ssh` environment.** Config is `{host alias, remoteRoot}`. `prepare` runs `git fetch`, then `git worktree add` on the remote. `spawn` runs `ssh -T host -- <argv>`. `collect` runs `git push origin taskBranch` remotely, then `git fetch` and a worktree locally. `health` checks `codex --version`, `claude --version` and `codex login status` remotely. This one adapter covers a home server, a VPS, WSL, and Codespaces (via its `gh codespace ssh` config) with full capabilities. Expect 1–2 days of work.
3. **Add a `codex-cloud` environment as a limited, opt-in adapter.** It works by submit, list-poll, diff, then a local worktree. The UI marks it "no steer/interrupt; follow up in ChatGPT" and shows the task URL. The environment ID is configured by hand. Gate it behind a feature flag, because the CLI is experimental and the cloud is mid-migration.
4. **Later.** Add a sandbox adapter (E2B or Daytona) once you need bursts of parallel tasks. Re-check the exec-server `environment/add` path when it reaches the documented, non-experimental API.

**Skip for now:** calling the private ChatGPT `wham` endpoints directly, Cloudflare Sandbox (too much custom infrastructure for one user), and exposing app-server WebSockets beyond loopback or Tailscale.
