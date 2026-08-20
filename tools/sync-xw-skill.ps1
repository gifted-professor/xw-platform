param(
    [ValidateSet("Check", "Install")]
    [string]$Mode = "Check"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "integrations\codex\skills\xw"
$targets = @(
    "C:\Users\windows 10\.agents\skills\xw",
    "C:\Users\windows 10\.codex\skills\xw"
)

function Relative-Files([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    return @(Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object {
        $_.FullName.Substring($prefix.Length).Replace('\', '/')
    } | Sort-Object)
}

function File-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-FileSet([string]$ExpectedRoot, [string]$ActualRoot, [string]$Label) {
    $expectedFiles = Relative-Files $ExpectedRoot
    $actualFiles = Relative-Files $ActualRoot
    if (Compare-Object $expectedFiles $actualFiles) { throw "Skill file set differs: $Label" }
    foreach ($relative in $expectedFiles) {
        $sourceHash = File-Sha256 (Join-Path $ExpectedRoot $relative)
        $actualHash = File-Sha256 (Join-Path $ActualRoot $relative)
        if ($sourceHash -ne $actualHash) { throw "Skill content differs: $Label\$relative" }
    }
}

function Assert-SafeManagedTarget([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ([IO.Path]::GetFileName($full) -ine "xw") { throw "Refusing unmanaged skill target: $full" }
    $parentName = [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($full))
    if ($parentName -ine "skills") { throw "Refusing skill target outside a skills directory: $full" }
    return $full
}

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    throw "Canonical xw skill missing: $source"
}

$expected = Relative-Files $source
foreach ($target in $targets) {
    $target = Assert-SafeManagedTarget $target
    if ($Mode -eq "Install") {
        $staging = "$target.staging-$PID"
        $backup = "$target.backup-$PID"
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        foreach ($relative in $expected) {
            $from = Join-Path $source $relative
            $to = Join-Path $staging $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
            Copy-Item -LiteralPath $from -Destination $to -Force
        }
        Assert-FileSet $source $staging $staging
        try {
            if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
            Move-Item -LiteralPath $staging -Destination $target
        } catch {
            if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
                Move-Item -LiteralPath $backup -Destination $target
            }
            throw
        }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    }
    Assert-FileSet $source $target $target
}

@{
    ok = $true
    mode = $Mode.ToLowerInvariant()
    source = $source
    targets = $targets
    files = $expected
} | ConvertTo-Json -Depth 4
