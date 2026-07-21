<#
.SYNOPSIS
  xhs-watcher-launch.ps1 — Register and run a one-shot Task Scheduler job via XML

.PARAMETER runId   Must match: run-YYYYMMDD-HHMMSS-xxxxxxxx (8 hex)
.PARAMETER agentId Must match: agent-run-YYYYMMDD-HHMMSS-xxxxxxxx (8 hex)
.PARAMETER statusOnly  Read-only mode
.PARAMETER execute  Full lifecycle mode; required explicitly
#>

param(
    [Parameter(Mandatory=$true)] [string]$runId,
    [Parameter(Mandatory=$true)] [string]$agentId,
    [switch]$statusOnly,
    [switch]$execute
)
$ErrorActionPreference = "Stop"

# ── Validate IDs ──
if ($runId -notmatch '^run-\d{8}-\d{6}-[0-9a-f]{8}$') { Write-Error "Invalid runId: $runId"; exit 1 }
if ($agentId -notmatch '^agent-run-\d{8}-\d{6}-[0-9a-f]{8}$') { Write-Error "Invalid agentId: $agentId"; exit 1 }
if ([bool]$statusOnly -eq [bool]$execute) { Write-Error "Choose exactly one mode: -statusOnly or -execute"; exit 1 }

# ── Paths ──
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watcherPath = Join-Path $repo 'scripts\xhs-watcher.mjs'
$taskName = "XHS-Watcher-$runId"
$runDir = 'C:\Users\Public\xhs-agent-runs'
$statePath = Join-Path $runDir "$runId.json"
$logPath = Join-Path $runDir "$runId.log"
$xmlPath = Join-Path $runDir "$runId-task.xml"

if (-not (Test-Path $watcherPath)) { Write-Error "Watcher not found: $watcherPath"; exit 1 }

# ── Refuse duplicate run IDs ──
# A runId is a single-use identity. Reusing it can launch the same task twice,
# append to an old log, or overwrite an earlier run-state file.
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$existingArtifacts = @($statePath, $logPath, $xmlPath) | Where-Object { Test-Path -LiteralPath $_ }
if ($existingTask -or $existingArtifacts.Count -gt 0) {
    $found = @()
    if ($existingTask) { $found += "task:$taskName" }
    $found += $existingArtifacts
    Write-Error "runId already exists; generate a new runId. Found: $($found -join ', ')"
    exit 1
}

# ── Find node.exe absolute path ──
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Error "node.exe not found in PATH"; exit 1 }

# ── Build arguments (watcher handles its own logging) ──
$q = [char]34
$nodeArgs = "$q$watcherPath$q --runId $q$runId$q --agentId $q$agentId$q"
if ($statusOnly) { $nodeArgs += " --status-only" }

# ── Build an on-demand task XML ──
# Do not add a TimeTrigger here. The launcher starts the task exactly once via
# schtasks /Run below; combining both mechanisms causes duplicate execution.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>XHS watcher runId=$runId</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$nodeExe</Command>
      <Arguments>$nodeArgs</Arguments>
      <WorkingDirectory>$repo</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$xml | Out-File -FilePath $xmlPath -Encoding Unicode

# ── Register and run ──
$r = schtasks.exe /Create /TN $taskName /XML $xmlPath 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /create failed: $r"; exit 1 }

$r2 = schtasks.exe /Run /TN $taskName 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /run failed: $r2"; exit 1 }

# ── Output ──
[ordered]@{
    ok = $true
    taskName = $taskName
    runId = $runId
    agentId = $agentId
    statusOnly = [bool]$statusOnly
    execute = [bool]$execute
    mode = if ($statusOnly) { "status-only" } else { "full-lifecycle" }
    launchMode = "on-demand"
    nodeExe = $nodeExe
} | ConvertTo-Json -Compress
