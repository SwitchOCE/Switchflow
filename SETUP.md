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
   ```

3. Verify the empty board and Backlog documents:

   ```powershell
   .\.switchflow\scripts\backlog.ps1 doctor
   .\.switchflow\scripts\check-docs.ps1
   ```

4. Review and commit the imported baseline before creating product tasks.

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
