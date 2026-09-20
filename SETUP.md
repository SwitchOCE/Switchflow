# Set up a project

Run the importer from the Switchflow repository:

```powershell
.\scripts\import-switchflow.ps1 `
  -TargetPath 'C:\path\to\project' `
  -ProjectName 'Project name' `
  -TaskPrefix 'PRJ' `
  -OwnerName 'Owner display name' `
  -RepoUrl 'https://github.com/owner/repository' `
  -InitializeGit
```

`RepoUrl` and `InitializeGit` are optional. The importer may create the target directory, but it refuses to overwrite an existing governance file.

After import:

1. Edit `backlog/docs/doc-02 - Project-profile.md`. Confirm the product goal, phase, normal verification commands, approval posture, and project-specific protected boundaries.
2. Install the isolated tools:

   ```powershell
   npm --prefix .switchflow ci --ignore-scripts
   npm --prefix .switchflow run setup:backlog-fork
   ```

3. Verify the empty board and Backlog documents:

   ```powershell
   .\.switchflow\scripts\backlog.ps1 doctor
   .\.switchflow\scripts\check-docs.ps1
   ```

4. Review and commit the imported baseline before creating product tasks.

5. Sign in to the installed local Codex CLI using its normal login flow. Double-click `Start Switchflow.cmd` or run `npm --prefix .switchflow run board`. Create an initiative and start Intake from the browser. The same launcher registers this Git project with the shared local service. Additional projects and code worktrees reuse its port; choose a project in the top navigation.

The CAS setup builds Backlog 1.50.1 plus the tracked revision patch from an integrity-checked official source archive using pinned Bun 1.3.14. Generated source and binaries stay in the external user cache; later projects reuse that exact build. See [fork provenance](template/.switchflow/scripts/backlog-fork/README.md). Without it, original Backlog remains readable and safe task editing fails closed.

The supported host is Windows with PowerShell, Node.js, Git, and local Codex. This candidate was exercised with PowerShell 7.6.5 (launcher also invokes Windows PowerShell), Node 24.19.0, Git 2.55.0.windows.3, and Codex 0.155.0-alpha.9.2. No global model or authentication configuration is changed. Codex needs its normal local state/database permissions when the service runs; starting it inside another restricted sandbox can prevent startup even when `codex --version` succeeds.

The first browser service uses an OS-assigned loopback port and displays the project URL. Every later launch in the same state-home reuses that port; `Add project` accepts an absolute local project folder. `backlog.ps1 control -Port <number>` selects a fixed port; `-NoOpen` starts/reuses it without opening a tab. The original Backlog browser remains available as `npm --prefix .switchflow run board:native`.

See [browser control](docs/browser-control.md) for storage backup and crash recovery. Keep the service local; a remote/cloud runner is outside this release.

The separate personal framework-review skill can be installed from this repository with `scripts/install-review-skill.ps1`. Invoke `$review-switchflow` to review external friction across a selected project without dispatching application work. Its maintained source lives under `skills/review-switchflow`; it is separate from the eleven imported project skills.

Use a short uppercase task prefix that is unique within the repository. `OwnerName` must match the name used on authoritative owner comments so agents can recognize and close them correctly.

## Version and source provenance

`.switchflow/project.json` records `templateVersion`, `templateRevision` (the source Git commit), and `templateDirty` (whether template, script, or VERSION changes were present). Revision and dirty state are `null` when they cannot be determined, including imports from archives without Git metadata. A dirty import records its base commit, not an exact source snapshot. Use a clean pinned checkout for an accepted update.

Bump `VERSION` for each released template or importer change and keep the README status aligned: patch for compatible fixes, minor for new capabilities or breaking changes while below 1.0. Documentation-only maintainer changes need no bump. Record the source commit even when versions match; older 0.2.0 snapshots differ. These optional provenance fields keep schema version 1; existing imports may omit them until their next reviewed update.

Provenance identifies the source used for comparison. It does not certify that selectively merged project files match upstream. The accepted project commit is the baseline for future worktrees.

## Update an existing project

The importer is for first-time installation and deliberately rejects collisions. Do not point it at an existing import to update it.

1. Record the accepted project commit, existing template metadata, and exact target Switchflow commit. Inventory local customizations and keep unrelated work outside the update.
2. Use a clean checkout of that Switchflow commit. Run the importer with the project's identity values and an empty disposable target directory outside the Switchflow checkout. Review the rendered files there; a failed import must not touch the active project.
3. Compare that candidate with the project. Merge related policy, skills, diagrams, and tooling changes together. Preserve the board configuration and task, milestone, decision, and comment history; project profile, product documents, approval boundaries, and local guards are project-owned. Even template-origin governance documents may contain local additions. Retain dependencies and lockfiles unless a dependency change is part of the update.
4. Update Backlog document bodies through the project's `.switchflow/scripts/backlog.ps1` wrapper, preserving document IDs and metadata. Review other source changes normally. Record intentional divergences and copy the candidate's version and provenance fields into project metadata only as part of this reviewed update; preserve project identity fields.
5. Run the affected regression tests, board doctor, documentation validation, and the project's integrated gate. Obtain independent review and owner acceptance at the project's dispatch boundary. Record the resulting project commit and source provenance in the update evidence.
6. Create subsequent worktrees from that accepted project commit. Run preflight from the accepted dispatch checkout against each worktree. It validates required metadata and compares schema, template version, and task prefix; when the dispatch checkout records a source revision, revision and dirty state must also match. Older imports without provenance retain version-based checks. Equal metadata cannot prove equal file contents, so starting from the accepted project commit remains necessary.

Rollback restores the scoped source changes and document bodies from the accepted pre-update baseline. Restore Backlog bodies through the wrapper, retaining their IDs, metadata, comments, and history. Automatic merging and transactional import remain separate backlog work (SF-07 and SF-10).

### Updating to 0.3.0

Bring in the eight skills, scope/revision adapter, discovery-aware flow, and their governing documents together. Existing milestone records work without conversion; their current content becomes the first baseline when edited. Keep revision snapshots in version control and add the candidate's narrow milestone lock/staging exclusions to the project gitignore.

The fresh template uses `doc-09` for Scope and revisions. If that ID already belongs to a project document, preserve it. Create the new governance page through `doc create`, then substitute its assigned ID, filename and browser route in the imported skills, AGENTS.md and links. Do not overwrite a product page or renumber existing documents. Verify the remapped references in the disposable candidate before applying the update.

### Updating to 0.4.0

Apply the eleven skills, revised governing documents, browser service, operations modules, pinned tooling, and launcher together using the reviewed update procedure. Existing task and milestone IDs stay unchanged. External browser state is created on first launch, with no migration of existing board records. The standalone phase skill remains available for grants that name only one phase; project-wide continuation requires a recorded plan approval.

Take an external state backup with the service stopped when moving a project to a different Git common directory: project identity is derived from that canonical directory. Do not copy a running service lock or auto-replay interrupted work. No ongoing application project is upgraded by changing this template repository.

### Updating to 0.5.0

Apply the fork, Switchflow browser assets, wrappers, shared control service and revised governance rules together. The fork still verifies its diagnostic web bundle; the shared workspace serves Switchflow assets directly. Stop prior Switchflow and native Backlog servers for the affected projects before replacing their runtime. A live per-project service lock prevents registering a second engine; the new launcher never kills an unrelated service. Build the new pinned fork, then launch one project and add the other updated projects to the same service. Registration requires 0.5.x project metadata; older imports are refused rather than mixing incompatible writers. A requested port must match an already-running shared service; changing ports requires stopping that service first.

The new shared registry lives in `SWITCHFLOW_HOME/control-service` (normally `%LOCALAPPDATA%/Switchflow/control-service`). Existing per-project state stays at its original Git-common-directory identity. Registration from a linked worktree resolves to the primary checkout. All board/document/MCP commands use the primary wrapper and tooling; copied worktree governance remains historical, is never adopted automatically, and is not deleted by this update. Importing fresh governance into a linked worktree is rejected.

Milestone IDs and descriptions remain valid. Optional `labels` and `executionOrder` are added on edit, independently of numeric IDs; legacy milestones with no order stay unspecified. Optional task `blockReason` uses the serialized `block_reason` field. Existing unexplained Blocked tasks remain blocked until their reason is explicitly set or cleared. `dependent` is reserved for automatic readiness; other text is a manual blocker. Keep the new fork for every writer so its graph lock and reconciliation apply. A plain upstream binary or manual Markdown editing cannot provide those guarantees.

Back up governance and external state with services stopped before updating. Rollback restores the prior runtime and data backup together; an older serializer may drop the new optional fields. No automatic consumer migration or deletion is performed. See [workspace details](docs/workspace-0.5.0.md).
