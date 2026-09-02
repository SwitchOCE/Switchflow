# Skills

Switchflow imports six repository-local skills, one per role in the [artifact pipeline](role-contracts.md). Each skill owns trigger-specific sequencing and judgement; shared lifecycle, task, delivery, quality, and documentation policy stays in the governing Backlog documents.

| Skill | Role | Invocation |
| --- | --- | --- |
| `intake` | Establish a milestone's scope contract by interrogating intent. | Explicit user invocation only |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. | Automatic or explicit |
| `orchestrate-phase` | Deliver one phase, then exit. | Explicit user invocation only |
| `deliver-task` | Implement one task and hand it off. | Automatic or explicit |
| `review-task` | Independently review a fixed diff. | Automatic or explicit |
| `create-human-task` | Define work only a person can do. | Automatic or explicit |

## What each skill must not read

Every skill declares a read limit. These are the load-bearing lines, not economies:

| Skill | Must not read | Why |
| --- | --- | --- |
| `intake` | Source code, tasks, diffs | Implementation knowledge anchors questions to what is cheap to build |
| `plan-milestone` | The friction log | Process history is not product evidence |
| `orchestrate-phase` | Diffs, file contents, worker reasoning | Orchestrator context is the scarce resource |
| `deliver-task` | Other tasks, the milestone plan, policy above its risk class | A typo fix should not pay a migration's policy tax |
| `review-task` | The worker's reasoning beyond the factual handoff | Reading the argument converts review into agreement |

## Boundaries

`orchestrate-phase` serves one phase and exits, writing a phase record so the next phase starts with a cold context. It amends tasks and re-dispatches rather than implementing, except within a single-file, no-new-behaviour bound.

`deliver-task` is used both by the owner directly and by an orchestrator briefing a worker. One worker takes one task and ends at its handoff; corrections from review stay with the same worker, and a different task gets a new one.

`review-task` is read-only unless the owner separately authorizes a mutation. It absorbed blast-radius analysis as an escalation gated by a stated trigger, declared in every verdict.

No skill grants permission to deploy, change live systems, expose secrets, rewrite history, or expand product scope.

## Removed skills

`task-creator`, `task-clarifier`, and `milestone-review` merged into `plan-milestone`, which now applies the readiness gate as its exit condition rather than leaving it to a second pass. `task-implementer` became `deliver-task` and `task-reviewer` became `review-task`. `blast-radius-review` became a section of `review-task`. `quality-profile` and `stakeholder-questionnaire` were removed as skills; their content moved into `doc-04` and `doc-07` respectively.

## Validation

Skills are stored in `template/.agents/skills/`. Project and owner tokens are rendered during import. Validate the rendered skills, not the tokenized source, after changing their frontmatter or interface metadata:

```powershell
.\scripts\validate-switchflow.ps1
```

The command performs a disposable import and checks every rendered skill using explicit UTF-8 reads. To also run a Codex validator, pass its script path and a Python environment containing its dependencies:

```powershell
.\scripts\validate-switchflow.ps1 -ValidatorPath 'C:\path\to\quick_validate.py'
```

Structural validation proves the skills parse. It does not prove their decisions are good.
