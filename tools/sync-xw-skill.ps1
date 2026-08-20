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

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    throw "Canonical xw skill missing: $source"
}

$expected = Relative-Files $source
foreach ($target in $targets) {
    if ($Mode -eq "Install") {
        foreach ($relative in $expected) {
            $from = Join-Path $source $relative
            $to = Join-Path $target $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
            Copy-Item -LiteralPath $from -Destination $to -Force
        }
    }

    $actual = Relative-Files $target
    if (Compare-Object $expected $actual) {
        throw "Skill file set differs: $target"
    }
    foreach ($relative in $expected) {
        $sourceHash = File-Sha256 (Join-Path $source $relative)
        $targetHash = File-Sha256 (Join-Path $target $relative)
        if ($sourceHash -ne $targetHash) { throw "Skill content differs: $target\$relative" }
    }
}

@{
    ok = $true
    mode = $Mode.ToLowerInvariant()
    source = $source
    targets = $targets
    files = $expected
} | ConvertTo-Json -Depth 4
