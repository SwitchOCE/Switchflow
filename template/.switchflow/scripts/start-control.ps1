[CmdletBinding()]
param([ValidateRange(0, 65535)][int]$Port = 0, [switch]$NoOpen)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'tooling.ps1')
$projectRoot = Resolve-GovernanceRoot -ProjectRoot $sourceRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$primaryScripts = Join-Path $projectRoot '.switchflow\scripts'
$operationsPath = Join-Path $primaryScripts 'operations\operations.mjs'
$contextJson = & $nodePath $operationsPath context $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the project. Initialize its Git repository before starting Switchflow.' }
$context = $contextJson | ConvertFrom-Json
$sharedDir = Join-Path (Split-Path -Parent (Split-Path -Parent $context.stateDir)) 'control-service'
New-Item -ItemType Directory -Path $sharedDir -Force | Out-Null
$infoPath = Join-Path $sharedDir 'service-info.json'

function Get-MatchingService {
    if (-not (Test-Path -LiteralPath $infoPath)) { return $null }
    try {
        $info = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json
        $uri = [Uri]$info.url
        if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { return $null }
        $health = Invoke-RestMethod -Uri ($info.url + '/api/health') -TimeoutSec 2
        if ($health.service -eq 'switchflow-control' -and $health.apiVersion -eq 2 -and $health.mode -eq 'multi-project' -and $health.pid -eq $info.pid) { return $info.url }
    } catch { return $null }
    return $null
}

$url = Get-MatchingService
if (-not $url) {
    $serverPath = Join-Path $primaryScripts 'control\server.mjs'
    $launchId = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $sharedDir ("service.$launchId.stdout.log")
    $stderrPath = Join-Path $sharedDir ("service.$launchId.stderr.log")
    $process = Start-Process -FilePath $nodePath -ArgumentList @("`"$serverPath`"", '--project', "`"$projectRoot`"", '--port', "$Port") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $url = Get-MatchingService
        if ($url) { break }
        # A simultaneous launcher can win the shared lock; wait for its receipt.
        # Do not fail early when this child loses: the winning launcher can
        # still be probing Codex or recovering registered projects.
    } while ((Get-Date) -lt $deadline)
    if (-not $url) { throw "Switchflow is still starting or needs recovery. Inspect $stderrPath" }
}
if ($Port -ne 0 -and ([Uri]$url).Port -ne $Port) { throw "The shared board already uses $url. Omit -Port to reuse it, or stop that service before changing its port." }
$registry = Invoke-RestMethod -Uri ($url + '/api/projects') -TimeoutSec 10
$payload = @{ projectRoot = $projectRoot } | ConvertTo-Json -Compress
$registered = Invoke-RestMethod -Uri ($url + '/api/projects') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ 'X-Switchflow-Token' = $registry.csrfToken } -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30
$projectUrl = $url + '/?project=' + $registered.project.id
Write-Host "Switchflow: $projectUrl"
if (-not $NoOpen) { Start-Process $projectUrl }
