[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Worktree,

    [Parameter(Mandatory)]
    [string]$TaskId,

    [switch]$RequireDocs,
    [switch]$RequireNode
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

    if ($RequireNode) {
        $packageJsonPath = Join-Path $worktreeRoot 'package.json'
        if (-not (Test-Path -LiteralPath $packageJsonPath)) {
            throw "RequireNode was requested but $worktreeRoot has no package.json."
        }

        # npm writes node_modules/.package-lock.json only once an install completes,
        # so its presence separates an installed worktree from a copied, interrupted,
        # or never-installed one. It proves the graph was installed for this package;
        # it does not prove every binary in it runs. A project that needs that should
        # check its own toolchain in addition.
        $installMarkerPath = Join-Path $worktreeRoot 'node_modules\.package-lock.json'
        if (-not (Test-Path -LiteralPath $installMarkerPath)) {
            throw "Node dependencies are unavailable in $worktreeRoot. Run 'npm ci --ignore-scripts' there before dispatch; do not run 'npm install'."
        }

        $packageManifest = Get-Content -Raw -Encoding utf8 -LiteralPath $packageJsonPath | ConvertFrom-Json
        $installMarker = Get-Content -Raw -Encoding utf8 -LiteralPath $installMarkerPath | ConvertFrom-Json
        if ($packageManifest.name -ne $installMarker.name -or $packageManifest.version -ne $installMarker.version) {
            throw "node_modules in $worktreeRoot was installed for $($installMarker.name)@$($installMarker.version), not $($packageManifest.name)@$($packageManifest.version). Run 'npm ci --ignore-scripts' there before dispatch."
        }
    }
}
finally {
    Pop-Location
}

Write-Host "Worktree tooling ready: $TaskId"
