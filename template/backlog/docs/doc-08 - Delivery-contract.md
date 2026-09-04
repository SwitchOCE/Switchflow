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

Dispatch grouping is decided while planning, not at dispatch. The planner reads the repository and writes every context map, so it is the only role that knows which files a task touches; the orchestrator's read limit deliberately excludes that detail. The planner records the groups in the phase plan and the orchestrator executes them.

A group runs in parallel when its assignments have independent outcomes, clear owners, non-overlapping files or stable interfaces, an explicit integration order, and reviewable stop conditions. Otherwise its tasks run in sequence. Both answers are ordinary. Sequencing work that could have run in parallel costs wall time and leaves no trace, while parallelising work that could not fails visibly at integration or the phase gate, so neither is the safe default and neither needs more justification than the other.

The orchestrator may collapse a group to sequential when phase evidence contradicts the plan, and records why. It does not widen one: judging that more parallelism is safe needs the file-level detail it does not read. It records the opportunity in the phase record instead.

A branch does not isolate agents sharing one checkout. Use dedicated worktrees, branches, sub-branches, or file ownership when useful. Avoid concurrent edits to the same files and unresolved interfaces. Run `.switchflow/scripts/check-worktree-tools.ps1 -Worktree <path> -TaskId <id>` as the preflight for each assignment, and resolve shared setup once. It confirms the pinned Backlog CLI resolves in that worktree and that the task is readable before a worker starts. Add `-RequireNode` when the assignment builds, tests, or runs project code, so a worktree whose dependencies were never installed fails at dispatch rather than part-way through the task; add `-RequireDocs` when it changes Backlog documents.

## Git workflow

`main` is the integration branch. An orchestrator is designated by explicit `$orchestrate-phase` invocation or specific user authority. Other agents are workers unless the user grants integration authority.

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

Use **Blocked** only after execution has started, safe independent work is complete, and in-scope alternatives are exhausted. Record:

- the obstruction and its impact;
- evidence checked;
- completed and remaining work;
- exact unblock criteria and owner;
- what changed since readiness;
- whether readiness could have detected it; and
- prevention or follow-up learning, including when no preventable admission failure occurred.

When resolved, update scope if needed and move **Blocked → Ready** for a fresh execution pass.

## Reviewer handoff

The handoff names the accepted base, exact HEAD, completed and pending scope, changed contracts, evidence for each criterion, deviations, unresolved issues, resulting commit when one exists, and the first next action. Re-read the task to confirm every mutation before handoff.

## Independent review

Pin the base, exact HEAD, and fixed diff. Review two axes:

1. **Outcome:** the change satisfies accepted scope and criteria without material omission or unrelated work.
2. **Standards:** the change follows the active quality posture, risk class, repository standards, and durable contracts.

One independent reviewer normally covers both. Author self-check is not independent acceptance. Critical work needs relevant specialist expertise; add another reviewer only for a separate, named expertise gap.

`review-task` escalates to blast-radius analysis for a suspicious small diff or durable Elevated/Critical boundary, and states which trigger fired in every verdict. The escalation names one or two decisive safety facts, traces downstream consumers, and proves the facts with the cheapest credible contract, failure-path, execution, application, or artifact evidence.

A finding blocks when it violates acceptance, risks data loss or credential disclosure, exposes restricted data, breaks an accepted contract, or creates likely user-facing incorrectness. Improvements outside the accepted boundary become follow-up work only when authorized.

The reviewer reports actionable findings first, then verification, uncertainty, and decision. Review is read-only unless the user separately grants status or acceptance authority. With status authority, a blocking finding returns **Review → Ready** with a comment; otherwise the reviewer reports it for an authorized actor. The next execution pass uses **Ready → In Progress**. If integration adds a material author-owned delta, review that delta and the resulting integrated state independently. An authorized acceptance then moves **Review → Done**.
