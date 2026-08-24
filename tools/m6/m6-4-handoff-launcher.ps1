#requires -Version 7.2
[CmdletBinding(DefaultParameterSetName = 'Send')]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^xw-m6-4-handoff-[a-z0-9-]{8,80}$')][string]$PipeName,
  [Parameter(Mandatory = $true, ParameterSetName = 'Start')][string]$HostConfigPath,
  [Parameter(Mandatory = $true, ParameterSetName = 'Start')][switch]$StartElevatedHost,
  [Parameter(Mandatory = $true, ParameterSetName = 'Send')][string]$RequestPath,
  [Parameter(ParameterSetName = 'Send')][ValidateRange(1000, 120000)][int]$TimeoutMs = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($StartElevatedHost) {
  $hostScript = Join-Path $PSScriptRoot 'm6-4-handoff-host.ps1'
  $resolvedConfig = (Resolve-Path -LiteralPath $HostConfigPath).Path
  $quotedHost = '"' + $hostScript.Replace('"', '\"') + '"'
  $quotedConfig = '"' + $resolvedConfig.Replace('"', '\"') + '"'
  $arguments = "-NoProfile -NonInteractive -File $quotedHost -PipeName $PipeName -ConfigPath $quotedConfig"
  Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden | Out-Null
  [ordered]@{ ok = $true; status = 'HOST_START_REQUESTED'; pipeName = $PipeName; actionCount = 0 } | ConvertTo-Json -Compress
  exit 0
}

$requestItem = Get-Item -LiteralPath $RequestPath -Force
if (-not ($requestItem -is [IO.FileInfo]) -or $requestItem.Length -lt 2 -or $requestItem.Length -gt 262144 -or
    (($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'bounded plain request file required' }
$requestText = Get-Content -LiteralPath $requestItem.FullName -Raw -Encoding UTF8
try { $request = $requestText | ConvertFrom-Json -Depth 20 } catch { throw 'request file is not JSON' }
if ($request.schemaId -cne 'xw.m6-4-handoff-host-request.v1') { throw 'request schema is not allowlisted' }
$canonicalRequest = $request | ConvertTo-Json -Compress -Depth 20

$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
try {
  $pipe.Connect($TimeoutMs)
  $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
  $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
  try {
    $writer.WriteLine($canonicalRequest)
    $writer.Flush()
    $responseTask = $reader.ReadLineAsync()
    if (-not $responseTask.Wait($TimeoutMs)) { throw 'bounded handoff response timed out' }
    $response = $responseTask.Result
    if ($null -eq $response -or [Text.Encoding]::UTF8.GetByteCount($response) -gt 16384) { throw 'bounded handoff response invalid' }
    $response
  } finally {
    $writer.Dispose()
    $reader.Dispose()
  }
} finally {
  $pipe.Dispose()
}
