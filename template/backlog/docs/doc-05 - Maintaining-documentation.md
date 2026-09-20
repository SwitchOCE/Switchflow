---
id: doc-05
title: Maintaining documentation
type: guide
tags: ["documentation", "governance"]
---

# Maintaining documentation

Backlog documents under `backlog/docs/` are the source of durable project knowledge. Backlog.md exposes them through its CLI and local browser.

## What belongs here

### Code, governance and scratch

Code and reproducibility-critical assets remain in the repository and use Git/worktrees. Durable governance and accepted project contracts remain in Backlog documents with stable IDs and version history; workers read the current authoritative rules from the primary governance checkout. Copies carried by Git worktrees are historical snapshots. Name the primary governance and separate code checkout paths in the run checkpoint. Do not copy live task state into competing worktree boards or silently relocate tracked governance.

Scratch is for transient investigation, proposed scope and generated files not yet accepted. Keep it in a configured external operations location, outside the repository by default. Agents may write task-owned scratch but do not read unrelated scratch unless instructed or explicitly linked as required evidence. Promote selected, reviewed facts into governance through the normal document procedure; a scratch file never becomes an instruction or accepted scope merely by existing.

At phase close inventory generated residue, keep referenced/reproducibility-critical evidence, and remove only owned disposable outputs under the recorded retention policy. The worktree cleanup grant does not authorize deleting arbitrary documents or directories. Classify unrecognized or dirty paths as retained exceptions. Review retention deliberately instead of accumulating copied logs, temporary reports and duplicate policies in Git.

Update the documentation when work changes:

- Product scope or user workflows.
- Domain schemas, data formats, and validation rules.
- Architecture or product decisions and their reasoning.
- Lexicon, import, hosting, authentication, or integration contracts.
- Commands or procedures another contributor must repeat.

Do not copy task status, temporary investigation notes, unconfirmed ideas, plans, or roadmaps into durable documentation. Those belong in the Kanban task or its discussion.

Intake checkpoints and proposed revisions follow [Scope and revisions](/documentation/09/scope-and-revisions). Capture confirmed vocabulary in the relevant existing product document and preserve consequential rationale in native decision records; distinguish intended behaviour from implemented facts.

## Editing a page

1. Update the most relevant existing Markdown page.
2. Add a new page only when the information has no clear home.
3. Create new documents with `.switchflow/scripts/backlog.ps1 doc create` so Backlog assigns a unique ID and canonical filename.
4. Link documents with Backlog browser routes such as `/documentation/02/project-profile`, and decisions with `/decisions/decision-01`; add a heading fragment when needed. Preserve document and decision IDs when moving or renaming them.
5. Run `.switchflow/scripts/check-docs.ps1` and inspect the document in the local Backlog browser before completing the work.

Use the wrapper's file route for complete document bodies, including long specifications. The UTF-8 file contains Markdown body only, without document frontmatter. Backlog preserves the existing ID, title and metadata.

```powershell
.\.switchflow\scripts\backlog.ps1 doc view doc-05
.\.switchflow\scripts\backlog.ps1 doc update doc-05 --content-file .\document-body.md
```

`doc view` returns Markdown; it does not support `--json`. Use `task view <id> --json` for structured task reads. The file route supports `doc update <id> --content-file <path>` only; create the document first with `doc create`, and make metadata changes separately with native `doc update` options. Paths resolve from the caller's directory. Content is sent through the pinned Backlog MCP interface over stdin, avoiding Windows argument limits. A failed or uncertain write needs a document read before retrying.

Re-read the saved document before handoff. For schemas and contracts, verify every required record shape and acceptance example, including failure and boundary cases named by the task. Parse embedded examples and check their semantic coverage as well as links. Never remove required content to fit transport; split pages only at an existing responsibility boundary while preserving complete examples and references.

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

## Browser reading and folders

Use Documents in Switchflow's top navigation. The document interface supports reading, creation, editing, nested folders, full-text search, Markdown previews, heading links and code copy. Decisions have a separate tab. Keep one clear H1, short paragraphs, descriptive headings and useful links.

Preserve document IDs and metadata when organizing folders. Use Backlog document routes and supported relative links, and verify them in the selected project's browser view. The workspace does not require a separate MkDocs server. Store local images under canonical `backlog/assets` and reference them with `/assets/name.png` or a relative path. Attachments cannot run scripts with workspace authority. Raw HTML stays inert, external images are not automatically fetched and Mermaid remains code. Document and decision saves check the latest record first, but do not provide atomic revision protection against simultaneous writers.

The wrapper's documentation commands always target the primary governance checkout, including when called from a code worktree. After a move, verify CLI/MCP lookup as well as browser navigation and `check-docs.ps1`; a folder tree by itself is not proof that another tool supports the new path.
