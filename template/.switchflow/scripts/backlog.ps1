$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
$cliPath = Resolve-BacklogCli -ProjectRoot $projectRoot

$isMilestoneList = $args.Count -ge 2 -and $args[0] -in @('milestone', 'milestones') -and $args[1] -eq 'list'

Push-Location -LiteralPath $projectRoot
try {
    if ($isMilestoneList) {
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
