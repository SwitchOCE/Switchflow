[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Worktree,

    [Parameter(Mandatory)]
    [string]$TaskId,

    [switch]$RequireDocs,
    [switch]$RequireNode,
    [switch]$ProvisionFiles
)

$ErrorActionPreference = 'Stop'
$worktreeRoot = (Resolve-Path -LiteralPath $Worktree).Path
function Read-GovernanceConfig {
    param([string]$Root)

    $configPath = Join-Path $Root '.switchflow\project.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "$Root has no Switchflow project metadata. Create a fresh worktree from the accepted project base and rerun this preflight."
    }
    $configText = Get-Content -Raw -Encoding utf8 -LiteralPath $configPath
    try { $config = $configText | ConvertFrom-Json }
    catch { throw "Invalid Switchflow project metadata in $Root. Expected a JSON object." }
    # Windows PowerShell can wrap JSON arrays/scalars as PSObjects, making
    # '-is [pscustomobject]' true. Require the actual JSON object runtime type.
    if ($null -eq $config -or $config.GetType() -ne [System.Management.Automation.PSCustomObject]) {
        throw "Invalid Switchflow project metadata in $Root. Expected a JSON object."
    }
    foreach ($field in @('schemaVersion', 'templateVersion', 'taskPrefix', 'templateRevision', 'templateDirty')) {
        if ($null -eq $config.PSObject.Properties[$field]) {
            $config | Add-Member -NotePropertyName $field -NotePropertyValue $null
        }
    }
    if ($config.schemaVersion -ne 1 -or
        $config.templateVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($config.templateVersion) -or
        $config.taskPrefix -isnot [string] -or $config.taskPrefix -cnotmatch '^[A-Z][A-Z0-9]{1,7}$') {
        throw "Invalid Switchflow project metadata in $Root. Expected schema 1, a template version, and an uppercase task prefix."
    }
    if (($null -ne $config.templateRevision -and
            ($config.templateRevision -isnot [string] -or $config.templateRevision -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$')) -or
        ($null -ne $config.templateDirty -and $config.templateDirty -isnot [bool])) {
        throw "Invalid Switchflow source provenance in $Root."
    }
    return $config
}

# The project profile (doc-02) owns environment facts that workers otherwise
# rediscover: ignored files a worktree needs, access checks, and command notes.
# They live in one JSON block under its "Environment requirements" heading.
function Read-EnvironmentRequirements {
    param([string]$Root)

    $empty = [pscustomobject]@{ Files = @(); Checks = @(); Notes = @() }
    $docsRoot = Join-Path $Root 'backlog\docs'
    if (-not (Test-Path -LiteralPath $docsRoot -PathType Container)) { return $empty }
    $profileDoc = Get-ChildItem -LiteralPath $docsRoot -Filter 'doc-02 - *.md' -File | Select-Object -First 1
    if ($null -eq $profileDoc) { return $empty }
    $text = Get-Content -Raw -Encoding utf8 -LiteralPath $profileDoc.FullName
    $section = [regex]::Match($text, '(?ms)^## Environment requirements[ \t]*\r?\n(.*?)(?=^## |\z)')
    if (-not $section.Success) { return $empty }
    $block = [regex]::Match($section.Groups[1].Value, '(?ms)^```json[ \t]*\r?\n(.*?)^```')
    $where = "the Environment requirements JSON block in $($profileDoc.Name)"
    if (-not $block.Success) { throw "No JSON block found in the Environment requirements section of $($profileDoc.Name)." }
    try { $declared = $block.Groups[1].Value | ConvertFrom-Json }
    catch { throw "Invalid JSON in $where." }
    if ($null -eq $declared -or $declared.GetType() -ne [System.Management.Automation.PSCustomObject]) {
        throw "Expected a JSON object in $where."
    }
    $list = {
        param($Name)
        $property = $declared.PSObject.Properties[$Name]
        if ($null -eq $property -or $null -eq $property.Value) { return , @() }
        if ($property.Value -isnot [array]) { throw "'$Name' must be an array in $where." }
        return , @($property.Value)
    }
    $requiredText = {
        param($Entry, $Field, $Label)
        $value = if ($null -ne $Entry -and $Entry.GetType() -eq [System.Management.Automation.PSCustomObject]) { $Entry.PSObject.Properties[$Field] } else { $null }
        if ($null -eq $value -or $value.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($value.Value)) {
            throw "Each $Label entry needs a non-empty '$Field' string in $where."
        }
        return $value.Value
    }

    $files = foreach ($entry in (& $list 'files')) {
        $path = & $requiredText $entry 'path' 'files'
        if ([System.IO.Path]::IsPathRooted($path) -or ($path -split '[\\/]') -contains '..') {
            throw "File requirement '$path' must be relative to the checkout without '..' in $where."
        }
        [pscustomobject]@{ Path = $path; Reason = (& $requiredText $entry 'reason' 'files') }
    }
    $checks = foreach ($entry in (& $list 'checks')) {
        $timeout = 60
        $timeoutProperty = $entry.PSObject.Properties['timeoutSeconds']
        if ($null -ne $timeoutProperty) {
            if ($timeoutProperty.Value -isnot [int] -and $timeoutProperty.Value -isnot [long]) { $timeout = -1 }
            else { $timeout = [int]$timeoutProperty.Value }
            if ($timeout -lt 1 -or $timeout -gt 600) { throw "timeoutSeconds must be a whole number from 1 to 600 in $where." }
        }
        [pscustomobject]@{
            Name    = (& $requiredText $entry 'name' 'checks')
            Run     = (& $requiredText $entry 'run' 'checks')
            Reason  = (& $requiredText $entry 'reason' 'checks')
            Timeout = $timeout
        }
    }
    $notes = foreach ($note in (& $list 'notes')) {
        if ($note -isnot [string] -or [string]::IsNullOrWhiteSpace($note)) { throw "Each note must be a non-empty string in $where." }
        $note
    }
    return [pscustomobject]@{ Files = @($files); Checks = @($checks); Notes = @($notes) }
}

# Runs one declared check in the assigned checkout with a bounded wait. The
# command is passed encoded so quoting in the profile cannot change its meaning.
function Invoke-EnvironmentCheck {
    param($Check, [string]$WorkingDirectory)

    $script = "`$ErrorActionPreference = 'Stop'; try { & { $($Check.Run) }; if (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE } } catch { [Console]::Error.WriteLine(`$_.Exception.Message); exit 1 }"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Process -Id $PID).Path
    $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($Check.Timeout * 1000)) {
        & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
        throw "Environment check '$($Check.Name)' did not finish within $($Check.Timeout) seconds. It is required because: $($Check.Reason)"
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        $output = @(($stderr.Result + "`n" + $stdout.Result) -split '\r?\n' | Where-Object { $_.Trim() -ne '' })
        $detail = if ($output.Count -gt 0) { " Last output: $($output[-1].Trim())" } else { '' }
        throw "Environment check '$($Check.Name)' failed with exit code $($process.ExitCode) running '$($Check.Run)'. It is required because: $($Check.Reason).$detail"
    }
}

. (Join-Path $PSScriptRoot 'tooling.ps1')
$governanceRoot =Resolve-GovernanceRoot -ProjectRoot $worktreeRoot
$projectConfig = Read-GovernanceConfig -Root $governanceRoot
$dispatchRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dispatchRoot = Resolve-GovernanceRoot -ProjectRoot $dispatchRoot
if ($null -ne (Get-PrimaryCheckoutRoot -ProjectRoot $worktreeRoot) -and
    $null -ne (Get-PrimaryCheckoutRoot -ProjectRoot $dispatchRoot) -and
    -not $governanceRoot.Equals($dispatchRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The assigned checkout belongs to a different Git project ($governanceRoot). Dispatch using that project's own canonical governance."
}
$dispatchConfig = Read-GovernanceConfig -Root $dispatchRoot
if ($projectConfig.schemaVersion -ne $dispatchConfig.schemaVersion -or
    $projectConfig.templateVersion -ne $dispatchConfig.templateVersion -or
    $projectConfig.taskPrefix -ne $dispatchConfig.taskPrefix -or
    ($null -ne $dispatchConfig.templateRevision -and
        ($projectConfig.templateRevision -ne $dispatchConfig.templateRevision -or
         $projectConfig.templateDirty -ne $dispatchConfig.templateDirty))) {
    throw "Switchflow governance mismatch in $worktreeRoot. Expected schema $($dispatchConfig.schemaVersion), template $($dispatchConfig.templateVersion), prefix $($dispatchConfig.taskPrefix), revision $($dispatchConfig.templateRevision). Create a fresh worktree from the accepted project base and rerun this preflight."
}
$taskPattern = '^' + [regex]::Escape([string]$projectConfig.taskPrefix) + '-\d+(\.\d+)?$'
if ($TaskId -notmatch $taskPattern) {
    throw "TaskId must match $($projectConfig.taskPrefix)-<number>."
}
$backlogCli = Resolve-BacklogCli -ProjectRoot $governanceRoot

Push-Location -LiteralPath $governanceRoot
try {
    & node $backlogCli task view $TaskId --json | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Backlog task read failed for $TaskId in canonical governance $governanceRoot"
    }

    if ($RequireDocs) {
        & node (Join-Path $governanceRoot '.switchflow\scripts\check-docs.mjs') $governanceRoot $backlogCli
        if ($LASTEXITCODE -ne 0) {
            throw "Backlog documentation preflight failed in $worktreeRoot"
        }
    }

    if ($RequireNode) {
        $packageJsonPath = Join-Path $worktreeRoot 'package.json'
        if (-not (Test-Path -LiteralPath $packageJsonPath)) {
            throw "RequireNode was requested but $worktreeRoot has no package.json."
        }

        # npm writes node_modules/.package-lock.json only once an install completes,
        # so its presence separates an installed worktree from a copied, interrupted,
        # or never-installed one. It proves the graph was installed for this package;
        # it does not prove every binary in it runs. A project that needs that should
        # check its own toolchain in addition.
        $installMarkerPath = Join-Path $worktreeRoot 'node_modules\.package-lock.json'
        if (-not (Test-Path -LiteralPath $installMarkerPath)) {
            throw "Node dependencies are unavailable in $worktreeRoot. Run 'npm ci --ignore-scripts' there before dispatch; do not run 'npm install'."
        }

        $packageManifest = Get-Content -Raw -Encoding utf8 -LiteralPath $packageJsonPath | ConvertFrom-Json
        $installMarker = Get-Content -Raw -Encoding utf8 -LiteralPath $installMarkerPath | ConvertFrom-Json
        if ($packageManifest.name -ne $installMarker.name -or $packageManifest.version -ne $installMarker.version) {
            throw "node_modules in $worktreeRoot was installed for $($installMarker.name)@$($installMarker.version), not $($packageManifest.name)@$($packageManifest.version). Run 'npm ci --ignore-scripts' there before dispatch."
        }
    }

    $requirements = Read-EnvironmentRequirements -Root $governanceRoot
    $provisioned = @()
    $missing = @()
    foreach ($file in $requirements.Files) {
        $target = Join-Path $worktreeRoot $file.Path
        if (Test-Path -LiteralPath $target) { continue }
        $source = Join-Path $governanceRoot $file.Path
        $canCopy = -not $worktreeRoot.Equals($governanceRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $source)
        if ($ProvisionFiles -and $canCopy) {
            $targetParent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $targetParent)) { New-Item -ItemType Directory -Path $targetParent | Out-Null }
            Copy-Item -LiteralPath $source -Destination $target -Recurse
            $provisioned += $file.Path
        }
        elseif ($canCopy) {
            $missing += "$($file.Path) ($($file.Reason)). Rerun with -ProvisionFiles to copy it from $source."
        }
        else {
            $missing += "$($file.Path) ($($file.Reason)). It is also absent from the primary checkout $governanceRoot; create it there first."
        }
    }
    if ($missing.Count -gt 0) {
        throw "Required files are missing in ${worktreeRoot}:`n- $($missing -join "`n- ")"
    }
    foreach ($check in $requirements.Checks) {
        Invoke-EnvironmentCheck -Check $check -WorkingDirectory $worktreeRoot
    }
}
finally {
    Pop-Location
}

# Windows PowerShell turns native stderr into a terminating error under 'Stop'.
try { $head = & git -C $worktreeRoot rev-parse HEAD 2>$null; if ($LASTEXITCODE -ne 0) { $head = $null } }
catch { $head = $null }
if ([string]::IsNullOrWhiteSpace($head)) { $head = 'not a Git checkout' }
$receipt = @(
    "Environment receipt for $TaskId (observed by this preflight; facts, not permissions):",
    "- code: $worktreeRoot at $head",
    "- governance: $governanceRoot"
)
if ($RequireNode) { $receipt += "- node dependencies: installed for $($packageManifest.name)@$($packageManifest.version)" }
foreach ($file in $requirements.Files) {
    $state = if ($provisioned -contains $file.Path) { 'copied from primary checkout' } else { 'present' }
    $receipt += "- file $($file.Path): $state"
}
foreach ($check in $requirements.Checks) { $receipt += "- check passed: $($check.Name) ($($check.Run))" }
foreach ($note in $requirements.Notes) { $receipt += "- note: $note" }
Write-Host "Worktree tooling ready: $TaskId; code: $worktreeRoot; governance: $governanceRoot"
Write-Host ($receipt -join "`n")
