param(
    [string]$ContractPath = "",
    [switch]$CreateMissingDirectories,
    [switch]$M6C1Only,
    [switch]$SkipHealthCheck,
    [ValidateSet("QUALIFICATION_ONLY", "FINAL")]
    [string]$Mode = "FINAL"
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

function Test-ExactProperties($Value, [string[]]$Expected) {
    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count) { return $false }
    for ($index = 0; $index -lt $wanted.Count; $index += 1) {
        if ([string]$actual[$index] -cne [string]$wanted[$index]) { return $false }
    }
    return $true
}

function Test-NonzeroHash([string]$Value) {
    return $Value -match '^[0-9a-f]{64}$' -and $Value -notmatch '^0{64}$'
}

function Test-PlainFile([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction Stop)) { return $false }
        return ((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
    } catch { return $false }
}

function Test-PlainDirectory([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container -ErrorAction Stop)) { return $false }
        return ((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
    } catch { return $false }
}

function Resolve-OptionalAbsolutePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) { return $null }
    try { return [IO.Path]::GetFullPath($Value) } catch { return $null }
}

function Test-Within([string]$Root, [string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Root) -or [string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    try {
        $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        return [IO.Path]::GetFullPath($Candidate).StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Test-SamePath([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right) `
        -or -not [IO.Path]::IsPathRooted($Left) -or -not [IO.Path]::IsPathRooted($Right)) { return $false }
    try { return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
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

$m6 = $contract.m6C1
$m6Keys = @(
    "schemaId", "runtimeModes", "bindingPath", "bindingSchemaId", "qualificationBindingPath",
    "qualificationBindingSchemaId", "providerBaseUrl", "controlPlaneHost", "controlPlanePort",
    "healthUrl", "gateStatusUrl", "nodeExecutable", "nodeVersion", "requiredSecretEnvironment",
    "requiredOpaqueEnvironment", "qualificationRequiredSecretEnvironment",
    "qualificationRequiredOpaqueEnvironment"
)
$expectedSecrets = @("DEEPSEEK_API_KEY", "XW_M6_GATE_F_OPERATIONS_TOKEN", "XW_M6_LIVE_ENTRY_TOKEN") | Sort-Object
$actualSecrets = @($m6.requiredSecretEnvironment | ForEach-Object { [string]$_ } | Sort-Object)
$expectedOpaque = @("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH")
$actualOpaque = @($m6.requiredOpaqueEnvironment | ForEach-Object { [string]$_ })
$expectedQualificationSecrets = @("XW_M6_GATE_F_OPERATIONS_TOKEN")
$actualQualificationSecrets = @($m6.qualificationRequiredSecretEnvironment | ForEach-Object { [string]$_ })
$actualQualificationOpaque = @($m6.qualificationRequiredOpaqueEnvironment | ForEach-Object { [string]$_ })
$m6ContractOk = (Test-ExactProperties $m6 $m6Keys) `
    -and [string]$m6.schemaId -eq "xw.runtime.m6-c1-launch-contract.v1" `
    -and [string]$m6.bindingSchemaId -eq "xw.runtime.m6-c1-runtime.v1" `
    -and [string]$m6.qualificationBindingSchemaId -eq "xw.runtime.m6-c1-qualification-bootstrap.v1" `
    -and (@($m6.runtimeModes | ForEach-Object { [string]$_ }) -join "`0") -ceq (@("QUALIFICATION_ONLY", "FINAL") -join "`0") `
    -and [string]$m6.providerBaseUrl -eq "https://api.deepseek.com" `
    -and [string]$m6.controlPlaneHost -eq "127.0.0.1" `
    -and [int]$m6.controlPlanePort -eq 17920 `
    -and [string]$m6.healthUrl -eq "http://127.0.0.1:17920/control/v1/health" `
    -and [string]$m6.gateStatusUrl -eq "http://127.0.0.1:17920/control/v1/internal/m6/gate-f/status" `
    -and ($actualSecrets -join "`0") -ceq ($expectedSecrets -join "`0") `
    -and ($actualOpaque -join "`0") -ceq ($expectedOpaque -join "`0") `
    -and ($actualQualificationSecrets -join "`0") -ceq ($expectedQualificationSecrets -join "`0") `
    -and ($actualQualificationOpaque -join "`0") -ceq ($expectedOpaque -join "`0")
Add-Check "m6-c1:launch-contract" $m6ContractOk "xw.runtime.m6-c1-launch-contract.v1"

$immutableReleaseOk = $false
if ($m6ContractOk -and $currentOk) {
    $externalLauncher = Join-Path $repoRoot "services\control-plane\scripts\xw-control-plane-runtime.ps1"
    try {
        $verificationRaw = (& $externalLauncher -RuntimeRoot $runtimeRoot -ContractPath ([IO.Path]::GetFullPath($ContractPath)) `
            -Mode $Mode -VerifyReleaseOnly 2>$null | Out-String)
        $verification = $verificationRaw | ConvertFrom-Json
        $immutableReleaseOk = [bool]$verification.ok -eq $true `
            -and [string]$verification.schemaId -eq "xw.runtime.m6-c1-immutable-release-verification.v1" `
            -and [IO.Path]::GetFullPath([string]$verification.releaseRoot).Equals($releaseRoot, [StringComparison]::OrdinalIgnoreCase)
    } catch { $immutableReleaseOk = $false }
}
Add-Check "m6-c1:external-immutable-release" $immutableReleaseOk $(if ($immutableReleaseOk) { "manifest-and-full-tree-verified" } else { "missing-drifted-or-rebound" })

$bindingPath = $null
$binding = $null
$bindingRaw = ""
$bindingRelative = if ($Mode -eq "QUALIFICATION_ONLY") { [string]$m6.qualificationBindingPath } else { [string]$m6.bindingPath }
$bindingRelativeOk = $m6ContractOk -and -not [string]::IsNullOrWhiteSpace($bindingRelative) `
    -and -not [IO.Path]::IsPathRooted($bindingRelative) -and $bindingRelative -notmatch '(^|[\\/])\.\.([\\/]|$)'
if ($bindingRelativeOk) {
    $bindingPath = Resolve-RuntimePath $bindingRelative
    $bindingRelativeOk = Test-Within $runtimeRoot $bindingPath
}
Add-Check "m6-c1:binding-path" $bindingRelativeOk $(if ($bindingRelativeOk) { $bindingPath } else { "invalid" })
if ($bindingRelativeOk -and (Test-PlainFile $bindingPath)) {
    try {
        $bindingRaw = Get-Content -LiteralPath $bindingPath -Raw
        $binding = $bindingRaw | ConvertFrom-Json
    } catch { $binding = $null }
}
$bindingHasNoSecretMaterial = $null -ne $binding `
    -and $bindingRaw -notmatch '(?i)bearer\s+|"(?:apiKey|token|password|secret|credentialValue)"\s*:'
Add-Check "m6-c1:binding-secret-free" $bindingHasNoSecretMaterial $(if ($bindingHasNoSecretMaterial) { "no-secret-fields" } else { "missing-or-forbidden" })
$finalBindingKeys = @(
    "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
    "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
    "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
    "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
    "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256", "targetEnvironmentAttestationPath",
    "targetEnvironmentAttestationHash", "environmentQualificationPath", "environmentQualificationSha256",
    "productionDependencyBindingPath", "productionDependencyBindingHash"
)
$qualificationBindingKeys = @(
    "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
    "gateId", "gateIssuerAllowlistPath", "gateFArtifactInventoryPath", "gateFArtifactInventoryHash"
)
$expectedBindingKeys = if ($Mode -eq "QUALIFICATION_ONLY") { $qualificationBindingKeys } else { $finalBindingKeys }
$expectedBindingSchema = if ($Mode -eq "QUALIFICATION_ONLY") { [string]$m6.qualificationBindingSchemaId } else { [string]$m6.bindingSchemaId }
$bindingSchemaOk = (Test-ExactProperties $binding $expectedBindingKeys) `
    -and [string]$binding.schemaId -eq $expectedBindingSchema `
    -and [string]$binding.releaseId -match '^[A-Za-z0-9._-]{1,128}$' `
    -and [string]$binding.sourceCommit -match '^[0-9a-f]{40}$' `
    -and (Test-NonzeroHash ([string]$binding.releaseManifestSha256)) `
    -and (($Mode -eq "QUALIFICATION_ONLY" -and (Test-NonzeroHash ([string]$binding.gateFArtifactInventoryHash))) `
        -or ($Mode -eq "FINAL" -and (Test-NonzeroHash ([string]$binding.gateFArtifactCatalogHash)))) `
    -and [string]$binding.gateId -match '^[A-Za-z0-9._-]{1,128}$'
if ($Mode -eq "FINAL") {
    $bindingSchemaOk = $bindingSchemaOk `
        -and (Test-NonzeroHash ([string]$binding.dependencyLayerHash)) `
        -and (Test-NonzeroHash ([string]$binding.modelProfileHash)) `
        -and (Test-NonzeroHash ([string]$binding.targetEnvironmentAttestationHash)) `
        -and (Test-NonzeroHash ([string]$binding.environmentQualificationSha256)) `
        -and (Test-NonzeroHash ([string]$binding.gateFArtifactCatalogSha256)) `
        -and (Test-NonzeroHash ([string]$binding.productionDependencyBindingHash)) `
        -and [string]$binding.providerBaseUrl -eq [string]$m6.providerBaseUrl
}
Add-Check "m6-c1:binding-schema" $bindingSchemaOk $(if ($bindingSchemaOk) { [string]$binding.schemaId } else { "missing-or-invalid" })

$boundReleaseRoot = Resolve-OptionalAbsolutePath ([string]$binding.sourceReleaseRoot)
$releaseBindingOk = $bindingSchemaOk -and $currentOk -and $null -ne $boundReleaseRoot `
    -and $boundReleaseRoot.Equals($releaseRoot, [StringComparison]::OrdinalIgnoreCase) `
    -and $manifestOk -and [string]$manifest.releaseId -eq [string]$binding.releaseId `
    -and [string]$manifest.sourceCommit -eq [string]$binding.sourceCommit `
    -and (Test-NonzeroHash ([string]$binding.releaseManifestSha256)) `
    -and (Test-PlainFile $manifestPath) -and (Get-Sha256 $manifestPath) -eq [string]$binding.releaseManifestSha256
Add-Check "m6-c1:release-binding" $releaseBindingOk $(if ($releaseBindingOk) { "$($binding.releaseId)/$($binding.sourceCommit)" } else { "missing-or-rebound" })

if ($Mode -eq "QUALIFICATION_ONLY") {
    $gateIssuerPath = Resolve-OptionalAbsolutePath ([string]$binding.gateIssuerAllowlistPath)
    $inventorySentinelPath = Resolve-OptionalAbsolutePath ([string]$binding.gateFArtifactInventoryPath)
    $sentinelRoot = Join-Path $runtimeRoot "qualification-bootstrap"
    $liveIssuerPath = Join-Path $sentinelRoot "live-window-owner-keys-unavailable.json"
    $sentinelOk = $null -ne $inventorySentinelPath -and (Test-Within $sentinelRoot $inventorySentinelPath) `
        -and -not (Test-Path -LiteralPath $inventorySentinelPath) -and -not (Test-Path -LiteralPath $liveIssuerPath)
    Add-Check "m6-c1:qualification-inventory-sentinel" $sentinelOk $(if ($sentinelOk) { "deliberately-unavailable" } else { "missing-boundary-or-activation-capable" })
    $qualificationInputsOk = Test-PlainFile $gateIssuerPath
    Add-Check "m6-c1:qualification-gate-inputs" $qualificationInputsOk $(if ($qualificationInputsOk) { "issuer-inputs-present" } else { "missing-or-invalid" })
    $deviceConfigPath = Join-Path $runtimeRoot "secrets\control-plane.devices.json"
    $deviceConfig = $null
    if (Test-PlainFile $deviceConfigPath) { try { $deviceConfig = Get-Content -LiteralPath $deviceConfigPath -Raw | ConvertFrom-Json } catch { } }
    $alias01 = @($deviceConfig.devices | Where-Object { [string]$_.alias -eq "01" -and [bool]$_.online -eq $true -and [bool]$_.quarantined -eq $false })
    $deviceConfigOk = $alias01.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$alias01[0].deviceId)
    Add-Check "m6-c1:qualification-alias01-binding" $deviceConfigOk $(if ($deviceConfigOk) { "one-online-public-binding" } else { "missing-duplicate-or-offline" })

    $nodeExecutable = Resolve-OptionalAbsolutePath ([string]$m6.nodeExecutable)
    $nodeOk = Test-PlainFile $nodeExecutable
    if ($nodeOk) {
        try {
            $actualNodeVersion = (& $nodeExecutable -p "process.versions.node").Trim()
            $nodeOk = $LASTEXITCODE -eq 0 -and $actualNodeVersion -eq [string]$m6.nodeVersion
        } catch { $nodeOk = $false }
    }
    Add-Check "m6-c1:node-runtime" $nodeOk $(if ($nodeOk) { [string]$m6.nodeVersion } else { "missing-or-version-mismatch" })

    $operationsToken = [Environment]::GetEnvironmentVariable("XW_M6_GATE_F_OPERATIONS_TOKEN", "Process")
    $operationsTokenOk = -not [string]::IsNullOrWhiteSpace($operationsToken) -and $operationsToken.Length -ge 32 `
        -and $operationsToken.Length -le 4096 -and $operationsToken -notmatch '[\x00\r\n]'
    Add-Check "m6-c1:required-env:XW_M6_GATE_F_OPERATIONS_TOKEN" $operationsTokenOk $(if ($operationsTokenOk) { "present" } else { "missing-or-invalid" })
    $accountBinding = [Environment]::GetEnvironmentVariable("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", "Process")
    $accountBindingOk = Test-NonzeroHash $accountBinding
    Add-Check "m6-c1:required-env:XW_M6_ACCOUNT_ISOLATION_BINDING_HASH" $accountBindingOk $(if ($accountBindingOk) { "present" } else { "missing-or-invalid" })

    if (-not $SkipHealthCheck) {
        $health = $null
        $gateStatus = $null
        try { $health = Invoke-RestMethod -Method Get -Uri ([string]$m6.healthUrl) -TimeoutSec 3 } catch { }
        if ($operationsTokenOk) {
            try {
                $gateStatus = Invoke-RestMethod -Method Get -Uri ([string]$m6.gateStatusUrl) -TimeoutSec 3 `
                    -Headers @{ "X-Control-Token" = $operationsToken }
            } catch { }
        }
        $healthOk = $null -ne $health -and [bool]$health.ok -eq $true `
            -and [string]$health.releaseId -eq [string]$binding.releaseId `
            -and [string]$health.sourceCommit -eq [string]$binding.sourceCommit `
            -and [string]$health.runtimeProfile -eq [string]$contract.runtimeProfile `
            -and [string]$health.m6RuntimeMode -eq "QUALIFICATION_ONLY" `
            -and $null -eq $health.m6 -and $null -eq $health.m6LiveEntry `
            -and [string]$health.m6GateFOperations.status -eq "PREFLIGHT_REQUIRED" `
            -and @($health.m6GateFOperations.blockers).Count -eq 0
        Add-Check "m6-c1:qualification-health" $healthOk $(if ($healthOk) { "qualification-only-route-set" } else { "unavailable-unsealed-or-overbroad" })
        $gate = $gateStatus.gate
        $gateOk = [string]$gate.schemaId -eq "xw.m6-gate-f-operations-status.v1" `
            -and [string]$gate.mode -eq "CLOSED" -and [string]$gate.phase -eq "CLOSED" `
            -and [bool]$gate.tripleConsistent -eq $true -and @($gate.errors).Count -eq 0 `
            -and [int]$gate.activeAuthorizationCount -eq 0 -and [int]$gate.actionCount -eq 0 `
            -and [int]$gate.resourceCounts.jobs -eq 0 -and [int]$gate.resourceCounts.leases -eq 0 `
            -and [int]$gate.resourceCounts.runs -eq 0 -and [int]$gate.resourceCounts.sessions -eq 0
        Add-Check "m6-c1:qualification-gate-status" $gateOk $(if ($gateOk) { "closed-and-resource-zero" } else { "unavailable-open-or-busy" })
    }

    Add-Check "runtime-file:$bindingRelative" (Test-PlainFile $bindingPath) $bindingPath
    $failed = @($checks | Where-Object { -not $_.ok })
    $result = [ordered]@{
        ok = $failed.Count -eq 0
        schemaId = [string]$contract.schemaId
        runtimeMode = "QUALIFICATION_ONLY"
        sourceRoot = $repoRoot
        runtimeRoot = $runtimeRoot
        releaseId = if ($null -ne $manifest) { [string]$manifest.releaseId } else { $null }
        sourceCommit = if ($null -ne $manifest) { [string]$manifest.sourceCommit } else { $null }
        checks = $checks
    }
    $result | ConvertTo-Json -Depth 8
    if ($failed.Count -gt 0) { exit 1 }
    exit 0
}

$dependencyRoot = Resolve-OptionalAbsolutePath ([string]$binding.dependencyRoot)
$modelProfileRoot = Resolve-OptionalAbsolutePath ([string]$binding.modelProfileRoot)
$manifestRoot = Resolve-OptionalAbsolutePath ([string]$binding.manifestRoot)
$snapshotPath = Resolve-OptionalAbsolutePath ([string]$binding.runtimeSnapshotPath)
$persistenceRoot = Resolve-OptionalAbsolutePath ([string]$binding.dshPersistenceRoot)
$gateIssuerPath = Resolve-OptionalAbsolutePath ([string]$binding.gateIssuerAllowlistPath)
$liveIssuerPath = Resolve-OptionalAbsolutePath ([string]$binding.liveAuthorizationIssuerAllowlistPath)
$catalogPath = Resolve-OptionalAbsolutePath ([string]$binding.gateFArtifactCatalogPath)
$targetEnvironmentPath = Resolve-OptionalAbsolutePath ([string]$binding.targetEnvironmentAttestationPath)
$environmentQualificationPath = Resolve-OptionalAbsolutePath ([string]$binding.environmentQualificationPath)
$productionDependencyBindingPath = Resolve-OptionalAbsolutePath ([string]$binding.productionDependencyBindingPath)
$rootSeparationOk = $null -ne $dependencyRoot -and $null -ne $modelProfileRoot -and $null -ne $persistenceRoot `
    -and $null -ne $productionDependencyBindingPath `
    -and -not (Test-Within $releaseRoot $dependencyRoot) -and -not (Test-Within $releaseRoot $modelProfileRoot) `
    -and -not (Test-Within $releaseRoot $persistenceRoot) -and -not (Test-Within $dependencyRoot $modelProfileRoot) `
    -and -not (Test-Within $dependencyRoot $persistenceRoot) `
    -and -not (Test-Within $releaseRoot $productionDependencyBindingPath)
Add-Check "m6-c1:mutable-root-separation" $rootSeparationOk "release/dependency/model/persistence"

$productionDependencyOk = (Test-PlainFile $productionDependencyBindingPath) `
    -and (Get-Sha256 $productionDependencyBindingPath) -eq [string]$binding.productionDependencyBindingHash
Add-Check "m6-c1:production-dependency-binding" $productionDependencyOk $(if ($productionDependencyOk) { [string]$binding.productionDependencyBindingHash } else { "missing-or-rebound" })

$layerManifestPath = if ($null -ne $dependencyRoot) { Join-Path $dependencyRoot "m6-live-runtime-dependency-layer.v1.json" } else { $null }
$layer = $null
if (Test-PlainFile $layerManifestPath) { try { $layer = Get-Content -LiteralPath $layerManifestPath -Raw | ConvertFrom-Json } catch { } }
$layerOk = $rootSeparationOk -and (Test-PlainDirectory $dependencyRoot) -and $null -ne $layer `
    -and [string]$layer.schemaId -eq "xw.m6-live-runtime-dependency-layer.v1" `
    -and [string]$layer.layerHash -eq [string]$binding.dependencyLayerHash `
    -and [string]$layer.sourceRelease.releaseId -eq [string]$binding.releaseId `
    -and [string]$layer.sourceRelease.sourceCommit -eq [string]$binding.sourceCommit `
    -and [string]$layer.sourceRelease.manifestSha256 -eq [string]$binding.releaseManifestSha256
Add-Check "m6-c1:dependency-layer" $layerOk $(if ($layerOk) { [string]$binding.dependencyLayerHash } else { "missing-or-rebound" })

$profilePath = if ($null -ne $modelProfileRoot -and (Test-NonzeroHash ([string]$binding.modelProfileHash))) {
    Join-Path $modelProfileRoot (([string]$binding.modelProfileHash) + ".json")
} else { $null }
$profile = $null
if (Test-PlainFile $profilePath) { try { $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json } catch { } }
$profileExpiry = [DateTimeOffset]::MinValue
$profileTimeOk = $null -ne $profile -and [DateTimeOffset]::TryParse([string]$profile.expiresAt, [ref]$profileExpiry) -and $profileExpiry -gt [DateTimeOffset]::UtcNow
$profileOk = (Test-PlainDirectory $modelProfileRoot) -and $profileTimeOk `
    -and [string]$profile.schemaId -eq "xw.m6-live-model-profile.v1" -and [string]$profile.status -eq "QUALIFIED" `
    -and [bool]$profile.gateFEligible -eq $true -and [string]$profile.provider -eq "deepseek-official" `
    -and [string]$profile.contentHash -eq [string]$binding.modelProfileHash
Add-Check "m6-c1:model-profile" $profileOk $(if ($profileOk) { [string]$binding.modelProfileHash } else { "missing-invalid-or-expired" })

$catalogOk = (Test-PlainFile $catalogPath) -and (Get-Sha256 $catalogPath) -eq [string]$binding.gateFArtifactCatalogSha256
$targetEnvironment = $null
$environmentQualification = $null
$artifactCatalog = $null
$artifactInventories = @()
if (Test-PlainFile $targetEnvironmentPath) { try { $targetEnvironment = Get-Content -LiteralPath $targetEnvironmentPath -Raw | ConvertFrom-Json } catch { } }
if (Test-PlainFile $environmentQualificationPath) { try { $environmentQualification = Get-Content -LiteralPath $environmentQualificationPath -Raw | ConvertFrom-Json } catch { } }
if ($catalogOk) {
    try {
        $artifactCatalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
        $artifactInventories = @($artifactCatalog.entries | ForEach-Object {
            Get-Content -LiteralPath ([string]$_.inventoryPath) -Raw | ConvertFrom-Json
        })
    } catch { $artifactCatalog = $null; $artifactInventories = @() }
}
$targetExpiry = [DateTimeOffset]::MinValue
$targetFresh = $null -ne $targetEnvironment -and [DateTimeOffset]::TryParse([string]$targetEnvironment.expiresAt, [ref]$targetExpiry) `
    -and $targetExpiry -gt [DateTimeOffset]::UtcNow
$environmentQualificationOk = $targetFresh -and (Test-PlainFile $environmentQualificationPath) `
    -and (Get-Sha256 $environmentQualificationPath) -eq [string]$binding.environmentQualificationSha256 `
    -and $profileOk `
    -and [string]$profile.targetEnvironmentAttestationHash -eq [string]$binding.targetEnvironmentAttestationHash `
    -and $profileExpiry -le $targetExpiry `
    -and [string]$targetEnvironment.schemaId -eq "xw.m6-target-environment-attestation.v1" `
    -and [string]$targetEnvironment.attestationHash -eq [string]$binding.targetEnvironmentAttestationHash `
    -and [string]$environmentQualification.schemaId -eq "xw.m6-environment-qualification.v1" `
    -and [string]$environmentQualification.status -eq "QUALIFIED" -and [bool]$environmentQualification.gateFEligible -eq $true `
    -and [string]$environmentQualification.alias -eq "01" -and [string]$environmentQualification.effectBoundary -eq "READ_ONLY" `
    -and [int]$environmentQualification.sampleCount -eq 2 -and [int]$environmentQualification.actionCount -eq 0 `
    -and [bool]$environmentQualification.secretMaterialPresent -eq $false -and [bool]$environmentQualification.rawDeviceIdentityPresent -eq $false `
    -and @($environmentQualification.qualifiedAttestationHashes).Count -eq 1 `
    -and [string]$environmentQualification.qualifiedAttestationHashes[0] -eq [string]$binding.targetEnvironmentAttestationHash `
    -and [string]$environmentQualification.capturedAt -eq [string]$targetEnvironment.capturedAt `
    -and [string]$environmentQualification.expiresAt -eq [string]$targetEnvironment.expiresAt `
    -and [string]$artifactCatalog.schemaId -eq "xw.m6-gate-f-artifact-catalog.v1" `
    -and [string]$artifactCatalog.catalogHash -eq [string]$binding.gateFArtifactCatalogHash `
    -and @($artifactCatalog.entries).Count -eq 5 -and @($artifactInventories).Count -eq 5 `
    -and @($artifactInventories | Where-Object {
        -not (Test-SamePath ([string]$_.runtimeArtifacts.environmentAttestation.path) $targetEnvironmentPath) `
        -or -not (Test-SamePath ([string]$_.lockArtifacts.environmentQualification.path) $environmentQualificationPath)
    }).Count -eq 0
$environmentInputsOk = (Test-PlainDirectory $manifestRoot) -and (Test-PlainFile $snapshotPath) `
    -and (Test-PlainDirectory $persistenceRoot) -and (Test-PlainFile $gateIssuerPath) `
    -and (Test-PlainFile $liveIssuerPath) -and $catalogOk -and $environmentQualificationOk `
    -and $productionDependencyOk
Add-Check "m6-c1:environment-and-gate-inputs" $environmentInputsOk $(if ($environmentInputsOk) { "sealed-inputs-present" } else { "missing-or-invalid" })

$nodeExecutable = Resolve-OptionalAbsolutePath ([string]$m6.nodeExecutable)
$nodeOk = Test-PlainFile $nodeExecutable
if ($nodeOk) {
    try {
        $actualNodeVersion = (& $nodeExecutable -p "process.versions.node").Trim()
        $nodeOk = $LASTEXITCODE -eq 0 -and $actualNodeVersion -eq [string]$m6.nodeVersion
    } catch { $nodeOk = $false }
}
Add-Check "m6-c1:node-runtime" $nodeOk $(if ($nodeOk) { [string]$m6.nodeVersion } else { "missing-or-version-mismatch" })

foreach ($secretName in $expectedSecrets) {
    $value = [Environment]::GetEnvironmentVariable($secretName, "Process")
    $minimum = if ($secretName -eq "DEEPSEEK_API_KEY") { 8 } else { 32 }
    $present = -not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge $minimum -and $value.Length -le 4096 -and $value -notmatch '[\x00\r\n]'
    Add-Check "m6-c1:required-env:$secretName" $present $(if ($present) { "present" } else { "missing-or-invalid" })
}
$accountBinding = [Environment]::GetEnvironmentVariable("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", "Process")
$accountBindingOk = Test-NonzeroHash $accountBinding
Add-Check "m6-c1:required-env:XW_M6_ACCOUNT_ISOLATION_BINDING_HASH" $accountBindingOk $(if ($accountBindingOk) { "present" } else { "missing-or-invalid" })

if (-not $SkipHealthCheck) {
    $health = $null
    try { $health = Invoke-RestMethod -Method Get -Uri ([string]$m6.healthUrl) -TimeoutSec 3 } catch { }
    $healthOk = $null -ne $health -and [bool]$health.ok -eq $true `
        -and [string]$health.releaseId -eq [string]$binding.releaseId `
        -and [string]$health.sourceCommit -eq [string]$binding.sourceCommit `
        -and [string]$health.runtimeProfile -eq [string]$contract.runtimeProfile `
        -and [string]$health.m6RuntimeMode -eq "FINAL" `
        -and $null -ne $health.m6 -and $null -ne $health.m6LiveEntry -and $null -ne $health.m6GateFOperations `
        -and [string]$health.m6LiveEntry.status -eq "PREFLIGHT_REQUIRED" `
        -and @($health.m6LiveEntry.blockers).Count -eq 0 -and [int]$health.m6LiveEntry.activeRuns -eq 0 `
        -and [string]$health.m6GateFOperations.status -eq "PREFLIGHT_REQUIRED" `
        -and @($health.m6GateFOperations.blockers).Count -eq 0 -and [int]$health.m6GateFOperations.actionCount -eq 0
    Add-Check "m6-c1:control-plane-health" $healthOk $(if ($healthOk) { "release-bound-and-sealed" } else { "unavailable-unsealed-or-rebound" })
}

foreach ($entry in @($contract.runtimeFiles)) {
    if ($M6C1Only -and [string]$entry.kind -notin @("release-identity", "non-secret-runtime-binding")) { continue }
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

if (-not $M6C1Only) {
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
}

if (-not $M6C1Only -and ($IsWindows -or $env:OS -eq "Windows_NT")) {
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
