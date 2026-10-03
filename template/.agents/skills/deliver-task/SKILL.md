---
name: deliver-task
description: 'Implement one {{PROJECT_NAME_YAML_SINGLE}} task, verify its accepted outcome, and hand off at Review for independent acceptance.'
---

# Deliver Task

Implement one task, prove it, and stop delivery at Review. A phase agent using this procedure then resumes `orchestrate-phase` to obtain independent review, integrate and accept before its next serial task. This skill alone grants none of that phase authority.

## Read proportionally

Read the task and all its comments through `.switchflow/scripts/backlog.ps1`, the files its context map names, and the delivery loop in `backlog/docs/doc-08 - Delivery-contract.md`.

Every task reads the Delivery rules and applicable Risk and verification guidance in `backlog/docs/doc-04 - Engineering-standards.md`. Elevated and Critical tasks additionally read `backlog/docs/doc-03 - Kanban-workflow.md`, `backlog/docs/doc-07 - Task-contract.md`, and the protected boundaries in the engineering standards.

Do not read other tasks, the milestone plan, or the friction log.

The context map is advisory. Start where it points; if it is wrong, correct course and report the correction so the next map is better. Do not treat it as a second contract.

Account for every open {{OWNER_NAME}} comment as `doc-07` requires before relying on task text. Do not implement against stale scope.

## State the approach first

Before implementing, state in three lines: the files you will change, the approach, and the stop condition. Wait for confirmation when you are a delegated worker; when the Switchflow host dispatched you, return the approach as your result and stop until the orchestrator replies. The host keeps you read-only until it confirms; do not try to edit before then. A phase agent delivering directly checks its plan against accepted scope and proceeds under its existing grant.

## Implement

Move **Ready** to **In Progress**. Build the smallest useful slice that satisfies the accepted outcome and its risk class. Prefer a thin vertical slice over a complete subsystem, and defer speculative generalisation.

Keep durable documentation aligned when behaviour, contracts, schemas, decisions, or repeatable procedures change. Follow `backlog/docs/doc-05 - Maintaining-documentation.md`.

## Verify what changed

Run the changed-outcome tests the context map identifies, plus whatever the risk class requires.

Use focused task evidence. Apply the phase gate from `doc-04` and the project profile on the integrated candidate: documentation and board checks for affected Documentation-only surfaces, or the full suite and required boundaries for runtime or operational changes. Honor any explicit task gate. Do not duplicate phase checks on every task branch.

Do not re-run a suite that has not been invalidated by a change since its last run.

When the `acquire_suite_lock` tool is present, hold it while running the full test or build suite and release it as soon as the run ends; focused tests do not need it.

## Check what review usually blocks

In earlier Switchflow projects, about half of reviewed tasks failed their first independent review, mostly on the classes below. Before handoff, ask each question that applies to this change, and fix or test what you find:

1. **In-flight and failed work.** What happens if a request is slow, fails, is retried, or its response is lost? Check edits made while loading or saving, late responses overwriting newer state, retries keeping their idempotency key, error feedback where the user is, and cleanup that cannot hang.
2. **Contract edges.** Test every limit, range, unit, version and identity the contract states at its exact boundary, including existing data near a limit that this change adds to. Keep IDs and display labels separate.
3. **Checks that fail closed.** A validator or boundary check rejects what it cannot classify; it never skips it.
4. **Raw input.** Do not write normalized or display values back into what the user is typing or into stored raw fields.
5. **Focus and access.** After dialogs close or lists rerender, focus lands on a defined control, and visible text matches accessible text.
6. **The shipped artifact.** When packaging or build output changes, inspect the real output, not the source tree.
7. **Tests that can fail.** At least one test per criterion drives the real path from the user's starting state and fails without the change. Seeding state through a back door or a separate root can hide the defect.

Record in the handoff which questions applied and their evidence. This is author diligence, not a substitute for independent review.

## Hand off and stop

Check each satisfied criterion, set the final summary, and record the handoff comment: accepted base, exact HEAD, completed and pending scope, changed contracts, evidence per criterion, deviations, unresolved issues, and the first next action.

Re-read the task to confirm every mutation, then move **In Progress** to **Review**.

A delegated worker returns five lines and nothing more. A phase agent records the same envelope at the delivery boundary before requesting independent review:

```text
task: {{TASK_PREFIX}}-14
branch: task/{{TASK_PREFIX}}-14
head: <sha>
criteria: 3/3 checked
blocking: none
```

Delivery stops at Review. Never review your own work. Without separate phase authority, do not integrate, merge into `main`, or start another task. If acceptance becomes impossible, complete safe independent work, record the obstruction as `doc-08` requires, and move to **Blocked**.
