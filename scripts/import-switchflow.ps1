[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)]
    [string]$TargetPath,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectName,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Z][A-Z0-9]{1,7}$')]
    [string]$TaskPrefix,

    [ValidateNotNullOrEmpty()]
    [string]$OwnerName = 'Project owner',

    [string]$RepoUrl = '',

    [ValidateNotNullOrEmpty()]
    [string]$ProjectPhase = 'Discovery',

    [switch]$InitializeGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-YamlSingleQuotedInner {
    param([Parameter(Mandatory)][string]$Value)
    return $Value.Replace("'", "''")
}

function ConvertTo-YamlDoubleQuotedInner {
    param([Parameter(Mandatory)][string]$Value)
    $jsonString = ConvertTo-Json -InputObject $Value -Compress
    return $jsonString.Substring(1, $jsonString.Length - 2)
}

function Test-BinaryFile {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = [byte[]]::new(8192)
        $read = $stream.Read($buffer, 0, $buffer.Length)
        for ($index = 0; $index -lt $read; $index++) {
            if ($buffer[$index] -eq 0) {
                return $true
            }
        }
        return $false
    }
    finally {
        $stream.Dispose()
    }
}

function Assert-TemplateText {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name must contain visible text."
    }
    if ($Value.ToCharArray() | Where-Object { [char]::IsControl($_) } | Select-Object -First 1) {
        throw "$Name must be a single-line value without control characters."
    }
    if ($Value -match '\{\{[A-Z0-9_]+\}\}') {
        throw "$Name contains reserved Switchflow template-token syntax."
    }
}

Assert-TemplateText -Name 'ProjectName' -Value $ProjectName
Assert-TemplateText -Name 'OwnerName' -Value $OwnerName
Assert-TemplateText -Name 'ProjectPhase' -Value $ProjectPhase
if (-not [string]::IsNullOrWhiteSpace($RepoUrl)) {
    Assert-TemplateText -Name 'RepoUrl' -Value $RepoUrl
}

$switchflowRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$templateRoot = Join-Path $switchflowRoot 'template'
$targetRoot = [System.IO.Path]::GetFullPath($TargetPath)
$pathRoot = [System.IO.Path]::GetPathRoot($targetRoot)

if ($targetRoot.TrimEnd('\', '/') -eq $pathRoot.TrimEnd('\', '/')) {
    throw 'The target may not be a filesystem root.'
}

$switchflowPrefix = $switchflowRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if ($targetRoot.Equals($switchflowRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $targetRoot.StartsWith($switchflowPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Import into a separate project, not into the Switchflow repository.'
}

$targetParent = Split-Path -Parent $targetRoot
if (Test-Path -LiteralPath $targetParent -PathType Container) {
    foreach ($prior in Get-ChildItem -LiteralPath $targetParent -Directory -Force -Filter '.switchflow-import-*') {
        $journal = Join-Path $prior.FullName 'recovery.json'
        if (Test-Path -LiteralPath $journal -PathType Leaf) {
            $recovery = Get-Content -LiteralPath $journal -Raw -Encoding utf8 | ConvertFrom-Json
            if ($recovery.target -eq $targetRoot) {
                throw "An interrupted import needs reconciliation before retrying. Inspect $journal and preserve files whose hashes differ."
            }
        }
    }
}

# Governance belongs to the checkout owning the common Git directory. Importing
# into a linked code worktree would create a second mutable board before its
# wrapper could route reads to the primary authority.
if (Test-Path -LiteralPath (Join-Path $targetRoot '.git')) {
    . (Join-Path $templateRoot '.switchflow\scripts\tooling.ps1')
    $primaryTarget = Get-PrimaryCheckoutRoot -ProjectRoot $targetRoot
    if ($null -eq $primaryTarget) {
        throw 'Cannot identify the primary checkout for this Git target. Repair its Git registration before importing governance.'
    }
    if (-not $targetRoot.TrimEnd('\', '/').Equals($primaryTarget.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Import Switchflow into the primary checkout $primaryTarget, not linked code worktree $targetRoot. Existing governance copies were preserved."
    }
}

if (-not [string]::IsNullOrWhiteSpace($RepoUrl)) {
    $repositoryUri = $null
    if (-not [System.Uri]::TryCreate($RepoUrl, [System.UriKind]::Absolute, [ref]$repositoryUri) -or
        $repositoryUri.Scheme -notin @('http', 'https')) {
        throw 'RepoUrl must be an absolute HTTP or HTTPS URL.'
    }
}

$version = (Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $switchflowRoot 'VERSION')).Trim()
# Archives and unavailable Git leave provenance unknown. Do not accidentally
# attribute an unpacked copy to an enclosing repository, or label dirty input clean.
$templateRevision = $null
$templateDirty = $null
if ((Test-Path -LiteralPath (Join-Path $switchflowRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try {
        $revision = & git -C $switchflowRoot rev-parse --verify HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and "$revision" -match '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
            $templateRevision = ([string]$revision).Trim()
            $sourceStatus = @(& git -C $switchflowRoot status --porcelain --untracked-files=all -- template scripts VERSION 2>$null)
            if ($LASTEXITCODE -eq 0) {
                $templateDirty = $sourceStatus.Count -gt 0
            }
        }
    }
    catch {
        # Windows PowerShell turns native stderr into a terminating error under
        # ErrorActionPreference=Stop. Provenance is optional, including for unborn HEAD.
        $templateDirty = $null
    }
}
$repositoryDisplay = if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    'Not configured.'
}
else {
    $RepoUrl
}

$tokens = [ordered]@{
    '{{PROJECT_NAME_YAML_SINGLE}}' = ConvertTo-YamlSingleQuotedInner $ProjectName
    '{{OWNER_NAME_YAML_SINGLE}}' = ConvertTo-YamlSingleQuotedInner $OwnerName
    '{{PROJECT_NAME_YAML_DOUBLE}}' = ConvertTo-YamlDoubleQuotedInner $ProjectName
    '{{PROJECT_NAME}}' = $ProjectName
    '{{TASK_PREFIX}}' = $TaskPrefix
    '{{OWNER_NAME}}' = $OwnerName
    '{{PROJECT_PHASE}}' = $ProjectPhase
    '{{REPOSITORY_DISPLAY}}' = $repositoryDisplay
}

# Transient build and tooling directories are never part of the template. They can
# appear if tools are installed inside template/, and must not reach an import.
$excludedDirectories = @('node_modules', '.git', '.venv', '__pycache__', '.tmp')

$renderedFiles = [System.Collections.Generic.List[object]]::new()
$excludedPaths = [System.Collections.Generic.List[string]]::new()
$separators = [char[]]@('\', '/')

foreach ($sourceFile in Get-ChildItem -LiteralPath $templateRoot -Recurse -File -Force) {
    $relativePath = $sourceFile.FullName.Substring($templateRoot.Length).TrimStart($separators)

    $segments = $relativePath.Split($separators, [System.StringSplitOptions]::RemoveEmptyEntries)
    $excludedSegment = $segments | Where-Object { $excludedDirectories -contains $_ } | Select-Object -First 1
    if ($null -ne $excludedSegment) {
        $excludedPaths.Add($excludedSegment)
        continue
    }

    # Binary files are copied verbatim. Token substitution would corrupt them, and
    # scanning their bytes for token syntax produces false unresolved-token errors.
    if (Test-BinaryFile -Path $sourceFile.FullName) {
        $renderedFiles.Add([pscustomobject]@{
            RelativePath = $relativePath
            Content = $null
            Bytes = [System.IO.File]::ReadAllBytes($sourceFile.FullName)
        })
        continue
    }

    $content = Get-Content -Raw -Encoding utf8 -LiteralPath $sourceFile.FullName
    if ($null -eq $content) {
        $content = ''
    }
    foreach ($token in $tokens.Keys) {
        $content = $content.Replace($token, [string]$tokens[$token])
    }
    if ($content -match '\{\{[A-Z0-9_]+\}\}') {
        throw "Unresolved template token in $relativePath"
    }
    $renderedFiles.Add([pscustomobject]@{
        RelativePath = $relativePath
        Content = $content
        Bytes = $null
    })
}

if ($excludedPaths.Count -gt 0) {
    $excludedKinds = @($excludedPaths | Sort-Object -Unique)
    Write-Warning ("Skipped {0} file(s) in transient directories under template/ ({1}). These are never imported." -f $excludedPaths.Count, ($excludedKinds -join ', '))
}

if ($renderedFiles.Count -eq 0) {
    throw "No template files were found under $templateRoot."
}

$collisions = @(
    $renderedFiles |
        Where-Object { Test-Path -LiteralPath (Join-Path $targetRoot $_.RelativePath) } |
        ForEach-Object RelativePath
)
$projectConfigPath = Join-Path $targetRoot '.switchflow\project.json'
if (Test-Path -LiteralPath $projectConfigPath) {
    $collisions += '.switchflow\project.json'
}
if ($collisions.Count -gt 0) {
    throw "Import would overwrite existing governance files:`n- $($collisions -join "`n- ")"
}

# Validate every existing ancestor before the first write. A leaf-only collision
# check misses files where directories are needed and links that redirect writes
# outside the intended project (including an existing linked .gitignore).
$destinations = @($renderedFiles | ForEach-Object { Join-Path $targetRoot $_.RelativePath }) +
    @($projectConfigPath, (Join-Path $targetRoot '.gitignore'))
$checkedPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($destination in $destinations) {
    $cursor = $destination
    $isLeaf = $true
    while (-not [string]::IsNullOrEmpty($cursor)) {
        if ($checkedPaths.Add($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
            if ($null -ne $item) {
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Import destination uses a linked path: $cursor"
                }
                if (-not $isLeaf -and -not $item.PSIsContainer) {
                    throw "Import requires a directory but found a file: $cursor"
                }
                if ($isLeaf -and $item.PSIsContainer) {
                    throw "Import requires a file but found a directory: $cursor"
                }
            }
        }
        $cursor = Split-Path -Parent $cursor
        $isLeaf = $false
    }
}

if (-not $PSCmdlet.ShouldProcess($targetRoot, "Import Switchflow $version")) {
    return
}

$utf8 = [System.Text.UTF8Encoding]::new($false)

$projectConfig = [ordered]@{
    schemaVersion = 1
    templateVersion = $version
    templateRevision = $templateRevision
    templateDirty = $templateDirty
    projectName = $ProjectName
    taskPrefix = $TaskPrefix
    ownerName = $OwnerName
    repositoryUrl = $RepoUrl
    projectPhase = $ProjectPhase
}
$renderedFiles.Add([pscustomobject]@{ RelativePath = '.switchflow\project.json'; Content = (($projectConfig | ConvertTo-Json -Depth 3) + "`n"); Bytes = $null })

$gitignorePath = Join-Path $targetRoot '.gitignore'
$gitignoreMarker = '# Switchflow local tooling'
$gitignoreBlock = @'
# Switchflow local tooling
/.switchflow/node_modules/
/backlog/milestones/*.scope-lock
/backlog/milestones/*.tmp
'@
$originalGitignoreBytes = $null
$existingGitignore = if (Test-Path -LiteralPath $gitignorePath) {
    $originalGitignoreBytes = [System.IO.File]::ReadAllBytes($gitignorePath)
    $utf8.GetString($originalGitignoreBytes).TrimStart([char]0xFEFF)
}
else {
    ''
}
if (-not $existingGitignore.Contains($gitignoreMarker)) {
    $separator = if ([string]::IsNullOrWhiteSpace($existingGitignore)) { '' } else { "`n" }
    $renderedFiles.Add([pscustomobject]@{ RelativePath = '.gitignore'; Content = ($existingGitignore.TrimEnd("`r", "`n") + $separator + $gitignoreBlock.Trim() + "`n"); Bytes = $null; OriginalBytes = $originalGitignoreBytes })
}

if ($InitializeGit -and -not (Test-Path -LiteralPath (Join-Path $targetRoot '.git'))) {
    & git init -b main $targetRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Git initialization failed for $targetRoot"
    }
}

& (Join-Path $PSScriptRoot 'install-rendered-template.ps1') -TargetRoot $targetRoot -Files $renderedFiles.ToArray()

Write-Host "Imported Switchflow $version into $targetRoot"
Write-Host 'Next: edit the project profile in backlog/docs, install .switchflow tools, and run the board and documentation checks.'
