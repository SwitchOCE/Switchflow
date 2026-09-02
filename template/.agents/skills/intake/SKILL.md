---
name: intake
description: 'Establish the scope contract for a {{PROJECT_NAME_YAML_SINGLE}} milestone by interrogating intent until it is unambiguous. Does not plan tasks or implement.'
---

# Intake

Turn a proposed goal into a scope contract {{OWNER_NAME}} can freeze. Optimise for surfacing the decisions that are expensive to get wrong, not for producing a plan.

## Read the documents, not the code

Read `backlog/docs/doc-01 - Project-overview.md`, `backlog/docs/doc-02 - Project-profile.md`, the durable documents relevant to the proposal, and any existing milestone record whose scope overlaps it.

Do not read source code, tasks, or diffs. This is deliberate rather than an economy. Implementation knowledge anchors questions to what is cheap to build and turns interrogation into solution design. Durable documents are the right altitude to ask informed questions without acquiring that bias.

## Interrogate

Establish, in this order:

1. The product outcome, in {{OWNER_NAME}}'s terms rather than technical ones.
2. What is explicitly out of scope, including work that seems adjacent and will otherwise be assumed in.
3. Decisions {{OWNER_NAME}} owns that would cause substantial rework if guessed wrong.
4. Consequences and problems {{OWNER_NAME}} has not raised, with a recommended default for each.
5. What {{OWNER_NAME}} will do to judge the finished milestone.

Ask one idea per question and order questions by how much the answer changes. Always offer a recommended default so a question can be answered with agreement. Accept "I don't know" and record it as a deferred question with its default rather than pressing.

Raise problems early and concretely. A consequence noticed here costs a sentence; the same consequence noticed during delivery costs a phase. This is the cheapest point in the whole workflow to change direction, and the only phase where {{OWNER_NAME}} is reliably present.

Do not ask about implementation approach, technology choices, or anything the durable documents already answer.

## Write the contract

Write the scope contract to a new milestone record. Use a single-quoted PowerShell here-string so the description carries real newlines; a literal `\n` is stored as text.

```powershell
$Scope = @'
## Goal

## In scope

## Out of scope

## Decisions taken

## Alternatives rejected

## Deferred questions and their defaults

## UAT definition
'@
.\.switchflow\scripts\backlog.ps1 milestone add 'Milestone name' --description $Scope
```

**UAT definition** states what {{OWNER_NAME}} will do to judge the result. It tells `plan-milestone` where to stop and becomes the closing human task.

Milestone records cannot be edited through the CLI. Iterate in conversation and write once, when {{OWNER_NAME}} confirms the contract is right.

## Stop here

Report the contract and ask {{OWNER_NAME}} to freeze it. Do not create tasks, plan phases, propose an implementation, or read the repository to check feasibility. When a deferred question later proves material, return here rather than deciding during planning.

When several related answers belong to one external person rather than {{OWNER_NAME}}, follow the stakeholder questionnaire guidance in `backlog/docs/doc-07 - Task-contract.md`.
