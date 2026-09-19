[CmdletBinding()]
param([ValidateRange(0, 65535)][int]$Port = 0, [switch]$NoOpen)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nodePath = (Get-Command node -ErrorAction Stop).Source
$operationsPath = Join-Path $PSScriptRoot 'operations\operations.mjs'
$contextJson = & $nodePath $operationsPath context $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the project. Initialize its Git repository before starting Switchflow.' }
$context = $contextJson | ConvertFrom-Json
$infoPath = Join-Path $context.stateDir 'service-info.json'

function Get-MatchingService {
    if (-not (Test-Path -LiteralPath $infoPath)) { return $null }
    try {
        $info = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json
        $uri = [Uri]$info.url
        if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { return $null }
        $health = Invoke-RestMethod -Uri ($info.url + '/api/health') -TimeoutSec 2
        if ($health.service -eq 'switchflow-control' -and $health.projectId -eq $context.id -and $health.pid -eq $info.pid) { return $info.url }
    } catch { return $null }
    return $null
}

$url = Get-MatchingService
if (-not $url) {
    $serverPath = Join-Path $PSScriptRoot 'control\server.mjs'
    $stdoutPath = Join-Path $context.stateDir 'service.stdout.log'
    $stderrPath = Join-Path $context.stateDir 'service.stderr.log'
    $process = Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"", '--project', "`"$projectRoot`"", '--port', "$Port") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        $url = Get-MatchingService
        if ($url) { break }
        if ($process.HasExited) { throw "Switchflow did not start. Inspect $stderrPath" }
    } while ((Get-Date) -lt $deadline)
    if (-not $url) { throw "Switchflow is still starting or needs recovery. Inspect $stderrPath" }
}
Write-Host "Switchflow: $url"
if (-not $NoOpen) { Start-Process $url }
