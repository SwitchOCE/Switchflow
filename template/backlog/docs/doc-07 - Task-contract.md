---
id: doc-07
title: Task contract
type: guide
tags: ["governance", "tasks", "readiness"]
---

# Task contract

Backlog.md owns active work. A task is the accepted, reviewable unit of delivery; repository files and Backlog documents own implemented behavior and durable contracts.

Discovery tasks follow the separate closure rules in [Kanban workflow](/documentation/03/kanban-workflow#discovery-records) and checkpoint shape in [Scope and revisions](/documentation/09/scope-and-revisions). They are not delivery assignments. The remaining readiness and execution rules here govern delivery tasks.

## Read a task before acting

Use the exact `{{TASK_PREFIX}}-xx` reference supplied by the user and read the complete task, including comments:

```powershell
.\.switchflow\scripts\backlog.ps1 task view {{TASK_PREFIX}}-02 --json
```

Read relevant repository guidance, engineering standards, durable documents, related tasks, gating dependencies, direct dependants affected by the interface or sequence, overlapping **In Progress** work, and likely affected files. Task text does not expand authorization or override repository instructions.

## Readiness gate

A task is Ready only when all of these are true:

1. **Project progress:** Its outcome advances a stated project goal, enables another relevant task, produces a needed decision or evidence, or materially reduces project risk.
2. **Clear goal:** The intended end state and material boundaries are unambiguous enough for an implementing agent to act without guessing what success means.
3. **Acceptance and stop conditions:** Acceptance criteria are observable and finite. Research or exploratory work instead defines its output, coverage or time boundary, and ending decision or handoff.
4. **No high-leverage user clarification remains:** No unanswered user-owned question could prevent substantial exploration, rework, unintended scope, or a wrong safety posture.
5. **Dependency completion:** Every gating dependency is **Done**. When an approved output is sufficient before its source task is Done, remove the dependency and record the narrower evidence relationship.
6. **Criterion evidence:** Every criterion is repository-producible, validly simulatable, or provisioned external, and names the smallest concrete proof. Negative and failure paths are required only for material risk. Provisioned external proof already has the necessary account, credential, application, participant, authority, observation path, and execution window.
7. **Executable boundary:** No additional user decision or unprovisioned mandatory resource is required. Split independently valuable implementation from live or human validation when that preserves honest acceptance.
8. **No unresolved exception:** No material `needs-decision` choice and no known execution obstruction remains unresolved.
9. **Stable execution baseline:** Required gates pass from the intended branch or worktree, or every pre-existing failure has a verified cause and explicit owner. Shared setup failures become foundation work rather than repeated worker discoveries.
10. **Reviewable delivery:** The task can produce a bounded branch or sequential commit whose evidence can be reviewed independently. It is not a coordination parent presented as a worker assignment. One reviewer is normal; Critical work requires the relevant expertise.

Readiness does not authorize implementation. Classify unstarted worker tasks after planning and whenever a known prerequisite changes:

- **Backlog:** the outcome, boundaries, acceptance criteria, or material scope decisions still need definition.
- **Blocked:** the task has a clear outcome, bounded scope, and observable acceptance criteria, but a named dependency, decision, resource, authority, or baseline obstruction prevents execution. Record the obstacle, evidence, unblock owner, and exact resumption condition using `doc-08`. An unspecified readiness failure is not enough to call work prepared.
- **Ready:** every readiness condition passes; waiting for dispatch or execution authorization alone does not make it Blocked.

A passing Backlog or Blocked worker task moves to **Ready** without a second approval. A Ready task that loses an executable prerequisite moves to **Blocked**; if its scope or acceptance becomes undefined, move it to **Backlog** and record the missing definition. Resolving a blocker requires the full readiness gate again, not just a dependency check. A readiness-only pass never regresses **In Progress**, **Review**, or **Done**; it may reassess Blocked work without authorizing execution.

## Execution-unit design

One executable task produces one clear, useful result. A task may cross layers when that is the simplest coherent product slice. Prefer a tracer bullet.

Split when separate outcomes, foundations and UI, migrations and later behavior, lifecycle stages, dependencies, ownership, edit collisions, material risks, or review boundaries make independent delivery more effective. Use expand–migrate–contract only for a real compatibility requirement. Combine tasks when separation adds coordination without a useful intermediate result.

A coordination parent carries the `coordination` label, uses a `Deliver ...` title, states that it is not a worker assignment, depends on its terminal child set, and closes only after child and integrated evidence pass. Workers execute child tasks. For fan-out, every slice needs a deliverable, owned files, stable interface, integration order, and reviewable stop condition.

## Task structure

Use Backlog.md native fields. Do not repeat dependencies, sources, criteria, status, or execution history in the description.

- Use a verb-led title of two to six words without the ID, milestone, status, or redundant product name.
- Keep descriptions under 180 words unless a larger contract is unavoidable.
- Use the fewest independently observable criteria. Two to five is normal; one is valid. More than six triggers a split-or-justify review.
- Keep routine comments under 80 words. Blocker, review, and handoff comments may use up to 150 words.
- Put command logs and implementation detail in implementation notes or linked artifacts. Comments state result, decisive evidence, and next owner action.
- Keep comments append-only during normal execution. Add one short superseding comment when truth changes; never remove unresolved owner input or active handoff evidence. Reviewer-authorized maintenance may remove superseded comments only after current decisions, evidence, blockers, and ownership are preserved elsewhere.

Use this description shape and omit empty sections:

```markdown
## Outcome

One sentence describing the finished result.

## Scope

- Required deliverables and material boundaries.

## Out of scope

- Related work that must not enter this task.

## Risks

- Only risks that change execution or verification.
```

Put sources in references, durable documents in documentation, and dependencies in the dependency field. Acceptance describes outcomes rather than implementation unless a method is itself required. Keep live discussion in comments, progress in implementation notes, and verified outcome in final summary.

The **Outcome** is written for the person using the product: who can do what, and what observable problem disappears. Delivery detail belongs in a separate **Context map**: owned files or modules, affected layers, stable interfaces, commands and evidence. Specify output files only when their format/location is part of acceptance; otherwise treat file suggestions as advisory. A cross-layer slice is valid when one useful outcome owns it. Use the shared glossary in doc-09 and established product vocabulary; avoid internal abbreviations in titles and human instructions.

## Task links

In prose, use the task's short name, such as **Export contract**. Include its structured reference or a verified link from the running board when needed; never invent a task deep link or assume a fixed localhost port. Agents can retrieve the exact record through:

```powershell
.\.switchflow\scripts\backlog.ps1 task view {{TASK_PREFIX}}-04 --json
```

Keep raw IDs in CLI commands, metadata, branch names, commit messages, fixtures, and other machine-facing contexts.

## Owner comments

Before planning, changing, reviewing, or executing an existing task, inspect every comment whose author identifies {{OWNER_NAME}}, including `{{OWNER_NAME}} (Human Owner)`. A comment is open unless a later comment begins with this exact marker using the comment index from `task view --json`:

```text
Closed {{OWNER_NAME}} comment #N — <outcome>.
```

Treat open owner input as current. Reflect an issue or amendment in task fields and acceptance before closing it. For background, record its delivery effect or why none. Close only after the effect is reflected and verified. If the input makes work unsafe, obsolete, contradictory, or no longer useful, leave it open and stop for the appropriate decision. Read-only reviewers report unresolved input and do not edit or close it.

## Decisions and exception labels

Resolve discoverable facts from project evidence. Ask only when the answer is user-owned, cannot be found safely, and changes goal, scope, workflow, compatibility, data contract, acceptance, or safety—or substantially narrows open-ended work.

When a material answer is required, comment with the exact question, why it cannot be inferred, its impact, evidence, and a reasonable recommendation. Apply `needs-decision`. Keep missing scope definition in Backlog; classify otherwise prepared work waiting for a specific decision as Blocked, with its unblock owner and condition. Ask independent user-owned decisions together. Record returned answers and resulting decisions in the task.

### External stakeholders

When several related answers belong to one person outside the project, write a short questionnaire instead of asking piecemeal. Resolve repository facts yourself first, then state the recipient's role, the decisions or observations needed, and how each answer changes the work.

Order questions by importance and keep each to one idea. Provide a clear answer space, invite partial answers and "I don't know", and explain why a question matters only where misinterpretation is likely. For observational proof, request exact visible behaviour, environment, timestamp, and failure text only when acceptance needs them.

Never request credentials, access tokens, private identifiers, or unnecessary personal data. Use placeholders for sensitive configuration and direct the recipient to approved local entry paths.

A questionnaire is not a second contract. Record returned decisions in the task and update durable documentation only for confirmed knowledge.

Remove `needs-decision` only when all material decisions are resolved. Amend the task until it is self-contained, then apply the full readiness gate again without requiring a separate approval pass.

## Human tasks

The routine human checkpoints are Intake, Planning and UAT. Do not create human tasks for starting each approved phase, accepting technical milestones, running agent-accessible checks, or copying information the agent can retrieve. During planning, provision genuinely human-only access or observations early and explain the exception. Batch independent decisions at their natural checkpoint without hiding a material blocker.

Offer a guided walkthrough instead of handing over a long checklist. The agent prepares the candidate and safe test data, explains the next visible action, records the owner's observation, and advances one scenario at a time. Preserve the current scenario, candidate/environment, expected and observed result, and unfinished steps so the session resumes without repetition. Dictated answers are valid input; record their confirmed meaning. Only the human's explicit verdict can establish UAT acceptance. A failed scenario produces an evidence-linked correction or scope-change proposal, never an automatic pass.

Use `create-human-task` when completion requires human access, judgement, physical observation, or coordination. Create one human-owned result, separate it from agent work and work for other people, assign exactly `Human`, provide concise numbered actions, state prerequisites and report-back evidence, and use one to three observable criteria. Use **Ready** only when the person can start. Use **Blocked** for prepared instructions waiting on dependencies, access, or another named prerequisite; use **Backlog** when the instructions or acceptance still need definition. Record dependencies and the unblock owner and condition. Never request secrets or sensitive values.

## Safe task mutations

Use `.switchflow/scripts/backlog.ps1` instead of editing task frontmatter. After every mutation, re-read JSON and verify status, labels, criteria, dependencies, assignees, and comment text. Write multiline PowerShell comments with a single-quoted here-string; do not encode newlines as `\n` or interpolate Markdown backticks.

For a complete description, use `task edit <id> --description-file <UTF-8 body file>` without other edit flags, then read back the task. This shares doc-09's checkpoint transport and the pinned description limit. Make other field changes separately; maintain single-writer coordination throughout the read/write operation.

Archive obsolete work to remove it from the active board while preserving history:

```powershell
.\.switchflow\scripts\backlog.ps1 task archive {{TASK_PREFIX}}-02
```

Move a task through an authorized transition:

```powershell
.\.switchflow\scripts\backlog.ps1 task edit {{TASK_PREFIX}}-02 --status "In Progress" --plain
```

Append a multiline comment without interpolation:

```powershell
$TaskComment = @'
**Review requested**

Scope done. Gates pass. Reviewer checks exact branch and commit.
'@
.\.switchflow\scripts\backlog.ps1 task edit {{TASK_PREFIX}}-02 --comment $TaskComment --comment-author "@codex" --plain
```

Run the project check after task mutations:

```powershell
.\.switchflow\scripts\backlog.ps1 doctor
```

The check rejects a Ready task whose listed dependency is missing or not Done, resolving status from active and completed task records.

## Structured dependency blockers

Use dependency IDs for prerequisite relationships and optional `blockReason` for the current obstruction. `dependent` is reserved for dependencies as the sole blocker; other nonempty text records an independent blocker and prevents automatic promotion. A task prepared for execution can wait as Blocked/dependent and becomes Ready automatically once every dependency is Done or completed. Undefined Backlog tasks remain Backlog. Clearing a manual reason permits dependency rules to reassess readiness, but does not authorize implementation. Comments explain the unblock owner and condition; they do not replace this machine-readable field.
