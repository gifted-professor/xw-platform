param(
    [ValidateSet("Install", "Start", "Stop", "Restart", "Status")]
    [string]$Action = "Status",
    [ValidateSet("01", "02", "03", "04")]
    [string]$Alias
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$deviceConfig = Join-Path $repoRoot "config\control-plane.devices.json"
$stateRoot = "C:\Users\Public\xhs-agent-control\fast-operator"
$registryRoot = "C:\Users\Public\xhs-registry"
$taskName = "XhsFastOperator${Alias}Live"
$launchConfig = Join-Path $stateRoot "serve-launch-${Alias}.json"
$worker = Join-Path $PSScriptRoot "fast-operator-serve-worker.ps1"
$wrapperPath = Join-Path $registryRoot "serve-restart-$Alias.ps1"
$lifecycleLog = Join-Path $stateRoot "lifecycle-events.jsonl"

function Write-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

function Resolve-NodeExe {
    if (-not [string]::IsNullOrWhiteSpace($env:XHS_NODE_EXE) -and (Test-Path -LiteralPath $env:XHS_NODE_EXE)) {
        return $env:XHS_NODE_EXE
    }
    $pinned = "D:\Program Files\Node\node.exe"
    if (Test-Path -LiteralPath $pinned) {
        return $pinned
    }
    return (Get-Command node -ErrorAction Stop).Source
}

function Write-LifecycleEvent([string]$Phase, [int]$ListenerPid = 0) {
    $record = [ordered]@{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        alias = $Alias
        phase = $Phase
        callerPid = $PID
    }
    if ($ListenerPid -gt 0) { $record["listenerPid"] = $ListenerPid }
    try {
        Add-Content -LiteralPath $lifecycleLog -Value ($record | ConvertTo-Json -Compress)
    } catch {
        # Audit failure must not change task lifecycle behavior.
    }
}

function Resolve-Device {
    if (-not (Test-Path -LiteralPath $deviceConfig)) {
        throw "Device config missing: $deviceConfig"
    }
    $config = Get-Content -LiteralPath $deviceConfig -Raw | ConvertFrom-Json
    $device = @($config.devices | Where-Object { [string]$_.alias -eq $Alias }) | Select-Object -First 1
    if ($null -eq $device) { throw "Unknown device alias: $Alias" }
    if ([string]::IsNullOrWhiteSpace([string]$device.runtimeId)) {
        throw "Device runtimeId missing for alias $Alias"
    }
    $port = [int]$device.metadata.xhsServePort
    if ($port -lt 1 -or $port -gt 65535) {
        throw "Invalid xhsServePort for alias $Alias"
    }
    return $device
}

function Get-Listener([int]$Port) {
    return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Wait-ForListener([int]$Port, [bool]$Expected) {
    for ($index = 0; $index -lt 40; $index += 1) {
        $present = $null -ne (Get-Listener $Port)
        if ($present -eq $Expected) { return $present }
        Start-Sleep -Milliseconds 250
    }
    return $null -ne (Get-Listener $Port)
}

function Stop-Serve([int]$Port) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $listener = Get-Listener $Port
    if ($null -ne $listener) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $commandLine = [string]$process.CommandLine
        $expectedPort = "--port $Port"
        if ($commandLine -notmatch "fast-operator\.mjs" -or
            $commandLine -notmatch "\sserve(?:\s|$)" -or
            -not $commandLine.Contains($expectedPort)) {
            throw "Refusing to stop unrelated listener on port $Port"
        }
        Stop-Process -Id $listener.OwningProcess -Force
    }
    if (Wait-ForListener $Port $false) {
        throw "FastOperator serve did not stop for alias $Alias on port $Port"
    }
}

$device = Resolve-Device
$servePort = [int]$device.metadata.xhsServePort

if ($Action -eq "Install") {
    if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") {
        throw "Task can only be installed on DESKTOP-3I1EVHE"
    }
    if (-not (Test-Path -LiteralPath $worker)) { throw "Worker missing: $worker" }

    $nodeExe = Resolve-NodeExe
    $nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
    if ($nodeVersion -ne "24.11.1") { throw "Node 24.11.1 required; found $nodeVersion" }
    $gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to resolve repository commit" }

    New-Item -ItemType Directory -Force -Path $stateRoot, $registryRoot | Out-Null
    $launch = [ordered]@{
        schemaVersion = 1
        repoRoot = $repoRoot
        nodeExe = $nodeExe
        gitCommit = $gitCommit
        deviceConfig = $deviceConfig
        alias = $Alias
    }
    $launchJson = ($launch | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    $launchTemp = "$launchConfig.tmp-$PID"
    [IO.File]::WriteAllText($launchTemp, $launchJson, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $launchTemp -Destination $launchConfig -Force

    $powershell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worker`" -LaunchConfig `"$launchConfig`""
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repoRoot
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal $principal -Settings $settings -Force | Out-Null

    $taskScript = $PSCommandPath
    $wrapperContent = @"
param()
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$taskScript`" -Action Restart -Alias `"$Alias`"
exit `$LASTEXITCODE
"@
    $wrapperTemp = "$wrapperPath.tmp-$PID"
    [IO.File]::WriteAllText($wrapperTemp, $wrapperContent, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $wrapperTemp -Destination $wrapperPath -Force

    Write-Result @{
        ok = $true
        action = "installed"
        alias = $Alias
        taskName = $taskName
        gitCommit = $gitCommit
        port = $servePort
        autoStarted = $false
    }
    exit 0
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Action -eq "Start" -or $Action -eq "Restart") {
    if ($null -eq $task) { throw "Task not installed: $taskName" }
    if ($Action -eq "Restart") {
        $listener = Get-Listener $servePort
        Write-LifecycleEvent -Phase "task-restart-request" -ListenerPid $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
        Stop-Serve $servePort
        Write-LifecycleEvent -Phase "task-stopped"
    } elseif ($null -ne (Get-Listener $servePort)) {
        throw "Port already occupied; use Restart for alias $Alias"
    } else {
        Write-LifecycleEvent -Phase "task-start-request"
    }
    Start-ScheduledTask -TaskName $taskName
    if (-not (Wait-ForListener $servePort $true)) {
        throw "FastOperator serve did not listen for alias $Alias on port $servePort"
    }
    $listener = Get-Listener $servePort
    Write-LifecycleEvent -Phase "task-started" -ListenerPid $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
    Write-Result @{
        ok = $true
        action = $Action.ToLowerInvariant()
        alias = $Alias
        taskName = $taskName
        port = $servePort
        listening = $true
    }
    exit 0
}

if ($Action -eq "Stop") {
    $listener = Get-Listener $servePort
    Write-LifecycleEvent -Phase "task-stop-request" -ListenerPid $(if ($null -ne $listener) { $listener.OwningProcess } else { 0 })
    Stop-Serve $servePort
    $listening = $null -ne (Get-Listener $servePort)
    if (-not $listening) { Write-LifecycleEvent -Phase "task-stopped" }
    Write-Result @{
        ok = -not $listening
        action = "stopped"
        alias = $Alias
        taskName = $taskName
        port = $servePort
        listening = $listening
    }
    exit $(if ($listening) { 1 } else { 0 })
}

$listening = $null -ne (Get-Listener $servePort)
Write-Result @{
    ok = $true
    action = "status"
    alias = $Alias
    taskName = $taskName
    installed = $null -ne $task
    taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    port = $servePort
    listening = $listening
}
