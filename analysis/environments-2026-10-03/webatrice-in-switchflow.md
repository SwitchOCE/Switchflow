# The Webatrice parity run, as it would run in Switchflow

4 October 2026. This walks the same workflow as the 3 October trial ([webatrice-trial.md](webatrice-trial.md)): about 22 stacked PRs closing Cockatrice gaps. It shows how that run would go through Switchflow once Switchflow is finished.

Every step is tagged:
- **[exists]**: built in Switchflow 0.6.0 today. Sources are README.md, docs/browser-control.md and the "Deviations" section of orchestration DESIGN.md.
- **[designed]**: written up in [DESIGN.md](DESIGN.md) or [../orchestration-2026-10-03/DESIGN.md](../orchestration-2026-10-03/DESIGN.md) but not built.
- **[gap]**: nobody has designed it yet.

## Part 1. How the owner's model evolved after the first cloud wave

Sources:
- the orchestrator transcript `C:\Users\keech\.claude\projects\C--Users-keech-Documents-Webatrice\43f1066b-….jsonl` from 23:24 on 3 October to 00:00 on 4 October;
- `C:\Users\keech\Documents\Webatrice\.parity-run\plan.md`, `cloud-brief.md`, `send.sh` and `poll.sh`, all written 23:58–23:59.

The sessions "Playwright cloud test prompt" and "Environment ID lookup" have no local transcript. They ran in the cloud: one was the owner's earlier Playwright cloud test, the other the owner asking an agent inside the new environment for its ID (23:06).

**How cloud workers are launched:**
- They are Claude Code cloud routines (RemoteTrigger), one-off, using Opus. They are not `--cloud`, not Agent `isolation: "remote"`, and not Codex.
- They all run in one environment the owner created, `env_016BCWYxrwLYpHgjW2E9hrip`. It has a custom allowlist of 16 hosts and `cloud-setup.sh`. The setup is now cached, so a new session starts in about 5 s.
- The code lives on the **public** fork `SwitchOCE/Webatrice`. All `parity/*` branches were pushed there; the `backup/*` branches stayed local.
- The recipe is: `create(enabled:false)`, then `update {mcp_connections:[], clear_mcp_connections:true}` (a bare `[]` is silently ignored), then `run`.
- The plan now says to keep the prompt to one line and put the task text in `parity-notes:tasks/<id>.md`, because the API echoes the prompt three times per response.

**How workers are fed:**
- A `parity-notes` branch on the fork holds:
  - `cloud-brief.md`: the local brief, minus the e2e lock, plus push rules, Survival and a Mailbox section;
  - the PR descriptions, gap tables and audit;
  - `tasks/` and `inbox/`.
- Workers run e2e browsers inside the `mcr.microsoft.com/playwright:v1.60.0-noble` container, because the box's own browsers do not match Playwright 1.60.

**How the orchestrator and workers talk.** It is a git mailbox the orchestrator invented at 23:54, after confirming that a routine event addressed to a running session does not inject into it but starts a fresh one:
- Orchestrator to worker: numbered messages (M1, M2, …) in `parity-notes:inbox/<task>.md`, sent with `.parity-run/send.sh`.
- Worker to orchestrator: worker status, ACK and QUESTION lines go in `status.md` on `claude/notes-<task>`.
- `.parity-run/poll.sh` fetches `claude/*` and lists open questions.
- The lag is a few minutes. A blocked worker waits up to 20 minutes, then takes its stated default.

**How results come back.** The orchestrator takes in each finished worker by hand:
1. fetch the fork;
2. review the diff;
3. back up the old local branch;
4. fast-forward local `parity/<x>` to `fork/claude/parity-<x>`;
5. copy the PR file from `claude/notes-<task>` into `.parity-run/prs/`;
6. push `parity/<x>` back to the fork.

w21 went through this at 23:57, about 33 minutes after dispatch, including a three-browser e2e run.

**Width.**
- Wave 1 (23:24) had 3 workers: w06, w21 and w05s4.
- Wave 2 (23:56–23:58) added 4: w23p, w22, w17spec and w0918. w20 followed, stacked onto w21's new tip.
- That made 7 running at 23:59, against a self-imposed local cap of 5 earlier in the day.
- At 23:53 the owner asked: "you can fan out as wide as you need to in these cloud environments right?" Width is now limited by branch dependencies and account caps, not hardware.
- The PC hosts only the orchestrator. There is no local Docker and no local agents.

**What is still manual:**
- Polling: the orchestrator still sets 15–20 minute check-back timers, and there is no completion notification.
- Intake of every result.
- Restack ordering: line A, line B, and the 05→09→{16,18} refactor line, which "must rebase as a unit".
- Schema-number reservations: Dexie v5/v6/v7.
- Deleting junk triggers: the owner was asked to delete `trig_01RNkoU8…` and `trig_01GJ1sMv…`.
- Writing the cloud brief by hand.

**What broke or surprised:**
- The empty-list connector update was silently ignored.
- A message sent to a running session spawned a junk session instead.
- The prompt is echoed three times per API response.
- The pre-commit hook fails on the docs-only notes branch, so it is committed with `HUSKY=0`.
- Host browsers don't match Playwright 1.60, despite the setup script.
- The Playwright container does not trust the egress proxy's certificate. As a result 5 of 30 e2e tests fail on w21; they fail on its base too.
- The 3.1 Servatrice image must be rebuilt per box, taking 15–25 min.
- The orchestrator itself ran out of context and was compacted at 23:27.

**Time and cost against the local phase:**

| | Local (wave 1, ~10 agents) | Cloud |
|---|---|---|
| Typecheck through unit tests | "25+ min" under load | about 3 min (probe) |
| Full gate plus three-browser e2e | — | about 15 min (probe) |
| Rebase plus gate plus e2e, dispatch to intake | — | about 33 min (w21) |
| E2E lock waits | about 26–30 min | none: each worker has its own box and Docker |

- Cost: cloud runs draw from the owner's Max plan allowance, with no separate compute charge ("Hardware bottleneck options" session, 18:09). Token totals for the cloud runs are not visible locally and were not measured.
- Owner time moved from crash recovery and lending the PC to one-time setup: fork approval, GitHub App, environment, allowlist, environment-ID lookup. That setup took about 20:46–23:07, mostly waiting on the owner.

## Part 2. The same run in finished-state Switchflow

### 0. Project setup (once)

- [exists] Import Switchflow into Webatrice. The project profile records required files, access checks and command notes (SF-22).
  - Command notes would record the gate commands.
  - Command notes would also record the `--open=false` rule.
- [designed] Add a capacity section to the project profile:
  - a per-worker memory budget: about 1.5 GB idle, about 6 GB while gating;
  - gate slots: `gate: 2`, `e2e: 1` locally;
  - injected test caps: `VITEST_MAX_WORKERS=2`, `NODE_OPTIONS`.

  This is what stops the trial's OOM burst.
- [gap] Profile entries for two more things:
  - a browser-open suppressor (`BROWSER=none` or similar) injected into every worker's environment;
  - a declared list of **shared-state hotspots** that branches must reserve rather than pick freely (Dexie schema version, e2e seed accounts, barrel files).
- [designed] Environments the project may use. This is the owner's privacy decision, made once:
  - local: allowed;
  - SSH box: allowed;
  - Claude cloud: allowed, but only on a private repo, or on the public fork if the owner accepts that;
  - Codex cloud: opt-in.

  In the trial this decision came mid-run, at 19:02 and again at 22:53. Here it is made up front.

### 1. Intake

- [exists] The owner types the same request in the browser: close every remaining parity gap, including moderation, at datatrice/sockatrice quality. Intake reads the earlier Codex audit and the Claude reports, re-verifies the gaps, and brings back questions and a proposed scope.
- [exists] The upfront questions become **decision records**:
  - local-only branches or a remote;
  - target the 3.1 protocol;
  - lint sweep first;
  - full PlayerBox refactor;
  - the out-of-scope list.

  In the trial these lived in a memory file and `plan.md`.
- [exists] `create-human-task` records the work only the owner can do, before delivery starts, so it does not stall the run halfway:
  - create a private repo or approve the fork;
  - install the Claude GitHub App;
  - create a cloud environment and paste its ID;
  - optionally provision the SSH box.
- [gap] A **remote-readiness check** that turns those human tasks into a verified probe:
  - push a throwaway branch;
  - run one routine through setup, gate and e2e;
  - report blocked hosts.

  The trial's 23:07 probe did this by hand. Switchflow should run it as Intake's environment access check and name the exact allowlist.

### 2. Planning: 22 PRs become milestones, tasks and a stack

- [exists] Milestones end where the owner can judge a result. A natural split:
  1. Foundation: 01 lint, 02 hand reorder, 03 3.1 protocol.
  2. Moderation and staff: 12, 04, 10, 11, 13, 14, 15.
  3. Settings surface: 19, 21, 20.
  4. Game and decks: 05 refactor stages, 09, 16, 17, 18, 23.
  5. Parity docs (22) and the i18n sweep.

  Each milestone gets a UAT walkthrough.
- [exists] Each PR is a Backlog task with acceptance evidence (the gate) and owned files. Dependencies are explicit; for example, 21 depends on 19. The board marks a dependent task Blocked with reason `dependent` until its prerequisite is Done.
- [exists] Parallel groups follow the fan-out contract: owned files, a stable interface, integration order and a stop condition.
- [exists] Approving the plan authorizes every phase. The owner's "fan out more aggressively" (15:05) becomes a plan setting, not a mid-run message.
- [gap] **Stack order as data.** Switchflow models dependencies and an integration *merge* order. It does not model "branch N is rebased onto branch N-1's tip and submitted as its own upstream PR". The trial's line A, line B and refactor line belonged in the plan, not in prose.
- [gap] **Hotspot reservations at planning time.** For example, give 15/19/20 the Dexie versions v5/v6/v7 up front; that renumbering cost several restacks. Also assign seed accounts and barrel insertion points once.
- [designed] **Placement per task.** Planning tags each task with its needs: needs 3.1 image e2e; heavy gate; self-contained. The host places each one by rule:

| Work in this run | Placed on | Why |
|---|---|---|
| 03 protocol, 13 admin, 14 reports: e2e against the locally built 3.1 Servatrice image | local, or the SSH box once the image is in a registry or built there | the image exists only on the PC |
| 04, 10, 11, 12, 15, 16, 18, 19, 20, 21: feature plus full gate plus 3.0.0 e2e | Claude cloud, or the SSH box | heavy gate; Docker per box removes the e2e mutex |
| 05 refactor stages, 09 deck refactor: long, needing steering | SSH box first (full stream, steer and interrupt), Claude cloud second | the cloud has only mailbox steering |
| Restacks after each predecessor lands | wherever the branch's last worker ran | needs the full gate |
| Small follow-ups: make a new interface member optional, regenerate a stale `i18n-default.json`, a spec for 17 | Codex cloud (opt-in, fire-and-forget, diff applied locally) | bounded; no steering needed; Docker/e2e there is unverified, so no e2e |
| 22 parity docs | local or any; light | no gate beyond docs checks |
| Cross-provider reviews | local | read-only and cheap |

- [designed] If the preferred environment is unavailable, the task waits and says why. It never silently falls back to local, as `isolation: "remote"` did at 19:05.

### 3. Delivery

- [exists] A Claude phase orchestrator (`orchestrate-phase`) delegates through host-owned MCP tools:
  - `delegate_task` per PR task, into a bridge-registered worktree;
  - `wait_for_workers` instead of 41 "Still running." turns;
  - `send_to_worker` for fixes and rebase orders, instead of SendMessage;
  - `interrupt_worker` to pause, for example PR05 at 20:14.
- [exists] **Approach gate.** Each delivery worker's first turn is read-only and returns a three-line approach. The orchestrator, or the owner from the Agents view, confirms it before any edit. This would have caught 18's two new *required* interface members before they were written, since the plan's rule says "new response members are optional".
- [exists] **Cross-provider review.** A Claude-authored PR is reviewed by a read-only Codex session, and the reverse; at most `maxReviewRounds`, then escalate. The review notes the orchestrator wrote by hand (breaking third argument, duplicate seeds, Dexie collisions) become structured verdicts. Caveat: a real Claude reviewer has not been exercised live.
- [exists] `maxWorkers` caps live workers by count.
- [exists] One project-wide **suite lock** with automatic release when its holder ends or after 30 minutes. It already replaces the `mkdir e2e.lock` plus `rm -rf`, including the stale-owner rule.
- [designed] **Memory admission.** Admission is by memory, not just count. Five wave-1 agents would queue with "needs 6 GB, 4 GB free" instead of crashing the app.
- [designed] **Leases** with owner, time limit and teardown:
  - gate slots;
  - a Docker-stack lease whose release runs `test:e2e:down`;
  - a port range.
- [designed] Test caps injected into every worker.
- [designed] Per-worker process-tree cleanup on close. That would have reaped the orphaned WebKit processes that hung Playwright for about 2 hours.
- [gap] **Per-worktree e2e isolation:** a compose project name and port block per lease, so two e2e runs can coexist on one host. With that, the local `e2e: 1` slot can become `e2e: 2–3` on the SSH box.
- [designed] **Shared dependencies** (optional): a pnpm store or hard-linked `node_modules`, so 18 worktrees cost megabytes, not 9.4 GB.
- [gap] Making it work for this repo is undesigned: it is an npm workspace with a `prepare` step (submodule, buf generate).
- [designed] **Environment adapters:**
  - local [exists as today's spawn path];
  - SSH box: the same CLIs over `ssh -T`, worktrees on the box, results as a pushed branch;
  - Claude cloud: `start` = routine, `collect` = fetch `claude/*` into a local candidate;
  - Codex cloud: submit, poll, apply the diff;
  - Managed Agents.

  Remote workers are reviewed and merged locally exactly like local ones.
  - Note on the SSH box: the WSL Ubuntu test box exists with its CLIs signed in, but it shares this PC's 32 GB. It is a test bed for the SSH adapter, not extra capacity. Real headroom needs a separate machine with 24 GB or more.
- [gap] **Cloud steering.** The adapter's stream, steer and interrupt columns are "to verify". The trial shows that routines cannot be messaged mid-run. The git mailbox (`inbox/<task>.md` ↔ `status.md`, about 5-min lag, QUESTION/default protocol) is the working answer today. Switchflow should own it and surface `QUESTION` lines in the Agents view as "Needs you / needs orchestrator".
- [gap] **Remote push authority.** A plan grant does not authorize remote pushes. Cloud and SSH placement needs a narrow, owner-granted exception: "push `parity/*` and `claude/*` to remote X for this initiative". Without it, every dispatch is a human task.

### 4. Integrating stacked branches

- [exists] The git bridge merges managed candidates into an integrated candidate. The phase gate runs the full suite on it, so conflicts between tasks surface.
- [gap] An **integration queue for stacked upstream PRs.** This run needs separate, reviewable branches, each rebased onto its predecessor. When a predecessor lands, the queue should:
  - rebase each dependent in order, on the environment where it last ran;
  - apply the hotspot reservations;
  - run the gate;
  - flag intermediate red commits for squashing;
  - keep `backup/*` refs.

  The orchestrator did all of this by hand: 21 SendMessage calls and a dozen `plan.md` log entries. Today it is still done by hand, through the mailbox.
- [designed, partly] **Intake of remote results:** `collect()` into a local candidate. Still a gap: the trial's backup, fast-forward and PR-file sync, and a "rename `claude/*` to the task branch" mapping.
- [exists] Upstream PR submission stays with the owner. A plan grant never opens PRs. PR descriptions live as task records rather than in `.parity-run/prs/`.

### 5. The owner's touchpoints

| Owner action | Trial | Finished Switchflow |
|---|---|---|
| Approve scope and decisions | chat at 14:29 | Intake and plan approval [exists] |
| Approve remote / repo policy | 19:02 and 22:53, mid-run | at Intake, as project environment policy [designed] plus a push grant [gap] |
| One-time cloud setup | about 2.5 h of fork, App, environment and allowlist | human tasks [exists] plus a readiness probe [gap] |
| Watch progress | ask the orchestrator | Agents view: tree of orchestrator → workers with provider, role, task, status, approach state [exists]; environment badge and remote session links [gap] |
| Steer or pause a worker | via the orchestrator | from the Agents view: steer, queue, interrupt, confirm approach [exists for local]; through the mailbox for cloud [gap] |
| "I need the PC" | stop launches, pause PR05 by hand | [gap] a **yield** action: drain local workers to their next commit, release local slots, re-place queued tasks on remote environments |
| A dev server opened the owner's browser | the owner asked why | prevented by the injected environment [gap]; cleaned up by tree-kill [designed] |
| Delete junk triggers / stale worktrees | asked to by the orchestrator | adapter `cleanup()` [designed] |
| Babysit polling, locks, OOM | implicit | gone: event waits [exists], admission and leases [designed] |

### 6. Recovery after a crash

- [exists] **Restart fence.** Every worker's PID is recorded before it starts. On restart, live, unverified or unknown processes hold the run. The owner can run `stop-processes` or `recover-run`, and nothing is replayed automatically. The suite lock expires by itself.
- [exists] The board, decisions and task records are the durable checkpoint, so an orchestrator that runs out of context (as at 23:27) resumes from the records.
- [designed] **One-step resume.** "Resume all held workers" within the admission budget, instead of ten SendMessage calls between 16:21 and 16:47.
- [gap] **Recovery sweep:**
  - dirty worktrees;
  - half-finished rebases;
  - leftover containers;
  - Docker leases held by dead workers.

  The trial's orchestrator did this sweep by hand at 16:20.
- [designed] Remote workers survive a local crash. After restart the adapter reconnects by session ID and the last pushed branch. Today that is `poll.sh`.

### 7. UAT

- [exists] **Preview launcher.** Per milestone, the UAT checklist's Preview bar starts the integrated candidate locally from `.switchflow/preview.json`, links to it and guards network listeners. For Webatrice, the command would be a script that runs `test:e2e:up` (Servatrice plus MySQL) and then `vite preview --open=false`. Remote results are first collected into a local candidate.
- [exists] Only one preview runs per project, and it is stopped and tree-killed on accept, rework or scope change.
- [gap] **Preview-time Docker lease.** The preview's Servatrice stack shares compose names and ports with e2e. It should take the same Docker lease, or a separate port block, so UAT doesn't break a running e2e.
- [gap] Previewing *one PR in the stack*, as opposed to the milestone's integrated candidate. Reviewers upstream see single PRs.

## Highest-leverage gaps to build next

Ranked by owner time saved in this trial:

1. **Environment policy plus remote push grant plus readiness probe at Intake.** The owner lost the PC from 19:02 and spent about 20:46–23:07 on mid-run setup and repo decisions. Deciding up front and probing automatically removes most of that.
2. **Capacity layer: memory admission, leases, test caps, tree-kill, browser suppression.** These are [designed] except the suppressor. They remove the OOM burst, the 16:20 app crash and the owner's "recover and resume", the Zen popup, and the 2-hour Playwright hang. This is the biggest risk reduction for no money.
3. **A Claude-cloud adapter that owns dispatch, the mailbox, collect and cleanup.** This turns the trial's hand-built routine recipe, `send.sh`/`poll.sh` and manual intake into one placement choice. It also shows cloud `QUESTION`s in the Agents view and removes the junk-trigger chores.
4. **Yield the PC.** Drain local workers to a checkpoint and re-place the queue remotely. This replaces "what's the hold up with PR 05? can we pause" and the hours of idle that followed.

Status 2026-10-04: part of 1 and 4 is built. Before each delivery run the service checks the health of every placed environment and holds the initiative with the reasons and "Test again"; "Where workers run" has Test all and a Codex cloud form (reviews only). "Pause local workers" in the capacity strip queues new local workers while running ones continue. Still open: the full probe (a throwaway push and one routine run through setup and gate), draining to a checkpoint, and re-placing the queue remotely.
5. **Stacked-branch integration queue with hotspot reservations.** This saves orchestrator time first: 21 SendMessage calls and repeated Dexie restacks. It saves owner time at PR submission: squashes, red intermediate commits, review of the overlaps.
6. **One-step recovery plus a recovery sweep.** Rare, but it cost about 30 minutes of hand recovery in the trial.
7. **Per-worktree compose project and ports, and shared `node_modules`.** These lift local e2e throughput and reclaim about 9 GB. They matter less once heavy gates go remote.
