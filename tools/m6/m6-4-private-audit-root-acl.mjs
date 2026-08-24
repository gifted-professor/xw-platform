import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, posix, resolve, win32 } from "node:path";

const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";
const SID_PATTERN = /^S-\d+(?:-\d+)+$/u;
const WINDOWS_ACL_SCHEMA = "xw.m6-4-private-audit-root-acl-inspection.v1";
const MAX_ACL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_ENTRIES = 100_000;
const WINDOWS_ACL_INSPECTION_TIMEOUT_MS = 60_000;

// FileSystemRights: write data, append/create directory, write extended
// attributes, delete children, write attributes, delete, change DACL, owner.
const DANGEROUS_RIGHTS_MASK = 2 | 4 | 16 | 64 | 256 | 65_536 | 262_144 | 524_288;
const REQUIRED_CURRENT_WRITE_MASK = 2 | 4 | 16 | 256;

const WINDOWS_ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Read-AclNode([System.IO.FileSystemInfo]$Item, [string]$RelativePath, [string]$Kind) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "M64_AUDIT_REPARSE_POINT" }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    if ($Kind -eq "DIRECTORY") {
        $acl = [IO.Directory]::GetAccessControl($Item.FullName, $sections)
    } else {
        $acl = [IO.File]::GetAccessControl($Item.FullName, $sections)
    }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
        [ordered]@{
            sid = [string]$_.IdentityReference.Value
            type = [string]$_.AccessControlType.ToString()
            rights = [int64]$_.FileSystemRights
            inherited = [bool]$_.IsInherited
        }
    })
    return [ordered]@{
        relativePath = $RelativePath
        kind = $Kind
        ownerSid = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        areAccessRulesProtected = [bool]$acl.AreAccessRulesProtected
        rules = @($rules)
    }
}

$encodedPath = [Environment]::GetEnvironmentVariable("M64_AUDIT_ROOT_PATH_B64", "Process")
if ([string]::IsNullOrWhiteSpace($encodedPath)) { throw "M64_AUDIT_PATH_MISSING" }
$auditRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
if ([string]::IsNullOrWhiteSpace($auditRoot) -or -not [IO.Path]::IsPathRooted($auditRoot)) { throw "M64_AUDIT_PATH_INVALID" }
$auditRoot = [IO.Path]::GetFullPath($auditRoot)
$root = Get-Item -LiteralPath $auditRoot -Force -ErrorAction Stop
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "M64_AUDIT_ROOT_INVALID"
}

$nodes = New-Object System.Collections.Generic.List[object]
$pending = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
$pending.Push([System.IO.DirectoryInfo]$root)
$rootPrefix = $auditRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    if ($directory.FullName -eq $auditRoot) { $relative = "." }
    else { $relative = $directory.FullName.Substring($rootPrefix.Length) }
    $nodes.Add((Read-AclNode $directory $relative "DIRECTORY"))
    if ($nodes.Count -gt ${MAX_AUDIT_ENTRIES}) { throw "M64_AUDIT_TREE_TOO_LARGE" }
    foreach ($child in @($directory.GetFileSystemInfos())) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "M64_AUDIT_REPARSE_POINT" }
        if ($child.PSIsContainer) {
            $pending.Push([System.IO.DirectoryInfo]$child)
        } elseif ($child -is [System.IO.FileInfo]) {
            $childRelative = $child.FullName.Substring($rootPrefix.Length)
            $nodes.Add((Read-AclNode $child $childRelative "FILE"))
            if ($nodes.Count -gt ${MAX_AUDIT_ENTRIES}) { throw "M64_AUDIT_TREE_TOO_LARGE" }
        } else {
            throw "M64_AUDIT_ENTRY_INVALID"
        }
    }
}

[ordered]@{
    schemaId = "${WINDOWS_ACL_SCHEMA}"
    currentSid = [string]([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    nodes = $nodes.ToArray()
} | ConvertTo-Json -Compress -Depth 6
`;

function fail(reason) {
  const error = new Error(`M64_AUDIT_ROOT_ACL_INVALID:${reason}`);
  error.code = "M64_AUDIT_ROOT_ACL_INVALID";
  throw error;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertAbsolutePath(path, platform) {
  if (typeof path !== "string" || path.length === 0 || path.length > 32_767 || path.includes("\0")) {
    fail("PATH_INVALID");
  }
  const absolute = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!absolute) fail("PATH_NOT_ABSOLUTE");
}

function validateRelativeWindowsPath(value, root) {
  if (value === ".") return root;
  if (typeof value !== "string" || value === "" || value.includes("\0")
    || win32.isAbsolute(value) || posix.isAbsolute(value)) fail("NODE_PATH_INVALID");
  const parts = value.split(/[\\/]/u);
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail("NODE_PATH_INVALID");
  return value.toLowerCase();
}

function validateWindowsInspection(value) {
  if (!exactKeys(value, ["schemaId", "currentSid", "nodes"])
    || value.schemaId !== WINDOWS_ACL_SCHEMA
    || !SID_PATTERN.test(value.currentSid)
    || !Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > MAX_AUDIT_ENTRIES) {
    fail("INSPECTION_SCHEMA_INVALID");
  }

  const allowedDangerousSids = new Set([
    value.currentSid.toUpperCase(), LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID,
  ]);
  const seen = new Set();
  let root = null;
  for (const node of value.nodes) {
    if (!exactKeys(node, ["relativePath", "kind", "ownerSid", "areAccessRulesProtected", "rules"])
      || !["DIRECTORY", "FILE"].includes(node.kind)
      || !SID_PATTERN.test(node.ownerSid)
      || typeof node.areAccessRulesProtected !== "boolean"
      || !Array.isArray(node.rules) || node.rules.length > 4096) {
      fail("NODE_SCHEMA_INVALID");
    }
    const pathKey = validateRelativeWindowsPath(node.relativePath, ".");
    if (seen.has(pathKey)) fail("NODE_PATH_DUPLICATE");
    seen.add(pathKey);
    if (node.relativePath === ".") {
      if (node.kind !== "DIRECTORY" || root !== null) fail("ROOT_NODE_INVALID");
      root = node;
    }
    if (!allowedDangerousSids.has(node.ownerSid.toUpperCase())) fail("OWNER_NOT_ALLOWED");

    let currentWriteRights = 0;
    for (const rule of node.rules) {
      if (!exactKeys(rule, ["sid", "type", "rights", "inherited"])
        || !SID_PATTERN.test(rule.sid) || !["Allow", "Deny"].includes(rule.type)
        || !Number.isSafeInteger(rule.rights) || rule.rights < 0 || rule.rights > 0x7fffffff
        || typeof rule.inherited !== "boolean") {
        fail("RULE_SCHEMA_INVALID");
      }
      const dangerous = (rule.rights & DANGEROUS_RIGHTS_MASK) !== 0;
      if (rule.type === "Allow" && dangerous
        && !allowedDangerousSids.has(rule.sid.toUpperCase())) fail("DANGEROUS_ALLOW_NOT_ALLOWED");
      // A write-capable deny can make the current identity's effective access
      // ambiguous through token-group membership, so reject it rather than guess.
      if (rule.type === "Deny" && dangerous) fail("DANGEROUS_DENY_PRESENT");
      if (rule.type === "Allow" && rule.sid.toUpperCase() === value.currentSid.toUpperCase()) {
        currentWriteRights |= rule.rights;
      }
    }
    if ((currentWriteRights & REQUIRED_CURRENT_WRITE_MASK) !== REQUIRED_CURRENT_WRITE_MASK) {
      fail("CURRENT_IDENTITY_NOT_WRITABLE");
    }
  }
  if (root === null || !root.areAccessRulesProtected || root.rules.some((rule) => rule.inherited)) {
    fail("ROOT_DACL_NOT_PROTECTED");
  }
  return Object.freeze({
    ok: true,
    platform: "win32",
    currentSid: value.currentSid,
    ownerSid: root.ownerSid,
    entriesChecked: value.nodes.length,
  });
}

function windowsInspection(path, processRunner) {
  const encodedScript = Buffer.from(WINDOWS_ACL_INSPECTION_SCRIPT, "utf16le").toString("base64");
  const environment = Object.freeze({
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    M64_AUDIT_ROOT_PATH_B64: Buffer.from(path, "utf8").toString("base64"),
  });
  let result;
  try {
    result = processRunner(WINDOWS_POWERSHELL, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript,
    ], {
      cwd: String.raw`C:\Windows\System32`,
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_ACL_OUTPUT_BYTES,
      timeout: WINDOWS_ACL_INSPECTION_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    fail("INSPECTION_PROCESS_FAILED");
  }
  const stdout = typeof result?.stdout === "string" ? result.stdout : result?.stdout?.toString?.("utf8");
  const stderr = typeof result?.stderr === "string" ? result.stderr : result?.stderr?.toString?.("utf8");
  if (result?.error || result?.signal || result?.status !== 0 || (stderr ?? "").trim() !== ""
    || typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_ACL_OUTPUT_BYTES) {
    fail("INSPECTION_PROCESS_FAILED");
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { fail("INSPECTION_JSON_INVALID"); }
  return validateWindowsInspection(parsed);
}

function validatePosixTree(path) {
  if (typeof process.getuid !== "function") fail("POSIX_IDENTITY_UNAVAILABLE");
  const currentUid = process.getuid();
  const pending = [resolve(path)];
  let checked = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let item;
    try { item = lstatSync(current); } catch { fail("POSIX_STAT_FAILED"); }
    if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) fail("POSIX_ENTRY_INVALID");
    if (item.uid !== currentUid) fail("POSIX_OWNER_INVALID");
    const permissions = item.mode & 0o777;
    const ownerRequired = item.isDirectory() ? 0o700 : 0o600;
    if ((permissions & ownerRequired) !== ownerRequired || (permissions & 0o077) !== 0) {
      fail("POSIX_MODE_INVALID");
    }
    checked += 1;
    if (checked > MAX_AUDIT_ENTRIES) fail("POSIX_TREE_TOO_LARGE");
    if (item.isDirectory()) {
      let names;
      try { names = readdirSync(current); } catch { fail("POSIX_READDIR_FAILED"); }
      for (const name of names) pending.push(resolve(current, name));
    }
  }
  return Object.freeze({ ok: true, platform: "posix", ownerUid: currentUid, entriesChecked: checked });
}

/**
 * Read-only, fail-closed validation for the durable M6-4 audit tree.
 * The injected runner exists only for deterministic unit testing.
 */
export function assertM64PrivateAuditRootAcl(path, {
  platform = process.platform,
  processRunner = spawnSync,
} = {}) {
  if (!new Set(["win32", "linux", "darwin", "freebsd", "openbsd"]).has(platform)) {
    fail("PLATFORM_UNSUPPORTED");
  }
  assertAbsolutePath(path, platform);
  if (platform === "win32") {
    if (typeof processRunner !== "function") fail("PROCESS_RUNNER_INVALID");
    return windowsInspection(win32.normalize(path), processRunner);
  }
  return validatePosixTree(path);
}
