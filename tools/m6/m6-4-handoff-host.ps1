#requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^xw-m6-4-handoff-[a-z0-9-]{8,80}$')][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [ValidateRange(1, 10000)][int]$MaxRequests = 4096,
  [switch]$ValidateConfigOnly,
  [string]$ValidateRequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:HashPattern = '^[0-9a-f]{64}$'
$script:RoleNames = @('observation', 'process-inventory', 'normal-close')
$script:OperationNames = @('READY', 'DRY', 'RUN_ONCE', 'STOP')
$script:WorkerNames = @{
  observation = 'm6-4-independent-observation-worker.mjs'
  'process-inventory' = 'm6-4-process-inventory-worker.mjs'
  'normal-close' = 'm6-4-normal-close-bundle-worker.mjs'
}

function Fail([string]$Code, [string]$Message) {
  $exception = [InvalidOperationException]::new($Message)
  $exception.Data['Code'] = $Code
  throw $exception
}

function Test-ExactKeys($Object, [string[]]$Keys) {
  if ($null -eq $Object) { return $false }
  $actual = @($Object.PSObject.Properties.Name | Sort-Object)
  $expected = @($Keys | Sort-Object)
  return (($actual -join "`n") -ceq ($expected -join "`n"))
}

function Resolve-PlainFile([string]$Path, [string]$Label) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { Fail 'M64_HANDOFF_PATH_INVALID' "$Label must be absolute" }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not ($item -is [IO.FileInfo]) -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail 'M64_HANDOFF_PATH_INVALID' "$Label must be a non-reparse-point file"
  }
  return $item.FullName
}

function Resolve-Directory([string]$Path, [string]$Label) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { Fail 'M64_HANDOFF_PATH_INVALID' "$Label must be absolute" }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not ($item -is [IO.DirectoryInfo]) -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Fail 'M64_HANDOFF_PATH_INVALID' "$Label must be a non-reparse-point directory"
  }
  return $item.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Test-Descendant([string]$Path, [string]$Root) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  return $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-BoundedJsonFile([string]$Path, [string]$Label, [int]$MaxBytes = 2097152) {
  $plain = Resolve-PlainFile $Path $Label
  $size = (Get-Item -LiteralPath $plain).Length
  if ($size -lt 2 -or $size -gt $MaxBytes) { Fail 'M64_HANDOFF_FILE_BOUNDS_INVALID' "$Label is outside its byte bound" }
  try { return Get-Content -LiteralPath $plain -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100 } catch {
    Fail 'M64_HANDOFF_JSON_INVALID' "$Label is not valid JSON"
  }
}

function Read-Descriptor($Descriptor, [string]$Label, [string]$AllowedRoot) {
  if (-not (Test-ExactKeys $Descriptor @('path', 'sha256'))) { Fail 'M64_HANDOFF_DESCRIPTOR_INVALID' "$Label descriptor must be exact" }
  if ($Descriptor.sha256 -cnotmatch $script:HashPattern) { Fail 'M64_HANDOFF_DESCRIPTOR_INVALID' "$Label hash is invalid" }
  $path = Resolve-PlainFile ([string]$Descriptor.path) $Label
  if (-not (Test-Descendant $path $AllowedRoot)) { Fail 'M64_HANDOFF_DESCRIPTOR_ESCAPE' "$Label escaped its allowlisted root" }
  if ((Get-Sha256 $path) -cne $Descriptor.sha256) { Fail 'M64_HANDOFF_DESCRIPTOR_HASH_MISMATCH' "$Label bytes do not match the bound hash" }
  return [pscustomobject]@{ path = $path; sha256 = [string]$Descriptor.sha256 }
}

function Read-HostConfig([string]$Path) {
  $config = Read-BoundedJsonFile $Path 'handoff host config' 262144
  if (-not (Test-ExactKeys $config @('schemaId', 'nodePath', 'repositoryRoot', 'maxRequestBytes', 'requestTimeoutMs', 'roles')) -or
      $config.schemaId -cne 'xw.m6-4-handoff-host-config.v1') {
    Fail 'M64_HANDOFF_CONFIG_INVALID' 'host config has an unknown or non-exact schema'
  }
  if ($config.maxRequestBytes -isnot [long] -or $config.maxRequestBytes -lt 256 -or $config.maxRequestBytes -gt 262144 -or
      $config.requestTimeoutMs -isnot [long] -or $config.requestTimeoutMs -lt 1000 -or $config.requestTimeoutMs -gt 120000) {
    Fail 'M64_HANDOFF_CONFIG_INVALID' 'host bounds are invalid'
  }
  if (-not (Test-ExactKeys $config.roles $script:RoleNames)) { Fail 'M64_HANDOFF_CONFIG_INVALID' 'host roles must be exact' }
  $repositoryRoot = Resolve-Directory ([string]$config.repositoryRoot) 'repository root'
  $nodePath = Resolve-PlainFile ([string]$config.nodePath) 'Node runtime'
  if ([IO.Path]::GetFileName($nodePath) -cnotin @('node.exe', 'node')) { Fail 'M64_HANDOFF_CONFIG_INVALID' 'runtime must be Node' }

  $roleKeys = @{
    observation = @('workerPath', 'privateKeyPath', 'policyDescriptor', 'releaseRoot', 'ticketInboxRoot', 'controlPlaneUrl')
    'process-inventory' = @('workerPath', 'privateKeyPath', 'policyPath', 'dbPath', 'requestInboxRoot', 'responseRoot')
    'normal-close' = @('workerPath', 'privateKeyPath', 'gateKeyId', 'gateSubject', 'gateAllowlistVersion', 'requestInboxRoot', 'windowInboxRoot', 'outputRoot')
  }
  foreach ($role in $script:RoleNames) {
    $entry = $config.roles.$role
    if (-not (Test-ExactKeys $entry $roleKeys[$role])) { Fail 'M64_HANDOFF_CONFIG_INVALID' "$role config must be exact" }
    $entry.workerPath = Resolve-PlainFile ([string]$entry.workerPath) "$role worker"
    if (-not (Test-Descendant $entry.workerPath $repositoryRoot) -or [IO.Path]::GetFileName($entry.workerPath) -cne $script:WorkerNames[$role]) {
      Fail 'M64_HANDOFF_WORKER_NOT_ALLOWLISTED' "$role worker is outside the frozen allowlist"
    }
    $entry.privateKeyPath = Resolve-PlainFile ([string]$entry.privateKeyPath) "$role private key"
  }
  $config.roles.observation.releaseRoot = Resolve-Directory $config.roles.observation.releaseRoot 'observation release root'
  $config.roles.observation.ticketInboxRoot = Resolve-Directory $config.roles.observation.ticketInboxRoot 'observation ticket inbox'
  try { $controlPlaneUri = [Uri]::new([string]$config.roles.observation.controlPlaneUrl, [UriKind]::Absolute) } catch {
    Fail 'M64_HANDOFF_CONFIG_INVALID' 'observation Control Plane URL is invalid'
  }
  if ($controlPlaneUri.Scheme -cnotin @('http', 'https') -or -not [string]::IsNullOrEmpty($controlPlaneUri.UserInfo) -or
      $controlPlaneUri.AbsolutePath -cne '/' -or -not [string]::IsNullOrEmpty($controlPlaneUri.Query) -or -not [string]::IsNullOrEmpty($controlPlaneUri.Fragment)) {
    Fail 'M64_HANDOFF_CONFIG_INVALID' 'observation Control Plane URL must be one credential-free origin'
  }
  if ($controlPlaneUri.Host -cnotin @('127.0.0.1', 'localhost', '[::1]')) {
    Fail 'M64_HANDOFF_CONFIG_INVALID' 'observation Control Plane origin must be loopback'
  }
  if ($config.roles.observation.policyDescriptor -cnotmatch '^(?<path>.+)@(?<hash>[0-9a-f]{64})$') { Fail 'M64_HANDOFF_CONFIG_INVALID' 'observation policy descriptor is invalid' }
  $policyPath = Resolve-PlainFile $Matches.path 'observation policy'
  if ((Get-Sha256 $policyPath) -cne $Matches.hash) { Fail 'M64_HANDOFF_DESCRIPTOR_HASH_MISMATCH' 'observation policy changed' }

  $config.roles.'process-inventory'.policyPath = Resolve-PlainFile $config.roles.'process-inventory'.policyPath 'process policy'
  $config.roles.'process-inventory'.dbPath = Resolve-PlainFile $config.roles.'process-inventory'.dbPath 'Control DB'
  $config.roles.'process-inventory'.requestInboxRoot = Resolve-Directory $config.roles.'process-inventory'.requestInboxRoot 'process request inbox'
  $config.roles.'process-inventory'.responseRoot = Resolve-Directory $config.roles.'process-inventory'.responseRoot 'process response root'

  $close = $config.roles.'normal-close'
  if ([string]::IsNullOrWhiteSpace($close.gateKeyId) -or [string]::IsNullOrWhiteSpace($close.gateSubject) -or
      $close.gateAllowlistVersion -isnot [long] -or $close.gateAllowlistVersion -lt 1) { Fail 'M64_HANDOFF_CONFIG_INVALID' 'normal-close identity is invalid' }
  $close.requestInboxRoot = Resolve-Directory $close.requestInboxRoot 'normal-close request inbox'
  $close.windowInboxRoot = Resolve-Directory $close.windowInboxRoot 'normal-close window inbox'
  $close.outputRoot = Resolve-Directory $close.outputRoot 'normal-close output root'
  return $config
}

function Test-RequestEnvelope($Request) {
  if ($null -eq $Request -or $Request.operation -cnotin $script:OperationNames) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'operation is not allowlisted' }
  if ($Request.operation -ceq 'STOP') {
    if (-not (Test-ExactKeys $Request @('schemaId', 'requestId', 'operation'))) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'STOP request must be exact' }
  } else {
    if (-not (Test-ExactKeys $Request @('schemaId', 'requestId', 'operation', 'role', 'requestHash', 'descriptors'))) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'work request must be exact' }
    if ($Request.role -cnotin $script:RoleNames -or $Request.requestHash -cnotmatch $script:HashPattern) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'role or request hash is invalid' }
  }
  if ($Request.schemaId -cne 'xw.m6-4-handoff-host-request.v1' -or $Request.requestId -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{7,95}$') {
    Fail 'M64_HANDOFF_REQUEST_INVALID' 'request identity is invalid'
  }
}

function New-WorkerCommand($Request, $Config) {
  Test-RequestEnvelope $Request
  if ($Request.operation -ceq 'STOP') { return $null }
  $role = [string]$Request.role
  $entry = $Config.roles.$role
  if ($Request.operation -ceq 'READY') {
    if (-not (Test-ExactKeys $Request.descriptors @())) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'READY accepts no descriptors' }
    return [pscustomobject]@{ role = $role; operation = 'READY'; arguments = @(); requestHash = $Request.requestHash }
  }
  switch ($role) {
    'observation' {
      if ($Request.operation -ceq 'DRY') {
        if (-not (Test-ExactKeys $Request.descriptors @())) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'observation DRY accepts no descriptors' }
        $args = @($entry.workerPath, '--mode', 'dry-run', '--policy', $entry.policyDescriptor, '--release-root', $entry.releaseRoot, '--observer-key-file', $entry.privateKeyPath)
      } else {
        if (-not (Test-ExactKeys $Request.descriptors @('ticket'))) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'observation RUN_ONCE needs one signed device-read ticket descriptor' }
        $ticket = Read-Descriptor $Request.descriptors.ticket 'device-read ticket' $entry.ticketInboxRoot
        $ticketJson = Read-BoundedJsonFile $ticket.path 'device-read ticket'
        if ($ticketJson.schemaId -cne 'xw.m6-4-device-read-work-ticket.v1' -or $ticketJson.request.requestHash -cne $Request.requestHash) {
          Fail 'M64_HANDOFF_REQUEST_REBOUND' 'device-read ticket was rebound'
        }
        $args = @($entry.workerPath, '--mode', 'once', '--policy', $entry.policyDescriptor, '--release-root', $entry.releaseRoot, '--observer-key-file', $entry.privateKeyPath, '--ticket', $ticket.path, '--control-plane-url', $entry.controlPlaneUrl)
      }
    }
    'process-inventory' {
      if (-not (Test-ExactKeys $Request.descriptors @('locator'))) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'process inventory needs one locator descriptor' }
      $locator = Read-Descriptor $Request.descriptors.locator 'process locator' $entry.requestInboxRoot
      $locatorJson = Read-BoundedJsonFile $locator.path 'process locator'
      if ($locatorJson.kind -cne 'RESOURCE_OBSERVATION' -or $locatorJson.requestHash -cne $Request.requestHash) { Fail 'M64_HANDOFF_REQUEST_REBOUND' 'process locator was rebound' }
      $args = @($entry.workerPath, '--locator', $locator.path, '--response-root', $entry.responseRoot, '--db-path', $entry.dbPath, '--private-key', $entry.privateKeyPath, '--policy', $entry.policyPath)
    }
    'normal-close' {
      if (-not (Test-ExactKeys $Request.descriptors @('locator', 'window'))) { Fail 'M64_HANDOFF_REQUEST_INVALID' 'normal-close needs locator and window descriptors' }
      $locator = Read-Descriptor $Request.descriptors.locator 'normal-close locator' $entry.requestInboxRoot
      $window = Read-Descriptor $Request.descriptors.window 'normal-close window' $entry.windowInboxRoot
      $locatorJson = Read-BoundedJsonFile $locator.path 'normal-close locator'
      if ($locatorJson.kind -cne 'NORMAL_CLOSE_SIGNING' -or $locatorJson.requestHash -cne $Request.requestHash) { Fail 'M64_HANDOFF_REQUEST_REBOUND' 'normal-close locator was rebound' }
      $args = @($entry.workerPath, '--request-locator', "$($locator.path)@$($locator.sha256)", '--window', "$($window.path)@$($window.sha256)", '--gate-private-key', $entry.privateKeyPath, '--gate-key-id', $entry.gateKeyId, '--gate-subject', $entry.gateSubject, '--gate-allowlist-version', [string]$entry.gateAllowlistVersion)
      if ($Request.operation -ceq 'RUN_ONCE') { $args += @('--publish', '--output-root', $entry.outputRoot) }
    }
  }
  return [pscustomobject]@{ role = $role; operation = $Request.operation; arguments = $args; requestHash = $Request.requestHash }
}

function Invoke-BoundedWorker($Command, $Config) {
  if ($Command.operation -ceq 'READY') {
    return [ordered]@{ ok = $true; status = 'READY'; role = $Command.role; requestHash = $Command.requestHash; actionCount = 0 }
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Config.nodePath
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.CreateNoWindow = $true
  foreach ($argument in $Command.arguments) { [void]$start.ArgumentList.Add([string]$argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit([int]$Config.requestTimeoutMs)) {
    try { $process.Kill($true) } catch {}
    Fail 'M64_HANDOFF_WORKER_TIMEOUT' 'worker exceeded its bounded deadline'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  [void]$stderrTask.GetAwaiter().GetResult()
  if ([Text.Encoding]::UTF8.GetByteCount($stdout) -gt 65536) { Fail 'M64_HANDOFF_WORKER_OUTPUT_BOUNDS' 'worker output exceeded its public bound' }
  $parsed = $null
  try { $parsed = $stdout | ConvertFrom-Json -Depth 100 } catch {}
  if ($process.ExitCode -ne 0 -or $null -eq $parsed) { Fail 'M64_HANDOFF_WORKER_FAILED_CLOSED' 'worker rejected the bounded request' }
  $actionCount = if ($null -ne $parsed.actionCount) { [long]$parsed.actionCount } else { 0L }
  if ($Command.operation -ceq 'DRY' -and $actionCount -ne 0) { Fail 'M64_HANDOFF_DRY_ACTION_INVALID' 'dry worker reported an action' }
  return [ordered]@{
    ok = $true; status = if ($Command.operation -ceq 'DRY') { 'DRY_COMPLETE' } else { 'RUN_ONCE_COMPLETE' }
    role = $Command.role; requestHash = $Command.requestHash; actionCount = $actionCount
  }
}

function Write-PipeResponse($Writer, $Response) {
  $json = $Response | ConvertTo-Json -Compress -Depth 10
  if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384) { Fail 'M64_HANDOFF_RESPONSE_BOUNDS' 'public response exceeded its bound' }
  $Writer.WriteLine($json)
  $Writer.Flush()
}

$config = Read-HostConfig $ConfigPath
if ($ValidateConfigOnly) {
  [ordered]@{ ok = $true; status = 'CONFIG_VALID'; roles = $script:RoleNames; actionCount = 0 } | ConvertTo-Json -Compress
  exit 0
}
if (-not [string]::IsNullOrWhiteSpace($ValidateRequestPath)) {
  $validationRequest = Read-BoundedJsonFile $ValidateRequestPath 'handoff validation request' ([int]$config.maxRequestBytes)
  $validationCommand = New-WorkerCommand $validationRequest $config
  [ordered]@{
    ok = $true; status = 'REQUEST_VALID'; role = $validationCommand.role
    operation = $validationCommand.operation; requestHash = $validationCommand.requestHash; actionCount = 0
  } | ConvertTo-Json -Compress
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'M64_HANDOFF_ELEVATION_REQUIRED' 'handoff host must run elevated'
}

$stop = $false
for ($handled = 0; $handled -lt $MaxRequests -and -not $stop; $handled++) {
  $pipe = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1,
    [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::CurrentUserOnly, 4096, [int]$config.maxRequestBytes)
  try {
    $pipe.WaitForConnection()
    $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
    $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
    $writer.AutoFlush = $true
    try {
      $line = $reader.ReadLine()
      if ($null -eq $line -or [Text.Encoding]::UTF8.GetByteCount($line) -gt $config.maxRequestBytes) { Fail 'M64_HANDOFF_REQUEST_BOUNDS' 'pipe request exceeded its bound' }
      try { $request = $line | ConvertFrom-Json -Depth 20 } catch { Fail 'M64_HANDOFF_REQUEST_INVALID' 'pipe request is not JSON' }
      $command = New-WorkerCommand $request $config
      if ($request.operation -ceq 'STOP') {
        Write-PipeResponse $writer ([ordered]@{ ok = $true; status = 'STOPPED'; requestId = $request.requestId; actionCount = 0 })
        $stop = $true
      } else {
        $result = Invoke-BoundedWorker $command $config
        Write-PipeResponse $writer ([ordered]@{ requestId = $request.requestId; result = $result })
      }
    } catch {
      $code = if ($_.Exception.Data['Code']) { [string]$_.Exception.Data['Code'] } else { 'M64_HANDOFF_FAILED_CLOSED' }
      Write-PipeResponse $writer ([ordered]@{ ok = $false; code = $code; actionCount = 0 })
    } finally {
      $reader.Dispose()
      $writer.Dispose()
    }
  } finally {
    $pipe.Dispose()
  }
}
