param(
    [ValidateSet("Provision", "Verify")]
    [string]$Mode = "Verify",
    [string]$RuntimeRoot = "C:\Users\Public\xw-runtime"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Keep this bootstrap ASCII-only for Windows PowerShell 5.1.

$SecretSchemaId = "xw.runtime.control-plane-secret-environment.v1"
$KeyringSchemaId = "xw.digest-keyring.v1"
$SecretFilename = "control-plane-secret-environment.v1.json"
$KeyringFilename = "xhs-evidence-digest-keyring.v1.json"
$SystemSidValue = "S-1-5-18"
$AdministratorsSidValue = "S-1-5-32-544"
$ExpectedVariables = @(
    "DEEPSEEK_API_KEY",
    "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
    "XW_M6_GATE_F_OPERATIONS_TOKEN",
    "XW_M6_LIVE_ENTRY_TOKEN"
)

function Fail-Closed([string]$Code) {
    throw $Code
}

function Assert-ElevatedAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Fail-Closed "GATE_F_PROVISION_ELEVATION_REQUIRED"
        }
    } catch { Fail-Closed "GATE_F_PROVISION_ELEVATION_REQUIRED" }
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

function Test-Within([string]$Root, [string]$Candidate) {
    try {
        $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        $candidateFull = [IO.Path]::GetFullPath($Candidate)
        return $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Assert-PlainDirectory([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Assert-PlainFile([string]$Path, [string]$Code) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail-Closed $Code }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Closed $Code }
}

function Get-Sha256([string]$Path) {
    Assert-PlainFile $Path "GATE_F_PRIVATE_MATERIAL_INVALID"
    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
}

function New-RandomBytes([int]$Count) {
    if ($Count -lt 1 -or $Count -gt 4096) { Fail-Closed "GATE_F_RANDOM_REQUEST_INVALID" }
    $bytes = New-Object byte[] $Count
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) }
    finally { $generator.Dispose() }
    return $bytes
}

function ConvertTo-LowerHex([byte[]]$Bytes) {
    return ([BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
}

function Set-SystemAdministratorsPrivateAcl([System.IO.FileSystemInfo]$Item) {
    $isDirectory = $Item -is [IO.DirectoryInfo]
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or (-not $isDirectory -and -not ($Item -is [IO.FileInfo]))) {
        Fail-Closed "GATE_F_PRIVATE_ACL_INVALID"
    }
    if ($isDirectory) {
        $security = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit `
            -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier($AdministratorsSidValue)
    $security.SetOwner($administratorsSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($SystemSidValue, $AdministratorsSidValue)) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $security.AddAccessRule($rule)
    }
    if ($isDirectory) {
        [IO.Directory]::SetAccessControl($Item.FullName, [Security.AccessControl.DirectorySecurity]$security)
    } else {
        [IO.File]::SetAccessControl($Item.FullName, [Security.AccessControl.FileSecurity]$security)
    }
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
        $persisted = [IO.Directory]::GetAccessControl($Item.FullName, $sections)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit `
            -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $persisted = [IO.File]::GetAccessControl($Item.FullName, $sections)
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $allowed = @($SystemSidValue, $AdministratorsSidValue)
    $owner = [string]$persisted.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($persisted.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $persisted.AreAccessRulesProtected -or $allowed -notcontains $owner -or $rules.Count -ne 2) {
        Fail-Closed "GATE_F_PRIVATE_ACL_INVALID"
    }
    foreach ($sidValue in $allowed) {
        $matches = @($rules | Where-Object {
            [string]$_.IdentityReference.Value -ceq $sidValue `
                -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow `
                -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl `
                -and $_.InheritanceFlags -eq $inheritance `
                -and $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None `
                -and -not $_.IsInherited
        })
        if ($matches.Count -ne 1) { Fail-Closed "GATE_F_PRIVATE_ACL_INVALID" }
    }
}

function Write-PrivateJsonCreateOnly([string]$Target, $Value) {
    if (Test-Path -LiteralPath $Target) { Fail-Closed "GATE_F_PRIVATE_MATERIAL_EXISTS" }
    $parent = Split-Path -Parent $Target
    Assert-PlainDirectory $parent "GATE_F_SECRETS_ROOT_INVALID"
    $temporary = Join-Path $parent (([IO.Path]::GetFileName($Target)) + ".tmp-" + [Guid]::NewGuid().ToString("N"))
    $utf8 = New-Object Text.UTF8Encoding($false)
    $json = ($Value | ConvertTo-Json -Depth 12) + "`r`n"
    $moved = $false
    try {
        $stream = New-Object IO.FileStream(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            $bytes = $utf8.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        $temporaryItem = Get-Item -LiteralPath $temporary -Force
        Set-SystemAdministratorsPrivateAcl $temporaryItem
        Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $temporary -Force)
        [IO.File]::Move($temporary, $Target)
        $moved = $true
        Assert-PlainFile $Target "GATE_F_PRIVATE_MATERIAL_INVALID"
        Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $Target -Force)
    } catch {
        if ($moved -and (Test-Path -LiteralPath $Target)) {
            Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-PrivateValue([string]$Value, [int]$MinimumLength) {
    return -not [string]::IsNullOrWhiteSpace($Value) `
        -and $Value.Length -ge $MinimumLength -and $Value.Length -le 4096 `
        -and $Value -notmatch '[\x00\r\n]'
}

function Assert-SecretEnvironment([string]$Path) {
    Assert-PlainFile $Path "GATE_F_SECRET_ENVIRONMENT_INVALID"
    $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if (-not (Test-ExactProperties $raw @("schemaId", "variables")) `
        -or [string]$raw.schemaId -cne $SecretSchemaId `
        -or -not (Test-ExactProperties $raw.variables $ExpectedVariables)) {
        Fail-Closed "GATE_F_SECRET_ENVIRONMENT_INVALID"
    }
    $provider = [string]$raw.variables.DEEPSEEK_API_KEY
    $gateToken = [string]$raw.variables.XW_M6_GATE_F_OPERATIONS_TOKEN
    $liveToken = [string]$raw.variables.XW_M6_LIVE_ENTRY_TOKEN
    $accountHash = [string]$raw.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH
    if (-not (Test-PrivateValue $provider 8) `
        -or -not (Test-PrivateValue $gateToken 32) `
        -or -not (Test-PrivateValue $liveToken 32) `
        -or $accountHash -notmatch '^(?!0{64}$)[0-9a-f]{64}$' `
        -or [string]::Equals($gateToken, $liveToken, [StringComparison]::Ordinal) `
        -or [string]::Equals($gateToken, $provider, [StringComparison]::Ordinal) `
        -or [string]::Equals($liveToken, $provider, [StringComparison]::Ordinal)) {
        Fail-Closed "GATE_F_SECRET_ENVIRONMENT_INVALID"
    }
}

function Assert-DigestKeyring([string]$Path) {
    Assert-PlainFile $Path "GATE_F_DIGEST_KEYRING_INVALID"
    $raw = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $initial = Test-ExactProperties $raw @("schemaId", "activeKeyId", "createdAt", "keys")
    $rotated = Test-ExactProperties $raw @("schemaId", "activeKeyId", "rotatedAt", "keys")
    $keys = @($raw.keys)
    if ((-not $initial -and -not $rotated) -or [string]$raw.schemaId -cne $KeyringSchemaId `
        -or [string]$raw.activeKeyId -notmatch '^[A-Za-z0-9-]{1,64}$' `
        -or $keys.Count -lt 1 -or $keys.Count -gt 256) {
        Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID"
    }
    $seen = @{}
    $activeCount = 0
    $declaredActive = $false
    foreach ($entry in $keys) {
        if (-not (Test-ExactProperties $entry @("keyId", "keyBase64", "algorithm", "status", "createdAt")) `
            -or [string]$entry.keyId -notmatch '^[A-Za-z0-9-]{1,64}$' `
            -or $seen.ContainsKey([string]$entry.keyId) `
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
        $seen[[string]$entry.keyId] = $true
        if ([string]$entry.status -ceq "active") {
            $activeCount += 1
            if ([string]$entry.keyId -ceq [string]$raw.activeKeyId) { $declaredActive = $true }
        }
    }
    if ($activeCount -ne 1 -or -not $declaredActive) { Fail-Closed "GATE_F_DIGEST_KEYRING_INVALID" }
}

function Get-VerificationReceipt([string]$SecretsRoot, [string]$SecretPath, [string]$KeyringPath) {
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretsRoot -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $SecretPath -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $KeyringPath -Force)
    Assert-SecretEnvironment $SecretPath
    Assert-DigestKeyring $KeyringPath
    return [ordered]@{
        ok = $true
        schemaId = "xw.runtime.control-plane-private-material-verification.v1"
        secretEnvironment = [ordered]@{
            sha256 = Get-Sha256 $SecretPath
            requiredEnvironment = [ordered]@{
                DEEPSEEK_API_KEY = "present"
                XW_M6_GATE_F_OPERATIONS_TOKEN = "present"
                XW_M6_LIVE_ENTRY_TOKEN = "present"
                XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = "present"
            }
        }
        digestKeyring = [ordered]@{
            sha256 = Get-Sha256 $KeyringPath
            activeKeyId = "present"
            keyMaterial = "present"
        }
    }
}

$runtimeRootFull = Resolve-AbsolutePath $RuntimeRoot "GATE_F_RUNTIME_ROOT_INVALID"
Assert-PlainDirectory $runtimeRootFull "GATE_F_RUNTIME_ROOT_INVALID"
$secretsRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRootFull "secrets"))
if (-not (Test-Within $runtimeRootFull $secretsRoot)) { Fail-Closed "GATE_F_SECRETS_ROOT_INVALID" }
$secretPath = Join-Path $secretsRoot $SecretFilename
$keyringPath = Join-Path $secretsRoot $KeyringFilename

if ($Mode -eq "Provision") {
    Assert-ElevatedAdministrator
    $providerKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "Process")
    $accountHash = [Environment]::GetEnvironmentVariable("XW_M6_ACCOUNT_ISOLATION_BINDING_HASH", "Process")
    if (-not (Test-PrivateValue $providerKey 8) `
        -or $accountHash -notmatch '^(?!0{64}$)[0-9A-Fa-f]{64}$') {
        Fail-Closed "GATE_F_PROVISION_INPUT_UNAVAILABLE"
    }
    if (-not (Test-Path -LiteralPath $secretsRoot)) {
        [IO.Directory]::CreateDirectory($secretsRoot) | Out-Null
    }
    Assert-PlainDirectory $secretsRoot "GATE_F_SECRETS_ROOT_INVALID"
    Set-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $secretsRoot -Force)
    Assert-SystemAdministratorsPrivateAcl (Get-Item -LiteralPath $secretsRoot -Force)
    if ((Test-Path -LiteralPath $secretPath) -or (Test-Path -LiteralPath $keyringPath)) {
        Fail-Closed "GATE_F_PRIVATE_MATERIAL_EXISTS"
    }

    $gateToken = [Convert]::ToBase64String((New-RandomBytes 32))
    $liveToken = [Convert]::ToBase64String((New-RandomBytes 32))
    if ([string]::Equals($gateToken, $liveToken, [StringComparison]::Ordinal)) {
        Fail-Closed "GATE_F_RANDOM_COLLISION"
    }
    $now = [DateTimeOffset]::UtcNow.ToString("o")
    $keyId = "ka-" + (ConvertTo-LowerHex (New-RandomBytes 8))
    $secretManifest = [ordered]@{
        schemaId = $SecretSchemaId
        variables = [ordered]@{
            DEEPSEEK_API_KEY = $providerKey
            XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = $accountHash.ToLowerInvariant()
            XW_M6_GATE_F_OPERATIONS_TOKEN = $gateToken
            XW_M6_LIVE_ENTRY_TOKEN = $liveToken
        }
    }
    $keyringManifest = [ordered]@{
        schemaId = $KeyringSchemaId
        activeKeyId = $keyId
        createdAt = $now
        keys = @([ordered]@{
            keyId = $keyId
            keyBase64 = [Convert]::ToBase64String((New-RandomBytes 32))
            algorithm = "HMAC-SHA-256"
            status = "active"
            createdAt = $now
        })
    }
    $createdSecret = $false
    $createdKeyring = $false
    try {
        Write-PrivateJsonCreateOnly $secretPath $secretManifest
        $createdSecret = $true
        Write-PrivateJsonCreateOnly $keyringPath $keyringManifest
        $createdKeyring = $true
    } catch {
        if ($createdKeyring -and (Test-Path -LiteralPath $keyringPath)) {
            Remove-Item -LiteralPath $keyringPath -Force -ErrorAction SilentlyContinue
        }
        if ($createdSecret -and (Test-Path -LiteralPath $secretPath)) {
            Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
        }
        throw
    } finally {
        $providerKey = $null
        $accountHash = $null
        $gateToken = $null
        $liveToken = $null
        $secretManifest = $null
        $keyringManifest = $null
    }
} else {
    Assert-PlainDirectory $secretsRoot "GATE_F_SECRETS_ROOT_INVALID"
}

$receipt = Get-VerificationReceipt $secretsRoot $secretPath $keyringPath
$receipt | ConvertTo-Json -Depth 6
