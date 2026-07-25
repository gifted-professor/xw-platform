<#
.SYNOPSIS
  install-scout-task.ps1 — Register the XhsScoutScout scheduled task

.DESCRIPTION
  Registers a Windows scheduled task that runs scout.mjs in --constraint-only
  mode every 45 minutes. This mode only does grep-based constraint verification
  against the local codebase — no device interaction, no job submission, no
  approval calls.

  StopOnIdleEnd is explicitly disabled (lesson from infra pitfall: idle-stop
  kills long-running services prematurely).

.PARAMETER Action
  Install | Start | Stop | Status | Remove

.EXAMPLE
  .\scripts\install-scout-task.ps1 -Action Install
  .\scripts\install-scout-task.ps1 -Action Status
  .\scripts\install-scout-task.ps1 -Action Remove
#>

param(
    [ValidateSet("Install", "Start", "Stop", "Status", "Remove")]
    [string]$Action = "Status",
    [string]$TaskName = "XhsScoutScout"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot "data\scout-logs"

function Write-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

if ($Action -eq "Install") {
    # ── Pre-flight checks ──
    if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") {
        throw "Task can only be installed on DESKTOP-3I1EVHE"
    }
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
    if ($nodeVersion -ne "24.11.1") { throw "Node 24.11.1 required; found $nodeVersion" }

    $scoutScript = Join-Path $repoRoot "scout\scout.mjs"
    if (-not (Test-Path -LiteralPath $scoutScript)) {
        throw "scout.mjs not found: $scoutScript"
    }

    # ── Ensure log directory ──
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    # ── Build task action ──
    # --constraint-only: only grep-based constraint verification, no device ops
    # --dry-run: first run is observation-only (no knowledge writes)
    $nodeArgs = "`"$scoutScript`" --constraint-only 3"
    $taskAction = New-ScheduledTaskAction `
        -Execute $nodeExe `
        -Argument $nodeArgs `
        -WorkingDirectory $repoRoot

    # ── Trigger: every 45 minutes, starting now ──
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 45) -RepetitionDuration ([TimeSpan]::MaxValue)

    # ── Principal: current user, limited privileges ──
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited

    # ── Settings: CRITICAL — StopOnIdleEnd must be false ──
    # Lesson from infra pitfall: StopOnIdleEnd kills services prematurely
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 2) `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    # Explicitly disable idle-stop (belt-and-suspenders)
    $settings.StopOnIdleEnd = $false
    $settings.DisallowStartOnIdle = $false

    # ── Register ──
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $taskAction `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Scout auto-cruise: constraint-only verification every 45min. No device ops." `
        -Force | Out-Null

    Write-Result @{
        ok = $true
        action = "installed"
        taskName = $TaskName
        mode = "constraint-only"
        interval = "45min"
        nodeExe = $nodeExe
        nodeVersion = $nodeVersion
        repoRoot = $repoRoot
        logDir = $logDir
        stopOnIdleEnd = $false
    }
    exit 0
}

if ($Action -eq "Start") {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Result @{
        ok = $true
        action = "started"
        taskName = $TaskName
        taskState = if ($null -ne $task) { [string]$task.State } else { "Unknown" }
    }
    exit 0
}

if ($Action -eq "Stop") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Result @{
        ok = $true
        action = "stopped"
        taskName = $TaskName
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

# ── Status ──
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = $null
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
}
Write-Result @{
    ok = $true
    action = "status"
    taskName = $TaskName
    installed = ($null -ne $task)
    taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    lastRun = if ($info) { [string]$info.LastRunTime } else { $null }
    lastResult = if ($info) { [string]$info.LastTaskResult } else { $null }
    nextRun = if ($info) { [string]$info.NextRunTime } else { $null }
    stopOnIdleEnd = if ($task) { [string]$task.Settings.StopOnIdleEnd } else { $null }
}
