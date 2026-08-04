param(
    [string]$LaunchConfig = "C:\Users\Public\xhs-agent-control\task-launch.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not (Test-Path -LiteralPath $LaunchConfig)) {
    throw "Control-plane launch config not found: $LaunchConfig"
}

$launch = Get-Content -LiteralPath $LaunchConfig -Raw | ConvertFrom-Json
$repoRoot = [string]$launch.repoRoot
$nodeExe = [string]$launch.nodeExe
$expectedCommit = [string]$launch.gitCommit
$deviceConfig = [string]$launch.deviceConfig
$stateRoot = Split-Path -Parent $LaunchConfig

if (-not (Test-Path -LiteralPath $repoRoot)) { throw "Repository missing: $repoRoot" }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node missing: $nodeExe" }
if (-not (Test-Path -LiteralPath $deviceConfig)) { throw "Device config missing: $deviceConfig" }

$actualCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $expectedCommit) {
    throw "Repository commit mismatch: expected $expectedCommit, found $actualCommit"
}

if ($launch.PSObject.Properties.Name -contains "allowDirtyWorktree" -and [bool]$launch.allowDirtyWorktree) {
    $env:XHS_ALLOW_DIRTY_WORKTREE = "1"
} else {
    Remove-Item Env:XHS_ALLOW_DIRTY_WORKTREE -ErrorAction SilentlyContinue
}
& $nodeExe (Join-Path $repoRoot "scripts\assert-release-gates.mjs")
if ($LASTEXITCODE -ne 0) { throw "release gates failed" }

$recipeOverlayMode = [string]$launch.recipeOverlayMode
if ([string]::IsNullOrWhiteSpace($recipeOverlayMode)) { $recipeOverlayMode = "off" }
$env:XHS_RECIPE_OVERLAY_MODE = $recipeOverlayMode


# REX Phase 6 B7: fixed modes/release come from the launch config the task installer wrote,
# never guessed here, and never echoed to stdout/stderr. AUTONOMY_POLICY_MODE feeds
# bootstrap's resolvePolicyMode (legacy=null, shadow=compute-not-apply, nonpayment_v1=gated).
$autonomyPolicyMode = [string]$launch.autonomyPolicyMode
if ([string]::IsNullOrWhiteSpace($autonomyPolicyMode)) { $autonomyPolicyMode = "legacy" }
$evidenceMode = [string]$launch.evidenceMode
if ([string]::IsNullOrWhiteSpace($evidenceMode)) { $evidenceMode = "legacy" }
$releaseId = [string]$launch.releaseId
# REX Phase 7: pilot selectors are data from the pinned launch config, never ad-hoc worker flags.
# JSON keeps actor/alias values unambiguous and lets bootstrap reject malformed selectors before
# the server starts. Empty arrays intentionally keep a real adapter in shadow.
$pilotActors = @($launch.pilotActors) | ConvertTo-Json -Compress
$pilotAliases = @($launch.pilotAliases) | ConvertTo-Json -Compress

$env:CONTROL_PLANE_EXPECTED_HOST = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_ID = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_VERSION = "24.11.1"
$env:CONTROL_PLANE_GIT_COMMIT = $actualCommit
$env:CONTROL_PLANE_DEVICES_FILE = $deviceConfig
$env:AUTONOMY_POLICY_MODE = $autonomyPolicyMode
$env:EVIDENCE_MODE = $evidenceMode
$env:CONTROL_PLANE_PILOT_ACTORS = $pilotActors
$env:CONTROL_PLANE_PILOT_ALIASES = $pilotAliases
if (-not [string]::IsNullOrWhiteSpace($releaseId)) {
    $env:CONTROL_PLANE_RELEASE_ID = $releaseId
}
$env:CONTROL_PLANE_LEGACY_MODE = "enforce"
$env:NODE_NO_WARNINGS = "1"

$stdout = Join-Path $stateRoot "server.stdout.log"
$stderr = Join-Path $stateRoot "server.stderr.log"
Set-Location -LiteralPath $repoRoot

& $nodeExe (Join-Path $repoRoot "control-plane\server.mjs") serve 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
