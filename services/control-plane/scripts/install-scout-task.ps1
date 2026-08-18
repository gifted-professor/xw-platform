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
$xmlPath = Join-Path $logDir "$TaskName-task.xml"

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

    # ── Build task XML directly (schtasks.exe approach) ──
    # --constraint-only: only grep-based constraint verification, no device ops
    # 3: max rounds (process up to 3 unverified constraint recipes per run)
    $q = [char]34

    # Calculate start time: 1 minute from now
    $startTime = (Get-Date).AddMinutes(1).ToString("HH:mm")
    $startDate = (Get-Date).ToString("yyyy-MM-dd")

    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Scout auto-cruise: constraint-only verification every 45min. No device ops.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT45M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$($startDate)T$($startTime)</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT2M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
      <Duration>PT0S</Duration>
      <WaitTimeout>PT0S</WaitTimeout>
    </IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$nodeExe</Command>
      <Arguments>$q$scoutScript$q --constraint-only 3</Arguments>
      <WorkingDirectory>$repoRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

    $xml | Out-File -FilePath $xmlPath -Encoding Unicode

    # ── Register via schtasks.exe (most reliable) ──
    $r = schtasks.exe /Create /TN $TaskName /XML $xmlPath /F 2>&1
    if ($LASTEXITCODE -ne 0) { throw "schtasks /create failed: $r" }

    # Verify idle settings
    $verifyXml = Join-Path $env:TEMP "$TaskName-verify.xml"
    schtasks.exe /Query /TN $TaskName /XML ONE | Out-File -FilePath $verifyXml -Encoding Unicode
    [xml]$check = Get-Content -Path $verifyXml
    $ns = New-Object System.Xml.XmlNamespaceManager($check.NameTable)
    $ns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task")
    $stopOnIdle = $check.SelectSingleNode("//t:StopOnIdleEnd", $ns)
    Remove-Item -Path $verifyXml -Force -ErrorAction SilentlyContinue

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
        stopOnIdleEnd = if ($stopOnIdle) { $stopOnIdle.InnerText } else { "not found" }
    }
    exit 0
}

if ($Action -eq "Start") {
    $r = schtasks.exe /Run /TN $TaskName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "schtasks /run failed: $r" }
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
    schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null
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
}
