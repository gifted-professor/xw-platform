/**
 * Fixed Windows ACL boundary for the XHS V3 independent blind reviewer.
 *
 * The task-private corpus and deployed implementation remain an exact
 * SYSTEM/Administrators TCB.  The fixed reviewer receives read-only access to
 * the purpose-built export plus WriteData (never create/delete/ACL authority)
 * on one fixed untrusted draft.  The response inbox itself stays read-only;
 * only the privileged SID-authenticating broker can admit response bytes.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const XHS_V3_BLIND_REVIEW_ACL_PLAN_SCHEMA_ID =
  "xw.xhs.v3-blind-review-acl-plan.v1";
export const XHS_V3_BLIND_REVIEW_ACL_RECEIPT_SCHEMA_ID =
  "xw.xhs.v3-blind-review-acl-receipt.v1";
export const XHS_V3_BLIND_REVIEWER_ACCOUNT = "CodexSandboxOffline";
export const XHS_V3_BLIND_REVIEW_FIREWALL_RULES = Object.freeze([
  "codex_sandbox_offline_block_loopback_tcp",
  "codex_sandbox_offline_block_loopback_udp",
  "codex_sandbox_offline_block_outbound",
]);
export const XHS_V3_BLIND_REVIEW_ROOT = join(
  "C:\\", "Program Files", "XW Platform", "blind-review",
);

const HASH = /^(?!0{64}$)[0-9a-f]{64}$/u;
const MAX_TREE_ENTRIES = 50_000;

function aclError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left, right, platform = process.platform) {
  const a = resolve(left);
  const b = resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildXhsV3BlindReviewAclPlan({
  reviewRoot = XHS_V3_BLIND_REVIEW_ROOT,
  workspaceRoot,
  inboxRoot,
  privateRoot,
  providerRoot,
  releaseRoot,
  sourceRoot,
} = {}) {
  const paths = [reviewRoot, workspaceRoot, inboxRoot, privateRoot, providerRoot, releaseRoot, sourceRoot];
  if (paths.some((value) => typeof value !== "string" || !isAbsolute(value))) {
    throw aclError("XHS_V3_BLIND_REVIEW_ACL_PLAN_INVALID", "all blind-review ACL paths must be absolute");
  }
  const fixedReviewRoot = resolve(reviewRoot);
  const workspace = resolve(workspaceRoot);
  const inbox = resolve(inboxRoot);
  const taskPrivate = resolve(privateRoot);
  const providerOutput = resolve(providerRoot);
  const deployedRelease = resolve(releaseRoot);
  const source = resolve(sourceRoot);
  if (!within(fixedReviewRoot, workspace) || !within(workspace, inbox)
    || within(fixedReviewRoot, taskPrivate) || within(fixedReviewRoot, providerOutput)
    || within(fixedReviewRoot, deployedRelease) || within(taskPrivate, workspace)
    || within(providerOutput, workspace) || within(deployedRelease, workspace)
    || within(fixedReviewRoot, source) || within(source, workspace)) {
    throw aclError("XHS_V3_BLIND_REVIEW_ACL_PATH_ESCAPE", "review workspace is not isolated from task-private/release roots");
  }
  return Object.freeze({
    schemaId: XHS_V3_BLIND_REVIEW_ACL_PLAN_SCHEMA_ID,
    reviewRoot: fixedReviewRoot,
    workspaceRoot: workspace,
    inboxRoot: inbox,
    privateRoot: taskPrivate,
    providerRoot: providerOutput,
    releaseRoot: deployedRelease,
    sourceRoot: source,
    reviewerAccount: XHS_V3_BLIND_REVIEWER_ACCOUNT,
  });
}

function validatePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "inboxRoot", "privateRoot", "providerRoot", "releaseRoot", "reviewRoot", "reviewerAccount",
      "schemaId", "sourceRoot", "workspaceRoot",
    ].sort())
    || value.schemaId !== XHS_V3_BLIND_REVIEW_ACL_PLAN_SCHEMA_ID
    || value.reviewerAccount !== XHS_V3_BLIND_REVIEWER_ACCOUNT) {
    throw aclError("XHS_V3_BLIND_REVIEW_ACL_PLAN_INVALID", "blind-review ACL plan drifted");
  }
  return buildXhsV3BlindReviewAclPlan(value);
}

function assertPlainTree(path, {
  platform,
  lstatSyncFn,
  readdirSyncFn,
  realpathSyncFn,
}) {
  const pending = [resolve(path)];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let stat;
    try { stat = lstatSyncFn(current); } catch {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_PATH_UNAVAILABLE", "blind-review ACL path is unavailable");
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && stat.nlink !== 1)
      || !samePath(realpathSyncFn(current), current, platform)) {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_STRUCTURE_INVALID", "blind-review tree contains a link/reparse/non-plain item");
    }
    count += 1;
    if (count > MAX_TREE_ENTRIES) {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_TREE_TOO_LARGE", "blind-review tree exceeded its fixed bound");
    }
    if (stat.isDirectory()) {
      let entries;
      try { entries = readdirSyncFn(current, { withFileTypes: true }); } catch {
        throw aclError("XHS_V3_BLIND_REVIEW_ACL_STRUCTURE_INVALID", "blind-review tree cannot be enumerated");
      }
      for (const entry of entries) pending.push(join(current, entry.name));
    }
  }
  return count;
}

// PowerShell 5.1 compatible.  The native verifier resolves one fixed local
// group, rejects an empty group or any member reachable from Administrators,
// validates exact task-private/release TCB roots, and returns only SID/SDDL
// digests.  It never receives or inherits provider/token material.
export const WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SystemSid = "S-1-5-18"
$AdministratorsSid = "S-1-5-32-544"

function Stop-ReviewAcl([string]$Code) {
    [Console]::Error.Write("XHS_REVIEW_ACL_" + $Code)
    exit 23
}
function Full-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) { Stop-ReviewAcl "PATH_INVALID" }
    try { return [IO.Path]::GetFullPath($Value) } catch { Stop-ReviewAcl "PATH_INVALID" }
}
function Same-Path([string]$Left, [string]$Right) {
    return (Full-Path $Left).Equals((Full-Path $Right), [StringComparison]::OrdinalIgnoreCase)
}
function Within-Or-Same([string]$Root, [string]$Candidate) {
    $r = (Full-Path $Root).TrimEnd('\')
    $c = Full-Path $Candidate
    return $c.Equals($r, [StringComparison]::OrdinalIgnoreCase) -or $c.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Plain-Item([string]$Path) {
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { Stop-ReviewAcl "PATH_UNAVAILABLE" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-ReviewAcl "REPARSE_FORBIDDEN" }
    if (-not $item.PSIsContainer -and -not ($item -is [IO.FileInfo])) { Stop-ReviewAcl "TYPE_INVALID" }
    return $item
}
function Get-AclCore([System.IO.FileSystemInfo]$Item) {
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    if ($Item.PSIsContainer) { return [IO.Directory]::GetAccessControl($Item.FullName, $sections) }
    return [IO.File]::GetAccessControl($Item.FullName, $sections)
}
function Hash-Text([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Exact-Keys([object]$Value, [string[]]$Keys) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Keys | Sort-Object)
    return (($actual -join [Environment]::NewLine) -ceq ($expected -join [Environment]::NewLine))
}
function Account-Sid([string]$Path) {
    try {
        $entry = [ADSI]$Path
        return (New-Object Security.Principal.SecurityIdentifier($entry.objectSid.Value, 0)).Value
    } catch { Stop-ReviewAcl "PRINCIPAL_INVALID" }
}
function Members([string]$GroupPath) {
    try {
        $group = [ADSI]$GroupPath
        return @($group.psbase.Invoke("Members") | ForEach-Object { $_.GetType().InvokeMember("ADsPath", "GetProperty", $null, $_, $null) })
    } catch { Stop-ReviewAcl "PRINCIPAL_INVALID" }
}
function Assert-Reviewer-Separation([string]$ReviewerAccount) {
    try { $users = @(Get-LocalUser -Name $ReviewerAccount -ErrorAction Stop) }
    catch { Stop-ReviewAcl "PRINCIPAL_INVALID" }
    if ($users.Count -ne 1) { Stop-ReviewAcl "PRINCIPAL_INVALID" }
    $reviewer = $users[0]
    if ($reviewer.Enabled -ne $true) { Stop-ReviewAcl "REVIEWER_DISABLED" }
    $reviewSid = [string]$reviewer.SID.Value
    try { $adminMembers = @(Get-LocalGroupMember -SID $AdministratorsSid -ErrorAction Stop) }
    catch { Stop-ReviewAcl "PRINCIPAL_INVALID" }
    if (@($adminMembers | Where-Object { [string]$_.SID.Value -ceq $reviewSid }).Count -ne 0) {
        Stop-ReviewAcl "REVIEWER_IS_ADMIN"
    }
    return $reviewSid
}
function One-FirewallRule([string]$Name) {
    try { $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $Name -ErrorAction Stop) }
    catch { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
    if ($rules.Count -ne 1) { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
    $rule = $rules[0]
    if ([string]$rule.Enabled -cne "True" -or [string]$rule.Direction -cne "Outbound" -or
        [string]$rule.Action -cne "Block" -or
        [string]$rule.Profile -ne "Any") { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
    return $rule
}
function Exact-Set([object[]]$Actual, [string[]]$Expected) {
    $a = @($Actual | ForEach-Object { [string]$_ } | Sort-Object)
    $e = @($Expected | Sort-Object)
    return (($a -join [Environment]::NewLine) -ceq ($e -join [Environment]::NewLine))
}
function Assert-RuleSid([object]$Rule, [string]$ReviewerSid) {
    try { $security = $Rule | Get-NetFirewallSecurityFilter -ErrorAction Stop }
    catch { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
    try { $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor([string]$security.LocalUser) }
    catch { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
    $aces = @($descriptor.DiscretionaryAcl)
    if ($aces.Count -ne 1 -or $aces[0].AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
        [string]$aces[0].SecurityIdentifier.Value -cne $ReviewerSid -or [Int64]$aces[0].AccessMask -ne 1) {
        Stop-ReviewAcl "NETWORK_POLICY_INVALID"
    }
}
function Assert-Reviewer-NetworkPolicy([string]$ReviewerSid) {
    $specs = @(
        @{ Name = "codex_sandbox_offline_block_loopback_tcp"; Protocol = "TCP"; RemotePort = "1-65535"; Addresses = @("127.0.0.0/255.0.0.0", "::/127") },
        @{ Name = "codex_sandbox_offline_block_loopback_udp"; Protocol = "UDP"; RemotePort = "Any"; Addresses = @("127.0.0.0/255.0.0.0", "::/127") },
        @{ Name = "codex_sandbox_offline_block_outbound"; Protocol = "Any"; RemotePort = "Any"; Addresses = @("0.0.0.0-126.255.255.255", "128.0.0.0-255.255.255.255", "::", "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff") }
    )
    $observed = New-Object Collections.Generic.List[string]
    foreach ($spec in $specs) {
        $rule = One-FirewallRule $spec.Name
        Assert-RuleSid $rule $ReviewerSid
        try {
            $address = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
            $port = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
            $application = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop
            $service = $rule | Get-NetFirewallServiceFilter -ErrorAction Stop
            $interfaceType = $rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop
            $interface = $rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop
        } catch { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
        if (-not (Exact-Set @($address.RemoteAddress) @($spec.Addresses)) -or
            [string]$address.LocalAddress -cne "Any" -or [string]$port.Protocol -cne [string]$spec.Protocol -or
            [string]$port.LocalPort -cne "Any" -or [string]$port.RemotePort -cne [string]$spec.RemotePort -or
            [string]$application.Program -cne "Any" -or [string]$service.Service -cne "Any" -or
            [string]$interfaceType.InterfaceType -cne "Any" -or [string]$interface.InterfaceAlias -cne "Any" -or
            [string]$rule.EdgeTraversalPolicy -cne "Block" -or [string]$rule.LooseSourceMapping -cne "False" -or
            [string]$rule.LocalOnlyMapping -cne "False") { Stop-ReviewAcl "NETWORK_POLICY_INVALID" }
        $observed.Add(($spec.Name + "|Enabled=True|Direction=Outbound|Action=Block|Profile=Any|Protocol=" + $spec.Protocol +
            "|LocalAddress=Any|LocalPort=Any|RemotePort=" + $spec.RemotePort + "|RemoteAddress=" +
            ((@($spec.Addresses) | Sort-Object) -join ",") + "|Program=Any|Service=Any|InterfaceType=Any|InterfaceAlias=Any|" +
            "EdgeTraversal=Block|LooseSourceMapping=False|LocalOnlyMapping=False|LocalUserSid=" + $ReviewerSid))
    }
    return Hash-Text (($observed | Sort-Object) -join [Environment]::NewLine)
}
function Set-ItemAcl([System.IO.FileSystemInfo]$Item, [string]$ReviewerSid, [bool]$Draft) {
    if ($Item.PSIsContainer) {
        $security = [IO.Directory]::GetAccessControl($Item.FullName)
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = [IO.File]::GetAccessControl($Item.FullName)
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    if ($Item.PSIsContainer) { $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($AdministratorsSid))) }
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        [void]$security.RemoveAccessRuleSpecific($existingRule)
    }
    foreach ($sidValue in @($SystemSid, $AdministratorsSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sidValue)),
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$security.AddAccessRule($rule)
    }
    $reviewRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    # Only this existing untrusted draft can be edited.  The reviewer cannot
    # create, rename, replace, delete, or change metadata/ACLs anywhere.
    if ($Draft) { $reviewRights = $reviewRights -bor [Security.AccessControl.FileSystemRights]::WriteData }
    $reviewRule = New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($ReviewerSid)),
        $reviewRights,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    [void]$security.AddAccessRule($reviewRule)
    try {
        if ($Item.PSIsContainer) { [IO.Directory]::SetAccessControl($Item.FullName, [Security.AccessControl.DirectorySecurity]$security) }
        else { [IO.File]::SetAccessControl($Item.FullName, [Security.AccessControl.FileSecurity]$security) }
    } catch {
        if ($Item.PSIsContainer) { Stop-ReviewAcl "WORKSPACE_DIRECTORY_PROTECT_INVALID" }
        if ($Draft) { Stop-ReviewAcl "WORKSPACE_DRAFT_PROTECT_INVALID" }
        Stop-ReviewAcl "WORKSPACE_FILE_PROTECT_INVALID"
    }
}
function Assert-IsolatedTcb([string]$Path) {
    $item = Plain-Item $Path
    $acl = Get-AclCore $item
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or @($SystemSid, $AdministratorsSid) -notcontains $owner -or $rules.Count -ne 2) { Stop-ReviewAcl "ISOLATION_INVALID" }
    foreach ($sidValue in @($SystemSid, $AdministratorsSid)) {
        $match = @($rules | Where-Object {
            [string]$_.IdentityReference.Value -ceq $sidValue -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl
        })
        if ($match.Count -ne 1) { Stop-ReviewAcl "ISOLATION_INVALID" }
    }
    return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Protect-SourceDeny([string]$Path, [string]$ReviewerSid) {
    $item = Plain-Item $Path
    if (-not $item.PSIsContainer) { Stop-ReviewAcl "SOURCE_INVALID" }
    $acl = [IO.Directory]::GetAccessControl($item.FullName, [Security.AccessControl.AccessControlSections]::All)
    $deny = New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($ReviewerSid)),
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Deny)
    [void]$acl.SetAccessRule($deny)
    try { [IO.Directory]::SetAccessControl($item.FullName, $acl) }
    catch { Stop-ReviewAcl "SOURCE_PROTECT_INVALID" }
}
function Assert-SourceDeny([string]$Path, [string]$ReviewerSid) {
    $item = Plain-Item $Path
    if (-not $item.PSIsContainer) { Stop-ReviewAcl "SOURCE_INVALID" }
    $acl = [IO.Directory]::GetAccessControl($item.FullName, [Security.AccessControl.AccessControlSections]::All)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $matches = @($rules | Where-Object {
        -not $_.IsInherited -and [string]$_.IdentityReference.Value -ceq $ReviewerSid -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
        $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        $_.InheritanceFlags -eq ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
        $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
    })
    $allows = @($rules | Where-Object {
        -not $_.IsInherited -and [string]$_.IdentityReference.Value -ceq $ReviewerSid -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    })
    if ($matches.Count -ne 1 -or $allows.Count -ne 0) { Stop-ReviewAcl "SOURCE_INVALID" }
    return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Set-LeaseAcl([string]$Path, [bool]$Directory) {
    if ($Directory) {
        $security = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($AdministratorsSid)))
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($SystemSid, $AdministratorsSid)) {
        [void]$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sidValue)),
            [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)))
    }
    try {
        if ($Directory) { [IO.Directory]::SetAccessControl($Path, $security) }
        else { [IO.File]::SetAccessControl($Path, $security) }
    } catch { Stop-ReviewAcl "SOURCE_LEASE_ACL_INVALID" }
}
function Source-Lease([string]$Private, [string]$Workspace, [string]$Source, [string]$ReviewerSid, [bool]$Create) {
    $leaseRoot = Join-Path $Private "blind-review-source-acl-leases"
    if (-not (Test-Path -LiteralPath $leaseRoot)) {
        if (-not $Create) { return $null }
        [void][IO.Directory]::CreateDirectory($leaseRoot)
        Set-LeaseAcl $leaseRoot $true
    }
    # One fixed CreateNew path is the global CAS. Different review workspaces
    # cannot both acquire a source ACL lease after racing an empty directory.
    $leasePath = Join-Path $leaseRoot "active.source-acl-lease.v1.json"
    if (-not (Test-Path -LiteralPath $leasePath)) {
        if (-not $Create) { return $null }
        $sourceAcl = [IO.Directory]::GetAccessControl($Source, [Security.AccessControl.AccessControlSections]::All)
        $sddl = $sourceAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
        $protectedAcl = New-Object Security.AccessControl.DirectorySecurity
        $protectedAcl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::All)
        $protectedDeny = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($ReviewerSid)),
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Deny)
        [void]$protectedAcl.SetAccessRule($protectedDeny)
        $protectedSddl = $protectedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
        $lease = [ordered]@{
            schemaId = "xw.xhs.v3-blind-review-source-acl-lease.v1"; schemaVersion = 1
            workspaceHash = Hash-Text $Workspace; sourceHash = Hash-Text $Source; reviewerSid = $ReviewerSid
            originalSddlBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl)); originalSddlHash = Hash-Text $sddl
            protectedSddlHash = Hash-Text $protectedSddl
        }
        $leaseBytes = [Text.Encoding]::UTF8.GetBytes(($lease | ConvertTo-Json -Compress))
        $stream = New-Object IO.FileStream($leasePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($leaseBytes, 0, $leaseBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Set-LeaseAcl $leasePath $false
    }
    [void](Assert-IsolatedTcb $leaseRoot)
    [void](Assert-IsolatedTcb $leasePath)
    try { $loaded = Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Stop-ReviewAcl "SOURCE_LEASE_INVALID" }
    if (-not (Exact-Keys $loaded @(
        "schemaId", "schemaVersion", "workspaceHash", "sourceHash", "reviewerSid",
        "originalSddlBase64", "originalSddlHash", "protectedSddlHash"
    ))) { Stop-ReviewAcl "SOURCE_LEASE_INVALID" }
    if ($loaded.workspaceHash -cne (Hash-Text $Workspace)) { Stop-ReviewAcl "SOURCE_LEASE_ACTIVE" }
    if ($loaded.schemaId -cne "xw.xhs.v3-blind-review-source-acl-lease.v1" -or $loaded.schemaVersion -ne 1 -or
        $loaded.sourceHash -cne (Hash-Text $Source) -or
        $loaded.reviewerSid -cne $ReviewerSid -or $loaded.originalSddlHash -notmatch '^[0-9a-f]{64}$') {
        Stop-ReviewAcl "SOURCE_LEASE_INVALID"
    }
    try { $originalSddl = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$loaded.originalSddlBase64)) }
    catch { Stop-ReviewAcl "SOURCE_LEASE_INVALID" }
    if ((Hash-Text $originalSddl) -cne [string]$loaded.originalSddlHash) { Stop-ReviewAcl "SOURCE_LEASE_INVALID" }
    if ([string]$loaded.protectedSddlHash -notmatch '^[0-9a-f]{64}$') { Stop-ReviewAcl "SOURCE_LEASE_INVALID" }
    return @{ Path = $leasePath; Value = $loaded; OriginalSddl = $originalSddl }
}
function Restore-SourceLease([string]$Private, [string]$Workspace, [string]$Source, [string]$ReviewerSid) {
    $lease = Source-Lease $Private $Workspace $Source $ReviewerSid $false
    if ($null -eq $lease) {
        $unchanged = ([IO.Directory]::GetAccessControl($Source, [Security.AccessControl.AccessControlSections]::All)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
        return Hash-Text $unchanged
    }
    $acl = [IO.Directory]::GetAccessControl($Source, [Security.AccessControl.AccessControlSections]::All)
    $current = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    $currentHash = Hash-Text $current
    if ($currentHash -cne [string]$lease.Value.originalSddlHash) {
        if ($currentHash -cne [string]$lease.Value.protectedSddlHash) { Stop-ReviewAcl "SOURCE_RESTORE_DRIFT" }
        [void](Assert-SourceDeny $Source $ReviewerSid)
        $restored = New-Object Security.AccessControl.DirectorySecurity
        $restored.SetSecurityDescriptorSddlForm($lease.OriginalSddl, [Security.AccessControl.AccessControlSections]::All)
        [IO.Directory]::SetAccessControl($Source, $restored)
    }
    $verified = ([IO.Directory]::GetAccessControl($Source, [Security.AccessControl.AccessControlSections]::All)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    if ((Hash-Text $verified) -cne [string]$lease.Value.originalSddlHash) { Stop-ReviewAcl "SOURCE_RESTORE_INVALID" }
    Remove-Item -LiteralPath $lease.Path -Force
    return [string]$lease.Value.originalSddlHash
}
function Assert-WorkspaceAcl([System.IO.FileSystemInfo]$Item, [string]$ReviewerSid, [bool]$Draft) {
    $failureCode = if ($Draft) { "WORKSPACE_DRAFT_INVALID" } elseif ($Item.PSIsContainer) { "WORKSPACE_DIRECTORY_INVALID" } else { "WORKSPACE_FILE_INVALID" }
    $acl = Get-AclCore $Item
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $allowed = @($SystemSid, $AdministratorsSid, $ReviewerSid)
    if (-not $acl.AreAccessRulesProtected) { Stop-ReviewAcl ($failureCode + "_UNPROTECTED") }
    if (@($SystemSid, $AdministratorsSid) -notcontains $owner) { Stop-ReviewAcl ($failureCode + "_OWNER") }
    if ($rules.Count -ne 3) { Stop-ReviewAcl ($failureCode + "_RULE_COUNT") }
    foreach ($rule in $rules) {
        $sid = [string]$rule.IdentityReference.Value
        if ($allowed -notcontains $sid -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { Stop-ReviewAcl ($failureCode + "_RULE") }
        if (@($SystemSid, $AdministratorsSid) -contains $sid) {
            if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { Stop-ReviewAcl ($failureCode + "_TCB_RIGHTS") }
        } elseif ($sid -ceq $ReviewerSid) {
            $rights = [Int64]$rule.FileSystemRights
            $forbidden = [Int64][Security.AccessControl.FileSystemRights]::Delete -bor [Int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Int64][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Int64][Security.AccessControl.FileSystemRights]::TakeOwnership
            $expected = [Int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
            if ($Draft) { $expected = $expected -bor [Int64][Security.AccessControl.FileSystemRights]::WriteData }
            if (($rights -band $forbidden) -ne 0 -or $rights -ne $expected) { Stop-ReviewAcl ($failureCode + "_REVIEWER_RIGHTS") }
        }
    }
    return $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
}

try {
    $action = [string]$env:XW_XHS_REVIEW_ACL_ACTION
    if (@("Protect", "Verify", "Restore", "Close") -notcontains $action) { Stop-ReviewAcl "ACTION_INVALID" }
    $reviewRoot = Full-Path ([string]$env:XW_XHS_REVIEW_ROOT)
    $workspace = Full-Path ([string]$env:XW_XHS_REVIEW_WORKSPACE)
    $inbox = Full-Path ([string]$env:XW_XHS_REVIEW_INBOX)
    $private = Full-Path ([string]$env:XW_XHS_REVIEW_PRIVATE)
    $provider = Full-Path ([string]$env:XW_XHS_REVIEW_PROVIDER)
    $release = Full-Path ([string]$env:XW_XHS_REVIEW_RELEASE)
    $source = Full-Path ([string]$env:XW_XHS_REVIEW_SOURCE)
    if (-not (Within-Or-Same $reviewRoot $workspace) -or -not (Within-Or-Same $workspace $inbox)) { Stop-ReviewAcl "PATH_ESCAPE" }
    $reviewerSid = Assert-Reviewer-Separation ([string]$env:XW_XHS_REVIEW_ACCOUNT)
    if ($action -ceq "Close") {
        # Revoke reviewer access first. Source restoration drift must never
        # leave a formerly active workspace readable by the reviewer.
        $closeItems = @(Plain-Item $workspace) + @(Get-ChildItem -LiteralPath $workspace -Force -Recurse -ErrorAction Stop)
        foreach ($closeItem in @($closeItems | Sort-Object { $_.FullName.Length })) {
            Set-LeaseAcl $closeItem.FullName $closeItem.PSIsContainer
        }
        foreach ($closeItem in $closeItems) { [void](Assert-IsolatedTcb $closeItem.FullName) }
        $closedSddl = Assert-IsolatedTcb $workspace
        $restoredHash = Restore-SourceLease $private $workspace $source $reviewerSid
        [Console]::Out.Write((@{ restoredSourceAclHash = $restoredHash; closedWorkspaceAclHash = Hash-Text $closedSddl } | ConvertTo-Json -Compress))
        exit 0
    }
    if ($action -ceq "Restore") {
        $restoredHash = Restore-SourceLease $private $workspace $source $reviewerSid
        [Console]::Out.Write((@{ restoredSourceAclHash = $restoredHash } | ConvertTo-Json -Compress))
        exit 0
    }
    $networkPolicyHash = Assert-Reviewer-NetworkPolicy $reviewerSid
    $sourceLease = Source-Lease $private $workspace $source $reviewerSid ($action -ceq "Protect")
    if ($null -eq $sourceLease) { Stop-ReviewAcl "SOURCE_LEASE_MISSING" }
    $currentSourceSddl = ([IO.Directory]::GetAccessControl($source, [Security.AccessControl.AccessControlSections]::All)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    if ($action -ceq "Protect" -and (Hash-Text $currentSourceSddl) -ceq [string]$sourceLease.Value.originalSddlHash) {
        Protect-SourceDeny $source $reviewerSid
    }
    $currentSourceSddl = ([IO.Directory]::GetAccessControl($source, [Security.AccessControl.AccessControlSections]::All)).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    if ((Hash-Text $currentSourceSddl) -cne [string]$sourceLease.Value.protectedSddlHash) { Stop-ReviewAcl "SOURCE_PROTECT_DRIFT" }
    $draft = Join-Path $workspace "human-response.draft.v1.json"
    $managed = New-Object Collections.Generic.List[System.IO.FileSystemInfo]
    $cursor = $workspace
    while ($true) {
        $managed.Add((Plain-Item $cursor))
        if (Same-Path $cursor $reviewRoot) { break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Same-Path $parent $cursor) -or -not (Within-Or-Same $reviewRoot $parent)) {
            Stop-ReviewAcl "PATH_ESCAPE"
        }
        $cursor = $parent
    }
    $items = @(@($managed) + @(Get-ChildItem -LiteralPath $workspace -Force -Recurse -ErrorAction Stop) |
        Sort-Object { $_.FullName.Length })
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-ReviewAcl "REPARSE_FORBIDDEN" }
        $isDraft = (-not $item.PSIsContainer) -and (Same-Path $draft $item.FullName)
        if ($action -ceq "Protect") { Set-ItemAcl $item $reviewerSid $isDraft }
    }
    foreach ($item in $items) {
        $isDraft = (-not $item.PSIsContainer) -and (Same-Path $draft $item.FullName)
        [void](Assert-WorkspaceAcl $item $reviewerSid $isDraft)
    }
    $workspaceRootSddl = Assert-WorkspaceAcl (Plain-Item $workspace) $reviewerSid $false
    $reviewRootSddl = Assert-WorkspaceAcl (Plain-Item $reviewRoot) $reviewerSid $false
    $inboxRootSddl = Assert-WorkspaceAcl (Plain-Item $inbox) $reviewerSid $false
    $privateSddl = Assert-IsolatedTcb $private
    $providerSddl = Assert-IsolatedTcb $provider
    $releaseSddl = Assert-IsolatedTcb $release
    $sourceSddl = Assert-SourceDeny $source $reviewerSid
    $out = [ordered]@{
        reviewerSid = $reviewerSid
        workspaceAclHash = Hash-Text ($workspaceRootSddl + [Environment]::NewLine + $inboxRootSddl)
        isolationAclHash = Hash-Text ($reviewRootSddl + [Environment]::NewLine + $privateSddl + [Environment]::NewLine + $providerSddl + [Environment]::NewLine + $releaseSddl + [Environment]::NewLine + $sourceSddl)
        networkPolicyHash = $networkPolicyHash
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Compress))
} catch {
    $nativeMessage = [string]$_.Exception.Message
    $nativeMarker = [regex]::Match($nativeMessage, 'XHS_REVIEW_ACL_[A-Z_]+')
    if ($nativeMarker.Success) { [Console]::Error.Write($nativeMarker.Value) }
    else { [Console]::Error.Write("XHS_REVIEW_ACL_NATIVE_FAILURE") }
    exit 23
}
`;

// The privileged operator hosts this one-shot pipe.  The client sends a
// four-byte big-endian length followed by canonical UTF-8 response bytes.  The
// server impersonates the connected client to bind the admission to the fixed
// reviewer SID, then drops impersonation before it creates the response file.
export const WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SystemSid = "S-1-5-18"
$AdministratorsSid = "S-1-5-32-544"
function Stop-Broker([string]$Code) { throw ("XHS_REVIEW_BROKER_" + $Code) }
function Full-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) { Stop-Broker "PATH_INVALID" }
    try { return [IO.Path]::GetFullPath($Value) } catch { Stop-Broker "PATH_INVALID" }
}
function Same-Path([string]$Left, [string]$Right) {
    return (Full-Path $Left).Equals((Full-Path $Right), [StringComparison]::OrdinalIgnoreCase)
}
function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Hash-Text([string]$Text) { return Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($Text)) }
function Exact-Keys([object]$Value, [string[]]$Keys) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Keys | Sort-Object)
    return (($actual -join [Environment]::NewLine) -ceq ($expected -join [Environment]::NewLine))
}
function Reviewer-Sid {
    try { $users = @(Get-LocalUser -Name "CodexSandboxOffline" -ErrorAction Stop) }
    catch { Stop-Broker "PRINCIPAL_INVALID" }
    if ($users.Count -ne 1 -or $users[0].Enabled -ne $true) { Stop-Broker "PRINCIPAL_INVALID" }
    return [string]$users[0].SID.Value
}
function Assert-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ([string]$identity.User.Value -ceq $SystemSid) { return }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Broker "ELEVATION_REQUIRED" }
}
function Set-ResponseAcl([string]$Path, [string]$ReviewerSid) {
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($AdministratorsSid)))
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($SystemSid, $AdministratorsSid)) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sidValue)),
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow)))
    }
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($ReviewerSid)),
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.AccessControlType]::Allow)))
    [IO.File]::SetAccessControl($Path, $security)
}
function Assert-ResponseAcl([string]$Path, [string]$ReviewerSid) {
    $acl = [IO.File]::GetAccessControl($Path, [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or @($SystemSid, $AdministratorsSid) -notcontains $owner -or $rules.Count -ne 3) { Stop-Broker "RESPONSE_ACL_INVALID" }
    foreach ($rule in $rules) {
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            ($sid -ceq $ReviewerSid -and [Int64]$rule.FileSystemRights -ne [Int64]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)) -or
            (@($SystemSid, $AdministratorsSid) -contains $sid -and $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) -or
            (@($SystemSid, $AdministratorsSid, $ReviewerSid) -notcontains $sid)) { Stop-Broker "RESPONSE_ACL_INVALID" }
    }
}
function Read-Exact([IO.Stream]$Stream, [int]$Count) {
    $bytes = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($bytes, $offset, $Count - $offset)
        if ($read -le 0) { Stop-Broker "FRAME_TRUNCATED" }
        $offset += $read
    }
    return $bytes
}
try {
    Assert-Elevated
    $pipeName = [string]$env:XW_XHS_REVIEW_PIPE_NAME
    $inbox = [IO.Path]::GetFullPath([string]$env:XW_XHS_REVIEW_INBOX)
    $workspace = Full-Path ([string]$env:XW_XHS_REVIEW_WORKSPACE)
    $nodePath = Full-Path ([string]$env:XW_XHS_REVIEW_NODE)
    $clientPath = Full-Path ([string]$env:XW_XHS_REVIEW_CLIENT)
    $responseHash = [string]$env:XW_XHS_REVIEW_RESPONSE_HASH
    $sessionId = [string]$env:XW_XHS_REVIEW_SESSION_ID
    $challenge = [string]$env:XW_XHS_REVIEW_CHALLENGE
    $requestHash = [string]$env:XW_XHS_REVIEW_REQUEST_HASH
    $attestationHash = [string]$env:XW_XHS_REVIEW_ATTESTATION_HASH
    if ($pipeName -notmatch '^xw-xhs-v3-review-[0-9a-f]{64}$' -or
        @(@($responseHash, $sessionId, $challenge, $requestHash, $attestationHash) |
            Where-Object { $_ -notmatch '^[0-9a-f]{64}$' }).Count -ne 0) {
        Stop-Broker "BINDING_INVALID"
    }
    $expectedClient = Join-Path (Join-Path $workspace "templates") "xhs-v3-blind-review-submit.mjs"
    $draftPath = Join-Path $workspace "human-response.draft.v1.json"
    if (-not (Same-Path $clientPath $expectedClient) -or -not (Test-Path -LiteralPath $clientPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $draftPath -PathType Leaf)) {
        Stop-Broker "LAUNCH_PATH_INVALID"
    }
    foreach ($path in @($workspace, $clientPath, $nodePath, $draftPath)) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Broker "LAUNCH_PATH_INVALID" }
    }
    $reviewerSid = Reviewer-Sid
    $probeLines = @(
        "file:C:\Users\Public\xw-fusion\xw-platform\package.json:DENIED",
        "directory:C:\Users\Public\xw-fusion\xw-platform:DENIED",
        "directory:C:\Users\Public\xw-runtime\private\xhs-v3:DENIED",
        "directory:C:\Users\Public\xw-runtime\releases:DENIED",
        "directory:C:\Program Files\XW Platform\providers:DENIED"
    )
    $expectedIsolationProbeHash = Hash-Text ($probeLines -join [char]10)
    $taskName = "XW-XHS-V3-BlindReview-" + $sessionId
    $taskPath = "\"
    $taskAction = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $clientPath + '"') -WorkingDirectory $workspace
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId (([string]$env:COMPUTERNAME) + "\CodexSandboxOffline") -LogonType S4U -RunLevel Limited -ProcessTokenSidType Default
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
    function Same-CimDefinition([object]$Actual, [object]$Expected) {
        $actualNames = @($Actual.CimInstanceProperties.Name | Sort-Object)
        $expectedNames = @($Expected.CimInstanceProperties.Name | Sort-Object)
        if (($actualNames -join [Environment]::NewLine) -cne ($expectedNames -join [Environment]::NewLine)) { return $false }
        foreach ($name in $expectedNames) {
            $actualValue = $Actual.CimInstanceProperties[$name].Value | ConvertTo-Json -Compress -Depth 12
            $expectedValue = $Expected.CimInstanceProperties[$name].Value | ConvertTo-Json -Compress -Depth 12
            if ($actualValue -cne $expectedValue) { return $false }
        }
        return $true
    }
    function Assert-TaskDefinition([object]$Registered) {
        $registeredActions = @($Registered.Actions)
        if ([string]$Registered.TaskName -cne $taskName -or [string]$Registered.TaskPath -cne $taskPath -or
            @($Registered.Triggers).Count -ne 0 -or $registeredActions.Count -ne 1 -or
            -not (Same-CimDefinition $Registered.Principal $taskPrincipal) -or
            -not (Same-CimDefinition $Registered.Settings $taskSettings) -or
            -not (Same-CimDefinition $registeredActions[0] $taskAction)) { Stop-Broker "TASK_DEFINITION_INVALID" }
        try { $registeredSid = [string](New-Object Security.Principal.NTAccount([string]$Registered.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch { Stop-Broker "TASK_DEFINITION_INVALID" }
        if ($registeredSid -cne $reviewerSid -or [string]$Registered.Principal.LogonType -cne "S4U" -or
            [string]$Registered.Principal.RunLevel -cne "Limited" -or
            [string]$Registered.Principal.ProcessTokenSidType -cne "Default" -or
            @($Registered.Principal.RequiredPrivilege).Count -ne 0) { Stop-Broker "TASK_DEFINITION_INVALID" }
    }
    function Remove-ExactTask {
        $residual = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        if ($null -eq $residual) { return }
        Assert-TaskDefinition $residual
        if ([string]$residual.State -cne "Ready") {
            Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
            $stopped = $false
            for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
                $state = [string](Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop).State
                if ($state -cne "Running" -and $state -cne "Queued") { $stopped = $true; break }
                Start-Sleep -Milliseconds 100
            }
            if (-not $stopped) { Stop-Broker "TASK_CLEANUP_FAILED" }
        }
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
        if ($null -ne (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue)) {
            Stop-Broker "TASK_CLEANUP_FAILED"
        }
    }
    $finalPath = Join-Path $inbox ($responseHash + ".review-response.v1.json")
    $receiptPath = Join-Path $inbox ($sessionId + ".admission-receipt.v1.json")
    if (Test-Path -LiteralPath $receiptPath) {
        $receiptRaw = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8
        $receipt = $receiptRaw | ConvertFrom-Json
        if (-not (Exact-Keys $receipt @("schemaId","schemaVersion","sessionId","challenge","reviewRequestHash","accessAttestationHash","responseHash","callerPrincipalHash","isolationProbeHash","taskExecutionHash")) -or
            $receipt.schemaId -cne "xw.xhs.v3-blind-review-admission.v1" -or $receipt.schemaVersion -ne 1 -or
            $receipt.sessionId -cne $sessionId -or $receipt.challenge -cne $challenge -or
            $receipt.reviewRequestHash -cne $requestHash -or $receipt.accessAttestationHash -cne $attestationHash -or
            $receipt.responseHash -cne $responseHash -or $receipt.callerPrincipalHash -cne (Hash-Text $reviewerSid) -or
            $receipt.isolationProbeHash -cne $expectedIsolationProbeHash -or
            [string]$receipt.taskExecutionHash -notmatch '^[0-9a-f]{64}$' -or
            -not (Test-Path -LiteralPath $finalPath)) { Stop-Broker "REPLAY_INVALID" }
        if ($receiptRaw -cne ($receipt | ConvertTo-Json -Compress)) { Stop-Broker "REPLAY_INVALID" }
        # CreateNew+Flush precedes ACL hardening. A crash in that narrow window
        # is recoverable only after exact content/session validation.
        Set-ResponseAcl $receiptPath $reviewerSid
        Assert-ResponseAcl $receiptPath $reviewerSid
        $persistedBytes = [IO.File]::ReadAllBytes($finalPath)
        if ((Hash-Bytes $persistedBytes) -cne $responseHash) { Stop-Broker "REPLAY_INVALID" }
        try { $persisted = (New-Object Text.UTF8Encoding($false, $true)).GetString($persistedBytes) | ConvertFrom-Json }
        catch { Stop-Broker "REPLAY_INVALID" }
        if (-not (Exact-Keys $persisted @("schemaId","schemaVersion","corpusSetId","sessionId","challenge","reviewRequestHash","accessAttestationHash","annotations")) -or
            $persisted.schemaId -cne "xw.xhs.v3-fixed-blind-review-human-response.v1" -or $persisted.schemaVersion -ne 1 -or
            $persisted.sessionId -cne $sessionId -or $persisted.challenge -cne $challenge -or
            $persisted.reviewRequestHash -cne $requestHash -or $persisted.accessAttestationHash -cne $attestationHash) {
            Stop-Broker "REPLAY_INVALID"
        }
        Set-ResponseAcl $finalPath $reviewerSid
        Assert-ResponseAcl $finalPath $reviewerSid
        # A crash after receipt flush can leave the exact S4U task behind.
        # Receipt replay first adopts and removes that durable launch intent.
        Remove-ExactTask
        [Console]::Out.Write(($receipt | ConvertTo-Json -Compress))
        exit 0
    }
    $adoptOrphan = Test-Path -LiteralPath $finalPath
    $pipeSecurity = New-Object IO.Pipes.PipeSecurity
    foreach ($sidValue in @($SystemSid, $AdministratorsSid)) {
        $pipeSecurity.AddAccessRule((New-Object IO.Pipes.PipeAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sidValue)),
            [IO.Pipes.PipeAccessRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow)))
    }
    $pipeSecurity.AddAccessRule((New-Object IO.Pipes.PipeAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($reviewerSid)),
        [IO.Pipes.PipeAccessRights]::ReadWrite,
        [Security.AccessControl.AccessControlType]::Allow)))
    $pipe = New-Object IO.Pipes.NamedPipeServerStream($pipeName, [IO.Pipes.PipeDirection]::InOut, 1,
        [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::None, 65536, 65536, $pipeSecurity)
    $taskCreated = $false
    try {
        $registered = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        $newTask = $null -eq $registered
        if ($newTask) {
            try { Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings -ErrorAction Stop | Out-Null }
            catch { Stop-Broker "TASK_REGISTER_FAILED" }
            $taskCreated = $true
            $registered = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
        }
        Assert-TaskDefinition $registered
        # An exact residual task is the durable launch intent left by an
        # operator crash.  It may be adopted; a same-name drifted task is never
        # stopped or deleted by this broker.
        $taskCreated = $true
        $wait = $pipe.BeginWaitForConnection($null, $null)
        $initialTaskInfo = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
        $initialLastRunTime = $initialTaskInfo.LastRunTime
        $startedHere = [string]$registered.State -cne "Running"
        $launchStarted = Get-Date
        if ($startedHere) {
            if ([string]$registered.State -cne "Ready") { Stop-Broker "TASK_STATE_INVALID" }
            try { Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop }
            catch { Stop-Broker "TASK_START_FAILED" }
        } elseif ($initialLastRunTime -eq [DateTime]::MinValue) {
            Stop-Broker "TASK_STATE_INVALID"
        }
        $connected = $false
        for ($attempt = 0; $attempt -lt 1200; $attempt += 1) {
            if ($wait.AsyncWaitHandle.WaitOne(100)) { $connected = $true; break }
            $waitingTask = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
            $waitingInfo = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
            if ([string]$waitingTask.State -ceq "Ready" -and $waitingInfo.LastRunTime -ge $launchStarted.AddSeconds(-2)) {
                if ([Int64]$waitingInfo.LastTaskResult -eq 0) { Stop-Broker "TASK_CLIENT_NO_PIPE" }
                Stop-Broker "TASK_CLIENT_FAILED"
            }
        }
        if (-not $connected) { Stop-Broker "TIMEOUT" }
        $pipe.EndWaitForConnection($wait)
        $script:callerSid = $null
        $pipe.RunAsClient({ $script:callerSid = [string]([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) })
        if ($script:callerSid -cne $reviewerSid) { Stop-Broker "CALLER_INVALID" }
        $probeBytes = Read-Exact $pipe 32
        $probeHash = ([BitConverter]::ToString($probeBytes)).Replace("-", "").ToLowerInvariant()
        if ($probeHash -cne $expectedIsolationProbeHash) { Stop-Broker "ISOLATION_PROBE_INVALID" }
        $header = Read-Exact $pipe 4
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
        $length = [BitConverter]::ToUInt32($header, 0)
        if ($length -lt 2 -or $length -gt 16777216) { Stop-Broker "FRAME_INVALID" }
        $bytes = Read-Exact $pipe ([int]$length)
        if ((Hash-Bytes $bytes) -cne $responseHash) { Stop-Broker "HASH_INVALID" }
        try { $json = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) | ConvertFrom-Json }
        catch { Stop-Broker "JSON_INVALID" }
        if (-not (Exact-Keys $json @("schemaId","schemaVersion","corpusSetId","sessionId","challenge","reviewRequestHash","accessAttestationHash","annotations")) -or
            $json.schemaId -cne "xw.xhs.v3-fixed-blind-review-human-response.v1" -or $json.schemaVersion -ne 1 -or
            $json.sessionId -cne $sessionId -or $json.challenge -cne $challenge -or
            $json.reviewRequestHash -cne $requestHash -or $json.accessAttestationHash -cne $attestationHash) { Stop-Broker "BINDING_INVALID" }
        if ($adoptOrphan) {
            $existing = [IO.File]::ReadAllBytes($finalPath)
            if ((Hash-Bytes $existing) -cne $responseHash -or
                [Convert]::ToBase64String($existing) -cne [Convert]::ToBase64String($bytes)) {
                Stop-Broker "ORPHAN_RESPONSE_INVALID"
            }
            Set-ResponseAcl $finalPath $reviewerSid
            Assert-ResponseAcl $finalPath $reviewerSid
        } else {
            $stream = New-Object IO.FileStream($finalPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
            Set-ResponseAcl $finalPath $reviewerSid
            Assert-ResponseAcl $finalPath $reviewerSid
        }
        $receipt = [ordered]@{
            schemaId = "xw.xhs.v3-blind-review-admission.v1"; schemaVersion = 1; sessionId = $sessionId
            challenge = $challenge; reviewRequestHash = $requestHash; accessAttestationHash = $attestationHash
            responseHash = $responseHash; callerPrincipalHash = Hash-Text $reviewerSid
            isolationProbeHash = $probeHash; taskExecutionHash = $null
        }
        $pipe.WriteByte(1)
        $pipe.Flush()
        $pipe.Dispose()
        $pipe = $null
        $completed = $false
        for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
            $state = [string](Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop).State
            if ($state -ceq "Ready") { $completed = $true; break }
            Start-Sleep -Milliseconds 100
        }
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
        $freshExecution = if ($startedHere) {
            $taskInfo.LastRunTime -gt $initialLastRunTime -and
                $taskInfo.LastRunTime -ge $launchStarted.AddSeconds(-2)
        } else {
            $taskInfo.LastRunTime -eq $initialLastRunTime
        }
        if (-not $completed -or [Int64]$taskInfo.LastTaskResult -ne 0 -or -not $freshExecution) {
            Stop-Broker "TASK_RESULT_INVALID"
        }
        $taskDefinitionHash = Hash-Text (([ordered]@{
            taskName = $taskName; taskPath = $taskPath
            principal = ($registered.Principal | ConvertTo-Json -Compress -Depth 12)
            settings = ($registered.Settings | ConvertTo-Json -Compress -Depth 12)
            action = (@($registered.Actions)[0] | ConvertTo-Json -Compress -Depth 12)
            triggerCount = @($registered.Triggers).Count
        } | ConvertTo-Json -Compress))
        $receipt.taskExecutionHash = Hash-Text ("xw.xhs.v3-blind-review-task-execution.v1|" +
            $taskDefinitionHash + "|" + $taskInfo.LastRunTime.ToUniversalTime().Ticks + "|0")
        # The terminal admission receipt is committed only after the exact
        # S4U task instance has consumed ACK, exited, and reported result 0.
        $receiptBytes = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Compress))
        $receiptStream = New-Object IO.FileStream($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $receiptStream.Write($receiptBytes, 0, $receiptBytes.Length); $receiptStream.Flush($true) } finally { $receiptStream.Dispose() }
        Set-ResponseAcl $receiptPath $reviewerSid
        Assert-ResponseAcl $receiptPath $reviewerSid
        [Console]::Out.Write(($receipt | ConvertTo-Json -Compress))
    } finally {
        if ($null -ne $pipe) { $pipe.Dispose() }
        if ($taskCreated) {
            Remove-ExactTask
        }
    }
} catch {
    $message = [string]$_.Exception.Message
    $match = [regex]::Match($message, 'XHS_REVIEW_BROKER_[A-Z_]+')
    if ($match.Success) { [Console]::Error.Write($match.Value) }
    else { [Console]::Error.Write("XHS_REVIEW_BROKER_NATIVE_FAILURE") }
    exit 23
}
`;

export function createXhsV3BlindReviewAclController({
  platform = process.platform,
  execFileSyncFn = execFileSync,
  lstatSyncFn = lstatSync,
  readdirSyncFn = readdirSync,
  realpathSyncFn = realpathSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  computerName = process.env.COMPUTERNAME,
  nodePath = process.execPath,
} = {}) {
  if (typeof computerName !== "string" || !/^[A-Za-z0-9-]{1,63}$/u.test(computerName)) {
    throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "fixed Windows computer identity is unavailable");
  }
  if (typeof nodePath !== "string" || !isAbsolute(nodePath)) {
    throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "fixed Node executable is unavailable");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const deps = { platform, lstatSyncFn, readdirSyncFn, realpathSyncFn };
  // Windows PowerShell 5 treats redirected `-Command -` input as an
  // interactive stream and silently skips multi-line statement blocks.  Keep
  // argv fixed and put one executable statement on stdin; the program itself
  // remains entirely off argv and outside the environment block.
  const stdinProgram = (program) => `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(program, "utf8").toString("base64")}')))`;

  function invoke(action, rawPlan) {
    const plan = validatePlan(rawPlan);
    const entryCount = assertPlainTree(plan.workspaceRoot, deps);
    assertPlainTree(plan.inboxRoot, deps);
    assertPlainTree(plan.privateRoot, deps);
    assertPlainTree(plan.providerRoot, deps);
    assertPlainTree(plan.releaseRoot, deps);
    const sourceStat = lstatSyncFn(plan.sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()
      || !samePath(realpathSyncFn(plan.sourceRoot), plan.sourceRoot, platform)) {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_STRUCTURE_INVALID", "source root is not a plain directory");
    }
    if (platform !== "win32") {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNSUPPORTED", "production blind-review ACL attestation requires Windows");
    }
    let output;
    try {
      output = execFileSyncFn(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        "-",
      ], {
        input: stdinProgram(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM),
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          COMPUTERNAME: computerName,
          XW_XHS_REVIEW_ACL_ACTION: action,
          XW_XHS_REVIEW_ROOT: plan.reviewRoot,
          XW_XHS_REVIEW_WORKSPACE: plan.workspaceRoot,
          XW_XHS_REVIEW_INBOX: plan.inboxRoot,
          XW_XHS_REVIEW_PRIVATE: plan.privateRoot,
          XW_XHS_REVIEW_PROVIDER: plan.providerRoot,
          XW_XHS_REVIEW_RELEASE: plan.releaseRoot,
          XW_XHS_REVIEW_SOURCE: plan.sourceRoot,
          XW_XHS_REVIEW_ACCOUNT: XHS_V3_BLIND_REVIEWER_ACCOUNT,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const marker = /XHS_REVIEW_ACL_[A-Z_]+/u.exec(String(error?.stderr || ""))?.[0];
      throw aclError(
        marker ? marker.replace(/^XHS_REVIEW_ACL_/u, "XHS_V3_BLIND_REVIEW_ACL_")
          : "XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE",
        "native blind-review ACL policy rejected the fixed workspace/isolation boundary",
      );
    }
    let native;
    try { native = JSON.parse(String(output)); } catch {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "native blind-review ACL receipt is invalid");
    }
    if (action === "Restore" || action === "Close") {
      if (!HASH.test(native?.restoredSourceAclHash || "")) {
        throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "source ACL restoration receipt drifted");
      }
      if (action === "Close" && !HASH.test(native?.closedWorkspaceAclHash || "")) {
        throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "workspace closure receipt drifted");
      }
      return Object.freeze({
        schemaId: action === "Close" ? "xw.xhs.v3-blind-review-workspace-closure.v1"
          : "xw.xhs.v3-blind-review-source-acl-restoration.v1",
        operation: action === "Close" ? "close-review-workspace" : "restore-source-acl",
        restoredSourceAclHash: native.restoredSourceAclHash,
        ...(action === "Close" ? { closedWorkspaceAclHash: native.closedWorkspaceAclHash } : {}),
      });
    }
    if (!native || typeof native.reviewerSid !== "string"
      || !/^S-1-5-21(?:-[0-9]+){4}$/u.test(native.reviewerSid)
      || !HASH.test(native.workspaceAclHash || "") || !HASH.test(native.isolationAclHash || "")
      || !HASH.test(native.networkPolicyHash || "")) {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNVERIFIABLE", "native blind-review ACL receipt drifted");
    }
    const body = Object.freeze({
      schemaId: XHS_V3_BLIND_REVIEW_ACL_RECEIPT_SCHEMA_ID,
      operation: action === "Protect" ? "protect-and-verify" : "verify",
      reviewerPrincipalHash: sha256(Buffer.from(native.reviewerSid, "utf8")),
      workspaceAclHash: native.workspaceAclHash,
      isolationAclHash: native.isolationAclHash,
      networkPolicyHash: native.networkPolicyHash,
      entryCount,
      providerOutputAccess: "DENIED_BY_ACL",
      implementationAnswerAccess: "DENIED_BY_ACL",
      networkAccess: "DENIED_BY_FIXED_OFFLINE_ACCOUNT",
    });
    return Object.freeze({
      ...body,
      receiptHash: sha256(Buffer.from(JSON.stringify(body), "utf8")),
    });
  }

  function admitResponse(rawPlan, {
    sessionId, challenge, reviewRequestHash, accessAttestationHash, responseHash,
  } = {}) {
    const plan = validatePlan(rawPlan);
    for (const value of [sessionId, challenge, reviewRequestHash, accessAttestationHash, responseHash]) {
      if (!HASH.test(String(value ?? ""))) {
        throw aclError("XHS_V3_BLIND_REVIEW_BROKER_BINDING_INVALID", "response admission binding drifted");
      }
    }
    assertPlainTree(plan.workspaceRoot, deps);
    assertPlainTree(plan.inboxRoot, deps);
    if (platform !== "win32") {
      throw aclError("XHS_V3_BLIND_REVIEW_ACL_UNSUPPORTED", "response admission requires Windows");
    }
    let output;
    try {
      output = execFileSyncFn(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        "-",
      ], {
        input: stdinProgram(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM),
        encoding: "utf8",
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          COMPUTERNAME: computerName,
          XW_XHS_REVIEW_PIPE_NAME: `xw-xhs-v3-review-${sessionId}`,
          XW_XHS_REVIEW_INBOX: plan.inboxRoot,
          XW_XHS_REVIEW_WORKSPACE: plan.workspaceRoot,
          XW_XHS_REVIEW_NODE: resolve(nodePath),
          XW_XHS_REVIEW_CLIENT: join(plan.workspaceRoot, "templates", "xhs-v3-blind-review-submit.mjs"),
          XW_XHS_REVIEW_SESSION_ID: sessionId,
          XW_XHS_REVIEW_CHALLENGE: challenge,
          XW_XHS_REVIEW_REQUEST_HASH: reviewRequestHash,
          XW_XHS_REVIEW_ATTESTATION_HASH: accessAttestationHash,
          XW_XHS_REVIEW_RESPONSE_HASH: responseHash,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const marker = /XHS_REVIEW_BROKER_[A-Z_]+/u.exec(String(error?.stderr || ""))?.[0];
      throw aclError(
        marker ? marker.replace(/^XHS_REVIEW_BROKER_/u, "XHS_V3_BLIND_REVIEW_BROKER_")
          : "XHS_V3_BLIND_REVIEW_BROKER_UNVERIFIABLE",
        "native reviewer response broker rejected admission",
      );
    }
    let receipt;
    try { receipt = JSON.parse(String(output)); } catch {
      throw aclError("XHS_V3_BLIND_REVIEW_BROKER_UNVERIFIABLE", "response admission receipt is invalid");
    }
    if (receipt?.schemaId !== "xw.xhs.v3-blind-review-admission.v1" || receipt.schemaVersion !== 1
      || receipt.sessionId !== sessionId || receipt.challenge !== challenge
      || receipt.reviewRequestHash !== reviewRequestHash
      || receipt.accessAttestationHash !== accessAttestationHash || receipt.responseHash !== responseHash
      || !HASH.test(receipt.callerPrincipalHash || "") || !HASH.test(receipt.isolationProbeHash || "")
      || !HASH.test(receipt.taskExecutionHash || "")) {
      throw aclError("XHS_V3_BLIND_REVIEW_BROKER_UNVERIFIABLE", "response admission receipt drifted");
    }
    return Object.freeze(receipt);
  }

  return Object.freeze({
    protect(plan) { return invoke("Protect", plan); },
    verify(plan) { return invoke("Verify", plan); },
    restore(plan) { return invoke("Restore", plan); },
    close(plan) { return invoke("Close", plan); },
    admitResponse,
  });
}
