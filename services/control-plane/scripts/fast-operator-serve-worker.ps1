param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchConfig
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") {
    throw "Worker can only run on DESKTOP-3I1EVHE"
}
if (-not (Test-Path -LiteralPath $LaunchConfig)) {
    throw "FastOperator launch config not found: $LaunchConfig"
}

$launch = Get-Content -LiteralPath $LaunchConfig -Raw | ConvertFrom-Json
$repoRoot = [string]$launch.repoRoot
$nodeExe = [string]$launch.nodeExe
$expectedCommit = [string]$launch.gitCommit
$deviceConfig = [string]$launch.deviceConfig
$alias = [string]$launch.alias
$stateRoot = Split-Path -Parent $LaunchConfig

if ($alias -notin @("01", "02", "03", "04")) { throw "Invalid alias in launch config" }
if (-not (Test-Path -LiteralPath $repoRoot)) { throw "Repository missing: $repoRoot" }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node missing: $nodeExe" }
if (-not (Test-Path -LiteralPath $deviceConfig)) { throw "Device config missing: $deviceConfig" }

$actualCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $expectedCommit) {
    throw "Repository commit mismatch: expected $expectedCommit, found $actualCommit"
}

$nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
if ($nodeVersion -ne "24.11.1") { throw "Node 24.11.1 required; found $nodeVersion" }

$config = Get-Content -LiteralPath $deviceConfig -Raw | ConvertFrom-Json
$device = @($config.devices | Where-Object { [string]$_.alias -eq $alias }) | Select-Object -First 1
if ($null -eq $device) { throw "Unknown device alias: $alias" }
$runtimeId = [string]$device.runtimeId
if ([string]::IsNullOrWhiteSpace($runtimeId)) { throw "Device runtimeId missing for alias $alias" }
$servePort = [int]$device.metadata.xhsServePort
if ($servePort -lt 1 -or $servePort -gt 65535) { throw "Invalid xhsServePort for alias $alias" }

$adbPath = [string]$device.metadata.adbPath
if ([string]::IsNullOrWhiteSpace($adbPath)) {
    $adbPath = "C:\Program Files (x86)\xiaowei_android\tools\adb.exe"
}
if (-not (Test-Path -LiteralPath $adbPath)) { throw "ADB missing for alias $alias" }

$operator = Join-Path $repoRoot "scripts\fast-operator.mjs"
if (-not (Test-Path -LiteralPath $operator)) { throw "FastOperator missing: $operator" }

$env:XHS_ALLOW_BYPASS = "0"
Remove-Item Env:XHS_BYPASS_REASON -ErrorAction SilentlyContinue
$env:XHS_OPERATOR_CONTROL_URL = "http://127.0.0.1:17920"
$env:NODE_NO_WARNINGS = "1"

$stdout = Join-Path $stateRoot "serve-${alias}.stdout.log"
$stderr = Join-Path $stateRoot "serve-${alias}.stderr.log"
$arguments = @(
    $operator,
    "--adb", $adbPath,
    "--serial", $runtimeId,
    "serve", "--port", [string]$servePort
)

Set-Location -LiteralPath $repoRoot
& $nodeExe @arguments 1>> $stdout 2>> $stderr
$nodeExitCode = $LASTEXITCODE
$lifecycleRecord = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    alias = $alias
    exitCode = $nodeExitCode
    expectedCommit = $expectedCommit
}
try {
    Add-Content -LiteralPath $stderr -Value ($lifecycleRecord | ConvertTo-Json -Compress)
} catch {
    # Lifecycle logging must never change the FastOperator exit result.
}
exit $nodeExitCode
