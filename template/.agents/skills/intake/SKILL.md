---
name: intake
description: 'Start or resume scope discovery for a {{PROJECT_NAME_YAML_SINGLE}} milestone, retaining decisions and unanswered questions across instances. Produces an accepted contract, not a delivery plan.'
---

# Intake

Turn a proposed goal into a scope contract {{OWNER_NAME}} can freeze. Resume by intake task ID; if none was supplied, inspect discovery summaries for a matching effort before creating another record.

## Orient and checkpoint

Read `backlog/docs/doc-01 - Project-overview.md`, `doc-02 - Project-profile.md`, `doc-09 - Scope-and-revisions.md`, relevant durable product documents, and overlapping milestones through `milestone view <id> --json`. Read this intake's checkpoint, new owner comments, linked questions and decisive evidence as needed. Use `.switchflow/scripts/backlog.ps1` for board access.

Create or refresh the intake record using doc-09. Capture meaningful answers as they land. A fresh instance must distinguish agreement, recommendation, accepted deferral and unanswered questions without the previous transcript.

Use doc-09's `task edit --description-file` route for checkpoint bodies, then read back JSON. Avoid transporting the checkpoint through a long command-line argument.

Keep product questioning above implementation detail. Read bounded fact-finding reports when a question depends on current behaviour or feasibility; source exploration belongs to a separately scoped investigation or planner. Do not read implementation tasks or diffs as a substitute for discovering the desired outcome.

## Interrogate

Establish the product outcome, exclusions, consequential owner decisions, unraised consequences with recommended defaults, and what {{OWNER_NAME}} will do to judge the result. Use established product terms and clarify overloaded words with concrete scenarios.

Ask independent questions together in a small round, one idea per question, ordered by how much the answer changes. Prefer the host's structured question tool with a recommended option. Questions depending on unanswered prerequisites wait for a later round. Resolve discoverable facts from evidence rather than asking the owner to supply them.

Accept "I don't know". Keep the proposed default provisional until the owner explicitly accepts deferral with that default. Preserve rejected alternatives and why. Checkpoint before moving to the next round.

When questions need separate research, prototypes, dependencies or multiple sessions, read `references/discovery.md`. Expand the existing record only as needed. For answers owned by an external person, use the questionnaire guidance in `doc-07 - Task-contract.md`. Returned facts inform owner decisions.

## Freeze or hand off

Synthesize Goal, In scope, Out of scope, Decisions taken, Alternatives rejected, Deferred questions and accepted defaults, and UAT definition. Verify against confirmed answers and apply doc-09's freeze procedure. For a new milestone, include an intake pointer in the full accepted contract and create it with:

```powershell
.\.switchflow\scripts\backlog.ps1 milestone add 'Milestone name' --description $Scope
```

Set `$Scope` using a single-quoted PowerShell here-string carrying real newlines. After creation, record the returned milestone ID on the intake and read back its scope before closing discovery. Inspect matching milestones before retrying an uncertain write. For an existing milestone, pass the proposed contract to `edit-milestone`; preserve its accepted baseline until that procedure applies the revision.

If discovery remains open, save its next question/action and report the intake ID. If accepted, report the contract and milestone ID. Stop at the contract boundary; phases and delivery require their own invocation and authority. A material deferred question returns to discovery, not an invented answer during planning.
