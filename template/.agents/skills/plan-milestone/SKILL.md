---
name: plan-milestone
description: 'Turn a frozen {{PROJECT_NAME_YAML_SINGLE}} scope contract into ordered phases and ready tasks with context maps. Also used to create or reshape individual tasks.'
---

# Plan Milestone

Produce the phases and tasks that deliver a frozen scope contract. This is the one role that reads the repository broadly, so read it once and write down what the next role would otherwise rediscover.

Read the milestone's scope contract, `backlog/docs/doc-07 - Task-contract.md`, `backlog/docs/doc-03 - Kanban-workflow.md`, the durable documents the work touches, existing tasks and their comments, and enough of the repository to place the work accurately. When a milestone is already part-delivered, read the phase records on its phase parents: they report which dispatch groups held. Do not read the friction log.

Use `.switchflow/scripts/backlog.ps1` for every board read and mutation.

Read the current contract with `milestone view <id> --json` and record its revision on each phase plan. For revisions of existing work, use `edit-phase` or `edit-milestone` and the shared procedure in `backlog/docs/doc-09 - Scope-and-revisions.md`; reuse the shaping rules here instead of recreating the milestone or completed tasks.

## Work within the frozen contract

The scope contract is binding. Do not re-open questions it settled, and do not expand scope because an adjacent improvement is convenient.

If the contract proves wrong or incomplete during planning, checkpoint the evidence and proposed change for `edit-milestone`, using `intake` for unresolved owner decisions. Preserve the accepted contract until revision is authorized and applied. Resume planning against the resulting current revision.

## Shape phases

Group tasks into phases. State an objective gate on the integrated candidate using `doc-04` and the project profile. Documentation-only phases use checks for the affected documentation and board surfaces plus diff review. Runtime or operational changes require the full repository suite and applicable boundary checks. This gate complements independent review; it never replaces it.

Create one parent task per phase and give it a phase label that is unique across the whole board, not just within this milestone. `cleanup-phase.ps1` selects tasks by that label alone and never scopes by milestone, so a label reused in a later milestone puts two milestones of branches in one cleanup run. Number phases continuously, or name them after the work. Add the `coordination` label to the parent. Give the parent the phase plan in its description and state that it is not a worker assignment. Worker tasks are its children and carry the same label.

Group each phase's tasks for dispatch in that plan. You read across the repository and wrote every context map. The orchestrator uses those maps and targeted detail for execution decisions, but does not repeat the planning pass or widen groups; an ungrouped phase is delivered one task at a time.

A group runs in parallel when its tasks have independent outcomes, owned non-overlapping files or a stable interface between them, an explicit integration order, and reviewable stop conditions — the fan-out shape `doc-07` requires. Otherwise sequence them. Both answers are normal: sequencing work that could have run in parallel costs wall time and leaves no trace, so sequence is not the safe default. State the reason for each boundary, so the orchestrator can act on it and the next planning pass can correct it.

```markdown
## Phase 1 plan

- Gate condition: the full suite passes on the integration branch
- Group A, parallel: {{TASK_PREFIX}}-12, {{TASK_PREFIX}}-13 — disjoint files, no shared interface
- Group B, after A: {{TASK_PREFIX}}-14 — consumes the serializer from {{TASK_PREFIX}}-12
```

```powershell
# Set $PhaseLabel to this phase's chosen board-unique label; use it for parent and children.
.\.switchflow\scripts\backlog.ps1 task create 'Deliver export path' -m 'Milestone name' -l $PhaseLabel --desc $PhasePlan --plain
.\.switchflow\scripts\backlog.ps1 task create 'Write CSV serializer' -m 'Milestone name' -l $PhaseLabel -p 1 --desc $TaskBody --plain
```

The milestone closes with a Human-assigned acceptance test built from the contract's UAT definition. Use `create-human-task` and make it depend on the final phase.

## Shape tasks

Apply the task contract's execution-unit rules and the full readiness gate in `doc-07`. Classification is this skill's exit condition: Backlog for missing definition, Blocked for prepared work waiting on named prerequisites, and Ready only when the full gate passes. Record an unblock owner and condition for every Blocked task. Do not weaken or restate the gate.

Split when independent delivery produces a useful result or a safer review boundary. Combine when separation adds coordination without an intermediate result. Remove speculative work.

Give each worker task a context map recording what this repository read established:

```markdown
## Context map

Advisory. Start here; correct it if it is wrong.

- Change: `src/path/file.ts:120-180`
- Test: `tests/path/file.spec.ts`
- Consumers: `src/other.ts:44`
- Pattern to follow: `src/example.ts:60-95`
```

The map is exempt from the description word limit. It is advisory, so a worker that finds it inaccurate corrects course and reports the correction rather than treating it as a contract. An accurate map is the difference between a worker that starts working and one that starts searching.

Set the risk class from `backlog/docs/doc-04 - Engineering-standards.md`. It selects both the verification depth and the capability the worker needs.

## Finish

Separate coordination parents from executable tasks in the report. Show worker counts by status, each Blocked task's waiting reason and unblock owner, and the Ready queue. Do not hide prepared dependency waiting in Backlog.

Re-read every changed task, run `.\.switchflow\scripts\backlog.ps1 doctor`, and report the phases, their gate conditions, each material mutation and its reason, and any assumption a worker will depend on.

Do not implement. When invoked for a single task rather than a milestone, apply the same task rules and skip the phase structure.
