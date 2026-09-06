---
name: edit-milestone
description: 'Revise an existing {{PROJECT_NAME_YAML_SINGLE}} milestone outcome, scope or acceptance contract while preserving identity, history and affected delivery work.'
---

# Edit Milestone

Apply the requested change using `doc-09 - Scope-and-revisions.md` and its shared revision procedure. Read that document, `doc-03 - Kanban-workflow.md`, and `doc-07 - Task-contract.md` under `backlog/docs/` first.

Read the current milestone through `milestone view <id> --json`, its linked intake, affected phase records, task fields and owner comments. Inspect targeted repository evidence for impact; exclude the friction log and unrelated implementation detail.

Create or resume a revision intake record. Capture the current revision, concrete proposed contract, UAT changes and affected work. Reuse confirmed decisions. If the new outcome is unclear, use `intake`'s questioning and checkpoint procedure for the unresolved portion.

Apply doc-09's authority and active-work check. Treat explicit owner instructions as authorization for the changes they settle; ask only for remaining material decisions. A phase-only adjustment belongs to `edit-phase`.

Save the full accepted description with `milestone edit <id> --input-file <path>`, including expected revision, reason and owner-authorization reference. For title-only edits use native `milestone rename`; read back identity, task links and the new hash. Never remove/recreate a milestone or replay a stale change after a conflict.

Reconcile affected phases using the shared procedure and `plan-milestone`'s shaping rules. Preserve completed work, update closing UAT, and record the new baseline and which execution grants still apply. Keep affected dispatch suspended until reconciliation finishes; checkpoint partial application so another instance can finish without repeating mutations.

Read back changed records, run `doctor`, and report the contract change, preserved milestone ID, current revision, affected phases, blockers and next authorized action. Stop after revision and planning reconciliation; do not execute the revised plan.
