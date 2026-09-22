# Skills

Switchflow imports eleven repository-local skills. Each owns trigger-specific sequencing and judgement; shared lifecycle, task, delivery, quality, documentation and revision policy stays in the governing Backlog documents.

| Skill | Role | Invocation |
| --- | --- | --- |
| `intake` | Start or resume discovery and establish an accepted scope contract. | Explicit invocation or authorized project lifecycle |
| `edit-milestone` | Revise accepted scope and reconcile affected delivery plans. | Automatic or explicit |
| `edit-phase` | Reshape an existing phase within accepted scope. | Automatic or explicit |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. | Automatic or explicit |
| `orchestrate-phase` | Deliver and checkpoint one authorized phase. | Explicit invocation or approved project plan |
| `orchestrate-project` | Run Intake, Planning, automatic phases and guided UAT. | Explicit owner/browser initiation |
| `guided-uat` | Guide scenario observations and record the owner's verdict. | Automatic at the UAT boundary or explicit |
| `review-framework` | Review external friction and recommend framework improvements without dispatch. | Explicit user invocation only |
| `deliver-task` | Implement one task and hand it off. | Automatic or explicit |
| `review-task` | Independently review a fixed diff. | Automatic or explicit |
| `create-human-task` | Define work only a person can do. | Automatic or explicit |

Every skill declares what it must not read. Those limits are load-bearing rather than economies: they are what keep intake unbiased, the orchestrator bounded, and review independent. The [role contracts](role-contracts.md) own each role's full read limit, produced artifact, exit condition, and authority. A skill file must not contradict or restate them.

## Inspect skills in the browser

Open **Skills** in the Switchflow workspace to browse the eleven Switchflow roles installed in the selected project. Search names and descriptions, select a skill to read its instructions, and expand **Original Markdown** to inspect the complete file including frontmatter. Linked Markdown reference notes are available alongside the instructions. Skill selections have bookmarkable project-scoped URLs.

The inspector reads `.agents/skills/` from the primary governance checkout and is read-only. **Refresh skills** reloads the installed files. Missing or unreadable skills are reported; unrelated personal or project skills are not included.

## Boundaries

Project mode has three routine human steps: Intake, Planning and UAT. The concrete Planning approval authorizes all listed phases through technical review and local integration; automatic continuation reuses `orchestrate-phase` without repeating human start or milestone-acceptance prompts. Standalone phase mode retains its single-phase boundary. Scope changes, bugs and updates use their established routes; protected external actions still need action-specific authority. Intake and Planning support an independent-review toggle that adds agent critique before their existing human decision.

Human clarification and permission requests are written to the configured external operations store by the requesting role. Delivery does not read friction history. `review-framework` reads it only on explicit invocation and never dispatches corrective work into an unrelated phase. `guided-uat` reads acceptance scenarios and candidate evidence, never source code or worker reasoning, and cannot supply the human verdict.

`orchestrate-phase` checkpoints each authorized phase. A related phase may reuse focused context once authorized; stale or crowded context calls for compaction or a fresh start. Targeted reads support dispatch and revision checks. Serial delivery uses `deliver-task`; independent review remains required. Revision checkpoints suspend affected dispatch while scope, evidence and authority are reconciled.

`intake` checkpoints from the start and loads its linked-question reference only for branching discovery. `edit-milestone` and `edit-phase` share doc-09's revision procedure and reuse planner shaping rules. Automatic discovery of an editing skill does not authorize an unrequested scope change.

`deliver-task` is used both by the owner directly and by an orchestrator briefing a worker. One worker takes one task and ends at its handoff; corrections from review stay with the same worker, and a different task gets a new one.

`review-task` is read-only unless the owner separately authorizes a mutation. Blast-radius analysis is an escalation inside it, gated by a stated trigger that every verdict declares.

No skill grants permission to deploy, change live systems, expose secrets, rewrite history, or expand product scope.

## Admitting a skill

Switchflow runs alongside whatever skills the owner has installed, and most of those auto-trigger on a description match rather than on an explicit invocation. That is the hazard, not the skill itself: the same skill is safe when the owner invokes it knowingly and unsafe when it fires inside a role whose contract forbids what it does.

One test decides admission:

**Does the skill change what a role reads, what it produces, or what it may do? If so, it is a role change and belongs in a role contract, not in an installed skill.**

A skill that changes only prose style is admissible but may duplicate AGENTS.md. A skill that widens reads, competes with an existing role, expands scope or authority, raises the quality tier, changes a return envelope, or writes durable state outside the board requires an explicit role-contract change. Import useful practices by adapting their owning policy and smallest workflow entry point together.

A blocklist of skill names is not maintained. It would age badly, and the same skill passes or fails depending on the role that triggers it.

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
