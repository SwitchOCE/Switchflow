[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Worktree,

    [Parameter(Mandatory)]
    [string]$TaskId,

    [switch]$RequireDocs
)

$ErrorActionPreference = 'Stop'
$worktreeRoot = (Resolve-Path -LiteralPath $Worktree).Path
$projectConfig = Get-Content -Raw -Encoding utf8 (Join-Path $worktreeRoot '.switchflow\project.json') | ConvertFrom-Json
$taskPattern = '^' + [regex]::Escape([string]$projectConfig.taskPrefix) + '-\d+(\.\d+)?$'
if ($TaskId -notmatch $taskPattern) {
    throw "TaskId must match $($projectConfig.taskPrefix)-<number>."
}
. (Join-Path $PSScriptRoot 'tooling.ps1')
$backlogCli = Resolve-BacklogCli -ProjectRoot $worktreeRoot

Push-Location -LiteralPath $worktreeRoot
try {
    & node $backlogCli task view $TaskId --json | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Backlog task read failed for $TaskId in $worktreeRoot"
    }

    if ($RequireDocs) {
        & node (Join-Path $PSScriptRoot 'check-docs.mjs') $worktreeRoot $backlogCli
        if ($LASTEXITCODE -ne 0) {
            throw "Backlog documentation preflight failed in $worktreeRoot"
        }
    }

}
finally {
    Pop-Location
}

Write-Host "Worktree tooling ready: $TaskId"
