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

1. Edit `backlog/docs/doc-02 - Project-profile.md`. Confirm the product goal, phase, normal verification commands, and project-specific protected boundaries.
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
