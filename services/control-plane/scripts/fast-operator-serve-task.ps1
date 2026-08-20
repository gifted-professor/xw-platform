param(
    [ValidateSet("Install", "Start", "Stop", "Restart", "Status")]
    [string]$Action = "Status",
    [ValidateSet("01", "02", "03", "04")]
    [string]$Alias,
    [string]$RuntimeRoot = "C:\Users\Public\xw-runtime"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$taskName = "XW Platform FastOperator $Alias"
$stateRoot = Join-Path $RuntimeRoot "state\control-plane\fast-operator"
$logRoot = Join-Path $RuntimeRoot "logs\fast-operator"
$launchConfig = Join-Path $stateRoot "serve-launch-$Alias.json"
$runtimeLauncher = Join-Path $RuntimeRoot "launch-fast-operator-serve.ps1"
$launcherTemplate = Join-Path $PSScriptRoot "xw-fast-operator-runtime.ps1"
$deviceConfig = Join-Path $RuntimeRoot "secrets\control-plane.devices.json"
$lifecycleLog = Join-Path $logRoot "lifecycle-events.jsonl"

function Write-Result([hashtable]$Value) { $Value | ConvertTo-Json -Depth 8 -Compress }

function Resolve-NodeExe {
    if (-not [string]::IsNullOrWhiteSpace($env:XHS_NODE_EXE) -and (Test-Path -LiteralPath $env:XHS_NODE_EXE)) {
        return $env:XHS_NODE_EXE
    }
    $pinned = "D:\Program Files\Node\node.exe"
    if (Test-Path -LiteralPath $pinned) { return $pinned }
    return (Get-Command node -ErrorAction Stop).Source
}

function Resolve-Release {
    $current = Join-Path $RuntimeRoot "current"
    if (-not (Test-Path -LiteralPath $current)) { throw "Runtime current junction missing: $current" }
    $releaseRoot = [string](Get-Item -LiteralPath $current).Target
    if ([string]::IsNullOrWhiteSpace($releaseRoot)) { throw "Runtime current junction unresolved: $current" }
    $releaseRoot = [IO.Path]::GetFullPath($releaseRoot)
    $releasesRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot "releases"))
    if (-not $releaseRoot.StartsWith($releasesRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime current target escapes releases root: $releaseRoot"
    }
    $manifestPath = Join-Path $releaseRoot "release-manifest.v1.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Release manifest missing: $manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.runtimeProfile -ne "legacy_compat") { throw "Unsupported runtime profile: $($manifest.runtimeProfile)" }
    if ([string]$manifest.sourceCommit -notmatch '^[0-9a-f]{40}$') { throw "Invalid release sourceCommit" }
    return @{ root = $releaseRoot; manifest = $manifest }
}

function Resolve-Device {
    if (-not (Test-Path -LiteralPath $deviceConfig)) { throw "Device config missing: $deviceConfig" }
    $config = Get-Content -LiteralPath $deviceConfig -Raw | ConvertFrom-Json
    $device = @($config.devices | Where-Object { [string]$_.alias -eq $Alias }) | Select-Object -First 1
    if ($null -eq $device) { throw "Unknown device alias: $Alias" }
    if ([string]::IsNullOrWhiteSpace([string]$device.runtimeId)) { throw "Device runtimeId missing for alias $Alias" }
    $port = [int]$device.metadata.xhsServePort
    if ($port -lt 1 -or $port -gt 65535) { throw "Invalid xhsServePort for alias $Alias" }
    return $device
}

function Get-Listener([int]$Port) {
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Wait-ForListener([int]$Port, [bool]$Expected) {
    for ($index = 0; $index -lt 40; $index += 1) {
        $present = $null -ne (Get-Listener $Port)
        if ($present -eq $Expected) { return $present }
        Start-Sleep -Milliseconds 250
    }
    return $null -ne (Get-Listener $Port)
}

function Write-LifecycleEvent([string]$Phase, [int]$ListenerPid = 0) {
    $record = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString("o"); alias = $Alias; phase = $Phase; callerPid = $PID }
    if ($ListenerPid -gt 0) { $record["listenerPid"] = $ListenerPid }
    try { Add-Content -LiteralPath $lifecycleLog -Value ($record | ConvertTo-Json -Compress) } catch { }
}

function Stop-Serve([int]$Port) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $listener = Get-Listener $Port
    if ($null -ne $listener) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $commandLine = [string]$process.CommandLine
        if ($commandLine -notmatch "fast-operator\.mjs" -or $commandLine -notmatch "\sserve(?:\s|$)" -or -not $commandLine.Contains("--port $Port")) {
            throw "Refusing to stop unrelated listener on port $Port"
        }
        Stop-Process -Id $listener.OwningProcess -Force
    }
    if (Wait-ForListener $Port $false) { throw "FastOperator serve did not stop for alias $Alias on port $Port" }
}

$release = Resolve-Release
$device = Resolve-Device
$servePort = [int]$device.metadata.xhsServePort

if ($Action -eq "Install") {
    if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") { throw "Task can only be installed on DESKTOP-3I1EVHE" }
    if (-not (Test-Path -LiteralPath $launcherTemplate)) { throw "Runtime launcher template missing: $launcherTemplate" }
    $nodeExe = Resolve-NodeExe
    $nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
    if ($nodeVersion -ne [string]$release.manifest.nodeVersion) { throw "Node $($release.manifest.nodeVersion) required; found $nodeVersion" }

    New-Item -ItemType Directory -Force -Path $stateRoot, $logRoot | Out-Null
    Copy-Item -LiteralPath $launcherTemplate -Destination $runtimeLauncher -Force
    $launch = [ordered]@{
        schemaVersion = 2
        runtimeRoot = $RuntimeRoot
        nodeExe = $nodeExe
        releaseId = [string]$release.manifest.releaseId
        sourceCommit = [string]$release.manifest.sourceCommit
        deviceConfig = $deviceConfig
        alias = $Alias
    }
    $launchTemp = "$launchConfig.tmp-$PID"
    [IO.File]::WriteAllText($launchTemp, (($launch | ConvertTo-Json -Depth 5) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $launchTemp -Destination $launchConfig -Force

    $powershell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runtimeLauncher`" -LaunchConfig `"$launchConfig`""
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $RuntimeRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Result @{ ok = $true; action = "installed"; alias = $Alias; taskName = $taskName; sourceCommit = $launch.sourceCommit; releaseId = $launch.releaseId; port = $servePort; autoStarted = $false }
    exit 0
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($Action -eq "Start" -or $Action -eq "Restart") {
    if ($null -eq $task) { throw "Task not installed: $taskName. Register the XW serve task first." }
    if ($Action -eq "Restart") {
        $listener = Get-Listener $servePort
        Write-LifecycleEvent "task-restart-request" $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
        Stop-Serve $servePort
        Write-LifecycleEvent "task-stopped"
    } elseif ($null -ne (Get-Listener $servePort)) { throw "Port already occupied; use Restart for alias $Alias" }
    else { Write-LifecycleEvent "task-start-request" }
    Start-ScheduledTask -TaskName $taskName
    if (-not (Wait-ForListener $servePort $true)) { throw "FastOperator serve did not listen for alias $Alias on port $servePort" }
    $listener = Get-Listener $servePort
    Write-LifecycleEvent "task-started" $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
    Write-Result @{ ok = $true; action = $Action.ToLowerInvariant(); alias = $Alias; taskName = $taskName; port = $servePort; listening = $true }
    exit 0
}

if ($Action -eq "Stop") {
    $listener = Get-Listener $servePort
    Write-LifecycleEvent "task-stop-request" $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
    Stop-Serve $servePort
    $listening = $null -ne (Get-Listener $servePort)
    if (-not $listening) { Write-LifecycleEvent "task-stopped" }
    Write-Result @{ ok = -not $listening; action = "stopped"; alias = $Alias; taskName = $taskName; port = $servePort; listening = $listening }
    exit $(if ($listening) { 1 } else { 0 })
}

$launch = $null
try { $launch = Get-Content -LiteralPath $launchConfig -Raw | ConvertFrom-Json } catch { }
Write-Result @{
    ok = $true; action = "status"; alias = $Alias; taskName = $taskName
    installed = $null -ne $task
    taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    port = $servePort; listening = $null -ne (Get-Listener $servePort)
    sourceCommit = if ($null -ne $launch) { [string]$launch.sourceCommit } else { $null }
    releaseId = if ($null -ne $launch) { [string]$launch.releaseId } else { $null }
}
