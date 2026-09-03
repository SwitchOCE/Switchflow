# Skills

Switchflow imports six repository-local skills, one per role in the artifact pipeline. Each skill owns trigger-specific sequencing and judgement; shared lifecycle, task, delivery, quality, and documentation policy stays in the governing Backlog documents.

| Skill | Role | Invocation |
| --- | --- | --- |
| `intake` | Establish a milestone's scope contract by interrogating intent. | Explicit user invocation only |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. | Automatic or explicit |
| `orchestrate-phase` | Deliver one phase, then exit. | Explicit user invocation only |
| `deliver-task` | Implement one task and hand it off. | Automatic or explicit |
| `review-task` | Independently review a fixed diff. | Automatic or explicit |
| `create-human-task` | Define work only a person can do. | Automatic or explicit |

Every skill declares what it must not read. Those limits are load-bearing rather than economies: they are what keep intake unbiased, the orchestrator bounded, and review independent. The [role contracts](role-contracts.md) own each role's full read limit, produced artifact, exit condition, and authority. A skill file must not contradict or restate them.

## Boundaries

`orchestrate-phase` serves one phase and exits, writing a phase record so the next phase starts with a cold context. It amends tasks and re-dispatches rather than implementing, except within a single-file, no-new-behaviour bound.

`deliver-task` is used both by the owner directly and by an orchestrator briefing a worker. One worker takes one task and ends at its handoff; corrections from review stay with the same worker, and a different task gets a new one.

`review-task` is read-only unless the owner separately authorizes a mutation. Blast-radius analysis is an escalation inside it, gated by a stated trigger that every verdict declares.

No skill grants permission to deploy, change live systems, expose secrets, rewrite history, or expand product scope.

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
