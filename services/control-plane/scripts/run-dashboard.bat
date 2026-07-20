@echo off
:: dashboard detached 启动器。日志落 scripts/logs/dashboard.log
:: 经 WMI Win32_Process.Create("cmd /c <本文件>") 起 truly-detached(随 ssh 存活)
cd /d "%~dp0"
if not exist logs mkdir logs
"D:\Program Files\Node\node.exe" "%~dp0dashboard.mjs" > "%~dp0logs\dashboard.log" 2>&1