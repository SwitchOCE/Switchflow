param([Parameter(Mandatory)][string]$TargetRoot, [Parameter(Mandatory)][object[]]$Files)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-ImportHash([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Assert-ImportPath([string]$Path) {
    $cursor = $Path
    while (-not [string]::IsNullOrEmpty($cursor)) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Import destination uses a linked path: $cursor" }
        $cursor = Split-Path -Parent $cursor
    }
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
$parent = Split-Path -Parent $TargetRoot
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
$stage = Join-Path $parent ('.switchflow-import-' + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($stage) | Out-Null
$entries = [System.Collections.Generic.List[object]]::new()
$installed = [System.Collections.Generic.List[object]]::new()
$keepRecovery = $false
try {
    # Stage on the target volume so each leaf is installed by an atomic move.
    foreach ($file in $Files) {
        $source = Join-Path $stage $file.RelativePath
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $source)) | Out-Null
        if ($null -ne $file.Bytes) { [System.IO.File]::WriteAllBytes($source, $file.Bytes) }
        else { [System.IO.File]::WriteAllText($source, $file.Content, $utf8) }
        $destination = Join-Path $TargetRoot $file.RelativePath
        $originalHash = $null
        if (Test-Path -LiteralPath $destination) {
            if ($file.RelativePath -ne '.gitignore') { throw "Import destination appeared during staging: $destination" }
            if ($null -eq $file.OriginalBytes -or [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($destination)) -ne [Convert]::ToBase64String($file.OriginalBytes)) { throw "Destination changed during rendering: $destination" }
            $originalHash = (Get-ImportHash $destination)
            [System.IO.File]::Copy($destination, (Join-Path $stage 'gitignore.original'))
        }
        elseif ($file.RelativePath -eq '.gitignore' -and $null -ne $file.OriginalBytes) { throw "Destination removed during rendering: $destination" }
        $entries.Add([pscustomobject]@{ source = $source; destination = $destination; hash = (Get-ImportHash $source); originalHash = $originalHash })
    }
    # Written before the first move, this journal survives a terminated process.
    $manifest = [ordered]@{ target = $TargetRoot; createdAt = [DateTime]::UtcNow.ToString('o'); files = $entries.ToArray(); recovery = 'Compare destination hashes before removing imported files. Preserve differing files. Restore gitignore.original only when the destination matches its staged hash. Empty directories may remain. Never remove unrelated files.' }
    [System.IO.File]::WriteAllText((Join-Path $stage 'recovery.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
    foreach ($entry in $entries) {
        Assert-ImportPath $entry.destination
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $entry.destination)) | Out-Null
        Assert-ImportPath $entry.destination
        if ($null -ne $entry.originalHash) {
            if ((Get-ImportHash $entry.destination) -ne $entry.originalHash) { throw "Destination changed during import: $($entry.destination)" }
            [System.IO.File]::Replace($entry.source, $entry.destination, (Join-Path $stage 'gitignore.replaced'))
        }
        else { [System.IO.File]::Move($entry.source, $entry.destination) }
        $installed.Add($entry)
    }
}
catch {
    $failure = $_
    foreach ($entry in @($installed.ToArray()) | Sort-Object destination -Descending) {
        try {
            Assert-ImportPath $entry.destination
            if ((Get-ImportHash $entry.destination) -ne $entry.hash) { throw 'Imported file changed; preserving it.' }
            if ($null -ne $entry.originalHash) { [System.IO.File]::Replace((Join-Path $stage 'gitignore.original'), $entry.destination, (Join-Path $stage 'gitignore.rolled-back')) }
            else { [System.IO.File]::Delete($entry.destination) }
        }
        catch { $keepRecovery = $true; Write-Warning "Could not roll back $($entry.destination): $_" }
    }
    if ($keepRecovery) { Write-Warning "Import recovery files retained at $stage" }
    throw $failure
}
finally {
    if (-not $keepRecovery) {
        $resolvedStage = [System.IO.Path]::GetFullPath($stage)
        if ((Split-Path -Parent $resolvedStage) -ne [System.IO.Path]::GetFullPath($parent) -or (Split-Path -Leaf $resolvedStage) -notmatch '^\.switchflow-import-[a-f0-9]{32}$') { throw 'Unsafe staging cleanup path' }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
