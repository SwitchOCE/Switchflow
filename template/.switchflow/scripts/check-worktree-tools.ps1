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
function Read-GovernanceConfig {
    param([string]$Root)

    $configPath = Join-Path $Root '.switchflow\project.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "$Root has no Switchflow project metadata. Create a fresh worktree from the accepted project base and rerun this preflight."
    }
    $config = Get-Content -Raw -Encoding utf8 -LiteralPath $configPath | ConvertFrom-Json
    if ($null -eq $config -or $config -isnot [pscustomobject]) {
        throw "Invalid Switchflow project metadata in $Root. Expected a JSON object."
    }
    foreach ($field in @('schemaVersion', 'templateVersion', 'taskPrefix', 'templateRevision', 'templateDirty')) {
        if ($null -eq $config.PSObject.Properties[$field]) {
            $config | Add-Member -NotePropertyName $field -NotePropertyValue $null
        }
    }
    if ($config.schemaVersion -ne 1 -or
        $config.templateVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($config.templateVersion) -or
        $config.taskPrefix -isnot [string] -or $config.taskPrefix -cnotmatch '^[A-Z][A-Z0-9]{1,7}$') {
        throw "Invalid Switchflow project metadata in $Root. Expected schema 1, a template version, and an uppercase task prefix."
    }
    if (($null -ne $config.templateRevision -and
            ($config.templateRevision -isnot [string] -or $config.templateRevision -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$')) -or
        ($null -ne $config.templateDirty -and $config.templateDirty -isnot [bool])) {
        throw "Invalid Switchflow source provenance in $Root."
    }
    return $config
}

$projectConfig = Read-GovernanceConfig -Root $worktreeRoot
$dispatchRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dispatchConfig = Read-GovernanceConfig -Root $dispatchRoot
if ($projectConfig.schemaVersion -ne $dispatchConfig.schemaVersion -or
    $projectConfig.templateVersion -ne $dispatchConfig.templateVersion -or
    $projectConfig.taskPrefix -ne $dispatchConfig.taskPrefix -or
    ($null -ne $dispatchConfig.templateRevision -and
        ($projectConfig.templateRevision -ne $dispatchConfig.templateRevision -or
         $projectConfig.templateDirty -ne $dispatchConfig.templateDirty))) {
    throw "Switchflow governance mismatch in $worktreeRoot. Expected schema $($dispatchConfig.schemaVersion), template $($dispatchConfig.templateVersion), prefix $($dispatchConfig.taskPrefix), revision $($dispatchConfig.templateRevision). Create a fresh worktree from the accepted project base and rerun this preflight."
}
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
