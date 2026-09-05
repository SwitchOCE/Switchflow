---
name: orchestrate-phase
description: 'Deliver one phase of a prepared {{PROJECT_NAME_YAML_SINGLE}} milestone by dispatching workers, checkpointing them, integrating, and recording the outcome. Use only when explicitly invoked.'
---

# Orchestrate Phase

Deliver the named phase and record what the next phase needs. Explicit invocation designates this agent as orchestrator for that phase with the authority described in `backlog/docs/doc-03 - Kanban-workflow.md`. Reusing this context does not authorize another phase.

Your context is the scarce resource this whole design protects. Everything below exists to keep it small.

## Read narrowly

Read the milestone record, the phase parent task and its prior phase records, and the identifiers, statuses, dependencies, risk classes and context maps of this phase's tasks. Use targeted task reads to obtain dispatch fields missing from summaries.

Avoid broad repository reads and worker reasoning. Read additional task detail when needed to judge a checkpoint, resolve a blocker or understand a contested verdict. Read only the affected diff and file sections when resolving a merge conflict or making a correction within the direct-implementation bound below. Independent review remains required; these reads do not make the orchestrator its own reviewer.

## Dispatch

Dispatch the groups the phase plan defines. The planner set them with repository-wide knowledge; targeted orchestration reads are not a reason to re-derive the grouping.

Collapse a group to sequential when phase evidence contradicts the plan — an unexpected shared file, an interface that proved unstable — and record why. Do not widen one: that needs a planning pass across all affected tasks. Record the opportunity in the phase record so the next planning pass can act on it.

Give each worker one task, the context it needs, and a non-overlapping surface. Use `deliver-task`. Choose worker capability from the task's risk class: Documentation-only and Standard take a smaller model, Elevated and Critical take a frontier model.

Resolve shared setup once, and run the preflight from the accepted dispatch checkout against each worktree before dispatching into it. It checks governance metadata against that checkout, then confirms the pinned Backlog CLI resolves and the task is readable. Matching metadata is not proof of identical files: create worktrees from the accepted project commit.

```powershell
.\.switchflow\scripts\check-worktree-tools.ps1 -Worktree ..\wt-{{TASK_PREFIX}}-14 -TaskId {{TASK_PREFIX}}-14
```

**One worker, one task.** A worker ends at its handoff. The next logical task gets a new worker to keep scope and task ownership separate. This is a workflow boundary, not a claim that restarting is always cheaper: cached context can be inexpensive to reuse. Corrections arising from review are the same task and stay with the same worker.

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
- Open for next phase: facts the next orchestrator needs
```

The last line makes a cold start possible. If the next orchestrator would need something the record does not carry, the record is wrong.

## Continue or restart

For a separately authorized related phase, reuse this orchestrator when its context remains focused and useful. Refresh current board state and owner comments before dispatching. Start fresh when accumulated context is stale, crowded or no longer relevant. Ending a turn does not clear context or guarantee a cache reset.

Use the host's compaction when available; do not restart solely because a phase ended. Without compaction, checkpoint and hand off before context is exhausted, even mid-phase. Record active task and worker IDs, branch/worktree locations, integration SHA, completed actions, pending reviews, blockers and the next step so a resumed agent does not duplicate work.

Cache reuse depends on a matching prompt prefix and cache availability. A restart or compaction can reduce reuse; fewer input tokens can still reduce total cost. Judge this tradeoff using measured cost and outcomes, not cumulative token volume alone.

When an unforeseen issue makes continued delivery the wrong call, or a decision belongs to {{OWNER_NAME}}, record the open question and pending work, then return control. Resume only after the blocker is resolved; a new context is optional.
