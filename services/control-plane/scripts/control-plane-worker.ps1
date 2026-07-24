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

$env:CONTROL_PLANE_EXPECTED_HOST = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_ID = "DESKTOP-3I1EVHE"
$env:CONTROL_PLANE_NODE_VERSION = "24.11.1"
$env:CONTROL_PLANE_GIT_COMMIT = $actualCommit
$env:CONTROL_PLANE_DEVICES_FILE = $deviceConfig
$env:CONTROL_PLANE_LEGACY_MODE = "audit"
$env:NODE_NO_WARNINGS = "1"

$stdout = Join-Path $stateRoot "server.stdout.log"
$stderr = Join-Path $stateRoot "server.stderr.log"
Set-Location -LiteralPath $repoRoot

& $nodeExe (Join-Path $repoRoot "control-plane\server.mjs") serve 1>> $stdout 2>> $stderr
exit $LASTEXITCODE
