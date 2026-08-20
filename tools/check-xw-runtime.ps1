param(
    [string]$ContractPath = "",
    [switch]$CreateMissingDirectories
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ContractPath)) {
    $ContractPath = Join-Path $repoRoot "config\runtime\xw-runtime.v1.json"
}
$contract = Get-Content -LiteralPath $ContractPath -Raw | ConvertFrom-Json
$runtimeRoot = [IO.Path]::GetFullPath([string]$contract.runtimeRoot)
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $checks.Add([ordered]@{ name = $Name; ok = $Ok; detail = $Detail })
}

function Resolve-RepoPath([string]$RelativePath) {
    return [IO.Path]::GetFullPath((Join-Path $repoRoot ($RelativePath -replace '/', '\')))
}

function Resolve-RuntimePath([string]$RelativePath) {
    return [IO.Path]::GetFullPath((Join-Path $runtimeRoot ($RelativePath -replace '/', '\')))
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-NormalizedTextSha256([string]$Path) {
    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$marker = Resolve-RepoPath ([string]$contract.sourceRootMarker)
Add-Check "source-root" (Test-Path -LiteralPath $marker -PathType Leaf) $repoRoot
Add-Check "runtime-root" (Test-Path -LiteralPath $runtimeRoot -PathType Container) $runtimeRoot

foreach ($relative in @($contract.directories)) {
    $path = Resolve-RuntimePath ([string]$relative)
    if ($CreateMissingDirectories -and -not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
    Add-Check "directory:$relative" (Test-Path -LiteralPath $path -PathType Container) $path
}

$current = Join-Path $runtimeRoot "current"
$releaseRoot = $null
try {
    $target = [string](Get-Item -LiteralPath $current).Target
    if (-not [string]::IsNullOrWhiteSpace($target)) { $releaseRoot = [IO.Path]::GetFullPath($target) }
} catch { }
$releasesRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "releases"))
$currentOk = $null -ne $releaseRoot -and $releaseRoot.StartsWith($releasesRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
Add-Check "current-release-boundary" $currentOk $(if ($null -ne $releaseRoot) { $releaseRoot } else { "unresolved" })

$manifest = $null
$manifestPath = Join-Path $current "release-manifest.v1.json"
try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { }
$manifestOk = $null -ne $manifest -and [string]$manifest.schemaId -eq "xw.runtime.release-manifest.v1" -and [string]$manifest.runtimeProfile -eq [string]$contract.runtimeProfile -and [string]$manifest.sourceCommit -match '^[0-9a-f]{40}$'
Add-Check "release-manifest" $manifestOk $(if ($null -ne $manifest) { "$($manifest.releaseId)/$($manifest.sourceCommit)" } else { "missing-or-invalid" })

foreach ($entry in @($contract.runtimeFiles)) {
    $relative = [string]$entry.path
    $path = Resolve-RuntimePath $relative
    $exists = Test-Path -LiteralPath $path -PathType Leaf
    Add-Check "runtime-file:$relative" ($exists -or -not [bool]$entry.required) $path
    if ($exists -and -not [string]::IsNullOrWhiteSpace([string]$entry.source)) {
        $source = Resolve-RepoPath ([string]$entry.source)
        $same = (Test-Path -LiteralPath $source -PathType Leaf) -and (Get-NormalizedTextSha256 $source) -eq (Get-NormalizedTextSha256 $path)
        Add-Check "managed-file:$relative" $same ([string]$entry.source)
    }
}

$deviceConfigPath = Join-Path $runtimeRoot "secrets\control-plane.devices.json"
$deviceConfig = $null
try { $deviceConfig = Get-Content -LiteralPath $deviceConfigPath -Raw | ConvertFrom-Json } catch { }
foreach ($property in $contract.deviceServePorts.PSObject.Properties) {
    $alias = [string]$property.Name
    $expectedPort = [int]$property.Value
    $device = @($deviceConfig.devices | Where-Object { [string]$_.alias -eq $alias }) | Select-Object -First 1
    $ok = $null -ne $device -and -not [string]::IsNullOrWhiteSpace([string]$device.runtimeId) -and [int]$device.metadata.xhsServePort -eq $expectedPort
    Add-Check "device:$alias" $ok "servePort=$expectedPort"
}

if ($IsWindows -or $env:OS -eq "Windows_NT") {
    foreach ($expected in @($contract.scheduledTasks)) {
        $task = Get-ScheduledTask -TaskName ([string]$expected.name) -ErrorAction SilentlyContinue
        $state = if ($null -ne $task) { [string]$task.State } else { "Missing" }
        $action = if ($null -ne $task) { @($task.Actions)[0] } else { $null }
        $arguments = if ($null -ne $action) { [string]$action.Arguments } else { "" }
        $launcher = Resolve-RuntimePath ([string]$expected.launcher)
        $enabled = $null -ne $task -and [bool]$task.Settings.Enabled
        $stateOk = $state -in @("Ready", "Running")
        $principalOk = $null -ne $task -and [string]$task.Principal.UserId -ieq [string]$expected.principal
        $runLevelOk = $null -ne $task -and [string]$task.Principal.RunLevel -ieq [string]$expected.runLevel
        $triggerTypes = @($task.Triggers | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_.CimClass.CimClassName })
        $triggerOk = $triggerTypes -contains [string]$expected.requiredTrigger
        $bindingOk = $null -ne $task -and $enabled -and $stateOk -and $principalOk -and $runLevelOk -and $triggerOk -and $arguments.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not [string]::IsNullOrWhiteSpace([string]$expected.argumentsContain)) {
            $bindingOk = $bindingOk -and $arguments.IndexOf([string]$expected.argumentsContain, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        Add-Check "task:$($expected.name)" $bindingOk "state=$state;enabled=$enabled;principal=$($task.Principal.UserId);runLevel=$($task.Principal.RunLevel);triggers=$($triggerTypes -join ',')"
    }
    foreach ($taskName in @($contract.retiredTasksMustStayDisabled)) {
        $task = Get-ScheduledTask -TaskName ([string]$taskName) -ErrorAction SilentlyContinue
        $ok = $null -eq $task -or [string]$task.State -eq "Disabled"
        Add-Check "retired-task:$taskName" $ok $(if ($null -eq $task) { "absent" } else { [string]$task.State })
    }
}

$failed = @($checks | Where-Object { -not $_.ok })
$result = [ordered]@{
    ok = $failed.Count -eq 0
    schemaId = [string]$contract.schemaId
    sourceRoot = $repoRoot
    runtimeRoot = $runtimeRoot
    releaseId = if ($null -ne $manifest) { [string]$manifest.releaseId } else { $null }
    sourceCommit = if ($null -ne $manifest) { [string]$manifest.sourceCommit } else { $null }
    checks = $checks
}
$result | ConvertTo-Json -Depth 8
if ($failed.Count -gt 0) { exit 1 }
