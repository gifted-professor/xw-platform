import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";
import { canonicalJson as domainCanonicalJson } from "../control-plane/lib/canonical.mjs";
import {
  acquireM6C1StoppedRuntimeGuard,
  M6_C1_RUNTIME_OWNER_LOCK_FILE,
  m6C1RuntimeOwnerLockPath,
} from "../control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import { loadM6Gate } from "../control-plane/lib/m6-gate-loader.mjs";
import { assertM6FileDbPointerConsistency } from "../control-plane/lib/m6-gate-promoter.mjs";
import { evaluateM6Gate } from "../control-plane/lib/m6-live-gate.mjs";
import {
  FORMAL_RELEASE_MANIFEST_SCHEMA_ID,
  FORMAL_RUNTIME_ROOT,
} from "./formal-release-builder.mjs";
import {
  FORMAL_CONTROL_PLANE_TASK_NAME,
  TRUSTED_NODE_EXECUTABLE,
} from "./gate-f-launcher-identity.mjs";
import {
  createNativeGateFCutoverAdapter,
  GATE_F_CUTOVER_OPERATOR_RELEASE_PATH,
  inspectTrustedNode,
  parseLegacyTaskDefinition,
  prepareGateFCutoverTargetFromFixedCandidate,
  replaceCurrentJunction,
  replaceFileWithBackup,
  stageGateFTargetCandidateFromFixedAssembler,
  verifyGateFCutoverTuple,
} from "./gate-f-cutover-operator.mjs";

export const M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH =
  "services/control-plane/ops/m6-qualification-legacy-window-operator.mjs";
export const M6_QUALIFICATION_LEGACY_WINDOW_PRESTATE_SCHEMA_ID =
  "xw.runtime.m6-qualification-legacy-window-prestate.v2";
export const M6_QUALIFICATION_LEGACY_WINDOW_REFERENCE_SCHEMA_ID =
  "xw.runtime.m6-qualification-legacy-window-reference.v2";
export const M6_QUALIFICATION_LEGACY_WINDOW_RECEIPT_SCHEMA_ID =
  "xw.runtime.m6-qualification-legacy-window-receipt.v2";
export const M6_QUALIFICATION_FINAL_RELAY_SCHEMA_ID =
  "xw.runtime.m6-qualification-final-relay.v1";
export const M6_QUALIFICATION_FINAL_RELAY_AUTHORIZATION_SCHEMA_ID =
  "xw.runtime.m6-qualification-final-relay-authorization.v1";
export const M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID =
  "xw.runtime.m6-qualification-final-relay-receipt.v1";
export const M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME =
  "qualification-legacy-windows";
export const M6_QUALIFICATION_CONTROL_HEALTH_URL =
  "http://127.0.0.1:17920/control/v1/health";
export const M6_QUALIFICATION_REGISTRY_HEALTH_URL =
  "http://127.0.0.1:17930/api/health";

const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const FIXED_PORTS = Object.freeze([17920, 17930]);
const CONTROL_MODULE_RELEASE_PATH = "services/control-plane/control-plane/server.mjs";
const REGISTRY_MODULE_RELEASE_PATH = "services/orchestrator/registry.mjs";
const STATE_STORE_RELEASE_PATH = "services/control-plane/control-plane/lib/state-store.mjs";
const QUALIFICATION_TASK_NAME = "XW Platform M6 Qualification";
const FINAL_TASK_NAMES = Object.freeze([
  FORMAL_CONTROL_PLANE_TASK_NAME,
  "XW Platform Orchestrator",
  "XW Platform FastOperator 03",
  "XW Platform FastOperator 04",
]);
const FINAL_RUNTIME_SLOT_PATHS = Object.freeze([
  Object.freeze(["config", "m6-c1-runtime.v1.json"]),
  Object.freeze(["state", "control-plane", "fast-operator", "serve-launch-03.json"]),
  Object.freeze(["state", "control-plane", "fast-operator", "serve-launch-04.json"]),
]);
const QUALIFICATION_BINDING_SCHEMA_ID = "xw.runtime.m6-c1-qualification-bootstrap.v1";
const QUALIFICATION_BOOTSTRAP_RECEIPT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-operator-receipt.v1";
const QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID =
  "xw.m6-c1-qualification-bootstrap-rotation-receipt.v1";
const QUALIFICATION_INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);
const WINDOWS_POWERSHELL_EXECUTABLE = join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const WINDOWS_TASKKILL_EXECUTABLE = join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "taskkill.exe",
);
const REGISTRY_DATABASE_FILENAME = ["registry", "db"].join(".");
const LEGACY_CONTROL_LAUNCHER_FILENAME = "launch-control-plane.simple.ps1";
const LEGACY_REGISTRY_LAUNCHER_FILENAME = "launch-orchestrator.current-user.ps1";
const LEGACY_LAUNCHER_TARGETS = Object.freeze([
  Object.freeze({ key: "controlPlane", filename: LEGACY_CONTROL_LAUNCHER_FILENAME, port: 17920 }),
  Object.freeze({ key: "registry", filename: LEGACY_REGISTRY_LAUNCHER_FILENAME, port: 17930 }),
]);
const DB_TARGETS = Object.freeze([
  Object.freeze({ key: "controlDb", path: ["state", "control-plane", "control.db"] }),
  Object.freeze({ key: "registryDb", path: ["state", "orchestrator", REGISTRY_DATABASE_FILENAME] }),
]);
const PRIVATE_TARGETS = Object.freeze([
  Object.freeze({ key: "secretEnvironment", path: ["secrets", "control-plane-secret-environment.v1.json"] }),
  Object.freeze({ key: "digestKeyring", path: ["secrets", "xhs-evidence-digest-keyring.v1.json"] }),
]);
const QUALIFICATION_BINDING_TARGET = Object.freeze({
  key: "qualificationBinding",
  path: ["config", "m6-c1-qualification-bootstrap.v1.json"],
});
const TASK_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$name = [string]$env:XW_LEGACY_TASK_NAME
$service = New-Object -ComObject "Schedule.Service"
$service.Connect()
$folder = $service.GetFolder("\")
try {
    $task = $folder.GetTask($name)
} catch {
    if ($_.Exception.HResult -eq -2147024894) {
        [ordered]@{ exists = $false; state = "ABSENT"; xml = $null } | ConvertTo-Json -Compress
        exit 0
    }
    exit 23
}
$states = @("UNKNOWN", "DISABLED", "QUEUED", "READY", "RUNNING")
$index = [int]$task.State
$state = if ($index -ge 0 -and $index -lt $states.Count) { $states[$index] } else { "UNKNOWN" }
[ordered]@{ exists = $true; state = $state; xml = [string]$task.Xml } | ConvertTo-Json -Compress
`;
const LISTENER_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XwNativeCommandLine {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr value);
    public static string[] Parse(string commandLine) {
        int argc;
        IntPtr argv = CommandLineToArgvW(commandLine, out argc);
        if (argv == IntPtr.Zero || argc < 1) throw new InvalidOperationException("argv parse failed");
        try {
            string[] values = new string[argc];
            for (int index = 0; index < argc; index++) {
                values[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size));
            }
            return values;
        } finally { LocalFree(argv); }
    }
}
'@
function Same-Path([string]$Left, [string]$Right) {
    try { return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}
function Same-Text([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::Ordinal)
}
function Is-Opaque-Argument([string]$Value) {
    return $null -ne $Value -and $Value.Length -ge 1 -and $Value.Length -le 8192 -and
        -not $Value.StartsWith("--", [StringComparison]::Ordinal) -and
        -not [Regex]::IsMatch($Value, '[\x00-\x1f\x7f]')
}
function Has-Exact-Node-Command(
    [string]$CommandLine,
    [string]$Node,
    [string]$Module,
    [string]$ModuleAlias,
    [int]$Port,
    [string]$RuntimeRoot
) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    try { [string[]]$argv = [XwNativeCommandLine]::Parse($CommandLine) } catch { return $false }
    if ($argv.Count -lt 2 -or -not (Same-Path $argv[0] $Node) -or
        (-not (Same-Path $argv[1] $Module) -and -not (Same-Path $argv[1] $ModuleAlias))) { return $false }
    if ($Port -eq 17920) {
        return $argv.Count -eq 3 -and (Same-Text $argv[2] "serve")
    }
    if ($Port -ne 17930 -or $argv.Count -ne 22) { return $false }
    # Assembled without a literal registry database filename (fusion authority scan).
    $registryDb = [IO.Path]::Combine($RuntimeRoot, "state", "orchestrator", ("registry" + ".db"))
    $controlDb = [IO.Path]::Combine($RuntimeRoot, "state", "control-plane", "control.db")
    $runsRoot = [IO.Path]::Combine($RuntimeRoot, "evidence")
    return (Same-Text $argv[2] "--port") -and (Same-Text $argv[3] "17930") -and
        (Same-Text $argv[4] "--host") -and (Same-Text $argv[5] "0.0.0.0") -and
        (Same-Text $argv[6] "--control") -and (Same-Text $argv[7] "http://127.0.0.1:17920") -and
        (Same-Text $argv[8] "--db") -and (Same-Path $argv[9] $registryDb) -and
        (Same-Text $argv[10] "--control-db") -and (Same-Path $argv[11] $controlDb) -and
        (Same-Text $argv[12] "--runs-root") -and (Same-Path $argv[13] $runsRoot) -and
        (Same-Text $argv[14] "--agent-token") -and (Is-Opaque-Argument $argv[15]) -and
        (Same-Text $argv[16] "--human-token") -and (Is-Opaque-Argument $argv[17]) -and
        (Same-Text $argv[18] "--human-actor") -and (Is-Opaque-Argument $argv[19]) -and
        (Same-Text $argv[20] "--observer-token") -and (Is-Opaque-Argument $argv[21])
}
function Has-Exact-Launcher-Command([string]$CommandLine, [string]$PowerShell, [string]$Launcher) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $powerShellEscaped = [Regex]::Escape($PowerShell)
    $launcherEscaped = [Regex]::Escape($Launcher)
    $pattern = '^\s*(?:"{0}"|{0})\s+-NoLogo\s+-NoProfile\s+-NonInteractive\s+-ExecutionPolicy\s+Bypass\s+-File\s+(?:"{1}"|{1})\s*$' -f $powerShellEscaped, $launcherEscaped
    return [Regex]::IsMatch($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Sha256-Text([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}
$ports = @(17920, 17930)
$expected = @{ 17920 = [string]$env:XW_LEGACY_CP_MODULE; 17930 = [string]$env:XW_LEGACY_REGISTRY_MODULE }
$aliases = @{ 17920 = [string]$env:XW_LEGACY_CP_MODULE_ALIAS; 17930 = [string]$env:XW_LEGACY_REGISTRY_MODULE_ALIAS }
$launchers = @{ 17920 = [string]$env:XW_LEGACY_CP_LAUNCHER; 17930 = [string]$env:XW_LEGACY_REGISTRY_LAUNCHER }
$node = [string]$env:XW_LEGACY_TRUSTED_NODE
$powershell = [string]$env:XW_LEGACY_POWERSHELL
$runtimeRoot = [string]$env:XW_LEGACY_RUNTIME_ROOT
$callerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$callerSidHash = Sha256-Text ([string]$callerIdentity.User.Value)
$callerSession = [int64][Diagnostics.Process]::GetCurrentProcess().SessionId
$rows = @(
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $ports -contains [int]$_.LocalPort } |
        Sort-Object LocalPort, OwningProcess, LocalAddress |
        Group-Object LocalPort, OwningProcess |
        ForEach-Object {
            $first = $_.Group[0]
            $port = [int]$first.LocalPort
            $pidValue = [int64]$first.OwningProcess
            $proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $pidValue) -ErrorAction Stop
            $parent = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f ([int64]$proc.ParentProcessId)) -ErrorAction SilentlyContinue
            $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction SilentlyContinue
            $parentOwner = if ($null -ne $parent) { Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -ErrorAction SilentlyContinue } else { $null }
            $module = [string]$expected[$port]
            $moduleAlias = [string]$aliases[$port]
            $launcher = [string]$launchers[$port]
            $childShape = $null -ne $owner -and
                (Same-Path ([string]$proc.ExecutablePath) $node) -and
                (Has-Exact-Node-Command ([string]$proc.CommandLine) $node $module $moduleAlias $port $runtimeRoot)
            $parentShape = $null -ne $parent -and $null -ne $parentOwner -and
                (Same-Path ([string]$parent.ExecutablePath) $powershell) -and
                (Has-Exact-Launcher-Command ([string]$parent.CommandLine) $powershell $launcher)
            [ordered]@{
                port = $port
                pid = $pidValue
                parentPid = [int64]$proc.ParentProcessId
                createdAt = [string]$proc.CreationDate
                executablePath = if ($childShape) { [string]$proc.ExecutablePath } else { $null }
                modulePath = if ($childShape) { $module } else { $null }
                localAddresses = [object[]]@($_.Group | ForEach-Object { [string]$_.LocalAddress } | Sort-Object -Unique)
                sessionId = if ($childShape) { [int64]$proc.SessionId } else { -1 }
                sidSha256 = if ($childShape) { Sha256-Text ([string]$owner.Sid) } else { $null }
                parentCreatedAt = if ($parentShape) { [string]$parent.CreationDate } else { $null }
                parentExecutablePath = if ($parentShape) { [string]$parent.ExecutablePath } else { $null }
                parentSessionId = if ($parentShape) { [int64]$parent.SessionId } else { -1 }
                parentSidSha256 = if ($parentShape) { Sha256-Text ([string]$parentOwner.Sid) } else { $null }
                launcherPath = if ($parentShape) { $launcher } else { $null }
            }
        }
)
[ordered]@{
    scope = "ALL_INTERFACES"
    ports = $ports
    caller = [ordered]@{ sidSha256 = $callerSidHash; sessionId = $callerSession }
    listeners = $rows
} | ConvertTo-Json -Depth 4 -Compress
`;
const TERMINATE_VERIFIED_PROCESS_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
function Same-Path([string]$Left, [string]$Right) {
    try { return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}
function Has-Exact-Token([string]$CommandLine, [string]$Expected) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $escaped = [Regex]::Escape($Expected)
    return [Regex]::IsMatch($CommandLine, '(?i)(?:^|[\s"]){0}(?=$|[\s"])' -f $escaped)
}
$pidValue = [int64]$env:XW_LEGACY_PID
$expectedCreatedAt = [string]$env:XW_LEGACY_CREATED_AT
$expectedModule = [string]$env:XW_LEGACY_MODULE
$expectedModuleAlias = [string]$env:XW_LEGACY_MODULE_ALIAS
$expectedNode = [string]$env:XW_LEGACY_TRUSTED_NODE
$proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $pidValue) -ErrorAction SilentlyContinue
if ($null -eq $proc) {
    [ordered]@{ status = "already-exited" } | ConvertTo-Json -Compress
    exit 0
}
if ([string]$proc.CreationDate -cne $expectedCreatedAt -or -not (Same-Path ([string]$proc.ExecutablePath) $expectedNode) -or (-not (Has-Exact-Token ([string]$proc.CommandLine) $expectedModule) -and -not (Has-Exact-Token ([string]$proc.CommandLine) $expectedModuleAlias))) {
    exit 41
}
& $env:XW_LEGACY_TASKKILL /PID ([string]$pidValue) /T /F *> $null
if ($LASTEXITCODE -ne 0) { exit 42 }
[ordered]@{ status = "terminated" } | ConvertTo-Json -Compress
`;
const CALLER_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$identity.User.Value)
    $hash = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    [ordered]@{
        sidSha256 = $hash
        sessionId = [int64][Diagnostics.Process]::GetCurrentProcess().SessionId
    } | ConvertTo-Json -Compress
} finally { $algorithm.Dispose() }
`;

function fail(code, message, details = undefined) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, ...(details ? { details } : {}) });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function pathKey(value) {
  const full = resolve(value);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string"
    && pathKey(left) === pathKey(right);
}

function within(root, candidate, { allowRoot = false } = {}) {
  const value = relative(resolve(root), resolve(candidate));
  if (value === "") return allowRoot;
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function absolutePath(value, code, label) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    fail(code, `${label} must be one absolute path`);
  }
  return resolve(value);
}

function assertPlainDirectory(path, code, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is absent or unreadable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${label} must be one plain directory`);
  }
}

function assertPlainFile(path, code, label, maximumBytes = 1024 * 1024 * 1024) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is absent or unreadable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) {
    fail(code, `${label} must be one bounded single-link file`);
  }
  return stat;
}

function readPlainBytes(path, code, label, maximumBytes) {
  assertPlainFile(path, code, label, maximumBytes);
  return readFileSync(path);
}

function parseJsonBytes(bytes, code, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(code, `${label} is not valid UTF-8 JSON`); }
}

function readCanonicalJson(path, code, label, maximumBytes = 64 * 1024 * 1024) {
  const bytes = readPlainBytes(path, code, label, maximumBytes);
  const value = parseJsonBytes(bytes, code, label);
  if (!bytes.equals(canonicalJsonBytes(value))) fail(code, `${label} is not canonical JSON`);
  return Object.freeze({ bytes, value });
}

function inspectLegacyRuntimeOwnerLock({ runtimeRoot, expectedPid = null, allowAbsent = false }) {
  const code = "M6_QUALIFICATION_LEGACY_OWNER_LOCK_INVALID";
  if (expectedPid !== null && (!Number.isSafeInteger(expectedPid) || expectedPid < 4)) {
    fail(code, "legacy control-plane PID is invalid");
  }
  let path;
  try { path = m6C1RuntimeOwnerLockPath(runtimeRoot); }
  catch { fail(code, "fixed runtime owner-lock path is invalid"); }
  if (basename(path) !== M6_C1_RUNTIME_OWNER_LOCK_FILE) {
    fail(code, "fixed runtime owner-lock filename drifted");
  }
  if (!existsSync(path) && allowAbsent) return null;
  const { bytes, value } = readCanonicalJson(path, code, "legacy runtime owner lock", 64 * 1024);
  if (!exactObject(value, [
    "acquiredAt", "ownerKind", "ownerNonce", "pid", "schemaId", "secretMaterialPresent",
  ]) || value.schemaId !== "xw.m6-c1-runtime-owner-lock.v1"
    || value.ownerKind !== "CONTROL_PLANE_M6_C1"
    || !Number.isSafeInteger(value.pid) || value.pid < 4
    || (expectedPid !== null && value.pid !== expectedPid)
    || typeof value.ownerNonce !== "string"
    || !/^[A-Za-z0-9._:-]{16,200}$/u.test(value.ownerNonce)
    || typeof value.acquiredAt !== "string"
    || !Number.isFinite(Date.parse(value.acquiredAt))
    || value.secretMaterialPresent !== false) {
    fail(code, "legacy runtime owner lock does not match the active control-plane listener");
  }
  return Object.freeze({ path, pid: value.pid, sha256: sha256(bytes) });
}

function inspectLegacyLaunchers({ runtimeRoot }) {
  const code = "M6_QUALIFICATION_LEGACY_LAUNCHER_INVALID";
  return Object.freeze(Object.fromEntries(LEGACY_LAUNCHER_TARGETS.map((target) => {
    const path = join(runtimeRoot, target.filename);
    const bytes = readPlainBytes(path, code, `${target.key} legacy launcher`, 1024 * 1024);
    return [target.key, Object.freeze({ key: target.key, path, sha256: sha256(bytes) })];
  })));
}

function manifestEntry(manifest, releasePath, code) {
  const matches = Array.isArray(manifest?.files)
    ? manifest.files.filter((entry) => entry?.path === releasePath) : [];
  if (matches.length !== 1 || !HEX64.test(matches[0]?.sha256 || "")) {
    fail(code, `release manifest does not uniquely pin ${releasePath}`);
  }
  return matches[0];
}

function inspectManifestFile({ manifest, releaseRoot, releasePath, code, label }) {
  const path = join(releaseRoot, ...releasePath.split("/"));
  const bytes = readPlainBytes(path, code, label, 256 * 1024 * 1024);
  const entry = manifestEntry(manifest, releasePath, code);
  if (sha256(bytes) !== entry.sha256) fail(code, `${label} differs from the release manifest`);
  return Object.freeze({ path, sha256: entry.sha256 });
}

function verifyTcb(tcbAclController, runtimeRoot, targetPath, recursive, code) {
  if (typeof tcbAclController?.verify !== "function") fail(code, "SYSTEM TCB verification is unavailable");
  try {
    tcbAclController.verify(buildSystemTcbAclPlan({
      boundaryPath: runtimeRoot,
      targetPath,
      recursive,
    }));
  } catch { fail(code, "SYSTEM TCB verification failed closed"); }
}

function protectTcb(tcbAclController, runtimeRoot, targetPath, recursive, code) {
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail(code, "SYSTEM TCB protect/verify controller is unavailable");
  }
  const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath, recursive });
  try { tcbAclController.protect(plan); tcbAclController.verify(plan); }
  catch { fail(code, "SYSTEM TCB protection failed closed"); }
}

function inspectRelease({
  runtimeRoot,
  releaseRoot,
  expectedReleaseId = null,
  expectedSourceCommit = null,
  releaseVerifier,
  tcbAclController,
  code,
}) {
  assertPlainDirectory(releaseRoot, code, "release root");
  if (!within(join(runtimeRoot, "releases"), releaseRoot)) fail(code, "release escaped the fixed releases root");
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const read = readCanonicalJson(manifestPath, code, "release manifest");
  const manifest = read.value;
  if (manifest?.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || !RELEASE_ID.test(manifest.releaseId || "") || !HEX40.test(manifest.sourceCommit || "")
    || manifest.releaseId !== basename(releaseRoot)
    || (expectedReleaseId !== null && manifest.releaseId !== expectedReleaseId)
    || (expectedSourceCommit !== null && manifest.sourceCommit !== expectedSourceCommit)
    || typeof manifest.nodeVersion !== "string" || manifest.nodeVersion === "") {
    fail(code, "release manifest identity is invalid");
  }
  let verified;
  try { verified = releaseVerifier({ manifestPath, root: releaseRoot }); }
  catch { fail(code, "release verification failed closed"); }
  if (verified?.ok !== true) fail(code, "release manifest/tree verification failed");
  verifyTcb(tcbAclController, runtimeRoot, releaseRoot, true, code);
  return Object.freeze({
    root: releaseRoot,
    manifestPath,
    manifestSha256: sha256(read.bytes),
    manifest,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
  });
}

function inspectCurrentRelease({ runtimeRoot, releaseVerifier, tcbAclController }) {
  const code = "M6_QUALIFICATION_LEGACY_CURRENT_INVALID";
  const currentPath = join(runtimeRoot, "current");
  let stat;
  try { stat = lstatSync(currentPath); }
  catch { fail(code, "current junction is absent"); }
  if (!stat.isSymbolicLink()) fail(code, "current must be one release junction");
  const releaseRoot = realpathSync(currentPath);
  const release = inspectRelease({
    runtimeRoot,
    releaseRoot,
    releaseVerifier,
    tcbAclController,
    code,
  });
  return Object.freeze({ ...release, currentPath });
}

function inspectTargetRelease({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  executingOperatorPath,
  releaseVerifier,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_LEGACY_TARGET_INVALID";
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")) {
    fail(code, "new formal release identity is invalid");
  }
  const root = join(runtimeRoot, "releases", expectedReleaseId);
  const release = inspectRelease({
    runtimeRoot,
    releaseRoot: root,
    expectedReleaseId,
    expectedSourceCommit,
    releaseVerifier,
    tcbAclController,
    code,
  });
  const operator = inspectManifestFile({
    manifest: release.manifest,
    releaseRoot: root,
    releasePath: M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH,
    code,
    label: "qualification legacy-window operator",
  });
  if (!samePath(executingOperatorPath, operator.path)) {
    fail(code, "operator must execute from the exact new formal release path");
  }
  return Object.freeze({ ...release, operator });
}

function containsPathToken(text, path) {
  if (typeof text !== "string") return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[\\s\"])(?:${escaped})(?=$|[\\s\"])`, "iu").test(text);
}

function validateLegacyTaskInspection(inspection, { runtimeRoot, legacyRelease, targetRelease, modules }) {
  const code = "M6_QUALIFICATION_LEGACY_TASK_INVALID";
  if (!exactObject(inspection, ["exists", "state", "xml"])
    || inspection.exists !== true || !["READY", "RUNNING"].includes(inspection.state)
    || typeof inspection.xml !== "string" || inspection.xml.length > 256 * 1024) {
    fail(code, "fixed legacy task must exist and be READY or RUNNING");
  }
  let definition;
  try { definition = parseLegacyTaskDefinition(inspection.xml); }
  catch { fail(code, "fixed legacy task XML is invalid"); }
  if (definition.principal !== "SYSTEM" || definition.enabled !== true
    || /[\0\r\n]/u.test(definition.action.command)
    || /[\0\r\n]/u.test(definition.action.arguments)
    || /[\0\r\n]/u.test(definition.action.workingDirectory)
    || !within(runtimeRoot, definition.action.workingDirectory, { allowRoot: true })) {
    fail(code, "fixed legacy task principal/action escaped the runtime boundary");
  }
  const commandIsNode = samePath(definition.action.command, TRUSTED_NODE_EXECUTABLE);
  const commandIsPowerShell = samePath(
    definition.action.command.replace(/^%SystemRoot%/iu, process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"),
    WINDOWS_POWERSHELL_EXECUTABLE,
  );
  if ((!commandIsNode && !commandIsPowerShell)
    || (commandIsNode && ![
      modules.controlPlane.path,
      join(legacyRelease.currentPath, ...CONTROL_MODULE_RELEASE_PATH.split("/")),
    ].some((path) => containsPathToken(definition.action.arguments, path)))
    || (commandIsPowerShell
      && ![runtimeRoot, legacyRelease.currentPath, legacyRelease.root]
        .some((path) => definition.action.arguments.toLowerCase().includes(path.toLowerCase())))
    || definition.action.arguments.toLowerCase().includes(targetRelease.root.toLowerCase())) {
    fail(code, "fixed legacy task action is not bound to current legacy authority");
  }
  return Object.freeze({
    name: FORMAL_CONTROL_PLANE_TASK_NAME,
    state: inspection.state,
    xml: inspection.xml,
    xmlSha256: sha256(Buffer.from(inspection.xml, "utf8")),
  });
}

export function normalizeM6QualificationLegacyListeners(value, {
  modules,
  trustedNode,
  requireActive = true,
  allowPartial = false,
  launchers = null,
  caller = null,
} = {}) {
  const code = "M6_QUALIFICATION_LEGACY_LISTENER_INVALID";
  const topologyRequired = launchers !== null || caller !== null;
  if (!exactObject(value, topologyRequired
    ? ["caller", "listeners", "ports", "scope"]
    : (Object.hasOwn(value || {}, "caller")
      ? ["caller", "listeners", "ports", "scope"]
      : ["listeners", "ports", "scope"]))
    || value.scope !== "ALL_INTERFACES"
    || JSON.stringify(value.ports) !== JSON.stringify(FIXED_PORTS)
    || !Array.isArray(value.listeners)) {
    fail(code, "listener oracle receipt is malformed");
  }
  let normalizedCaller = null;
  if (topologyRequired) {
    if (!exactObject(launchers, ["controlPlane", "registry"])
      || !exactObject(caller, ["sessionId", "sidSha256"])
      || !Number.isSafeInteger(caller.sessionId) || caller.sessionId < 0
      || !HEX64.test(caller.sidSha256 || "")
      || !exactObject(value.caller, ["sessionId", "sidSha256"])
      || value.caller.sessionId !== caller.sessionId
      || value.caller.sidSha256 !== caller.sidSha256) {
      fail(code, "listener caller identity differs from the sealed current-user authority");
    }
    normalizedCaller = caller;
    for (const target of LEGACY_LAUNCHER_TARGETS) {
      const ref = launchers[target.key];
      if (!exactObject(ref, ["key", "path", "sha256"])
        || ref.key !== target.key || !samePath(ref.path, join(dirname(ref.path), target.filename))
        || basename(ref.path).toLowerCase() !== target.filename.toLowerCase()
        || !HEX64.test(ref.sha256 || "")) {
        fail(code, "sealed legacy launcher identity is malformed");
      }
    }
  }
  const rows = value.listeners.map((row) => {
    const baseKeys = [
      "createdAt", "executablePath", "localAddresses", "modulePath", "parentPid", "pid", "port",
    ];
    const topologyKeys = [
      ...baseKeys, "launcherPath", "parentCreatedAt", "parentExecutablePath",
      "parentSessionId", "parentSidSha256", "sessionId", "sidSha256",
    ];
    if (!exactObject(row, topologyRequired ? topologyKeys : (
      Object.hasOwn(row || {}, "launcherPath") ? topologyKeys : baseKeys
    ))
      || !FIXED_PORTS.includes(row.port)
      || !Number.isSafeInteger(row.pid) || row.pid < 4
      || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
      || typeof row.createdAt !== "string" || row.createdAt === ""
      || !Array.isArray(row.localAddresses) || row.localAddresses.length === 0
      || row.localAddresses.length > 8
      || row.localAddresses.some((address) => typeof address !== "string" || isIP(address) === 0)
      || JSON.stringify(row.localAddresses) !== JSON.stringify([...new Set(row.localAddresses)].sort())
      || !samePath(row.executablePath, trustedNode.path)) {
      fail(code, "listener process identity is malformed or uses an untrusted executable");
    }
    const expected = row.port === 17920 ? modules.controlPlane : modules.registry;
    if (!samePath(row.modulePath, expected.path)) {
      fail(code, "listener command line did not bind the exact release module");
    }
    const normalized = {
      port: row.port,
      pid: row.pid,
      parentPid: row.parentPid,
      createdAt: row.createdAt,
      executablePath: resolve(row.executablePath),
      modulePath: expected.path,
      moduleSha256: expected.sha256,
      localAddresses: Object.freeze([...row.localAddresses]),
    };
    if (topologyRequired) {
      const launcherKey = row.port === 17920 ? "controlPlane" : "registry";
      const launcher = launchers[launcherKey];
      if (typeof row.parentCreatedAt !== "string" || row.parentCreatedAt === ""
        || !samePath(row.parentExecutablePath, WINDOWS_POWERSHELL_EXECUTABLE)
        || !Number.isSafeInteger(row.parentSessionId) || row.parentSessionId !== normalizedCaller.sessionId
        || row.parentSidSha256 !== normalizedCaller.sidSha256
        || !Number.isSafeInteger(row.sessionId) || row.sessionId !== normalizedCaller.sessionId
        || row.sidSha256 !== normalizedCaller.sidSha256
        || !samePath(row.launcherPath, launcher.path)) {
        fail(code, "listener parent does not reproduce the sealed current-user launcher topology");
      }
      Object.assign(normalized, {
        parentCreatedAt: row.parentCreatedAt,
        parentExecutablePath: resolve(row.parentExecutablePath),
        parentSessionId: row.parentSessionId,
        parentSidSha256: row.parentSidSha256,
        sessionId: row.sessionId,
        sidSha256: row.sidSha256,
        launcherKey,
        launcherPath: launcher.path,
        launcherSha256: launcher.sha256,
      });
    }
    return Object.freeze(normalized);
  }).sort((left, right) => left.port - right.port);
  if (new Set(rows.map((row) => row.port)).size !== rows.length
    || new Set(rows.map((row) => row.pid)).size !== rows.length) {
    fail(code, "listener oracle returned duplicate port or process ownership");
  }
  if (requireActive) {
    if (rows.length !== 2 || rows[0].port !== 17920 || rows[1].port !== 17930
      || rows[0].pid === rows[1].pid
      || (topologyRequired && rows[0].parentPid === rows[1].parentPid)) {
      fail(code, "17920 and 17930 must each have one distinct exact legacy listener");
    }
  } else if (!allowPartial && rows.length !== 0) {
    fail(code, "qualification legacy window requires both fixed ports to be empty");
  }
  return Object.freeze(rows);
}

function assertHealthIdentity(value, release, code) {
  const control = value?.controlPlane;
  const registry = value?.registry;
  if (control?.ok !== true || registry?.ok !== true
    || control.releaseId !== release.releaseId || control.sourceCommit !== release.sourceCommit
    || registry.releaseId !== release.releaseId || registry.sourceCommit !== release.sourceCommit) {
    fail(code, "control-plane/registry health did not reproduce the exact legacy identity");
  }
  return Object.freeze({
    controlPlane: Object.freeze({
      releaseId: control.releaseId,
      sourceCommit: control.sourceCommit,
    }),
    registry: Object.freeze({
      releaseId: registry.releaseId,
      sourceCommit: registry.sourceCommit,
    }),
  });
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
}

function tableCount(db, tables, table, where = "") {
  if (!tables.has(table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"${where}`).get().count);
}

function qualificationFenceIdentity(value) {
  return Object.freeze({
    gateId: value.gateId,
    epochHash: value.epochHash,
    generation: value.generation,
    mode: value.mode,
    purpose: value.purpose,
    allowlist: value.allowlist,
    expiresAt: value.expiresAt,
    releaseId: value.releaseId,
    sourceCommit: value.sourceCommit,
    locksHash: value.locksHash,
  });
}

function qualificationFenceHash(value) {
  return sha256(`xw.m6-c1-qualification-fence.v1:${domainCanonicalJson(
    qualificationFenceIdentity(value),
  )}`);
}

function readQualificationFence(db, tables, code) {
  if (!tables.has("m6_gate_fence")) fail(code, "control database has no M6 fence table");
  const rows = db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").all();
  if (rows.length !== 1) fail(code, "control database must contain exactly one M6 fence");
  const row = rows[0];
  let allowlist;
  try { allowlist = JSON.parse(row.allowlist_json); }
  catch { fail(code, "M6 fence allowlist is malformed"); }
  return Object.freeze({
    gateId: row.gate_id,
    epochHash: row.epoch_hash,
    generation: Number(row.generation),
    mode: row.mode,
    purpose: row.purpose,
    allowlist,
    expiresAt: row.expires_at,
    releaseId: row.release_id,
    sourceCommit: row.source_commit,
    locksHash: row.locks_hash,
  });
}

function inspectQualificationDatabase({ path, nowMs, requireStandalone }) {
  const code = "M6_QUALIFICATION_RESUME_DATABASE_INVALID";
  assertPlainFile(path, code, "post-qualification control database", 4 * 1024 * 1024 * 1024);
  if (requireStandalone && ["-wal", "-shm"].some((suffix) => existsSync(`${path}${suffix}`))) {
    fail(code, "stopped post-qualification database still has a WAL/SHM sidecar");
  }
  const beforeSha256 = requireStandalone ? sha256(readFileSync(path)) : null;
  const location = requireStandalone
    ? `${pathToFileURL(path).href}?mode=ro&immutable=1`
    : path;
  const db = new DatabaseSync(location, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON");
    db.exec("BEGIN");
    const quickCheck = Object.values(db.prepare("PRAGMA quick_check").get() || {})[0];
    const integrityCheck = Object.values(db.prepare("PRAGMA integrity_check").get() || {})[0];
    const userVersion = Number(Object.values(db.prepare("PRAGMA user_version").get() || {})[0]);
    const tables = tableNames(db);
    const fence = readQualificationFence(db, tables, code);
    const resources = Object.freeze({
      jobs: tableCount(db, tables, "jobs", " WHERE status IN ('queued','waiting_approval','running','verifying','restoring')"),
      sessions: tableCount(db, tables, "sessions", ` WHERE expires_at>${Number(nowMs)}`),
      leases: tableCount(db, tables, "leases", ` WHERE expires_at>${Number(nowMs)}`),
      actionCount: tableCount(db, tables, "device_session_actions", " WHERE execution_mode='m6-grounded-live-v2'"),
      pendingApprovals:
        tableCount(db, tables, "protected_commits", " WHERE status='waiting_authorization'")
        + tableCount(db, tables, "device_runs", " WHERE phase='waiting_authorization'")
        + tableCount(db, tables, "mission_effects", " WHERE status IN ('pending_authorization','waiting_authorization')"),
    });
    const residueTables = Object.freeze({
      emergencyCloseConsumptions: "m6_emergency_close_consumptions",
      groundingPermits: "m6_grounding_permits",
      actionClaims: "m6_action_claims",
      groundedActionDetails: "m6_grounded_action_details",
      liveWindowAuthorizations: "m6_live_window_authorization_consumptions",
      liveScenarioClaims: "m6_live_scenario_claims",
      safetyCloseArms: "m6_gate_safety_close_arms",
    });
    if (Object.values(residueTables).some((table) => !tables.has(table))) {
      fail(code, "schema-21 control database is missing an M6 residue table");
    }
    const durableResidue = Object.freeze(Object.fromEntries(Object.entries(residueTables)
      .map(([key, table]) => [key, tableCount(db, tables, table)])));
    const fenceAgain = readQualificationFence(db, tables, code);
    db.exec("COMMIT");
    if (quickCheck !== "ok" || integrityCheck !== "ok"
      || userVersion !== 21
      || domainCanonicalJson(fenceAgain) !== domainCanonicalJson(fence)
      || Object.values(resources).some((count) => !Number.isSafeInteger(count) || count !== 0)
      || Object.values(durableResidue).some((count) => !Number.isSafeInteger(count) || count !== 0)) {
      fail(code, "post-qualification database is not intact, stable, supported, and zero-resource");
    }
    if (requireStandalone) {
      const afterSha256 = sha256(readFileSync(path));
      if (afterSha256 !== beforeSha256
        || ["-wal", "-shm"].some((suffix) => existsSync(`${path}${suffix}`))) {
        fail(code, "standalone post-qualification database raced inspection");
      }
    }
    return Object.freeze({
      path,
      sha256: beforeSha256,
      quickCheck,
      integrityCheck,
      userVersion,
      fence,
      resources,
      durableResidue,
    });
  } catch (cause) {
    try { db.exec("ROLLBACK"); } catch {}
    if (cause?.code === code) throw cause;
    fail(code, "post-qualification database inspection failed closed");
  } finally { db.close(); }
}

function validateQualificationBinding({ runtimeRoot, targetRelease }) {
  const code = "M6_QUALIFICATION_RESUME_BINDING_INVALID";
  const path = join(runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json");
  const read = readCanonicalJson(path, code, "qualification binding", 64 * 1024);
  const value = read.value;
  const issuerPath = join(runtimeRoot, "m6-gate", "issuer-keys.json");
  const inventoryPath = join(runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json");
  const ownerKeysPath = join(runtimeRoot, "qualification-bootstrap", "live-window-owner-keys-unavailable.json");
  if (!exactObject(value, [
    "gateFArtifactInventoryHash", "gateFArtifactInventoryPath", "gateId",
    "gateIssuerAllowlistPath", "releaseId", "releaseManifestSha256", "schemaId",
    "sourceCommit", "sourceReleaseRoot",
  ]) || value.schemaId !== QUALIFICATION_BINDING_SCHEMA_ID
    || value.releaseId !== targetRelease.releaseId
    || value.sourceCommit !== targetRelease.sourceCommit
    || !samePath(value.sourceReleaseRoot, targetRelease.root)
    || value.releaseManifestSha256 !== targetRelease.manifestSha256
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.gateId || "")
    || !samePath(value.gateIssuerAllowlistPath, issuerPath)
    || !samePath(value.gateFArtifactInventoryPath, inventoryPath)
    || value.gateFArtifactInventoryHash !== QUALIFICATION_INVENTORY_SENTINEL_HASH
    || existsSync(inventoryPath) || existsSync(ownerKeysPath)) {
    fail(code, "qualification binding does not reproduce the new formal release and sentinel-only authority");
  }
  readPlainBytes(issuerPath, code, "gate issuer allowlist", 4 * 1024 * 1024);
  return Object.freeze({ path, sha256: sha256(read.bytes), value });
}

function zeroReceiptResources(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const relevant = ["jobs", "leases", "runs", "sessions", "actionCount", "pendingApprovals"]
    .filter((key) => Object.hasOwn(value, key));
  return relevant.length >= 3
    && relevant.every((key) => Number.isSafeInteger(value[key]) && value[key] === 0);
}

function validateQualificationReceipt({
  receipt,
  binding,
  database,
  targetRelease,
  runtimeRoot,
}) {
  const code = "M6_QUALIFICATION_RESUME_RECEIPT_INVALID";
  const schema = receipt.schemaId;
  if (![QUALIFICATION_BOOTSTRAP_RECEIPT_SCHEMA_ID, QUALIFICATION_ROTATION_RECEIPT_SCHEMA_ID]
    .includes(schema)) return null;
  if (receipt.gateId !== database.fence.gateId
    || receipt.closedEpochHash !== database.fence.epochHash) return null;
  const { receiptHash, ...body } = receipt;
  if (!HEX64.test(receiptHash || "")
    || !HEX64.test(receipt.packageHash || "")
    || receiptHash !== sha256(`${schema}:${domainCanonicalJson(body)}`)
    || receipt.gateId !== database.fence.gateId
    || receipt.closedEpochHash !== database.fence.epochHash
    || receipt.generation !== 0 || receipt.mode !== "CLOSED"
    || receipt.bindingSha256 !== binding.sha256
    || !samePath(receipt.bindingPath, binding.path)
    || receipt.releaseManifestSha256 !== targetRelease.manifestSha256
    || !samePath(
      receipt.gateFArtifactInventoryPath,
      join(runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json"),
    )
    || receipt.gateFArtifactInventoryHash !== QUALIFICATION_INVENTORY_SENTINEL_HASH
    || receipt.actionCount !== 0 || !zeroReceiptResources(receipt.resourceCounts)
    || receipt.privateKeyAccessed !== false
    || receipt.providerAccessed !== false || receipt.deviceAccessed !== false
    || receipt.networkAccessed !== false) {
    fail(code, "qualification operator receipt hash/binding/fence/resource identity is invalid");
  }
  if (schema === QUALIFICATION_BOOTSTRAP_RECEIPT_SCHEMA_ID) {
    if (receipt.releaseId !== targetRelease.releaseId
      || receipt.sourceCommit !== targetRelease.sourceCommit
      || receipt.locksHash !== database.fence.locksHash
      || receipt.secretMaterialPresent !== false) {
      fail(code, "bootstrap receipt is rebound from the new release fence");
    }
  } else if (receipt.nextFenceHash !== qualificationFenceHash(database.fence)) {
    fail(code, "rotation receipt does not bind the new qualification fence hash");
  }
  return Object.freeze({ schemaId: schema, receiptHash, packageHash: receipt.packageHash });
}

function inspectQualificationFinalState({
  runtimeRoot,
  targetRelease,
  expectedQualificationHash = null,
  requireStandalone = true,
  nowMs = Date.now(),
  gateLoader = loadM6Gate,
  tripleVerifier = assertM6FileDbPointerConsistency,
  gateEvaluator = evaluateM6Gate,
} = {}) {
  const code = "M6_QUALIFICATION_RESUME_STATE_INVALID";
  if ((expectedQualificationHash !== null && !HEX64.test(expectedQualificationHash || ""))
    || !Number.isFinite(nowMs)
    || typeof gateLoader !== "function" || typeof tripleVerifier !== "function"
    || typeof gateEvaluator !== "function") {
    fail(code, "qualification proof hash, clock, and gate verifiers are invalid");
  }
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  const binding = validateQualificationBinding({ runtimeRoot: runtime, targetRelease });
  const database = inspectQualificationDatabase({
    path: join(runtime, ...DB_TARGETS[0].path),
    nowMs,
    requireStandalone,
  });
  const fence = database.fence;
  const fenceHash = qualificationFenceHash(fence);
  if (fence.generation !== 0 || fence.mode !== "CLOSED" || fence.purpose !== null
    || domainCanonicalJson(fence.allowlist) !== domainCanonicalJson(["01"])
    || !HEX64.test(fence.epochHash || "") || !HEX64.test(fence.locksHash || "")
    || fence.releaseId !== targetRelease.releaseId
    || fence.sourceCommit !== targetRelease.sourceCommit
    || fence.gateId !== binding.value.gateId
    || !Number.isFinite(Date.parse(fence.expiresAt || ""))
    || Date.parse(fence.expiresAt) <= nowMs) {
    fail(code, "database fence is not the fresh new-release generation-0 CLOSED zero-authority fence");
  }
  let loaded;
  try {
    loaded = gateLoader({
      m6Root: runtime,
      gateId: fence.gateId,
      issuerAllowlistPath: binding.value.gateIssuerAllowlistPath,
      requireLocks: true,
    });
    tripleVerifier({ loaded, fence, pointer: loaded.currentPointer });
  } catch { fail(code, "file/DB/pointer qualification fence is not triple-consistent"); }
  const evaluation = gateEvaluator({
    ...loaded,
    nowMs,
    expectedRelease: { releaseId: targetRelease.releaseId, sourceCommit: targetRelease.sourceCommit },
    lockHashes: loaded.lockHashes,
  });
  if (evaluation?.mode !== "CLOSED" || evaluation?.activeEpochHash !== fence.epochHash
    || !Array.isArray(evaluation?.errors) || evaluation.errors.length !== 0) {
    fail(code, "qualification gate chain does not evaluate to exact CLOSED");
  }
  const receiptRoot = join(runtime, "qualification-bootstrap", "receipts");
  assertPlainDirectory(receiptRoot, code, "qualification receipt root");
  const names = readdirSync(receiptRoot).filter((name) => name.endsWith(".json"));
  if (names.length < 1 || names.length > 256) fail(code, "qualification receipt set is absent or unbounded");
  const matches = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) fail(code, "qualification receipt filename is not content-addressed");
    const read = readCanonicalJson(join(receiptRoot, name), code, "qualification receipt", 4 * 1024 * 1024);
    const validated = validateQualificationReceipt({
      receipt: read.value,
      binding,
      database,
      targetRelease,
      runtimeRoot: runtime,
    });
    if (validated) {
      if (name !== `${validated.receiptHash}.json`) fail(code, "qualification receipt address drifted");
      matches.push(Object.freeze({
        ...validated,
        path: join(receiptRoot, name),
        sha256: sha256(read.bytes),
      }));
    }
  }
  if (matches.length !== 1) fail(code, "new qualification fence must have exactly one binding receipt");
  const receipt = matches[0];
  if (expectedQualificationHash !== null
    && ![fenceHash, receipt.receiptHash].includes(expectedQualificationHash)) {
    fail(code, "caller proof hash matches neither the new fence nor its qualification receipt");
  }
  return Object.freeze({
    schemaId: "xw.runtime.m6-qualification-resume-state.v1",
    releaseId: targetRelease.releaseId,
    sourceCommit: targetRelease.sourceCommit,
    databaseVersion: database.userVersion,
    databaseSha256: database.sha256,
    fenceHash,
    fence,
    resources: database.resources,
    durableResidue: database.durableResidue,
    binding: Object.freeze({ path: binding.path, sha256: binding.sha256 }),
    receipt,
  });
}

export function inspectM6QualificationResumeState(options = {}) {
  if (!HEX64.test(options.expectedQualificationHash || "")) {
    fail("M6_QUALIFICATION_RESUME_STATE_INVALID", "expected qualification proof hash is required");
  }
  return inspectQualificationFinalState(options);
}

export function inspectM6QualificationFinalRelayState(options = {}) {
  return inspectQualificationFinalState({ ...options, expectedQualificationHash: null });
}

function publishGateFRelaySnapshot({
  runtimeRoot,
  releaseId,
  sourceCommit,
  targetPath,
  filename,
  bytes,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_SNAPSHOT_INVALID";
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024 * 1024) {
    fail(code, `${filename} snapshot bytes are invalid`);
  }
  const snapshotSha256 = sha256(bytes);
  const snapshotPath = join(
    runtimeRoot,
    "rollback-snapshots",
    releaseId,
    sourceCommit,
    snapshotSha256,
    filename,
  );
  if (!within(join(runtimeRoot, "rollback-snapshots"), snapshotPath)) {
    fail(code, "qualified target snapshot escaped fixed rollback namespace");
  }
  if (!existsSync(dirname(snapshotPath))) mkdirSync(dirname(snapshotPath), { recursive: true });
  protectTcb(tcbAclController, runtimeRoot, dirname(snapshotPath), false, code);
  if (existsSync(snapshotPath)) {
    const existing = readPlainBytes(snapshotPath, code, filename, 1024 * 1024 * 1024);
    if (!existing.equals(bytes)) fail(code, "qualified target snapshot address collision");
  } else {
    writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
  }
  protectTcb(tcbAclController, runtimeRoot, snapshotPath, false, code);
  return Object.freeze({ targetPath, snapshotPath, snapshotSha256 });
}

export async function captureM6QualificationFinalTargetSnapshots({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  qualification,
  databaseSnapshotter = snapshotSqliteDatabase,
  tcbAclController = createSystemTcbAclController(),
  nowMs = Date.now(),
} = {}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_SNAPSHOT_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")
    || qualification?.releaseId !== expectedReleaseId
    || qualification?.sourceCommit !== expectedSourceCommit
    || qualification?.databaseVersion !== 21 || !HEX64.test(qualification?.fenceHash || "")
    || typeof databaseSnapshotter !== "function" || !Number.isFinite(nowMs)) {
    fail(code, "stopped qualification identity and snapshotter are required");
  }
  const currentPath = join(runtime, "current");
  let currentTarget;
  try {
    if (!lstatSync(currentPath).isSymbolicLink()) fail(code, "current is not a junction");
    currentTarget = realpathSync(currentPath);
  } catch (cause) {
    if (cause?.code === code) throw cause;
    fail(code, "current qualification junction is unavailable");
  }
  const expectedRoot = join(runtime, "releases", expectedReleaseId);
  if (!samePath(currentTarget, expectedRoot)) fail(code, "current is not the qualified target release");
  const manifest = readCanonicalJson(join(expectedRoot, "release-manifest.v1.json"), code, "target manifest").value;
  if (manifest.releaseId !== expectedReleaseId || manifest.sourceCommit !== expectedSourceCommit) {
    fail(code, "current manifest differs from qualified target identity");
  }
  const targets = {
    controlDb: join(runtime, ...DB_TARGETS[0].path),
    registryDb: join(runtime, ...DB_TARGETS[1].path),
    secretEnvironment: join(runtime, ...PRIVATE_TARGETS[0].path),
    digestKeyring: join(runtime, ...PRIVATE_TARGETS[1].path),
  };
  for (const path of Object.values(targets)) assertPlainFile(path, code, "qualified target slot");
  for (const path of [targets.controlDb, targets.registryDb]) {
    if (["-wal", "-shm"].some((suffix) => existsSync(`${path}${suffix}`))) {
      fail(code, "qualified database is not standalone at snapshot boundary");
    }
  }
  const tempRoot = join(runtime, "rollback-snapshots", ".qualification-sqlite-captures");
  const [controlBytes, registryBytes] = await Promise.all([
    databaseSnapshotter(targets.controlDb, { tempRoot, runtimeRoot: runtime, tcbAclController }),
    databaseSnapshotter(targets.registryDb, { tempRoot, runtimeRoot: runtime, tcbAclController }),
  ]);
  const publish = (targetPath, filename, bytes) => publishGateFRelaySnapshot({
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    targetPath,
    filename,
    bytes,
    tcbAclController,
  });
  const controlDb = publish(targets.controlDb, "control.db", controlBytes);
  const copiedQualification = inspectQualificationDatabase({
    path: controlDb.snapshotPath,
    nowMs,
    requireStandalone: true,
  });
  if (copiedQualification.userVersion !== 21
    || qualificationFenceHash(copiedQualification.fence) !== qualification.fenceHash
    || domainCanonicalJson(copiedQualification.resources) !== domainCanonicalJson(qualification.resources)
    || domainCanonicalJson(copiedQualification.durableResidue)
      !== domainCanonicalJson(qualification.durableResidue)) {
    fail(code, "captured target DB did not reproduce the exact qualification fence/resources");
  }
  return Object.freeze({
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    snapshots: Object.freeze({
      controlDb,
      registryDb: publish(targets.registryDb, REGISTRY_DATABASE_FILENAME, registryBytes),
      privateMaterial: Object.freeze([
        publish(targets.secretEnvironment, "control-plane-secret-environment.v1.json",
          readPlainBytes(targets.secretEnvironment, code, "secret environment", 32 * 1024)),
        publish(targets.digestKeyring, "xhs-evidence-digest-keyring.v1.json",
          readPlainBytes(targets.digestKeyring, code, "digest keyring", 32 * 1024)),
      ]),
    }),
  });
}

function relayAuthorizationDocument({
  targetRelease,
  assemblerReceiptHash,
  prestateArtifact,
  relayPrestateArtifact,
  qualification,
  candidate,
  tuplePath,
  tupleSha256,
}) {
  return Object.freeze({
    schemaId: M6_QUALIFICATION_FINAL_RELAY_AUTHORIZATION_SCHEMA_ID,
    intent: "M6_QUALIFICATION_FINAL_RELAY",
    targetRelease: Object.freeze({
      releaseId: targetRelease.releaseId,
      sourceCommit: targetRelease.sourceCommit,
    }),
    assemblerReceiptHash,
    legacy: Object.freeze({ path: prestateArtifact.path, sha256: prestateArtifact.sha256 }),
    relayPrestate: Object.freeze({
      path: relayPrestateArtifact.path,
      sha256: relayPrestateArtifact.sha256,
    }),
    qualification: Object.freeze({
      databaseSha256: qualification.databaseSha256,
      databaseVersion: qualification.databaseVersion,
      fenceHash: qualification.fenceHash,
      bindingSha256: qualification.binding.sha256,
      receiptHash: qualification.receipt.receiptHash,
      packageHash: qualification.receipt.packageHash,
    }),
    candidate: Object.freeze({ path: candidate.path, sha256: candidate.sha256 }),
    to: Object.freeze({ path: tuplePath, sha256: tupleSha256 }),
  });
}

export function materializeM6QualificationFinalRelayAuthorization({
  runtimeRoot,
  targetRelease,
  assemblerReceiptHash,
  prestateArtifact,
  relayPrestateArtifact,
  qualification,
  candidate,
  tuplePath,
  tupleSha256,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_AUTHORIZATION_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  const expectedLegacyRoot = join(runtime, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME, "prestates");
  const expectedTuplePath = join(runtime, "cutover-tuples", tupleSha256 || "", "gate-f-cutover-tuple.v1.json");
  const expectedCandidatePath = join(
    runtime,
    "cutover-candidates",
    targetRelease?.releaseId || "",
    targetRelease?.sourceCommit || "",
    "gate-f-target-candidate.v1.json",
  );
  if (!RELEASE_ID.test(targetRelease?.releaseId || "")
    || !HEX40.test(targetRelease?.sourceCommit || "")
    || !HEX64.test(assemblerReceiptHash || "")
    || !HEX64.test(prestateArtifact?.sha256 || "")
    || !within(expectedLegacyRoot, prestateArtifact?.path || "")
    || basename(dirname(prestateArtifact.path)).toLowerCase() !== prestateArtifact.sha256
    || !HEX64.test(relayPrestateArtifact?.sha256 || "")
    || !within(join(runtime, "qualification-final-relays", "artifacts"), relayPrestateArtifact?.path || "")
    || basename(dirname(relayPrestateArtifact.path)).toLowerCase() !== relayPrestateArtifact.sha256
    || !HEX64.test(qualification?.databaseSha256 || "")
    || qualification.databaseVersion !== 21
    || !HEX64.test(qualification?.fenceHash || "")
    || !HEX64.test(qualification?.binding?.sha256 || "")
    || !HEX64.test(qualification?.receipt?.receiptHash || "")
    || !HEX64.test(qualification?.receipt?.packageHash || "")
    || !HEX64.test(candidate?.sha256 || "") || !samePath(candidate?.path, expectedCandidatePath)
    || !HEX64.test(tupleSha256 || "") || !samePath(tuplePath, expectedTuplePath)) {
    fail(code, "relay authorization inputs escaped fixed content addresses or exact schema-21 identity");
  }
  validateArtifactRef(prestateArtifact, {
    base: join(runtime, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME),
    code,
    label: "sealed legacy window prestate",
  });
  const relayPrestateBytes = readPlainBytes(
    relayPrestateArtifact.path,
    code,
    "sealed relay overlay prestate",
    4 * 1024 * 1024,
  );
  if (sha256(relayPrestateBytes) !== relayPrestateArtifact.sha256) {
    fail(code, "sealed relay overlay prestate drifted");
  }
  const tupleBytes = readPlainBytes(tuplePath, code, "target Gate-F tuple", 64 * 1024 * 1024);
  if (sha256(tupleBytes) !== tupleSha256) fail(code, "target Gate-F tuple content address drifted");
  const candidateBytes = readPlainBytes(candidate.path, code, "target Gate-F candidate", 64 * 1024 * 1024);
  if (sha256(candidateBytes) !== candidate.sha256) fail(code, "target Gate-F candidate content hash drifted");
  const document = relayAuthorizationDocument({
    targetRelease,
    assemblerReceiptHash,
    prestateArtifact,
    relayPrestateArtifact,
    qualification,
    candidate,
    tuplePath,
    tupleSha256,
  });
  const bytes = canonicalJsonBytes(document);
  const authorizationSha256 = sha256(bytes);
  const path = join(
    runtime,
    "qualification-final-relays",
    "by-release",
    targetRelease.releaseId,
    targetRelease.sourceCommit,
    authorizationSha256,
    "authorization.v1.json",
  );
  if (!within(join(runtime, "qualification-final-relays"), path)) {
    fail(code, "relay authorization path escaped fixed namespace");
  }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  protectTcb(tcbAclController, runtime, dirname(path), false, code);
  if (existsSync(path)) {
    const existing = readPlainBytes(path, code, "existing relay authorization", 4 * 1024 * 1024);
    if (!existing.equals(bytes)) fail(code, "relay authorization address collision");
  } else {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  protectTcb(tcbAclController, runtime, path, false, code);
  return Object.freeze({ path, sha256: authorizationSha256, document });
}

function validateM6QualificationFinalRelayAuthorization({
  runtimeRoot,
  authorization,
  targetRelease,
  assemblerReceiptHash,
  prestateArtifact,
  relayPrestateArtifact,
  qualification,
  candidate,
  tuplePath,
  tupleSha256,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_AUTHORIZATION_INVALID";
  const document = relayAuthorizationDocument({
    targetRelease,
    assemblerReceiptHash,
    prestateArtifact,
    relayPrestateArtifact,
    qualification,
    candidate,
    tuplePath,
    tupleSha256,
  });
  const expectedBytes = canonicalJsonBytes(document);
  const expectedSha256 = sha256(expectedBytes);
  const expectedPath = join(
    runtimeRoot,
    "qualification-final-relays",
    "by-release",
    targetRelease.releaseId,
    targetRelease.sourceCommit,
    expectedSha256,
    "authorization.v1.json",
  );
  if (!exactObject(authorization, ["document", "path", "sha256"])
    || authorization.sha256 !== expectedSha256
    || !samePath(authorization.path, expectedPath)
    || domainCanonicalJson(authorization.document) !== domainCanonicalJson(document)) {
    fail(code, "relay authorization return did not reproduce its fixed content address");
  }
  const actualBytes = readPlainBytes(
    expectedPath,
    code,
    "sealed relay authorization",
    4 * 1024 * 1024,
  );
  if (!actualBytes.equals(expectedBytes) || sha256(actualBytes) !== expectedSha256) {
    fail(code, "sealed relay authorization bytes differ from the authorized transition");
  }
  verifyTcb(tcbAclController, runtimeRoot, expectedPath, false, code);
  return Object.freeze({ path: expectedPath, sha256: expectedSha256 });
}

function safeRelayErrorCode(value, fallback) {
  return SAFE_ERROR_CODE.test(value || "") ? value : fallback;
}

function safeRelaySettlementRows(rows) {
  return Object.freeze((Array.isArray(rows) ? rows : []).map((row) => Object.freeze({
    component: typeof row?.component === "string" && /^[A-Za-z0-9:._ -]{1,128}$/u.test(row.component)
      ? row.component
      : "unknown",
    status: row?.status === "fulfilled" ? "fulfilled" : "rejected",
    ...(row?.status === "rejected" ? {
      errorCode: safeRelayErrorCode(
        row?.errorCode,
        "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_STEP_FAILED",
      ),
    } : {}),
  })));
}

function safeRelayRollback(value) {
  return Object.freeze({
    stop: safeRelaySettlementRows(value?.stop),
    resources: safeRelaySettlementRows(value?.resources),
    overlay: safeRelaySettlementRows(value?.overlay),
    restart: safeRelaySettlementRows(value?.restart),
    verified: value?.verified === true,
  });
}

function materializeM6QualificationFinalRelayReceipt({
  runtimeRoot,
  body,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_RECEIPT_PERSIST_FAILED";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.schemaId !== M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID
    || !SAFE_ERROR_CODE.test(body.code || "")
    || !["FINAL_ACTIVE", "LEGACY_RESTORED", "ROLLBACK_INCOMPLETE"].includes(body.outcome)
    || !RELEASE_ID.test(body.releaseId || "") || !HEX40.test(body.sourceCommit || "")
    || !HEX64.test(body.authorizationSha256 || "")
    || !HEX64.test(body.legacyPrestateSha256 || "")
    || !HEX64.test(body.relayPrestateSha256 || "")
    || !HEX64.test(body.targetTupleSha256 || "")) {
    fail(code, "relay receipt body is not one bounded public result");
  }
  const receiptHash = sha256(
    `${M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID}:${domainCanonicalJson(body)}`,
  );
  const receipt = Object.freeze({ ...body, receiptHash });
  const bytes = canonicalJsonBytes(receipt);
  const receiptRoot = join(runtime, "qualification-final-relays", "receipts");
  const path = join(receiptRoot, `${receiptHash}.json`);
  try {
    if (!existsSync(receiptRoot)) mkdirSync(receiptRoot, { recursive: true });
    assertPlainDirectory(receiptRoot, code, "relay receipt root");
    protectTcb(tcbAclController, runtime, receiptRoot, false, code);
    if (existsSync(path)) {
      const existing = readPlainBytes(path, code, "existing relay receipt", 4 * 1024 * 1024);
      if (!existing.equals(bytes)) fail(code, "relay receipt address collision");
    } else {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    protectTcb(tcbAclController, runtime, path, false, code);
    const persisted = readCanonicalJson(path, code, "persisted relay receipt", 4 * 1024 * 1024);
    const { receiptHash: persistedHash, ...persistedBody } = persisted.value;
    if (persistedHash !== receiptHash
      || receiptHash !== sha256(
        `${M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID}:${domainCanonicalJson(persistedBody)}`,
      )
      || !persisted.bytes.equals(bytes)) {
      fail(code, "persisted relay receipt did not reproduce its domain hash");
    }
  } catch (cause) {
    if (cause?.code === code) throw cause;
    fail(code, "relay receipt could not be persisted and verified");
  }
  return Object.freeze({
    receiptHash,
    receiptRef: Object.freeze({ path, sha256: sha256(bytes) }),
  });
}

function persistM6QualificationFinalRelayReceipt({
  receiptWriter,
  runtimeRoot,
  body,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_RECEIPT_PERSIST_FAILED";
  let result;
  try {
    result = receiptWriter({ runtimeRoot, body, tcbAclController });
  } catch (cause) {
    if (cause?.code === code) throw cause;
    fail(code, "relay receipt writer failed closed");
  }
  const expectedPath = join(
    runtimeRoot,
    "qualification-final-relays",
    "receipts",
    `${result?.receiptHash || ""}.json`,
  );
  if (!exactObject(result, ["receiptHash", "receiptRef"])
    || !HEX64.test(result.receiptHash || "")
    || !exactObject(result.receiptRef, ["path", "sha256"])
    || !samePath(result.receiptRef.path, expectedPath)
    || !HEX64.test(result.receiptRef.sha256 || "")) {
    fail(code, "relay receipt writer returned a non-canonical reference");
  }
  const persisted = readCanonicalJson(expectedPath, code, "persisted relay receipt", 4 * 1024 * 1024);
  const { receiptHash, ...persistedBody } = persisted.value;
  if (receiptHash !== result.receiptHash
    || receiptHash !== sha256(
      `${M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID}:${domainCanonicalJson(persistedBody)}`,
    )
    || sha256(persisted.bytes) !== result.receiptRef.sha256
    || domainCanonicalJson(persistedBody) !== domainCanonicalJson(body)) {
    fail(code, "relay receipt writer output failed independent reproduction");
  }
  verifyTcb(tcbAclController, runtimeRoot, expectedPath, false, code);
  return Object.freeze({
    code: body.code,
    receiptHash: result.receiptHash,
    receiptRef: result.receiptRef,
  });
}

export async function planM6QualificationLegacyWindow({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  executingOperatorPath = fileURLToPath(import.meta.url),
  releaseVerifier = verifyReleaseManifest,
  trustedNodeInspector = inspectTrustedNode,
  taskInspector,
  listenerInspector,
  healthInspector,
  ownerLockInspector = inspectLegacyRuntimeOwnerLock,
  launcherInspector = inspectLegacyLaunchers,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "M6_QUALIFICATION_LEGACY_PREFLIGHT_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  assertPlainDirectory(runtime, code, "runtime root");
  if (typeof releaseVerifier !== "function" || typeof trustedNodeInspector !== "function"
    || typeof taskInspector !== "function" || typeof listenerInspector !== "function"
    || typeof healthInspector !== "function" || typeof ownerLockInspector !== "function"
    || typeof launcherInspector !== "function") {
    fail(code, "release/node/task/listener/health/runtime inspectors are required");
  }
  const targetRelease = inspectTargetRelease({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    executingOperatorPath,
    releaseVerifier,
    tcbAclController,
  });
  const legacyRelease = inspectCurrentRelease({ runtimeRoot: runtime, releaseVerifier, tcbAclController });
  if (samePath(targetRelease.root, legacyRelease.root)) {
    fail(code, "new formal release must not be the active legacy release");
  }
  const trustedNode = trustedNodeInspector(TRUSTED_NODE_EXECUTABLE);
  if (!samePath(trustedNode?.path, TRUSTED_NODE_EXECUTABLE)
    || !HEX64.test(trustedNode?.sha256 || "")
    || trustedNode?.version !== legacyRelease.manifest.nodeVersion
    || trustedNode.version !== targetRelease.manifest.nodeVersion) {
    fail(code, "trusted Node path/hash/version differs from legacy or target release");
  }
  const modules = Object.freeze({
    controlPlane: inspectManifestFile({
      manifest: legacyRelease.manifest,
      releaseRoot: legacyRelease.root,
      releasePath: CONTROL_MODULE_RELEASE_PATH,
      code,
      label: "legacy control-plane module",
    }),
    registry: inspectManifestFile({
      manifest: legacyRelease.manifest,
      releaseRoot: legacyRelease.root,
      releasePath: REGISTRY_MODULE_RELEASE_PATH,
      code,
      label: "legacy registry module",
    }),
  });
  const task = validateLegacyTaskInspection(await taskInspector(), {
    runtimeRoot: runtime,
    legacyRelease,
    targetRelease,
    modules,
  });
  const launchers = await launcherInspector({ runtimeRoot: runtime });
  if (!exactObject(launchers, ["controlPlane", "registry"])) {
    fail(code, "fixed legacy launcher set is malformed");
  }
  for (const target of LEGACY_LAUNCHER_TARGETS) {
    const ref = launchers[target.key];
    const expectedPath = join(runtime, target.filename);
    if (!exactObject(ref, ["key", "path", "sha256"])
      || ref.key !== target.key || !samePath(ref.path, expectedPath)
      || !HEX64.test(ref.sha256 || "")
      || sha256(readPlainBytes(expectedPath, code, `${target.key} launcher`, 1024 * 1024))
        !== ref.sha256) {
      fail(code, "fixed legacy launcher identity drifted");
    }
    verifyTcb(tcbAclController, runtime, expectedPath, false, code);
  }
  const listenerInspection = await listenerInspector({
    modules,
    trustedNode,
    launchers,
  });
  const caller = listenerInspection?.caller;
  const listeners = normalizeM6QualificationLegacyListeners(listenerInspection, {
    modules,
    trustedNode,
    requireActive: true,
    launchers,
    caller,
  });
  const controlListener = listeners.find((row) => row.port === 17920);
  const ownerLock = await ownerLockInspector({ runtimeRoot: runtime, expectedPid: controlListener.pid });
  if (!exactObject(ownerLock, ["path", "pid", "sha256"])
    || !samePath(ownerLock.path, m6C1RuntimeOwnerLockPath(runtime))
    || ownerLock.pid !== controlListener.pid || !HEX64.test(ownerLock.sha256 || "")
    || !exactObject(caller, ["sessionId", "sidSha256"])
    || !Number.isSafeInteger(caller.sessionId) || caller.sessionId < 0
    || !HEX64.test(caller.sidSha256 || "")) {
    fail(code, "legacy runtime owner-lock or caller identity is invalid");
  }
  const legacyRuntime = Object.freeze({
    ownerLock,
    launchers,
    caller: Object.freeze({ ...caller }),
  });
  const health = assertHealthIdentity(
    await healthInspector(),
    legacyRelease,
    "M6_QUALIFICATION_LEGACY_HEALTH_INVALID",
  );
  for (const row of [...DB_TARGETS, ...PRIVATE_TARGETS]) {
    const path = join(runtime, ...row.path);
    assertPlainFile(path, code, row.key);
    verifyTcb(tcbAclController, runtime, path, false, code);
  }
  return Object.freeze({
    schemaId: "xw.runtime.m6-qualification-legacy-window-plan.v2",
    runtimeRoot: runtime,
    targetRelease,
    legacyRelease,
    trustedNode: Object.freeze({
      path: resolve(trustedNode.path),
      sha256: trustedNode.sha256,
      version: trustedNode.version,
    }),
    modules,
    task,
    listeners,
    legacyRuntime,
    health,
  });
}

async function snapshotSqliteDatabase(sourcePath, {
  tempRoot,
  runtimeRoot,
  tcbAclController,
  standalone = false,
}) {
  if (standalone) {
    const code = "M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID";
    if (["-wal", "-shm"].some((suffix) => existsSync(`${sourcePath}${suffix}`))) {
      fail(code, "stopped SQLite snapshot requires absent WAL/SHM sidecars");
    }
    let fd;
    try {
      fd = openSync(sourcePath, "r");
      const opened = fstatSync(fd, { bigint: true });
      const named = lstatSync(sourcePath, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.isSymbolicLink()
        || !sameOpenFileIdentity(opened, named)) {
        fail(code, "stopped SQLite snapshot source is not one stable single-link file");
      }
      const bytes = readFileSync(fd);
      const descriptorAfter = fstatSync(fd, { bigint: true });
      const pathAfter = lstatSync(sourcePath, { bigint: true });
      if (!sameOpenFileIdentity(opened, descriptorAfter)
        || !sameOpenFileIdentity(descriptorAfter, pathAfter)
        || ["-wal", "-shm"].some((suffix) => existsSync(`${sourcePath}${suffix}`))) {
        fail(code, "stopped SQLite snapshot source drifted while copied");
      }
      verifyTcb(tcbAclController, runtimeRoot, sourcePath, false, code);
      return bytes;
    } catch (cause) {
      if (cause?.code === code) throw cause;
      fail(code, "stopped SQLite snapshot failed closed");
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch {}
    }
  }
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (!existsSync(tempRoot)) mkdirSync(tempRoot, { recursive: true });
  protectTcb(tcbAclController, runtimeRoot, tempRoot, false, "M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID");
  const tempPath = join(tempRoot, `${randomUUID()}.sqlite`);
  let source;
  let check;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
    await backup(source, tempPath);
    source.close();
    source = null;
    check = new DatabaseSync(tempPath, { readOnly: true, allowExtension: false });
    const row = check.prepare("PRAGMA quick_check").get();
    if (!row || !Object.values(row).includes("ok")) {
      fail("M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID", "SQLite backup quick_check failed");
    }
    check.close();
    check = null;
    return readPlainBytes(
      tempPath,
      "M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID",
      "SQLite backup",
      1024 * 1024 * 1024,
    );
  } catch (cause) {
    if (cause?.code === "M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID") throw cause;
    fail("M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID", "SQLite online backup failed closed");
  } finally {
    try { source?.close(); } catch {}
    try { check?.close(); } catch {}
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function createSealedPublisher({ runtimeRoot, tcbAclController }) {
  const code = "M6_QUALIFICATION_LEGACY_PUBLICATION_INVALID";
  const base = join(runtimeRoot, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME);
  const seal = (path, recursive = false) => protectTcb(
    tcbAclController,
    runtimeRoot,
    path,
    recursive,
    code,
  );
  const ensureDirectory = (path) => {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    assertPlainDirectory(path, code, "publication directory");
    seal(path, false);
  };
  const publishBytes = ({ namespace, filename, bytes }) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024 * 1024
      || typeof filename !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(filename)) {
      fail(code, "addressed artifact input is invalid");
    }
    const digest = sha256(bytes);
    const path = join(base, namespace, digest, filename);
    ensureDirectory(dirname(path));
    if (existsSync(path)) {
      const existing = readPlainBytes(path, code, "addressed artifact", 1024 * 1024 * 1024);
      if (!existing.equals(bytes)) fail(code, "address collision");
    } else {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    seal(path, false);
    return Object.freeze({ path, sha256: digest });
  };
  const publishIdentity = ({ path, bytes }) => {
    if (!within(base, path)) fail(code, "identity publication escaped the fixed window root");
    ensureDirectory(dirname(path));
    if (existsSync(path)) {
      const existing = readPlainBytes(path, code, "identity publication", 64 * 1024 * 1024);
      if (!existing.equals(bytes)) fail(code, "fixed target release is already bound to another prestate");
    } else {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    seal(path, false);
    return Object.freeze({ path, sha256: sha256(bytes) });
  };
  ensureDirectory(base);
  return Object.freeze({ base, publishBytes, publishIdentity });
}

function resourceSnapshotRef({ artifact, targetPath }) {
  return Object.freeze({
    path: artifact.path,
    sha256: artifact.sha256,
    targetPath,
  });
}

function optionalResourceSnapshotRef({ artifact = null, targetPath }) {
  return artifact === null
    ? Object.freeze({ present: false, targetPath })
    : Object.freeze({ ...resourceSnapshotRef({ artifact, targetPath }), present: true });
}

async function captureSealedPrestate(plan, {
  databaseSnapshotter,
  publisher,
  tcbAclController,
  boundary,
  publishReference = true,
}) {
  const code = "M6_QUALIFICATION_LEGACY_SNAPSHOT_INVALID";
  const runtime = plan.runtimeRoot;
  if (!exactObject(boundary, ["checkpointHash", "kind", "ownerRecoveryHash"])
    || !["ONLINE_ROLLBACK", "STOPPED"].includes(boundary.kind)
    || !HEX64.test(boundary.checkpointHash || "")
    || !HEX64.test(boundary.ownerRecoveryHash || "")
    || (publishReference && boundary.kind !== "STOPPED")
    || (!publishReference && boundary.kind !== "ONLINE_ROLLBACK")) {
    fail(code, "prestate boundary identity does not match its publication role");
  }
  const tempRoot = join(publisher.base, ".sqlite-captures");
  const databaseRefs = {};
  for (const row of DB_TARGETS) {
    const targetPath = join(runtime, ...row.path);
    const bytes = await databaseSnapshotter(targetPath, {
      tempRoot,
      runtimeRoot: runtime,
      tcbAclController,
      standalone: boundary.kind === "STOPPED",
    });
    if (!Buffer.isBuffer(bytes)) fail(code, "database snapshotter must return bytes");
    const artifact = publisher.publishBytes({ namespace: "artifacts", filename: basename(targetPath), bytes });
    databaseRefs[row.key] = resourceSnapshotRef({ artifact, targetPath });
  }
  const privateRefs = {};
  for (const row of PRIVATE_TARGETS) {
    const targetPath = join(runtime, ...row.path);
    const bytes = readPlainBytes(targetPath, code, row.key, 32 * 1024);
    const artifact = publisher.publishBytes({ namespace: "artifacts", filename: basename(targetPath), bytes });
    privateRefs[row.key] = resourceSnapshotRef({ artifact, targetPath });
  }
  const qualificationBindingPath = join(runtime, ...QUALIFICATION_BINDING_TARGET.path);
  let qualificationBindingArtifact = null;
  if (existsSync(qualificationBindingPath)) {
    const bytes = readPlainBytes(
      qualificationBindingPath,
      code,
      QUALIFICATION_BINDING_TARGET.key,
      64 * 1024,
    );
    qualificationBindingArtifact = publisher.publishBytes({
      namespace: "artifacts",
      filename: basename(qualificationBindingPath),
      bytes,
    });
  }
  const qualificationBinding = optionalResourceSnapshotRef({
    artifact: qualificationBindingArtifact,
    targetPath: qualificationBindingPath,
  });
  const taskArtifact = publisher.publishBytes({
    namespace: "artifacts",
    filename: "xw-platform-control-plane.xml",
    bytes: Buffer.from(plan.task.xml, "utf8"),
  });
  const currentValue = {
    schemaId: "xw.runtime.m6-qualification-legacy-current-prestate.v1",
    path: plan.legacyRelease.currentPath,
    target: plan.legacyRelease.root,
    releaseId: plan.legacyRelease.releaseId,
    sourceCommit: plan.legacyRelease.sourceCommit,
  };
  const currentArtifact = publisher.publishBytes({
    namespace: "artifacts",
    filename: "current-prestate.v1.json",
    bytes: canonicalJsonBytes(currentValue),
  });
  const processValue = {
    schemaId: "xw.runtime.m6-qualification-legacy-process-prestate.v2",
    releaseId: plan.legacyRelease.releaseId,
    sourceCommit: plan.legacyRelease.sourceCommit,
    listeners: plan.listeners.map((row) => ({ ...row })),
  };
  const processArtifact = publisher.publishBytes({
    namespace: "artifacts",
    filename: "process-prestate.v2.json",
    bytes: canonicalJsonBytes(processValue),
  });
  const prestate = {
    schemaId: M6_QUALIFICATION_LEGACY_WINDOW_PRESTATE_SCHEMA_ID,
    runtimeRoot: runtime,
    targetRelease: {
      releaseId: plan.targetRelease.releaseId,
      sourceCommit: plan.targetRelease.sourceCommit,
      operatorSha256: plan.targetRelease.operator.sha256,
    },
    legacyRelease: {
      releaseId: plan.legacyRelease.releaseId,
      sourceCommit: plan.legacyRelease.sourceCommit,
      root: plan.legacyRelease.root,
      manifestPath: plan.legacyRelease.manifestPath,
      manifestSha256: plan.legacyRelease.manifestSha256,
    },
    current: {
      path: plan.legacyRelease.currentPath,
      target: plan.legacyRelease.root,
      snapshot: currentArtifact,
    },
    task: {
      name: FORMAL_CONTROL_PLANE_TASK_NAME,
      state: plan.task.state,
      xml: taskArtifact,
    },
    legacyRuntime: plan.legacyRuntime,
    boundary,
    trustedNode: plan.trustedNode,
    modules: plan.modules,
    processes: { snapshot: processArtifact },
    resources: {
      controlDb: databaseRefs.controlDb,
      registryDb: databaseRefs.registryDb,
      qualificationBinding,
      privateMaterial: [privateRefs.secretEnvironment, privateRefs.digestKeyring],
    },
  };
  const prestateBytes = canonicalJsonBytes(prestate);
  const prestateArtifact = publisher.publishBytes({
    namespace: publishReference ? "prestates" : "rollback-drafts",
    filename: "m6-qualification-legacy-window-prestate.v2.json",
    bytes: prestateBytes,
  });
  const reference = publishReference ? {
    schemaId: M6_QUALIFICATION_LEGACY_WINDOW_REFERENCE_SCHEMA_ID,
    targetRelease: {
      releaseId: plan.targetRelease.releaseId,
      sourceCommit: plan.targetRelease.sourceCommit,
    },
    legacyRelease: {
      releaseId: plan.legacyRelease.releaseId,
      sourceCommit: plan.legacyRelease.sourceCommit,
    },
    prestate: prestateArtifact,
  } : null;
  const referencePath = join(
    publisher.base,
    "by-release",
    plan.targetRelease.releaseId,
    plan.targetRelease.sourceCommit,
    "window-reference.v2.json",
  );
  const referenceArtifact = publishReference ? publisher.publishIdentity({
    path: referencePath,
    bytes: canonicalJsonBytes(reference),
  }) : null;
  return Object.freeze({ prestate, prestateArtifact, reference, referenceArtifact });
}

function validateArtifactRef(ref, { base, expectedPath = null, code, label }) {
  if (!exactObject(ref, expectedPath === null ? ["path", "sha256"] : ["path", "sha256", "targetPath"])
    || !HEX64.test(ref.sha256 || "") || !within(base, ref.path)
    || basename(dirname(ref.path)).toLowerCase() !== ref.sha256
    || (expectedPath !== null && !samePath(ref.targetPath, expectedPath))) {
    fail(code, `${label} reference escaped its fixed content address or target`);
  }
  const bytes = readPlainBytes(ref.path, code, label, 1024 * 1024 * 1024);
  if (sha256(bytes) !== ref.sha256) fail(code, `${label} snapshot bytes drifted`);
  return bytes;
}

export function validateM6QualificationLegacyPrestate(prestate, {
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  baseRoot = join(runtimeRoot, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME),
} = {}) {
  const code = "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID";
  if (!exactObject(prestate, [
    "boundary", "current", "legacyRelease", "legacyRuntime", "modules", "processes", "resources", "runtimeRoot",
    "schemaId", "targetRelease", "task", "trustedNode",
  ]) || prestate.schemaId !== M6_QUALIFICATION_LEGACY_WINDOW_PRESTATE_SCHEMA_ID
    || !samePath(prestate.runtimeRoot, runtimeRoot)
    || !exactObject(prestate.targetRelease, ["operatorSha256", "releaseId", "sourceCommit"])
    || prestate.targetRelease.releaseId !== expectedReleaseId
    || prestate.targetRelease.sourceCommit !== expectedSourceCommit
    || !HEX64.test(prestate.targetRelease.operatorSha256 || "")
    || !exactObject(prestate.legacyRelease, ["manifestPath", "manifestSha256", "releaseId", "root", "sourceCommit"])
    || !RELEASE_ID.test(prestate.legacyRelease.releaseId || "")
    || !HEX40.test(prestate.legacyRelease.sourceCommit || "")
    || !HEX64.test(prestate.legacyRelease.manifestSha256 || "")
    || !samePath(prestate.legacyRelease.root, join(runtimeRoot, "releases", prestate.legacyRelease.releaseId))
    || !samePath(prestate.legacyRelease.manifestPath, join(prestate.legacyRelease.root, "release-manifest.v1.json"))) {
    fail(code, "prestate exact identity/schema drifted");
  }
  if (!exactObject(prestate.current, ["path", "snapshot", "target"])
    || !samePath(prestate.current.path, join(runtimeRoot, "current"))
    || !samePath(prestate.current.target, prestate.legacyRelease.root)
    || !exactObject(prestate.task, ["name", "state", "xml"])
    || prestate.task.name !== FORMAL_CONTROL_PLANE_TASK_NAME
    || !["READY", "RUNNING"].includes(prestate.task.state)
    || !exactObject(prestate.processes, ["snapshot"])
    || !exactObject(prestate.legacyRuntime, ["caller", "launchers", "ownerLock"])
    || !exactObject(prestate.legacyRuntime.ownerLock, ["path", "pid", "sha256"])
    || !samePath(prestate.legacyRuntime.ownerLock.path, m6C1RuntimeOwnerLockPath(runtimeRoot))
    || !Number.isSafeInteger(prestate.legacyRuntime.ownerLock.pid)
    || prestate.legacyRuntime.ownerLock.pid < 4
    || !HEX64.test(prestate.legacyRuntime.ownerLock.sha256 || "")
    || !exactObject(prestate.legacyRuntime.caller, ["sessionId", "sidSha256"])
    || !Number.isSafeInteger(prestate.legacyRuntime.caller.sessionId)
    || prestate.legacyRuntime.caller.sessionId < 0
    || !HEX64.test(prestate.legacyRuntime.caller.sidSha256 || "")
    || !exactObject(prestate.legacyRuntime.launchers, ["controlPlane", "registry"])
    || !exactObject(prestate.boundary, ["checkpointHash", "kind", "ownerRecoveryHash"])
    || prestate.boundary.kind !== "STOPPED"
    || !HEX64.test(prestate.boundary.checkpointHash || "")
    || !HEX64.test(prestate.boundary.ownerRecoveryHash || "")
    || !exactObject(prestate.resources, [
      "controlDb", "privateMaterial", "qualificationBinding", "registryDb",
    ])
    || !Array.isArray(prestate.resources.privateMaterial)
    || prestate.resources.privateMaterial.length !== 2) {
    fail(code, "current/task/process/resource prestate drifted");
  }
  for (const target of LEGACY_LAUNCHER_TARGETS) {
    const ref = prestate.legacyRuntime.launchers[target.key];
    const expectedPath = join(runtimeRoot, target.filename);
    if (!exactObject(ref, ["key", "path", "sha256"])
      || ref.key !== target.key || !samePath(ref.path, expectedPath)
      || !HEX64.test(ref.sha256 || "")
      || sha256(readPlainBytes(expectedPath, code, `${target.key} launcher`, 1024 * 1024))
        !== ref.sha256) {
      fail(code, "sealed legacy launcher identity drifted");
    }
  }
  if (!exactObject(prestate.trustedNode, ["path", "sha256", "version"])
    || !samePath(prestate.trustedNode.path, TRUSTED_NODE_EXECUTABLE)
    || !HEX64.test(prestate.trustedNode.sha256 || "")
    || typeof prestate.trustedNode.version !== "string" || prestate.trustedNode.version === ""
    || !exactObject(prestate.modules, ["controlPlane", "registry"])) {
    fail(code, "trusted Node/module prestate drifted");
  }
  for (const [key, releasePath] of [
    ["controlPlane", CONTROL_MODULE_RELEASE_PATH],
    ["registry", REGISTRY_MODULE_RELEASE_PATH],
  ]) {
    const module = prestate.modules[key];
    const expectedPath = join(prestate.legacyRelease.root, ...releasePath.split("/"));
    if (!exactObject(module, ["path", "sha256"])
      || !samePath(module.path, expectedPath) || !HEX64.test(module.sha256 || "")
      || sha256(readPlainBytes(module.path, code, `${key} module`, 256 * 1024 * 1024)) !== module.sha256) {
      fail(code, `${key} module prestate drifted`);
    }
  }
  const currentBytes = validateArtifactRef(prestate.current.snapshot, {
    base: baseRoot,
    code,
    label: "current prestate",
  });
  const currentValue = parseJsonBytes(currentBytes, code, "current prestate");
  if (!currentBytes.equals(canonicalJsonBytes(currentValue))
    || !exactObject(currentValue, ["path", "releaseId", "schemaId", "sourceCommit", "target"])
    || currentValue.schemaId !== "xw.runtime.m6-qualification-legacy-current-prestate.v1"
    || !samePath(currentValue.path, prestate.current.path)
    || !samePath(currentValue.target, prestate.current.target)
    || currentValue.releaseId !== prestate.legacyRelease.releaseId
    || currentValue.sourceCommit !== prestate.legacyRelease.sourceCommit) {
    fail(code, "current snapshot content drifted");
  }
  const taskBytes = validateArtifactRef(prestate.task.xml, { base: baseRoot, code, label: "task XML" });
  let taskDefinition;
  try { taskDefinition = parseLegacyTaskDefinition(taskBytes.toString("utf8")); }
  catch { fail(code, "sealed task XML is invalid"); }
  if (taskDefinition.principal !== "SYSTEM" || taskDefinition.enabled !== true) {
    fail(code, "sealed task XML lost SYSTEM/enabled identity");
  }
  const processBytes = validateArtifactRef(prestate.processes.snapshot, {
    base: baseRoot,
    code,
    label: "process prestate",
  });
  const processValue = parseJsonBytes(processBytes, code, "process prestate");
  if (!processBytes.equals(canonicalJsonBytes(processValue))
    || !exactObject(processValue, ["listeners", "releaseId", "schemaId", "sourceCommit"])
    || processValue.schemaId !== "xw.runtime.m6-qualification-legacy-process-prestate.v2"
    || processValue.releaseId !== prestate.legacyRelease.releaseId
    || processValue.sourceCommit !== prestate.legacyRelease.sourceCommit
    || !Array.isArray(processValue.listeners) || processValue.listeners.length !== 2) {
    fail(code, "process snapshot content drifted");
  }
  for (const [index, port] of FIXED_PORTS.entries()) {
    const row = processValue.listeners[index];
    const expectedModule = port === 17920 ? prestate.modules.controlPlane : prestate.modules.registry;
    if (!exactObject(row, [
      "createdAt", "executablePath", "launcherKey", "launcherPath", "launcherSha256", "modulePath",
      "localAddresses", "moduleSha256", "parentCreatedAt", "parentExecutablePath", "parentPid",
      "parentSessionId", "parentSidSha256", "pid", "port", "sessionId", "sidSha256",
    ]) || row.port !== port || !Number.isSafeInteger(row.pid) || row.pid < 4
      || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
      || typeof row.createdAt !== "string" || row.createdAt === ""
      || typeof row.parentCreatedAt !== "string" || row.parentCreatedAt === ""
      || !samePath(row.parentExecutablePath, WINDOWS_POWERSHELL_EXECUTABLE)
      || row.parentSessionId !== prestate.legacyRuntime.caller.sessionId
      || row.parentSidSha256 !== prestate.legacyRuntime.caller.sidSha256
      || row.sessionId !== prestate.legacyRuntime.caller.sessionId
      || row.sidSha256 !== prestate.legacyRuntime.caller.sidSha256
      || !Array.isArray(row.localAddresses) || row.localAddresses.length === 0
      || row.localAddresses.length > 8
      || row.localAddresses.some((address) => typeof address !== "string" || isIP(address) === 0)
      || JSON.stringify(row.localAddresses) !== JSON.stringify([...new Set(row.localAddresses)].sort())
      || !samePath(row.executablePath, prestate.trustedNode.path)
      || !samePath(row.modulePath, expectedModule.path)
      || row.moduleSha256 !== expectedModule.sha256
      || row.launcherKey !== (port === 17920 ? "controlPlane" : "registry")
      || !samePath(row.launcherPath, prestate.legacyRuntime.launchers[row.launcherKey].path)
      || row.launcherSha256 !== prestate.legacyRuntime.launchers[row.launcherKey].sha256) {
      fail(code, "process snapshot listener identity drifted");
    }
  }
  if (processValue.listeners[0].parentPid === processValue.listeners[1].parentPid
    || prestate.legacyRuntime.ownerLock.pid !== processValue.listeners[0].pid) {
    fail(code, "legacy runtime launch topology drifted after sealing");
  }
  validateArtifactRef(prestate.resources.controlDb, {
    base: baseRoot,
    expectedPath: join(runtimeRoot, ...DB_TARGETS[0].path),
    code,
    label: "control DB",
  });
  validateArtifactRef(prestate.resources.registryDb, {
    base: baseRoot,
    expectedPath: join(runtimeRoot, ...DB_TARGETS[1].path),
    code,
    label: "registry DB",
  });
  const qualificationBindingPath = join(runtimeRoot, ...QUALIFICATION_BINDING_TARGET.path);
  const qualificationBinding = prestate.resources.qualificationBinding;
  if (qualificationBinding?.present === false) {
    if (!exactObject(qualificationBinding, ["present", "targetPath"])
      || !samePath(qualificationBinding.targetPath, qualificationBindingPath)) {
      fail(code, "absent qualification binding prestate escaped its fixed target");
    }
  } else {
    if (!exactObject(qualificationBinding, ["path", "present", "sha256", "targetPath"])
      || qualificationBinding.present !== true) {
      fail(code, "qualification binding prestate schema drifted");
    }
    validateArtifactRef({
      path: qualificationBinding.path,
      sha256: qualificationBinding.sha256,
      targetPath: qualificationBinding.targetPath,
    }, {
      base: baseRoot,
      expectedPath: qualificationBindingPath,
      code,
      label: "qualification binding",
    });
  }
  for (let index = 0; index < PRIVATE_TARGETS.length; index += 1) {
    validateArtifactRef(prestate.resources.privateMaterial[index], {
      base: baseRoot,
      expectedPath: join(runtimeRoot, ...PRIVATE_TARGETS[index].path),
      code,
      label: PRIVATE_TARGETS[index].key,
    });
  }
  const manifestBytes = readPlainBytes(
    prestate.legacyRelease.manifestPath,
    code,
    "legacy manifest",
    64 * 1024 * 1024,
  );
  if (sha256(manifestBytes) !== prestate.legacyRelease.manifestSha256) {
    fail(code, "legacy release manifest drifted after sealing");
  }
  return prestate;
}

function loadSealedPrestate({ runtimeRoot, expectedReleaseId, expectedSourceCommit, tcbAclController }) {
  const code = "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID";
  const base = join(runtimeRoot, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME);
  const referencePath = join(
    base,
    "by-release",
    expectedReleaseId,
    expectedSourceCommit,
    "window-reference.v2.json",
  );
  verifyTcb(tcbAclController, runtimeRoot, referencePath, false, code);
  const reference = readCanonicalJson(referencePath, code, "window reference").value;
  if (!exactObject(reference, ["legacyRelease", "prestate", "schemaId", "targetRelease"])
    || reference.schemaId !== M6_QUALIFICATION_LEGACY_WINDOW_REFERENCE_SCHEMA_ID
    || !exactObject(reference.targetRelease, ["releaseId", "sourceCommit"])
    || reference.targetRelease.releaseId !== expectedReleaseId
    || reference.targetRelease.sourceCommit !== expectedSourceCommit
    || !exactObject(reference.legacyRelease, ["releaseId", "sourceCommit"])) {
    fail(code, "window reference exact identity drifted");
  }
  const bytes = validateArtifactRef(reference.prestate, {
    base,
    code,
    label: "window prestate",
  });
  const prestate = parseJsonBytes(bytes, code, "window prestate");
  if (!bytes.equals(canonicalJsonBytes(prestate))) fail(code, "window prestate is not canonical JSON");
  validateM6QualificationLegacyPrestate(prestate, {
    runtimeRoot,
    expectedReleaseId,
    expectedSourceCommit,
    baseRoot: base,
  });
  for (const target of LEGACY_LAUNCHER_TARGETS) {
    verifyTcb(
      tcbAclController,
      runtimeRoot,
      prestate.legacyRuntime.launchers[target.key].path,
      false,
      code,
    );
  }
  return Object.freeze({ referencePath, reference, prestate });
}

function safeWindowsEnvironment(extra = {}) {
  // PATHEXT is required for native executables (e.g. taskkill.exe) to report
  // $LASTEXITCODE under a stripped environment; without it PowerShell launches
  // the process but leaves $LASTEXITCODE null, which fails closed on receipt checks.
  return Object.freeze({
    SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    ...extra,
  });
}

function sameOpenFileIdentity(left, right) {
  return String(left?.dev) === String(right?.dev)
    && String(left?.ino) === String(right?.ino)
    && String(left?.mode) === String(right?.mode)
    && String(left?.nlink) === String(right?.nlink)
    && String(left?.size) === String(right?.size)
    && String(left?.mtimeNs ?? left?.mtimeMs) === String(right?.mtimeNs ?? right?.mtimeMs);
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function archiveStaleLegacyOwnerLock({
  runtimeRoot,
  expected,
  publisher,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_LEGACY_OWNER_LOCK_RECOVERY_INVALID";
  const path = m6C1RuntimeOwnerLockPath(runtimeRoot);
  if (!exactObject(expected, ["path", "pid", "sha256"])
    || !samePath(expected.path, path)
    || !Number.isSafeInteger(expected.pid) || expected.pid < 4
    || !HEX64.test(expected.sha256 || "")
    || !samePath(publisher?.base, join(runtimeRoot, M6_QUALIFICATION_LEGACY_WINDOW_ROOT_NAME))) {
    fail(code, "sealed owner-lock recovery input is invalid");
  }
  const archivePath = join(
    publisher.base,
    "stale-owner-locks",
    expected.sha256,
    "m6-c1-runtime-owner-lock.v1.json",
  );
  const validateBytes = (bytes) => {
    if (sha256(bytes) !== expected.sha256) fail(code, "runtime owner lock hash changed after sealing");
    const value = parseJsonBytes(bytes, code, "runtime owner lock");
    if (!bytes.equals(canonicalJsonBytes(value))
      || !exactObject(value, [
        "acquiredAt", "ownerKind", "ownerNonce", "pid", "schemaId", "secretMaterialPresent",
      ])
      || value.schemaId !== "xw.m6-c1-runtime-owner-lock.v1"
      || value.pid !== expected.pid || value.ownerKind !== "CONTROL_PLANE_M6_C1"
      || value.secretMaterialPresent !== false) {
      fail(code, "runtime owner lock no longer matches the sealed control-plane owner");
    }
    return value;
  };
  const sourceExists = existsSync(path);
  const archiveExists = existsSync(archivePath);
  if (sourceExists && archiveExists) {
    fail(code, "source owner lock and its sealed archive must never coexist");
  }
  if (!sourceExists) {
    if (!archiveExists) fail(code, "sealed owner lock is absent without its exact archive");
    verifyTcb(tcbAclController, runtimeRoot, archivePath, false, code);
    const bytes = readPlainBytes(archivePath, code, "archived runtime owner lock", 64 * 1024);
    validateBytes(bytes);
    return Object.freeze({
      status: "REPLAYED",
      artifact: Object.freeze({ path: archivePath, sha256: expected.sha256 }),
    });
  }
  verifyTcb(tcbAclController, runtimeRoot, path, false, code);
  let fd;
  try {
    fd = openSync(path, "r");
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n
      || !sameOpenFileIdentity(opened, named)) {
      fail(code, "runtime owner lock is not one stable single-link file");
    }
    const bytes = readFileSync(fd);
    validateBytes(bytes);
    if (processIsAlive(expected.pid)) fail(code, "sealed control-plane owner PID is still alive");
    if (!existsSync(dirname(archivePath))) mkdirSync(dirname(archivePath), { recursive: true });
    assertPlainDirectory(dirname(archivePath), code, "stale owner-lock archive directory");
    protectTcb(tcbAclController, runtimeRoot, dirname(archivePath), false, code);
    const descriptorAfter = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameOpenFileIdentity(opened, descriptorAfter)
      || !sameOpenFileIdentity(descriptorAfter, pathAfter)) {
      fail(code, "runtime owner lock changed before atomic quarantine");
    }
    renameSync(path, archivePath);
    if (existsSync(path) || !existsSync(archivePath)) {
      fail(code, "atomic owner-lock quarantine did not remove the source name");
    }
    const archiveStat = lstatSync(archivePath, { bigint: true });
    const descriptorFinal = fstatSync(fd, { bigint: true });
    if (!sameOpenFileIdentity(opened, descriptorFinal)
      || !sameOpenFileIdentity(descriptorFinal, archiveStat)) {
      fail(code, "quarantined owner-lock identity differs from the opened source");
    }
    protectTcb(tcbAclController, runtimeRoot, archivePath, false, code);
    const readback = readPlainBytes(archivePath, code, "quarantined runtime owner lock", 64 * 1024);
    if (!readback.equals(bytes)) fail(code, "quarantined owner-lock readback changed");
    validateBytes(readback);
    return Object.freeze({
      status: "ARCHIVED",
      artifact: Object.freeze({ path: archivePath, sha256: expected.sha256 }),
    });
  } catch (cause) {
    if (cause?.code === code) throw cause;
    fail(code, "stale runtime owner lock could not be archived safely");
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch {}
  }
}

function exactQuickCheck(row) {
  return row && typeof row === "object" && !Array.isArray(row)
    && Object.keys(row).length === 1 && Object.values(row)[0] === "ok";
}

export function checkpointM6QualificationLegacyDatabases({
  runtimeRoot,
  tcbAclController = createSystemTcbAclController(),
}) {
  const code = "M6_QUALIFICATION_LEGACY_WAL_CHECKPOINT_FAILED";
  const rows = [];
  for (const target of DB_TARGETS) {
    const path = join(runtimeRoot, ...target.path);
    const initial = assertPlainFile(path, code, target.key);
    verifyTcb(tcbAclController, runtimeRoot, path, false, code);
    let database;
    try {
      database = new DatabaseSync(path, { allowExtension: false });
      database.exec("PRAGMA busy_timeout=5000");
      const before = database.prepare("PRAGMA quick_check").get();
      if (!exactQuickCheck(before)) {
        fail(code, `${target.key} failed its pre-checkpoint quick_check`);
      }
      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (!exactObject(checkpoint, ["busy", "checkpointed", "log"])
        || !Number.isSafeInteger(checkpoint.busy) || checkpoint.busy !== 0
        || !Number.isSafeInteger(checkpoint.log) || checkpoint.log < 0
        || !Number.isSafeInteger(checkpoint.checkpointed) || checkpoint.checkpointed < 0
        || checkpoint.checkpointed > checkpoint.log) {
        fail(code, `${target.key} WAL checkpoint receipt is invalid or remained busy`);
      }
      const after = database.prepare("PRAGMA quick_check").get();
      if (!exactQuickCheck(after)) {
        fail(code, `${target.key} failed its post-checkpoint quick_check`);
      }
      database.close();
      database = null;
      const final = assertPlainFile(path, code, target.key);
      if (String(initial.dev) !== String(final.dev) || String(initial.ino) !== String(final.ino)
        || initial.nlink !== final.nlink) {
        fail(code, `${target.key} main-file identity changed during checkpoint`);
      }
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${path}${suffix}`)) {
          fail(code, `${target.key} retained a WAL/SHM sidecar after checkpoint close`);
        }
      }
      verifyTcb(tcbAclController, runtimeRoot, path, false, code);
      rows.push(Object.freeze({
        key: target.key,
        busy: checkpoint.busy,
        log: checkpoint.log,
        checkpointed: checkpoint.checkpointed,
        databaseSha256: sha256(readPlainBytes(path, code, target.key, 1024 * 1024 * 1024)),
        quickCheck: "ok",
        sidecarsAbsent: true,
      }));
    } catch (cause) {
      if (cause?.code === code) throw cause;
      fail(code, `${target.key} WAL checkpoint failed closed`);
    } finally {
      try { database?.close(); } catch {}
    }
  }
  const body = Object.freeze({
    schemaId: "xw.runtime.m6-qualification-legacy-db-checkpoint.v1",
    rows: Object.freeze(rows),
  });
  return Object.freeze({ ...body, checkpointHash: sha256(domainCanonicalJson(body)) });
}

function runPowerShellJson(program, { env = {}, code, label }) {
  let raw;
  try {
    raw = execFileSync(WINDOWS_POWERSHELL_EXECUTABLE, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program,
    ], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      env: safeWindowsEnvironment(env),
    });
  } catch { fail(code, `${label} failed closed`); }
  try { return JSON.parse(raw); }
  catch { fail(code, `${label} returned malformed JSON`); }
}

async function fetchHealthJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    if (!response.ok) fail("M6_QUALIFICATION_LEGACY_HEALTH_INVALID", "fixed health endpoint failed");
    return await response.json();
  } catch (error) {
    if (error?.code === "M6_QUALIFICATION_LEGACY_HEALTH_INVALID") throw error;
    fail("M6_QUALIFICATION_LEGACY_HEALTH_INVALID", "fixed health endpoint is unavailable");
  } finally { clearTimeout(timer); }
}

export function createNativeM6QualificationLegacyWindowAdapter({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  if (!samePath(runtimeRoot, FORMAL_RUNTIME_ROOT)) {
    fail("M6_QUALIFICATION_LEGACY_RUNTIME_INVALID", "native window operations are fixed to the formal runtime root");
  }
  const inspectTask = () => runPowerShellJson(TASK_INSPECTION_PROGRAM, {
    env: { XW_LEGACY_TASK_NAME: FORMAL_CONTROL_PLANE_TASK_NAME },
    code: "M6_QUALIFICATION_LEGACY_TASK_INVALID",
    label: "fixed task inspection",
  });
  const inspectFixedTask = (taskName) => {
    if (![...FINAL_TASK_NAMES, QUALIFICATION_TASK_NAME].includes(taskName)) {
      fail("M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID", "task inspection escaped the fixed relay set");
    }
    return runPowerShellJson(TASK_INSPECTION_PROGRAM, {
      env: { XW_LEGACY_TASK_NAME: taskName },
      code: "M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID",
      label: "fixed relay task inspection",
    });
  };
  const inspectListeners = ({ modules, trustedNode, launchers = inspectLegacyLaunchers({ runtimeRoot }) }) => runPowerShellJson(LISTENER_INSPECTION_PROGRAM, {
    env: {
      XW_LEGACY_CP_MODULE: modules.controlPlane.path,
      XW_LEGACY_CP_MODULE_ALIAS: join(runtimeRoot, "current", ...CONTROL_MODULE_RELEASE_PATH.split("/")),
      XW_LEGACY_REGISTRY_MODULE: modules.registry.path,
      XW_LEGACY_REGISTRY_MODULE_ALIAS: join(runtimeRoot, "current", ...REGISTRY_MODULE_RELEASE_PATH.split("/")),
      XW_LEGACY_TRUSTED_NODE: trustedNode.path,
      XW_LEGACY_CP_LAUNCHER: launchers.controlPlane.path,
      XW_LEGACY_REGISTRY_LAUNCHER: launchers.registry.path,
      XW_LEGACY_POWERSHELL: WINDOWS_POWERSHELL_EXECUTABLE,
      XW_LEGACY_RUNTIME_ROOT: runtimeRoot,
    },
    code: "M6_QUALIFICATION_LEGACY_LISTENER_INVALID",
    label: "fixed listener inspection",
  });
  const schtasks = (args, tolerateFailure = false) => {
    try {
      return execFileSync("schtasks.exe", args, {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        env: safeWindowsEnvironment(),
      });
    } catch {
      if (tolerateFailure) return "";
      fail("M6_QUALIFICATION_LEGACY_TASK_MUTATION_FAILED", "fixed Scheduled Task operation failed");
    }
  };
  return Object.freeze({
    inspectTask,
    inspectFixedTask,
    async inspectOwnerLock({ expectedPid = null, allowAbsent = false } = {}) {
      return inspectLegacyRuntimeOwnerLock({ runtimeRoot, expectedPid, allowAbsent });
    },
    async inspectLaunchers() {
      return inspectLegacyLaunchers({ runtimeRoot });
    },
    async inspectCaller() {
      return runPowerShellJson(CALLER_INSPECTION_PROGRAM, {
        code: "M6_QUALIFICATION_LEGACY_CALLER_INVALID",
        label: "fixed current-user caller inspection",
      });
    },
    async inspectQualificationTask() {
      return inspectFixedTask(QUALIFICATION_TASK_NAME);
    },
    inspectListeners,
    async inspectHealth() {
      const [controlPlane, registry] = await Promise.all([
        fetchHealthJson(M6_QUALIFICATION_CONTROL_HEALTH_URL),
        fetchHealthJson(M6_QUALIFICATION_REGISTRY_HEALTH_URL),
      ]);
      return Object.freeze({ controlPlane, registry });
    },
    async endTask() {
      schtasks(["/End", "/TN", FORMAL_CONTROL_PLANE_TASK_NAME], true);
    },
    async terminateVerifiedProcess(row) {
      const value = runPowerShellJson(TERMINATE_VERIFIED_PROCESS_PROGRAM, {
        env: {
          XW_LEGACY_PID: String(row.pid),
          XW_LEGACY_CREATED_AT: row.createdAt,
          XW_LEGACY_MODULE: row.modulePath,
          XW_LEGACY_MODULE_ALIAS: join(
            runtimeRoot,
            "current",
            ...(row.port === 17920 ? CONTROL_MODULE_RELEASE_PATH : REGISTRY_MODULE_RELEASE_PATH).split("/"),
          ),
          XW_LEGACY_TRUSTED_NODE: row.executablePath,
          XW_LEGACY_TASKKILL: WINDOWS_TASKKILL_EXECUTABLE,
        },
        code: "M6_QUALIFICATION_LEGACY_PROCESS_STOP_FAILED",
        label: "verified listener process-tree termination",
      });
      if (!exactObject(value, ["status"]) || !["already-exited", "terminated"].includes(value.status)) {
        fail("M6_QUALIFICATION_LEGACY_PROCESS_STOP_FAILED", "process-tree termination receipt is invalid");
      }
      return value.status;
    },
    async assertWalSafe() {
      for (const row of DB_TARGETS) {
        const path = join(runtimeRoot, ...row.path);
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(`${path}${suffix}`)) {
            fail("M6_QUALIFICATION_LEGACY_WAL_UNSAFE", "SQLite WAL/SHM sidecar remains after quiescence");
          }
        }
      }
    },
    async archiveStaleOwnerLock({ expected, publisher }) {
      return archiveStaleLegacyOwnerLock({
        runtimeRoot,
        expected,
        publisher,
        tcbAclController,
      });
    },
    async checkpointDatabases() {
      return checkpointM6QualificationLegacyDatabases({ runtimeRoot, tcbAclController });
    },
    async acquireStoppedGuard({ beforeOwner }) {
      return acquireM6C1StoppedRuntimeGuard({
        runtimeRoot,
        ownerKind: "QUALIFICATION_LEGACY_WINDOW",
        hosts: ["0.0.0.0", "::"],
        ports: FIXED_PORTS,
        beforeOwner,
      });
    },
    async inspectCurrent() {
      const path = join(runtimeRoot, "current");
      let stat;
      try { stat = lstatSync(path); } catch { return null; }
      return stat.isSymbolicLink() ? realpathSync(path) : null;
    },
    async restoreCurrent(target) {
      replaceCurrentJunction({ runtimeRoot, targetPath: target });
    },
    async switchCurrent(target) {
      replaceCurrentJunction({ runtimeRoot, targetPath: target });
    },
    async runLauncher(ref, caller) {
      const code = "M6_QUALIFICATION_LEGACY_LAUNCHER_INVALID";
      const target = LEGACY_LAUNCHER_TARGETS.find((row) => row.key === ref?.key);
      const expectedPath = target ? join(runtimeRoot, target.filename) : "";
      const actualCaller = runPowerShellJson(CALLER_INSPECTION_PROGRAM, {
        code: "M6_QUALIFICATION_LEGACY_CALLER_INVALID",
        label: "fixed current-user caller inspection",
      });
      if (!target || !exactObject(ref, ["key", "path", "sha256"])
        || !samePath(ref.path, expectedPath) || !HEX64.test(ref.sha256 || "")
        || !exactObject(caller, ["sessionId", "sidSha256"])
        || domainCanonicalJson(actualCaller) !== domainCanonicalJson(caller)
        || sha256(readPlainBytes(expectedPath, code, `${target.key} legacy launcher`, 1024 * 1024))
          !== ref.sha256) {
        fail(code, "sealed legacy launcher or caller drifted before restart");
      }
      verifyTcb(tcbAclController, runtimeRoot, expectedPath, false, code);
      let child;
      try {
        child = spawn(WINDOWS_POWERSHELL_EXECUTABLE, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", expectedPath,
        ], {
          cwd: runtimeRoot,
          detached: true,
          env: safeWindowsEnvironment(),
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      } catch { fail(code, "sealed legacy registry launcher could not be started"); }
      if (!Number.isSafeInteger(child.pid) || child.pid < 4) {
        fail(code, "legacy launcher returned no stable parent PID");
      }
      return Object.freeze({ key: target.key, parentPid: child.pid, started: true });
    },
    async restoreFile(ref) {
      const allowed = new Set([
        ...DB_TARGETS,
        ...PRIVATE_TARGETS,
        QUALIFICATION_BINDING_TARGET,
      ].map((row) => pathKey(join(runtimeRoot, ...row.path))));
      if (!allowed.has(pathKey(ref.targetPath))) {
        fail("M6_QUALIFICATION_LEGACY_RESTORE_INVALID", "snapshot restore target escaped the fixed set");
      }
      if (ref.present === false) {
        protectTcb(
          tcbAclController,
          runtimeRoot,
          dirname(ref.targetPath),
          false,
          "M6_QUALIFICATION_LEGACY_RESTORE_INVALID",
        );
        if (existsSync(ref.targetPath)) rmSync(ref.targetPath, { force: true });
        if (existsSync(ref.targetPath)) {
          fail("M6_QUALIFICATION_LEGACY_RESTORE_INVALID", "absent qualification binding could not be restored");
        }
        protectTcb(
          tcbAclController,
          runtimeRoot,
          dirname(ref.targetPath),
          false,
          "M6_QUALIFICATION_LEGACY_RESTORE_INVALID",
        );
        return;
      }
      const bytes = readPlainBytes(ref.path, "M6_QUALIFICATION_LEGACY_RESTORE_INVALID", "snapshot", 1024 * 1024 * 1024);
      if (sha256(bytes) !== ref.sha256) fail("M6_QUALIFICATION_LEGACY_RESTORE_INVALID", "snapshot bytes drifted");
      replaceFileWithBackup({
        targetPath: ref.targetPath,
        bytes,
        beforeInstall: (path) => protectTcb(
          tcbAclController,
          runtimeRoot,
          path,
          false,
          "M6_QUALIFICATION_LEGACY_RESTORE_INVALID",
        ),
        afterInstall: (path) => protectTcb(
          tcbAclController,
          runtimeRoot,
          path,
          false,
          "M6_QUALIFICATION_LEGACY_RESTORE_INVALID",
        ),
      });
      const restored = readPlainBytes(
        ref.targetPath,
        "M6_QUALIFICATION_LEGACY_RESTORE_INVALID",
        "restored snapshot",
        1024 * 1024 * 1024,
      );
      if (sha256(restored) !== ref.sha256 || !restored.equals(bytes)) {
        fail("M6_QUALIFICATION_LEGACY_RESTORE_INVALID", "restored snapshot failed exact hash readback");
      }
    },
    async registerTaskXml(xmlPath) {
      schtasks(["/Create", "/TN", FORMAL_CONTROL_PLANE_TASK_NAME, "/XML", xmlPath, "/F"]);
    },
    async runTask() {
      schtasks(["/Run", "/TN", FORMAL_CONTROL_PLANE_TASK_NAME]);
    },
    async cleanupFinalTasks() {
      for (const taskName of [...FINAL_TASK_NAMES].reverse()) {
        schtasks(["/End", "/TN", taskName], true);
        schtasks(["/Delete", "/TN", taskName, "/F"], true);
      }
      for (const taskName of FINAL_TASK_NAMES) {
        const inspection = inspectFixedTask(taskName);
        if (inspection?.exists !== false || inspection?.state !== "ABSENT") {
          fail("M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID", "FINAL task cleanup was not proven absent");
        }
      }
    },
    async restoreRelaySlot(ref) {
      const allowed = new Set(FINAL_RUNTIME_SLOT_PATHS.map((parts) => pathKey(join(runtimeRoot, ...parts))));
      if (!allowed.has(pathKey(ref?.targetPath || "")) || typeof ref?.present !== "boolean") {
        fail("M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INVALID", "relay slot restore escaped the fixed set");
      }
      if (!ref.present) {
        if (existsSync(ref.targetPath)) rmSync(ref.targetPath, { force: true });
        return;
      }
      const bytes = readPlainBytes(
        ref.path,
        "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INVALID",
        "sealed relay runtime slot",
        64 * 1024 * 1024,
      );
      if (sha256(bytes) !== ref.sha256) {
        fail("M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INVALID", "sealed relay runtime slot drifted");
      }
      replaceFileWithBackup({
        targetPath: ref.targetPath,
        bytes,
        beforeInstall: (path) => protectTcb(
          tcbAclController,
          runtimeRoot,
          path,
          false,
          "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INVALID",
        ),
        afterInstall: (path) => protectTcb(
          tcbAclController,
          runtimeRoot,
          path,
          false,
          "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INVALID",
        ),
      });
    },
    async registerFixedTaskXml(taskName, xmlPath) {
      if (!FINAL_TASK_NAMES.includes(taskName) || !isAbsolute(xmlPath)) {
        fail("M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID", "task restore escaped the fixed relay set");
      }
      schtasks(["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    },
  });
}

function assertAdapter(adapter) {
  const methods = [
    "acquireStoppedGuard", "archiveStaleOwnerLock", "assertWalSafe", "checkpointDatabases", "endTask",
    "inspectCaller", "inspectCurrent", "inspectHealth", "inspectLaunchers", "inspectListeners",
    "inspectOwnerLock", "inspectTask", "registerTaskXml", "restoreCurrent", "restoreFile", "runLauncher",
    "switchCurrent", "terminateVerifiedProcess",
  ];
  if (methods.some((name) => typeof adapter?.[name] !== "function")) {
    fail("M6_QUALIFICATION_LEGACY_DEPENDENCY_INVALID", "window adapter is incomplete");
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitFor({ probe, predicate, timeoutMs, pollMs, delayFn, code, message }) {
  const started = Date.now();
  while (true) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() - started >= timeoutMs) fail(code, message);
    await delayFn(pollMs);
  }
}

function normalizeOwnerRecoveryEvidence(value, publisher) {
  const code = "M6_QUALIFICATION_LEGACY_OWNER_LOCK_RECOVERY_INVALID";
  if (!exactObject(value, ["artifact", "status"])
    || !["ARCHIVED", "REPLAYED"].includes(value.status)
    || !exactObject(value.artifact, ["path", "sha256"])
    || !HEX64.test(value.artifact.sha256 || "")
    || !within(join(publisher.base, "stale-owner-locks"), value.artifact.path)) {
    fail(code, "owner-lock recovery did not return one sealed archive identity");
  }
  const body = Object.freeze({
    schemaId: "xw.runtime.m6-qualification-legacy-owner-recovery.v1",
    status: value.status,
    archiveSha256: value.artifact.sha256,
  });
  return Object.freeze({ ...body, ownerRecoveryHash: sha256(domainCanonicalJson(body)) });
}

function normalizeCheckpointEvidence(value) {
  const code = "M6_QUALIFICATION_LEGACY_WAL_CHECKPOINT_FAILED";
  if (!exactObject(value, ["checkpointHash", "rows", "schemaId"])
    || value.schemaId !== "xw.runtime.m6-qualification-legacy-db-checkpoint.v1"
    || !Array.isArray(value.rows) || value.rows.length !== DB_TARGETS.length) {
    fail(code, "database checkpoint evidence schema drifted");
  }
  for (const [index, target] of DB_TARGETS.entries()) {
    const row = value.rows[index];
    if (!exactObject(row, [
      "busy", "checkpointed", "databaseSha256", "key", "log", "quickCheck", "sidecarsAbsent",
    ]) || row.key !== target.key || row.busy !== 0
      || !Number.isSafeInteger(row.log) || row.log < 0
      || !Number.isSafeInteger(row.checkpointed) || row.checkpointed < 0
      || row.checkpointed > row.log || !HEX64.test(row.databaseSha256 || "")
      || row.quickCheck !== "ok" || row.sidecarsAbsent !== true) {
      fail(code, "database checkpoint evidence row drifted");
    }
  }
  const body = Object.freeze({ schemaId: value.schemaId, rows: value.rows });
  if (!HEX64.test(value.checkpointHash || "")
    || value.checkpointHash !== sha256(domainCanonicalJson(body))) {
    fail(code, "database checkpoint evidence hash is not reproducible");
  }
  return Object.freeze({ ...body, checkpointHash: value.checkpointHash });
}

function stoppedBoundary(settlement) {
  return Object.freeze({
    kind: "STOPPED",
    ownerRecoveryHash: settlement.ownerRecovery.ownerRecoveryHash,
    checkpointHash: settlement.checkpoint.checkpointHash,
  });
}

function publicReceipt({
  operation,
  plan,
  prestateArtifact,
  outcome,
  boundary,
  autoRestore = null,
}) {
  return Object.freeze({
    schemaId: M6_QUALIFICATION_LEGACY_WINDOW_RECEIPT_SCHEMA_ID,
    operation,
    outcome,
    targetRelease: Object.freeze({
      releaseId: plan.targetRelease.releaseId,
      sourceCommit: plan.targetRelease.sourceCommit,
    }),
    legacyRelease: Object.freeze({
      releaseId: plan.legacyRelease.releaseId,
      sourceCommit: plan.legacyRelease.sourceCommit,
    }),
    prestateSha256: prestateArtifact.sha256,
    boundary: Object.freeze({ ...boundary }),
    listeners: Object.freeze(FIXED_PORTS.map((port) => Object.freeze({ port, state: outcome === "QUIESCED" ? "ABSENT" : "ACTIVE" }))),
    ...(autoRestore === null ? {} : { autoRestore }),
  });
}

function exactListenerIdentity(left, right) {
  return domainCanonicalJson(left) === domainCanonicalJson(right);
}

function hasSealedListenerAddresses(actual, sealed) {
  return actual?.port === sealed?.port
    && domainCanonicalJson(actual.localAddresses) === domainCanonicalJson(sealed.localAddresses);
}

function readSealedListeners(prestate, code = "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID") {
  const bytes = readPlainBytes(prestate.processes.snapshot.path, code, "sealed process prestate", 4 * 1024 * 1024);
  if (sha256(bytes) !== prestate.processes.snapshot.sha256) fail(code, "sealed process prestate hash drifted");
  const value = parseJsonBytes(bytes, code, "sealed process prestate");
  if (!bytes.equals(canonicalJsonBytes(value)) || !Array.isArray(value.listeners)) {
    fail(code, "sealed process prestate content drifted");
  }
  return Object.freeze(value.listeners.map((row) => Object.freeze({ ...row })));
}

async function settleSealedLegacyRuntime({
  modules,
  trustedNode,
  ownerLock,
  launchers,
  caller,
  expectedListeners,
  adapter,
  publisher,
  delayFn,
  timeoutMs,
  pollMs,
}) {
  const task = await adapter.inspectTask();
  if (task?.exists === true && ["RUNNING", "QUEUED"].includes(task.state)) {
    await adapter.endTask();
    await waitFor({
      probe: () => adapter.inspectTask(),
      predicate: (value) => value?.exists !== true || ["READY", "DISABLED"].includes(value.state),
      timeoutMs,
      pollMs,
      delayFn,
      code: "M6_QUALIFICATION_LEGACY_TASK_STOP_TIMEOUT",
      message: "fixed legacy task did not stop",
    });
  }
  const residual = normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
    modules,
    trustedNode,
    launchers,
  }), {
    modules, trustedNode, requireActive: false, allowPartial: true, launchers, caller,
  });
  if (residual.some((row) => !expectedListeners.some((expected) => exactListenerIdentity(row, expected)))) {
    fail(
      "M6_QUALIFICATION_LEGACY_LISTENER_DRIFT",
      "a residual listener is not an exact subset of the sealed legacy processes",
    );
  }
  for (const row of residual) await adapter.terminateVerifiedProcess(row);
  await waitFor({
    probe: () => adapter.inspectListeners({ modules, trustedNode, launchers }),
    predicate: (value) => {
      try {
        normalizeM6QualificationLegacyListeners(value, {
          modules,
          trustedNode,
          requireActive: false,
          launchers,
          caller,
        });
        return true;
      } catch { return false; }
    },
    timeoutMs,
    pollMs,
    delayFn,
    code: "M6_QUALIFICATION_LEGACY_LISTENER_STOP_TIMEOUT",
    message: "fixed legacy listener ports did not become empty",
  });
  let ownerRecovery = null;
  const guard = await adapter.acquireStoppedGuard({
    beforeOwner: async () => {
      ownerRecovery = normalizeOwnerRecoveryEvidence(
        await adapter.archiveStaleOwnerLock({ expected: ownerLock, publisher }),
        publisher,
      );
    },
  });
  try {
    await guard.assertOwned();
    if (ownerRecovery === null) {
      fail("M6_QUALIFICATION_LEGACY_OWNER_LOCK_RECOVERY_INVALID", "guard acquired without owner recovery");
    }
    const checkpoint = normalizeCheckpointEvidence(await adapter.checkpointDatabases());
    await adapter.assertWalSafe();
    await guard.assertOwned();
    return Object.freeze({ guard, ownerRecovery, checkpoint });
  } catch (cause) {
    try { await guard.release(); } catch {}
    throw cause;
  }
}

async function rollbackStartedLegacyLaunchers({
  starts,
  prestate,
  adapter,
  publisher,
  delayFn,
  timeoutMs,
  pollMs,
}) {
  const code = "M6_QUALIFICATION_LEGACY_LAUNCH_ROLLBACK_INCOMPLETE";
  const rows = normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
    modules: prestate.modules,
    trustedNode: prestate.trustedNode,
    launchers: prestate.legacyRuntime.launchers,
  }), {
    modules: prestate.modules,
    trustedNode: prestate.trustedNode,
    requireActive: false,
    allowPartial: true,
    launchers: prestate.legacyRuntime.launchers,
    caller: prestate.legacyRuntime.caller,
  });
  if (rows.some((row) => !starts.some((start) => (
    start.key === row.launcherKey && start.parentPid === row.parentPid
  )))) {
    fail(code, "launcher rollback observed a process not created by this restore attempt");
  }
  for (const row of rows) await adapter.terminateVerifiedProcess(row);
  await waitFor({
    probe: () => adapter.inspectListeners({
      modules: prestate.modules,
      trustedNode: prestate.trustedNode,
      launchers: prestate.legacyRuntime.launchers,
    }),
    predicate: (value) => {
      try {
        normalizeM6QualificationLegacyListeners(value, {
          modules: prestate.modules,
          trustedNode: prestate.trustedNode,
          requireActive: false,
          launchers: prestate.legacyRuntime.launchers,
          caller: prestate.legacyRuntime.caller,
        });
        return true;
      } catch { return false; }
    },
    timeoutMs,
    pollMs,
    delayFn,
    code,
    message: "started legacy listeners did not stop during rollback",
  });
  const staleOwner = await adapter.inspectOwnerLock({ allowAbsent: true });
  let recovery = null;
  const guard = await adapter.acquireStoppedGuard({
    beforeOwner: async () => {
      if (staleOwner !== null) {
        recovery = normalizeOwnerRecoveryEvidence(
          await adapter.archiveStaleOwnerLock({ expected: staleOwner, publisher }),
          publisher,
        );
      }
    },
  });
  try {
    await guard.assertOwned();
    normalizeCheckpointEvidence(await adapter.checkpointDatabases());
    await adapter.assertWalSafe();
    await guard.assertOwned();
    await guard.release();
    return Object.freeze({ stopped: true, ownerRecovery: recovery });
  } catch (cause) {
    try { await guard.release(); } catch {}
    throw cause;
  }
}

async function restoreFromPrestate({
  prestate,
  prestateArtifact,
  adapter,
  publisher,
  delayFn,
  timeoutMs,
  pollMs,
  resourcesAlreadyRestored = false,
}) {
  const expectedListeners = readSealedListeners(prestate);
  const settlement = await settleSealedLegacyRuntime({
    modules: prestate.modules,
    trustedNode: prestate.trustedNode,
    ownerLock: prestate.legacyRuntime.ownerLock,
    launchers: prestate.legacyRuntime.launchers,
    caller: prestate.legacyRuntime.caller,
    expectedListeners,
    adapter,
    publisher,
    delayFn,
    timeoutMs,
    pollMs,
  });
  let guardReleased = false;
  try {
    await settlement.guard.assertOwned();
    if (!resourcesAlreadyRestored) {
      const rows = await restoreLegacyResourceSet({ adapter, prestate });
      if (rows.some((row) => row.status !== "fulfilled")) {
        fail("M6_QUALIFICATION_LEGACY_RESTORE_FAILED", "one or more sealed legacy resources failed restore", { rows });
      }
    }
    await adapter.restoreCurrent(prestate.current.target);
    if (!samePath(await adapter.inspectCurrent(), prestate.current.target)) {
      fail("M6_QUALIFICATION_LEGACY_RESTORE_FAILED", "current junction did not restore exact legacy target");
    }
    await adapter.registerTaskXml(prestate.task.xml.path);
    const taskReady = await adapter.inspectTask();
    if (taskReady?.exists !== true || !["READY", "DISABLED"].includes(taskReady.state)
      || sha256(Buffer.from(taskReady.xml || "", "utf8")) !== prestate.task.xml.sha256) {
      fail("M6_QUALIFICATION_LEGACY_RESTORE_FAILED", "restored fixed task does not match sealed stopped XML");
    }
    await settlement.guard.assertOwned();
    await settlement.guard.release();
    guardReleased = true;
  } catch (cause) {
    if (!guardReleased) {
      try { await settlement.guard.release(); } catch {}
    }
    throw cause;
  }
  const starts = [];
  try {
    const controlStart = await adapter.runLauncher(
    prestate.legacyRuntime.launchers.controlPlane,
    prestate.legacyRuntime.caller,
    );
    starts.push(controlStart);
    await waitFor({
    probe: async () => {
      try {
        const rows = normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
          modules: prestate.modules,
          trustedNode: prestate.trustedNode,
          launchers: prestate.legacyRuntime.launchers,
        }), {
          modules: prestate.modules,
          trustedNode: prestate.trustedNode,
          requireActive: false,
          allowPartial: true,
          launchers: prestate.legacyRuntime.launchers,
          caller: prestate.legacyRuntime.caller,
        });
        const sealedControl = expectedListeners.find((row) => row.port === 17920);
        return rows.length === 1 && rows[0].port === 17920
          && rows[0].parentPid === controlStart.parentPid
          && hasSealedListenerAddresses(rows[0], sealedControl) ? rows : null;
      } catch { return null; }
    },
    predicate: (value) => value !== null,
    timeoutMs,
    pollMs,
    delayFn,
    code: "M6_QUALIFICATION_LEGACY_CONTROL_RESTORE_TIMEOUT",
    message: "legacy control-plane launcher did not reproduce its sealed topology",
    });
    const registryStart = await adapter.runLauncher(
    prestate.legacyRuntime.launchers.registry,
    prestate.legacyRuntime.caller,
    );
    starts.push(registryStart);
    const result = await waitFor({
    probe: async () => {
      try {
        const task = await adapter.inspectTask();
        const listeners = normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
          modules: prestate.modules,
          trustedNode: prestate.trustedNode,
          launchers: prestate.legacyRuntime.launchers,
        }), {
          modules: prestate.modules,
          trustedNode: prestate.trustedNode,
          requireActive: true,
          launchers: prestate.legacyRuntime.launchers,
          caller: prestate.legacyRuntime.caller,
        });
        if (listeners[0].parentPid !== controlStart.parentPid
          || listeners[1].parentPid !== registryStart.parentPid
          || !listeners.every((row) => hasSealedListenerAddresses(
            row,
            expectedListeners.find((sealed) => sealed.port === row.port),
          ))) return null;
        const health = assertHealthIdentity(await adapter.inspectHealth(), prestate.legacyRelease,
          "M6_QUALIFICATION_LEGACY_RESTORE_FAILED");
        return { task, listeners, health };
      } catch { return null; }
    },
    predicate: (value) => value?.task?.exists === true
      && ["READY", "DISABLED"].includes(value.task.state),
    timeoutMs,
    pollMs,
    delayFn,
    code: "M6_QUALIFICATION_LEGACY_RESTORE_TIMEOUT",
    message: "legacy task/listeners/health did not converge",
    });
    return Object.freeze({ result, prestateArtifact, settlement });
  } catch (cause) {
    if (starts.length > 0) {
      try {
        await rollbackStartedLegacyLaunchers({
          starts,
          prestate,
          adapter,
          publisher,
          delayFn,
          timeoutMs,
          pollMs,
        });
      } catch (rollbackCause) {
        fail(
          "M6_QUALIFICATION_LEGACY_LAUNCH_ROLLBACK_INCOMPLETE",
          "legacy launcher restore failed and its started processes did not settle safely",
          {
            causeCode: cause?.code || "M6_QUALIFICATION_LEGACY_RESTORE_FAILED",
            rollbackCode: rollbackCause?.code || "M6_QUALIFICATION_LEGACY_LAUNCH_ROLLBACK_FAILED",
          },
        );
      }
    }
    throw cause;
  }
}

async function settleRelaySteps(steps) {
  const rows = [];
  for (const step of steps) {
    try {
      await step.run();
      rows.push(Object.freeze({ component: step.component, status: "fulfilled" }));
    } catch (error) {
      rows.push(Object.freeze({
        component: step.component,
        status: "rejected",
        errorCode: error?.code || "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_STEP_FAILED",
      }));
    }
  }
  return Object.freeze(rows);
}

async function restoreLegacyResourceSet({ adapter, prestate }) {
  return settleRelaySteps([
    { component: "controlDb", run: () => adapter.restoreFile(prestate.resources.controlDb) },
    { component: "registryDb", run: () => adapter.restoreFile(prestate.resources.registryDb) },
    {
      component: "qualificationBinding",
      run: () => adapter.restoreFile(prestate.resources.qualificationBinding),
    },
    ...prestate.resources.privateMaterial.map((ref, index) => ({
      component: index === 0 ? "secretEnvironment" : "digestKeyring",
      run: () => adapter.restoreFile(ref),
    })),
  ]);
}

function planFromPrestate(prestate, targetRelease) {
  return Object.freeze({
    targetRelease,
    legacyRelease: prestate.legacyRelease,
  });
}

export async function executeM6QualificationLegacyQuiesce({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  expectedReleaseId,
  expectedSourceCommit,
  executingOperatorPath = fileURLToPath(import.meta.url),
  adapter = createNativeM6QualificationLegacyWindowAdapter({ runtimeRoot }),
  releaseVerifier = verifyReleaseManifest,
  trustedNodeInspector = inspectTrustedNode,
  databaseSnapshotter = snapshotSqliteDatabase,
  publisher = null,
  tcbAclController = createSystemTcbAclController(),
  timeoutMs = 30_000,
  pollMs = 100,
  delayFn = delay,
} = {}) {
  assertAdapter(adapter);
  const plan = await planM6QualificationLegacyWindow({
    runtimeRoot,
    expectedReleaseId,
    expectedSourceCommit,
    executingOperatorPath,
    releaseVerifier,
    trustedNodeInspector,
    taskInspector: () => adapter.inspectTask(),
    listenerInspector: (value) => adapter.inspectListeners(value),
    healthInspector: () => adapter.inspectHealth(),
    ownerLockInspector: (value) => adapter.inspectOwnerLock(value),
    launcherInspector: () => adapter.inspectLaunchers(),
    tcbAclController,
  });
  const sealedPublisher = publisher || createSealedPublisher({ runtimeRoot: plan.runtimeRoot, tcbAclController });
  const rollbackBoundary = Object.freeze({
    kind: "ONLINE_ROLLBACK",
    ownerRecoveryHash: sha256("xw.m6-qualification.online-owner.v1"),
    checkpointHash: sha256("xw.m6-qualification.online-checkpoint.v1"),
  });
  const rollbackCapture = await captureSealedPrestate(plan, {
    databaseSnapshotter,
    publisher: sealedPublisher,
    tcbAclController,
    boundary: rollbackBoundary,
    publishReference: false,
  });
  let mutationStarted = false;
  let settlement = null;
  let captured = null;
  let guardReleased = false;
  try {
    mutationStarted = true;
    settlement = await settleSealedLegacyRuntime({
      modules: plan.modules,
      trustedNode: plan.trustedNode,
      ownerLock: plan.legacyRuntime.ownerLock,
      launchers: plan.legacyRuntime.launchers,
      caller: plan.legacyRuntime.caller,
      expectedListeners: plan.listeners,
      adapter,
      publisher: sealedPublisher,
      delayFn,
      timeoutMs,
      pollMs,
    });
    await settlement.guard.assertOwned();
    captured = await captureSealedPrestate(plan, {
      databaseSnapshotter,
      publisher: sealedPublisher,
      tcbAclController,
      boundary: stoppedBoundary(settlement),
      publishReference: true,
    });
    await adapter.assertWalSafe();
    await settlement.guard.assertOwned();
    if (!samePath(await adapter.inspectCurrent(), plan.legacyRelease.root)) {
      fail("M6_QUALIFICATION_LEGACY_CURRENT_DRIFT", "current changed before target activation");
    }
    await adapter.switchCurrent(plan.targetRelease.root);
    if (!samePath(await adapter.inspectCurrent(), plan.targetRelease.root)) {
      fail("M6_QUALIFICATION_LEGACY_TARGET_ACTIVATION_FAILED", "current did not activate the new formal qualification release");
    }
    await settlement.guard.assertOwned();
    await settlement.guard.release();
    guardReleased = true;
    return publicReceipt({
      operation: "quiesce",
      plan,
      prestateArtifact: captured.prestateArtifact,
      outcome: "QUIESCED",
      boundary: captured.prestate.boundary,
    });
  } catch (cause) {
    if (!mutationStarted) throw cause;
    if (settlement !== null && !guardReleased) {
      try { await settlement.guard.release(); } catch {}
      guardReleased = true;
    }
    let restored = false;
    let restoreCode = null;
    let restoreResult = null;
    const recoveryCapture = captured || rollbackCapture;
    try {
      restoreResult = await restoreFromPrestate({
        prestate: recoveryCapture.prestate,
        prestateArtifact: recoveryCapture.prestateArtifact,
        adapter,
        publisher: sealedPublisher,
        delayFn,
        timeoutMs,
        pollMs,
        resourcesAlreadyRestored: true,
      });
      restored = true;
    } catch (restoreError) { restoreCode = restoreError?.code || "M6_QUALIFICATION_LEGACY_AUTO_RESTORE_FAILED"; }
    const code = restored
      ? "M6_QUALIFICATION_LEGACY_QUIESCE_ROLLED_BACK"
      : "M6_QUALIFICATION_LEGACY_AUTO_RESTORE_INCOMPLETE";
    throw Object.assign(new Error(`${code}: quiesce did not commit`), {
      code,
      causeCode: cause?.code || "M6_QUALIFICATION_LEGACY_QUIESCE_FAILED",
      restoreCode,
      receipt: publicReceipt({
        operation: "quiesce",
        plan,
        prestateArtifact: recoveryCapture.prestateArtifact,
        outcome: restored ? "RESTORED" : "RESTORE_INCOMPLETE",
        boundary: restored
          ? stoppedBoundary(restoreResult.settlement)
          : recoveryCapture.prestate.boundary,
        autoRestore: restored,
      }),
    });
  }
}

export async function executeM6QualificationLegacyRestore({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  expectedReleaseId,
  expectedSourceCommit,
  executingOperatorPath = fileURLToPath(import.meta.url),
  adapter = createNativeM6QualificationLegacyWindowAdapter({ runtimeRoot }),
  releaseVerifier = verifyReleaseManifest,
  trustedNodeInspector = inspectTrustedNode,
  tcbAclController = createSystemTcbAclController(),
  timeoutMs = 30_000,
  pollMs = 100,
  delayFn = delay,
} = {}) {
  assertAdapter(adapter);
  const runtime = absolutePath(runtimeRoot, "M6_QUALIFICATION_LEGACY_RUNTIME_INVALID", "runtimeRoot");
  const targetRelease = inspectTargetRelease({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    executingOperatorPath,
    releaseVerifier,
    tcbAclController,
  });
  const loaded = loadSealedPrestate({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    tcbAclController,
  });
  if (loaded.prestate.targetRelease.operatorSha256 !== targetRelease.operator.sha256) {
    fail("M6_QUALIFICATION_LEGACY_PRESTATE_INVALID", "sealed operator identity drifted");
  }
  const legacyRelease = inspectRelease({
    runtimeRoot: runtime,
    releaseRoot: loaded.prestate.legacyRelease.root,
    expectedReleaseId: loaded.prestate.legacyRelease.releaseId,
    expectedSourceCommit: loaded.prestate.legacyRelease.sourceCommit,
    releaseVerifier,
    tcbAclController,
    code: "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID",
  });
  if (legacyRelease.manifestSha256 !== loaded.prestate.legacyRelease.manifestSha256) {
    fail("M6_QUALIFICATION_LEGACY_PRESTATE_INVALID", "legacy release manifest changed after sealing");
  }
  const trustedNode = trustedNodeInspector(TRUSTED_NODE_EXECUTABLE);
  if (!samePath(trustedNode?.path, loaded.prestate.trustedNode.path)
    || trustedNode?.sha256 !== loaded.prestate.trustedNode.sha256
    || trustedNode?.version !== loaded.prestate.trustedNode.version) {
    fail("M6_QUALIFICATION_LEGACY_PRESTATE_INVALID", "trusted Node changed after sealing");
  }
  const taskXml = readPlainBytes(
    loaded.prestate.task.xml.path,
    "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID",
    "sealed task XML",
    256 * 1024,
  ).toString("utf8");
  validateLegacyTaskInspection({ exists: true, state: loaded.prestate.task.state, xml: taskXml }, {
    runtimeRoot: runtime,
    legacyRelease: Object.freeze({ ...legacyRelease, currentPath: join(runtime, "current") }),
    targetRelease,
    modules: loaded.prestate.modules,
  });
  for (const target of LEGACY_LAUNCHER_TARGETS) {
    verifyTcb(
      tcbAclController,
      runtime,
      loaded.prestate.legacyRuntime.launchers[target.key].path,
      false,
      "M6_QUALIFICATION_LEGACY_PRESTATE_INVALID",
    );
  }
  const actualCaller = await adapter.inspectCaller();
  if (domainCanonicalJson(actualCaller) !== domainCanonicalJson(loaded.prestate.legacyRuntime.caller)) {
    fail("M6_QUALIFICATION_LEGACY_CALLER_INVALID", "restore caller differs from sealed current-user authority");
  }
  const sealedPublisher = createSealedPublisher({ runtimeRoot: runtime, tcbAclController });
  const restored = await restoreFromPrestate({
    prestate: loaded.prestate,
    prestateArtifact: loaded.reference.prestate,
    adapter,
    publisher: sealedPublisher,
    delayFn,
    timeoutMs,
    pollMs,
  });
  return publicReceipt({
    operation: "restore",
    plan: planFromPrestate(loaded.prestate, targetRelease),
    prestateArtifact: loaded.reference.prestate,
    outcome: "RESTORED",
    boundary: stoppedBoundary(restored.settlement),
  });
}

function publishRelayArtifact({ runtimeRoot, filename, bytes, tcbAclController }) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID";
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024 * 1024
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(filename || "")) {
    fail(code, "relay prestate artifact input is invalid");
  }
  const digest = sha256(bytes);
  const path = join(runtimeRoot, "qualification-final-relays", "artifacts", digest, filename);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  protectTcb(tcbAclController, runtimeRoot, dirname(path), false, code);
  if (existsSync(path)) {
    const existing = readPlainBytes(path, code, filename, 64 * 1024 * 1024);
    if (!existing.equals(bytes)) fail(code, "relay artifact address collision");
  } else {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  protectTcb(tcbAclController, runtimeRoot, path, false, code);
  return Object.freeze({ path, sha256: digest });
}

async function captureM6QualificationFinalRelayPrestate({
  runtimeRoot,
  adapter,
  windowPrestate,
  tcbAclController,
}) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID";
  const runtimeSlots = FINAL_RUNTIME_SLOT_PATHS.map((parts) => {
    const targetPath = join(runtimeRoot, ...parts);
    if (!existsSync(targetPath)) return Object.freeze({ present: false, targetPath });
    const bytes = readPlainBytes(targetPath, code, "pre-relay runtime binding", 64 * 1024 * 1024);
    const artifact = publishRelayArtifact({
      runtimeRoot,
      filename: basename(targetPath),
      bytes,
      tcbAclController,
    });
    return Object.freeze({ present: true, targetPath, ...artifact });
  });
  const tasks = [];
  for (const taskName of FINAL_TASK_NAMES) {
    const inspection = await adapter.inspectFixedTask(taskName);
    if (!exactObject(inspection, ["exists", "state", "xml"])
      || !["ABSENT", "DISABLED", "READY"].includes(inspection.state)
      || inspection.exists !== (inspection.state !== "ABSENT")
      || (inspection.exists ? typeof inspection.xml !== "string" : inspection.xml !== null)) {
      fail(code, "all legacy/future FINAL tasks must be exact and stopped at relay boundary");
    }
    if (!inspection.exists) {
      tasks.push(Object.freeze({ name: taskName, exists: false, state: "ABSENT" }));
      continue;
    }
    if (taskName !== FINAL_TASK_NAMES[0]) {
      fail(code, "initial qualification relay requires all three auxiliary FINAL tasks absent");
    }
    let definition;
    try { definition = parseLegacyTaskDefinition(inspection.xml); }
    catch { fail(code, `${taskName} stopped XML is invalid`); }
    if (definition.principal !== "SYSTEM") fail(code, `${taskName} is not SYSTEM-owned`);
    const artifact = publishRelayArtifact({
      runtimeRoot,
      filename: `${taskName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}.xml`,
      bytes: Buffer.from(inspection.xml, "utf8"),
      tcbAclController,
    });
    tasks.push(Object.freeze({ name: taskName, exists: true, state: inspection.state, xml: artifact }));
  }
  if (!tasks[0].exists || tasks[0].xml.sha256 !== windowPrestate.task.xml.sha256) {
    fail(code, "relay task prestate does not reproduce the sealed legacy main task");
  }
  const prestate = Object.freeze({
    schemaId: "xw.runtime.m6-qualification-final-relay-prestate.v1",
    runtimeRoot,
    runtimeSlots: Object.freeze(runtimeSlots),
    tasks: Object.freeze(tasks),
  });
  const bytes = canonicalJsonBytes(prestate);
  const artifact = publishRelayArtifact({
    runtimeRoot,
    filename: "relay-prestate.v1.json",
    bytes,
    tcbAclController,
  });
  return Object.freeze({ prestate, artifact });
}

async function restoreM6QualificationFinalRelayOverlay({ adapter, relayPrestate }) {
  return settleRelaySteps([
    ...relayPrestate.runtimeSlots.map((ref, index) => ({
      component: ["m6Final", "serve03", "serve04"][index],
      run: () => adapter.restoreRelaySlot(ref),
    })),
    ...relayPrestate.tasks.slice(1).filter((task) => task.exists).map((task) => ({
      component: `task:${task.name}`,
      run: () => adapter.registerFixedTaskXml(task.name, task.xml.path),
    })),
  ]);
}

async function assertM6QualificationFinalRelayPrestateUnchanged({ adapter, relayPrestate }) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_CONCURRENT_DRIFT";
  for (const ref of relayPrestate.runtimeSlots) {
    const present = existsSync(ref.targetPath);
    if (present !== ref.present) fail(code, "pre-relay runtime slot presence changed before apply");
    if (present && sha256(readPlainBytes(
      ref.targetPath,
      code,
      "pre-relay runtime slot",
      64 * 1024 * 1024,
    )) !== ref.sha256) fail(code, "pre-relay runtime slot bytes changed before apply");
  }
  for (const expected of relayPrestate.tasks) {
    const actual = await adapter.inspectFixedTask(expected.name);
    if (!exactObject(actual, ["exists", "state", "xml"])
      || actual.exists !== expected.exists || actual.state !== expected.state
      || (expected.exists && sha256(Buffer.from(actual.xml || "", "utf8")) !== expected.xml.sha256)
      || (!expected.exists && actual.xml !== null)) {
      fail(code, "fixed task state/XML changed before relay apply");
    }
  }
}

function assertFinalRelayAdapters(adapter, cutoverAdapter) {
  for (const name of ["acquireStoppedGuard", "archiveStaleOwnerLock", "assertWalSafe",
    "checkpointDatabases", "cleanupFinalTasks", "inspectCaller", "inspectCurrent", "inspectLaunchers", "inspectListeners",
    "inspectFixedTask", "inspectQualificationTask", "inspectTask", "registerFixedTaskXml",
    "registerTaskXml", "restoreCurrent", "restoreFile", "restoreRelaySlot", "runLauncher",
    "terminateVerifiedProcess"]) {
    if (typeof adapter?.[name] !== "function") {
      fail("M6_QUALIFICATION_FINAL_RELAY_DEPENDENCY_INVALID", `legacy relay adapter is missing ${name}`);
    }
  }
  for (const name of ["registerTask", "start", "switchCurrent", "writeRuntimeBinding"]) {
    if (typeof cutoverAdapter?.[name] !== "function") {
      fail("M6_QUALIFICATION_FINAL_RELAY_DEPENDENCY_INVALID", `Gate-F relay adapter is missing ${name}`);
    }
  }
}

function inspectRelayTargetModules(targetRelease) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_TARGET_INVALID";
  return Object.freeze({
    controlPlane: inspectManifestFile({
      manifest: targetRelease.manifest,
      releaseRoot: targetRelease.root,
      releasePath: CONTROL_MODULE_RELEASE_PATH,
      code,
      label: "target control-plane module",
    }),
    registry: inspectManifestFile({
      manifest: targetRelease.manifest,
      releaseRoot: targetRelease.root,
      releasePath: REGISTRY_MODULE_RELEASE_PATH,
      code,
      label: "target registry module",
    }),
    stateStore: inspectManifestFile({
      manifest: targetRelease.manifest,
      releaseRoot: targetRelease.root,
      releasePath: STATE_STORE_RELEASE_PATH,
      code,
      label: "target state-store module",
    }),
    gateFCutoverOperator: inspectManifestFile({
      manifest: targetRelease.manifest,
      releaseRoot: targetRelease.root,
      releasePath: GATE_F_CUTOVER_OPERATOR_RELEASE_PATH,
      code,
      label: "target Gate-F cutover operator",
    }),
  });
}

async function assertFinalRelayQuiescentPreconditions({
  adapter,
  prestate,
  targetRelease,
  targetModules,
}) {
  if (!samePath(await adapter.inspectCurrent(), targetRelease.root)) {
    fail("M6_QUALIFICATION_FINAL_RELAY_CURRENT_INVALID", "current is not the qualified target release");
  }
  const task = await adapter.inspectTask();
  if (!exactObject(task, ["exists", "state", "xml"]) || task.exists !== true
    || !["READY", "DISABLED"].includes(task.state)
    || sha256(Buffer.from(task.xml || "", "utf8")) !== prestate.task.xml.sha256) {
    fail("M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID", "sealed legacy task is not exact and stopped");
  }
  const qualificationTask = await adapter.inspectQualificationTask();
  if (!exactObject(qualificationTask, ["exists", "state", "xml"])
    || qualificationTask.exists !== false || qualificationTask.state !== "ABSENT"
    || qualificationTask.xml !== null) {
    fail("M6_QUALIFICATION_FINAL_RELAY_TASK_INVALID", "qualification task must be stopped and removed");
  }
  normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
    modules: targetModules,
    trustedNode: prestate.trustedNode,
  }), { modules: targetModules, trustedNode: prestate.trustedNode, requireActive: false });
  await adapter.assertWalSafe();
}

function assertPreparedFinalRelayTarget({ prepared, staged, targetRelease, prestate }) {
  const code = "M6_QUALIFICATION_FINAL_RELAY_TARGET_INVALID";
  if (prepared?.ok !== true || !HEX64.test(prepared.tupleSha256 || "")
    || !samePath(prepared.tuplePath, join(
      targetRelease.runtimeRoot,
      "cutover-tuples",
      prepared.tupleSha256 || "",
      "gate-f-cutover-tuple.v1.json",
    ))) fail(code, "prepared Gate-F tuple is not content-addressed at the fixed target");
  const tuple = prepared.tuple;
  const candidate = staged?.candidate;
  if (tuple?.release?.releaseId !== targetRelease.releaseId
    || tuple.release.sourceCommit !== targetRelease.sourceCommit
    || !samePath(tuple.release.root, targetRelease.root)
    || !samePath(tuple.current?.target, targetRelease.root)
    || tuple.formal?.task?.name !== FINAL_TASK_NAMES[0]
    || JSON.stringify(tuple.activationTasks?.map((row) => row.name))
      !== JSON.stringify(FINAL_TASK_NAMES.slice(1))
    || !samePath(tuple.trustedNode?.path, prestate.trustedNode.path)
    || tuple.trustedNode.sha256 !== prestate.trustedNode.sha256
    || tuple.trustedNode.version !== prestate.trustedNode.version) {
    fail(code, "prepared Gate-F tuple release/task/Node identity drifted");
  }
  const privateHashes = [
    tuple.runtimeBindings?.secretEnvironment?.sha256,
    tuple.runtimeBindings?.digestKeyring?.sha256,
  ];
  if (JSON.stringify(privateHashes)
    !== JSON.stringify(prestate.resources.privateMaterial.map((row) => row.sha256))) {
    fail(code, "target tuple changed sealed private material");
  }
  if (candidate?.ok !== true || !HEX64.test(candidate.sha256 || "")
    || candidate.value?.releaseId !== targetRelease.releaseId
    || candidate.value?.sourceCommit !== targetRelease.sourceCommit
    || domainCanonicalJson(candidate.value.snapshots) !== domainCanonicalJson(tuple.snapshots)
    || candidate.value.preparedRuntimeBindings?.m6Final?.sha256
      !== tuple.runtimeBindings.m6Final.sha256
    || candidate.value.preparedRuntimeBindings?.serve03?.sha256
      !== tuple.runtimeBindings.serve03.sha256
    || candidate.value.preparedRuntimeBindings?.serve04?.sha256
      !== tuple.runtimeBindings.serve04.sha256) {
    fail(code, "prepared tuple is not the exact qualified assembler candidate");
  }
  return tuple;
}

async function terminateExactRelayTargetListeners({
  adapter,
  modules,
  trustedNode,
  timeoutMs,
  pollMs,
  delayFn,
}) {
  const rows = normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
    modules,
    trustedNode,
  }), { modules, trustedNode, requireActive: false, allowPartial: true });
  for (const row of rows) await adapter.terminateVerifiedProcess(row);
  await waitFor({
    probe: () => adapter.inspectListeners({ modules, trustedNode }),
    predicate: (value) => {
      try {
        normalizeM6QualificationLegacyListeners(value, {
          modules,
          trustedNode,
          requireActive: false,
        });
        return true;
      } catch { return false; }
    },
    timeoutMs,
    pollMs,
    delayFn,
    code: "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_LISTENER_TIMEOUT",
    message: "exact target listeners did not become absent before rollback",
  });
}

export async function executeM6QualificationFinalRelay({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  expectedReleaseId,
  expectedSourceCommit,
  assemblerReceiptHash,
  executingOperatorPath = fileURLToPath(import.meta.url),
  adapter = createNativeM6QualificationLegacyWindowAdapter({ runtimeRoot }),
  cutoverAdapter = createNativeGateFCutoverAdapter({ runtimeRoot }),
  releaseVerifier = verifyReleaseManifest,
  trustedNodeInspector = inspectTrustedNode,
  qualificationInspector = inspectM6QualificationFinalRelayState,
  candidateStager = stageGateFTargetCandidateFromFixedAssembler,
  targetPreparer = prepareGateFCutoverTargetFromFixedCandidate,
  tupleVerifier = verifyGateFCutoverTuple,
  authorizationWriter = materializeM6QualificationFinalRelayAuthorization,
  receiptWriter = materializeM6QualificationFinalRelayReceipt,
  candidateSnapshotDependencies = {},
  targetPreparerDependencies = {},
  tupleVerifierDependencies = {},
  qualificationInspectorDependencies = {},
  tcbAclController = createSystemTcbAclController(),
  timeoutMs = 30_000,
  pollMs = 100,
  delayFn = delay,
} = {}) {
  if (!HEX64.test(assemblerReceiptHash || "")
    || typeof qualificationInspector !== "function" || typeof candidateStager !== "function"
    || typeof targetPreparer !== "function" || typeof tupleVerifier !== "function"
    || typeof authorizationWriter !== "function" || typeof receiptWriter !== "function") {
    fail("M6_QUALIFICATION_FINAL_RELAY_ARGUMENT_INVALID", "fixed assembler receipt and relay dependencies are required");
  }
  assertFinalRelayAdapters(adapter, cutoverAdapter);
  const runtime = absolutePath(runtimeRoot, "M6_QUALIFICATION_FINAL_RELAY_RUNTIME_INVALID", "runtimeRoot");
  const targetReleaseBase = inspectTargetRelease({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    executingOperatorPath,
    releaseVerifier,
    tcbAclController,
  });
  const targetRelease = Object.freeze({ ...targetReleaseBase, runtimeRoot: runtime });
  const targetModules = inspectRelayTargetModules(targetRelease);
  const loaded = loadSealedPrestate({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    tcbAclController,
  });
  const sealedPublisher = createSealedPublisher({ runtimeRoot: runtime, tcbAclController });
  if (loaded.prestate.targetRelease.operatorSha256 !== targetRelease.operator.sha256) {
    fail("M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID", "sealed relay operator identity drifted");
  }
  const legacyRelease = inspectRelease({
    runtimeRoot: runtime,
    releaseRoot: loaded.prestate.legacyRelease.root,
    expectedReleaseId: loaded.prestate.legacyRelease.releaseId,
    expectedSourceCommit: loaded.prestate.legacyRelease.sourceCommit,
    releaseVerifier,
    tcbAclController,
    code: "M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID",
  });
  if (legacyRelease.manifestSha256 !== loaded.prestate.legacyRelease.manifestSha256) {
    fail("M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID", "sealed legacy manifest drifted");
  }
  const trustedNode = trustedNodeInspector(TRUSTED_NODE_EXECUTABLE);
  if (!samePath(trustedNode?.path, loaded.prestate.trustedNode.path)
    || trustedNode?.sha256 !== loaded.prestate.trustedNode.sha256
    || trustedNode?.version !== loaded.prestate.trustedNode.version) {
    fail("M6_QUALIFICATION_FINAL_RELAY_PRESTATE_INVALID", "trusted Node drifted after quiesce");
  }
  await assertFinalRelayQuiescentPreconditions({
    adapter,
    prestate: loaded.prestate,
    targetRelease,
    targetModules,
  });
  const relayPrestate = await captureM6QualificationFinalRelayPrestate({
    runtimeRoot: runtime,
    adapter,
    windowPrestate: loaded.prestate,
    tcbAclController,
  });
  const qualification = qualificationInspector({
    ...qualificationInspectorDependencies,
    runtimeRoot: runtime,
    targetRelease,
    requireStandalone: true,
  });
  if (qualification?.databaseVersion !== 21 || !HEX64.test(qualification?.databaseSha256 || "")
    || !HEX64.test(qualification?.receipt?.packageHash || "")) {
    fail("M6_QUALIFICATION_FINAL_RELAY_QUALIFICATION_INVALID", "relay requires exact stopped schema-21 qualification state");
  }
  const staged = await candidateStager({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    assemblerReceiptHash,
    qualificationPackageHash: qualification.receipt.packageHash,
    tcbAclController,
    snapshotCapturer: (options) => captureM6QualificationFinalTargetSnapshots({
      ...options,
      ...candidateSnapshotDependencies,
      runtimeRoot: runtime,
      expectedReleaseId,
      expectedSourceCommit,
      qualification,
      tcbAclController,
    }),
  });
  if (staged?.ok !== true || staged.snapshotSource?.releaseId !== expectedReleaseId
    || staged.snapshotSource?.sourceCommit !== expectedSourceCommit) {
    fail("M6_QUALIFICATION_FINAL_RELAY_TARGET_INVALID", "qualified target snapshots were not release-bound");
  }
  const prepared = await targetPreparer({
    ...targetPreparerDependencies,
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    tcbAclController,
  });
  const tuple = assertPreparedFinalRelayTarget({
    prepared,
    staged,
    targetRelease,
    prestate: loaded.prestate,
  });
  const preflight = await tupleVerifier({
    ...tupleVerifierDependencies,
    tuplePath: prepared.tuplePath,
    expectedTupleSha256: prepared.tupleSha256,
    expectedRuntimeRoot: runtime,
    requireActive: false,
    tcbAclController,
  });
  if (preflight?.ok !== true || preflight.releaseId !== expectedReleaseId
    || preflight.sourceCommit !== expectedSourceCommit || preflight.active !== false) {
    fail("M6_QUALIFICATION_FINAL_RELAY_TARGET_INVALID", "target Gate-F tuple failed inactive verification");
  }
  const authorization = authorizationWriter({
    runtimeRoot: runtime,
    targetRelease,
    assemblerReceiptHash,
    prestateArtifact: loaded.reference.prestate,
    relayPrestateArtifact: relayPrestate.artifact,
    qualification,
    candidate: staged.candidate,
    tuplePath: prepared.tuplePath,
    tupleSha256: prepared.tupleSha256,
    tcbAclController,
  });
  const sealedAuthorization = validateM6QualificationFinalRelayAuthorization({
    runtimeRoot: runtime,
    authorization,
    targetRelease,
    assemblerReceiptHash,
    prestateArtifact: loaded.reference.prestate,
    relayPrestateArtifact: relayPrestate.artifact,
    qualification,
    candidate: staged.candidate,
    tuplePath: prepared.tuplePath,
    tupleSha256: prepared.tupleSha256,
    tcbAclController,
  });
  await assertFinalRelayQuiescentPreconditions({
    adapter,
    prestate: loaded.prestate,
    targetRelease,
    targetModules,
  });
  await assertM6QualificationFinalRelayPrestateUnchanged({
    adapter,
    relayPrestate: relayPrestate.prestate,
  });
  const qualificationCas = qualificationInspector({
    ...qualificationInspectorDependencies,
    runtimeRoot: runtime,
    targetRelease,
    requireStandalone: true,
  });
  if (qualificationCas?.databaseSha256 !== qualification.databaseSha256
    || qualificationCas.fenceHash !== qualification.fenceHash
    || qualificationCas.binding?.sha256 !== qualification.binding.sha256
    || qualificationCas.receipt?.receiptHash !== qualification.receipt.receiptHash
    || qualificationCas.receipt?.packageHash !== qualification.receipt.packageHash) {
    fail("M6_QUALIFICATION_FINAL_RELAY_CONCURRENT_DRIFT", "qualification state changed before relay apply");
  }

  const applied = [];
  let mutationStarted = false;
  try {
    mutationStarted = true;
    await cutoverAdapter.writeRuntimeBinding(tuple.runtimeBindings.m6Final); applied.push("m6Final");
    await cutoverAdapter.writeRuntimeBinding(tuple.runtimeBindings.serve03); applied.push("serve03");
    await cutoverAdapter.writeRuntimeBinding(tuple.runtimeBindings.serve04); applied.push("serve04");
    await cutoverAdapter.switchCurrent(tuple.current.target); applied.push("current");
    for (const task of [tuple.formal.task, ...tuple.activationTasks]) {
      await cutoverAdapter.registerTask(task);
      applied.push(`task:${task.name}`);
    }
    await cutoverAdapter.start(); applied.push("fixedTasksStarted");
    const activePostflight = await waitFor({
      probe: async () => {
        try {
          return await tupleVerifier({
            ...tupleVerifierDependencies,
            tuplePath: prepared.tuplePath,
            expectedTupleSha256: prepared.tupleSha256,
            expectedRuntimeRoot: runtime,
            requireActive: true,
            tcbAclController,
          });
        } catch { return null; }
      },
      predicate: (postflight) => postflight?.ok === true && postflight.active === true
        && postflight.releaseId === expectedReleaseId
        && postflight.sourceCommit === expectedSourceCommit
        && HEX64.test(postflight.taskProcessClosure?.closureSha256 || ""),
      timeoutMs,
      pollMs,
      delayFn,
      code: "M6_QUALIFICATION_FINAL_RELAY_POSTFLIGHT_TIMEOUT",
      message: "active Gate-F target identity did not converge",
    });
    await waitFor({
      probe: async () => {
        try {
          return normalizeM6QualificationLegacyListeners(await adapter.inspectListeners({
            modules: targetModules,
            trustedNode: loaded.prestate.trustedNode,
          }), {
            modules: targetModules,
            trustedNode: loaded.prestate.trustedNode,
            requireActive: true,
          });
        } catch { return null; }
      },
      predicate: (listeners) => Array.isArray(listeners) && listeners.length === 2,
      timeoutMs,
      pollMs,
      delayFn,
      code: "M6_QUALIFICATION_FINAL_RELAY_LISTENER_TIMEOUT",
      message: "exact trusted target listeners did not converge on 17920/17930",
    });
    const postQualification = qualificationInspector({
      ...qualificationInspectorDependencies,
      runtimeRoot: runtime,
      targetRelease,
      requireStandalone: false,
    });
    if (postQualification?.databaseVersion !== qualification.databaseVersion
      || postQualification.fenceHash !== qualification.fenceHash
      || postQualification.binding?.sha256 !== qualification.binding.sha256
      || postQualification.receipt?.receiptHash !== qualification.receipt.receiptHash
      || postQualification.receipt?.packageHash !== qualification.receipt.packageHash) {
      fail("M6_QUALIFICATION_FINAL_RELAY_POSTFLIGHT_INVALID", "qualified CLOSED fence drifted during FINAL activation");
    }
    const receiptBody = Object.freeze({
      schemaId: M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID,
      code: "M6_QUALIFICATION_FINAL_RELAY_COMMITTED",
      outcome: "FINAL_ACTIVE",
      releaseId: expectedReleaseId,
      sourceCommit: expectedSourceCommit,
      assemblerReceiptHash,
      authorizationSha256: sealedAuthorization.sha256,
      legacyPrestateSha256: loaded.reference.prestate.sha256,
      relayPrestateSha256: relayPrestate.artifact.sha256,
      qualificationFenceHash: qualification.fenceHash,
      qualificationReceiptHash: qualification.receipt.receiptHash,
      qualificationPackageHash: qualification.receipt.packageHash,
      targetTupleSha256: prepared.tupleSha256,
      applied: Object.freeze(applied),
      postflight: Object.freeze({
        active: true,
        gate: "CLOSED",
        qualificationPreserved: true,
        taskOwnedProcessClosureSha256: activePostflight.taskProcessClosure.closureSha256,
      }),
    });
    return persistM6QualificationFinalRelayReceipt({
      receiptWriter,
      runtimeRoot: runtime,
      body: receiptBody,
      tcbAclController,
    });
  } catch (cause) {
    if (!mutationStarted) throw cause;
    let rollbackVerified = false;
    let rollbackCode = null;
    const stop = await settleRelaySteps([
      { component: "finalTasks", run: () => adapter.cleanupFinalTasks() },
      {
        component: "targetListeners",
        run: () => terminateExactRelayTargetListeners({
          adapter,
          modules: targetModules,
          trustedNode: loaded.prestate.trustedNode,
          timeoutMs,
          pollMs,
          delayFn,
        }),
      },
      { component: "walBoundary", run: () => adapter.assertWalSafe() },
    ]);
    let resources = Object.freeze([]);
    let overlay = Object.freeze([]);
    let restart = Object.freeze([]);
    if (stop.every((row) => row.status === "fulfilled")) {
      resources = await restoreLegacyResourceSet({ adapter, prestate: loaded.prestate });
      overlay = await restoreM6QualificationFinalRelayOverlay({
        adapter,
        relayPrestate: relayPrestate.prestate,
      });
      if ([...resources, ...overlay].every((row) => row.status === "fulfilled")) {
        restart = await settleRelaySteps([{
          component: "legacyCurrentTaskHealth",
          run: () => restoreFromPrestate({
            prestate: loaded.prestate,
            prestateArtifact: loaded.reference.prestate,
            adapter,
            publisher: sealedPublisher,
            delayFn,
            timeoutMs,
            pollMs,
            resourcesAlreadyRestored: true,
          }),
        }]);
        rollbackVerified = restart[0]?.status === "fulfilled";
      }
    }
    const rollback = Object.freeze({ stop, resources, overlay, restart, verified: rollbackVerified });
    rollbackCode = [...stop, ...resources, ...overlay, ...restart]
      .find((row) => row.status === "rejected")?.errorCode ?? null;
    const code = rollbackVerified
      ? "M6_QUALIFICATION_FINAL_RELAY_ROLLED_BACK"
      : "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INCOMPLETE";
    const receiptBody = Object.freeze({
      schemaId: M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID,
      code,
      outcome: rollbackVerified ? "LEGACY_RESTORED" : "ROLLBACK_INCOMPLETE",
      releaseId: expectedReleaseId,
      sourceCommit: expectedSourceCommit,
      causeCode: safeRelayErrorCode(
        cause?.code,
        "M6_QUALIFICATION_FINAL_RELAY_APPLY_FAILED",
      ),
      rollbackCode: rollbackCode === null ? null : safeRelayErrorCode(
        rollbackCode,
        "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_STEP_FAILED",
      ),
      authorizationSha256: sealedAuthorization.sha256,
      legacyPrestateSha256: loaded.reference.prestate.sha256,
      relayPrestateSha256: relayPrestate.artifact.sha256,
      targetTupleSha256: prepared.tupleSha256,
      applied: Object.freeze(applied),
      rollback: safeRelayRollback(rollback),
    });
    let persisted;
    try {
      persisted = persistM6QualificationFinalRelayReceipt({
        receiptWriter,
        runtimeRoot: runtime,
        body: receiptBody,
        tcbAclController,
      });
    } catch {
      fail(
        "M6_QUALIFICATION_FINAL_RELAY_RECEIPT_PERSIST_FAILED",
        `${code} receipt could not be persisted`,
      );
    }
    throw Object.assign(new Error(`${code}: FINAL relay did not commit`), {
      code,
      receiptHash: persisted.receiptHash,
      receiptRef: persisted.receiptRef,
    });
  }
}

export function parseM6QualificationLegacyWindowCommand(argv) {
  if (Array.isArray(argv) && argv.length === 4 && argv[0] === "relay-final-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")
    && HEX64.test(argv[3] || "")) {
    return Object.freeze({
      kind: "relay-final",
      releaseId: argv[1],
      sourceCommit: argv[2],
      assemblerReceiptHash: argv[3],
    });
  }
  if (!Array.isArray(argv) || argv.length !== 3
    || !["quiesce-fixed", "restore-fixed"].includes(argv[0])
    || !RELEASE_ID.test(argv[1] || "") || !HEX40.test(argv[2] || "")) {
    fail(
      "M6_QUALIFICATION_LEGACY_ARGUMENT_INVALID",
      "requires a fixed command plus new formal releaseId/sourceCommit and, for FINAL relay only, the assembler receipt hash; paths, PIDs, ports, tokens, and options are forbidden",
    );
  }
  return Object.freeze({
    kind: argv[0] === "quiesce-fixed" ? "quiesce" : "restore",
    releaseId: argv[1],
    sourceCommit: argv[2],
  });
}

export async function mainM6QualificationLegacyWindow(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const command = parseM6QualificationLegacyWindowCommand(argv);
  const invoke = command.kind === "quiesce"
    ? executeM6QualificationLegacyQuiesce
    : command.kind === "restore"
      ? executeM6QualificationLegacyRestore
      : executeM6QualificationFinalRelay;
  const receipt = await invoke({
    ...dependencies,
    runtimeRoot: FORMAL_RUNTIME_ROOT,
    expectedReleaseId: command.releaseId,
    expectedSourceCommit: command.sourceCommit,
    ...(command.kind === "relay-final" ? { assemblerReceiptHash: command.assemblerReceiptHash } : {}),
    executingOperatorPath: fileURLToPath(import.meta.url),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainM6QualificationLegacyWindow().catch((error) => {
    const code = safeRelayErrorCode(
      error?.code,
      "M6_QUALIFICATION_LEGACY_WINDOW_FAILED",
    );
    const expectedReceiptPath = HEX64.test(error?.receiptHash || "")
      ? join(
        FORMAL_RUNTIME_ROOT,
        "qualification-final-relays",
        "receipts",
        `${error.receiptHash}.json`,
      )
      : null;
    const receiptRef = expectedReceiptPath !== null
      && exactObject(error?.receiptRef, ["path", "sha256"])
      && samePath(error.receiptRef.path, expectedReceiptPath)
      && HEX64.test(error.receiptRef.sha256 || "")
      ? error.receiptRef
      : null;
    process.stderr.write(`${JSON.stringify({
      code,
      ...(receiptRef === null ? {} : {
        receiptHash: error.receiptHash,
        receiptRef,
      }),
    })}\n`);
    process.exitCode = 1;
  });
}
