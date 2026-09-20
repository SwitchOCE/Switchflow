---
id: doc-09
title: Scope and revisions
type: guide
tags: ["governance", "intake", "planning"]
---

# Scope and revisions

This document owns intake checkpoints, accepted scope baselines, and the shared revision procedure. The [Kanban workflow](/documentation/03/kanban-workflow) owns authority and statuses; the [task contract](/documentation/07/task-contract) owns readiness and owner input. Skills choose the relevant steps without copying this policy.

## Intake state

Intake covers a whole project outcome or multiple delivery phases, as well as a small change. Begin with a concise **Current capabilities** inventory: what already works, evidence/source, known limitations, and the gap to the requested outcome. Distinguish reported, observed and proposed behaviour. Reuse current documentation and bounded investigations; do not make the owner rediscover repository facts or silently treat old memory as current proof.

Record the selected review mode (**standard** or **independent review**) for Intake and Planning. The browser initiative's `reviewMode` toggle covers both gates. Independent review critiques missing decisions, coherence and acceptance coverage before the owner's existing gate. Its findings return to the current writer; it neither approves product scope nor creates another mandatory human step. Changing the toggle does not erase prior answers or execute delivery.

Start an editable Backlog task when intake begins, before the contract is settled. Use `discovery` and `coordination` labels and title it `Clarify <outcome>`. Keep it outside delivery milestones and phase labels, including when revising a milestone: link that milestone through references instead. Discovery is not delivered product work and must not inflate milestone completion or executable worker queues.

The description is the current checkpoint; comments retain answers and superseded decisions; references point to evidence and accepted milestones. This is active work, so it belongs on the board rather than in product documentation or a temporary handoff file. The normal short description limit does not apply, but prefer links over repeated history.

```markdown
## Destination
The outcome to clarify; milestone ID when revising one.

## Draft contract
Goal, in scope, out of scope, and how the owner will judge the result.

## Current capabilities
Observed or reported behaviour, evidence, limitations, and required changes.

## Project progression
Proposed outcomes across milestones/phases, dependencies, review mode,
and the final UAT boundary. Planning owns executable decomposition.

## Confirmed decisions
Stable question IDs, answers, rationale, and pointers to owner answers.

## Provisional defaults
Recommendations awaiting agreement; these are not confirmed decisions.

## Deferred questions
Question, explicitly accepted default, and condition for revisiting it.

## Open questions
Precise questions, prerequisites, answer owner, and why each changes the work.

## Not yet specified
In-scope uncertainty that cannot yet be phrased as a precise question.

## Resume
Next question/action, waiting work and owner, evidence pointers, active writer,
last checkpoint; for edits, baseline revision and application progress.
```

Omit empty sections. Keep rejected alternatives with the relevant decision. Distinguish observed current behaviour from desired behaviour. An unanswered recommendation never becomes agreement through elapsed time, compaction, or a new agent instance.

After meaningful answers or findings, append the outcome and rationale, then refresh the checkpoint. Before handing off, record the next step and incomplete writes. Return the intake ID so a fresh instance can resume.

Create the task with a short description, then save checkpoint Markdown as a UTF-8 file containing real newlines and replace its description through the wrapper. This file route preserves the observed task status and uses the pinned MCP; keep one writer active while it reads and writes. Backlog limits descriptions to 10,000 characters: keep the checkpoint compact and link detailed question records rather than truncating answers.

```powershell
.\.switchflow\scripts\backlog.ps1 task edit TASK-ID --description-file .\intake-checkpoint.md
.\.switchflow\scripts\backlog.ps1 task view TASK-ID --json
```

Read documents with `doc view <id>` (plain Markdown), milestone listings with `milestone list`, and individual milestone baselines with `milestone view <id> --json`. Native document views and milestone listings do not accept `--json`.

On resumption, read the checkpoint and new owner comments first, then only evidence needed for the next question. Reconcile differences between comments and summary before continuing. Re-read before every replacement; one intake writer owns the checkpoint at a time. Research workers update their own question records. A claim is a coordination convention, not an atomic lock: resolve competing writers before replacing shared state.

For branching intake, the `intake` skill's `references/discovery.md` expands the same record into linked questions. Short intake stays in one record.

## From discovery to an accepted contract

Freeze when every material question is confirmed or explicitly deferred with an accepted default, and the owner has accepted the concrete scope and UAT definition. Existing owner instructions can satisfy this; ask only about remaining material choices. Freezing scope does not authorize implementation.

For a new milestone, create its record once with the full accepted contract and an intake pointer. Record the returned milestone ID on the intake immediately. If a write is interrupted or uncertain, inspect `milestone list` and matching records before retrying to avoid duplicates. Mark the intake Done only after reading back the milestone and matching it to the accepted contract.

Confirmed product vocabulary belongs in the most relevant existing durable document. Create a native Backlog decision when a choice is costly to reverse, involves a real tradeoff, and needs rationale a future reader would otherwise miss. Keep current and desired behaviour distinguishable: an accepted plan is not proof it shipped.

## Current milestone baseline

```powershell
.\.switchflow\scripts\backlog.ps1 milestone view m-0 --json
```

The wrapper returns the description and its `revision` (SHA-256 of the whole record). Plans and phase records name the scope revision they used. A changed hash calls for comparison, not automatic rejection of valid work: a rename also changes it. Legacy milestones need no conversion; their current record is the initial baseline.

The pinned Switchflow fork supports revision-checked milestone title, description, labels and execution-order edits through CLI and MCP. The scope-revision adapter preserves exact previous content and approval evidence, then delegates the description change to that native CAS editor using its shared mutation lock. Identity, task assignments and dependencies remain stable. Never remove/recreate a milestone to revise scope.

## Shared revision procedure

1. **Establish the baseline.** Read the current contract, relevant owner comments, phase plans and records, affected tasks, direct dependants and active assignments. Capture the milestone revision and affected phase/task before-state. Inspect implementation evidence only for concrete impact; exclude the friction log.
2. **Show the change.** State the trigger, old/proposed outcome, scope/UAT changes, affected gates and task IDs, and evidence or authorization invalidated. Preserve unrelated work. An implementation finding informs a product decision; it does not settle it for the owner.
3. **Resolve authority and active work.** Apply explicit owner instructions already given. Resolve remaining material product choices against a concrete proposed contract. Within unchanged scope, planning may reshape tasks under its existing grant. Before changing a contract used by active work, have its orchestrator checkpoint affected workers, preserve worktrees and evidence, and suspend affected dispatch. If coordination is unavailable, save the proposal and leave the accepted baseline unchanged. Unaffected authorized work can continue.
4. **Apply from fresh state.** Re-read the baseline and owner comments; reconcile intervening changes before writing. For milestone changes, save the accepted contract with the adapter, then align affected phases/tasks and closing UAT. For phase-only changes, leave the milestone unchanged. Record progress after each material mutation: board updates are not one transaction, so affected dispatch stays suspended until reconciliation finishes.
5. **Reassess and hand off.** Preserve Done records and accepted evidence as history; create follow-up tasks for newly required work. Archive obsolete unstarted work recoverably. Reassess unstarted tasks against the full readiness gate, dependencies, board-unique phase labels, dispatch groups, context maps and phase gates. For In Progress or Review work, its orchestrator explicitly determines whether scope/evidence remain valid and records rework transitions; editors do not silently reset statuses. Record which grants still apply. An edit and readiness authorize no new delivery.

Finish with readback, `doctor`, changed records and reasons, remaining blockers and next authorized action. If interrupted, resume from the revision checkpoint and current board, completing only unapplied changes. Rollback is another revision against current state, not deletion of history or automatic replay over later work.

## Milestone edit transport and history

Save a UTF-8 JSON file with exactly these fields. `description` is the full new contract; use a JSON serializer to preserve newlines, quotes, Unicode and Markdown.

```json
{
  "expectedRevision": "<revision returned by milestone view>",
  "description": "## Goal\n\nThe full accepted contract...",
  "reason": "What changed and why; pointer to the revision intake",
  "approval": "Pointer to the owner's instruction accepting this change"
}
```

```powershell
.\.switchflow\scripts\backlog.ps1 milestone edit m-0 --input-file .\scope-change.json
.\.switchflow\scripts\backlog.ps1 milestone view m-0 --json
```

Paths resolve from the caller's directory. The adapter checks input and expected revision, saves a prepared snapshot, and delegates the mutation to the native CAS editor. Browser, CLI and MCP writers participate in that shared mutation lock. A separate applied receipt records success. Approval text remains an audit reference, not a machine-verified grant; an expected revision protects state consistency without granting scope authority.

Prepared snapshots under `backlog/archive/milestone-revisions/<id>/` hold exact previous content, baseline hash, intended description, reason and approval reference. A separate `.applied.json` receipt records native CAS success and the resulting revision. `milestone view` lists the prepared snapshots. Keep this evidence in version control. An interrupted attempt can leave an unused snapshot: the current milestone is authoritative, and a snapshot alone does not prove completion. Restore by extracting the previous description and submitting a new edit against today's revision. Native task/milestone mutation locks coordinate writers; do not remove a lock while any writer is active. Re-read current state and receipts before retrying an uncertain operation.

## Shared glossary

| Term | Meaning |
| --- | --- |
| Intake | Human agreement on the intended outcome and acceptance boundary. |
| Planning | Human review and approval of a concrete execution plan. |
| Scope contract | Accepted outcomes, exclusions, decisions and UAT definition. |
| Milestone | A coherent product outcome with a recorded acceptance boundary. |
| Phase | Agent-managed delivery group ending in an integrated technical gate. |
| Task | One independently reviewable unit of useful delivery. |
| Technical acceptance | Independent review and required checks passed for the candidate. |
| UAT | User acceptance testing: the human's observations and explicit product verdict. |
| Candidate | Exact revision and environment presented for review or UAT. |
| Project grant | Owner approval to execute the listed plan until its UAT boundary. |
| Scope change | An agreed revision to accepted outcomes or exclusions. |
| Update | A read-only progress report; it grants no new delivery authority. |
| Friction | A recorded process obstacle or human interruption for later framework review. |
| Scratch | Transient, unaccepted working material outside canonical governance. |

Use these meanings consistently and add domain terms to the project's durable vocabulary. Technical phase completion does not mean UAT has passed. In a project grant spanning several milestones, collect their UAT scenarios into the final guided human session unless the owner explicitly requires an intermediate human gate.

## Milestone identity and intended sequence

Milestone IDs such as `m-7` are stable identifiers only. Their numbers never define delivery priority or execution order. Use optional `executionOrder` for the intended sequence, labels for grouping and filtering, title for the human outcome, and description for the scope contract. Dependencies and the approved plan still constrain execution; changing display order does not authorize new work or bypass a prerequisite. Unordered milestones remain explicitly unsequenced rather than acquiring an order from their ID.

Milestones remain editable after creation. Use `milestone view <id> --json` to read the current revision and `milestone edit <id> --expected-revision <revision>` with `--title`, `--description`, `--labels`, `--execution-order` or `--clear-execution-order` for metadata changes. A stale revision must be reconciled, never overwritten blindly. Scope changes retain the accepted-scope procedure and its reason/approval snapshot route; metadata editing does not grant scope-change authority. Prepared revision snapshots record an attempted change; an applied receipt records native CAS success. An interrupted snapshot without its receipt requires reading current state before retrying.
