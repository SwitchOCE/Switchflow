# Agent environments: design

Status: proposed, 2026-10-03. Phases 1–4 built 2026-10-04 (see Phases). Evidence: [webatrice-trial.md](webatrice-trial.md), [claude-cloud.md](claude-cloud.md), [codex-cloud-and-remote.md](codex-cloud-and-remote.md).

## The problem, from the Cockatrice parity run

- **Memory is the binding limit, not CPU.** Ten parallel Opus workers on this 32 GB PC produced five JavaScript heap out-of-memory crashes in sixteen minutes (Vitest defaults to about 18 workers each), then the Claude app crashed. One agent's full gate peaks near 6 GB, so about five gates fill the machine. The orchestrator fell back to five agents and `--maxWorkers=2` by hand.
- **Disk adds up.** Each worktree is about 565 MB, nearly all of it its own `node_modules`; 18 worktrees took 9.4 GB and 1.3 M files.
- **Shared resources were coordinated by hand.** One Docker stack and fixed ports meant e2e runs queued on a `mkdir` lock for up to 30 minutes, and leftover WebKit processes hung Playwright for two hours before anyone noticed.
- **Recovery and waiting cost the owner.** Ten agents were resumed one by one after the crash; the orchestrator posted 41 "Still running." turns.
- **Going remote was slow and leaky.** Setting up the cloud side took about three hours, forced a public fork (reversing a local-only decision), and `isolation: "remote"` silently ran locally.

## Two layers

### 1. Local capacity management (no new environment, no money)

Switchflow already owns worker spawning, worktrees and a restart fence, so it can stop the machine being overcommitted:

- **Memory admission.** A project profile declares a per-worker budget (for example 1.5 GB idle, 6 GB while gating). `delegate_task` admits a worker only when the budget fits the machine's free memory with headroom; otherwise it queues and says so. The orchestrator sees "queued: needs 6 GB, 4 GB free".
- **Gate slots.** Heavy steps (full test gate, e2e) take a named slot. Slot counts come from the profile (`gate: 2`, `e2e: 1`). This generalises today's suite lock.
- **Leases, not locks.** Every slot and shared resource (Docker stack, a port range) is a lease with an owner, a time limit and automatic release when the worker ends, crashes or overruns. No more hand-made `mkdir` locks.
- **Test-worker caps.** The profile sets environment variables the host injects into every worker (`VITEST_MAX_WORKERS`, `JEST_WORKERS`, `NODE_OPTIONS=--max-old-space-size=…`), so caps don't depend on each agent remembering.
- **Process cleanup.** When a worker's session closes, the host kills the rest of its process tree (dev servers, browsers), using the SF-27 tree-kill path.
- **Shared dependencies (optional, per project).** Install into worktrees from a shared store (pnpm store, or hard-linked `node_modules` when the lockfile matches) so a worktree costs megabytes, not 565 MB.
- **One-step recovery.** The worker registry already survives restarts; add "resume all held workers" after the owner confirms the fence.

### 2. Environments: where a worker runs

Provider (Claude or Codex) stays the choice of *who*; environment becomes the choice of *where*. Each environment adapter declares its capabilities, and Switchflow never pretends a missing one exists.

| Environment | How it runs | Stream / steer / interrupt | Results come back as | Billing | Code leaves the PC to |
|---|---|---|---|---|---|
| **Local** (today) | CLIs on this PC | yes / yes / yes | local worktree | subscriptions | nowhere |
| **SSH box** (home server, VPS, codespace) | the same CLIs over `ssh` stdio, worktrees on the box | yes / yes / yes | branch pushed to a git remote both sides reach (the box itself can be that remote) | subscriptions + the box | your box only |
| **Claude self-hosted environment** (`claude --environment ccpool_…`) | Anthropic-controlled session executing on your box | to verify | to verify | subscription | your box (conversation via Anthropic, as today) |
| **Claude Code cloud** (routines started through the CLI, claude.ai/code) | Anthropic sandbox, GitHub repo | polled log (~1 min) / message into the session (~2 s, taken at the next turn boundary) / no | `claude/*` branch on GitHub, fetched into the local candidate | subscription | GitHub + Anthropic |
| **Claude Managed Agents** (API) | Anthropic sandbox, programmable environments | yes / yes / yes (events API) | branch on GitHub | API key, per token | GitHub + Anthropic |
| **Codex cloud** | OpenAI VM per task | no / no / no (submit, poll, diff, apply) | diff applied into a local worktree | ChatGPT allowance (cloud costs more) | GitHub + OpenAI |

Adapter contract: `health()`, `capabilities`, `prepare(workspace)`, `start(task)` → session (or `submit` for fire-and-forget), `collect()` into a local candidate worktree via git, `cleanup()`, `usage()`. The orchestration bridge, reviews and the approach gate stay host-side, so remote workers are reviewed and merged locally exactly like local ones.

**Placement.** Per project: which environments are allowed (the owner's privacy decision). Per role or per task: a preferred environment, with rules such as "heavy gate → SSH box", "e2e needing the locally built image → local". If the preferred environment is unavailable the task waits and says why; it never silently falls back to local.

## Phases

1. **Local capacity management** (above). No decisions needed; removes the crash class seen in the trial. **Status: built 2026-10-04.** What shipped, documented in `docs/browser-control.md` "Capacity":
   - `.switchflow/capacity.json` profile, strictly validated; defaults (1.5 GB idle, 6 GB gating, 3 GB headroom; leases `gate` 2, `e2e` 1, `suite` 1) apply when it is absent or invalid.
   - Memory admission: `delegate_task` queues first in first out with a reason ("needs 1.5 GB, 0.8 GB available") instead of overcommitting, and queued workers start by themselves.
   - Leases `acquire_lease` / `release_lease` / `list_leases` with counts, time limits, gating memory, release on any session end, and persistence across restarts (kept while the restart fence holds their run). The suite lock is the lease `suite`.
   - `workerEnv` caps injected into every agent process, under a deny policy for paths, homes, agent and Git configuration, loaders and secrets.
   - Process cleanup of each closed session's leftover processes, guarded by start times.
   - "Resume N held workers" after a restart: the next execution run re-delegates the interrupted run's queued and open workers with their original instructions. Provider-level resume of local sessions is not used; remote workers are recovered (phases 2–4).
   - A capacity strip in the Agents view.
   - Shared dependencies, opt-in (`dependencies: { mode: "link" }`, `dependencies.mjs`). When a new candidate's npm lockfile matches the primary's and the primary's install matches its lockfile, `node_modules` is a real folder of junctions or symlinks into a store under the project state: one copy of the primary's folder per lockfile and install, sealed read-only (on Windows also with an inherited deny entry, since read-only attributes do not stop renames or new entries) and checked against its manifest before each use. Nothing links to the primary's own folder. Hardlinks were rejected because an in-place edit or a cleared read-only flag would reach every copy, and the primary; reflinks fall back to full copies on NTFS and ext4. Anything unexpected leaves the candidate for a normal install, with the reason. On a 67,000-file, 217 MB fixture: 0.6 s and 0.2 MB per worktree instead of 55–75 s and 217 MB, plus 228 MB and about 73 s once per lockfile.
   - Per-worker port blocks (`ports: { base, blockSize, blocks }`, injected as `SWITCHFLOW_PORT_BASE` and `SWITCHFLOW_PORT_COUNT`, counted per environment) and a compose project per worker (`COMPOSE_PROJECT_NAME=sf-<id>`), with opt-in `docker compose -p … down --remove-orphans` at session end (`docker.composeDown`). Together they remove the trial's shared e2e stack and fixed ports.
   - Leases named at delegation (`delegate_task` `leases`), held by the worker's session, so remote workers get gate and e2e leases too; each environment declares its own lease pool.
2. **Environment abstraction + SSH box.** Move process spawning behind a local environment adapter with no behaviour change, then add SSH. Full capabilities; code stays on hardware the owner controls; no GitHub requirement (the box can host the git remote). **Status: built 2026-10-04**, documented in `docs/browser-control.md` "Environments and SSH boxes"; real runs in [ssh-real-run.md](ssh-real-run.md).
   - `environments/index.mjs`: the contract and the one registry (local, ssh, claude-cloud). Local is today's spawn, unchanged.
   - `environments/ssh.mjs`: CLIs over `ssh -T` under a `setsid` wrapper that records the remote PID (fenced with the environment id); kill over a second connection; bare mirror on the box, remote worktree per worker, host commits each writable turn and fast-forwards the local candidate.
   - Environments and `placement` (delivery, review) are owner agent settings; unhealthy or unconfigured environments are refused with their reason, never replaced by local.
   - Agents view: "Where workers run" with Test connection, SSH add/edit and "Runs on"; sessions show their environment.
   - Found in the real run: WSL stops an idle distro even with ssh sessions open, hence `keepAwake`.
   - SSH workers skip local memory admission and queue against the box's own `maxWorkers` (default 2). They get no lease tools: the lease server is a host-local stdio process on loopback, and leases describe this PC's resources. Since then the orchestrator names their leases at delegation, from the box's own pool.
  - Restart recovery (built 2026-10-04): the remote CLI dies with its ssh connection, so a held SSH worker is delegated again, but first its remote worktree's uncommitted changes are committed on the box, fetched to `refs/switchflow/recovery/<worker>`, and the new worker starts from that commit with a note that it continues interrupted work. An unreachable box keeps the workers held with the reason. Workspace cleanup also removes Claude's conversation folder for that worktree on the box (exact encoded path, kept if any conversation ran elsewhere); Codex session files are left, since Codex indexes them in its own state.
3. **Claude subscription cloud.** **Status: adapter built 2026-10-04** (`environments/claude-cloud.mjs`, documented in `docs/browser-control.md` "Claude cloud workers"). Probe results with Claude Code 2.1.288: `claude -p --cloud "<task>"` is refused (new cloud sessions are interactive only); a headless `claude -p --tools RemoteTrigger` turn drives the routines API with the CLI's sign-in (create, update, run, list_runs, get_run_log; no delete); `claude -p --cloud <session_id>` delivers follow-ups into a routine session in about 2 s; a routine's `allowed_tools` does not restrict the session, so the approach turn is read-only by instruction plus a host push check. Self-hosted `--environment ccpool_…` was not probed. Restart recovery (built 2026-10-04): the worker handle (session, routine, branches, URL, run-log position, open turn) is kept in the worker ledger, and resuming reconnects to the running session instead of delegating again.
4. **Codex cloud**, opt-in, fire-and-forget, behind a flag (the relaunch on 2026-09-29 is still settling). **Status: adapter built 2026-10-04** (`environments/codex-cloud.mjs`, documented in `docs/browser-control.md` "Codex cloud workers"). It was checked against the codex-cli 0.153.4 help and the cloud-tasks source; no task was submitted.
   - Opt-in per entry (`experimental: true`). It submits with `codex cloud exec --env --branch sf-task/<key>` (the host pushes under the owner's `push` grant), polls `codex cloud status`, and reads `codex cloud diff`. The host applies the diff with `git apply --check` first and commits it in the clean candidate.
   - No CLI command returns the worker's messages, so its JSON reply travels in the diff as `.switchflow-result.json`, which is never applied.
   - No approach turn (`approachGate: false`), so `delegate_task` refuses delivery there. Reviews run read-only on every turn, and their diffs are never applied. A Claude provider is refused on codex-cloud, and a Codex provider on claude-cloud.
   - Restart recovery (built 2026-10-04): a held task is reconnected by its task ID and polled on; it is not submitted again.
5. **Managed Agents API** only if per-token billing is wanted.

## Decisions for the owner

1. Which remote target to build after phase 1: an SSH box you control, Claude's subscription cloud, or both.
2. Whether project code may go to GitHub (private repository with the Claude GitHub App) for cloud workers, or must stay on hardware you control.
3. If an SSH box: an existing machine, or a rented one. The trial's gate needs about 6 GB per worker, so a box for three parallel gates wants 24 GB or more.
