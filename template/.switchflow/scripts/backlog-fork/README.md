# Pinned Backlog CAS runtime

This is a small, local MIT-licensed fork of [Backlog.md](https://github.com/MrLesk/Backlog.md), tag `v1.50.1`, commit `94c10a690b75f26ebfe8e337e74ffe02f2d459d7`. The tag's source package.json reports 1.50.0; the release tag/commit is the provenance authority. `manifest.json` pins the official source archive SHA256 and Bun 1.3.14 toolchains with registry SHA512 integrity. `UPSTREAM-LICENSE` preserves the upstream license. No upstream repository, source checkout, dependencies, or binary is tracked in Switchflow.

Run once in each environment:

```powershell
node .switchflow/scripts/backlog-fork/setup.mjs
```

Requires Node with fetch, Git, tar, and access to the official GitHub and npm registries. Installation downloads the verified archive and toolchain, applies the tracked patch, installs upstream's frozen Bun lockfile without lifecycle scripts, and compiles the actual native CLI. It does not publish or push a fork. Source and tooling stay available in the external cache for inspection and reproducibility. Windows x64 is integration-tested; pinned Linux and macOS x64/arm64 bootstrap entries are provided but have not been executed here.

The default cache is `%LOCALAPPDATA%/Switchflow/backlog-fork` on Windows and `$XDG_CACHE_HOME/switchflow/backlog-fork` (or `~/.cache/switchflow/backlog-fork`) elsewhere. `--cache <directory>` overrides installation location; set `SWITCHFLOW_BACKLOG_CACHE` to the same directory for runtime resolution. Cache identities include the manifest, patch, and bootstrap scripts; updates build separately. Imported projects reuse matching cached versions. Identity inputs normalize CRLF to LF, and setup applies a cached LF patch so Windows Git line-ending conversion does not split identities or break patch application. Archive, toolchain, executable, and launcher integrity checks retain exact bytes. Source archive extraction materializes the build's required Markdown symlink to avoid Windows administrator/symlink privileges.

`runtime.mjs` exports `resolveBacklogFork()` returning `{ executable, cliPath, root, identity }`. It verifies the compiled executable against the completed build receipt and both CLI/MCP launchers against deterministic templates; missing or changed binaries fail closed and display the setup command. No network access occurs during resolution. `cliPath` is a Node-compatible launcher with adjacent `resolveBinary.cjs` for existing adapters. A failed/interrupted setup never produces a valid receipt. Inspect any abandoned `setup.lock` before removing it and rerunning setup. Old version caches can be removed explicitly after confirming no running jobs use them; setup never deletes another version.

## Mutation contract

- `task view <id> --json` exposes `task.revision`, SHA256 of the exact bytes parsed from the local task file. MCP `task_view` includes `Revision: <sha256>` in its text result.
- MCP `task_edit` accepts `expectedRevision`; CLI task edit accepts `--expected-revision <sha256>`.
- The comparison happens after reloading inside Backlog's existing canonical task lock. A competing native edit is either busy or causes `REVISION_CONFLICT`; no stale mutation is applied. Disabling the upstream task lock is rejected for CAS operations.
- Native reorder locks all possible rebalance participants before refreshing; archive locks the target and existing active tasks before dependency cleanup; completion and direct demotion lock their target. Core task writes also lock and reject stale revision-bearing snapshots. Nested operations share an active async lock lease, which expires when the owner releases it.
- Absent status in MCP edits remains absent. Upstream's create default remains unchanged. Existing task fields, including status, comments, labels, dependencies, and checklists, survive partial edits through upstream's normal serializer. Unknown custom Markdown/frontmatter is subject to upstream serialization; this patch does not promise arbitrary byte-preserving edits.
- Successful edits return a fresh revision. CAS is currently for local active/completed tasks through the existing task mutation path, not draft promotion/demotion. Draft transitions with a revision fail closed. Hand-editing files outside Backlog's lock is not a cooperating writer and is outside this lock guarantee.

Repository validation after setup: `node --test scripts/backlog-cas.test.mjs scripts/backlog-fork-portability.test.mjs`. This runs the compiled native binary and a real upstream Core writer holding the same task lock. It checks long Unicode MCP stdin, fresh CLI/MCP edits, exact revision hashes, metadata preservation, contention and stale rejection without file changes. It also checks native archive/dependency-cleanup/completion/demotion contention, compiled HTTP reorder, launcher integrity, and delayed async lock ownership. Human browser acceptance is a separate check.

Use the fork for every native browser, CLI, and MCP writer, and restart an already-running stock Backlog server after setup. The unpatched upstream reorder/archive paths do not honor the task lock; this fork cannot retrofit locking into an existing stock process.
