---
id: doc-03
title: Kanban workflow
type: guide
tags: ["governance", "workflow"]
---

# Kanban workflow

Backlog.md is the source of truth for active work. Task files live in `backlog/tasks/`; repository files and Backlog documents own implemented behavior and durable project knowledge.

This document owns roles, statuses, labels, and legal transitions. The [task contract](/documentation/07/task-contract) owns task shape and readiness. The [delivery contract](/documentation/08/delivery-contract) owns coordination, Git, blockers, handoff, review, and integration. [Engineering standards](/documentation/04/engineering-standards) own quality and risk.

Run the local board with:

```powershell
npm --prefix .switchflow ci --ignore-scripts # initial setup only, while this installation is not serving the board
npm --prefix .switchflow run setup:backlog-fork # required for mutations, MCP and the native board
.\.switchflow\scripts\backlog.ps1 browser
```

The launcher opens the shared local control service and reuses its port across projects; choose the active project in the top navigation. `browser-native` explicitly opens the legacy board for diagnostics. Agents use `.switchflow/scripts/backlog.ps1` instead of editing task frontmatter. The wrapper routes every task, document, milestone and MCP operation to the primary checkout resolved from the common Git directory, using its pinned tooling. Linked worktrees never become independent governance stores. Missing primary governance is an error, not permission to fall back to a stale copy.

For project initiation and orchestration controls, use `.switchflow/scripts/backlog.ps1 control`. This local control surface complements the native task/document board. It keeps initiative revisions, owner messages, approval history and agent checkpoints in the external project operations directory, keyed by the canonical Git common directory so worktrees share one run history. It serializes active agent processes for that project. A restarted service marks uncertain execution interrupted; resume from the recorded checkpoint and never blindly replay an external action.

Keep the board running during ordinary orchestration. Application dependencies and `.switchflow/node_modules` are separate installations. Before `npm ci --ignore-scripts`, stop only application or test processes using the target checkout's application dependencies. Stop the board only before replacing the `.switchflow` installation it actually uses; a worktree may be using the primary checkout's installation. Reuse a matching pinned Backlog installation instead of reinstalling it for each worker. If board maintenance is necessary, record its checkout and launch options, restart it after the attempt (including recovery after failure), and verify its HTTP endpoint before reporting it available. Never stop unrelated Node processes.

`milestone list` reports active and completed records. Completed records remain outside the active board and count once by task ID.

## Ownership and authority

### Three routine human steps

1. **Intake:** agree the intended outcome, current capability gaps, exclusions, and UAT definition. Preserve a resumable checkpoint across all proposed phases.
2. **Planning:** review the concrete phase sequence, candidate and environment, technical gates, scope revision, and external-action boundaries. In project orchestration mode, approving this plan authorizes its listed phases automatically through technical review and local integration until UAT.
3. **UAT:** use the delivered candidate in a guided walkthrough and record acceptance or observed failures. Technical completion never substitutes for the owner's acceptance.

The browser's initiation action starts or resumes this lifecycle. It must expose the current gate, progress, next action and owner, and recoverable run identity. Starting intake does not pre-approve the plan. Phase starts and technical milestone checks are agent work after plan approval, with no routine human start or milestone-acceptance step. Review mode in Intake or Planning requests an independent critique before the corresponding human decision; it does not add another human gate.

Scope changes and bugs use the revision procedure when they alter accepted outcomes; read-only project updates report progress without changing authority. Missing access, consequential unplanned decisions, or protected external actions remain explicit exceptions. Record each human interruption externally so a separately requested framework review can improve the process.

### Project and phase grants

An explicit `orchestrate-project` request or owner approval of its concrete browser plan designates the project orchestrator. The durable approval identifies the scope revision, ordered phases, integration branch, UAT boundary, and any separately approved external actions. Continue the next listed phase after its dependencies and integrated gate pass. Re-read board state and owner comments before each dispatch; a stale or edited plan requires reconciliation before affected work continues. Persist approval and run checkpoints so restarting never loses authority or repeats completed delivery. A run state or agent-written approval string alone is not evidence of owner approval.

A standalone `orchestrate-phase` request still authorizes only the named phase. The project orchestrator invokes that same phase procedure under its approved plan; the inner phase exit checkpoints progress and returns to the project loop rather than asking the owner to start the next phase. Neither mode grants unlisted scope, remote push, deployment, live-data mutation, or general branch deletion.

The project owner or user owns product goals, priority, accepted risk, and final milestone accountability. Codex prepares and delivers work against that direction. Their decisions are binding unless unsafe or impossible.

A **reviewer** is an actor assigned to inspect a fixed change independently. Review is read-only by default. An **authorized reviewer** is a reviewer the user has separately granted task-status or acceptance authority for the named work. Selecting `review-task` or automatically invoking review logic does not grant mutation or acceptance authority.

A user-invoked `plan-milestone` pass may create, update, archive, split, combine, reorder, move, or relink tasks in the named milestone. It explains every material mutation and serves the milestone's frozen scope contract. Archiving is the recoverable way to remove obsolete work from the active board.

`edit-phase` exercises that planning authority for an existing phase. `edit-milestone` applies owner-authorized changes to the accepted scope and reconciles affected plans. Both use the shared procedure in [Scope and revisions](/documentation/09/scope-and-revisions), including coordination with active work and preservation of completed evidence. Neither grants delivery authority.

Explicit `$orchestrate-phase` invocation designates the orchestrator for one named phase. It may deliver serial tasks directly, coordinate parallel workers, amend tasks within the frozen scope contract, integrate branches, and record acceptance after a separate independent verdict and required integration checks. Direct delivery follows the delivery contract and retains separate task boundaries. It may not independently accept material work it authored. Product decisions, secrets, live external actions, pushing, shared-history rewrites, and branch deletion remain separately authorized.

One narrow exception to branch deletion stands: the orchestrator may run `.switchflow/scripts/cleanup-phase.ps1` at a phase boundary. The script deletes a branch and removes its worktree only when the task is **Done**, the branch matches the task-branch pattern, and Git reports it fully merged into the integration branch. Everything else it reports as an exception for a decision. This grant covers that predicate and nothing wider; deleting a branch outside it still requires explicit authorization.

`deliver-task` implements one referenced task, whether invoked directly or briefed by an orchestrator, and stops at Review. `review-task` independently reviews a fixed change surface and does not change accepted scope. A milestone's scope contract is established by `intake` and decomposed by `plan-milestone`. Producing those artifacts does not authorize execution; owner approval of a project execution plan supplies the project grant described above.

## Status lifecycle

| Status | Meaning | Transition owner |
| --- | --- | --- |
| **Backlog** | Work whose outcome, scope, acceptance, or material scope decisions still need definition. | Project owner or authorized reviewer controls approval; Codex may clarify it. |
| **Ready** | Prepared and executable; passes the full readiness gate and awaits dispatch or execution authorization. | Project owner, authorized reviewer, or Codex after readiness review or explicit execution instruction. |
| **In Progress** | The assigned agent or human is actively executing the task. | Codex under execution authority. |
| **Review** | Implementation, documentation, verification, and handoff are complete; awaiting independent review or required integration. | Codex after reviewer handoff. |
| **Blocked** | Prepared work cannot proceed because of a named dependency, decision, resource, or obstruction, before or after execution starts. | Codex or orchestrator records and later clears the obstruction. |
| **Done** | The result passed independent acceptance review and required integration checks. | Authorized reviewer or the designated phase orchestrator. |

Tasks normally move **Backlog → Ready → In Progress → Review → Done**. Prepared work may enter **Blocked** from Backlog, Ready, In Progress, or Review. For non-dependency blockers, resolution requires reassessment: return to Ready when the full gate passes, or Backlog when scope needs definition. A task blocked during Review may return to Review only when its reviewed surface and evidence remain valid. Actionable review corrections return **Review → Ready → In Progress**; an external obstacle uses Blocked instead. Keep work in Review until acceptance and required integration checks finish.

### Dependency readiness and block reasons

`blockReason` is an optional task string, separate from labels and dependency IDs. The reserved value `dependent` means unfinished dependencies are the only blocker. Prepared Ready tasks with unfinished dependencies become Blocked with `dependent`. When all prerequisites are Done or completed, dependency-only Blocked tasks automatically become Ready and clear that reason. A missing, archived-without-completion, or otherwise unresolved prerequisite does not count as Done. A task with another reason remains Blocked until that obstruction is explicitly cleared; automatic dependency reconciliation must never discard that reason. Do not use `dependent` for a decision, resource, failed check or missing authority.

Automatic readiness is limited to previously prepared work. It never approves undefined Backlog scope, starts execution, changes active In Progress/Review work, or substitutes for UAT. Dependency edits and completion through the board, CLI or MCP use the same structured rule. Re-read the returned task revision after mutations because reconciliation can change affected dependent records.

Readiness does not authorize implementation. A request such as “execute {{TASK_PREFIX}}-02” authorizes **Backlog → Ready → In Progress** only when no material decision or execution obstruction remains.

## Exception labels

Labels communicate exceptions, not status:

| Label | Use | Ownership |
| --- | --- | --- |
| `needs-decision` | A material product, design, or technical choice is required before readiness. | Codex applies it and removes it after every material decision is understood. |
| `high-priority` | Work should precede normal-priority tasks. | Project owner or authorized reviewer alone applies or removes it. |

Use `needs-decision` for a user-owned choice in either Backlog or Blocked. Missing scope definition belongs in Backlog; an otherwise prepared task waiting for a specific decision belongs in Blocked. Put non-blocking risk in the task's **De-risking** section or implementation notes.

## Complete lifecycle

1. The project owner, authorized reviewer, or Codex creates a **Backlog** task under the [task contract](/documentation/07/task-contract).
2. Codex resolves discoverable facts, accounts for owner comments, amends the task, and applies the readiness gate.
3. When a material answer is required, Codex comments with the decision frontier, applies `needs-decision`, and classifies it as Backlog or Blocked using the task contract. After the answer is recorded and all material decisions are resolved, Codex removes the label and reapplies readiness.
4. Classify prepared tasks waiting on prerequisites as **Blocked**, with an unblock owner and condition. A task passing the full gate moves to **Ready**. Readiness alone does not start work.
5. Under explicit execution authority, Codex moves **Ready → In Progress** and follows the [delivery contract](/documentation/08/delivery-contract).
6. If acceptance becomes impossible, Codex completes safe independent work, records the obstruction and learning, and moves to **Blocked**. Resolution triggers the reassessment described above.
7. Otherwise Codex records final evidence and handoff, then moves **In Progress → Review**.
8. An authorized independent reviewer or designated orchestrator moves **Review → Done** after acceptance and required integration checks, or records actionable corrections and moves **Review → Ready**. A reviewer without status authority reports the decision and awaits an authorized actor.

## Keep the board current

### Discovery records

Explicit intake authorizes maintaining its `discovery` records and bounded local fact-finding needed to clarify the requested outcome; it does not authorize product implementation or protected external actions. The intake parent also carries `coordination`. Discovery records stay outside delivery milestones and phase labels. `flow` reports them separately from delivery workers and phase parents.

Use Backlog for an unformulated question, In Progress for active intake or investigation, and Blocked when waiting on a named answer or resource. A well-defined discovery question may be Ready when it can be taken next, but is not a delivery assignment. Completed research goes to Review until the intake owner checks evidence against its question; owner decisions resolve only from that owner's recorded answer. The intake agent may mark that question Done after this check; the parent becomes Done only when the accepted contract is saved and read back. These are discovery closure rules, not independent acceptance of product code. Archive abandoned questions with their reason. A closed intake reopened by new uncertainty uses a new linked revision intake when the milestone is already frozen.

### Delivery records

At planning completion, classify every changed worker task. At phase start, handoff, dependency completion, blocker resolution, and phase close, the orchestrator refreshes affected tasks and their current owner comments. Reassess direct dependants after acceptance; do not promote them solely because one dependency finished. Status maintenance may expose readiness for a later phase but never authorizes its execution.

Give coordination parents the `coordination` label and exclude them from executable queue counts. Keep a parent in Backlog while its phase is only planned, In Progress while the authorized phase runs, Review while its integrated gate awaits acceptance, and Done after phase acceptance. Use Blocked only for an obstacle to phase progress, not merely unfinished children. Never dispatch a parent as a worker task.

Use `backlog.ps1 flow` for worker queues, separate coordination parents, and recently updated records. This is a read-only snapshot of recorded state, not a readiness verdict or a complete transition log. Update statuses at actual handoffs; do not hold Ready or Review artificially to make them visible.

## Deterministic checks

Run the project check after task mutations:

```powershell
.\.switchflow\scripts\backlog.ps1 doctor
```

The wrapper extends Backlog doctor with Ready-dependency validation. This checks dependency consistency only; a passing doctor result does not establish task completeness, review evidence, independent acceptance, or UAT. The status meanings above are role obligations, not guarantees enforced by every native task write. Agents must apply the task and delivery contracts before changing status. Advisory readiness, risk, and review judgement remain in the governing contracts and skills until a reliable deterministic rule is justified by observed failures.
