[CmdletBinding()]
param(
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')

function Test-ListeningPort {
    param([int]$Port)

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $connection
}

Set-Location -LiteralPath $projectRoot
$null = Resolve-BacklogCli -ProjectRoot $projectRoot

if (Test-ListeningPort -Port 6420) {
    Write-Host 'Backlog workspace is already running at http://127.0.0.1:6420'
}
else {
    $powershell = (Get-Process -Id $PID).Path
    $backlogScript = Join-Path $PSScriptRoot 'backlog.ps1'
    $backlogArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backlogScript, 'browser')
    if ($NoOpen) {
        $backlogArgs += '--no-open'
    }
    Start-Process -FilePath $powershell -ArgumentList $backlogArgs -WorkingDirectory $projectRoot -WindowStyle Hidden
    Write-Host 'Started Backlog workspace at http://127.0.0.1:6420'
}

Write-Host 'Workflow ready. This launcher does not change your persistent execution policy.'
