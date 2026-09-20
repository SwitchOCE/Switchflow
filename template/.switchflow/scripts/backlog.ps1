$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
if ($args.Count -ge 1 -and $args[0] -in @('control', 'browser')) {
    $launchArgs = @{}
    for ($i = 1; $i -lt $args.Count; $i++) {
        if ($args[$i] -in @('--no-open', '-NoOpen')) { $launchArgs.NoOpen = $true }
        elseif ($args[$i] -in @('--port', '-Port') -and $i + 1 -lt $args.Count) { $i++; $launchArgs.Port = [int]$args[$i] }
        else { throw "Unsupported board option $($args[$i]). Use -Port <port> or -NoOpen; browser-native explicitly opens the legacy board." }
    }
    $governanceRoot = Resolve-GovernanceRoot -ProjectRoot $projectRoot
    & (Join-Path $governanceRoot '.switchflow\scripts\start-control.ps1') @launchArgs
    exit $LASTEXITCODE
}
if ($args.Count -ge 1 -and $args[0] -eq 'browser-native') { $args[0] = 'browser' }
$projectRoot = Resolve-GovernanceRoot -ProjectRoot $projectRoot
$governanceScripts = Join-Path $projectRoot '.switchflow\scripts'
$readOnlyCommand = $args.Count -eq 0 -or $args[0] -in @('doctor', 'flow', '--version', '-V', '--help', '-h', 'help') -or
    ($args.Count -ge 2 -and $args[0] -in @('task', 'tasks', 'doc', 'docs', 'milestone', 'milestones') -and $args[1] -in @('view', 'list', 'search'))
$cliPath = Resolve-BacklogCli -ProjectRoot $projectRoot -RequireFork:(-not $readOnlyCommand)

$isMilestoneList = $args.Count -ge 2 -and $args[0] -in @('milestone', 'milestones') -and $args[1] -eq 'list'
$isDocumentFile = $args.Count -ge 2 -and $args[0] -eq 'doc' -and $args -contains '--content-file'
$isTaskDescriptionFile = $args.Count -ge 2 -and $args[0] -eq 'task' -and $args -contains '--description-file'
$isMilestoneScope = $args.Count -ge 2 -and $args[0] -eq 'milestone' -and ($args[1] -eq 'view' -or ($args[1] -eq 'edit' -and $args -contains '--input-file'))

if ($isMilestoneScope -and $args[1] -eq 'edit') {
    if ($args.Count -notin @(5, 6) -or $args[3] -ne '--input-file' -or ($args.Count -eq 6 -and $args[5] -ne '--json')) {
        throw 'Usage: backlog.ps1 milestone edit <id> --input-file <UTF-8 JSON file> [--json]'
    }
    $args[4] = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($args[4])
    $milestoneInput = Get-Content -LiteralPath $args[4] -Raw -Encoding utf8 | ConvertFrom-Json
    # Legacy scope revisions carry approval evidence; ordinary metadata JSON uses
    # the native CAS editor directly and shares its task/milestone mutation lock.
    $isMilestoneScope = $null -ne $milestoneInput.PSObject.Properties['reason'] -or $null -ne $milestoneInput.PSObject.Properties['approval']
    if ($isMilestoneScope -and $args.Count -eq 6) { $args = $args[0..4] }
}

# Resolve file paths before changing directory, so callers can use their own cwd.
if ($isDocumentFile) {
    if ($args.Count -ne 5 -or $args[1] -ne 'update' -or $args[3] -ne '--content-file') {
        throw 'Usage: backlog.ps1 doc update <id> --content-file <UTF-8 body file> (no other options)'
    }
    $args[4] = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($args[4])
}

if ($isTaskDescriptionFile) {
    if ($args.Count -ne 5 -or $args[1] -ne 'edit' -or $args[3] -ne '--description-file') {
        throw 'Usage: backlog.ps1 task edit <id> --description-file <UTF-8 body file> (no other options)'
    }
    $args[4] = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($args[4])
}

Push-Location -LiteralPath $projectRoot
try {
    if ($isMilestoneScope) {
        & node (Join-Path $governanceScripts 'milestone-scope.mjs') $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($isDocumentFile -or $isTaskDescriptionFile) {
        & node (Join-Path $governanceScripts 'update-document.mjs') $cliPath $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($args.Count -ge 1 -and $args[0] -eq 'flow') {
        $flowArgs = @($args | Select-Object -Skip 1)
        & node (Join-Path $governanceScripts 'flow.mjs') $cliPath $projectRoot @flowArgs
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($isMilestoneList) {
        & node (Join-Path $governanceScripts 'check-milestone-progress.mjs') $cliPath $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    else {
        & node $cliPath @args
        $cliExitCode = $LASTEXITCODE

        if ($cliExitCode -eq 0 -and $args.Count -eq 1 -and $args[0] -eq 'doctor') {
            & node (Join-Path $governanceScripts 'check-ready-dependencies.mjs') $cliPath $projectRoot
            $cliExitCode = $LASTEXITCODE
        }
    }
}
finally {
    Pop-Location
}

exit $cliExitCode
