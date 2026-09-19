$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
if ($args.Count -ge 1 -and $args[0] -eq 'control') {
    & (Join-Path $PSScriptRoot 'start-control.ps1') @($args | Select-Object -Skip 1)
    exit $LASTEXITCODE
}
$cliPath = Resolve-BacklogCli -ProjectRoot $projectRoot

$isMilestoneList = $args.Count -ge 2 -and $args[0] -in @('milestone', 'milestones') -and $args[1] -eq 'list'
$isDocumentFile = $args.Count -ge 2 -and $args[0] -eq 'doc' -and $args -contains '--content-file'
$isTaskDescriptionFile = $args.Count -ge 2 -and $args[0] -eq 'task' -and $args -contains '--description-file'
$isMilestoneScope = $args.Count -ge 2 -and $args[0] -eq 'milestone' -and $args[1] -in @('view', 'edit')

if ($isMilestoneScope -and $args[1] -eq 'edit') {
    if ($args.Count -ne 5 -or $args[3] -ne '--input-file') {
        throw 'Usage: backlog.ps1 milestone edit <id> --input-file <UTF-8 JSON file>'
    }
    $args[4] = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($args[4])
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
        & node (Join-Path $PSScriptRoot 'milestone-scope.mjs') $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($isDocumentFile -or $isTaskDescriptionFile) {
        & node (Join-Path $PSScriptRoot 'update-document.mjs') $cliPath $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($args.Count -ge 1 -and $args[0] -eq 'flow') {
        $flowArgs = @($args | Select-Object -Skip 1)
        & node (Join-Path $PSScriptRoot 'flow.mjs') $cliPath $projectRoot @flowArgs
        $cliExitCode = $LASTEXITCODE
    }
    elseif ($isMilestoneList) {
        & node (Join-Path $PSScriptRoot 'check-milestone-progress.mjs') $cliPath $projectRoot @args
        $cliExitCode = $LASTEXITCODE
    }
    else {
        & node $cliPath @args
        $cliExitCode = $LASTEXITCODE

        if ($cliExitCode -eq 0 -and $args.Count -eq 1 -and $args[0] -eq 'doctor') {
            & node (Join-Path $PSScriptRoot 'check-ready-dependencies.mjs') $cliPath $projectRoot
            $cliExitCode = $LASTEXITCODE
        }
    }
}
finally {
    Pop-Location
}

exit $cliExitCode
