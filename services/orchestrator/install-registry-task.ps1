param(
  # Prefer .env (XHS_AGENT_TOKEN / XHS_HUMAN_TOKEN / …). CLI flags override .env when non-empty.
  [string]$AgentToken = "",
  [string]$HumanToken = "",
  [string]$ObserverToken = "",
  [string]$OperatorToken = "",
  [string]$HumanActor = "",
  [string]$RunsRoot = ""
)
$ErrorActionPreference = "Stop"
$taskName = "XhsDeviceRegistry"
$workDir = "C:\Users\Public\xhs-registry"

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -le 0) { return }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

Import-DotEnv (Join-Path $workDir ".env")

if (-not $AgentToken) { $AgentToken = $env:XHS_AGENT_TOKEN }
if (-not $HumanToken) { $HumanToken = $env:XHS_HUMAN_TOKEN }
if (-not $ObserverToken) { $ObserverToken = $env:XHS_OBSERVER_TOKEN }
if (-not $OperatorToken) { $OperatorToken = $env:XHS_OPERATOR_TOKEN }
if (-not $HumanActor) { $HumanActor = $env:XHS_HUMAN_ACTOR }
if (-not $RunsRoot) { $RunsRoot = $env:XHS_RUNS_ROOT }

if ([string]::IsNullOrWhiteSpace($AgentToken)) {
  throw "XHS_AGENT_TOKEN missing. Copy .env.example to .env (or pass -AgentToken). Never commit real tokens."
}

$argLine = '"' + $workDir + '\registry.mjs" --port 17930 --host 0.0.0.0 --control http://127.0.0.1:17920 --db "' + $workDir + '\registry.db" --agent-token ' + $AgentToken
if ($HumanToken) {
  $argLine += ' --human-token ' + $HumanToken
  if ($HumanActor) { $argLine += ' --human-actor ' + $HumanActor }
}
if ($ObserverToken) { $argLine += ' --observer-token ' + $ObserverToken }
if ($OperatorToken) { $argLine += ' --operator-token ' + $OperatorToken }
if ($RunsRoot) { $argLine += ' --runs-root "' + $RunsRoot + '"' }

$action = New-ScheduledTaskAction -Execute "node.exe" -Argument $argLine -WorkingDirectory $workDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
# AtStartup 触发器：没有它任务只能手动 Start，重启后 17930 不会自动拉起
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U 需要「作为批处理作业登录」权限；若装完 State 不是 Running，把 -LogonType S4U 换成 Interactive 重跑
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
Write-Output ("task state: " + $task.State)
Write-Output ("stop on idle end: " + $task.Settings.IdleSettings.StopOnIdleEnd)
Write-Output ("triggers: " + ($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ",")
Write-Output "tokens: loaded from .env / flags (values not printed)"
