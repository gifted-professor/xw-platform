param(
    [ValidateSet("Install", "Start", "Stop", "Status", "Remove")]
    [string]$Action = "Status",
    [string]$TaskName = "XhsDeviceControlPlaneV1",
    [ValidateSet("legacy", "shadow", "nonpayment_v1")]
    [string]$AutonomyPolicyMode = "legacy",
    [ValidateSet("legacy", "dual", "v1")]
    [string]$EvidenceMode = "legacy",
    [string]$ReleaseId = "",
    [string]$RegistryCommit = "",
    [string]$WindowsRegistryCommit = "",
    [string[]]$PilotActors = @(),
    [string[]]$PilotAliases = @(),
    [ValidateSet("off", "shadow", "canary", "active")]
    [string]$RecipeOverlayMode = "off",
    [string]$RecipeOverlayPath = "C:\Users\Public\xhs-agent-control\generated-overlay\recipe-catalog.json",
    [string]$RecipeOverlaySha256 = "",
    [bool]$RequireTestReceipt = $true,
    [bool]$RequireMainOrigin = $true,
    [bool]$AllowDirtyWorktree = $false
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = "C:\Users\Public\xhs-agent-control"
$launchConfig = Join-Path $stateRoot "task-launch.json"
$worker = Join-Path $PSScriptRoot "control-plane-worker.ps1"
$deviceConfig = Join-Path $repoRoot "config\control-plane.devices.json"

function Get-Health {
    try {
        return Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:17920/control/v1/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Write-Result([hashtable]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

if ($Action -eq "Install") {
    if ([System.Net.Dns]::GetHostName() -ine "DESKTOP-3I1EVHE") {
        throw "Task can only be installed on DESKTOP-3I1EVHE"
    }
    if (-not (Test-Path -LiteralPath $deviceConfig)) {
        throw "Create the untracked device config first: $deviceConfig"
    }
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = (& $nodeExe --no-warnings --version).Trim().TrimStart("v")
    if ($nodeVersion -ne "24.11.1") { throw "Node 24.11.1 required; found $nodeVersion" }
    $gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to resolve repository commit" }
    if ($gitCommit -notmatch "^[0-9a-f]{40}$") { throw "Repository HEAD must be a full 40-char SHA: $gitCommit" }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $launch = [ordered]@{
        schemaVersion = 1
        repoRoot = $repoRoot
        nodeExe = $nodeExe
        gitCommit = $gitCommit
        deviceConfig = $deviceConfig
        releaseId = $ReleaseId
        autonomyPolicyMode = $AutonomyPolicyMode
        evidenceMode = $EvidenceMode
        pilotActors = @($PilotActors)
        pilotAliases = @($PilotAliases)
        recipeOverlayMode = $RecipeOverlayMode
        recipeOverlayPath = $RecipeOverlayPath
        recipeOverlaySha256 = $RecipeOverlaySha256
        requireTestReceipt = [bool]$RequireTestReceipt
        requireMainOrigin = [bool]$RequireMainOrigin
        allowDirtyWorktree = [bool]$AllowDirtyWorktree
    }
    $json = $launch | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($launchConfig, $json, (New-Object Text.UTF8Encoding($false)))

    # REX Phase 6 B7: a cross-repo release manifest (xhs.cross-repo-release.v1) is written at
    # install/update time when a release is pinned. deviceAgentCommit / taskLaunchCommit are this
    # checkout's HEAD; registryCommit / windowsRegistryCommit are the registry repo SHAs supplied
    # by the deploy flow (Windows has no git checkout of the registry repo). All must be full
    # 40-char SHAs. effectiveDecisionSource mirrors resolvePolicyMode (shadow is compute-not-apply).
    if (-not [string]::IsNullOrWhiteSpace($ReleaseId)) {
        foreach ($commit in @($RegistryCommit, $WindowsRegistryCommit, $gitCommit)) {
            if ($commit -notmatch "^[0-9a-f]{40}$") {
                throw "Cross-repo release manifest requires full 40-char SHAs; got: $commit"
            }
        }
        $pilotConfigured = (@($PilotActors).Count -gt 0 -and @($PilotAliases).Count -gt 0)
        $effectiveDecisionSource = if ($AutonomyPolicyMode -eq "nonpayment_v1" -and $pilotConfigured) { "deployed-runtime" } else { "shadow" }
        $release = [ordered]@{
            schemaId = "xhs.cross-repo-release.v1"
            schemaVersion = 1
            releaseId = $ReleaseId
            registryCommit = $RegistryCommit
            deviceAgentCommit = $gitCommit
            windowsRegistryCommit = $WindowsRegistryCommit
            taskLaunchCommit = $gitCommit
            policyMode = $AutonomyPolicyMode
            evidenceMode = $EvidenceMode
            runtimePolicyVersion = "xhs.nonpayment-autonomy.v1"
            effectiveDecisionSource = $effectiveDecisionSource
            pilotActors = @($PilotActors)
            pilotAliases = @($PilotAliases)
            pilotConfigured = $pilotConfigured
            policyDocDebt = @()
            schemaContracts = @()
            deployedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
        $releaseJson = $release | ConvertTo-Json -Depth 6
        [IO.File]::WriteAllText((Join-Path $stateRoot "cross-repo-release.json"), $releaseJson, (New-Object Text.UTF8Encoding($false)))
    }

    $powershell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worker`" -LaunchConfig `"$launchConfig`""
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repoRoot
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Principal $principal -Settings $settings -Force | Out-Null
    Write-Result @{
        ok = $true
        action = "installed"
        taskName = $TaskName
        gitCommit = $gitCommit
        node = $nodeVersion
        releaseId = $ReleaseId
        autonomyPolicyMode = $AutonomyPolicyMode
        evidenceMode = $EvidenceMode
        autoStarted = $false
    }
    exit 0
}

if ($Action -eq "Start") {
    Start-ScheduledTask -TaskName $TaskName
    $health = $null
    for ($index = 0; $index -lt 40; $index += 1) {
        Start-Sleep -Milliseconds 250
        $health = Get-Health
        if ($null -ne $health) { break }
    }
    if ($null -eq $health) { throw "Control plane did not become healthy" }
    Write-Result @{
        ok = $true
        action = "started"
        taskName = $TaskName
        health = $health
    }
    exit 0
}

if ($Action -eq "Stop") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    for ($index = 0; $index -lt 20; $index += 1) {
        if ($null -eq (Get-Health)) { break }
        Start-Sleep -Milliseconds 250
    }
    Write-Result @{
        ok = $true
        action = "stopped"
        taskName = $TaskName
        listening = ($null -ne (Get-Health))
    }
    exit 0
}

if ($Action -eq "Remove") {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Result @{
        ok = $true
        action = "removed"
        taskName = $TaskName
    }
    exit 0
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$health = Get-Health
Write-Result @{
    ok = $true
    action = "status"
    taskName = $TaskName
    installed = ($null -ne $task)
    taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    healthy = ($null -ne $health)
    health = $health
}
