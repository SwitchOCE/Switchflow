# Pinned Backlog workflow runtime

This is a small, local MIT-licensed fork of [Backlog.md](https://github.com/MrLesk/Backlog.md), tag `v1.50.1`, commit `94c10a690b75f26ebfe8e337e74ffe02f2d459d7`. The tag's source package.json reports 1.50.0; the release tag/commit is the provenance authority. `manifest.json` pins the official source archive SHA256 and Bun 1.3.14 toolchains with registry SHA512 integrity. `UPSTREAM-LICENSE` preserves the upstream license. No upstream repository, source checkout, dependencies, or binary is tracked in Switchflow.

Run once in each environment:

```powershell
node .switchflow/scripts/backlog-fork/setup.mjs
```

Requires Node with fetch, Git, tar, and access to the official GitHub and npm registries. Installation downloads the verified archive and toolchain, applies the tracked patch, installs upstream's frozen Bun lockfile without lifecycle scripts, and compiles the actual native CLI. It does not publish or push a fork. Source and tooling stay available in the external cache for inspection and reproducibility. Windows x64 is integration-tested; pinned Linux and macOS x64/arm64 bootstrap entries are provided but have not been executed here.

The default cache is `%LOCALAPPDATA%/Switchflow/backlog-fork` on Windows and `$XDG_CACHE_HOME/switchflow/backlog-fork` (or `~/.cache/switchflow/backlog-fork`) elsewhere. `--cache <directory>` overrides installation location; set `SWITCHFLOW_BACKLOG_CACHE` to the same directory for runtime resolution. Cache identities include the manifest, patch, and bootstrap scripts; updates build separately. Imported projects reuse matching cached versions. Identity inputs normalize CRLF to LF, and setup applies a cached LF patch so Windows Git line-ending conversion does not split identities or break patch application. Archive, toolchain, executable, and launcher integrity checks retain exact bytes. Source archive extraction materializes the build's required Markdown symlink to avoid Windows administrator/symlink privileges.

`runtime.mjs` exports `resolveBacklogFork()` returning `{ executable, cliPath, root, identity, webRoot }`. It verifies the compiled executable against the completed build receipt and both CLI/MCP launchers against deterministic templates; missing or changed binaries fail closed and display the setup command. No network access occurs during resolution. `cliPath` is a Node-compatible launcher with adjacent `resolveBinary.cjs` for existing adapters. A failed/interrupted setup never produces a valid receipt. Inspect any abandoned `setup.lock` before removing it and rerunning setup. Old version caches can be removed explicitly after confirming no running jobs use them; setup never deletes another version.

## Mutation contract

- `task view <id> --json` exposes `task.revision`, SHA256 of the exact bytes parsed from the local task file. MCP `task_view` includes `Revision: <sha256>` in its text result.
- MCP `task_edit` accepts `expectedRevision`; CLI task edit accepts `--expected-revision <sha256>`.
- The comparison happens after reloading inside the canonical project's workflow lock. A competing native edit is either busy or causes `REVISION_CONFLICT`; no stale mutation is applied. Disabling the upstream task lock is rejected for CAS operations.
- Native reorder, archive, completion, direct demotion, milestone mutations and Core task writes share one fail-fast workflow lock. It protects the whole dependency graph; batch writes finish before readiness reconciliation, avoiding stale sibling snapshots. Nested operations share an active async lock lease, which expires when the owner releases it. The lock directory is `<backlog>/.locks/workflow`; its separate stable target is `.locks/workflow-target`.
- Absent status in MCP edits remains absent. Upstream's create default remains unchanged. Existing task fields, including status, comments, labels, dependencies, and checklists, survive partial edits through upstream's normal serializer. Unknown custom Markdown/frontmatter is subject to upstream serialization; this patch does not promise arbitrary byte-preserving edits.
- Successful edits return a fresh revision. CAS covers local active/completed tasks and same-draft edits, with exact-byte revisions also exposed by draft reads/lists. Draft promotion/demotion with a revision still fails closed; use the explicit lifecycle action. Draft edits, saves, promotion, and archival participate in the workflow lock. Hand-editing files outside Backlog's lock is not a cooperating writer and is outside this lock guarantee.

## Milestone metadata and ordering

Milestone IDs identify records; they never imply execution order. Optional non-negative integer `execution_order` is exposed as `executionOrder` in JSON/MCP. Lists sort explicit positions first, then title for display stability; an absent position stays unsequenced. Milestones also support `labels` and a Markdown Description section. Native POST `/api/milestones` accepts title, description, labels, and executionOrder together; validation precedes its single persisted creation write, and the response includes the revision.

`milestone list --json` returns an array; `milestone view <id> --json` returns metadata plus exact-byte SHA256 `revision`. Edit with `milestone edit <id> --expected-revision <revision> --title <text> --description <text> --labels <comma-separated labels> --execution-order <integer> --json`. Omit unchanged fields; empty labels clears labels; `--clear-execution-order` removes order. For long descriptions, `--input-file <JSON path>` accepts the same fields (`executionOrder: null` clears order). MCP `milestone_view` and `milestone_edit` provide the equivalent contract; MCP list includes `structuredContent.milestones`. Edits preserve ID, unknown frontmatter and body sections outside Description. Renaming normalizes unambiguous legacy task references using the old title to stable milestone IDs; ambiguous references must be resolved first.

## Dependency readiness

Task JSON/CLI/MCP expose optional `blockReason`, persisted as `block_reason`. CLI create/edit accepts `--block-reason`; MCP create/edit accepts `blockReason`. Empty text explicitly clears a reason. The exact value `dependent` is reserved for a dependency-only block.

When the project defines Ready and Blocked statuses, every cooperating task write reconciles the local graph: Ready with unfinished/missing prerequisites becomes Blocked/dependent; Blocked/dependent becomes Ready and clears its reason when all prerequisites are Done, Completed, the configured terminal status, or in the completed corpus. Explicit other reasons stay Blocked. A legacy Blocked task with no reason remains blocked until the user explicitly classifies or clears it. Backlog, In Progress, Review and terminal tasks are never automatically promoted or regressed. Readiness filters also exclude explicit and legacy unspecified blockers.

Reconciliation changes task revisions, so a previously loaded edit may correctly conflict. Multi-file batches hold the graph lock throughout; filesystem crashes cannot be made atomic across all Markdown files. Repeating `task reconcile --json` repairs derived statuses after an interrupted batch or direct file edits. Reconciliation does not invent scope approval, change dependency edges, or bypass another block reason. Old servers must be stopped before upgrading: earlier task-lock-only forks do not participate in this graph lock.

Repository validation after setup: `node --test scripts/backlog-cas.test.mjs scripts/backlog-fork-portability.test.mjs scripts/fork-workflow.test.mjs`. This runs the compiled native binary and real upstream Core writers. It checks long Unicode MCP stdin, fresh CLI/MCP edits, exact revision hashes, metadata preservation, contention and stale rejection, dependency completion/reopening/missing/cycles/manual blocks, milestone ordering/legacy references, and Core completion/archive batches. It also checks native archive/dependency-cleanup/completion/demotion contention, compiled HTTP reorder, launcher integrity, and delayed async lock ownership. Human browser acceptance is a separate check.

Use the fork for every native browser, CLI, and MCP writer, and restart an already-running stock Backlog server after setup. The unpatched upstream reorder/archive paths do not honor the task lock; this fork cannot retrofit locking into an existing stock process.

## Native browser bridge

The build exports the native Backlog HTML, JavaScript and CSS into the versioned cache `web/` directory; no generated bundle is committed. Browser assets use `/backlog-assets/`. The receipt hashes every web file, and resolution rejects missing, changed, extra or symlinked assets as well as executable/launcher tampering.

`backlog switchflow-bridge` initializes the native stores and search service without opening an HTTP listener. Its cwd selects the primary project. Stdin/stdout carry JSONL: requests are `{id, method, path, body?, contentType?}` where body is a JSON object or raw string and contentType is application/json (default) or text/plain; responses are `{id, status, headers, body}` with base64 bytes, or `{id, error}`. Only `/api/*` and `/assets/*` are dispatched, through the same route definitions and handlers as the native HTTP server. Each request is at most 1 MiB; decoded response bodies are at most 16 MiB. Logs go to stderr. Stdin EOF and termination signals dispose stores/watchers. The gateway owns authentication, host/origin/CSRF checks and mutation admission; the bridge is a private child transport and must not be exposed directly.

Bridge task and milestone PUT edits require a valid `expectedRevision` and return HTTP 409 for stale revisions. Native operations retain their shared workflow lock. The standalone browser still uses the same native API route definitions.
