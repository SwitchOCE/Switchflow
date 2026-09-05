---
name: orchestrate-phase
description: 'Deliver one phase of a prepared {{PROJECT_NAME_YAML_SINGLE}} milestone through direct serial delivery or parallel workers, independent review, integration, and a phase record. Use only when explicitly invoked.'
---

# Orchestrate Phase

Deliver the named phase and record what the next phase needs. Explicit invocation designates this agent as orchestrator for that phase with the authority described in `backlog/docs/doc-03 - Kanban-workflow.md`. Reusing this context does not authorize another phase.

Retain useful context for related serial work. Add delivery agents when parallel work or a stated capability or isolation benefit justifies the extra coordination.

## Read narrowly

Read the milestone record, the phase parent task and its prior phase records, and the identifiers, statuses, dependencies, risk classes and context maps of this phase's tasks. Use targeted task reads to obtain dispatch fields missing from summaries.

While coordinating workers, avoid broad repository reads and worker reasoning. Read additional detail for a checkpoint, blocker, contested verdict or integration change. While delivering directly, follow the task-sized reads in `deliver-task`. Independent review remains required in either mode.

## Keep status current

At phase start, classify its unstarted worker tasks under `doc-07` and mark the coordination parent In Progress. At handoff, verify the worker is in Review before requesting independent review. Keep it there through required integration and validation, then accept it as Done. After dependency completion or blocker resolution, re-read affected direct dependants and owner comments and reapply the full readiness gate. Ready means executable, including work awaiting authorization; Blocked means prepared but waiting on a named obstacle. Record the waiting reason, evidence, unblock owner, and resumption condition. Do not dispatch a newly Ready task outside the authorized phase.

Use `backlog.ps1 flow` at phase opening and closing to report worker queues separately from coordination parents and show recently updated records. Do not infer readiness from this snapshot alone.

## Choose delivery mode

Dispatch the groups the phase plan defines. The planner set them with repository-wide knowledge; targeted orchestration reads are not a reason to re-derive the grouping.

Collapse a group to sequential when phase evidence contradicts the plan — an unexpected shared file, an interface that proved unstable — and record why. Do not widen one: that needs a planning pass across all affected tasks. Record the opportunity in the phase record so the next planning pass can act on it.

When only one delivery task is ready within the planned group, use `deliver-task` yourself. Complete its handoff, obtain independent review of the exact candidate, integrate and accept it before starting a dependent successor. Retain useful context across related serial tasks; refresh each task, its owner comments and changed source facts. Corrections stay with the author.

When at least two independent tasks in a planned parallel group are ready, coordinate delivery workers. A serial task may also use a worker for a stated capability or isolation benefit; record the reason. Give each worker one task and a non-overlapping surface using `deliver-task`. Choose the lowest capability adequate for the assigned risk and work, including the whole serial segment for a direct runner. Respect host model settings; do not assume moving work to a more capable parent saves cost.

Include a compact environment note in each dispatch: accepted base and worktree, verified command forms, pinned dependency state and known access route. These are facts, not transferred permissions. Refresh changed facts at checkpoints; do not repeat discovery merely because the role changed.

Keep the board running during ordinary orchestration. Application dependencies and `.switchflow/node_modules` are separate installations. Before `npm ci --ignore-scripts`, stop only application or test processes using the target checkout's application dependencies. Stop the board only before replacing the `.switchflow` installation it actually uses; a worktree may be using the primary checkout's installation. Reuse a matching pinned Backlog installation instead of reinstalling it for each worker. If board maintenance is necessary, record its checkout and launch options, restart it after the attempt (including recovery after failure), and verify its HTTP endpoint before reporting it available. Never stop unrelated Node processes.

Prepare only the next ready group by default. Prewarm a gated worktree only when likely dispatch and saved setup time justify it; record the prerequisite revision that must be refreshed before preflight. Do not install speculative future groups. Reuse verified pinned tooling and dependency facts when still valid.

Resolve shared setup once, and run the preflight from the accepted dispatch checkout against each worktree before dispatching into it. It checks governance metadata against that checkout, then confirms the pinned Backlog CLI resolves and the task is readable. Matching metadata is not proof of identical files: create worktrees from the accepted project commit.

```powershell
.\.switchflow\scripts\check-worktree-tools.ps1 -Worktree ..\wt-{{TASK_PREFIX}}-14 -TaskId {{TASK_PREFIX}}-14
```

**One task, one delivery boundary.** Keep criteria, commits, evidence and review separate for every task. A delegated worker stops at its handoff; corrections stay with it. The phase agent may retain context for the next authorized serial task after acceptance. Context reuse does not merge task scope or allow self-review.

## Checkpoint before implementation

State the three-line approach for every task: files, approach, stop condition. Confirm or correct delegated workers before they implement. For direct delivery, check the approach against the accepted task and proceed within existing authority; do not wait for self-confirmation or invent a new approval gate.

## Wait for meaningful events

While workers or reviewers run, do useful independent work or use the host's event wait for a checkpoint, completion, blocker or user input. Use the longest interval permitted by higher-priority host instructions and appropriate to the work. Do not add status reads or shorter polling when the wait already supplies progress.

An empty timeout adds no delivery evidence. Avoid repetitive updates where the host allows quiet waiting; comply with any required progress cadence. Repository instructions cannot override a host wait limit or commentary requirement. Change that behavior only through a documented host setting if available. Direct serial delivery removes idle coordination while implementing, but still waits for independent review.

## Handle corrections

When execution evidence contradicts the plan, amend the task within the frozen scope and reapply readiness. Direct-delivery corrections stay here; delegated corrections return to their author. Resolve integration conflicts within phase authority and send any material authored delta for independent review. Scope changes beyond the grant still need the owner.

Product decisions, scope changes beyond the frozen contract, secrets, live external actions, pushing, shared-history rewrites, and branch deletion remain separately authorised.

## Integrate and close

Obtain independent review of each task through `review-task`. Integrate accepted work in dependency order and validate the integrated state. When integration or conflict resolution materially changes the reviewed surface, obtain independent review of that delta before acceptance.

Verify the recorded phase gate on the integrated candidate using `doc-04` and the project profile. Documentation-only phases use documentation and board checks for affected surfaces plus diff review. Runtime or operational risk requires the applicable repository suite and boundary checks. Do not silently weaken an existing explicit gate; amend it under phase authority with the risk-based reason first. Reuse evidence still valid for the exact candidate.

Mark the parent Review when implementation is complete and the integrated phase gate awaits acceptance. After independent acceptance and the phase gate pass, mark it Done. Refresh affected dependants before the final snapshot.

Then close the phase:

1. Run the cleanup script and resolve only its exceptions.

   ```powershell
   # Set $PhaseLabel to the exact board-unique label on the phase parent.
   # Set $BranchPattern from the project profile's Task branch naming section.
   .\.switchflow\scripts\cleanup-phase.ps1 -PhaseLabel $PhaseLabel -BranchPattern $BranchPattern -WhatIf
   .\.switchflow\scripts\cleanup-phase.ps1 -PhaseLabel $PhaseLabel -BranchPattern $BranchPattern
   ```

   It removes a branch only when its task is Done, the branch matches the task-branch pattern, and Git reports it fully merged into the integration branch. Everything else is reported and left alone. Do not force past an exception: an unmerged branch or a dirty worktree holds work nobody has reviewed. Resolve it or record it in the phase record.

2. Write the phase record as a comment on the phase parent task.
3. Append friction entries to `.switchflow/friction/<milestone-id>.md`. See that directory's README for what belongs there — framework-level findings only, never task-level ones.
4. Finish the authorized phase. Apply the context guidance below before another phase.

```markdown
## Phase N closed

- Delivered: {{TASK_PREFIX}}-12, {{TASK_PREFIX}}-13
- Deferred: {{TASK_PREFIX}}-15 — reason
- Integrated at: <sha> on <branch>
- Gate condition: how it was verified
- Cleanup: n branches removed, n exceptions, listed
- Grouping: which groups held, and any that should have been wider or narrower
- Execution: direct or delegated per task, and reasons for serial delegation
- Efficiency: where telemetry is available, total tree cached/uncached input, output, models, active elapsed time, first-review acceptance and correction count
- Open for next phase: facts the next orchestrator needs
```

The last line makes a cold start possible. If the next orchestrator would need something the record does not carry, the record is wrong.

## Continue or restart

For a separately authorized related phase, reuse this orchestrator when its context remains focused and useful. Refresh current board state and owner comments before dispatching. Start fresh when accumulated context is stale, crowded or no longer relevant. Ending a turn does not clear context or guarantee a cache reset.

Use the host's compaction when available; do not restart solely because a phase ended. Without compaction, checkpoint and hand off before context is exhausted, even mid-phase. Record active task and worker IDs, branch/worktree locations, integration SHA, completed actions, pending reviews, blockers and the next step so a resumed agent does not duplicate work.

Cache reuse depends on a matching prompt prefix and cache availability. A restart or compaction can reduce reuse; fewer input tokens can still reduce total cost. Judge this tradeoff using measured cost and outcomes, not cumulative token volume alone.

When an unforeseen issue makes continued delivery the wrong call, or a decision belongs to {{OWNER_NAME}}, record the open question and pending work, then return control. Resume only after the blocker is resolved; a new context is optional.
