$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
$projectRoot = Resolve-GovernanceRoot -ProjectRoot $projectRoot
$cliPath = Resolve-BacklogCli -ProjectRoot $projectRoot

& node (Join-Path $projectRoot '.switchflow\scripts\check-docs.mjs') $projectRoot $cliPath
exit $LASTEXITCODE
