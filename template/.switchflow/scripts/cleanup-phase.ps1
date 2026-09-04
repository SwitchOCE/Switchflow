<#
.SYNOPSIS
Remove branches and worktrees belonging to completed tasks in one phase.

.DESCRIPTION
Deterministic cleanup only. A branch is removed when every condition holds:

  1. Its task carries the named phase label. The label selects tasks across the
     whole board, so a phase label reused between milestones widens this run.
  2. That task's status is Done.
  3. The branch name matches the task-branch pattern exactly.
  4. It is not the integration branch and not currently checked out here.
  5. Git reports it fully merged into the integration branch.

Anything failing a condition is reported as an exception and left untouched.
Exceptions need a decision and belong to the orchestrator, not this script.

.EXAMPLE
# Set $PhaseLabel to the exact board-unique label on the phase parent.
.\.switchflow\scripts\cleanup-phase.ps1 -PhaseLabel $PhaseLabel -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$PhaseLabel,

    [ValidateNotNullOrEmpty()]
    [string]$IntegrationBranch = 'main',

    # {0} is replaced with the task ID.
    [ValidateNotNullOrEmpty()]
    [string]$BranchPattern = 'task/{0}'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Get-Frontmatter {
    param([Parameter(Mandatory)][string]$Path)

    $text = Get-Content -Raw -Encoding utf8 -LiteralPath $Path
    if ($null -eq $text -or -not $text.StartsWith('---')) {
        return $null
    }
    $end = $text.IndexOf("`n---", 3)
    if ($end -lt 0) {
        return $null
    }
    $block = $text.Substring(3, $end - 3)

    $record = @{ Id = $null; Status = $null; Labels = @() }

    # Backlog.md serializes a non-empty list as a YAML block sequence and only an
    # empty one as inline flow, so both forms have to be read. Parsing the inline
    # form alone leaves every real phase label invisible: the selector matches no
    # task and cleanup reports success having examined nothing.
    $labels = [System.Collections.Generic.List[string]]::new()
    $inLabelBlock = $false
    foreach ($line in $block -split "`r?`n") {
        if ($inLabelBlock) {
            if ($line -match '^\s+-\s*(.*?)\s*$') {
                $item = $Matches[1].Trim().Trim('"', "'")
                if ($item) { $labels.Add($item) }
                continue
            }
            $inLabelBlock = $false
        }

        if ($line -match '^\s*id:\s*"?([^"\r\n]+?)"?\s*$') { $record.Id = $Matches[1].Trim() }
        elseif ($line -match '^\s*status:\s*"?([^"\r\n]+?)"?\s*$') { $record.Status = $Matches[1].Trim() }
        elseif ($line -match '^\s*labels:\s*\[(.*)\]\s*$') {
            foreach ($item in ($Matches[1] -split ',')) {
                $trimmed = $item.Trim().Trim('"', "'")
                if ($trimmed) { $labels.Add($trimmed) }
            }
        }
        elseif ($line -match '^\s*labels:\s*$') {
            $inLabelBlock = $true
        }
    }
    $record.Labels = @($labels)
    if ($null -eq $record.Id) {
        return $null
    }
    return [pscustomobject]$record
}

function Get-PhaseTasks {
    param([Parameter(Mandatory)][string]$ProjectRoot, [Parameter(Mandatory)][string]$Label)

    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($directory in @('backlog\tasks', 'backlog\completed')) {
        $path = Join-Path $ProjectRoot $directory
        if (-not (Test-Path -LiteralPath $path)) { continue }

        # A Done task moves to backlog/completed, so both locations are read and
        # deduplicated by ID. Reading only the active board misses finished work.
        foreach ($file in Get-ChildItem -LiteralPath $path -Filter '*.md' -File) {
            $record = Get-Frontmatter -Path $file.FullName
            if ($null -ne $record -and $record.Labels -contains $Label) {
                $records.Add($record)
            }
        }
    }
    return $records | Sort-Object Id -Unique
}

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # Git writes refusals to stderr. Under ErrorActionPreference 'Stop', redirecting
    # a native command's stderr raises a terminating NativeCommandError, which would
    # abort the whole pass on the first refused branch instead of recording it as an
    # exception. Exit codes are the contract here, not the error stream.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $projectRoot @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output | Out-String).Trim() }
}

if ((Invoke-Git @('rev-parse', '--git-dir')).ExitCode -ne 0) {
    throw "Not a Git repository: $projectRoot"
}

$tasks = @(Get-PhaseTasks -ProjectRoot $projectRoot -Label $PhaseLabel)
if ($tasks.Count -eq 0) {
    Write-Host "No tasks carry the label '$PhaseLabel'. Nothing to clean up."
    return
}

$currentBranch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')).Output

$mergedResult = Invoke-Git @('branch', '--merged', $IntegrationBranch, '--format=%(refname:short)')
if ($mergedResult.ExitCode -ne 0) {
    throw "Could not list branches merged into '$IntegrationBranch'. $($mergedResult.Output)"
}
$mergedBranches = @($mergedResult.Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$existingResult = Invoke-Git @('branch', '--format=%(refname:short)')
$existingBranches = @($existingResult.Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# Map branch -> worktree path.
$worktrees = @{}
$worktreeResult = Invoke-Git @('worktree', 'list', '--porcelain')
if ($worktreeResult.ExitCode -eq 0) {
    $path = $null
    foreach ($line in $worktreeResult.Output -split "`r?`n") {
        if ($line -match '^worktree\s+(.+)$') { $path = $Matches[1].Trim() }
        elseif ($line -match '^branch\s+refs/heads/(.+)$' -and $null -ne $path) {
            $worktrees[$Matches[1].Trim()] = $path
            $path = $null
        }
    }
}

$removed = [System.Collections.Generic.List[string]]::new()
$exceptions = [System.Collections.Generic.List[string]]::new()

foreach ($task in $tasks) {
    $branch = [string]::Format($BranchPattern, $task.Id)

    if ($existingBranches -notcontains $branch) {
        continue
    }
    if ($task.Status -ne 'Done') {
        $exceptions.Add("$branch - task $($task.Id) is $($task.Status), not Done")
        continue
    }
    if ($branch -eq $IntegrationBranch) {
        $exceptions.Add("$branch - refused: this is the integration branch")
        continue
    }
    if ($branch -eq $currentBranch) {
        $exceptions.Add("$branch - currently checked out here")
        continue
    }
    if ($mergedBranches -notcontains $branch) {
        $exceptions.Add("$branch - has commits not merged into $IntegrationBranch")
        continue
    }

    if ($worktrees.ContainsKey($branch)) {
        $worktreePath = $worktrees[$branch]
        if ($PSCmdlet.ShouldProcess($worktreePath, 'Remove worktree')) {
            # No --force: a dirty worktree holds unreviewed work and is an exception.
            $result = Invoke-Git @('worktree', 'remove', $worktreePath)
            if ($result.ExitCode -ne 0) {
                $exceptions.Add("$branch - worktree at $worktreePath could not be removed (uncommitted changes?)")
                continue
            }
        }
    }

    if ($PSCmdlet.ShouldProcess($branch, 'Delete merged branch')) {
        $result = Invoke-Git @('branch', '-d', $branch)
        if ($result.ExitCode -ne 0) {
            $exceptions.Add("$branch - delete refused by Git: $($result.Output)")
            continue
        }
        $removed.Add($branch)
    }
}

Write-Host "Phase '$PhaseLabel': $($tasks.Count) task(s), $($removed.Count) branch(es) removed, $($exceptions.Count) exception(s)."
foreach ($branch in $removed) {
    Write-Host "  removed  $branch"
}
foreach ($exception in $exceptions) {
    Write-Warning "  kept     $exception"
}
if ($exceptions.Count -gt 0) {
    Write-Host 'Exceptions need a decision. Resolve them before closing the phase.'
}
