param(
    [ValidateSet("Install", "Start", "Stop", "Status", "Remove")]
    [string]$Action = "Status",
    [string]$TaskName = "XhsDeviceControlPlaneV1"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = "C:\Users\Public\xhs-agent-control"
$launchConfig = Join-Path $stateRoot "task-launch.json"
$worker = Join-Path $PSScriptRoot "control-plane-worker.ps1"
$deviceConfig = Join-Path $repoRoot "config\control-plane.devices.json"

function Get-Health {
    try {
        return Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:17920/control/v1/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Write-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

if ($Action -eq "Install") {
    if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") {
        throw "Task can only be installed on DESKTOP-3I1EVHE"
    }
    if (-not (Test-Path -LiteralPath $deviceConfig)) {
        throw "Create the untracked device config first: $deviceConfig"
    }
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
    if ($nodeVersion -ne "24.11.1") { throw "Node 24.11.1 required; found $nodeVersion" }
    $gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to resolve repository commit" }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $launch = [ordered]@{
        schemaVersion = 1
        repoRoot = $repoRoot
        nodeExe = $nodeExe
        gitCommit = $gitCommit
        deviceConfig = $deviceConfig
    }
    $json = $launch | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($launchConfig, $json, (New-Object Text.UTF8Encoding($false)))

    $powershell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worker`" -LaunchConfig `"$launchConfig`""
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repoRoot
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType InteractiveToken `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Principal $principal -Settings $settings -Force | Out-Null
    Write-Result @{
        ok = $true
        action = "installed"
        taskName = $TaskName
        gitCommit = $gitCommit
        node = $nodeVersion
        autoStarted = $false
    }
    exit 0
}

if ($Action -eq "Start") {
    Start-ScheduledTask -TaskName $TaskName
    $health = $null
    for ($index = 0; $index -lt 40; $index += 1) {
        Start-Sleep -Milliseconds 250
        $health = Get-Health
        if ($null -ne $health) { break }
    }
    if ($null -eq $health) { throw "Control plane did not become healthy" }
    Write-Result @{
        ok = $true
        action = "started"
        taskName = $TaskName
        health = $health
    }
    exit 0
}

if ($Action -eq "Stop") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($index = 0; $index -lt 20; $index += 1) {
        if ($null -eq (Get-Health)) { break }
        Start-Sleep -Milliseconds 250
    }
    Write-Result @{
        ok = $true
        action = "stopped"
        taskName = $TaskName
        listening = ($null -ne (Get-Health))
    }
    exit 0
}

if ($Action -eq "Remove") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Result @{
        ok = $true
        action = "removed"
        taskName = $TaskName
    }
    exit 0
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$health = Get-Health
Write-Result @{
    ok = $true
    action = "status"
    taskName = $TaskName
    installed = ($null -ne $task)
    taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    healthy = ($null -ne $health)
    health = $health
}
