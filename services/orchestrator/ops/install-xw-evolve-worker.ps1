# install-xw-evolve-worker.ps1 — register XhsXwEvolveWorker (every 30 minutes)
#
# Default: dry-run — print what would be registered; do NOT call Register-ScheduledTask.
# To actually register: set INSTALL_EVOLVE_WORKER=1 (or pass -Install).
#
# Does not touch devices / control plane. Worker itself never auto-submits jobs.

param(
  [switch]$Install,
  [string]$WorkDir = "C:\Users\Public\xhs-registry",
  [string]$TaskName = "XhsXwEvolveWorker",
  [string]$NodeExe = "node.exe",
  [int]$IntervalMinutes = 30
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $WorkDir "ops\xw-evolve-worker.mjs"
$dbPath = Join-Path $WorkDir "registry.db"
$argLine = '"' + $scriptPath + '" --db "' + $dbPath + '"'

$shouldInstall = $Install -or ($env:INSTALL_EVOLVE_WORKER -eq "1")

Write-Output "=== XhsXwEvolveWorker install plan ==="
Write-Output ("taskName:          " + $TaskName)
Write-Output ("workDir:           " + $WorkDir)
Write-Output ("script:            " + $scriptPath)
Write-Output ("execute:           " + $NodeExe)
Write-Output ("arguments:         " + $argLine)
Write-Output ("intervalMinutes:   " + $IntervalMinutes)
Write-Output ("INSTALL_EVOLVE_WORKER: " + $env:INSTALL_EVOLVE_WORKER)
Write-Output ("willRegister:      " + $shouldInstall)

if (-not $shouldInstall) {
  Write-Output ""
  Write-Output "Dry-run only. Re-run with INSTALL_EVOLVE_WORKER=1 or -Install to register."
  Write-Output "Example:"
  Write-Output '  $env:INSTALL_EVOLVE_WORKER=1; powershell -File ops\install-xw-evolve-worker.ps1'
  exit 0
}

if (-not (Test-Path $scriptPath)) {
  throw "Worker script not found: $scriptPath"
}

$action = New-ScheduledTaskAction -Execute $NodeExe -Argument $argLine -WorkingDirectory $WorkDir
# Repeating trigger: first fire in ~1 minute, then every IntervalMinutes.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
} catch {
  # Fallback: Interactive failed — try S4U (needs batch logon right)
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType S4U `
    -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

$task = Get-ScheduledTask -TaskName $TaskName
Write-Output ("registered:        " + $task.TaskName)
Write-Output ("task state:        " + $task.State)
Write-Output ("ok")
