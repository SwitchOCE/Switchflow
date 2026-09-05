[CmdletBinding()]
param(
    [string]$PythonPath = 'python',
    [string]$ValidatorPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$switchflowRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$validationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('switchflow-validation-' + [guid]::NewGuid().ToString('N'))
$importerPath = Join-Path $switchflowRoot 'scripts\import-switchflow.ps1'
$allowedFrontmatterKeys = @('name', 'description', 'license', 'allowed-tools', 'metadata')

try {
    & node --test (Join-Path $switchflowRoot 'scripts\check-completed-tasks.test.mjs') (Join-Path $switchflowRoot 'scripts\check-governance-baseline.test.mjs') (Join-Path $switchflowRoot 'scripts\flow.test.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw 'Switchflow regression checks failed.'
    }

    & $importerPath `
        -TargetPath $validationRoot `
        -ProjectName 'Switchflow Validation' `
        -TaskPrefix 'VAL' `
        -OwnerName 'Validation Owner' `
        -ProjectPhase 'Experimental'

    & node (Join-Path $validationRoot '.switchflow\scripts\check-docs.mjs') $validationRoot
    if ($LASTEXITCODE -ne 0) {
        throw 'Rendered Backlog documentation validation failed.'
    }

    $skillRoots = @(Get-ChildItem -LiteralPath (Join-Path $validationRoot '.agents\skills') -Directory)
    foreach ($skillRoot in $skillRoots) {
        $skillPath = Join-Path $skillRoot.FullName 'SKILL.md'
        $content = Get-Content -Raw -Encoding utf8 -LiteralPath $skillPath
        $frontmatterMatch = [regex]::Match(
            $content,
            '\A---\r?\n(?<frontmatter>.*?)\r?\n---',
            [System.Text.RegularExpressions.RegexOptions]::Singleline
        )
        if (-not $frontmatterMatch.Success) {
            throw "Invalid or missing frontmatter in $skillPath"
        }

        $frontmatter = $frontmatterMatch.Groups['frontmatter'].Value
        $keys = [regex]::Matches($frontmatter, '(?m)^(?<key>[a-z][a-z0-9-]*):') |
            ForEach-Object { $_.Groups['key'].Value }
        $unexpectedKeys = @($keys | Where-Object { $_ -notin $allowedFrontmatterKeys })
        if ($unexpectedKeys.Count -gt 0) {
            throw "Unexpected frontmatter key in $skillPath`: $($unexpectedKeys -join ', ')"
        }

        $nameMatch = [regex]::Match($frontmatter, '(?m)^name:\s*(?<name>[a-z0-9-]+)\s*$')
        if (-not $nameMatch.Success -or $nameMatch.Groups['name'].Value -ne $skillRoot.Name) {
            throw "Skill name is missing, invalid, or different from its directory in $skillPath"
        }
        if (-not [regex]::IsMatch($frontmatter, '(?m)^description:\s*\S.+$')) {
            throw "Skill description is missing or empty in $skillPath"
        }
        if ($content -match '\{\{[A-Z0-9_]+\}\}') {
            throw "Unresolved template token in $skillPath"
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ValidatorPath)) {
        $ValidatorPath = [System.IO.Path]::GetFullPath($ValidatorPath)
        if (-not (Test-Path -LiteralPath $ValidatorPath -PathType Leaf)) {
            throw "Codex skill validator not found at $ValidatorPath."
        }
        foreach ($skillRoot in $skillRoots) {
            & $PythonPath -X utf8 $ValidatorPath $skillRoot.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "Codex skill validation failed for $($skillRoot.Name)."
            }
        }
    }

    # Phase cleanup selects tasks by label, and Backlog.md writes a non-empty list
    # as a YAML block sequence. A parser that reads only the inline flow form
    # selects nothing, deletes nothing, and still reports the phase clean, so both
    # forms are exercised here against real branches.
    $tasksRoot = Join-Path $validationRoot 'backlog\tasks'
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $fixtures = [ordered]@{
        'val-1.md' = "---`nid: VAL-1`ntitle: Block sequence labels`nstatus: Done`nlabels:`n  - phase-check`n---`n"
        'val-2.md' = "---`nid: VAL-2`ntitle: Inline flow labels`nstatus: Done`nlabels: ['phase-check']`n---`n"
        'val-3.md' = "---`nid: VAL-3`ntitle: No labels`nstatus: Done`nlabels: []`n---`n"
    }
    foreach ($fixture in $fixtures.GetEnumerator()) {
        [System.IO.File]::WriteAllText((Join-Path $tasksRoot $fixture.Key), $fixture.Value, $utf8NoBom)
    }

    & git init -b main $validationRoot | Out-Null
    & git -C $validationRoot -c user.name=Switchflow -c user.email=validation@localhost commit --allow-empty -m 'Validation baseline' | Out-Null
    foreach ($id in @('VAL-1', 'VAL-2', 'VAL-3')) {
        & git -C $validationRoot branch "task/$id" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create validation branch task/$id."
        }
    }

    & (Join-Path $validationRoot '.switchflow\scripts\cleanup-phase.ps1') -PhaseLabel phase-check | Out-Null
    $remaining = @(& git -C $validationRoot branch --format='%(refname:short)')
    $shouldBeGone = @(@('task/VAL-1', 'task/VAL-2') | Where-Object { $remaining -contains $_ })
    if ($shouldBeGone.Count -gt 0) {
        throw "Phase cleanup did not select labelled tasks: $($shouldBeGone -join ', ') survived."
    }
    if ($remaining -notcontains 'task/VAL-3') {
        throw 'Phase cleanup removed task/VAL-3, whose task carries no label.'
    }
    Write-Host 'Validated phase cleanup label selection for block sequence and inline flow lists.'

    $officialResult = if ([string]::IsNullOrWhiteSpace($ValidatorPath)) { '' } else { ' and the supplied Codex validator' }
    Write-Host "Validated $($skillRoots.Count) rendered Switchflow skills in UTF-8 mode$officialResult."
}
finally {
    if (Test-Path -LiteralPath $validationRoot) {
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        $resolvedValidationRoot = [System.IO.Path]::GetFullPath($validationRoot)
        if (-not $resolvedValidationRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean validation path outside the temporary directory: $resolvedValidationRoot"
        }
        Remove-Item -LiteralPath $resolvedValidationRoot -Recurse -Force
    }
}
