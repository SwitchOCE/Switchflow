[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$SkillsRoot = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SkillsRoot)) {
    $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $SkillsRoot = Join-Path $codexRoot 'skills'
}
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'skills\review-switchflow'
$destination = Join-Path ([System.IO.Path]::GetFullPath($SkillsRoot)) 'review-switchflow'
if (Test-Path -LiteralPath $destination) {
    $different = @(Get-ChildItem -LiteralPath $source -File -Recurse | Where-Object {
        $relative = $_.FullName.Substring($source.Length).TrimStart('\', '/')
        $targetFile = Join-Path $destination $relative
        -not (Test-Path -LiteralPath $targetFile -PathType Leaf) -or (Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $targetFile).Hash
    })
    if ($different.Count) { throw "An existing $destination differs. Compare it before replacing a personal skill." }
    Write-Host "Already installed: $destination"
    return
}
if ($PSCmdlet.ShouldProcess($destination, 'Install the external Switchflow review skill')) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse
    Write-Host "Installed: $destination"
}
