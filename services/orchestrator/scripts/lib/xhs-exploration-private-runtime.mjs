/**
 * Create-only, content-addressed private execution tree for the exploration
 * vision provider. Source bytes may be discovered in a user profile for P4A
 * staging, but production config and spawn paths are restricted to this
 * SYSTEM/Administrators-owned Program Files namespace.
 */
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX,
  readExplorationVisionProviderBundle,
  verifyExplorationVisionProviderBundle,
  verifyPythonRuntimeClosure,
} from "./xhs-exploration-provider-bundle.mjs";

export const EXPLORATION_VISION_PRIVATE_ANCHOR = join("C:\\", "Program Files", "XW Platform");
export const EXPLORATION_VISION_PRIVATE_PROVIDER_ROOT = join(
  EXPLORATION_VISION_PRIVATE_ANCHOR,
  "providers",
);

const HEX_64 = /^[0-9a-f]{64}$/;

function privateError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    name: "ExplorationVisionPrivateRuntimeError",
    status: 409,
    details,
  });
}

export function privateProviderRootForDigest(providerBundleDigest, {
  providerRoot = EXPLORATION_VISION_PRIVATE_PROVIDER_ROOT,
} = {}) {
  if (!HEX_64.test(String(providerBundleDigest ?? "")) || !isAbsolute(providerRoot)) {
    throw privateError("EXPLORATION_VISION_PRIVATE_PATH_INVALID", "private provider root/digest is invalid");
  }
  return join(resolve(providerRoot), providerBundleDigest);
}

function runtimeDataDestination(targetRoot, logicalPath) {
  const relative = logicalPath.slice(EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX.length).split("/");
  if (relative[0] === "root") relative.shift();
  return join(targetRoot, "runtime", ...relative);
}

export function privateProviderInputs({
  targetRoot,
  source = null,
  manifest,
} = {}) {
  if (!targetRoot || !isAbsolute(targetRoot) || !manifest) {
    throw privateError("EXPLORATION_VISION_PRIVATE_PATH_INVALID", "private provider mapping needs an absolute target and manifest");
  }
  const dataByLogicalPath = source
    ? new Map((source.dataFiles ?? []).map((row) => [row.logicalPath, row]))
    : null;
  const dataFiles = manifest.files.filter((row) => row.role === "data").map((row) => {
    if (dataByLogicalPath && !dataByLogicalPath.has(row.logicalPath)) {
      throw privateError("EXPLORATION_VISION_PRIVATE_SOURCE_INVALID", "private provider source data closure is incomplete");
    }
    return {
      logicalPath: row.logicalPath,
      path: row.logicalPath.startsWith(EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX)
        ? runtimeDataDestination(targetRoot, row.logicalPath)
        : join(targetRoot, "aux", ...row.logicalPath.split("/")),
      ...(dataByLogicalPath ? { sourcePath: dataByLogicalPath.get(row.logicalPath).path } : {}),
    };
  });
  return {
    manifestPath: join(targetRoot, "provider-bundle.v1.json"),
    python: join(targetRoot, "runtime", "python.exe"),
    script: join(targetRoot, "provider", "analyze.py"),
    model: join(targetRoot, "model", "pause-zone-model.v1.json"),
    dataFiles,
  };
}

function walkTree(root) {
  const rows = [];
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && Number(stat.nlink ?? 1) !== 1)) {
      throw privateError("EXPLORATION_VISION_PRIVATE_TREE_INVALID", "private provider tree contains a reparse/special/hardlinked entry");
    }
    rows.push({ path, directory: stat.isDirectory(), stat });
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    }
  }
  visit(root);
  return rows;
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath([string]$env:XW_PROVIDER_PRIVATE_ROOT)
$mode = [string]$env:XW_PROVIDER_PRIVATE_MODE
$system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$admins = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
function Stop-Acl { [Console]::Error.Write("PROVIDER_PRIVATE_ACL_INVALID"); exit 23 }
function Get-Items([string]$Path) {
  @((Get-Item -LiteralPath $Path -Force -ErrorAction Stop)) +
    @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)
}
function Set-Exact([IO.FileSystemInfo]$Item) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Acl }
  if ($Item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($system)
  foreach ($sid in @($system, $admins)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  if ($Item.PSIsContainer) { [IO.Directory]::SetAccessControl($Item.FullName, $acl) }
  else { [IO.File]::SetAccessControl($Item.FullName, $acl) }
}
function Assert-Exact([IO.FileSystemInfo]$Item) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Acl }
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  if ($Item.PSIsContainer) {
    $acl = [IO.Directory]::GetAccessControl($Item.FullName, $sections)
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [IO.File]::GetAccessControl($Item.FullName, $sections)
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  if (-not $acl.AreAccessRulesProtected) { Stop-Acl }
  $owner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (@("S-1-5-18", "S-1-5-32-544") -notcontains $owner) { Stop-Acl }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { Stop-Acl }
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
    $match = @($rules | Where-Object {
      [string]$_.IdentityReference.Value -ceq $sid -and -not $_.IsInherited -and
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
      $_.InheritanceFlags -eq $inherit -and
      $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
    })
    if ($match.Count -ne 1) { Stop-Acl }
  }
}
try {
  $items = Get-Items $root
  if ($mode -ceq "set") { foreach ($item in $items) { Set-Exact $item }; $items = Get-Items $root }
  foreach ($item in $items) { Assert-Exact $item }
  [Console]::Out.Write("PROVIDER_PRIVATE_ACL_OK")
} catch { Stop-Acl }
`;

function windowsAcl(path, mode, {
  execFileSyncFn = execFileSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || join("C:\\", "Windows"),
} = {}) {
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = execFileSyncFn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024,
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      XW_PROVIDER_PRIVATE_ROOT: resolve(path),
      XW_PROVIDER_PRIVATE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (String(output) !== "PROVIDER_PRIVATE_ACL_OK") {
    throw privateError("EXPLORATION_VISION_PRIVATE_ACL_INVALID", "private provider ACL probe did not return success");
  }
}

export function hardenPrivateProviderTree(path, { platform = process.platform, ...deps } = {}) {
  walkTree(path);
  if (platform === "win32") {
    windowsAcl(path, "set", deps);
  } else {
    for (const row of walkTree(path)) chmodSync(row.path, row.directory ? 0o700 : 0o600);
  }
  return verifyPrivateProviderTree(path, { platform, ...deps });
}

export function verifyPrivateProviderTree(path, { platform = process.platform, ...deps } = {}) {
  const rows = walkTree(path);
  if (platform === "win32") {
    try {
      windowsAcl(path, "verify", deps);
    } catch (error) {
      if (error?.code === "EXPLORATION_VISION_PRIVATE_ACL_INVALID") throw error;
      throw privateError("EXPLORATION_VISION_PRIVATE_ACL_INVALID", "SYSTEM/Administrators private provider ACL verification failed");
    }
  } else if (rows.some((row) => (Number(row.stat.mode ?? 0) & 0o077) !== 0)) {
    throw privateError("EXPLORATION_VISION_PRIVATE_ACL_INVALID", "private provider tree is group/world accessible");
  }
  return true;
}

function copyCreateOnly(source, target) {
  if (!isAbsolute(source) || !isAbsolute(target)) {
    throw privateError("EXPLORATION_VISION_PRIVATE_SOURCE_INVALID", "private provider copy paths must be absolute");
  }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw privateError("EXPLORATION_VISION_PRIVATE_SOURCE_INVALID", "private provider source must be an ordinary file");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
}

export function verifyPrivateProviderClosure({
  inputs,
  providerBundleDigest,
  targetRoot,
  verifyAcl = verifyPrivateProviderTree,
} = {}) {
  const expectedRoot = resolve(targetRoot);
  for (const path of [inputs.manifestPath, inputs.python, inputs.script, inputs.model, ...inputs.dataFiles.map((row) => row.path)]) {
    const relative = resolve(path).slice(expectedRoot.length);
    if (!relative.startsWith("\\") && !relative.startsWith("/")) {
      throw privateError("EXPLORATION_VISION_PRIVATE_PATH_INVALID", "provider execution path escaped its content-addressed root");
    }
  }
  const closure = verifyExplorationVisionProviderBundle({
    manifestPath: inputs.manifestPath,
    python: inputs.python,
    script: inputs.script,
    model: inputs.model,
    dataFiles: inputs.dataFiles.map((row) => ({ logicalPath: row.logicalPath, path: row.path })),
  });
  if (closure.providerBundleDigest !== providerBundleDigest) {
    throw privateError("EXPLORATION_VISION_PRIVATE_CLOSURE_DRIFT", "private provider bundle digest drifted");
  }
  verifyPythonRuntimeClosure({ python: inputs.python, dataFiles: inputs.dataFiles });
  verifyAcl(targetRoot);
  return Object.freeze({ ...inputs, closure, targetRoot: expectedRoot });
}

export function verifyResolvedPrivateProviderConfig(config, {
  providerRoot = EXPLORATION_VISION_PRIVATE_PROVIDER_ROOT,
  verifyAcl = verifyPrivateProviderTree,
} = {}) {
  const digest = String(config?.provider?.providerBundleDigest ?? config?.bundle?.providerBundleDigest ?? "");
  const targetRoot = privateProviderRootForDigest(digest, { providerRoot });
  const manifestPath = join(targetRoot, "provider-bundle.v1.json");
  const sealed = readExplorationVisionProviderBundle(manifestPath);
  const expected = privateProviderInputs({ targetRoot, manifest: sealed.manifest });
  const actualData = (config?.pin?.data ?? []).map((row) => ({
    logicalPath: row.logicalPath,
    path: resolve(row.path),
  }));
  const expectedData = expected.dataFiles.map((row) => ({
    logicalPath: row.logicalPath,
    path: resolve(row.path),
  }));
  if (resolve(config?.bundle?.manifest?.path ?? "") !== resolve(expected.manifestPath)
    || resolve(config?.pin?.python?.path ?? "") !== resolve(expected.python)
    || resolve(config?.pin?.script?.path ?? "") !== resolve(expected.script)
    || resolve(config?.pin?.model?.path ?? "") !== resolve(expected.model)
    || JSON.stringify(actualData) !== JSON.stringify(expectedData)) {
    throw privateError("EXPLORATION_VISION_PRIVATE_PATH_DRIFT", "resolved provider config does not use the fixed private content-addressed closure");
  }
  return verifyPrivateProviderClosure({
    inputs: expected,
    providerBundleDigest: digest,
    targetRoot,
    verifyAcl,
  });
}

export function provisionPrivateProviderClosure({
  source,
  providerBundleDigest,
  targetRoot = privateProviderRootForDigest(providerBundleDigest),
  protectedAnchor = EXPLORATION_VISION_PRIVATE_ANCHOR,
  hardenTree = hardenPrivateProviderTree,
  verifyAcl = verifyPrivateProviderTree,
} = {}) {
  const sealed = readExplorationVisionProviderBundle(source.manifestPath);
  if (sealed.providerBundleDigest !== providerBundleDigest || existsSync(targetRoot)) {
    throw privateError("EXPLORATION_VISION_PRIVATE_CREATE_ONLY", "private provider target exists or source digest differs");
  }
  mkdirSync(protectedAnchor, { recursive: true, mode: 0o700 });
  hardenTree(protectedAnchor);
  const providerRoot = dirname(targetRoot);
  mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  hardenTree(providerRoot);
  const stagingRoot = mkdtempSync(join(providerRoot, `.stage-${providerBundleDigest}-`));
  try {
    const mapped = privateProviderInputs({ targetRoot: stagingRoot, source, manifest: sealed.manifest });
    copyCreateOnly(source.manifestPath, mapped.manifestPath);
    copyCreateOnly(source.python, mapped.python);
    copyCreateOnly(source.script, mapped.script);
    copyCreateOnly(source.model, mapped.model);
    for (const row of mapped.dataFiles) copyCreateOnly(row.sourcePath, row.path);
    hardenTree(stagingRoot);
    verifyPrivateProviderClosure({
      inputs: mapped,
      providerBundleDigest,
      targetRoot: stagingRoot,
      verifyAcl,
    });
    renameSync(stagingRoot, targetRoot);
    const finalInputs = privateProviderInputs({ targetRoot, manifest: sealed.manifest });
    return verifyPrivateProviderClosure({
      inputs: finalInputs,
      providerBundleDigest,
      targetRoot,
      verifyAcl,
    });
  } catch (error) {
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}
