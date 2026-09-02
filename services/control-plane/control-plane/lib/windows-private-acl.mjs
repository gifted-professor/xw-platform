import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

export const WINDOWS_PRIVATE_ACL_PROBE = String.raw`
$ErrorActionPreference = "Stop"
function Stop-PrivateAclProbe {
    [Console]::Error.Write("PRIVATE_ACL_INVALID")
    exit 23
}
function Assert-PrivateAcl([string]$Path, [bool]$Directory) {
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-PrivateAclProbe }
        if ($Directory -and -not $item.PSIsContainer) { Stop-PrivateAclProbe }
        if (-not $Directory -and ($item.PSIsContainer -or -not ($item -is [IO.FileInfo]))) { Stop-PrivateAclProbe }
        $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
            [Security.AccessControl.AccessControlSections]::Access
        if ($Directory) {
            $acl = [IO.Directory]::GetAccessControl($item.FullName, $sections)
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
        } else {
            $acl = [IO.File]::GetAccessControl($item.FullName, $sections)
            $inheritance = [Security.AccessControl.InheritanceFlags]::None
        }
        $allowed = @("S-1-5-18", "S-1-5-32-544")
        $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if (-not $acl.AreAccessRulesProtected -or $allowed -notcontains $owner) { Stop-PrivateAclProbe }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 2) { Stop-PrivateAclProbe }
        foreach ($sid in $allowed) {
            $matches = @($rules | Where-Object {
                [string]$_.IdentityReference.Value -ceq $sid -and
                $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
                $_.InheritanceFlags -eq $inheritance -and
                $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
                -not $_.IsInherited
            })
            if ($matches.Count -ne 1) { Stop-PrivateAclProbe }
        }
    } catch { Stop-PrivateAclProbe }
}
try {
    $target = [IO.Path]::GetFullPath([string]$env:XW_PRIVATE_ACL_TARGET)
    if ([string]::IsNullOrWhiteSpace($target)) { Stop-PrivateAclProbe }
    Assert-PrivateAcl (Split-Path -Parent $target) $true
    Assert-PrivateAcl $target $false
    [Console]::Out.Write("PRIVATE_ACL_OK")
} catch { Stop-PrivateAclProbe }
`;

export const WINDOWS_PRIVATE_ACL_HARDENER = String.raw`
$ErrorActionPreference = "Stop"
function Stop-PrivateAclHardener {
    [Console]::Error.Write("PRIVATE_ACL_HARDEN_FAILED")
    exit 23
}
function Set-PrivateAcl([System.IO.FileSystemInfo]$Item) {
    $isDirectory = $Item -is [IO.DirectoryInfo]
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (-not $isDirectory -and -not ($Item -is [IO.FileInfo]))) { Stop-PrivateAclHardener }
    if ($isDirectory) {
        $security = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $security = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $administrators = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $security.SetOwner($administrators)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @("S-1-5-18", "S-1-5-32-544")) {
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
try {
    $target = [IO.Path]::GetFullPath([string]$env:XW_PRIVATE_ACL_TARGET)
    if ([string]::IsNullOrWhiteSpace($target)) { Stop-PrivateAclHardener }
    $parent = Get-Item -LiteralPath (Split-Path -Parent $target) -Force -ErrorAction Stop
    $file = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if (-not $parent.PSIsContainer -or $file.PSIsContainer) { Stop-PrivateAclHardener }
    Set-PrivateAcl $parent
    Set-PrivateAcl $file
    [Console]::Out.Write("PRIVATE_ACL_HARDENED")
} catch { Stop-PrivateAclHardener }
`;

function aclError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainFile(path, { lstatSyncFn }) {
  const stat = lstatSyncFn(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw aclError("KEYRING_ACL_INVALID", "private keyring must be a single-link regular file");
  }
  const parent = lstatSyncFn(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw aclError("KEYRING_ACL_INVALID", "private keyring parent must be a non-reparse directory");
  }
}

function posixPrivateAclCheck(path, { statSyncFn }) {
  const stats = statSyncFn(path);
  if ((Number(stats.mode ?? 0) & 0o077) !== 0) {
    throw aclError(
      "KEYRING_ACL_INVALID",
      "digest keyring is readable by group/other; ACL must deny by default",
    );
  }
}

export function createSystemAdministratorsPrivateAclChecker({
  platform = process.platform,
  execFileSyncFn = execFileSync,
  lstatSyncFn = lstatSync,
  statSyncFn = statSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
} = {}) {
  return function verifyPrivateAcl(path) {
    if (typeof path !== "string" || path === "") {
      throw aclError("KEYRING_ACL_UNVERIFIABLE", "digest keyring path is unavailable");
    }
    const target = resolve(path);
    try {
      assertPlainFile(target, { lstatSyncFn });
      if (platform !== "win32") {
        posixPrivateAclCheck(target, { statSyncFn });
        return;
      }
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const encoded = Buffer.from(WINDOWS_PRIVATE_ACL_PROBE, "utf16le").toString("base64");
      const output = execFileSyncFn(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encoded,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          XW_PRIVATE_ACL_TARGET: target,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (String(output) !== "PRIVATE_ACL_OK") {
        throw aclError("KEYRING_ACL_INVALID", "SYSTEM/Administrators ACL probe rejected the keyring");
      }
    } catch (error) {
      if (["KEYRING_ACL_INVALID", "KEYRING_ACL_UNVERIFIABLE"].includes(error?.code)) throw error;
      const stderr = String(error?.stderr || "");
      if (stderr.includes("PRIVATE_ACL_INVALID") || error?.status === 23) {
        throw aclError("KEYRING_ACL_INVALID", "SYSTEM/Administrators ACL drifted");
      }
      throw aclError("KEYRING_ACL_UNVERIFIABLE", "native private ACL verification failed closed");
    }
  };
}

export function createSystemAdministratorsPrivateAclHardener({
  platform = process.platform,
  execFileSyncFn = execFileSync,
  chmodSyncFn = chmodSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
} = {}) {
  return function hardenPrivateAcl(path) {
    if (typeof path !== "string" || path === "") {
      throw aclError("KEYRING_ACL_PROVISION_FAILED", "private file path is unavailable");
    }
    const target = resolve(path);
    try {
      if (platform !== "win32") {
        chmodSyncFn(dirname(target), 0o700);
        chmodSyncFn(target, 0o600);
        return;
      }
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const encoded = Buffer.from(WINDOWS_PRIVATE_ACL_HARDENER, "utf16le").toString("base64");
      const output = execFileSyncFn(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encoded,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          XW_PRIVATE_ACL_TARGET: target,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (String(output) !== "PRIVATE_ACL_HARDENED") {
        throw aclError("KEYRING_ACL_PROVISION_FAILED", "native private ACL hardener returned an invalid receipt");
      }
    } catch (error) {
      if (error?.code === "KEYRING_ACL_PROVISION_FAILED") throw error;
      throw aclError("KEYRING_ACL_PROVISION_FAILED", "native private ACL hardening failed closed");
    }
  };
}

export const SYSTEM_ADMINISTRATORS_PRIVATE_SIDS = Object.freeze([SYSTEM_SID, ADMINISTRATORS_SID]);
