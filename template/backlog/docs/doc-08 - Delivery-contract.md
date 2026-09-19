---
id: doc-08
title: Delivery contract
type: guide
tags: ["governance", "delivery", "review", "git"]
---

# Delivery contract

This contract governs execution, coordination, review, integration, and handoff. The [Kanban workflow](/documentation/03/kanban-workflow) owns status meanings and legal transitions; the [task contract](/documentation/07/task-contract) owns readiness and task shape; [engineering standards](/documentation/04/engineering-standards) own risk and evidence.

## Authority precondition

The [Kanban workflow](/documentation/03/kanban-workflow#ownership-and-authority) is the sole source for execution, orchestration, integration, and acceptance authority. Confirm the applicable grant before using this delivery procedure. This contract does not grant authority, and no delivery step expands the grant. Protected Git, secret, product-decision, and live external actions remain separately authorized under that lifecycle contract.

## Coordination and isolation

Dispatch grouping is decided while planning, not at dispatch. The planner assesses all affected tasks and files and writes every context map. The planner records the groups in the phase plan and the orchestrator executes them. Targeted orchestration reads support checkpoints, blockers, contested verdicts, and permitted conflict resolution or corrections; they do not replace that planning pass or independent review.

A group runs in parallel when its assignments have independent outcomes, clear owners, non-overlapping files or stable interfaces, an explicit integration order, and reviewable stop conditions. Otherwise its tasks run in sequence. Both answers are ordinary. Sequencing work that could have run in parallel costs wall time and leaves no trace, while parallelising work that could not fails visibly at integration or the phase gate, so neither is the safe default and neither needs more justification than the other.

The orchestrator may collapse a group to sequential when phase evidence contradicts the plan, and records why. It does not widen one: that requires another planning pass across all affected tasks. It records the opportunity in the phase record instead.

When only one task in the planned group is ready, the phase agent normally delivers it directly using `deliver-task`, including task-sized reads, the three-line approach, evidence and the handoff at Review. It then resumes coordination to obtain an independent verdict on the exact candidate and perform required integration checks before recording acceptance. It never supplies its own acceptance verdict. Related serial successors may reuse its context after acceptance, with fresh task and owner-comment reads. Each task retains separate criteria, commits, evidence and review.

Use delivery workers for a ready parallel group, or record a concrete capability or isolation benefit for serial delegation. Switch modes at ready group boundaries without widening the plan. Corrections stay with the author. Select capability for the actual work; total tree cost and outcomes decide efficiency, not the number of agents alone.

Dispatch a compact environment note with the accepted base/worktree, valid command forms, pinned dependency state and known access route. It conveys observed facts, not execution permissions. Refresh changed facts at checkpoints and preserve reviewers' access to authoritative evidence.

Prepare only the next ready group by default. Prewarm a gated worktree only when likely dispatch and saved setup time justify it; record the prerequisite revision that must be refreshed before preflight. Do not install speculative future groups. Reuse verified pinned tooling and dependency facts when still valid.

A branch does not isolate agents sharing one checkout. Use dedicated worktrees, branches, sub-branches, or file ownership when useful. Avoid concurrent edits to the same files and unresolved interfaces. Run `.switchflow/scripts/check-worktree-tools.ps1 -Worktree <path> -TaskId <id>` as the preflight for each assignment, and resolve shared setup once. It confirms the pinned Backlog CLI resolves in that worktree and that the task is readable before a worker starts. Add `-RequireNode` when the assignment builds, tests, or runs project code, so a worktree whose dependencies were never installed fails at dispatch rather than part-way through the task; add `-RequireDocs` when it changes Backlog documents.

Keep the board running during ordinary orchestration. Application dependencies and `.switchflow/node_modules` are separate installations. Before `npm ci --ignore-scripts`, stop only application or test processes using the target checkout's application dependencies. Stop the board only before replacing the `.switchflow` installation it actually uses; a worktree may be using the primary checkout's installation. Reuse a matching pinned Backlog installation instead of reinstalling it for each worker. If board maintenance is necessary, record its checkout and launch options, restart it after the attempt (including recovery after failure), and verify its HTTP endpoint before reporting it available. Never stop unrelated Node processes.

## Git workflow

### Worktree ownership

Planning names one worktree manager: **Codex managed**, **orchestrator managed**, or **human managed**. Record each worktree's canonical path, branch, base, owner, task, integration target, profile/output locations and cleanup responsibility in the phase checkpoint. Codex-managed trees use host lifecycle support when available; orchestrator-managed trees use the project preflight and bounded cleanup; human-managed trees are preserved unless their owner grants specific cleanup. Never have two managers delete the same tree. A separate tree isolates files, not running processes or application data: use separate profiles, mutable data and generated output when the task needs them.

Browser delivery can supply a managed Git helper because the local agent sandbox protects Git metadata. Use the supplied helper and its recorded candidate paths for mutating Git operations; keep read-only inspection and product checks in the sandbox. Its approved baseline, candidate branches, exact-file commits, managed integration and durable receipts are the execution route for that run. It cannot integrate into the primary checkout or authorize remote actions. Preserve an uncertain operation or unsupported repository policy for explicit recovery; never bypass the helper with a less restricted runner.

Keep the accepted project integration branch explicit; use an isolated candidate branch when the owner reserves `main` acceptance. The default below applies only when no such reservation exists. Plan approval authorizes local integration within that named target, not remote publication. PR, CI and push requirements belong in the project profile and concrete plan; confirm remote identity and use existing action-specific authority before executing them.

`main` is the integration branch. An orchestrator is designated by explicit `$orchestrate-phase` invocation or specific user authority. Other agents are workers unless the user grants integration authority.

Use the task branch pattern recorded in the [project profile](/documentation/02/project-profile#task-branch-naming) when creating task branches and when passing `-BranchPattern` to phase cleanup.

Workers may use branches or worktrees and create scoped commits. They do not merge or cherry-pick into `main`, rewrite shared history, or delete branches. Their handoff identifies delivered work, repository state, verification, and unresolved issues.

Only an authorized orchestrator may integrate task branches into `main`. The orchestrator owns dependency order, conflict resolution, integrated validation, and authorized cleanup. If integration or conflict resolution materially changes the reviewed surface, an independent reviewer must review that post-integration delta and resulting state before acceptance. Pushing, force-pushing, shared-history rewrites, and branch deletion require explicit user authority, except for the scripted phase cleanup the [Kanban workflow](/documentation/03/kanban-workflow#ownership-and-authority) grants as a standing predicate.

For sequential work in the current `main` worktree, an execution instruction authorizes scoped commits unless the user says otherwise. Each commit covers one logical task, excludes unrelated user changes, uses task-appropriate validation, and includes the task ID when one exists.

## Delivery loop

1. Re-read the task and all open owner comments. Do not execute stale scope.
2. Move **Ready → In Progress** and implement the smallest useful slice that satisfies the accepted outcome and risk.
3. Keep durable documentation aligned when behavior, contracts, schemas, decisions, or repeatable procedures change.
4. Run the smallest verification set required by the active risk profile.
5. Check each satisfied criterion, set the final summary, record the reviewer handoff, re-read mutations, and move **In Progress → Review**.
6. A worker stops at Review. An authorized independent reviewer or designated orchestrator accepts or returns the task.

## Execution obstruction

### External interruption record

Record every human clarification or permission request through the external operations issue store. Resolve the project with `node .switchflow/scripts/operations/operations.mjs context <project-root>`. Add an event with `issue-add <project-root> <json>` using `kind` (`clarification` or `permission`), `summary`, optional `phase` and `taskId`, and `nextAction`. Include the reason and existing authority checked in `summary`. Resolve it with `issue-resolve <project-root> <json>` using the returned `id` and a non-sensitive `resolution` recording the answer and effect. Serialize JSON rather than composing it with shell interpolation.

These events never dispatch tasks. A product obstruction also needs its normal task blocker record below; external friction is for process improvement, not a replacement board. If recording fails, save the pending event in the current run checkpoint and reconcile it at the next successful access. Delivery roles write their events without reading unrelated friction history.

Use **Blocked** for prepared work waiting on a named prerequisite before execution, or for an obstruction discovered during execution or review. Continue safe independent work when useful; do not require a failed implementation attempt before recording a known blocker. Ordinary review or integration queues stay in **Review**. Record:

- Waiting for: the dependency, decision, resource, or obstruction and its impact;
- Evidence: the decisive observation or linked task;
- Unblock owner: the person or role that can resolve it;
- Resume when: the exact observable condition; and
- Progress: completed and remaining work, plus what changed since readiness when work had started.

Keep task dependencies in the native dependency field. Add a short current waiting summary to implementation notes and an append-only comment when the obstruction changes. For an execution surprise, also state whether readiness could have detected it and the prevention or follow-up learning.

When resolved, reapply the full readiness gate. Move **Blocked → Ready** only when it passes, or **Blocked → Backlog** when scope needs definition. If the obstruction interrupted Review and its reviewed surface and evidence remain valid, an authorized actor may restore **Blocked → Review**; otherwise return through readiness and rework.

## Reviewer handoff

The handoff names the accepted base, exact HEAD, completed and pending scope, changed contracts, evidence for each criterion, deviations, unresolved issues, resulting commit when one exists, and the first next action. Re-read the task to confirm every mutation before handoff.

## Independent review

Pin the base, exact HEAD, and fixed diff. Review two axes:

1. **Outcome:** the change satisfies accepted scope and criteria without material omission or unrelated work.
2. **Standards:** the change follows the active quality posture, risk class, repository standards, and durable contracts.

One independent reviewer normally covers both. Author self-check is not independent acceptance. Critical work needs relevant specialist expertise; add another reviewer only for a separate, named expertise gap.

`review-task` escalates to blast-radius analysis for a suspicious small diff or durable Elevated/Critical boundary, and states which trigger fired in every verdict. The escalation names one or two decisive safety facts, traces downstream consumers, and proves the facts with the cheapest credible contract, failure-path, execution, application, or artifact evidence.

A finding blocks acceptance when it violates acceptance, risks data loss or credential disclosure, exposes restricted data, breaks an accepted contract, or creates a likely user-facing correctness failure.

Structural findings block when the change introduces or materially worsens conflicting ownership of a rule or state, duplicated decision logic, or dependencies that force unrelated changes or setup. Identify the concrete consequence and smallest correction. File length, pattern preference, and hypothetical future requirements do not establish a finding.

Unrelated pre-existing structural debt remains outside the task unless the owner expands scope. Improvements outside the accepted boundary become follow-up work only when authorized.

The reviewer reports actionable findings first, then verification, uncertainty, and decision. Review is read-only unless the user separately grants status or acceptance authority. With status authority, a blocking finding returns **Review → Ready** with a comment; otherwise the reviewer reports it for an authorized actor. The next execution pass uses **Ready → In Progress**. If integration adds a material author-owned delta, review that delta and the resulting integrated state independently. Keep the task in Review while review or required integration is pending. An authorized acceptance moves **Review → Done** only after required integration checks pass. If corrections cannot start because of a named external obstacle, use Blocked with its unblock record instead of Ready.
