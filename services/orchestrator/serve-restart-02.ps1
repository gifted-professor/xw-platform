param()
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\Public\xw-fusion\xw-platform\services\control-plane\scripts\fast-operator-serve-task.ps1" -Action Restart -Alias "02"
exit $LASTEXITCODE
