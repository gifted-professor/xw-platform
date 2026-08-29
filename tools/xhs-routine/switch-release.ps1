# switch-release.ps1 - parameterized junction cutover for xw-runtime releases.
#
# Parameterized from the hand-maintained switch-release-b3.ps1 (2026-08-28
# cutover). Lesson kept: graceful CTRL-C is unreliable for the hidden-console
# CP, so this script uses force-stop; CP/Orch relaunch is MANUAL after
# AUDIT_OK (owner-lock recovery). Start order: CP -> Orch -> fast-operator.
#
# Runbook gate: run collect-rollback-tuple.ps1 + verify-rollback-tuple.mjs
# (PASS) BEFORE flipping. This script re-verifies the new release manifest
# hash immediately before the junction flip; any failure restores the old
# junction + current.json and exits with SWITCH_ROLLED_BACK.
#
# ASCII-only (PS 5.1 misreads UTF-8 scripts without BOM).
param(
  [Parameter(Mandatory = $true)][string]$NewRelease,
  [string]$OldRelease = "",
  [string]$RuntimeRoot = "C:\Users\Public\xw-runtime",
  # hard manifest gate: sha256 of <new>\release-manifest.v1.json
  [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
  # orch family listener ports stopped before the flip (registry + serves)
  [int[]]$OrchPorts = @(17930, 17896, 17898),
  # CP listener port
  [int]$ControlPort = 17920
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$releases = Join-Path $RuntimeRoot "releases"
$newRel = Join-Path $releases $NewRelease
$current = Join-Path $RuntimeRoot "current"
$currentJson = Join-Path $RuntimeRoot "current.json"
$manifest = Join-Path $newRel "release-manifest.v1.json"

# --- preconditions ---
foreach ($r in @($newRel, $manifest)) {
    if (-not (Test-Path -LiteralPath $r)) { throw "NEW_RELEASE_INCOMPLETE $r" }
}
$full = [IO.Path]::GetFullPath($newRel)
if (-not $full.StartsWith((Join-Path $releases ""))) { throw "RELEASE_OUTSIDE_RELEASES $newRel" }

if ($OldRelease -eq "") {
    $cj = Get-Content -LiteralPath $currentJson -Raw | ConvertFrom-Json
    if (-not $cj.releaseId) { throw "CURRENT_JSON_NO_RELEASEID (pass -OldRelease)" }
    $OldRelease = [string]$cj.releaseId
}
$oldRel = Join-Path $releases $OldRelease
if (-not (Test-Path -LiteralPath $oldRel -PathType Container)) { throw "OLD_RELEASE_MISSING $oldRel" }

$oldTarget = [string](Get-Item -LiteralPath $current).Target
if ($oldTarget -ne $oldRel) { throw "CURRENT_JUNCTION_UNEXPECTED target=$oldTarget expected=$oldRel" }

# --- safety snapshot (minimal; the full tuple is collect-rollback-tuple.ps1) ---
$snap = Join-Path $RuntimeRoot "snapshots"
New-Item -ItemType Directory -Force -Path $snap | Out-Null
$stamp = "switch-$NewRelease"
Copy-Item -LiteralPath $currentJson -Destination (Join-Path $snap "$stamp.current.json.before") -Force

# --- rollback junction pointing back at the old release ---
$pre = Join-Path $RuntimeRoot "current.pre-$NewRelease"
if (Test-Path -LiteralPath $pre) { cmd /c rmdir "$pre" | Out-Null }
cmd /c mklink /J "$pre" "$oldRel" | Out-Null
$preTarget = [string](Get-Item -LiteralPath $pre).Target
if ($preTarget -ne $oldRel) { throw "ROLLBACK_JUNCTION_FAILED target=$preTarget" }
Write-Output "ROLLBACK_JUNCTION_READY current.pre-$NewRelease -> $oldRel"

# --- manifest hash gate BEFORE the flip; mismatch restores and aborts ---
function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}
$manifestHash = Get-FileSha256 $manifest
if ($manifestHash -ne $ExpectedManifestSha256.ToLowerInvariant()) {
    cmd /c rmdir "$pre" | Out-Null
    throw "MANIFEST_HASH_MISMATCH expected=$ExpectedManifestSha256 actual=$manifestHash (junction untouched)"
}
Write-Output "MANIFEST_HASH_OK $manifest"

function Get-ListenerPid([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

# --- stop orchestrator family ---
foreach ($port in $OrchPorts) {
    $p = Get-ListenerPid $port
    if ($p) {
        Stop-Process -Id $p -Force -ErrorAction Stop
        Write-Output ("ORCH_STOPPED port=$port pid=$p")
    } else { Write-Output "ORCH_ALREADY_DOWN port=$port" }
}

# --- CP: force stop ---
$cpPid = Get-ListenerPid $ControlPort
if ($cpPid) {
    Stop-Process -Id $cpPid -Force -ErrorAction Stop
    Write-Output ("CP_FORCE_STOPPED pid=" + $cpPid)
} else { Write-Output "CP_ALREADY_DOWN" }
Start-Sleep -Seconds 2

# --- junction flip (cmd rmdir/mklink: PS 5.1 Remove-Item throws on junctions) ---
cmd /c rmdir "$current" | Out-Null
cmd /c mklink /J "$current" "$newRel" | Out-Null
$nowTarget = [string](Get-Item -LiteralPath $current).Target
if ($nowTarget -ne $newRel) {
    # restore the previous junction + current.json before failing
    cmd /c rmdir "$current" | Out-Null
    cmd /c mklink /J "$current" "$oldRel" | Out-Null
    Copy-Item -LiteralPath (Join-Path $snap "$stamp.current.json.before") -Destination $currentJson -Force
    throw "SWITCH_ROLLED_BACK target=$nowTarget expected=$newRel (restored $oldRel)"
}
Write-Output "JUNCTION_FLIPPED current -> $newRel"

@{
    rollbackJunction = "current.pre-$NewRelease"
    switchedAtUtc    = (Get-Date).ToUniversalTime().ToString("o")
    releaseId        = $NewRelease
    previous         = $OldRelease
    manifestSha256   = $manifestHash
} | ConvertTo-Json | Set-Content -LiteralPath $currentJson -Encoding UTF8
Write-Output "CURRENT_JSON_UPDATED"
Write-Output "NEXT_MANUAL: recover-cp-owner-lock (AUDIT_OK required) -> launch-control-plane.ps1 -> launch-orchestrator.current-user.ps1 -> fast-operator-serve task rebind 03/04"
Write-Output "NEXT_GATE: xw-start.mjs 03 --check --json must show ready/allHealthy/releaseGate.ok/adb.port=5038/activeLeases=0 before any live wave"