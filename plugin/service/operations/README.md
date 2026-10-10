# Shared project operations

`operations.mjs` is both a dependency-free Node API and a CLI:

```text
node .switchflow/scripts/operations/operations.mjs context <project-path>
node .switchflow/scripts/operations/operations.mjs issues <project-path>
node .switchflow/scripts/operations/operations.mjs retention <project-path>
```

Actions with arguments accept a third positional JSON object: `issue-add`,
`issue-resolve`, `check`, `worktree-register`, `scratch-write`, `scratch-promote`,
and `retention-apply`. `worktrees` inspects Git worktrees without mutation.

## Storage and ownership

`resolveProject(path, {stateHome})` resolves Git's real common directory and hashes
its canonical path. All linked worktrees share `<stateHome>/projects/<hash>`.
The default base is `SWITCHFLOW_HOME`, then `%LOCALAPPDATA%/Switchflow`, then
`~/.local/state/switchflow`. Keep it outside all source worktrees. `sourceRoot`
is the current worktree; `governanceRoot` is Git's primary checkout, where the
authoritative Backlog stays. Moving the common Git directory changes identity;
external records are local and are not automatically synchronized or migrated.

External JSON ledgers separate control state, issues, evidence, and registered
worktrees. Informational `issues`, `evidence`, `worktrees`, and `scratch` ledgers
and their locks live under `operations/`; controller and Git-operation records
remain outside that agent-writable directory. Earlier candidate ledgers at the
state root are read as a fallback; the next update creates the separated copy
and leaves the old file intact. Stop older services before adopting this layout.
`readState(context, name, fallback)` reads a ledger;
`updateState(context, name, mutate, fallback)` performs a locked atomic update.
The callback may mutate its argument or return a replacement. Callers own schema
and revision validation. `withLock(context, name, action, {timeoutMs})` serializes
other resources. Lock files record owner PID and timestamp. Abandoned locks are
never automatically stolen: inspect whether the recorded process still owns the
operation before manual recovery. Distinct resource names avoid nested locks.

Scratch is write-only during ordinary orchestration: `writeScratch` returns
metadata, and inventory does not expose its content. Explicit `promoteScratch`
copies a selected, unchanged file into external `governance` and marks it
referenced. This is a workflow boundary, not an operating-system access control;
agents with filesystem access can still read the directory. Do not put scratch
content into generic context collection. Existing repository documents remain
in place until a deliberate, reference-aware migration.

## Friction and evidence

`recordIssue(context, {kind, summary, phase?, taskId?, nextAction?})` records
`clarification`, `permission`, `scope-change`, `issue`, or `update` without
dispatching work. `listIssues`, `resolveIssue(context,id,resolution)`, and
`issueMetrics` support an explicit process review.

`runCheck(context, {command,args,scope,environment?,inputs?,docker?,timeoutMs?,reuse?})`
actually runs an executable without a shell. Use a real executable path on
Windows (for npm, invoke Node with npm's CLI path rather than a `.cmd` wrapper).
Successful unchanged results can be reused only for the same worktree path,
HEAD, tracked and nonignored file contents and modes, command and arguments,
scope, process environment digest, Node/platform, and caller-specified inputs.
Concurrent identical requests serialize and reuse one successful execution.
Failures, timeouts, and source changes during execution never qualify for reuse.
Output is capped at its final 128 KiB. Environment values are hashed, not stored.
Command arguments and process output are stored: do not include credentials.

Declare relevant ignored dependencies, service/database versions, configuration,
or container image digests in `inputs`; the tool cannot infer remote state or
changes inside ignored `node_modules`. Set `reuse:false` for checks against
mutable external systems. Exact source identity alone does not establish those
environment conditions. `docker:true` requires a responding Docker runtime and
adds its version response to the environment digest. It does not run a container.
For container checks invoke `docker` explicitly with a pinned image and declared
input digests. Results claim only local-process execution, never native, hosted,
rendered UI, or Human acceptance. Submodules require separate evidence.

## Retention

`planRetention` is a dry-run manifest. `applyRetention(context, ids)` requires
explicit scratch IDs, expired retention, unchanged content, a regular file under
the managed scratch directory, and no reference marker. Unknown files, changed
files, governance, issue/evidence ledgers, and Git worktrees are preserved.
Traversal and existing symbolic links/junctions are rejected. Storage must be
owned by the current user; path checks do not provide isolation from a malicious
same-user process racing filesystem mutations. Real worktree retirement remains
the existing `cleanup-phase.ps1` clean-and-merged proof workflow.
