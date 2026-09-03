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
npm --prefix .switchflow ci --ignore-scripts
.\.switchflow\scripts\backlog.ps1 browser
```

The server listens on <http://127.0.0.1:6420>. Agents use `.switchflow/scripts/backlog.ps1` instead of editing task frontmatter. The wrapper reuses a matching pinned Backlog.md installation from the primary checkout when possible, so isolated worktrees do not need a full install for board access.

`milestone list` reports active and completed records. Completed records remain outside the active board and count once by task ID.

## Ownership and authority

The project owner or user owns product goals, priority, accepted risk, and final milestone accountability. Codex prepares and delivers work against that direction. Their decisions are binding unless unsafe or impossible.

A **reviewer** is an actor assigned to inspect a fixed change independently. Review is read-only by default. An **authorized reviewer** is a reviewer the user has separately granted task-status or acceptance authority for the named work. Selecting `review-task` or automatically invoking review logic does not grant mutation or acceptance authority.

A user-invoked `plan-milestone` pass may create, update, archive, split, combine, reorder, move, or relink tasks in the named milestone. It explains every material mutation and serves the milestone's frozen scope contract. Archiving is the recoverable way to remove obsolete work from the active board.

Explicit `$orchestrate-phase` invocation designates the orchestrator for one named phase. It may coordinate workers, amend tasks within the frozen scope contract, integrate branches, and accept independently reviewed work. It may not independently accept material work it authored. Product decisions, secrets, live external actions, pushing, shared-history rewrites, and branch deletion remain separately authorized.

One narrow exception to branch deletion stands: the orchestrator may run `.switchflow/scripts/cleanup-phase.ps1` at a phase boundary. The script deletes a branch and removes its worktree only when the task is **Done**, the branch matches the task-branch pattern, and Git reports it fully merged into the integration branch. Everything else it reports as an exception for a decision. This grant covers that predicate and nothing wider; deleting a branch outside it still requires explicit authorization.

`deliver-task` implements one referenced task, whether invoked directly or briefed by an orchestrator, and stops at Review. `review-task` independently reviews a fixed change surface and does not change accepted scope. A milestone's scope contract is established by `intake` and decomposed by `plan-milestone`; neither authorizes execution.

## Status lifecycle

| Status | Meaning | Transition owner |
| --- | --- | --- |
| **Backlog** | Planned work not approved or not yet executable. | Project owner or authorized reviewer controls approval; Codex may clarify it. |
| **Ready** | The task passes the full readiness gate in the task contract. | Project owner, authorized reviewer, or Codex after readiness review or explicit execution instruction. |
| **In Progress** | Codex is actively executing the task. | Codex under execution authority. |
| **Review** | Implementation, documentation, and required verification are complete. | Codex after reviewer handoff. |
| **Blocked** | Execution cannot reach acceptance with current decisions, authority, resources, or evidence after safe alternatives are exhausted. | Codex or orchestrator records and later clears the obstruction. |
| **Done** | The result passed independent acceptance review. | Authorized reviewer or the designated phase orchestrator. |

Tasks move **Backlog → Ready → In Progress → Review → Done**. **Blocked** is non-terminal and enters only from execution. Resolution moves **Blocked → Ready** for a fresh pass. A blocking review finding moves **Review → Ready**, followed by **Ready → In Progress** for rework.

Readiness does not authorize implementation. A request such as “execute {{TASK_PREFIX}}-02” authorizes **Backlog → Ready → In Progress** only when no material decision or execution obstruction remains.

## Exception labels

Labels communicate exceptions, not status:

| Label | Use | Ownership |
| --- | --- | --- |
| `needs-decision` | A material product, design, or technical choice is required before readiness. | Codex applies it and removes it after every material decision is understood. |
| `high-priority` | Work should precede normal-priority tasks. | Project owner or authorized reviewer alone applies or removes it. |

Use `needs-decision` during Backlog clarification. Never use **Blocked** as a substitute for an unresolved readiness decision. Put non-blocking risk in the task's **De-risking** section or implementation notes.

## Complete lifecycle

1. The project owner, authorized reviewer, or Codex creates a **Backlog** task under the [task contract](/documentation/07/task-contract).
2. Codex resolves discoverable facts, accounts for owner comments, amends the task, and applies the readiness gate.
3. When a material answer is required, Codex comments with the decision frontier, applies `needs-decision`, and leaves the task in Backlog. After the answer is recorded and all material decisions are resolved, Codex removes the label and reapplies readiness.
4. A passing worker task moves to **Ready**. Readiness alone does not start work.
5. Under explicit execution authority, Codex moves **Ready → In Progress** and follows the [delivery contract](/documentation/08/delivery-contract).
6. If acceptance becomes impossible, Codex completes safe independent work, records the obstruction and learning, and moves to **Blocked**. Resolution returns the task to Ready.
7. Otherwise Codex records final evidence and handoff, then moves **In Progress → Review**.
8. An authorized independent reviewer or designated orchestrator moves **Review → Done** after acceptance, or records blocking findings and moves **Review → Ready**. A reviewer without status authority reports the decision and awaits an authorized actor.

## Deterministic checks

Run the project check after task mutations:

```powershell
.\.switchflow\scripts\backlog.ps1 doctor
```

The wrapper extends Backlog doctor with Ready-dependency validation. Advisory readiness, risk, and review judgement remain in the governing contracts and skills until a reliable deterministic rule is justified by observed failures.
