---
name: orchestrate-phase
description: 'Deliver one phase of a prepared {{PROJECT_NAME_YAML_SINGLE}} milestone by dispatching workers, checkpointing them, integrating, and exiting. Use only when explicitly invoked.'
---

# Orchestrate Phase

Deliver one phase, record what the next phase needs, and exit. Explicit invocation designates this agent as orchestrator for the named phase with the authority described in `backlog/docs/doc-03 - Kanban-workflow.md`.

Your context is the scarce resource this whole design protects. Everything below exists to keep it small.

## Read narrowly

Read the milestone record, the phase parent task and its prior phase records, and the identifiers, statuses and dependencies of this phase's tasks.

Do not read diffs, file contents, full task descriptions, or worker reasoning. When a diff needs judging, dispatch a reviewer. Fetch task detail only when an envelope reports a blocking issue or a review verdict is contested.

## Dispatch

Resolve shared setup once, and run the preflight against each worktree before dispatching into it. It confirms the pinned Backlog CLI resolves there and the task is readable, so workers do not rediscover the same setup failure.

```powershell
.\.switchflow\scripts\check-worktree-tools.ps1 -Worktree ..\wt-{{TASK_PREFIX}}-14 -TaskId {{TASK_PREFIX}}-14
```

Give each worker one task, the context it needs, and a non-overlapping surface. Use `deliver-task`. Choose worker capability from the task's risk class: Documentation-only and Standard take a smaller model, Elevated and Critical take a frontier model.

Parallel work is an optimisation, not a default. Fan out only when assignments have independent outcomes, non-overlapping files or stable interfaces, an explicit integration order, and reviewable stop conditions. Otherwise sequence them.

**One worker, one task.** A worker ends at its handoff. The next logical task gets a new worker even when the finished one already holds relevant context. Reuse looks efficient because the context is loaded, but accumulated context is re-sent on every later turn, so a reused worker's cost grows with the square of its lifetime. Corrections arising from review are the same task and stay with the same worker.

## Checkpoint before implementation

Require each worker to state its intended approach in three lines before it implements: files it will change, approach, stop condition. Confirm it or correct it.

This is your highest-value action. A correction here costs a few hundred tokens; discovering the same mistake after implementation costs the whole attempt.

## Wait once, long

Wait for workers with a timeout matched to the work — minutes, not seconds. Do independent orchestration work while they run, or block.

**Never narrate a timeout.** A timeout carries no new information, and reporting it costs a full-context turn. If a wait must be repeated, lengthen the interval rather than re-issuing the same short one. Repeated short waits are the second-largest source of wasted tokens measured in this framework.

## Amend rather than implement

When execution evidence shows the plan was wrong, amend the task and re-dispatch. That is the safety net and it is exercised by re-briefing.

Implement directly only within a narrow bound: a single file, no new behaviour, no new acceptance criterion. Merge conflict resolution and one-line corrections qualify. Anything larger is dispatched.

Product decisions, scope changes beyond the frozen contract, secrets, live external actions, pushing, shared-history rewrites, and branch deletion remain separately authorised.

## Integrate and close

Obtain independent review of each task through `review-task`. Integrate accepted work in dependency order and validate the integrated state. When integration or conflict resolution materially changes the reviewed surface, obtain independent review of that delta before acceptance.

Verify the phase gate condition. Run the full repository suite once here, on the integrated branch, rather than once per task: cross-task interference is only observable after integration.

Then close the phase:

1. Run the cleanup script and resolve only its exceptions.

   ```powershell
   .\.switchflow\scripts\cleanup-phase.ps1 -PhaseLabel phase-1 -WhatIf   # inspect first
   .\.switchflow\scripts\cleanup-phase.ps1 -PhaseLabel phase-1
   ```

   It removes a branch only when its task is Done, the branch matches the task-branch pattern, and Git reports it fully merged into the integration branch. Everything else is reported and left alone. Do not force past an exception: an unmerged branch or a dirty worktree holds work nobody has reviewed. Resolve it or record it in the phase record.

2. Write the phase record as a comment on the phase parent task.
3. Append friction entries to `.switchflow/friction/<milestone-id>.md`. See that directory's README for what belongs there — framework-level findings only, never task-level ones.
4. Exit.

```markdown
## Phase N closed

- Delivered: {{TASK_PREFIX}}-12, {{TASK_PREFIX}}-13
- Deferred: {{TASK_PREFIX}}-15 — reason
- Integrated at: <sha> on <branch>
- Gate condition: how it was verified
- Cleanup: n branches removed, n exceptions, listed
- Open for next phase: facts the next orchestrator needs
```

The last line makes a cold start possible. If the next orchestrator would need something the record does not carry, the record is wrong.

Do not continue into the next phase. Exiting is the mechanism that keeps orchestration affordable.

When an unforeseen issue makes continued delivery the wrong call, or a decision belongs to {{OWNER_NAME}}, write the phase record with the open question and exit rather than holding the context open.
