---
name: deliver-task
description: 'Implement one {{PROJECT_NAME_YAML_SINGLE}} Backlog.md task and hand it off for independent review. Used by {{OWNER_NAME_YAML_SINGLE}} directly or by an orchestrator briefing a worker.'
---

# Deliver Task

Implement one task, prove it, hand it off, and stop.

## Read proportionally

Read the task and all its comments through `.switchflow/scripts/backlog.ps1`, the files its context map names, and the delivery loop in `backlog/docs/doc-08 - Delivery-contract.md`.

Every task reads the Delivery rules and applicable Risk and verification guidance in `backlog/docs/doc-04 - Engineering-standards.md`. Elevated and Critical tasks additionally read `backlog/docs/doc-03 - Kanban-workflow.md`, `backlog/docs/doc-07 - Task-contract.md`, and the protected boundaries in the engineering standards.

Do not read other tasks, the milestone plan, or the friction log.

The context map is advisory. Start where it points; if it is wrong, correct course and report the correction so the next map is better. Do not treat it as a second contract.

Account for every open {{OWNER_NAME}} comment as `doc-07` requires before relying on task text. Do not implement against stale scope.

## State the approach first

Before implementing, state in three lines: the files you will change, the approach, and the stop condition. Wait for confirmation when an orchestrator briefed you.

This exists so a wrong direction is corrected in a sentence rather than after the work is done.

## Implement

Move **Ready** to **In Progress**. Build the smallest useful slice that satisfies the accepted outcome and its risk class. Prefer a thin vertical slice over a complete subsystem, and defer speculative generalisation.

Keep durable documentation aligned when behaviour, contracts, schemas, decisions, or repeatable procedures change. Follow `backlog/docs/doc-05 - Maintaining-documentation.md`.

## Verify what changed

Run the changed-outcome tests the context map identifies, plus whatever the risk class requires.

Do not run the full repository suite. That runs once per phase, on the integrated branch, where cross-task interference is actually observable. A full suite on an isolated task branch cannot detect what it is being run for, and its output displaces the code you need to reason about.

Do not re-run a suite that has not been invalidated by a change since its last run.

## Hand off and stop

Check each satisfied criterion, set the final summary, and record the handoff comment: accepted base, exact HEAD, completed and pending scope, changed contracts, evidence per criterion, deviations, unresolved issues, and the first next action.

Re-read the task to confirm every mutation, then move **In Progress** to **Review**.

Return five lines and nothing more:

```text
task: {{TASK_PREFIX}}-14
branch: task/{{TASK_PREFIX}}-14
head: <sha>
criteria: 3/3 checked
blocking: none
```

Detail belongs in the task comment, where the reviewer will fetch it. Repeating it in the return value puts it in the orchestrator's context, where it is paid for on every subsequent turn.

A worker stops at Review. Do not review your own work, integrate, merge into `main`, or start another task. If acceptance becomes impossible, complete safe independent work, record the obstruction as `doc-08` requires, and move to **Blocked**.
