$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
$cliPath = Resolve-BacklogCli -ProjectRoot $projectRoot

& node (Join-Path $PSScriptRoot 'check-docs.mjs') $projectRoot $cliPath
exit $LASTEXITCODE
