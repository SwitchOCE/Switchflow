# Webatrice parity trial: what ran, where it hurt, what could move

Read-only look at the Webatrice "parity run" on 2026-10-03, taken as the example of how the owner works today. All times are AEST (UTC+10).

**Main sources:**
- Orchestrator session "Cockatrice duplication gaps and PR readiness": `C:\Users\keech\.claude\projects\C--Users-keech-Documents-Webatrice\43f1066b-2abd-48e9-990f-9ef354f74b63.jsonl` and its `subagents\` folder (26 agent transcripts plus `.meta.json` files)
- Scratchpad: `C:\Users\keech\AppData\Local\Temp\claude\C--Users-keech-Documents-Webatrice\43f1066b-…\scratchpad\`
- Run notes: `C:\Users\keech\Documents\Webatrice\.parity-run\` (`plan.md`, `agent-brief.md`, `cloud-viability.md`, `cloud-setup.sh`, `prs\`)
- Hardware sessions from the same day: "Hardware bottleneck options" and "RAM and SSD upgrade for PC"

The run was still live when this was written: at 23:24 the orchestrator started 3 cloud workers.

## 1. What the trial is

**Goal.** At 14:19 the owner asked for every remaining Cockatrice-parity gap in Webatrice to be closed as a series of upstream-quality stacked PRs, and said they would not be around to supervise. The scope is about 22 planned PRs (`plan.md` table).

**How it was orchestrated:**
- **One Opus 5.5 orchestrator session** wrote the plan, the gap tables, a shared `agent-brief.md` and a progress log (`plan.md`). It created a git worktree and branch per PR itself (`Webatrice-parity-*`, 18 worktrees on `parity/NN-*` branches, all from one repo; `git worktree list`).
- **Workers were Claude Agent-tool subagents**, all `general-purpose`, all on Opus 5.5:
  - 24 of the 26 Agent calls set `run_in_background: true`.
  - One worker per PR, each told to work only in its own worktree.
  - Workers committed locally and wrote their PR text to `.parity-run/prs/`.
- **No Codex workers ran.** Codex appears only as the author of an earlier audit, from 2026-08-24.
- **26 agents in total:**
  - 20 coding workers: PR01, 02, 04, 05 (stages 1–4), 06, 09–16 and 18–21.
  - 2 Explore re-audits.
  - 1 cloud-viability assessor.
  - 1 remote-isolation probe.
  - 2 claude-code-guide doc lookups.
- **Follow-ups went through SendMessage, not fresh agents.** The orchestrator used 21 SendMessage calls to give agents rebase orders, ask for fixes, resume them after the crash and pause PR05.
- **Integration was a manual stacked rebase chain.** Each finished agent was sent back to rebase its own branch onto the current stack tip. Later this was split into "line A" and "line B" to save wall time (`plan.md` log).
- **Many overlaps had to be resolved by hand.** Examples:
  - Dexie schema versions collided: 15, 19 and 20 all claimed v5.
  - Test seed accounts were duplicated across PRs 12, 13 and 14.
  - Two PRs added the same join-room failure dialog.

**Parallelism over time** (coding agents with an active transcript span; from `subagents/*.jsonl` timestamps):

| Time | Coding agents | What happened |
|---|---|---|
| 14:35–15:04 | 2 | PR01 lint and PR02 protocol, serial foundation |
| 15:05 | — | Owner: "You have permission to fan out more aggressively" |
| 15:14–17:10 | **10–11** | Wave 1: PR04, 05, 10–15, 19, 20 at once |
| 16:01–16:17 | 10 | Vitest/ESLint heap OOMs in 5 agents |
| 16:20 | — | "The computer crashed": the Claude app died, the OS survived. Orchestrator resumed 5 agents, cap of about 5 at a time |
| 17:10–18:50 | 7 | Restacks plus PR06, 09, 16, 21 and 05 stage 3 |
| 19:02 | — | Owner needs the PC. No new local launches |
| 20:16–20:46 | 1 | PR05 paused at a checkpoint; PR18 finishes |
| 20:46–23:24 | 0 | Idle, waiting on the owner: fork, GitHub App, cloud env, allowlist |
| 23:07 | — | Cloud probe routine (RemoteTrigger) passes the full gate plus e2e |
| 23:24 | 3 cloud | First cloud wave: w06, w21, w05s4 as RemoteTrigger one-off routines |

**Agent spans:**
- Coding agents ran 26–236 min of wall time each.
- They issued about 4,850 shell commands in total.
- Model usage was about 2.94 B input-side tokens (mostly cache reads) and about 1.15 M output tokens, all Opus.

## 2. Resource pressure

### Memory: the binding limit

**Context.** The box has 32 GB RAM with about a 9 GB pagefile (41 GB commit limit). With no agents running there was 12.9 GB free.

**OOMs during wave 1, all within 16:01–16:17:**
- `JavaScript heap out of memory` / `ERR_WORKER_OUT_OF_MEMORY` in the PR11, PR20, PR05, PR15 and PR14 transcripts.
- PR14's crash was in **ESLint**: "sockatrice:lint: FATAL ERROR … heap out of memory", exit 134.
- PR05's log shows the cause: Vitest config `maxWorkers: '75%'`. That is about 18 workers per run on 24 threads, times about 10 agents.

**Responses:**
- At 16:08 the orchestrator told every agent to cap workers at `--maxWorkers=2`. Turbo needs the doubled `-- --`, and some agents also set `--concurrency=1`.
- The brief now says: "~10 agents run test suites at once and the host has run out of memory" (`agent-brief.md`).
- PR04 reported that webatrice unit tests "only pass when run one directory at a time: run as one `npm test`, vitest crashes out of memory on the shared host".
- The 16:20 app crash came straight after the OOM burst. That they are linked is inferred, not proven.
- After the crash the orchestrator self-imposed a cap of "~5 concurrent agents" (`plan.md`).

**Cloud measurement for comparison.** Unit tests at `--maxWorkers=2` peaked at about **6.2 GB** on the 16 GB cloud box (probe run log, 23:12). That is one agent's gate alone. At that rate, 5 local agents gating together is about 30 GB, which matches what the PC experienced.

### Disk

All figures measured now with `robocopy /L`:

| Item | Size |
|---|---|
| Each `Webatrice-parity-*` worktree | 543–578 MB and about 77 k files. 534 MB of that is root `node_modules`; every worktree has its own full `npm ci` |
| 18 parity worktrees | **9.4 GB, 1.31 M files** |
| Main checkout | 2.1 GB |
| Cockatrice-audit | 127 MB |
| Docker images | 8.6 GB, all projects. Webatrice uses mysql:8 (1.12 GB) plus two Servatrice images (297 MB and 228 MB) |
| Docker build cache | 4.4 GB |
| `docker_data.vhdx` | 13 GB |
| Playwright browser cache (`%LOCALAPPDATA%\ms-playwright`) | 1.97 GB. Holds two Chromium revisions, 1223 and 1243 |
| C: drive | 75 GB free of 466 GB |

**Notes:**
- The hardware session at 18:09 first reported C: at 0 GB free, then corrected itself to 67 GB at 18:17. Disk was tight but not exhausted.
- With 1.3 M small files, scans are slow. `du -sh` on a single worktree did not finish within 5 minutes; robocopy took under 1 s. Defender was using 1.3 GB of RAM (hardware session), and it scans all of these files.

### CPU and time per heavy step

**Install.** Six parallel `npm ci` runs for the wave-1 worktrees took about 3 min (15:09 → 15:12:37, `.parity-run/install-*.log`).

**Local gate at `--maxWorkers=2`**, PR13 at 19:10 with about 3 agents running:

| Step | Time |
|---|---|
| typecheck | 39 s |
| lint | 31 s |
| unit tests: sockatrice / datatrice / webatrice | 35 / 22 / 117 s |
| integration tests: sockatrice / datatrice / webatrice | 21 / 8 / 70 s |
| **Total** | **about 6 min, with packages run serially** |

Source: `scratchpad\p13_*.log`.

**Same steps under wave-1 load.** The orchestrator said typecheck through unit tests took "25+ minutes on your PC while it was shared" (23:14).

**E2E.** The full webatrice e2e is 21 tests across chromium, firefox and webkit, with **1 worker, serial**:
- 6.5 min for PR09 and PR18; 5.9 min for 18 tests in PR05 stage 3.
- PR18 needed 3 runs (2 failed on locators).
- PR06 ran the full suite at least 6 times, plus a 20× repeat stress run (`scratchpad\parity06\`).

**Servatrice 3.1 image build.** About 3 min locally (`servatrice-build.log`).

**Cloud probe** (4 vCPU / 16 GB, 23:07–23:22):

| Step | Time |
|---|---|
| Setup script | about 1 min |
| `npm ci` | 30 s |
| typecheck | 32 s |
| lint | 14 s |
| unit tests | 117 s |
| Playwright browsers | 43 s |
| sockatrice e2e | 97 s |
| webatrice e2e (21/21) | 392 s |
| **Total** | **about 15 min, everything green** |

Source: probe `get_run_log` result in the main transcript.

**The earlier prediction was too pessimistic.** The cloud-viability report predicted 25–35 min per gate and a 2–3× slowdown. Measured, one cloud box matches an unloaded local run and beats a loaded one.

## 3. Pain points and failure modes

1. **OOM and app crash forced manual recovery.** The orchestrator had to:
   - inspect every worktree for uncommitted edits and half-done rebases;
   - clear a stale `e2e.lock` and leftover containers;
   - resume 10 agents one by one via SendMessage, between 16:21 and 16:47;
   - write the agent IDs into `plan.md` so a second crash could be recovered.

   The brief's "Survival" section ("agents on this project die from session limits … commit early and often") exists because of this.
2. **The e2e stack is a global singleton.**
   - Every worktree's e2e uses one compose project (`webatrice-e2e`) and fixed host ports (4748/4173).
   - The orchestrator added a hand-rolled mutex at 15:06: an atomic `mkdir .parity-run/e2e.lock`, an owner file, and a 45-min staleness rule (`scratchpad\p14_e2e.sh`).
   - Waits were long. PR14's script was written at 16:41 but got the lock at 17:07, about 26 min. PR09 and PR16 show 20–30 min idle gaps "waiting for the e2e lock (currently held by parity/06…)". At 16:16 "most branches are at their final e2e step, queued on the shared Docker lock".
   - Agents release the lock themselves with `rm -rf`, so the lock relies on every agent obeying the brief.
3. **Leaked processes caused a hang.** Playwright's worker did not exit within 300 s after all tests passed (seen on PR11 and PR04). PR06 traced it to orphaned `WebKitNetworkProcess` instances from 16:44 and 16:59 still holding sockets. They were killed by hand at 18:44, about 2 h later.
4. **E2E was not hermetic.** The `app-boots` spec hit the external `mtg.chickatrice.net`. This took a dedicated PR (06) to fix: network stubs, and lint rules that forbid the raw Playwright `test`.
5. **Agents disturbed the owner's desktop.** Vite's `open: true` opened a localhost build in the owner's personal browser (Zen). The owner asked at 17:16 whether an agent needed a sign-in. Fixed with a brief rule: `--open=false`.
6. **There was a possible cross-worktree write.** PR04 "saw stray datatrice files appear in its worktree briefly" (`plan.md`).
7. **The orchestrator spent a lot of effort on polling and babysitting.**
   - 41 "Still running." turns in the main transcript.
   - A manual restack queue.
   - Overlap triage written into `plan.md` by hand.
   - Many interim "agent finished but is waiting on its own background work" notifications.
8. **The owner's PC was unavailable for its normal use.** At 19:02 the owner said: "I need to use the PC and the hardware cannot support the development pace at the same time." Work paused, and from 20:46 to 23:24 nothing ran while the owner set up the fork, GitHub App, cloud environment and allowlist.
9. **Moving to the cloud had several obstacles:**
   - Agent `isolation: "remote"` is not enabled for the account and **silently fell back to a local worktree** (19:05).
   - "Continue in cloud" moves only one branch and a summary. The orchestrator folder is not a repo, and origin was not pushable.
   - The fix was a **public** fork carrying all 18 branches, which reversed the owner's "local only" decision, plus a `parity-notes` branch for the brief and PR texts.
   - RemoteTrigger quirk: `mcp_connections: []` is ignored unless `clear_mcp_connections: true` is also sent (23:24).
   - Cloud workers cannot be resumed with SendMessage. A fix needs a new run.
   - Results come back as `claude/*` branches that must be fetched and renamed locally.
10. **Disk duplication.** 18 full `node_modules` copies (9.4 GB, 1.3 M files) for branches of one repo, plus duplicate Playwright revisions.

## 4. Remote vs local, based on what the trial actually ran

**Well suited to cloud sandboxes.** This is most of the work:
- **Per-PR implementation plus the full gate** (typecheck, lint, Vitest unit and integration). It is pure Node/TS on Linux, as in CI, with no secrets; the e2e accounts are throwaway seeds.
- **E2E against the public Servatrice 3.0.0 image.** Each cloud box has its own Docker, so the mutex, port collisions and orphaned browsers disappear. The probe proved mysql:8, ghcr.io, the Playwright CDN and the MCR image are reachable with the allowlist in `.parity-run/cloud-setup.sh`.
- **Rebases or restacks** that end in a full gate. The first cloud wave is exactly this: w06 and w21.
- **Stress or flake runs.** For example `--repeat-each=20` or repeated full e2e runs: PR06 ran about 7.

**Stays local, or needs work first:**
- **E2E against the locally built 3.1 Servatrice image** (`webatrice-local/servatrice:master-add65ca`). It is in no registry. It could move if the image is pushed to a registry or rebuilt in the setup script (about 3 min locally).
- **Human visual review.** The owner's in-app preview, the browser pane and Claude in Chrome are local-only. A real Scryfall-data preview needs extra hosts allowlisted in the cloud.
- **Orchestrator state.** `.parity-run/` is outside git, memory lives under `~/.claude/projects/...`, and the local `backup/*` branches stay local. The orchestrator itself is cheap: no tests, just notes, rebases and git.
- **Anything Windows-specific.** The trial did nothing that required Windows; the stack is Node plus Linux Docker. No GPU was needed. No secrets beyond GitHub push access.

## Implications for Switchflow

- **Treat memory, not CPU, as the scheduling budget.** One agent's gate takes about 3–6 GB. Switchflow should hand out local "gate slots" (about 2–3 on this 32 GB PC). It should set `--maxWorkers` and turbo `--concurrency` per agent itself, rather than relying on a brief agents may ignore.
- **Provide shared-resource leases as a primitive.** The e2e Docker stack, fixed ports and the browser pool need a governed mutex with owner, TTL, and automatic teardown (`test:e2e:down`) on holder death, replacing `mkdir e2e.lock` plus `rm -rf`. Better still, give each worktree its own compose project and ports.
- **Make the environment a per-task placement decision.**
  - Local is right for the orchestrator, visual review and private-image e2e.
  - The cloud is right for implement-plus-gate, rebase-plus-gate and stress runs.
  - The measured cloud gate (about 15 min, all green) is no slower than an unloaded local run and far faster than a loaded one.
- **Own the git transport for remote work:**
  - push the task branch and a notes branch;
  - dispatch the routine with connectors cleared;
  - poll `get_run_log`;
  - fetch `claude/*` and map it back to the task branch;
  - surface early the private-vs-public repo decision that blocked this run for about 3 hours.
- **Detect silent fallbacks.** `isolation: "remote"` running locally without an error is exactly the kind of thing a governance layer should catch and report.
- **Make crash recovery first-class:**
  - a durable registry of agent IDs, worktrees, branch tips and held leases (what `plan.md` did by hand);
  - an automatic dirty-worktree and stale-lock sweep on restart;
  - a bulk "resume N agents within the cap" action.
- **Clean up processes and prevent footguns:**
  - track and reap child processes (WebKit, Vite, Docker) per agent;
  - forbid `open: true` / opening the owner's browser;
  - check that each agent writes only inside its own worktree.
- **Address disk duplication:**
  - offer shared or linked `node_modules` (pnpm store or hardlinks), or just fewer live worktrees, since branches waiting to be restacked don't need installs;
  - prune stale Playwright revisions.
  - 9.4 GB / 1.3 M files per 18 worktrees also slows Defender scans.
- **Provide a stacked-branch integration queue.** Recording the stack order and conflict hotspots (schema versions, shared barrels, seed data) per branch would remove much of the orchestrator's manual restack and polling work: 41 "Still running." turns and 21 SendMessage calls in this run.
