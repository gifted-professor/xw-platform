param(
  # agent token：不再内置默认值；必须显式传入（轮换时两边一起改）
  [string]$AgentToken = "",
  # human token 是唯一能 approve/deny 的凭证；不传则 registry 跑在 LEGACY 模式（单 token 管一切）
  [string]$HumanToken = "",
  # observer token：abtop 远程只读舰队/截图，不能写不能审批；不传则不开 observer 角色
  [string]$ObserverToken = "",
  # operator token：本轮 operator 全面冻结（501）；不传则不开 operator 角色
  [string]$OperatorToken = "",
  # runs-root：cache-only Screen API 读已采集截图的根目录（=控制面 runsRoot）
  [string]$RunsRoot = "C:\Users\Public\xhs-agent-runs",
  # 调试模式：四 token 全空时显式放行（生产不要用）
  [switch]$DebugMode
)
$ErrorActionPreference = "Stop"
# 四 token 全空且未显式开 DebugMode → 拒绝安装（避免误装成开放调试模式）
if (-not $AgentToken -and -not $HumanToken -and -not $ObserverToken -and -not $OperatorToken -and -not $DebugMode) {
  throw "拒绝安装：四 token 全空会使 registry 进入开放调试模式。请传入至少一个 token，或显式指定 -DebugMode。"
}
# 角色 token 去重：鉴权按 human→agent→observer→operator 顺序匹配，任意两个非空角色 token 相同会让
# 低权限凭证被解析成更高权限角色（如 observer==human 时 observer 命中 human）。安装期即拒绝。
# 错误信息固定、不含任何 token 值/前缀/摘要，避免真实凭证进入终端、部署日志或任务记录。
$roleTokens = @($AgentToken, $HumanToken, $ObserverToken, $OperatorToken) | Where-Object { $_ }
$uniqueTokens = $roleTokens | Sort-Object -Unique
if ($roleTokens.Count -ne $uniqueTokens.Count) {
  throw "拒绝安装：存在重复的非空角色 token，会导致低权限凭证被解析成更高权限角色。请确保四个角色 token 互不相同。"
}
$taskName = "XhsDeviceRegistry"
$workDir = "C:\Users\Public\xhs-registry"
# 默认仅监听 127.0.0.1；对外通过 abtop 后端或 Tailscale Serve 暴露，不让 Observer API 默认监听 0.0.0.0
$argLine = '"' + $workDir + '\registry.mjs" --port 17930 --host 127.0.0.1 --control http://127.0.0.1:17920 --db "' + $workDir + '\registry.db"'
if ($AgentToken) { $argLine += ' --agent-token ' + $AgentToken }
if ($HumanToken) { $argLine += ' --human-token ' + $HumanToken }
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
