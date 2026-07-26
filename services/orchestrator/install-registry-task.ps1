param(
  # agent token 保持旧值 = sync-feishu / 现有 agent 零改动；轮换时两边一起改
  [string]$AgentToken = "REDACTED_OLD_AGENT_TOKEN",
  # human token 是唯一能 approve/deny 的凭证；不传则 registry 跑在 LEGACY 模式（单 token 管一切）
  [string]$HumanToken = ""
)
$ErrorActionPreference = "Stop"
$taskName = "XhsDeviceRegistry"
$workDir = "C:\Users\Public\xhs-registry"
$argLine = '"' + $workDir + '\registry.mjs" --port 17930 --host 0.0.0.0 --control http://127.0.0.1:17920 --db "' + $workDir + '\registry.db" --agent-token ' + $AgentToken
if ($HumanToken) { $argLine += ' --human-token ' + $HumanToken }
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
