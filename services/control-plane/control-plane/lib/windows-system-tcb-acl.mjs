/**
 * Windows SYSTEM execution TCB ACL boundary.
 *
 * A content hash cannot protect code before its first instruction executes, or
 * close a verify-then-spawn race.  Files reachable by a SYSTEM task therefore
 * live below a protected boundary whose owner and write authorities are exactly
 * LocalSystem and BUILTIN\Administrators.  The native probe also rejects a
 * writable/delete-capable ancestor, reparse traversal, and linked files.
 *
 * POSIX callers retain their existing file modes.  They still receive the
 * structural regular-file/no-symlink checks, but this Windows DACL policy is a
 * no-op outside win32.
 */
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const SYSTEM_TCB_ACL_PLAN_SCHEMA_ID = "xw.runtime.system-tcb-acl-plan.v1";
export const SYSTEM_TCB_ACL_RECEIPT_SCHEMA_ID = "xw.runtime.system-tcb-acl-receipt.v1";

const MAX_TREE_ENTRIES = 200_000;

// Windows PowerShell 5.1 compatible and deliberately ASCII-only.  No secret
// environment is inherited by the probe.
export const WINDOWS_SYSTEM_TCB_ACL_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$SystemSid = "S-1-5-18"
$AdministratorsSid = "S-1-5-32-544"
$TrustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
$AllowedWriters = @($SystemSid, $AdministratorsSid)
$AllowedAncestorOwners = @($SystemSid, $AdministratorsSid, $TrustedInstallerSid)
$AncestorDangerousRights = [Int64]64 -bor [Int64]65536 -bor [Int64]262144 -bor [Int64]524288

function Stop-TcbAcl([string]$Code) {
    [Console]::Error.Write("TCB_ACL_" + $Code)
    exit 23
}

function Full-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
        Stop-TcbAcl "PATH_INVALID"
    }
    try { return [IO.Path]::GetFullPath($Value) }
    catch { Stop-TcbAcl "PATH_INVALID" }
}

function Same-Path([string]$Left, [string]$Right) {
    return (Full-Path $Left).Equals((Full-Path $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Within-Or-Same([string]$Root, [string]$Candidate) {
    $rootFull = (Full-Path $Root).TrimEnd('\')
    $candidateFull = Full-Path $Candidate
    return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Plain-Item([string]$Path) {
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch { Stop-TcbAcl "PATH_UNAVAILABLE" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-TcbAcl "REPARSE_FORBIDDEN"
    }
    if (-not $item.PSIsContainer -and -not ($item -is [IO.FileInfo])) {
        Stop-TcbAcl "TYPE_INVALID"
    }
    return $item
}

function Access-Control([System.IO.FileSystemInfo]$Item) {
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Access
    if ($Item.PSIsContainer) {
        return [IO.Directory]::GetAccessControl($Item.FullName, $sections)
    }
    return [IO.File]::GetAccessControl($Item.FullName, $sections)
}

function Assert-ProtectedTcbAcl([System.IO.FileSystemInfo]$Item) {
    $acl = Access-Control $Item
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $AllowedWriters -notcontains $owner -or $rules.Count -ne 2) {
        Stop-TcbAcl "TARGET_DACL_INVALID"
    }
    $expectedInheritance = if ($Item.PSIsContainer) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sidValue in $AllowedWriters) {
        $matches = @($rules | Where-Object {
            [string]$_.IdentityReference.Value -ceq $sidValue -and
                $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
                $_.InheritanceFlags -eq $expectedInheritance -and
                $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
                -not $_.IsInherited
        })
        if ($matches.Count -ne 1) { Stop-TcbAcl "TARGET_DACL_INVALID" }
    }
}

function Set-ProtectedTcbAcl([System.IO.FileSystemInfo]$Item) {
    if ($Item.PSIsContainer) {
        $security = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $administrators = New-Object Security.Principal.SecurityIdentifier($AdministratorsSid)
    $security.SetOwner($administrators)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in $AllowedWriters) {
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
    if ($Item.PSIsContainer) {
        [IO.Directory]::SetAccessControl($Item.FullName, [Security.AccessControl.DirectorySecurity]$security)
    } else {
        [IO.File]::SetAccessControl($Item.FullName, [Security.AccessControl.FileSecurity]$security)
    }
}

function Assert-SafeExternalAncestor([System.IO.FileSystemInfo]$Item) {
    $acl = Access-Control $Item
    $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($AllowedAncestorOwners -notcontains $owner) { Stop-TcbAcl "ANCESTOR_OWNER_INVALID" }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        $sidValue = [string]$rule.IdentityReference.Value
        $rights = [Int64]$rule.FileSystemRights
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) -and
            $AllowedWriters -notcontains $sidValue -and
            (($rights -band $AncestorDangerousRights) -ne 0)) {
            Stop-TcbAcl "ANCESTOR_WRITABLE"
        }
    }
}

function Assert-ElevatedWriter {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ([string]$identity.User.Value -ceq $SystemSid) { return }
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
    } catch { }
    Stop-TcbAcl "ELEVATION_REQUIRED"
}

try {
    $action = [string]$env:XW_TCB_ACL_ACTION
    if (@("Protect", "ProtectTarget", "Verify", "VerifyTarget") -notcontains $action) {
        Stop-TcbAcl "ACTION_INVALID"
    }
    $boundary = Full-Path ([string]$env:XW_TCB_ACL_BOUNDARY)
    $target = Full-Path ([string]$env:XW_TCB_ACL_TARGET)
    $recursive = [string]$env:XW_TCB_ACL_RECURSIVE -ceq "1"
    if (-not (Within-Or-Same $boundary $target)) { Stop-TcbAcl "PATH_ESCAPE" }

    $boundaryItem = Plain-Item $boundary
    $targetItem = Plain-Item $target
    if (-not $boundaryItem.PSIsContainer) { Stop-TcbAcl "BOUNDARY_TYPE_INVALID" }

    # The full path chain must be plain.  Ancestors outside the managed TCB
    # boundary may keep OS read/create policy, but no untrusted principal may
    # own them or delete/change/take ownership of the protected child chain.
    $managedChain = New-Object System.Collections.Generic.List[System.IO.FileSystemInfo]
    $cursor = $target
    $sawBoundary = $false
    while ($true) {
        $item = Plain-Item $cursor
        $managedChain.Add($item)
        if (Same-Path $cursor $boundary) { $sawBoundary = $true; break }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Same-Path $parent $cursor)) { break }
        $cursor = $parent
    }
    if (-not $sawBoundary) { Stop-TcbAcl "PATH_ESCAPE" }
    $cursor = Split-Path -Parent $boundary
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        $item = Plain-Item $cursor
        Assert-SafeExternalAncestor $item
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Same-Path $parent $cursor)) { break }
        $cursor = $parent
    }

    $items = New-Object System.Collections.Generic.List[System.IO.FileSystemInfo]
    $items.Add($targetItem)
    if ($recursive -and $targetItem.PSIsContainer) {
        foreach ($item in @(Get-ChildItem -LiteralPath $target -Force -Recurse -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                (-not $item.PSIsContainer -and -not ($item -is [IO.FileInfo]))) {
                Stop-TcbAcl "TREE_TYPE_INVALID"
            }
            $items.Add($item)
            if ($items.Count -gt 200000) { Stop-TcbAcl "TREE_TOO_LARGE" }
        }
    }

    if ($action -ceq "Protect") {
        Assert-ElevatedWriter
        # Boundary/ancestor directories first: a target file is not protected
        # if an untrusted writer can replace one of its path components.
        foreach ($item in @($managedChain | Where-Object { $_.PSIsContainer } |
            Sort-Object { $_.FullName.Length })) {
            Set-ProtectedTcbAcl $item
        }
        # Then seal the complete target tree parent-first.
        foreach ($item in @($items | Sort-Object { $_.FullName.Length })) {
            Set-ProtectedTcbAcl $item
        }
    } elseif ($action -ceq "ProtectTarget") {
        Assert-ElevatedWriter
        if ($recursive -or $targetItem.PSIsContainer) { Stop-TcbAcl "ACTION_INVALID" }
        foreach ($item in @($managedChain | Where-Object { $_.PSIsContainer })) {
            Assert-ProtectedTcbAcl $item
        }
        Set-ProtectedTcbAcl $targetItem
    }
    if ($action -ceq "VerifyTarget") {
        if ($recursive -or $targetItem.PSIsContainer) { Stop-TcbAcl "ACTION_INVALID" }
        Assert-ProtectedTcbAcl $targetItem
    } else {
        foreach ($item in $managedChain) { Assert-ProtectedTcbAcl $item }
        foreach ($item in $items) { Assert-ProtectedTcbAcl $item }
    }
    [Console]::Out.Write("TCB_ACL_OK")
} catch {
    Stop-TcbAcl "NATIVE_FAILURE"
}
`;

function tcbError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function pathKey(value, platform) {
  const full = resolve(value);
  return platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right, platform) {
  return pathKey(left, platform) === pathKey(right, platform);
}

function withinOrSame(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function buildSystemTcbAclPlan({
  boundaryPath,
  targetPath,
  recursive = true,
} = {}) {
  if (typeof boundaryPath !== "string" || !isAbsolute(boundaryPath)
    || typeof targetPath !== "string" || !isAbsolute(targetPath)
    || typeof recursive !== "boolean") {
    throw tcbError("SYSTEM_TCB_ACL_PLAN_INVALID", "absolute boundary/target paths and a boolean recursive flag are required");
  }
  const boundary = resolve(boundaryPath);
  const target = resolve(targetPath);
  if (!withinOrSame(boundary, target)) {
    throw tcbError("SYSTEM_TCB_ACL_PATH_ESCAPE", "TCB target escapes its protected boundary");
  }
  return Object.freeze({
    schemaId: SYSTEM_TCB_ACL_PLAN_SCHEMA_ID,
    boundaryPath: boundary,
    targetPath: target,
    recursive,
    ownerSids: Object.freeze(["S-1-5-18", "S-1-5-32-544"]),
    writableSids: Object.freeze(["S-1-5-18", "S-1-5-32-544"]),
    protectedDacl: true,
    rejectReparse: true,
    rejectLinkedFiles: true,
    verifyExternalAncestors: true,
  });
}

function validatePlan(plan) {
  if (plan?.schemaId !== SYSTEM_TCB_ACL_PLAN_SCHEMA_ID
    || !Array.isArray(plan.ownerSids) || !Array.isArray(plan.writableSids)
    || plan.ownerSids.join("\0") !== "S-1-5-18\0S-1-5-32-544"
    || plan.writableSids.join("\0") !== "S-1-5-18\0S-1-5-32-544"
    || plan.protectedDacl !== true || plan.rejectReparse !== true
    || plan.rejectLinkedFiles !== true || plan.verifyExternalAncestors !== true
    || typeof plan.recursive !== "boolean") {
    throw tcbError("SYSTEM_TCB_ACL_PLAN_INVALID", "TCB ACL plan shape or authority set drifted");
  }
  return buildSystemTcbAclPlan(plan);
}

function assertPlainItem(path, {
  expectDirectory = null,
  platform,
  lstatSyncFn,
  realpathSyncFn,
}) {
  let stat;
  try {
    stat = lstatSyncFn(path);
  } catch {
    throw tcbError("SYSTEM_TCB_ACL_PATH_UNAVAILABLE", "TCB path is absent or unreadable");
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
    || (stat.isFile() && stat.nlink !== 1)
    || (expectDirectory === true && !stat.isDirectory())
    || (expectDirectory === false && !stat.isFile())) {
    throw tcbError("SYSTEM_TCB_ACL_STRUCTURE_INVALID", "TCB path is linked, reparsed, or has the wrong type");
  }
  let real;
  try {
    real = realpathSyncFn(path);
  } catch {
    throw tcbError("SYSTEM_TCB_ACL_STRUCTURE_INVALID", "TCB path cannot be resolved without a reparse hop");
  }
  if (!samePath(real, path, platform)) {
    throw tcbError("SYSTEM_TCB_ACL_REPARSE_FORBIDDEN", "TCB path resolves through a reparse point");
  }
  return stat;
}

function assertAncestorChain(plan, deps) {
  let cursor = plan.targetPath;
  let count = 0;
  while (true) {
    assertPlainItem(cursor, {
      expectDirectory: samePath(cursor, plan.boundaryPath, deps.platform) ? true : null,
      ...deps,
    });
    count += 1;
    if (samePath(cursor, plan.boundaryPath, deps.platform)) return;
    if (count > MAX_TREE_ENTRIES) {
      throw tcbError("SYSTEM_TCB_ACL_TREE_TOO_LARGE", "TCB ancestor chain exceeded its bound");
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw tcbError("SYSTEM_TCB_ACL_PATH_ESCAPE", "TCB boundary was not reached");
    cursor = parent;
  }
}

function assertStructuralTree(plan, deps) {
  assertAncestorChain(plan, deps);
  const rootStat = assertPlainItem(plan.targetPath, deps);
  if (!plan.recursive || !rootStat.isDirectory()) return 1;
  const pending = [plan.targetPath];
  let count = 1;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = deps.readdirSyncFn(directory, { withFileTypes: true });
    } catch {
      throw tcbError("SYSTEM_TCB_ACL_STRUCTURE_INVALID", "TCB tree is unreadable");
    }
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const stat = assertPlainItem(target, deps);
      count += 1;
      if (count > MAX_TREE_ENTRIES) {
        throw tcbError("SYSTEM_TCB_ACL_TREE_TOO_LARGE", "TCB tree exceeded its entry bound");
      }
      if (stat.isDirectory()) pending.push(target);
    }
  }
  return count;
}

export function assertSystemTcbAclSnapshot(snapshot, { ancestor = false } = {}) {
  const trusted = new Set(["S-1-5-18", "S-1-5-32-544"]);
  const trustedAncestorOwners = new Set([...trusted, "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]);
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.rules)) {
    throw tcbError("SYSTEM_TCB_ACL_SNAPSHOT_INVALID", "ACL snapshot is malformed");
  }
  if (ancestor) {
    if (!trustedAncestorOwners.has(snapshot.ownerSid)) {
      throw tcbError("SYSTEM_TCB_ACL_ANCESTOR_OWNER_INVALID", "external ancestor owner is not trusted");
    }
    const dangerousMask = 64 | 65_536 | 262_144 | 524_288;
    if (snapshot.rules.some((rule) => rule?.type === "allow" && rule.appliesToSelf !== false && !trusted.has(rule.sid)
      && (Number(rule.rights) & dangerousMask) !== 0)) {
      throw tcbError("SYSTEM_TCB_ACL_ANCESTOR_WRITABLE", "external ancestor can delete or retake the TCB boundary");
    }
    return true;
  }
  if (!trusted.has(snapshot.ownerSid) || snapshot.protected !== true || snapshot.rules.length !== 2) {
    throw tcbError("SYSTEM_TCB_ACL_TARGET_DACL_INVALID", "target owner or protected DACL drifted");
  }
  for (const sid of trusted) {
    const matches = snapshot.rules.filter((rule) => rule?.sid === sid && rule.type === "allow"
      && rule.rights === 2_032_127 && rule.inherited === false);
    if (matches.length !== 1) {
      throw tcbError("SYSTEM_TCB_ACL_TARGET_DACL_INVALID", "target has an unexpected writable authority");
    }
  }
  return true;
}

export function createSystemTcbAclController({
  platform = process.platform,
  execFileSyncFn = execFileSync,
  lstatSyncFn = lstatSync,
  readdirSyncFn = readdirSync,
  realpathSyncFn = realpathSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
} = {}) {
  const deps = { platform, lstatSyncFn, readdirSyncFn, realpathSyncFn };
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedProgram = Buffer.from(WINDOWS_SYSTEM_TCB_ACL_PROGRAM, "utf16le").toString("base64");

  function invokeNative(action, plan) {
    if (platform !== "win32") return;
    let output;
    try {
      output = execFileSyncFn(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedProgram,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          XW_TCB_ACL_ACTION: action,
          XW_TCB_ACL_BOUNDARY: plan.boundaryPath,
          XW_TCB_ACL_TARGET: plan.targetPath,
          XW_TCB_ACL_RECURSIVE: plan.recursive ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const marker = /TCB_ACL_[A-Z_]+/u.exec(String(error?.stderr || ""))?.[0] ?? null;
      throw tcbError(
        marker ? `SYSTEM_${marker}` : "SYSTEM_TCB_ACL_UNVERIFIABLE",
        marker ? "native Windows TCB ACL policy rejected the path" : "native Windows TCB ACL verification failed closed",
      );
    }
    if (String(output) !== "TCB_ACL_OK") {
      throw tcbError("SYSTEM_TCB_ACL_UNVERIFIABLE", "native Windows TCB ACL verifier returned an unexpected receipt");
    }
  }

  function verify(rawPlan) {
    const plan = validatePlan(rawPlan);
    const entryCount = assertStructuralTree(plan, deps);
    invokeNative("Verify", plan);
    return Object.freeze({
      ok: true,
      schemaId: SYSTEM_TCB_ACL_RECEIPT_SCHEMA_ID,
      operation: "verify",
      platform,
      entryCount,
      boundaryPath: plan.boundaryPath,
      targetPath: plan.targetPath,
      protectedDacl: platform === "win32" ? "verified" : "not-applicable",
    });
  }

  function protect(rawPlan) {
    const plan = validatePlan(rawPlan);
    assertStructuralTree(plan, deps);
    invokeNative("Protect", plan);
    const receipt = verify(plan);
    return Object.freeze({ ...receipt, operation: "protect-and-verify" });
  }

  function verifyTarget(rawPlan) {
    const plan = validatePlan(rawPlan);
    const targetStat = assertPlainItem(plan.targetPath, { expectDirectory: false, ...deps });
    if (plan.recursive || !targetStat.isFile()) {
      throw tcbError("SYSTEM_TCB_ACL_PLAN_INVALID", "target-only verification requires one non-recursive file plan");
    }
    assertAncestorChain(plan, deps);
    invokeNative("VerifyTarget", plan);
    return Object.freeze({
      ok: true,
      schemaId: SYSTEM_TCB_ACL_RECEIPT_SCHEMA_ID,
      operation: "verify-target",
      platform,
      entryCount: 1,
      boundaryPath: plan.boundaryPath,
      targetPath: plan.targetPath,
      protectedDacl: platform === "win32" ? "verified" : "not-applicable",
    });
  }

  function protectTarget(rawPlan) {
    const plan = validatePlan(rawPlan);
    const targetStat = assertPlainItem(plan.targetPath, { expectDirectory: false, ...deps });
    if (plan.recursive || !targetStat.isFile()) {
      throw tcbError("SYSTEM_TCB_ACL_PLAN_INVALID", "target-only protect requires one non-recursive file plan");
    }
    assertAncestorChain(plan, deps);
    invokeNative("ProtectTarget", plan);
    const receipt = verify(plan);
    return Object.freeze({ ...receipt, operation: "protect-target-and-verify" });
  }

  return Object.freeze({ protect, protectTarget, verify, verifyTarget });
}
