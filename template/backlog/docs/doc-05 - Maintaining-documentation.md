---
id: doc-05
title: Maintaining documentation
type: guide
tags: ["documentation", "governance"]
---

# Maintaining documentation

Backlog documents under `backlog/docs/` are the source of durable project knowledge. Backlog.md exposes them through its CLI and local browser.

## What belongs here

Update the documentation when work changes:

- Product scope or user workflows.
- Domain schemas, data formats, and validation rules.
- Architecture or product decisions and their reasoning.
- Lexicon, import, hosting, authentication, or integration contracts.
- Commands or procedures another contributor must repeat.

Do not copy task status, temporary investigation notes, unconfirmed ideas, plans, or roadmaps into durable documentation. Those belong in the Kanban task or its discussion.

## Editing a page

1. Update the most relevant existing Markdown page.
2. Add a new page only when the information has no clear home.
3. Create new documents with `.switchflow/scripts/backlog.ps1 doc create` so Backlog assigns a unique ID and canonical filename.
4. Link documents with Backlog browser routes such as `/documentation/02/project-profile`; add a heading fragment when needed. Preserve document IDs when moving or renaming them.
5. Run `.switchflow/scripts/check-docs.ps1` and inspect the document in the local Backlog browser before completing the work.

Prefer short paragraphs and exact terms; use lists when they improve scanning.

Create a native Backlog decision with `.switchflow/scripts/backlog.ps1 decision create` when a technical or product choice needs permanent rationale. Record its context, decision, alternatives, and consequences.

## Presentation rules

Use portable Markdown that renders clearly in Backlog.md and remains readable as source.

- Use blockquotes with a short bold label for warnings, failures, source-of-truth boundaries, and supporting context.
- Keep required steps and acceptance boundaries visible rather than hiding them in presentation widgets.
- Use a Mermaid diagram when three or more components, states, or steps are easier to understand visually. Keep a short explanation beside it.
- Split a page only at a stable responsibility boundary. Check inbound links, anchors, tests, and task references first.

Keep diagrams and callouts aligned with surrounding contracts. Prefer readable Markdown over decoration.

## Definition of done

A change is complete when affected documentation matches the implementation and the documentation check passes. If established knowledge did not change, no documentation edit is required.
