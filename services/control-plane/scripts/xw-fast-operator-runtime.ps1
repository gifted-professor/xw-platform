param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchConfig
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Keep this launcher ASCII-only for Windows PowerShell 5.1. It lives under
# xw-runtime and resolves the current junction before invoking Node.
if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") { throw "Worker can only run on DESKTOP-3I1EVHE" }
if (-not (Test-Path -LiteralPath $LaunchConfig)) { throw "FastOperator launch config not found: $LaunchConfig" }

$launch = Get-Content -LiteralPath $LaunchConfig -Raw | ConvertFrom-Json
$runtimeRoot = [IO.Path]::GetFullPath([string]$launch.runtimeRoot)
$nodeExe = [string]$launch.nodeExe
$expectedCommit = [string]$launch.sourceCommit
$expectedReleaseId = [string]$launch.releaseId
$deviceConfig = [string]$launch.deviceConfig
$alias = [string]$launch.alias
$stateRoot = Split-Path -Parent $LaunchConfig
$logRoot = Join-Path $runtimeRoot "logs\fast-operator"
$failureLog = Join-Path $logRoot "serve-$alias.stderr.log"

trap {
    try {
        New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
        $failure = [ordered]@{
            timestamp = (Get-Date).ToUniversalTime().ToString("o")
            alias = $alias
            phase = "launcher-error"
            errorType = [string]$_.Exception.GetType().FullName
            message = [string]$_.Exception.Message
        }
        Add-Content -LiteralPath $failureLog -Value ($failure | ConvertTo-Json -Compress)
    } catch { }
    exit 1
}

if ($alias -notin @("01", "02", "03", "04")) { throw "Invalid alias in launch config" }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node missing: $nodeExe" }
if (-not (Test-Path -LiteralPath $deviceConfig)) { throw "Device config missing: $deviceConfig" }

$current = Join-Path $runtimeRoot "current"
$releaseRoot = [string](Get-Item -LiteralPath $current).Target
if ([string]::IsNullOrWhiteSpace($releaseRoot)) { throw "Runtime current junction unresolved" }
$releaseRoot = [IO.Path]::GetFullPath($releaseRoot)
$releasesRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "releases"))
if (-not $releaseRoot.StartsWith($releasesRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime current target escapes releases root"
}
$manifestPath = Join-Path $releaseRoot "release-manifest.v1.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.sourceCommit -ne $expectedCommit -or [string]$manifest.releaseId -ne $expectedReleaseId) {
    throw "Release identity mismatch: expected $expectedReleaseId/$expectedCommit"
}
if ([string]$manifest.runtimeProfile -ne "legacy_compat") { throw "Unsupported runtime profile" }

$nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
if ($nodeVersion -ne [string]$manifest.nodeVersion) { throw "Node $($manifest.nodeVersion) required; found $nodeVersion" }

$config = Get-Content -LiteralPath $deviceConfig -Raw | ConvertFrom-Json
$device = @($config.devices | Where-Object { [string]$_.alias -eq $alias }) | Select-Object -First 1
if ($null -eq $device) { throw "Unknown device alias: $alias" }
$runtimeId = [string]$device.runtimeId
if ([string]::IsNullOrWhiteSpace($runtimeId)) { throw "Device runtimeId missing for alias $alias" }
$servePort = [int]$device.metadata.xhsServePort
if ($servePort -lt 1 -or $servePort -gt 65535) { throw "Invalid xhsServePort for alias $alias" }
$adbPath = [string]$device.metadata.adbPath
if ([string]::IsNullOrWhiteSpace($adbPath)) { $adbPath = "C:\Program Files (x86)\xiaowei_android\tools\adb.exe" }
if (-not (Test-Path -LiteralPath $adbPath)) { throw "ADB missing for alias $alias" }

$operator = Join-Path $releaseRoot "services\control-plane\scripts\fast-operator.mjs"
if (-not (Test-Path -LiteralPath $operator)) { throw "FastOperator missing: $operator" }

$env:XHS_ALLOW_BYPASS = "0"
Remove-Item Env:XHS_BYPASS_REASON -ErrorAction SilentlyContinue
$env:XHS_OPERATOR_CONTROL_URL = "http://127.0.0.1:17920"
$env:ANDROID_ADB_SERVER_PORT = "5038"
Remove-Item Env:ADB_SERVER_SOCKET -ErrorAction SilentlyContinue
$env:XW_RELEASE_MANIFEST = $manifestPath
$env:NODE_NO_WARNINGS = "1"

New-Item -ItemType Directory -Force -Path $stateRoot, $logRoot | Out-Null
$stdout = Join-Path $logRoot "serve-$alias.stdout.log"
$stderr = Join-Path $logRoot "serve-$alias.stderr.log"
$startRecord = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString("o"); alias = $alias; phase = "worker-start"; workerPid = $PID; expectedCommit = $expectedCommit; releaseId = $expectedReleaseId }
try { Add-Content -LiteralPath $stderr -Value ($startRecord | ConvertTo-Json -Compress) } catch { }

$arguments = @($operator, "--adb", $adbPath, "--serial", $runtimeId, "serve", "--port", [string]$servePort)
Set-Location -LiteralPath $releaseRoot
$nodeExitCode = $null
try {
    & $nodeExe @arguments 1>> $stdout 2>> $stderr
    $nodeExitCode = $LASTEXITCODE
} finally {
    $record = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString("o"); alias = $alias; phase = "worker-exit"; workerPid = $PID; exitCode = $nodeExitCode; expectedCommit = $expectedCommit; releaseId = $expectedReleaseId }
    try { Add-Content -LiteralPath $stderr -Value ($record | ConvertTo-Json -Compress) } catch { }
}
if ($null -eq $nodeExitCode) { $nodeExitCode = 1 }
exit $nodeExitCode
