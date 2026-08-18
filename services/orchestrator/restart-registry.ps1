$c = Get-NetTCPConnection -LocalPort 17930 -State Listen -ErrorAction SilentlyContinue
if ($c) {
  $p = $c.OwningProcess
  Write-Output "killing PID $p"
  Stop-Process -Id $p -Force
  Start-Sleep -Seconds 2
} else {
  Write-Output "no listener"
}
schtasks /Run /tn XhsDeviceRegistry | Out-Null
Start-Sleep -Seconds 5
$new = Get-NetTCPConnection -LocalPort 17930 -State Listen -ErrorAction SilentlyContinue
if ($new) { Write-Output ("new PID " + $new.OwningProcess) } else { Write-Output "NOT LISTENING" }
