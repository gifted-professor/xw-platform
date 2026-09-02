param(
    [string]$RuntimeRoot = "C:\Users\Public\xw-runtime",
    [Parameter(Mandatory = $true)]
    [string]$IdentityBindingPath,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?!0{64}$)[0-9a-f]{64}$')]
    [string]$ExpectedLauncherSha256,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?!0{64}$)[0-9a-f]{64}$')]
    [string]$ExpectedBindingSha256,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9._-]{2,127}$')]
    [string]$ExpectedReleaseId,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?!0{40}$)[0-9a-f]{40}$')]
    [string]$ExpectedSourceCommit,
    [ValidateSet("FINAL", "QUALIFICATION_ONLY")]
    [string]$Mode = "FINAL",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Keep this bootstrap ASCII-only for Windows PowerShell 5.1.

function Fail-Closed([string]$Code) {
    throw $Code
}

function Test-Hash([string]$Value) {
    return $Value -match '^(?!0{64}$)[0-9a-f]{64}$'
}

function Test-SourceCommit([string]$Value) {
    return $Value -match '^(?!0{40}$)[0-9a-f]{40}$'
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

function Resolve-AbsolutePath([string]$Value, [string]$Code) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
        Fail-Closed $Code
    }
    try { return [IO.Path]::GetFullPath($Value) }
    catch { Fail-Closed $Code }
}

function Test-SamePath([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Left).Equals(
            [IO.Path]::GetFullPath($Right),
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch { return $false }
}

function Test-Within([string]$Root, [string]$Candidate) {
    try {
        $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        $candidateFull = [IO.Path]::GetFullPath($Candidate)
        return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Assert-PlainFile([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Assert-PlainDirectory([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Assert-SystemAdministratorsPrivateAcl([System.IO.FileSystemInfo]$Item) {
    $isDirectory = $Item -is [IO.DirectoryInfo]
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or (-not $isDirectory -and -not ($Item -is [IO.FileInfo]))) {
        Fail-Closed "GATE_F_PRIVATE_ACL_INVALID"
    }
    $sections = [Security.AccessControl.AccessControlSections]::Owner `
        -bor [Security.AccessControl.AccessControlSections]::Access
    if ($isDirectory) {
        $acl = [IO.Directory]::GetAccessControl($Item.FullName, $sections)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit `
            -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $acl = [IO.File]::GetAccessControl($Item.FullName, $sections)
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $allowed = @("S-1-5-18", "S-1-5-32-544")
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $allowed -notcontains $owner -or $rules.Count -ne 2) {
        Fail-Closed "GATE_F_PRIVATE_ACL_INVALID"
    }
    foreach ($sidValue in $allowed) {
        $matching = @($rules | Where-Object {
            [string]$_.IdentityReference.Value -ceq $sidValue `
                -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow `
                -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl `
                -and $_.InheritanceFlags -eq $inheritance `
                -and $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None `
                -and -not $_.IsInherited
        })
        if ($matching.Count -ne 1) { Fail-Closed "GATE_F_PRIVATE_ACL_INVALID" }
    }
}

function Test-PrivateValue([string]$Value, [int]$MinimumLength) {
    return -not [string]::IsNullOrWhiteSpace($Value) `
        -and $Value.Length -ge $MinimumLength -and $Value.Length -le 4096 `
        -and $Value -notmatch '[\x00\r\n]'
}

function Get-Sha256([string]$Path) {
    Assert-PlainFile $Path "GATE_F_FILE_INVALID"
    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-Utf8Sha256([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
        } finally { $algorithm.Dispose() }
    } finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Get-ManifestEntryHash($Manifest, [string]$RelativePath, [string]$Code) {
    $matches = @($Manifest.files | Where-Object { [string]$_.path -ceq $RelativePath })
    if ($matches.Count -ne 1 -or -not (Test-Hash ([string]$matches[0].sha256))) { Fail-Closed $Code }
    return [string]$matches[0].sha256
}

function Assert-ManifestFile(
    $Manifest,
    [string]$ReleaseRoot,
    [string]$Path,
    [string]$RelativePath,
    [string]$ExpectedHash,
    [string]$Code
) {
    $expectedPath = Join-Path $ReleaseRoot ($RelativePath -replace '/', '\')
    if (-not (Test-SamePath $Path $expectedPath)) { Fail-Closed $Code }
    Assert-PlainFile $Path $Code
    if ((Get-Sha256 $Path) -cne $ExpectedHash `
        -or (Get-ManifestEntryHash $Manifest $RelativePath $Code) -cne $ExpectedHash) {
        Fail-Closed $Code
    }
}

function Import-ControlPlanePrivateMaterial(
    [string]$SecretsRoot,
    [string]$SecretEnvironmentPath,
    [string]$SecretEnvironmentSha256,
    [string]$DigestKeyringPath,
    [string]$DigestKeyringSha256
) {
    Assert-PlainDirectory $SecretsRoot "GATE_F_SECRETS_ROOT_INVALID"
    Assert-PlainFile $SecretEnvironmentPath "GATE_F_SECRET_ENVIRONMENT_INVALID"
    Assert-PlainFile $DigestKeyringPath "GATE_F_DIGEST_KEYRING_INVALID"
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretsRoot -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretEnvironmentPath -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $DigestKeyringPath -Force)
    if ((Get-Sha256 $SecretEnvironmentPath) -cne $SecretEnvironmentSha256 `
        -or (Get-Sha256 $DigestKeyringPath) -cne $DigestKeyringSha256) {
        Fail-Closed "GATE_F_PRIVATE_MATERIAL_HASH_DRIFT"
    }

    $secret = Get-Content -LiteralPath $SecretEnvironmentPath -Raw | ConvertFrom-Json
    $variableNames = @(
        "DEEPSEEK_API_KEY",
        "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
        "XW_M6_GATE_F_OPERATIONS_TOKEN",
        "XW_M6_LIVE_ENTRY_TOKEN"
    )
    if (-not (Test-ExactProperties $secret @("schemaId", "variables")) `
        -or [string]$secret.schemaId -cne "xw.runtime.control-plane-secret-environment.v1" `
        -or -not (Test-ExactProperties $secret.variables $variableNames)) {
        Fail-Closed "GATE_F_SECRET_ENVIRONMENT_INVALID"
    }
    $providerKey = [string]$secret.variables.DEEPSEEK_API_KEY
    $gateToken = [string]$secret.variables.XW_M6_GATE_F_OPERATIONS_TOKEN
    $liveToken = [string]$secret.variables.XW_M6_LIVE_ENTRY_TOKEN
    $accountHash = [string]$secret.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH
    if (-not (Test-PrivateValue $providerKey 8) `
        -or -not (Test-PrivateValue $gateToken 32) `
        -or -not (Test-PrivateValue $liveToken 32) `
        -or $accountHash -notmatch '^(?!0{64}$)[0-9a-f]{64}$' `
        -or [string]::Equals($gateToken, $liveToken, [StringComparison]::Ordinal) `
        -or [string]::Equals($gateToken, $providerKey, [StringComparison]::Ordinal) `
        -or [string]::Equals($liveToken, $providerKey, [StringComparison]::Ordinal)) {
        Fail-Closed "GATE_F_SECRET_ENVIRONMENT_INVALID"
    }

    $keyring = Get-Content -LiteralPath $DigestKeyringPath -Raw | ConvertFrom-Json
    $initialKeyring = Test-ExactProperties $keyring @("schemaId", "activeKeyId", "createdAt", "keys")
    $rotatedKeyring = Test-ExactProperties $keyring @("schemaId", "activeKeyId", "rotatedAt", "keys")
    $keyEntries = @($keyring.keys)
    if ((-not $initialKeyring -and -not $rotatedKeyring) `
        -or [string]$keyring.schemaId -cne "xw.digest-keyring.v1" `
        -or [string]$keyring.activeKeyId -notmatch '^[A-Za-z0-9-]{1,64}$' `
        -or $keyEntries.Count -lt 1 -or $keyEntries.Count -gt 256) {
        Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID"
    }
    $seenKeyIds = @{}
    $activeCount = 0
    $declaredActive = $false
    foreach ($entry in $keyEntries) {
        if (-not (Test-ExactProperties $entry @("keyId", "keyBase64", "algorithm", "status", "createdAt")) `
            -or [string]$entry.keyId -notmatch '^[A-Za-z0-9-]{1,64}$' `
            -or $seenKeyIds.ContainsKey([string]$entry.keyId) `
            -or [string]$entry.algorithm -cne "HMAC-SHA-256" `
            -or @("active", "retained") -notcontains [string]$entry.status) {
            Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID"
        }
        try { $keyBytes = [Convert]::FromBase64String([string]$entry.keyBase64) }
        catch { Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID" }
        if ($keyBytes.Length -ne 32 `
            -or [Convert]::ToBase64String($keyBytes) -cne [string]$entry.keyBase64) {
            Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID"
        }
        $seenKeyIds[[string]$entry.keyId] = $true
        if ([string]$entry.status -ceq "active") {
            $activeCount += 1
            if ([string]$entry.keyId -ceq [string]$keyring.activeKeyId) { $declaredActive = $true }
        }
    }
    if ($activeCount -ne 1 -or -not $declaredActive) { Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID" }

    [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $providerKey, "Process")
    [Environment]::SetEnvironmentVariable("XW_M6_GATE_F_OPERATIONS_TOKEN", $gateToken, "Process")
    [Environment]::SetEnvironmentVariable("XW_M6_LIVE_ENTRY_TOKEN", $liveToken, "Process")
    [Environment]::SetEnvironmentVariable("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", $accountHash, "Process")
    [Environment]::SetEnvironmentVariable("XHS_EVIDENCE_DIGEST_KEYRING_PATH", $DigestKeyringPath, "Process")
    $secret = $null
    $providerKey = $null
    $gateToken = $null
    $liveToken = $null
    $accountHash = $null
    $keyring = $null
    $keyBytes = $null
}

function Import-QualificationPrivateMaterial(
    [string]$SecretsRoot,
    [string]$SecretEnvironmentPath,
    [string]$SecretEnvironmentSha256,
    [string]$ExpectedGateTokenSha256,
    [string]$ExpectedAccountIsolationBindingHash
) {
    Assert-PlainDirectory $SecretsRoot "M6_QUALIFICATION_SECRETS_ROOT_INVALID"
    Assert-PlainFile $SecretEnvironmentPath "M6_QUALIFICATION_SECRET_ENVIRONMENT_INVALID"
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretsRoot -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretEnvironmentPath -Force)
    if ((Get-Sha256 $SecretEnvironmentPath) -cne $SecretEnvironmentSha256) {
        Fail-Closed "M6_QUALIFICATION_PRIVATE_MATERIAL_HASH_DRIFT"
    }

    $secret = Get-Content -LiteralPath $SecretEnvironmentPath -Raw | ConvertFrom-Json
    $variableNames = @(
        "DEEPSEEK_API_KEY",
        "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
        "XW_M6_GATE_F_OPERATIONS_TOKEN",
        "XW_M6_LIVE_ENTRY_TOKEN"
    )
    if (-not (Test-ExactProperties $secret @("schemaId", "variables")) `
        -or [string]$secret.schemaId -cne "xw.runtime.control-plane-secret-environment.v1" `
        -or -not (Test-ExactProperties $secret.variables $variableNames)) {
        Fail-Closed "M6_QUALIFICATION_SECRET_ENVIRONMENT_INVALID"
    }
    $gateToken = [string]$secret.variables.XW_M6_GATE_F_OPERATIONS_TOKEN
    $accountHash = [string]$secret.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH
    if (-not (Test-PrivateValue $gateToken 32) `
        -or -not (Test-Hash $ExpectedGateTokenSha256) `
        -or (Get-Utf8Sha256 $gateToken) -cne $ExpectedGateTokenSha256 `
        -or $accountHash -notmatch '^(?!0{64}$)[0-9a-f]{64}$' `
        -or $accountHash -cne $ExpectedAccountIsolationBindingHash) {
        Fail-Closed "M6_QUALIFICATION_PRIVATE_AUTHORITY_INVALID"
    }

    # The qualification listener receives only its two bounded authorities.
    # Provider, live-entry and task-bootstrap authority are removed even if the
    # parent process was polluted before Task Scheduler created this process.
    foreach ($name in @(
        "DEEPSEEK_API_KEY",
        "XW_M6_LIVE_ENTRY_TOKEN",
        "XHS_EVIDENCE_DIGEST_KEYRING_PATH",
        "XW_XHS_V3_TASK_BOOTSTRAP_ENABLED",
        "XW_XHS_RPA_TASK_BOOTSTRAP_ENABLED",
        "NODE_OPTIONS",
        "NODE_PATH"
    )) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    [Environment]::SetEnvironmentVariable("XW_M6_GATE_F_OPERATIONS_TOKEN", $gateToken, "Process")
    [Environment]::SetEnvironmentVariable("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", $accountHash, "Process")
    $secret = $null
    $gateToken = $null
    $accountHash = $null
}

function Invoke-ProviderClosureVerifier(
    $Manifest,
    [string]$ReleaseRoot,
    [string]$RuntimeEntryPath,
    [string]$RuntimeRoot,
    [string]$TrustedNodePath,
    [string]$TrustedNodeSha256,
    [string]$ProviderConfigPath,
    [string]$ProviderConfigSha256,
    [string]$ProviderBundleDigest
) {
    Assert-PlainFile $ProviderConfigPath "GATE_F_PROVIDER_CONFIG_INVALID"
    if ((Get-Sha256 $ProviderConfigPath) -cne $ProviderConfigSha256) {
        Fail-Closed "GATE_F_PROVIDER_CONFIG_HASH_DRIFT"
    }
    $trustedNode = $TrustedNodePath
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")
    Assert-PlainFile $trustedNode "GATE_F_TRUSTED_NODE_INVALID"
    if (-not (Test-SamePath $trustedNode "D:\Program Files\Node\node.exe") `
        -or (Get-Sha256 $trustedNode) -cne $TrustedNodeSha256) {
        Fail-Closed "GATE_F_TRUSTED_NODE_INVALID"
    }
    $trustedNodeVersion = [string](& $trustedNode -p "process.versions.node")
    if ($LASTEXITCODE -ne 0 -or $trustedNodeVersion.Trim() -cne [string]$Manifest.nodeVersion) {
        Fail-Closed "GATE_F_TRUSTED_NODE_INVALID"
    }

    $releaseLines = @(& $RuntimeEntryPath -RuntimeRoot $RuntimeRoot -VerifyReleaseOnly)
    $releaseText = ($releaseLines -join "`n").Trim()
    try { $releaseReceipt = $releaseText | ConvertFrom-Json }
    catch { Fail-Closed "GATE_F_RELEASE_VERIFICATION_RECEIPT_INVALID" }
    if (-not (Test-ExactProperties $releaseReceipt @("ok", "schemaId", "releaseRoot")) `
        -or [bool]$releaseReceipt.ok -ne $true `
        -or [string]$releaseReceipt.schemaId -cne "xw.runtime.m6-c1-immutable-release-verification.v1" `
        -or -not (Test-SamePath ([string]$releaseReceipt.releaseRoot) $ReleaseRoot)) {
        Fail-Closed "GATE_F_RELEASE_VERIFICATION_RECEIPT_INVALID"
    }
    $providerVerifierPath = Join-Path $ReleaseRoot "services\orchestrator\ops\xw-xhs-vision-pin.mjs"
    $providerVerifierRelative = "services/orchestrator/ops/xw-xhs-vision-pin.mjs"
    $providerVerifierHash = Get-ManifestEntryHash `
        $Manifest $providerVerifierRelative "GATE_F_PROVIDER_VERIFIER_INVALID"
    Assert-ManifestFile $Manifest $ReleaseRoot $providerVerifierPath `
        $providerVerifierRelative $providerVerifierHash "GATE_F_PROVIDER_VERIFIER_INVALID"

    $providerLines = @(& $trustedNode $providerVerifierPath verify)
    if ($LASTEXITCODE -ne 0) { Fail-Closed "GATE_F_PROVIDER_CLOSURE_INVALID" }
    $providerText = ($providerLines -join "`n").Trim()
    try { $providerReceipt = $providerText | ConvertFrom-Json }
    catch { Fail-Closed "GATE_F_PROVIDER_VERIFICATION_RECEIPT_INVALID" }
    if (-not (Test-ExactProperties $providerReceipt @("ok", "command", "configPath", "identity")) `
        -or [bool]$providerReceipt.ok -ne $true `
        -or [string]$providerReceipt.command -cne "verify" `
        -or -not (Test-SamePath ([string]$providerReceipt.configPath) $ProviderConfigPath) `
        -or [string]$providerReceipt.identity.provider.providerBundleDigest -cne $ProviderBundleDigest `
        -or (Get-Sha256 $ProviderConfigPath) -cne $ProviderConfigSha256) {
        Fail-Closed "GATE_F_PROVIDER_VERIFICATION_RECEIPT_INVALID"
    }
    [Environment]::SetEnvironmentVariable(
        "XHS_EXPLORATION_VISION_PROVIDER_CONFIG_PATH",
        $ProviderConfigPath,
        "Process"
    )
    [Environment]::SetEnvironmentVariable(
        "XHS_EXPLORATION_VISION_PROVIDER_BUNDLE_DIGEST",
        $ProviderBundleDigest,
        "Process"
    )
    $releaseReceipt = $null
    $providerReceipt = $null
    $providerText = $null
}

function Assert-FixedRuntimeBinding([string]$Path, [string]$ExpectedSha256, [string]$Code) {
    Assert-PlainFile $Path $Code
    if ((Get-Sha256 $Path) -cne $ExpectedSha256) { Fail-Closed $Code }
}

function Assert-ServeLaunchBinding(
    [string]$Path,
    [string]$Alias,
    [string]$RuntimeRoot,
    [string]$ReleaseId,
    [string]$SourceCommit
) {
    $serve = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if (-not (Test-ExactProperties $serve @(
            "schemaVersion", "runtimeRoot", "nodeExe", "releaseId", "sourceCommit", "deviceConfig", "alias"
        )) `
        -or [int]$serve.schemaVersion -ne 2 `
        -or [string]$serve.alias -cne $Alias `
        -or [string]$serve.releaseId -cne $ReleaseId `
        -or [string]$serve.sourceCommit -cne $SourceCommit `
        -or -not (Test-SamePath ([string]$serve.runtimeRoot) $RuntimeRoot) `
        -or -not (Test-SamePath ([string]$serve.nodeExe) "D:\Program Files\Node\node.exe") `
        -or -not (Test-SamePath ([string]$serve.deviceConfig) (Join-Path $RuntimeRoot "secrets\control-plane.devices.json"))) {
        Fail-Closed ("GATE_F_SERVE_" + $Alias + "_BINDING_INVALID")
    }
}

function Assert-FixedRuntimeSemanticBindings(
    [string]$M6FinalPath,
    [string]$Serve03Path,
    [string]$Serve04Path,
    [string]$RuntimeRoot,
    [string]$ReleaseRoot,
    [string]$ReleaseId,
    [string]$SourceCommit,
    [string]$ReleaseManifestSha256
) {
    $m6 = Get-Content -LiteralPath $M6FinalPath -Raw | ConvertFrom-Json
    $m6Keys = @(
        "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
        "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
        "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
        "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
        "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
        "targetEnvironmentAttestationPath", "targetEnvironmentAttestationHash",
        "environmentQualificationPath", "environmentQualificationSha256",
        "productionDependencyBindingPath", "productionDependencyBindingHash"
    )
    if (-not (Test-ExactProperties $m6 $m6Keys) `
        -or [string]$m6.schemaId -cne "xw.runtime.m6-c1-runtime.v1" `
        -or [string]$m6.releaseId -cne $ReleaseId `
        -or [string]$m6.sourceCommit -cne $SourceCommit `
        -or -not (Test-SamePath ([string]$m6.sourceReleaseRoot) $ReleaseRoot) `
        -or [string]$m6.releaseManifestSha256 -cne $ReleaseManifestSha256 `
        -or [string]$m6.providerBaseUrl -cne "https://api.deepseek.com" `
        -or [string]$m6.gateId -notmatch '^[A-Za-z0-9._-]{1,128}$') {
        Fail-Closed "GATE_F_M6_FINAL_BINDING_INVALID"
    }
    foreach ($name in @(
        "dependencyRoot", "modelProfileRoot", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot",
        "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath", "gateFArtifactCatalogPath",
        "targetEnvironmentAttestationPath", "environmentQualificationPath", "productionDependencyBindingPath"
    )) {
        if (-not [IO.Path]::IsPathRooted([string]$m6.$name)) {
            Fail-Closed "GATE_F_M6_FINAL_BINDING_INVALID"
        }
    }
    foreach ($name in @(
        "dependencyLayerHash", "modelProfileHash", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
        "targetEnvironmentAttestationHash", "environmentQualificationSha256", "productionDependencyBindingHash"
    )) {
        if (-not (Test-Hash ([string]$m6.$name))) { Fail-Closed "GATE_F_M6_FINAL_BINDING_INVALID" }
    }
    Assert-ServeLaunchBinding $Serve03Path "03" $RuntimeRoot $ReleaseId $SourceCommit
    Assert-ServeLaunchBinding $Serve04Path "04" $RuntimeRoot $ReleaseId $SourceCommit
}

$runtimeRootFull = Resolve-AbsolutePath $RuntimeRoot "GATE_F_RUNTIME_ROOT_INVALID"
$bindingPathFull = Resolve-AbsolutePath $IdentityBindingPath "GATE_F_LAUNCHER_BINDING_PATH_INVALID"
$launcherPathFull = Resolve-AbsolutePath $PSCommandPath "GATE_F_LAUNCHER_PATH_INVALID"
Assert-PlainDirectory $runtimeRootFull "GATE_F_RUNTIME_ROOT_INVALID"
Assert-PlainFile $bindingPathFull "GATE_F_LAUNCHER_BINDING_INVALID"
Assert-PlainFile $launcherPathFull "GATE_F_LAUNCHER_BODY_INVALID"

$bindingHash = Get-Sha256 $bindingPathFull
$launcherHash = Get-Sha256 $launcherPathFull
if ($bindingHash -cne $ExpectedBindingSha256 `
    -or $launcherHash -cne $ExpectedLauncherSha256 `
    -or [IO.Path]::GetFileName((Split-Path -Parent $bindingPathFull)) -cne $ExpectedBindingSha256 `
    -or [IO.Path]::GetFileName((Split-Path -Parent $launcherPathFull)) -cne $ExpectedLauncherSha256 `
    -or [IO.Path]::GetFileName($bindingPathFull) -cne "control-plane-launcher-binding.v1.json" `
    -or [IO.Path]::GetFileName($launcherPathFull) -cne "launch-control-plane.ps1") {
    Fail-Closed "GATE_F_CONTENT_ADDRESS_INVALID"
}

$binding = Get-Content -LiteralPath $bindingPathFull -Raw | ConvertFrom-Json
if ($Mode -ceq "QUALIFICATION_ONLY") {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $currentSid -or [string]$currentSid.Value -cne "S-1-5-18") {
        Fail-Closed "M6_QUALIFICATION_SYSTEM_IDENTITY_REQUIRED"
    }
    $qualificationKeys = @(
        "accountIsolationBindingHash", "contractPath", "contractSha256", "currentPath",
        "gateOperationsTokenSha256", "launcherPath", "launcherSha256", "launcherSourcePath",
        "launcherSourceSha256", "mode", "qualificationRuntimeBindingPath",
        "qualificationRuntimeBindingSha256", "releaseId", "releaseManifestPath",
        "releaseManifestSha256", "releaseRoot", "runtimeEntryPath", "runtimeEntrySha256",
        "runtimeRoot", "schemaId", "secretEnvironmentPath", "secretEnvironmentSha256",
        "sourceCommit", "taskName", "trustedNodePath", "trustedNodeSha256"
    )
    if (-not (Test-ExactProperties $binding $qualificationKeys) `
        -or [string]$binding.schemaId -cne "xw.runtime.m6-qualification-control-plane-launcher-binding.v1" `
        -or [string]$binding.taskName -cne "XW Platform M6 Qualification" `
        -or [string]$binding.mode -cne "QUALIFICATION_ONLY" `
        -or [string]$binding.releaseId -cne $ExpectedReleaseId `
        -or [string]$binding.sourceCommit -cne $ExpectedSourceCommit `
        -or -not (Test-SourceCommit ([string]$binding.sourceCommit)) `
        -or [string]$binding.launcherSha256 -cne $ExpectedLauncherSha256 `
        -or [string]$binding.launcherSourceSha256 -cne $ExpectedLauncherSha256 `
        -or -not (Test-Hash ([string]$binding.releaseManifestSha256)) `
        -or -not (Test-Hash ([string]$binding.runtimeEntrySha256)) `
        -or -not (Test-Hash ([string]$binding.contractSha256)) `
        -or -not (Test-Hash ([string]$binding.secretEnvironmentSha256)) `
        -or -not (Test-Hash ([string]$binding.qualificationRuntimeBindingSha256)) `
        -or -not (Test-Hash ([string]$binding.gateOperationsTokenSha256)) `
        -or [string]$binding.accountIsolationBindingHash -notmatch '^(?!0{64}$)[0-9a-f]{64}$' `
        -or -not (Test-Hash ([string]$binding.trustedNodeSha256))) {
        Fail-Closed "M6_QUALIFICATION_LAUNCHER_BINDING_INVALID"
    }

    $boundRuntimeRoot = Resolve-AbsolutePath ([string]$binding.runtimeRoot) "M6_QUALIFICATION_RUNTIME_ROOT_INVALID"
    $currentPath = Resolve-AbsolutePath ([string]$binding.currentPath) "M6_QUALIFICATION_CURRENT_RELEASE_INVALID"
    $releaseRoot = Resolve-AbsolutePath ([string]$binding.releaseRoot) "M6_QUALIFICATION_RELEASE_ROOT_INVALID"
    $manifestPath = Resolve-AbsolutePath ([string]$binding.releaseManifestPath) "M6_QUALIFICATION_RELEASE_MANIFEST_INVALID"
    $launcherSourcePath = Resolve-AbsolutePath ([string]$binding.launcherSourcePath) "M6_QUALIFICATION_LAUNCHER_SOURCE_INVALID"
    $runtimeEntryPath = Resolve-AbsolutePath ([string]$binding.runtimeEntryPath) "M6_QUALIFICATION_RUNTIME_ENTRY_INVALID"
    $contractPath = Resolve-AbsolutePath ([string]$binding.contractPath) "M6_QUALIFICATION_RUNTIME_CONTRACT_INVALID"
    $secretEnvironmentPath = Resolve-AbsolutePath ([string]$binding.secretEnvironmentPath) "M6_QUALIFICATION_SECRET_ENVIRONMENT_INVALID"
    $qualificationBindingPath = Resolve-AbsolutePath ([string]$binding.qualificationRuntimeBindingPath) "M6_QUALIFICATION_RUNTIME_BINDING_INVALID"
    $trustedNodePath = Resolve-AbsolutePath ([string]$binding.trustedNodePath) "M6_QUALIFICATION_TRUSTED_NODE_INVALID"
    $expectedBindingPath = Join-Path $runtimeRootFull "qualification-launcher-bindings\$ExpectedBindingSha256\control-plane-launcher-binding.v1.json"
    $expectedLauncherPath = Join-Path $runtimeRootFull "launchers\$ExpectedLauncherSha256\launch-control-plane.ps1"
    if (-not (Test-SamePath $runtimeRootFull $boundRuntimeRoot) `
        -or -not (Test-SamePath $bindingPathFull $expectedBindingPath) `
        -or -not (Test-SamePath $launcherPathFull $expectedLauncherPath) `
        -or -not (Test-SamePath $currentPath (Join-Path $runtimeRootFull "current")) `
        -or -not (Test-SamePath $launcherPathFull ([string]$binding.launcherPath)) `
        -or -not (Test-SamePath $secretEnvironmentPath (Join-Path $runtimeRootFull "secrets\control-plane-secret-environment.v1.json")) `
        -or -not (Test-SamePath $qualificationBindingPath (Join-Path $runtimeRootFull "config\m6-c1-qualification-bootstrap.v1.json")) `
        -or -not (Test-SamePath $trustedNodePath "D:\Program Files\Node\node.exe") `
        -or -not (Test-Within (Join-Path $runtimeRootFull "releases") $releaseRoot) `
        -or [IO.Path]::GetFileName($releaseRoot) -cne $ExpectedReleaseId) {
        Fail-Closed "M6_QUALIFICATION_RELEASE_BINDING_INVALID"
    }
    Assert-PlainDirectory (Join-Path $runtimeRootFull "releases") "M6_QUALIFICATION_RELEASES_ROOT_INVALID"
    $currentItem = Get-Item -LiteralPath $currentPath -Force
    if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Fail-Closed "M6_QUALIFICATION_CURRENT_RELEASE_INVALID"
    }
    $currentTarget = @($currentItem.Target)[0]
    if ([string]::IsNullOrWhiteSpace([string]$currentTarget)) {
        Fail-Closed "M6_QUALIFICATION_CURRENT_RELEASE_INVALID"
    }
    if (-not [IO.Path]::IsPathRooted([string]$currentTarget)) {
        $currentTarget = Join-Path (Split-Path -Parent $currentPath) ([string]$currentTarget)
    }
    if (-not (Test-SamePath $currentTarget $releaseRoot)) {
        Fail-Closed "M6_QUALIFICATION_CURRENT_RELEASE_INVALID"
    }
    Assert-PlainDirectory $releaseRoot "M6_QUALIFICATION_RELEASE_ROOT_INVALID"

    if (-not (Test-SamePath $manifestPath (Join-Path $releaseRoot "release-manifest.v1.json"))) {
        Fail-Closed "M6_QUALIFICATION_RELEASE_MANIFEST_INVALID"
    }
    Assert-PlainFile $manifestPath "M6_QUALIFICATION_RELEASE_MANIFEST_INVALID"
    if ((Get-Sha256 $manifestPath) -cne [string]$binding.releaseManifestSha256) {
        Fail-Closed "M6_QUALIFICATION_RELEASE_MANIFEST_INVALID"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.schemaId -cne "xw.runtime.release-manifest.v1" `
        -or [string]$manifest.releaseId -cne $ExpectedReleaseId `
        -or [string]$manifest.sourceCommit -cne $ExpectedSourceCommit `
        -or -not (Test-SourceCommit ([string]$manifest.sourceCommit))) {
        Fail-Closed "M6_QUALIFICATION_SOURCE_IDENTITY_MISMATCH"
    }
    Assert-ManifestFile $manifest $releaseRoot $launcherSourcePath `
        "services/control-plane/ops/launch-control-plane.ps1" `
        ([string]$binding.launcherSourceSha256) "M6_QUALIFICATION_LAUNCHER_SOURCE_INVALID"
    Assert-ManifestFile $manifest $releaseRoot $runtimeEntryPath `
        "services/control-plane/scripts/xw-control-plane-runtime.ps1" `
        ([string]$binding.runtimeEntrySha256) "M6_QUALIFICATION_RUNTIME_ENTRY_INVALID"
    Assert-ManifestFile $manifest $releaseRoot $contractPath `
        "config/runtime/xw-runtime.v1.json" `
        ([string]$binding.contractSha256) "M6_QUALIFICATION_RUNTIME_CONTRACT_INVALID"

    Assert-PlainFile $qualificationBindingPath "M6_QUALIFICATION_RUNTIME_BINDING_INVALID"
    if ((Get-Sha256 $qualificationBindingPath) -cne [string]$binding.qualificationRuntimeBindingSha256) {
        Fail-Closed "M6_QUALIFICATION_RUNTIME_BINDING_DRIFT"
    }
    $qualification = Get-Content -LiteralPath $qualificationBindingPath -Raw | ConvertFrom-Json
    $qualificationRuntimeKeys = @(
        "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
        "gateId", "gateIssuerAllowlistPath", "gateFArtifactInventoryPath", "gateFArtifactInventoryHash"
    )
    $gateIssuerPath = Join-Path $runtimeRootFull "m6-gate\issuer-keys.json"
    $inventoryPath = Join-Path $runtimeRootFull "qualification-bootstrap\final-inventory-unavailable.json"
    $liveOwnerKeysPath = Join-Path $runtimeRootFull "qualification-bootstrap\live-window-owner-keys-unavailable.json"
    $inventorySentinelHash = Get-Utf8Sha256 "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1"
    if (-not (Test-ExactProperties $qualification $qualificationRuntimeKeys) `
        -or [string]$qualification.schemaId -cne "xw.runtime.m6-c1-qualification-bootstrap.v1" `
        -or [string]$qualification.releaseId -cne $ExpectedReleaseId `
        -or [string]$qualification.sourceCommit -cne $ExpectedSourceCommit `
        -or -not (Test-SamePath ([string]$qualification.sourceReleaseRoot) $releaseRoot) `
        -or [string]$qualification.releaseManifestSha256 -cne [string]$binding.releaseManifestSha256 `
        -or [string]$qualification.gateId -notmatch '^[A-Za-z0-9._-]{1,128}$' `
        -or -not (Test-SamePath ([string]$qualification.gateIssuerAllowlistPath) $gateIssuerPath) `
        -or -not (Test-SamePath ([string]$qualification.gateFArtifactInventoryPath) $inventoryPath) `
        -or [string]$qualification.gateFArtifactInventoryHash -cne $inventorySentinelHash `
        -or (Test-Path -LiteralPath $inventoryPath) `
        -or (Test-Path -LiteralPath $liveOwnerKeysPath)) {
        Fail-Closed "M6_QUALIFICATION_RUNTIME_BINDING_INVALID"
    }
    Assert-PlainFile $gateIssuerPath "M6_QUALIFICATION_GATE_ISSUER_INVALID"
    Assert-PlainFile $trustedNodePath "M6_QUALIFICATION_TRUSTED_NODE_INVALID"
    if ((Get-Sha256 $trustedNodePath) -cne [string]$binding.trustedNodeSha256) {
        Fail-Closed "M6_QUALIFICATION_TRUSTED_NODE_INVALID"
    }
    $trustedNodeVersion = [string](& $trustedNodePath -p "process.versions.node")
    if ($LASTEXITCODE -ne 0 -or $trustedNodeVersion.Trim() -cne [string]$manifest.nodeVersion) {
        Fail-Closed "M6_QUALIFICATION_TRUSTED_NODE_INVALID"
    }

    Import-QualificationPrivateMaterial `
        (Join-Path $runtimeRootFull "secrets") `
        $secretEnvironmentPath `
        ([string]$binding.secretEnvironmentSha256) `
        ([string]$binding.gateOperationsTokenSha256) `
        ([string]$binding.accountIsolationBindingHash)

    # Hashtable splat is mandatory here: array splatting binds positionally, so
    # "-ContractPath" would land in $Mode and fail its ValidateSet.
    $delegateArguments = @{
        RuntimeRoot  = $runtimeRootFull
        ContractPath = $contractPath
        Mode         = "QUALIFICATION_ONLY"
    }
    if ($ValidateOnly) {
        $delegateArguments.ValidateOnly = $true
        $delegateLines = @(& $runtimeEntryPath @delegateArguments)
        $delegateText = ($delegateLines -join "`n").Trim()
        try { $delegateReceipt = $delegateText | ConvertFrom-Json }
        catch { Fail-Closed "M6_QUALIFICATION_DELEGATE_RECEIPT_INVALID" }
        $routeSet = @($delegateReceipt.routeSet | ForEach-Object { [string]$_ }) -join "`0"
        $expectedRoutes = @(
            "health", "gate-status", "alias01-device-binding",
            "qualification-job-submit", "qualification-job-status"
        ) -join "`0"
        if ($null -eq $delegateReceipt `
            -or [bool]$delegateReceipt.ok -ne $true `
            -or [string]$delegateReceipt.runtimeMode -cne "QUALIFICATION_ONLY" `
            -or $routeSet -cne $expectedRoutes `
            -or [string]$delegateReceipt.gateFArtifactInventory -cne "deliberately-unavailable-for-mutations") {
            Fail-Closed "M6_QUALIFICATION_DELEGATE_RECEIPT_INVALID"
        }
        foreach ($secretName in @(
            "XW_M6_GATE_F_OPERATIONS_TOKEN",
            "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH"
        )) {
            $secretValue = [Environment]::GetEnvironmentVariable($secretName, "Process")
            if (-not [string]::IsNullOrEmpty($secretValue) `
                -and $delegateText.IndexOf($secretValue, [StringComparison]::Ordinal) -ge 0) {
                Fail-Closed "M6_QUALIFICATION_DELEGATE_SECRET_OUTPUT_FORBIDDEN"
            }
        }
        [ordered]@{
            ok = $true
            schemaId = "xw.runtime.m6-qualification-control-plane-launcher-validation.v1"
            runtimeMode = "QUALIFICATION_ONLY"
            releaseId = $ExpectedReleaseId
            sourceCommit = $ExpectedSourceCommit
            launcherSha256 = $ExpectedLauncherSha256
            bindingSha256 = $ExpectedBindingSha256
            privateMaterial = [ordered]@{
                secretEnvironmentSha256 = [string]$binding.secretEnvironmentSha256
                gateOperationsToken = "hash-bound"
                accountIsolation = "hash-bound"
            }
            delegate = $delegateReceipt
        } | ConvertTo-Json -Depth 10
        return
    }
    & $runtimeEntryPath @delegateArguments
    return
}

$bindingKeys = @(
    "contractPath", "contractSha256", "currentPath", "launcherPath", "launcherSha256",
    "launcherSourcePath", "launcherSourceSha256", "mode", "releaseId", "releaseManifestPath",
    "releaseManifestSha256", "releaseRoot", "runtimeEntryPath", "runtimeEntrySha256",
    "runtimeRoot", "schemaId", "sourceCommit", "taskName",
    "secretEnvironmentPath", "secretEnvironmentSha256", "digestKeyringPath", "digestKeyringSha256",
    "providerConfigPath", "providerConfigSha256", "providerBundleDigest",
    "m6FinalBindingPath", "m6FinalBindingSha256",
    "serveLaunch03Path", "serveLaunch03Sha256", "serveLaunch04Path", "serveLaunch04Sha256",
    "trustedNodePath", "trustedNodeSha256"
)
if (-not (Test-ExactProperties $binding $bindingKeys) `
    -or [string]$binding.schemaId -cne "xw.runtime.control-plane-launcher-binding.v1" `
    -or [string]$binding.taskName -cne "XW Platform Control Plane" `
    -or [string]$binding.mode -cne "FINAL" `
    -or [string]$binding.releaseId -cne $ExpectedReleaseId `
    -or [string]$binding.sourceCommit -cne $ExpectedSourceCommit `
    -or -not (Test-SourceCommit ([string]$binding.sourceCommit)) `
    -or [string]$binding.launcherSha256 -cne $ExpectedLauncherSha256 `
    -or [string]$binding.launcherSourceSha256 -cne $ExpectedLauncherSha256 `
    -or -not (Test-Hash ([string]$binding.releaseManifestSha256)) `
    -or -not (Test-Hash ([string]$binding.runtimeEntrySha256)) `
    -or -not (Test-Hash ([string]$binding.contractSha256)) `
    -or -not (Test-Hash ([string]$binding.secretEnvironmentSha256)) `
    -or -not (Test-Hash ([string]$binding.digestKeyringSha256)) `
    -or -not (Test-Hash ([string]$binding.providerConfigSha256)) `
    -or -not (Test-Hash ([string]$binding.providerBundleDigest)) `
    -or -not (Test-Hash ([string]$binding.m6FinalBindingSha256)) `
    -or -not (Test-Hash ([string]$binding.serveLaunch03Sha256)) `
    -or -not (Test-Hash ([string]$binding.serveLaunch04Sha256)) `
    -or -not (Test-Hash ([string]$binding.trustedNodeSha256))) {
    Fail-Closed "GATE_F_LAUNCHER_BINDING_INVALID"
}

$boundRuntimeRoot = Resolve-AbsolutePath ([string]$binding.runtimeRoot) "GATE_F_RUNTIME_ROOT_INVALID"
$currentPath = Resolve-AbsolutePath ([string]$binding.currentPath) "GATE_F_CURRENT_RELEASE_INVALID"
$releaseRoot = Resolve-AbsolutePath ([string]$binding.releaseRoot) "GATE_F_RELEASE_ROOT_INVALID"
$manifestPath = Resolve-AbsolutePath ([string]$binding.releaseManifestPath) "GATE_F_RELEASE_MANIFEST_INVALID"
$launcherSourcePath = Resolve-AbsolutePath ([string]$binding.launcherSourcePath) "GATE_F_LAUNCHER_SOURCE_INVALID"
$runtimeEntryPath = Resolve-AbsolutePath ([string]$binding.runtimeEntryPath) "GATE_F_RUNTIME_ENTRY_INVALID"
$contractPath = Resolve-AbsolutePath ([string]$binding.contractPath) "GATE_F_RUNTIME_CONTRACT_INVALID"
$secretEnvironmentPath = Resolve-AbsolutePath ([string]$binding.secretEnvironmentPath) "GATE_F_SECRET_ENVIRONMENT_INVALID"
$digestKeyringPath = Resolve-AbsolutePath ([string]$binding.digestKeyringPath) "GATE_F_DIGEST_KEYRING_INVALID"
$providerConfigPath = Resolve-AbsolutePath ([string]$binding.providerConfigPath) "GATE_F_PROVIDER_CONFIG_INVALID"
$m6FinalBindingPath = Resolve-AbsolutePath ([string]$binding.m6FinalBindingPath) "GATE_F_M6_FINAL_BINDING_INVALID"
$serveLaunch03Path = Resolve-AbsolutePath ([string]$binding.serveLaunch03Path) "GATE_F_SERVE_03_BINDING_INVALID"
$serveLaunch04Path = Resolve-AbsolutePath ([string]$binding.serveLaunch04Path) "GATE_F_SERVE_04_BINDING_INVALID"
$trustedNodePath = Resolve-AbsolutePath ([string]$binding.trustedNodePath) "GATE_F_TRUSTED_NODE_INVALID"
$expectedBindingPath = Join-Path $runtimeRootFull "launcher-bindings\$ExpectedBindingSha256\control-plane-launcher-binding.v1.json"
$expectedLauncherPath = Join-Path $runtimeRootFull "launchers\$ExpectedLauncherSha256\launch-control-plane.ps1"
if (-not (Test-SamePath $runtimeRootFull $boundRuntimeRoot) `
    -or -not (Test-SamePath $bindingPathFull $expectedBindingPath) `
    -or -not (Test-SamePath $launcherPathFull $expectedLauncherPath) `
    -or -not (Test-SamePath $currentPath (Join-Path $runtimeRootFull "current")) `
    -or -not (Test-SamePath $launcherPathFull ([string]$binding.launcherPath)) `
    -or -not (Test-SamePath $secretEnvironmentPath (Join-Path $runtimeRootFull "secrets\control-plane-secret-environment.v1.json")) `
    -or -not (Test-SamePath $digestKeyringPath (Join-Path $runtimeRootFull "secrets\xhs-evidence-digest-keyring.v1.json")) `
    -or -not (Test-SamePath $providerConfigPath (Join-Path $runtimeRootFull "state\orchestrator\xhs-exploration-vision-provider.v1.json")) `
    -or -not (Test-SamePath $m6FinalBindingPath (Join-Path $runtimeRootFull "config\m6-c1-runtime.v1.json")) `
    -or -not (Test-SamePath $serveLaunch03Path (Join-Path $runtimeRootFull "state\control-plane\fast-operator\serve-launch-03.json")) `
    -or -not (Test-SamePath $serveLaunch04Path (Join-Path $runtimeRootFull "state\control-plane\fast-operator\serve-launch-04.json")) `
    -or -not (Test-SamePath $trustedNodePath "D:\Program Files\Node\node.exe") `
    -or -not (Test-Within (Join-Path $runtimeRootFull "releases") $releaseRoot) `
    -or [IO.Path]::GetFileName($releaseRoot) -cne $ExpectedReleaseId) {
    Fail-Closed "GATE_F_RELEASE_BINDING_INVALID"
}
Assert-PlainDirectory (Join-Path $runtimeRootFull "releases") "GATE_F_RELEASES_ROOT_INVALID"

$currentItem = Get-Item -LiteralPath $currentPath -Force
if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    Fail-Closed "GATE_F_CURRENT_RELEASE_INVALID"
}
$currentTarget = @($currentItem.Target)[0]
if ([string]::IsNullOrWhiteSpace([string]$currentTarget)) { Fail-Closed "GATE_F_CURRENT_RELEASE_INVALID" }
if (-not [IO.Path]::IsPathRooted([string]$currentTarget)) {
    $currentTarget = Join-Path (Split-Path -Parent $currentPath) ([string]$currentTarget)
}
if (-not (Test-SamePath $currentTarget $releaseRoot)) { Fail-Closed "GATE_F_CURRENT_RELEASE_INVALID" }
Assert-PlainDirectory $releaseRoot "GATE_F_RELEASE_ROOT_INVALID"

if (-not (Test-SamePath $manifestPath (Join-Path $releaseRoot "release-manifest.v1.json"))) {
    Fail-Closed "GATE_F_RELEASE_MANIFEST_INVALID"
}
Assert-PlainFile $manifestPath "GATE_F_RELEASE_MANIFEST_INVALID"
if ((Get-Sha256 $manifestPath) -cne [string]$binding.releaseManifestSha256) {
    Fail-Closed "GATE_F_RELEASE_MANIFEST_INVALID"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]$manifest.schemaId -cne "xw.runtime.release-manifest.v1" `
    -or [string]$manifest.releaseId -cne $ExpectedReleaseId `
    -or [string]$manifest.sourceCommit -cne $ExpectedSourceCommit `
    -or -not (Test-SourceCommit ([string]$manifest.sourceCommit))) {
    Fail-Closed "GATE_F_SOURCE_IDENTITY_MISMATCH"
}

Assert-ManifestFile $manifest $releaseRoot $launcherSourcePath `
    "services/control-plane/ops/launch-control-plane.ps1" `
    ([string]$binding.launcherSourceSha256) "GATE_F_LAUNCHER_SOURCE_INVALID"
Assert-ManifestFile $manifest $releaseRoot $runtimeEntryPath `
    "services/control-plane/scripts/xw-control-plane-runtime.ps1" `
    ([string]$binding.runtimeEntrySha256) "GATE_F_RUNTIME_ENTRY_INVALID"
Assert-ManifestFile $manifest $releaseRoot $contractPath `
    "config/runtime/xw-runtime.v1.json" `
    ([string]$binding.contractSha256) "GATE_F_RUNTIME_CONTRACT_INVALID"

Assert-FixedRuntimeBinding `
    $m6FinalBindingPath ([string]$binding.m6FinalBindingSha256) "GATE_F_M6_FINAL_BINDING_DRIFT"
Assert-FixedRuntimeBinding `
    $serveLaunch03Path ([string]$binding.serveLaunch03Sha256) "GATE_F_SERVE_03_BINDING_DRIFT"
Assert-FixedRuntimeBinding `
    $serveLaunch04Path ([string]$binding.serveLaunch04Sha256) "GATE_F_SERVE_04_BINDING_DRIFT"
Assert-FixedRuntimeSemanticBindings `
    $m6FinalBindingPath $serveLaunch03Path $serveLaunch04Path `
    $runtimeRootFull $releaseRoot $ExpectedReleaseId $ExpectedSourceCommit `
    ([string]$binding.releaseManifestSha256)

Invoke-ProviderClosureVerifier `
    $manifest `
    $releaseRoot `
    $runtimeEntryPath `
    $runtimeRootFull `
    $trustedNodePath `
    ([string]$binding.trustedNodeSha256) `
    $providerConfigPath `
    ([string]$binding.providerConfigSha256) `
    ([string]$binding.providerBundleDigest)
Import-ControlPlanePrivateMaterial `
    (Join-Path $runtimeRootFull "secrets") `
    $secretEnvironmentPath `
    ([string]$binding.secretEnvironmentSha256) `
    $digestKeyringPath `
    ([string]$binding.digestKeyringSha256)

# Non-secret, already-verified identity tuple consumed by the in-process XHS
# V3 task bootstrap. No task argument, shell caller, or business request can
# choose these values. The runtime entry hash is the caller-path identity.
[Environment]::SetEnvironmentVariable("XW_XHS_V3_TASK_BOOTSTRAP_ENABLED", "1", "Process")
[Environment]::SetEnvironmentVariable("XW_XHS_RPA_TASK_BOOTSTRAP_ENABLED", "1", "Process")
[Environment]::SetEnvironmentVariable("XW_XHS_V3_TASK_NAME", "XW Platform Control Plane", "Process")
[Environment]::SetEnvironmentVariable("XW_XHS_V3_TASK_BINDING_HASH", $ExpectedBindingSha256, "Process")
[Environment]::SetEnvironmentVariable("XW_XHS_V3_LAUNCHER_HASH", $ExpectedLauncherSha256, "Process")
[Environment]::SetEnvironmentVariable(
    "XW_XHS_V3_CALLER_PATH_HASH",
    [string]$binding.runtimeEntrySha256,
    "Process"
)
[Environment]::SetEnvironmentVariable("XW_XHS_V3_RELEASE_ID", $ExpectedReleaseId, "Process")
[Environment]::SetEnvironmentVariable("XW_XHS_V3_SOURCE_COMMIT", $ExpectedSourceCommit, "Process")
[Environment]::SetEnvironmentVariable(
    "XW_XHS_V3_PROVIDER_CONFIG_SHA256",
    [string]$binding.providerConfigSha256,
    "Process"
)
[Environment]::SetEnvironmentVariable(
    "XW_XHS_V3_DIGEST_KEYRING_SHA256",
    [string]$binding.digestKeyringSha256,
    "Process"
)

# Hashtable splat is mandatory here: array splatting binds positionally, so
# "-ContractPath" would land in $Mode and fail its ValidateSet.
$delegateArguments = @{
    RuntimeRoot  = $runtimeRootFull
    ContractPath = $contractPath
    Mode         = "FINAL"
}
if ($ValidateOnly) {
    $delegateArguments.ValidateOnly = $true
    $delegateLines = @(& $runtimeEntryPath @delegateArguments)
    $delegateText = ($delegateLines -join "`n").Trim()
    try { $delegateReceipt = $delegateText | ConvertFrom-Json }
    catch { Fail-Closed "GATE_F_DELEGATE_VALIDATION_RECEIPT_INVALID" }
    if ($null -eq $delegateReceipt -or [bool]$delegateReceipt.ok -ne $true) {
        Fail-Closed "GATE_F_DELEGATE_VALIDATION_RECEIPT_INVALID"
    }
    foreach ($secretName in @(
        "DEEPSEEK_API_KEY",
        "XW_M6_GATE_F_OPERATIONS_TOKEN",
        "XW_M6_LIVE_ENTRY_TOKEN",
        "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH"
    )) {
        $secretValue = [Environment]::GetEnvironmentVariable($secretName, "Process")
        if (-not [string]::IsNullOrEmpty($secretValue) `
            -and $delegateText.IndexOf($secretValue, [StringComparison]::Ordinal) -ge 0) {
            Fail-Closed "GATE_F_DELEGATE_SECRET_OUTPUT_FORBIDDEN"
        }
    }
    [ordered]@{
        ok = $true
        schemaId = "xw.runtime.control-plane-launcher-validation.v1"
        releaseId = $ExpectedReleaseId
        sourceCommit = $ExpectedSourceCommit
        launcherSha256 = $ExpectedLauncherSha256
        bindingSha256 = $ExpectedBindingSha256
        privateMaterial = [ordered]@{
            secretEnvironment = [ordered]@{
                sha256 = [string]$binding.secretEnvironmentSha256
                requiredEnvironment = [ordered]@{
                    DEEPSEEK_API_KEY = "present"
                    XW_M6_GATE_F_OPERATIONS_TOKEN = "present"
                    XW_M6_LIVE_ENTRY_TOKEN = "present"
                    XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "present"
                }
            }
            digestKeyring = [ordered]@{
                sha256 = [string]$binding.digestKeyringSha256
                activeKeyId = "present"
                keyMaterial = "present"
            }
        }
        provider = [ordered]@{
            configSha256 = [string]$binding.providerConfigSha256
            providerBundleDigest = [string]$binding.providerBundleDigest
            closure = "verified"
        }
        fixedRuntimeBindings = [ordered]@{
            m6FinalSha256 = [string]$binding.m6FinalBindingSha256
            serveLaunch03Sha256 = [string]$binding.serveLaunch03Sha256
            serveLaunch04Sha256 = [string]$binding.serveLaunch04Sha256
        }
        trustedNode = [ordered]@{
            sha256 = [string]$binding.trustedNodeSha256
        }
        delegate = $delegateReceipt
    } | ConvertTo-Json -Depth 12
    return
}
& $runtimeEntryPath @delegateArguments
