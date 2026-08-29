# collect-rollback-tuple.ps1 - capture the full rollback tuple (Plan V2 6.2)
# for the xhs-routine runtime, as ONE immutable JSON + redacted policy copy.
#
# Nine categories, all read-only:
#   1. junction previous value (junction target + current.json raw)
#   2. scheduled task XML + hash per task
#   3. release manifest SHA-256 (of the release the junction points at)
#   4. Control Plane / Registry health FULL text
#   5. policy redacted copy + hash (token/secret-ish fields stripped)
#   6. serve-launch-03/04.json copies + hashes
#   7. DB snapshot receipt reference (path + hash; receipt itself stays put)
#   8. active jobs/leases/approvals read-only dump (CP HTTP, loopback)
#   9. rollback start order + health expectations (static, recorded hash-off)
#
# ASCII-only (PS 5.1). Nothing here writes the CP ledger.
param(
  [string]$RuntimeRoot = "C:\Users\Public\xw-runtime",
  [string]$Stamp = ("rb-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")),
  # hard gate inputs
  [string[]]$TaskNames = @("XW Platform Control Plane", "XhsDeviceControlPlaneV1", "XhsDeviceRegistry", "XhsFastOperator03Live", "XhsFastOperator04Live"),
  [string]$ControlUri = "http://127.0.0.1:17920/control/v1/health",
  [string]$RegistryUri = "http://127.0.0.1:17930/api/health",
  [string]$PolicyPath = "",
  [string]$DbSnapshotReceipt = "",
  # plans/aliases serving launch descriptors (rebound by fast-operator task install, never hand-edited)
  [string[]]$ServeLaunchFiles = @("state\control-plane\fast-operator\serve-launch-03.json", "state\control-plane\fast-operator\serve-launch-04.json")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$outDir = Join-Path $RuntimeRoot "snapshots"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$tuplePath = Join-Path $outDir "$Stamp.rollback-tuple.json"
if (Test-Path -LiteralPath $tuplePath) { throw "TUPLE_EXISTS $tuplePath (append-only)" }

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Safe-Get([string]$Uri) {
    try {
        return (Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5).Content
    } catch { return "UNREACHABLE" }
}

# 1. junction previous value
$junctionTarget = [string](Get-Item -LiteralPath (Join-Path $RuntimeRoot "current")).Target
$currentJsonRaw = Get-Content -LiteralPath (Join-Path $RuntimeRoot "current.json") -Raw

# 2. scheduled task XML + hash
$tasks = @()
foreach ($name in $TaskNames) {
    $xml = $null
    try {
        $xml = ([xml](schtasks.exe /query /tn "$name" /xml 2>$null | Out-String)).OuterXml
    } catch { $xml = $null }
    if (-not $xml) {
        $tasks += @{ name = $name; xml = $null; xmlSha256 = $null; error = "TASK_XML_UNAVAILABLE" }
        continue
    }
    $xmlPath = Join-Path $outDir "$Stamp.task-$($name -replace '[^a-zA-Z0-9]', '-').xml"
    [IO.File]::WriteAllText($xmlPath, $xml)
    $tasks += @{ name = $name; xml = $xmlPath; xmlSha256 = (Get-FileSha256 $xmlPath) }
}

# 3. release manifest hash (junction must point under releases\)
$releaseManifestPath = Join-Path $junctionTarget "release-manifest.v1.json"
$manifestHash = $null
$manifestReleaseId = $null
if (Test-Path -LiteralPath $releaseManifestPath) {
    $manifestHash = Get-FileSha256 $releaseManifestPath
    try { $manifestReleaseId = [string]((Get-Content $releaseManifestPath -Raw | ConvertFrom-Json).releaseId) } catch { $manifestReleaseId = $null }
}

# 4. health full text
$cpHealth = Safe-Get $ControlUri
$registryHealth = Safe-Get $RegistryUri

# 5. policy redacted copy + hash
$policy = @{ path = $null; redactedCopyPath = $null; sha256 = $null }
if ($PolicyPath -and (Test-Path -LiteralPath $PolicyPath)) {
    $raw = Get-Content -LiteralPath $PolicyPath -Raw
    $redacted = $raw -replace '(?i)("[a-z0-9_-]*(token|secret|password|authorization|key)[a-z0-9_-]*"\s*:\s*)"[^"]*"', '$1"<REDACTED>"'
    $redactedPath = Join-Path $outDir "$Stamp.policy.redacted.json"
    [IO.File]::WriteAllText($redactedPath, $redacted)
    $policy = @{ path = $PolicyPath; redactedCopyPath = $redactedPath; sha256 = (Get-FileSha256 $PolicyPath) }
}

# 6. serve-launch copies + hashes
$serve = @()
foreach ($rel in $ServeLaunchFiles) {
    $p = Join-Path $RuntimeRoot $rel
    if (Test-Path -LiteralPath $p) {
        $copy = Join-Path $outDir "$Stamp.$([IO.Path]::GetFileName($rel))"
        Copy-Item -LiteralPath $p -Destination $copy -Force
        $serve += @{ path = $p; copy = $copy; sha256 = (Get-FileSha256 $p) }
    } else {
        $serve += @{ path = $p; copy = $null; sha256 = $null; error = "SERVE_LAUNCH_MISSING" }
    }
}

# 7. DB snapshot receipt reference
$dbSnapshot = @{ path = $null; sha256 = $null }
if ($DbSnapshotReceipt -and (Test-Path -LiteralPath $DbSnapshotReceipt)) {
    $dbSnapshot = @{ path = $DbSnapshotReceipt; sha256 = (Get-FileSha256 $DbSnapshotReceipt) }
}

# 8. active jobs/leases/approvals read-only dump (loopback; no writes)
$active = @{
    controlPlaneJobs     = Safe-Get "http://127.0.0.1:17920/control/v1/jobs?status=active"
    controlPlaneLeases   = Safe-Get "http://127.0.0.1:17920/control/v1/leases"
    registryDevicesView  = Safe-Get "http://127.0.0.1:17930/api/devices"
}

# 9. rollback start order + health expectations (verbatim expectations)
$restorePlan = [ordered]@{
    startOrder = @(
        "verify-rollback-tuple.mjs <tuplePath> must PASS before flip",
        "switch-release.ps1 -NewRelease <old> -ExpectedManifestSha256 <old manifest sha>",
        "recover-cp-owner-lock (AUDIT_OK required)",
        "launch-control-plane.ps1",
        "launch-orchestrator.current-user.ps1",
        "fast-operator-serve task rebind 03/04 (fast-operator-serve-task.ps1 -Action Install)"
    )
    healthExpectations = @{
        controlPlaneHealthContains = '"ok":true'
        registryPorts = @(17930, 17896, 17898)
        controlPort = 17920
        adbAuthoritativePort = 5038
        activeLeasesAfterStart = 0
    }
    rollbackJunctionExpected = "current.pre-<old-release-name>"
}

$tuple = [ordered]@{
    schema           = "xw.xhs.routine-rollback-tuple.v1"
    stamp            = $Stamp
    capturedAtUtc    = (Get-Date).ToUniversalTime().ToString("o")
    junction         = @{ previousTarget = $junctionTarget; currentJsonRaw = $currentJsonRaw }
    scheduledTasks   = $tasks
    releaseManifest  = @{ path = $releaseManifestPath; sha256 = $manifestHash; releaseId = $manifestReleaseId }
    health           = @{ controlPlane = $cpHealth; registry = $registryHealth }
    policy           = $policy
    serveLaunch      = $serve
    dbSnapshot       = $dbSnapshot
    activeWork       = $active
    startOrderPlan   = $restorePlan
}
[IO.File]::WriteAllText($tuplePath, ($tuple | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)
Write-Output "ROLLBACK_TUPLE_WRITTEN $tuplePath"
Write-Output "NEXT_GATE: node tools/xhs-routine/verify-rollback-tuple.mjs --tuple <tuplePath> --runtime-root $RuntimeRoot  (must PASS before flip)"