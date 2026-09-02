---
name: plan-milestone
description: 'Turn a frozen {{PROJECT_NAME_YAML_SINGLE}} scope contract into ordered phases and ready tasks with context maps. Also used to create or reshape individual tasks.'
---

# Plan Milestone

Produce the phases and tasks that deliver a frozen scope contract. This is the one role that reads the repository broadly, so read it once and write down what the next role would otherwise rediscover.

Read the milestone's scope contract, `backlog/docs/doc-07 - Task-contract.md`, `backlog/docs/doc-03 - Kanban-workflow.md`, the durable documents the work touches, existing tasks and their comments, and enough of the repository to place the work accurately. Do not read the friction log.

Use `.switchflow/scripts/backlog.ps1` for every board read and mutation.

## Work within the frozen contract

The scope contract is binding. Do not re-open questions it settled, and do not expand scope because an adjacent improvement is convenient.

If the contract proves wrong or incomplete during planning, stop and return to `intake` rather than deciding on {{OWNER_NAME}}'s behalf. Record what planning revealed so intake resumes from evidence.

## Shape phases

Group tasks into phases. A phase ends at a gate the orchestrator can verify alone: the full repository suite passes on the integrated branch, or an equivalent objective condition. State that condition explicitly for each phase.

Create one parent task per phase and label it `phase-N`. Give it the phase plan in its description and state that it is not a worker assignment. Worker tasks are its children.

```powershell
.\.switchflow\scripts\backlog.ps1 task create 'Deliver export path' -m 'Milestone name' -l 'phase-1' --desc $PhasePlan --plain
.\.switchflow\scripts\backlog.ps1 task create 'Write CSV serializer' -m 'Milestone name' -l 'phase-1' -p 1 --desc $TaskBody --plain
```

The milestone closes with a Human-assigned acceptance test built from the contract's UAT definition. Use `create-human-task` and make it depend on the final phase.

## Shape tasks

Apply the task contract's execution-unit rules and the full readiness gate in `doc-07`. Readiness is this skill's exit condition, not a separate later pass. Do not weaken or restate the gate.

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

Re-read every changed task, run `.\.switchflow\scripts\backlog.ps1 doctor`, and report the phases, their gate conditions, each material mutation and its reason, and any assumption a worker will depend on.

Do not implement. When invoked for a single task rather than a milestone, apply the same task rules and skip the phase structure.
