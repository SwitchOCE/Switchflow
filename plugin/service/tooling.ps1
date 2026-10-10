Set-StrictMode -Version Latest

function Get-PrimaryCheckoutRoot {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $dotGitPath = Join-Path $ProjectRoot '.git'
    $commonGitDir = $null

    if (Test-Path -LiteralPath $dotGitPath -PathType Container) {
        $commonGitDir = $dotGitPath
    }
    elseif (Test-Path -LiteralPath $dotGitPath -PathType Leaf) {
        $gitDirLine = (Get-Content -Raw -Encoding utf8 $dotGitPath).Trim()
        if ($gitDirLine.StartsWith('gitdir: ')) {
            $gitDir = $gitDirLine.Substring(8)
            if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
                $gitDir = Join-Path $ProjectRoot $gitDir
            }
            $gitDir = [System.IO.Path]::GetFullPath($gitDir)

            $commonDirFile = Join-Path $gitDir 'commondir'
            if (Test-Path -LiteralPath $commonDirFile) {
                $commonGitDir = Join-Path $gitDir (Get-Content -Raw -Encoding utf8 $commonDirFile).Trim()
            }
        }
    }

    if ($null -eq $commonGitDir) {
        try {
            $gitResult = & git -C $ProjectRoot rev-parse --path-format=absolute --git-common-dir 2>$null
        }
        catch {
            return $null
        }
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitResult)) {
            return $null
        }
        $commonGitDir = $gitResult
    }

    $commonGitDir = [System.IO.Path]::GetFullPath(([string]$commonGitDir).Trim())
    if ((Split-Path -Leaf $commonGitDir) -ne '.git') {
        return $null
    }

    return Split-Path -Parent $commonGitDir
}

function Get-ToolingRoots {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $roots = [System.Collections.Generic.List[string]]::new()
    $roots.Add([System.IO.Path]::GetFullPath($ProjectRoot))

    $primaryRoot = Get-PrimaryCheckoutRoot -ProjectRoot $ProjectRoot
    if ($null -ne $primaryRoot -and -not $roots.Contains($primaryRoot)) {
        $roots.Add($primaryRoot)
    }

    return $roots
}

function Resolve-GovernanceRoot {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $root = [System.IO.Path]::GetFullPath($ProjectRoot)
    $primary = Get-PrimaryCheckoutRoot -ProjectRoot $root
    if ($null -eq $primary) {
        if (Test-Path -LiteralPath (Join-Path $root '.git')) {
            throw "Cannot resolve the primary governance checkout for $root. Repair the Git worktree registration; do not use its copied board."
        }
        # Standalone imports are supported before Git initialization.
        return $root
    }
    $hasConfig = (Test-Path -LiteralPath (Join-Path $primary 'backlog.config.yml') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $primary 'backlog\config.yml') -PathType Leaf)
    if (-not $hasConfig -or
        -not (Test-Path -LiteralPath (Join-Path $primary 'backlog') -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $primary '.switchflow\scripts\backlog.ps1') -PathType Leaf)) {
        throw "Canonical governance is unavailable in primary checkout $primary. Restore that checkout's Switchflow configuration and backlog; copied worktree governance is never a fallback."
    }
    return $primary
}

function Resolve-BacklogCli {
    param([Parameter(Mandatory)][string]$ProjectRoot, [switch]$RequireFork)

    $forkResolver = Join-Path $ProjectRoot '.switchflow\scripts\backlog-fork\resolve.mjs'
    if (Test-Path -LiteralPath $forkResolver -PathType Leaf) {
        try {
            $forkCli = & node $forkResolver 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath ([string]$forkCli).Trim() -PathType Leaf)) { return ([string]$forkCli).Trim() }
        } catch { # Existing imports retain readable original tooling until explicit fork setup.
        }
    }

    if ($RequireFork) {
        throw "The verified Switchflow Backlog fork is required for mutations, MCP and the native board. Run 'npm --prefix .switchflow run setup:backlog-fork' in canonical governance $ProjectRoot. The official fallback is read-only."
    }

    $projectPackage = Get-Content -Raw -Encoding utf8 (Join-Path $ProjectRoot '.switchflow\package.json') | ConvertFrom-Json
    $expectedVersion = [string]$projectPackage.devDependencies.'backlog.md'
    if ([string]::IsNullOrWhiteSpace($expectedVersion)) {
        throw '.switchflow/package.json does not pin Backlog.md.'
    }

    foreach ($root in Get-ToolingRoots -ProjectRoot $ProjectRoot) {
        $cliPath = Join-Path $root '.switchflow\node_modules\backlog.md\cli.js'
        $installedPackagePath = Join-Path $root '.switchflow\node_modules\backlog.md\package.json'
        if (-not (Test-Path -LiteralPath $cliPath) -or -not (Test-Path -LiteralPath $installedPackagePath)) {
            continue
        }

        $installedPackage = Get-Content -Raw -Encoding utf8 $installedPackagePath | ConvertFrom-Json
        if ([string]$installedPackage.version -eq $expectedVersion) {
            try {
                & node $cliPath --version *> $null
            }
            catch {
                continue
            }
            if ($LASTEXITCODE -eq 0) {
                return $cliPath
            }
        }
    }

    throw "Backlog.md $expectedVersion is unavailable in this worktree and the primary checkout. Run 'npm --prefix .switchflow ci --ignore-scripts' in the primary checkout; do not run an unpinned install."
}
