import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import { fileURLToPath } from "node:url";

import { verifyReleaseManifest } from "../../../packages/release/lib/release-manifest.mjs";
import { M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID } from
  "../../../tools/m6/m6-4-production-release-assembler.mjs";
import { loadM6GateFArtifactCatalog } from
  "../control-plane/lib/m6-gate-f-operations.mjs";
import { loadM6Gate } from "../control-plane/lib/m6-gate-loader.mjs";
import { assertM6FileDbPointerConsistency } from
  "../control-plane/lib/m6-gate-promoter.mjs";
import {
  stageM6QualificationBootstrapRotationArtifacts,
  validateM6QualificationBootstrapPackage,
} from "../control-plane/lib/m6-qualification-bootstrap.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { canonicalJson as domainCanonicalJson } from
  "../control-plane/lib/canonical.mjs";
import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";
import {
  FORMAL_RELEASE_MANIFEST_SCHEMA_ID,
  FORMAL_RELEASE_SOURCE_REPO,
  FORMAL_RUNTIME_ROOT,
} from "./formal-release-builder.mjs";
import {
  buildCreateOnlyTaskRegistration,
  buildFormalControlPlaneTaskXml,
  FORMAL_BINDING_FILENAME,
  FORMAL_CONTROL_PLANE_TASK_NAME,
  FORMAL_LAUNCHER_FILENAME,
  FORMAL_TASK_XML_FILENAME,
  GATE_F_LAUNCHER_BINDING_SCHEMA_ID,
  inspectGateFProviderConfigClosure,
  prepareGateFTargetLauncherArtifacts,
  TRUSTED_NODE_EXECUTABLE,
  verifyGateFLauncherIdentity,
} from "./gate-f-launcher-identity.mjs";
import { inspectControlPlanePrivateMaterial } from "./control-plane-private-material.mjs";

export const GATE_F_CUTOVER_TUPLE_SCHEMA_ID = "xw.runtime.gate-f-cutover-tuple.v1";
export const GATE_F_CUTOVER_TRANSITION_SCHEMA_ID = "xw.runtime.gate-f-cutover-transition.v1";
export const GATE_F_CUTOVER_RECEIPT_SCHEMA_ID = "xw.runtime.gate-f-cutover-receipt.v1";
export const GATE_F_LEGACY_PRESTATE_SCHEMA_ID = "xw.runtime.gate-f-legacy-prestate.v1";
export const GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_SCHEMA_ID =
  "xw.runtime.gate-f-legacy-bootstrap-authorization.v1";
export const GATE_F_TARGET_CANDIDATE_SCHEMA_ID = "xw.runtime.gate-f-target-candidate.v1";
export const GATE_F_TARGET_REFERENCE_SCHEMA_ID = "xw.runtime.gate-f-target-reference.v1";
export const GATE_F_LEGACY_REFERENCE_SCHEMA_ID = "xw.runtime.gate-f-legacy-reference.v1";
export const GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID =
  "xw.runtime.gate-f-cross-release-target.v1";
export const GATE_F_CROSS_RELEASE_HANDOFF_SCHEMA_ID =
  "xw.runtime.gate-f-cross-release-handoff.v1";
export const GATE_F_TASK_OWNED_PROCESS_CLOSURE_SCHEMA_ID =
  "xw.runtime.gate-f-task-owned-process-closure.v1";
export const GATE_F_FINAL_VALIDATE_FIXED_SCHEMA_ID =
  "xw.runtime.gate-f-final-validate-fixed.v1";
export const GATE_F_CUTOVER_TUPLE_FILENAME = "gate-f-cutover-tuple.v1.json";
export const GATE_F_LEGACY_PRESTATE_FILENAME = "gate-f-legacy-prestate.v1.json";
export const GATE_F_TARGET_CANDIDATE_FILENAME = "gate-f-target-candidate.v1.json";
export const GATE_F_TARGET_REFERENCE_FILENAME = "gate-f-target-reference.v1.json";
export const GATE_F_LEGACY_REFERENCE_FILENAME = "gate-f-legacy-reference.v1.json";
export const GATE_F_CUTOVER_OPERATOR_RELEASE_PATH =
  "services/control-plane/ops/gate-f-cutover-operator.mjs";
export const GATE_F_AUTHORIZED_TRANSITION_PATH = join(
  FORMAL_RUNTIME_ROOT,
  "cutover",
  "authorized-transition.v1.json",
);
export const GATE_F_AUTHORIZED_LEGACY_BOOTSTRAP_PATH = join(
  FORMAL_RUNTIME_ROOT,
  "cutover",
  "authorized-legacy-bootstrap.v1.json",
);
export const GATE_F_CONTROL_HEALTH_URL = "http://127.0.0.1:17920/control/v1/health";
export const GATE_F_REGISTRY_HEALTH_URL = "http://127.0.0.1:17930/api/health";
export const GATE_F_STATUS_URL = "http://127.0.0.1:17920/control/v1/internal/m6/gate-f/status";
export const WINDOWS_POWERSHELL_EXECUTABLE = join(
  "C:\\",
  "Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
export const XHS_V3_PRIVATE_ROOT_NAMES = Object.freeze([
  "invocations",
  "captures",
  "corpus-sets",
  "runs",
  "acceptance",
]);

const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const REGISTRY_DATABASE_FILENAME = ["registry", "db"].join(".");
const TASKS_TO_ACTIVATE = Object.freeze([
  FORMAL_CONTROL_PLANE_TASK_NAME,
  "XW Platform Orchestrator",
  "XW Platform FastOperator 03",
  "XW Platform FastOperator 04",
]);
const TUPLE_KEYS = Object.freeze([
  "activationTasks", "current", "formal", "gateHandoff", "liveIdentity", "operator", "release", "runtimeBindings",
  "runtimeRoot", "schemaId", "snapshots", "systemTaskClosure", "trustedNode", "xhsV3PrivateRoots",
]);
const AUXILIARY_TASK_SPECS = Object.freeze([
  Object.freeze({ name: "XW Platform Orchestrator", filename: "xw-platform-orchestrator.xml", alias: null }),
  Object.freeze({ name: "XW Platform FastOperator 03", filename: "xw-platform-fastoperator-03.xml", alias: "03" }),
  Object.freeze({ name: "XW Platform FastOperator 04", filename: "xw-platform-fastoperator-04.xml", alias: "04" }),
]);
const TASK_PROCESS_SPECS = Object.freeze([
  Object.freeze({
    role: "controlPlane",
    taskName: FORMAL_CONTROL_PLANE_TASK_NAME,
    moduleReleasePath: "services/control-plane/control-plane/server.mjs",
    listenerPort: 17920,
  }),
  Object.freeze({
    role: "registry",
    taskName: "XW Platform Orchestrator",
    moduleReleasePath: "services/orchestrator/registry.mjs",
    listenerPort: 17930,
  }),
  Object.freeze({
    role: "serve03",
    taskName: "XW Platform FastOperator 03",
    moduleReleasePath: "services/control-plane/scripts/fast-operator.mjs",
    listenerPort: null,
  }),
  Object.freeze({
    role: "serve04",
    taskName: "XW Platform FastOperator 04",
    moduleReleasePath: "services/control-plane/scripts/fast-operator.mjs",
    listenerPort: null,
  }),
]);
const TASK_PROCESS_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Fail-Closed { exit 71 }
function Same-Path([string]$Left, [string]$Right) {
    try { return [IO.Path]::GetFullPath($Left).Equals([IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}
function Has-Exact-Token([string]$CommandLine, [string]$Expected) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $escaped = [Regex]::Escape($Expected)
    return [Regex]::IsMatch($CommandLine, '(?i)(?:^|[\s"]){0}(?=$|[\s"])' -f $escaped)
}
function Hash-Text([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally { $sha.Dispose() }
}
function Iso-Utc($Value) {
    return ([DateTime]$Value).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XW_GATE_F_TASK_PROCESS_SPECS_B64))
    $inputValue = $json | ConvertFrom-Json
    $service = New-Object -ComObject "Schedule.Service"
    $service.Connect()
    $folder = $service.GetFolder("\")
    $rows = @()
    foreach ($spec in @($inputValue.specs)) {
        $task = $folder.GetTask([string]$spec.taskName)
        if ([int]$task.State -ne 4) { Fail-Closed }
        $instances = @($task.GetInstances(0))
        if ($instances.Count -ne 1) { Fail-Closed }
        $instance = $instances[0]
        $enginePid = [int64]$instance.EnginePID
        if ($enginePid -lt 4 -or -not (Same-Path ([string]$instance.CurrentAction) ([string]$inputValue.powerShellPath))) { Fail-Closed }
        $engine = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $enginePid) -ErrorAction Stop
        if ($null -eq $engine -or -not (Same-Path ([string]$engine.ExecutablePath) ([string]$inputValue.powerShellPath))) { Fail-Closed }
        $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $enginePid) -ErrorAction Stop)
        $matches = @($children | Where-Object {
            (Same-Path ([string]$_.ExecutablePath) ([string]$inputValue.nodePath)) -and
            (Has-Exact-Token ([string]$_.CommandLine) ([string]$spec.modulePath))
        })
        if ($matches.Count -ne 1) { Fail-Closed }
        $leaf = $matches[0]
        $pidValue = [int64]$leaf.ProcessId
        if ([int64]$leaf.ParentProcessId -ne $enginePid) { Fail-Closed }
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int64]$_.OwningProcess -eq $pidValue })
        if ($null -ne $spec.listenerPort) {
            $port = [int]$spec.listenerPort
            $fixed = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
            if ($fixed.Count -lt 1 -or @($fixed | Where-Object { [int64]$_.OwningProcess -ne $pidValue }).Count -ne 0) { Fail-Closed }
            $listeners = $fixed
        } elseif ($listeners.Count -lt 1) { Fail-Closed }
        $listenerIdentity = [string]::Join([Environment]::NewLine, @($listeners | ForEach-Object {
            "{0}|{1}|{2}" -f ([string]$_.LocalAddress), ([int]$_.LocalPort), ([int64]$_.OwningProcess)
        } | Sort-Object))
        $engineCreatedAt = Iso-Utc $engine.CreationDate
        $createdAt = Iso-Utc $leaf.CreationDate
        $instanceMaterial = "xw.gate-f-task-instance.v1:{0}|{1}|{2}|{3}|{4}" -f ([string]$spec.taskName), ([string]$instance.InstanceGuid), $enginePid, $engineCreatedAt, ([string]$instance.CurrentAction)
        $rows += [ordered]@{
            role = [string]$spec.role
            taskName = [string]$spec.taskName
            taskInstanceSha256 = Hash-Text $instanceMaterial
            enginePid = $enginePid
            engineParentPid = [int64]$engine.ParentProcessId
            engineCreatedAt = $engineCreatedAt
            pid = $pidValue
            parentPid = [int64]$leaf.ParentProcessId
            createdAt = $createdAt
            moduleSha256 = ([string](Get-FileHash -LiteralPath ([string]$spec.modulePath) -Algorithm SHA256).Hash).ToLowerInvariant()
            listenerIdentitySha256 = Hash-Text ("xw.gate-f-listener.v1:{0}|{1}" -f ([string]$spec.role), $listenerIdentity)
        }
    }
    [ordered]@{
        schemaId = "xw.runtime.gate-f-task-owned-process-closure.v1"
        releaseId = [string]$inputValue.releaseId
        sourceCommit = [string]$inputValue.sourceCommit
        inspectedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        rows = $rows
    } | ConvertTo-Json -Depth 5 -Compress
} catch { Fail-Closed }
`;
const ARTIFACT_KEYS = Object.freeze(["bytesBase64", "path", "sha256"]);
const IDENTITY_ARTIFACT_KEYS = Object.freeze(["path", "sha256"]);
const SNAPSHOT_KEYS = Object.freeze(["snapshotPath", "snapshotSha256", "targetPath"]);
const LEGACY_PRESTATE_KEYS = Object.freeze([
  "current", "liveIdentity", "releaseManifest", "runtimeBindings", "runtimeRoot", "schemaId",
  "snapshots", "systemTaskClosure", "tasks", "trustedNode",
]);
const M64_ASSEMBLER_RECEIPT_KEYS = Object.freeze([
  "artifactCatalog", "inventories", "privateKeyMaterialRead", "productionDependencyBinding",
  "publicationDurability", "receiptHash", "release", "runtimeBinding", "schemaId",
  "secretMaterialPresent", "signatureGenerated",
]);
const FINAL_LAUNCHER_VALIDATION_KEYS = Object.freeze([
  "bindingSha256", "delegate", "fixedRuntimeBindings", "launcherSha256", "ok",
  "privateMaterial", "provider", "releaseId", "schemaId", "sourceCommit", "trustedNode",
]);

function fail(code, message, details = undefined) {
  throw Object.assign(new Error(`${code}: ${message}`), { code, ...(details ? { details } : {}) });
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(code, `${label} exact schema drifted`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pathKey(value) {
  const full = resolve(value);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function within(root, candidate, { allowRoot = false } = {}) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return allowRoot;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function absolutePath(value, code, label) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code, `${label} must be absolute`);
  return resolve(value);
}

function assertPlainFile(path, code, label) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(code, `${label} is absent`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !samePath(realpathSync(path), path)) {
    fail(code, `${label} must be a single-link regular file`);
  }
}

function assertPlainDirectory(path, code, label) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(code, `${label} is absent`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    fail(code, `${label} must be a plain directory`);
  }
}

function assertPlainRuntimeChain(runtimeRoot, targetPath, code, { allowTargetLink = false } = {}) {
  const root = resolve(runtimeRoot);
  const target = resolve(targetPath);
  if (!within(root, target, { allowRoot: true })) fail(code, "path escaped the runtime root");
  assertPlainDirectory(root, code, "runtime root");
  const parts = relative(root, target).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const stat = lstatSync(cursor);
    const final = index === parts.length - 1;
    if (stat.isSymbolicLink() && !(final && allowTargetLink)) {
      fail(code, `${cursor} traverses a symlink/reparse point`);
    }
  }
}

function readPlainBytes(path, code, label, maxBytes = 8 * 1024 * 1024) {
  assertPlainFile(path, code, label);
  const bytes = readFileSync(path);
  if (bytes.length < 1 || bytes.length > maxBytes) fail(code, `${label} size is invalid`);
  return bytes;
}

function parseJsonBytes(bytes, code, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(code, `${label} is not valid UTF-8 JSON`); }
}

function readCanonicalJson(path, code, label) {
  const bytes = readPlainBytes(path, code, label);
  const value = parseJsonBytes(bytes, code, label);
  if (!bytes.equals(canonicalJsonBytes(value))) fail(code, `${label} is not canonical LF JSON`);
  return Object.freeze({ bytes, value });
}

function decodeArtifact(artifact, code, label) {
  const keys = Object.hasOwn(Object(artifact), "providerBundleDigest")
    ? [...ARTIFACT_KEYS, "providerBundleDigest"] : ARTIFACT_KEYS;
  exactObject(artifact, keys, code, label);
  absolutePath(artifact.path, code, `${label}.path`);
  if (!HEX64.test(artifact.sha256 || "") || typeof artifact.bytesBase64 !== "string"
    || artifact.bytesBase64.length > 16 * 1024 * 1024) {
    fail(code, `${label} hash or byte encoding is invalid`);
  }
  const bytes = Buffer.from(artifact.bytesBase64, "base64");
  if (bytes.length < 1 || bytes.toString("base64") !== artifact.bytesBase64
    || sha256(bytes) !== artifact.sha256) {
    fail(code, `${label} bytes do not match their SHA-256`);
  }
  return bytes;
}

function identityArtifact(value, code, label) {
  exactObject(value, IDENTITY_ARTIFACT_KEYS, code, label);
  absolutePath(value.path, code, `${label}.path`);
  if (!HEX64.test(value.sha256 || "")) fail(code, `${label} SHA-256 is invalid`);
  return value;
}

function validateSystemTaskClosure(value, runtimeRoot, code) {
  exactObject(
    value,
    ["deviceConfig", "fastOperatorLauncher", "orchestratorLauncher", "windowsPowerShell"],
    code,
    "systemTaskClosure",
  );
  const expected = {
    windowsPowerShell: WINDOWS_POWERSHELL_EXECUTABLE,
    orchestratorLauncher: join(runtimeRoot, "secrets", "launch-orchestrator.ps1"),
    fastOperatorLauncher: join(runtimeRoot, "launch-fast-operator-serve.ps1"),
    deviceConfig: join(runtimeRoot, "secrets", "control-plane.devices.json"),
  };
  for (const [key, path] of Object.entries(expected)) {
    identityArtifact(value[key], code, `systemTaskClosure.${key}`);
    if (!samePath(value[key].path, path)) fail(code, `systemTaskClosure.${key} path drifted`);
  }
  return value;
}

function validateXhsV3PrivateRoots(value, runtimeRoot, code) {
  if (!Array.isArray(value) || value.length !== XHS_V3_PRIVATE_ROOT_NAMES.length) {
    fail(code, "exact XHS V3 private writer roots are required");
  }
  const expectedBase = join(runtimeRoot, "private", "xhs-v3");
  for (let index = 0; index < XHS_V3_PRIVATE_ROOT_NAMES.length; index += 1) {
    if (!samePath(value[index], join(expectedBase, XHS_V3_PRIVATE_ROOT_NAMES[index]))) {
      fail(code, "XHS V3 private writer root order/path drifted");
    }
  }
  return value;
}

function readIdentityBytes(value, code, label, { allowTrustedOsHardlink = false } = {}) {
  let bytes;
  if (allowTrustedOsHardlink) {
    let stat;
    try { stat = lstatSync(value.path); } catch { fail(code, `${label} is absent`); }
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync(value.path), value.path)) {
      fail(code, `${label} is not the exact regular OS executable`);
    }
    bytes = readFileSync(value.path);
    if (bytes.length < 1 || bytes.length > 256 * 1024 * 1024) fail(code, `${label} size is invalid`);
  } else {
    bytes = readPlainBytes(value.path, code, label, 256 * 1024 * 1024);
  }
  return bytes;
}

function verifyIdentityArtifactOnDisk(value, code, label, options = {}) {
  const bytes = readIdentityBytes(value, code, label, options);
  if (sha256(bytes) !== value.sha256) fail(code, `${label} bytes drifted`);
}

function validateSnapshotDescriptor(value, runtimeRoot, expectedTarget, code, label) {
  exactObject(value, SNAPSHOT_KEYS, code, label);
  absolutePath(value.targetPath, code, `${label}.targetPath`);
  absolutePath(value.snapshotPath, code, `${label}.snapshotPath`);
  if (!samePath(value.targetPath, expectedTarget) || !HEX64.test(value.snapshotSha256 || "")
    || !within(join(runtimeRoot, "rollback-snapshots"), value.snapshotPath)) {
    fail(code, `${label} escaped its fixed target or protected snapshot namespace`);
  }
  return value;
}

function snapshotRef(value, runtimeRoot, expectedTarget, code, label) {
  validateSnapshotDescriptor(value, runtimeRoot, expectedTarget, code, label);
  assertPlainRuntimeChain(runtimeRoot, value.snapshotPath, code);
  const bytes = readPlainBytes(value.snapshotPath, code, label, 1024 * 1024 * 1024);
  if (sha256(bytes) !== value.snapshotSha256) fail(code, `${label} snapshot bytes drifted`);
  return value;
}

function xmlUnescape(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlQuoted(value) {
  if (typeof value !== "string" || value === "" || /["\r\n]/u.test(value)) {
    fail("GATE_F_CUTOVER_TASK_INVALID", "fixed task argument is not safely quotable");
  }
  return `&quot;${xmlEscape(resolve(value))}&quot;`;
}

export function buildGateFAuxiliaryTaskXml({ runtimeRoot, taskName } = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_TASK_INVALID", "runtimeRoot");
  const spec = AUXILIARY_TASK_SPECS.find((row) => row.name === taskName);
  if (!spec) fail("GATE_F_CUTOVER_TASK_INVALID", "auxiliary task name is not fixed");
  const launcherPath = spec.alias === null
    ? join(runtime, "secrets", "launch-orchestrator.ps1")
    : join(runtime, "launch-fast-operator-serve.ps1");
  const argumentsText = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy Bypass",
    "-File", xmlQuoted(launcherPath),
    ...(spec.alias === null ? [] : [
      "-LaunchConfig",
      xmlQuoted(join(runtime, "state", "control-plane", "fast-operator", `serve-launch-${spec.alias}.json`)),
    ]),
  ].join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>xw-platform Gate F</Author>
    <Description>Identity-pinned ${xmlEscape(taskName)} activation task.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>SYSTEM</UserId>
      <LogonType>ServiceAccount</LogonType>
      <RunLevel>${spec.alias === null ? "LeastPrivilege" : "HighestAvailable"}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>
      <Arguments>${argumentsText}</Arguments>
      <WorkingDirectory>${xmlEscape(runtime)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function gateFAuxiliaryTaskFilename(taskName) {
  const spec = AUXILIARY_TASK_SPECS.find((row) => row.name === taskName);
  if (!spec) fail("GATE_F_CUTOVER_TASK_INVALID", "auxiliary task name is not fixed");
  return spec.filename;
}

function oneXmlValue(xml, tag, code) {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu"))];
  if (matches.length !== 1) fail(code, `task XML must contain exactly one ${tag}`);
  return xmlUnescape(matches[0][1]);
}

function taskEnabledValue(xml, { allowMissing = false } = {}) {
  const code = "GATE_F_CUTOVER_TASK_INVALID";
  const settingsMatches = [...xml.matchAll(/<Settings>([\s\S]*?)<\/Settings>/gu)];
  if (settingsMatches.length !== 1) fail(code, "task XML must contain exactly one Settings");
  const enabledMatches = [...settingsMatches[0][1].matchAll(/<Enabled>([\s\S]*?)<\/Enabled>/gu)];
  if (enabledMatches.length === 0 && allowMissing) return "true";
  if (enabledMatches.length !== 1) fail(code, "task Settings must contain exactly one Enabled");
  return xmlUnescape(enabledMatches[0][1]);
}

function parseTaskDefinition(xml, {
  allowLegacyLauncher = false,
  allowNativeLegacyDefaults = false,
} = {}) {
  if (typeof xml !== "string" || xml.length < 64 || xml.length > 256 * 1024
    || (!allowLegacyLauncher && /\.simple(?:\.|\s|&quot;|<)/iu.test(xml))) {
    fail(
      "GATE_F_CUTOVER_TASK_INVALID",
      `task XML is absent, oversized, or invokes ${allowLegacyLauncher ? "an invalid" : "a legacy"} launcher`,
    );
  }
  const principal = oneXmlValue(xml, "UserId", "GATE_F_CUTOVER_TASK_INVALID");
  return Object.freeze({
    principal: allowNativeLegacyDefaults && principal === "S-1-5-18" ? "SYSTEM" : principal,
    enabled: taskEnabledValue(xml, { allowMissing: allowNativeLegacyDefaults }) === "true",
    action: Object.freeze({
      command: oneXmlValue(xml, "Command", "GATE_F_CUTOVER_TASK_INVALID"),
      arguments: oneXmlValue(xml, "Arguments", "GATE_F_CUTOVER_TASK_INVALID"),
      workingDirectory: oneXmlValue(xml, "WorkingDirectory", "GATE_F_CUTOVER_TASK_INVALID"),
    }),
  });
}

export function parseFormalTaskDefinition(xml) {
  return parseTaskDefinition(xml, { allowLegacyLauncher: false });
}

export function parseLegacyTaskDefinition(xml) {
  return parseTaskDefinition(xml, {
    allowLegacyLauncher: true,
    allowNativeLegacyDefaults: true,
  });
}

function sameTaskDefinition(actual, expected) {
  const commandMatches = actual?.action?.command === expected.action.command
    || actual?.action?.command === expected.action.command.replace(
      /^%SystemRoot%/iu,
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
    );
  return actual?.principal === "SYSTEM" && actual?.enabled === true
    && commandMatches
    && actual?.action?.arguments === expected.action.arguments
    && samePath(actual?.action?.workingDirectory || "", expected.action.workingDirectory);
}

function manifestEntry(manifest, relativePath, code) {
  const matches = Array.isArray(manifest?.files)
    ? manifest.files.filter((entry) => entry?.path === relativePath) : [];
  if (matches.length !== 1 || !HEX64.test(matches[0]?.sha256 || "")) {
    fail(code, `release manifest does not uniquely pin ${relativePath}`);
  }
  return matches[0];
}

function fixedQualificationPackagePath(runtimeRoot, sourceCommit, packageHash) {
  return join(
    runtimeRoot,
    "m6-audit",
    `m6-c1-qualification-bootstrap-${sourceCommit.slice(0, 7)}`,
    "packages",
    `${packageHash}.package.json`,
  );
}

function validateGateHandoffDescriptor(value, {
  runtimeRoot,
  releaseId,
  sourceCommit,
  expectedGateId = null,
  code = "GATE_F_CUTOVER_TUPLE_INVALID",
} = {}) {
  exactObject(
    value,
    ["closedEpochHash", "gateId", "locksHash", "package", "packageHash", "pointer", "schemaId"],
    code,
    "gateHandoff",
  );
  if (value.schemaId !== GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID
    || !HEX64.test(value.closedEpochHash || "") || !HEX64.test(value.locksHash || "")
    || !HEX64.test(value.packageHash || "")
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.gateId || "")
    || (expectedGateId !== null && value.gateId !== expectedGateId)) {
    fail(code, "cross-release Gate handoff identity drifted");
  }
  identityArtifact(value.package, code, "gateHandoff.package");
  if (!samePath(
    value.package.path,
    fixedQualificationPackagePath(runtimeRoot, sourceCommit, value.packageHash),
  )) fail(code, "cross-release Gate package escaped its fixed release/source audit root");
  const pointerBytes = decodeArtifact(value.pointer, code, "gateHandoff.pointer");
  const pointer = parseJsonBytes(pointerBytes, code, "gateHandoff.pointer");
  exactObject(pointer, ["chain", "generation", "promotedAt", "tailEpochHash"], code, "Gate pointer");
  if (!pointerBytes.equals(canonicalJsonBytes(pointer))
    || !Array.isArray(pointer.chain) || pointer.chain.length !== 2
    || pointer.chain[1] !== value.closedEpochHash
    || pointer.tailEpochHash !== value.closedEpochHash || pointer.generation !== 0
    || !Number.isFinite(Date.parse(pointer.promotedAt || ""))
    || !samePath(value.pointer.path, join(runtimeRoot, "m6-gate", value.gateId, "current.json"))) {
    fail(code, "cross-release Gate pointer is not the exact generation-0 CLOSED target");
  }
  if (!RELEASE_ID.test(releaseId || "") || !HEX40.test(sourceCommit || "")) {
    fail(code, "cross-release Gate target release identity is invalid");
  }
  return Object.freeze({ pointer, pointerBytes });
}

function validateCoreTupleShape(tuple, expectedRuntimeRoot) {
  const code = "GATE_F_CUTOVER_TUPLE_INVALID";
  exactObject(tuple, TUPLE_KEYS, code, "cutover tuple");
  if (tuple.schemaId !== GATE_F_CUTOVER_TUPLE_SCHEMA_ID) fail(code, "tuple schema ID drifted");
  const runtimeRoot = absolutePath(tuple.runtimeRoot, code, "runtimeRoot");
  if (expectedRuntimeRoot && !samePath(runtimeRoot, expectedRuntimeRoot)) {
    fail(code, "tuple runtime root differs from the fixed operator root");
  }
  exactObject(tuple.release, ["manifest", "releaseId", "root", "sourceCommit"], code, "release");
  if (!RELEASE_ID.test(tuple.release.releaseId || "") || !HEX40.test(tuple.release.sourceCommit || "")) {
    fail(code, "release identity is invalid");
  }
  absolutePath(tuple.release.root, code, "release.root");
  if (!samePath(tuple.release.root, join(runtimeRoot, "releases", tuple.release.releaseId))) {
    fail(code, "release root escaped releases/<releaseId>");
  }
  const manifestBytes = decodeArtifact(tuple.release.manifest, code, "release.manifest");
  if (!samePath(tuple.release.manifest.path, join(tuple.release.root, "release-manifest.v1.json"))) {
    fail(code, "manifest path is not the fixed release manifest");
  }
  const manifest = parseJsonBytes(manifestBytes, code, "release.manifest");
  if (!manifestBytes.equals(canonicalJsonBytes(manifest))
    || manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.sourceRepo !== FORMAL_RELEASE_SOURCE_REPO
    || manifest.releaseId !== tuple.release.releaseId
    || manifest.sourceCommit !== tuple.release.sourceCommit
    || manifest.runtimeCutoverAllowed !== false) {
    fail(code, "release manifest identity or canonical bytes drifted");
  }

  const operatorBytes = decodeArtifact(tuple.operator, code, "operator");
  const operatorPath = join(tuple.release.root, ...GATE_F_CUTOVER_OPERATOR_RELEASE_PATH.split("/"));
  if (!samePath(tuple.operator.path, operatorPath)
    || manifestEntry(manifest, GATE_F_CUTOVER_OPERATOR_RELEASE_PATH, code).sha256 !== tuple.operator.sha256) {
    fail(code, "operator is not the tracked manifest-pinned release artifact");
  }

  exactObject(tuple.current, ["path", "target"], code, "current");
  if (!samePath(tuple.current.path, join(runtimeRoot, "current"))
    || !samePath(tuple.current.target, tuple.release.root)) {
    fail(code, "current pointer does not bind the release root");
  }

  exactObject(tuple.formal, ["binding", "launcher", "task"], code, "formal");
  const bindingBytes = decodeArtifact(tuple.formal.binding, code, "formal.binding");
  const binding = parseJsonBytes(bindingBytes, code, "formal.binding");
  if (!bindingBytes.equals(canonicalJsonBytes(binding))
    || binding.schemaId !== GATE_F_LAUNCHER_BINDING_SCHEMA_ID
    || binding.mode !== "FINAL" || binding.taskName !== FORMAL_CONTROL_PLANE_TASK_NAME
    || binding.releaseId !== tuple.release.releaseId || binding.sourceCommit !== tuple.release.sourceCommit
    || !samePath(binding.runtimeRoot, runtimeRoot) || !samePath(binding.currentPath, tuple.current.path)
    || !samePath(binding.releaseRoot, tuple.release.root)
    || !samePath(binding.releaseManifestPath, tuple.release.manifest.path)
    || binding.releaseManifestSha256 !== tuple.release.manifest.sha256
    || !samePath(tuple.formal.binding.path, join(
      runtimeRoot, "launcher-bindings", tuple.formal.binding.sha256, FORMAL_BINDING_FILENAME,
    ))) {
    fail(code, "formal binding identity or address drifted");
  }

  const launcherBytes = decodeArtifact(tuple.formal.launcher, code, "formal.launcher");
  if (!samePath(tuple.formal.launcher.path, binding.launcherPath)
    || tuple.formal.launcher.sha256 !== binding.launcherSha256
    || !samePath(tuple.formal.launcher.path, join(
      runtimeRoot, "launchers", tuple.formal.launcher.sha256, FORMAL_LAUNCHER_FILENAME,
    ))) {
    fail(code, "formal launcher identity or address drifted");
  }
  void launcherBytes;

  exactObject(tuple.formal.task, ["action", "name", "principal", "xml"], code, "formal.task");
  const taskXmlBytes = decodeArtifact(tuple.formal.task.xml, code, "formal.task.xml");
  const taskXml = taskXmlBytes.toString("utf8");
  const expectedTaskXml = buildFormalControlPlaneTaskXml({
    runtimeRoot,
    launcherPath: tuple.formal.launcher.path,
    bindingPath: tuple.formal.binding.path,
    launcherSha256: tuple.formal.launcher.sha256,
    bindingSha256: tuple.formal.binding.sha256,
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    taskName: FORMAL_CONTROL_PLANE_TASK_NAME,
  });
  const taskDefinition = parseFormalTaskDefinition(taskXml);
  exactObject(tuple.formal.task.action, ["arguments", "command", "workingDirectory"], code, "task action");
  if (tuple.formal.task.name !== FORMAL_CONTROL_PLANE_TASK_NAME
    || tuple.formal.task.principal !== "SYSTEM"
    || taskXml !== expectedTaskXml
    || !sameTaskDefinition({ principal: tuple.formal.task.principal, enabled: true, action: tuple.formal.task.action }, taskDefinition)
    || !samePath(tuple.formal.task.xml.path, join(
      runtimeRoot, "task-bindings", tuple.formal.task.xml.sha256, FORMAL_TASK_XML_FILENAME,
    ))) {
    fail(code, "formal SYSTEM task XML/action drifted");
  }
  buildCreateOnlyTaskRegistration({ taskXmlPath: tuple.formal.task.xml.path, taskName: tuple.formal.task.name });

  if (!Array.isArray(tuple.activationTasks)
    || tuple.activationTasks.length !== AUXILIARY_TASK_SPECS.length) {
    fail(code, "the exact three auxiliary activation tasks are required");
  }
  const activationTaskDefinitions = [];
  for (let index = 0; index < AUXILIARY_TASK_SPECS.length; index += 1) {
    const spec = AUXILIARY_TASK_SPECS[index];
    const task = exactObject(
      tuple.activationTasks[index],
      ["action", "name", "principal", "xml"],
      code,
      `activationTasks[${index}]`,
    );
    exactObject(task.action, ["arguments", "command", "workingDirectory"], code, `${spec.name} action`);
    const xmlBytes = decodeArtifact(task.xml, code, `${spec.name} XML`);
    const xml = xmlBytes.toString("utf8");
    const expectedXml = buildGateFAuxiliaryTaskXml({ runtimeRoot, taskName: spec.name });
    const definition = parseFormalTaskDefinition(xml);
    if (task.name !== spec.name || task.principal !== "SYSTEM" || xml !== expectedXml
      || !sameTaskDefinition({ principal: task.principal, enabled: true, action: task.action }, definition)
      || !samePath(task.xml.path, join(
        runtimeRoot, "task-bindings", task.xml.sha256, spec.filename,
      ))) {
      fail(code, `${spec.name} XML/action/address drifted`);
    }
    activationTaskDefinitions.push(definition);
  }

  exactObject(tuple.trustedNode, ["path", "sha256", "version"], code, "trustedNode");
  if (!samePath(tuple.trustedNode.path, TRUSTED_NODE_EXECUTABLE)
    || tuple.trustedNode.path !== binding.trustedNodePath
    || tuple.trustedNode.sha256 !== binding.trustedNodeSha256
    || !HEX64.test(tuple.trustedNode.sha256 || "")
    || tuple.trustedNode.version !== manifest.nodeVersion
    || !/^\d+\.\d+\.\d+$/u.test(tuple.trustedNode.version || "")) {
    fail(code, "trusted Node path/version/hash drifted");
  }
  validateSystemTaskClosure(tuple.systemTaskClosure, runtimeRoot, code);
  validateXhsV3PrivateRoots(tuple.xhsV3PrivateRoots, runtimeRoot, code);

  exactObject(
    tuple.runtimeBindings,
    ["digestKeyring", "m6Final", "provider", "secretEnvironment", "serve03", "serve04"],
    code,
    "runtimeBindings",
  );
  const m6Bytes = decodeArtifact(tuple.runtimeBindings.m6Final, code, "runtimeBindings.m6Final");
  const serve03Bytes = decodeArtifact(tuple.runtimeBindings.serve03, code, "runtimeBindings.serve03");
  const serve04Bytes = decodeArtifact(tuple.runtimeBindings.serve04, code, "runtimeBindings.serve04");
  const providerBytes = decodeArtifact(tuple.runtimeBindings.provider, code, "runtimeBindings.provider");
  const m6 = parseJsonBytes(m6Bytes, code, "M6 FINAL binding");
  const serve03 = parseJsonBytes(serve03Bytes, code, "serve03 binding");
  const serve04 = parseJsonBytes(serve04Bytes, code, "serve04 binding");
  exactObject(tuple.runtimeBindings.provider, ["bytesBase64", "path", "providerBundleDigest", "sha256"], code, "provider");
  if (!HEX64.test(tuple.runtimeBindings.provider.providerBundleDigest || "")
    || !samePath(tuple.runtimeBindings.m6Final.path, binding.m6FinalBindingPath)
    || tuple.runtimeBindings.m6Final.sha256 !== binding.m6FinalBindingSha256
    || !samePath(tuple.runtimeBindings.serve03.path, binding.serveLaunch03Path)
    || tuple.runtimeBindings.serve03.sha256 !== binding.serveLaunch03Sha256
    || !samePath(tuple.runtimeBindings.serve04.path, binding.serveLaunch04Path)
    || tuple.runtimeBindings.serve04.sha256 !== binding.serveLaunch04Sha256
    || !samePath(tuple.runtimeBindings.provider.path, binding.providerConfigPath)
    || tuple.runtimeBindings.provider.sha256 !== binding.providerConfigSha256
    || tuple.runtimeBindings.provider.providerBundleDigest !== binding.providerBundleDigest) {
    fail(code, "runtime binding paths or hashes differ from the formal binding");
  }
  void providerBytes;
  if (m6.schemaId !== "xw.runtime.m6-c1-runtime.v1"
    || m6.releaseId !== tuple.release.releaseId || m6.sourceCommit !== tuple.release.sourceCommit
    || !samePath(m6.sourceReleaseRoot, tuple.release.root)
    || m6.releaseManifestSha256 !== tuple.release.manifest.sha256
    || m6.gateId !== tuple.gateHandoff?.gateId) {
    fail(code, "M6 FINAL release identity drifted");
  }
  const gateHandoff = validateGateHandoffDescriptor(tuple.gateHandoff, {
    runtimeRoot,
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    expectedGateId: m6.gateId,
    code,
  });
  for (const [value, alias] of [[serve03, "03"], [serve04, "04"]]) {
    if (value.schemaVersion !== 2 || value.alias !== alias
      || value.releaseId !== tuple.release.releaseId || value.sourceCommit !== tuple.release.sourceCommit
      || !samePath(value.runtimeRoot, runtimeRoot) || !samePath(value.nodeExe, TRUSTED_NODE_EXECUTABLE)) {
      fail(code, `serve${alias} release identity drifted`);
    }
  }
  identityArtifact(tuple.runtimeBindings.secretEnvironment, code, "secretEnvironment");
  identityArtifact(tuple.runtimeBindings.digestKeyring, code, "digestKeyring");
  if (!samePath(tuple.runtimeBindings.secretEnvironment.path, binding.secretEnvironmentPath)
    || tuple.runtimeBindings.secretEnvironment.sha256 !== binding.secretEnvironmentSha256
    || !samePath(tuple.runtimeBindings.digestKeyring.path, binding.digestKeyringPath)
    || tuple.runtimeBindings.digestKeyring.sha256 !== binding.digestKeyringSha256) {
    fail(code, "private-material identities differ from the formal binding");
  }
  if (!samePath(tuple.runtimeBindings.m6Final.path, join(runtimeRoot, "config", "m6-c1-runtime.v1.json"))
    || !samePath(tuple.runtimeBindings.serve03.path, join(
      runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json",
    ))
    || !samePath(tuple.runtimeBindings.serve04.path, join(
      runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json",
    ))
    || !samePath(tuple.runtimeBindings.provider.path, join(
      runtimeRoot, "state", "orchestrator", "xhs-exploration-vision-provider.v1.json",
    ))
    || !samePath(tuple.runtimeBindings.secretEnvironment.path, join(
      runtimeRoot, "secrets", "control-plane-secret-environment.v1.json",
    ))
    || !samePath(tuple.runtimeBindings.digestKeyring.path, join(
      runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json",
    ))) {
    fail(code, "runtime bindings escaped their fixed namespaces");
  }

  exactObject(tuple.liveIdentity, ["controlPlane", "gate", "registry"], code, "liveIdentity");
  for (const [value, url, label] of [
    [tuple.liveIdentity.controlPlane, GATE_F_CONTROL_HEALTH_URL, "controlPlane"],
    [tuple.liveIdentity.registry, GATE_F_REGISTRY_HEALTH_URL, "registry"],
  ]) {
    exactObject(value, ["releaseId", "sourceCommit", "url"], code, label);
    if (value.url !== url || value.releaseId !== tuple.release.releaseId
      || value.sourceCommit !== tuple.release.sourceCommit) fail(code, `${label} identity drifted`);
  }
  exactObject(tuple.liveIdentity.gate, ["mode", "phase", "url"], code, "gate");
  if (tuple.liveIdentity.gate.url !== GATE_F_STATUS_URL
    || tuple.liveIdentity.gate.mode !== "CLOSED" || tuple.liveIdentity.gate.phase !== "CLOSED") {
    fail(code, "Gate-F live identity must be fixed CLOSED");
  }

  exactObject(tuple.snapshots, ["controlDb", "privateMaterial", "registryDb"], code, "snapshots");
  if (!Array.isArray(tuple.snapshots.privateMaterial) || tuple.snapshots.privateMaterial.length !== 2) {
    fail(code, "exactly two private-material snapshot refs are required");
  }
  validateSnapshotDescriptor(tuple.snapshots.controlDb, runtimeRoot,
    join(runtimeRoot, "state", "control-plane", "control.db"), code, "control DB snapshot");
  validateSnapshotDescriptor(tuple.snapshots.registryDb, runtimeRoot,
    join(runtimeRoot, "state", "orchestrator", REGISTRY_DATABASE_FILENAME), code, "registry DB snapshot");
  validateSnapshotDescriptor(tuple.snapshots.privateMaterial[0], runtimeRoot,
    tuple.runtimeBindings.secretEnvironment.path, code, "secret environment snapshot");
  validateSnapshotDescriptor(tuple.snapshots.privateMaterial[1], runtimeRoot,
    tuple.runtimeBindings.digestKeyring.path, code, "digest keyring snapshot");
  if (tuple.snapshots.privateMaterial[0].snapshotSha256
      !== tuple.runtimeBindings.secretEnvironment.sha256
    || tuple.snapshots.privateMaterial[1].snapshotSha256
      !== tuple.runtimeBindings.digestKeyring.sha256) {
    fail(code, "private-material snapshots do not reproduce the bound secret/keyring identities");
  }
  return Object.freeze({
    runtimeRoot,
    manifest,
    binding,
    taskDefinition,
    gateHandoff,
    activationTaskDefinitions: Object.freeze(activationTaskDefinitions),
    decoded: Object.freeze({ m6Bytes, serve03Bytes, serve04Bytes }),
  });
}

export function validateGateFCutoverTupleDocument(tuple, { expectedRuntimeRoot } = {}) {
  return validateCoreTupleShape(tuple, expectedRuntimeRoot);
}

export function validateGateFLegacyPrestateDocument(prestate, { expectedRuntimeRoot } = {}) {
  const code = "GATE_F_LEGACY_PRESTATE_INVALID";
  exactObject(prestate, LEGACY_PRESTATE_KEYS, code, "legacy prestate");
  if (prestate.schemaId !== GATE_F_LEGACY_PRESTATE_SCHEMA_ID) {
    fail(code, "legacy prestate schema ID drifted");
  }
  const runtimeRoot = absolutePath(prestate.runtimeRoot, code, "runtimeRoot");
  if (expectedRuntimeRoot && !samePath(runtimeRoot, expectedRuntimeRoot)) {
    fail(code, "legacy prestate runtime root differs from the fixed operator root");
  }
  exactObject(prestate.current, ["path", "releaseId", "sourceCommit", "target"], code, "current");
  if (!RELEASE_ID.test(prestate.current.releaseId || "")
    || !HEX40.test(prestate.current.sourceCommit || "")
    || !samePath(prestate.current.path, join(runtimeRoot, "current"))
    || !samePath(prestate.current.target, join(
      runtimeRoot, "releases", prestate.current.releaseId,
    ))) fail(code, "legacy current release identity escaped the fixed layout");

  const manifestBytes = decodeArtifact(prestate.releaseManifest, code, "releaseManifest");
  const manifest = parseJsonBytes(manifestBytes, code, "releaseManifest");
  if (!manifestBytes.equals(canonicalJsonBytes(manifest))
    || !samePath(prestate.releaseManifest.path, join(
      prestate.current.target, "release-manifest.v1.json",
    ))
    || manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.releaseId !== prestate.current.releaseId
    || manifest.sourceCommit !== prestate.current.sourceCommit) {
    fail(code, "legacy release manifest/current identity drifted");
  }

  if (!Array.isArray(prestate.tasks) || prestate.tasks.length !== TASKS_TO_ACTIVATE.length) {
    fail(code, "legacy prestate must pin the exact four activation tasks");
  }
  const taskDefinitions = [];
  for (let index = 0; index < TASKS_TO_ACTIVATE.length; index += 1) {
    const taskName = TASKS_TO_ACTIVATE[index];
    const task = exactObject(
      prestate.tasks[index],
      ["action", "name", "principal", "xml"],
      code,
      `tasks[${index}]`,
    );
    exactObject(task.action, ["arguments", "command", "workingDirectory"], code, `${taskName} action`);
    const xmlBytes = decodeArtifact(task.xml, code, `${taskName} XML`);
    const definition = parseLegacyTaskDefinition(xmlBytes.toString("utf8"));
    const filename = index === 0 ? FORMAL_TASK_XML_FILENAME : AUXILIARY_TASK_SPECS[index - 1].filename;
    if (task.name !== taskName || task.principal !== "SYSTEM"
      || !sameTaskDefinition({ principal: task.principal, enabled: true, action: task.action }, definition)
      || !samePath(task.xml.path, join(
        runtimeRoot, "legacy-task-bindings", task.xml.sha256, filename,
      ))) fail(code, `${taskName} legacy XML/action/address drifted`);
    taskDefinitions.push(definition);
  }

  exactObject(prestate.trustedNode, ["path", "sha256", "version"], code, "trustedNode");
  if (!samePath(prestate.trustedNode.path, TRUSTED_NODE_EXECUTABLE)
    || !HEX64.test(prestate.trustedNode.sha256 || "")
    || !/^\d+\.\d+\.\d+$/u.test(prestate.trustedNode.version || "")) {
    fail(code, "legacy trusted Node identity drifted");
  }
  validateSystemTaskClosure(prestate.systemTaskClosure, runtimeRoot, code);

  exactObject(
    prestate.runtimeBindings,
    ["digestKeyring", "m6Final", "provider", "secretEnvironment", "serve03", "serve04"],
    code,
    "runtimeBindings",
  );
  const m6Bytes = decodeArtifact(prestate.runtimeBindings.m6Final, code, "m6Final");
  const serve03Bytes = decodeArtifact(prestate.runtimeBindings.serve03, code, "serve03");
  const serve04Bytes = decodeArtifact(prestate.runtimeBindings.serve04, code, "serve04");
  decodeArtifact(prestate.runtimeBindings.provider, code, "provider");
  exactObject(
    prestate.runtimeBindings.provider,
    ["bytesBase64", "path", "providerBundleDigest", "sha256"],
    code,
    "provider",
  );
  identityArtifact(prestate.runtimeBindings.secretEnvironment, code, "secretEnvironment");
  identityArtifact(prestate.runtimeBindings.digestKeyring, code, "digestKeyring");
  if (!samePath(prestate.runtimeBindings.m6Final.path, join(runtimeRoot, "config", "m6-c1-runtime.v1.json"))
    || !samePath(prestate.runtimeBindings.serve03.path, join(
      runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json",
    ))
    || !samePath(prestate.runtimeBindings.serve04.path, join(
      runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json",
    ))
    || !samePath(prestate.runtimeBindings.provider.path, join(
      runtimeRoot, "state", "orchestrator", "xhs-exploration-vision-provider.v1.json",
    ))
    || !samePath(prestate.runtimeBindings.secretEnvironment.path, join(
      runtimeRoot, "secrets", "control-plane-secret-environment.v1.json",
    ))
    || !samePath(prestate.runtimeBindings.digestKeyring.path, join(
      runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json",
    ))) fail(code, "legacy runtime bindings escaped fixed slots");

  for (const [bytes, label] of [[m6Bytes, "M6"], [serve03Bytes, "serve03"], [serve04Bytes, "serve04"]]) {
    const value = parseJsonBytes(bytes, code, label);
    if (value.releaseId !== prestate.current.releaseId
      || value.sourceCommit !== prestate.current.sourceCommit) {
      fail(code, `${label} legacy release identity drifted`);
    }
  }

  exactObject(prestate.liveIdentity, ["controlPlane", "gate", "registry"], code, "liveIdentity");
  for (const [value, url, label] of [
    [prestate.liveIdentity.controlPlane, GATE_F_CONTROL_HEALTH_URL, "controlPlane"],
    [prestate.liveIdentity.registry, GATE_F_REGISTRY_HEALTH_URL, "registry"],
  ]) {
    exactObject(value, ["releaseId", "sourceCommit", "url"], code, label);
    if (value.url !== url || value.releaseId !== prestate.current.releaseId
      || value.sourceCommit !== prestate.current.sourceCommit) fail(code, `${label} identity drifted`);
  }
  exactObject(prestate.liveIdentity.gate, ["mode", "phase", "url"], code, "gate");
  if (prestate.liveIdentity.gate.url !== GATE_F_STATUS_URL
    || prestate.liveIdentity.gate.mode !== "CLOSED" || prestate.liveIdentity.gate.phase !== "CLOSED") {
    fail(code, "legacy Gate-F identity must be exact CLOSED");
  }

  exactObject(prestate.snapshots, ["controlDb", "privateMaterial", "registryDb"], code, "snapshots");
  if (!Array.isArray(prestate.snapshots.privateMaterial)
    || prestate.snapshots.privateMaterial.length !== 2) {
    fail(code, "legacy prestate requires exactly two private snapshots");
  }
  validateSnapshotDescriptor(prestate.snapshots.controlDb, runtimeRoot,
    join(runtimeRoot, "state", "control-plane", "control.db"), code, "control DB snapshot");
  validateSnapshotDescriptor(prestate.snapshots.registryDb, runtimeRoot,
    join(runtimeRoot, "state", "orchestrator", REGISTRY_DATABASE_FILENAME), code, "registry DB snapshot");
  validateSnapshotDescriptor(prestate.snapshots.privateMaterial[0], runtimeRoot,
    prestate.runtimeBindings.secretEnvironment.path, code, "secret snapshot");
  validateSnapshotDescriptor(prestate.snapshots.privateMaterial[1], runtimeRoot,
    prestate.runtimeBindings.digestKeyring.path, code, "keyring snapshot");
  if (prestate.snapshots.privateMaterial[0].snapshotSha256
      !== prestate.runtimeBindings.secretEnvironment.sha256
    || prestate.snapshots.privateMaterial[1].snapshotSha256
      !== prestate.runtimeBindings.digestKeyring.sha256) {
    fail(code, "legacy private snapshots do not reproduce bound private material");
  }
  return Object.freeze({
    runtimeRoot,
    manifest,
    taskDefinitions: Object.freeze(taskDefinitions),
  });
}

function assertArtifactOnDisk(artifact, runtimeRoot, code, label) {
  assertPlainRuntimeChain(runtimeRoot, artifact.path, code);
  const bytes = readPlainBytes(artifact.path, code, label);
  const embedded = decodeArtifact(artifact, code, label);
  if (!bytes.equals(embedded)) fail(code, `${label} on-disk bytes differ from the tuple`);
}

function assertActiveCurrent(tuple) {
  const code = "GATE_F_CUTOVER_CURRENT_INVALID";
  assertPlainRuntimeChain(tuple.runtimeRoot, tuple.current.path, code, { allowTargetLink: true });
  const stat = lstatSync(tuple.current.path);
  if (!stat.isSymbolicLink() || !samePath(realpathSync(tuple.current.path), tuple.current.target)) {
    fail(code, "current is not the exact release junction in the tuple");
  }
}

function stateReleaseIdentity(state) {
  if (state?.release) return state.release;
  if (state?.current) return state.current;
  fail("GATE_F_CUTOVER_LIVE_IDENTITY_INVALID", "state release identity is absent");
}

function verifyLiveIdentity(actual, state) {
  const code = "GATE_F_CUTOVER_LIVE_IDENTITY_INVALID";
  const expected = stateReleaseIdentity(state);
  const cp = actual?.controlPlane;
  const registry = actual?.registry;
  const gate = actual?.gate?.gate ?? actual?.gate;
  if (cp?.ok !== true || cp?.authority !== true || cp?.activeLeases !== 0
    || cp.releaseId !== expected.releaseId || cp.sourceCommit !== expected.sourceCommit) {
    fail(code, "Control Plane identity/authority/lease state drifted");
  }
  if (registry?.ok !== true || registry.releaseId !== expected.releaseId
    || registry.sourceCommit !== expected.sourceCommit) {
    fail(code, "Registry release identity drifted");
  }
  const resources = gate?.resourceCounts;
  if (gate?.schemaId !== "xw.m6-gate-f-operations-status.v1"
    || gate.mode !== "CLOSED" || gate.phase !== "CLOSED" || gate.tripleConsistent !== true
    || gate.activeAuthorizationCount !== 0 || gate.actionCount !== 0
    || !Array.isArray(gate.errors) || gate.errors.length !== 0
    || resources?.jobs !== 0 || resources?.leases !== 0 || resources?.runs !== 0
    || resources?.sessions !== 0) {
    fail(code, "Gate-F is not exact CLOSED/triple-consistent/zero-resource");
  }
}

export function inspectTrustedNode(path = TRUSTED_NODE_EXECUTABLE) {
  if (!samePath(path, TRUSTED_NODE_EXECUTABLE)) {
    fail("GATE_F_CUTOVER_NODE_INVALID", "trusted Node path is fixed");
  }
  const bytes = readPlainBytes(path, "GATE_F_CUTOVER_NODE_INVALID", "trusted Node", 256 * 1024 * 1024);
  let raw;
  try {
    raw = execFileSync(path, ["--version"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim();
  } catch { fail("GATE_F_CUTOVER_NODE_INVALID", "trusted Node version probe failed"); }
  if (!/^v\d+\.\d+\.\d+$/u.test(raw)) fail("GATE_F_CUTOVER_NODE_INVALID", "Node version is malformed");
  return Object.freeze({ path: resolve(path), version: raw.slice(1), sha256: sha256(bytes) });
}

export function inspectSystemTaskClosure(runtimeRoot = FORMAL_RUNTIME_ROOT) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_SYSTEM_TASK_CLOSURE_INVALID", "runtimeRoot");
  const paths = {
    windowsPowerShell: WINDOWS_POWERSHELL_EXECUTABLE,
    orchestratorLauncher: join(runtime, "secrets", "launch-orchestrator.ps1"),
    fastOperatorLauncher: join(runtime, "launch-fast-operator-serve.ps1"),
    deviceConfig: join(runtime, "secrets", "control-plane.devices.json"),
  };
  return Object.freeze(Object.fromEntries(Object.entries(paths).map(([key, path]) => {
    const bytes = readIdentityBytes(
      { path },
      "GATE_F_SYSTEM_TASK_CLOSURE_INVALID",
      `SYSTEM task closure ${key}`,
      { allowTrustedOsHardlink: key === "windowsPowerShell" },
    );
    return [key, Object.freeze({ path: resolve(path), sha256: sha256(bytes) })];
  })));
}

export function provisionGateFXhsV3PrivateRoots({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_XHS_PRIVATE_ROOT_INVALID", "runtimeRoot");
  assertPlainDirectory(runtime, "GATE_F_XHS_PRIVATE_ROOT_INVALID", "runtime root");
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const ensure = (path, recursive = false) => {
    if (!existsSync(path)) mkdirSync(path, { recursive: false });
    assertPlainDirectory(path, "GATE_F_XHS_PRIVATE_ROOT_INVALID", path);
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath: path, recursive });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  const privateRoot = join(runtime, "private");
  ensure(privateRoot, false);
  const xhsRoot = join(privateRoot, "xhs-v3");
  ensure(xhsRoot, false);
  const roots = XHS_V3_PRIVATE_ROOT_NAMES.map((name) => {
    const path = join(xhsRoot, name);
    ensure(path, true);
    return path;
  });
  return Object.freeze(roots);
}

export function inspectScheduledTaskXml(taskName = FORMAL_CONTROL_PLANE_TASK_NAME) {
  if (!TASKS_TO_ACTIVATE.includes(taskName)) {
    fail("GATE_F_CUTOVER_TASK_INVALID", "Scheduled Task inspection is fixed to the activation set");
  }
  let xml;
  try {
    xml = execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
  } catch { fail("GATE_F_CUTOVER_TASK_INVALID", "formal Scheduled Task is absent or unreadable"); }
  return xml;
}

export function inspectFormalScheduledTask(taskName = FORMAL_CONTROL_PLANE_TASK_NAME) {
  return Object.freeze({ name: taskName, ...parseFormalTaskDefinition(inspectScheduledTaskXml(taskName)) });
}

export function inspectLegacyScheduledTask(taskName = FORMAL_CONTROL_PLANE_TASK_NAME) {
  return Object.freeze({ name: taskName, ...parseLegacyTaskDefinition(inspectScheduledTaskXml(taskName)) });
}

export function inspectGateFTaskOwnedProcessClosure({ tuple } = {}) {
  const code = "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID";
  if (!tuple?.release || !tuple?.trustedNode) {
    fail(code, "an exact Gate-F cutover tuple is required");
  }
  const input = {
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    nodePath: tuple.trustedNode.path,
    powerShellPath: WINDOWS_POWERSHELL_EXECUTABLE,
    specs: TASK_PROCESS_SPECS.map((spec) => ({
      role: spec.role,
      taskName: spec.taskName,
      modulePath: join(tuple.release.root, ...spec.moduleReleasePath.split("/")),
      listenerPort: spec.listenerPort,
    })),
  };
  const systemRoot = join("C:\\", "Windows");
  let raw;
  try {
    raw = execFileSync(WINDOWS_POWERSHELL_EXECUTABLE, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", TASK_PROCESS_INSPECTION_PROGRAM,
    ], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: join(systemRoot, "Temp"),
        TMP: join(systemRoot, "Temp"),
        PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
        XW_GATE_F_TASK_PROCESS_SPECS_B64: Buffer.from(
          JSON.stringify(input),
          "utf8",
        ).toString("base64"),
      },
    });
  } catch {
    fail(code, "the exact four running task instances do not own their release processes");
  }
  try { return JSON.parse(raw); }
  catch { fail(code, "task-owned process oracle returned malformed JSON"); }
}

export function normalizeGateFTaskOwnedProcessClosure(value, { tuple } = {}) {
  const code = "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID";
  exactObject(
    value,
    ["inspectedAt", "releaseId", "rows", "schemaId", "sourceCommit"],
    code,
    "task-owned process closure",
  );
  if (value.schemaId !== GATE_F_TASK_OWNED_PROCESS_CLOSURE_SCHEMA_ID
    || value.releaseId !== tuple?.release?.releaseId
    || value.sourceCommit !== tuple?.release?.sourceCommit
    || typeof value.inspectedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.inspectedAt)
    || !Number.isFinite(Date.parse(value.inspectedAt))
    || !Array.isArray(value.rows) || value.rows.length !== TASK_PROCESS_SPECS.length) {
    fail(code, "task-owned process closure identity/schema drifted");
  }
  const manifest = parseJsonBytes(
    decodeArtifact(tuple.release.manifest, code, "release manifest"),
    code,
    "release manifest",
  );
  const rows = value.rows.map((row, index) => {
    const spec = TASK_PROCESS_SPECS[index];
    exactObject(
      row,
      [
        "createdAt", "engineCreatedAt", "engineParentPid", "enginePid",
        "listenerIdentitySha256", "moduleSha256", "parentPid", "pid", "role",
        "taskInstanceSha256", "taskName",
      ],
      code,
      `task-owned process row ${index}`,
    );
    const expectedModuleHash = manifestEntry(manifest, spec.moduleReleasePath, code).sha256;
    const validTime = (candidate) => typeof candidate === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate)
      && Number.isFinite(Date.parse(candidate));
    if (row.role !== spec.role || row.taskName !== spec.taskName
      || !Number.isSafeInteger(row.enginePid) || row.enginePid < 4
      || !Number.isSafeInteger(row.engineParentPid) || row.engineParentPid < 0
      || !Number.isSafeInteger(row.pid) || row.pid < 4
      || row.pid === row.enginePid || row.parentPid !== row.enginePid
      || !validTime(row.engineCreatedAt) || !validTime(row.createdAt)
      || Date.parse(row.createdAt) < Date.parse(row.engineCreatedAt)
      || row.moduleSha256 !== expectedModuleHash
      || !HEX64.test(row.taskInstanceSha256 || "")
      || !HEX64.test(row.listenerIdentitySha256 || "")) {
      fail(code, `${spec.taskName} is not the exact task-owned release process`);
    }
    return Object.freeze({ ...row });
  });
  const processIds = rows.flatMap((row) => [row.enginePid, row.pid]);
  if (new Set(processIds).size !== processIds.length
    || new Set(rows.map((row) => row.taskInstanceSha256)).size !== rows.length) {
    fail(code, "task instances or owned processes are not one-to-one");
  }
  const body = Object.freeze({
    schemaId: value.schemaId,
    releaseId: value.releaseId,
    sourceCommit: value.sourceCommit,
    inspectedAt: value.inspectedAt,
    rows: Object.freeze(rows),
  });
  return Object.freeze({
    ...body,
    closureSha256: sha256(
      `${GATE_F_TASK_OWNED_PROCESS_CLOSURE_SCHEMA_ID}:${domainCanonicalJson(body)}`,
    ),
  });
}

async function fetchFixedJson(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal, cache: "no-store" });
    if (!response.ok) fail("GATE_F_CUTOVER_LIVE_IDENTITY_INVALID", `${url} returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.code === "GATE_F_CUTOVER_LIVE_IDENTITY_INVALID") throw error;
    fail("GATE_F_CUTOVER_LIVE_IDENTITY_INVALID", `${url} was unavailable`);
  } finally { clearTimeout(timer); }
}

export async function inspectFixedLiveIdentity(runtimeRoot = FORMAL_RUNTIME_ROOT) {
  if (!samePath(runtimeRoot, FORMAL_RUNTIME_ROOT)) {
    fail("GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "production live endpoints are bound to the fixed runtime root");
  }
  const secretPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  const secret = parseJsonBytes(
    readPlainBytes(secretPath, "GATE_F_CUTOVER_PRIVATE_MATERIAL_INVALID", "secret environment", 32 * 1024),
    "GATE_F_CUTOVER_PRIVATE_MATERIAL_INVALID",
    "secret environment",
  );
  const token = secret?.variables?.XW_M6_GATE_F_OPERATIONS_TOKEN;
  if (typeof token !== "string" || token.length < 32 || /[\0\r\n]/u.test(token)) {
    fail("GATE_F_CUTOVER_PRIVATE_MATERIAL_INVALID", "Gate-F operations token is unavailable");
  }
  const [controlPlane, registry, gate] = await Promise.all([
    fetchFixedJson(GATE_F_CONTROL_HEALTH_URL),
    fetchFixedJson(GATE_F_REGISTRY_HEALTH_URL),
    fetchFixedJson(GATE_F_STATUS_URL, { headers: { "X-Control-Token": token } }),
  ]);
  return Object.freeze({ controlPlane, registry, gate });
}

export async function verifyGateFCutoverTuple({
  tuplePath,
  expectedTupleSha256,
  expectedRuntimeRoot = FORMAL_RUNTIME_ROOT,
  requireActive = false,
  releaseVerifier = verifyReleaseManifest,
  identityVerifier = verifyGateFLauncherIdentity,
  providerInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  nodeInspector = inspectTrustedNode,
  taskInspector = inspectFormalScheduledTask,
  liveIdentityInspector = inspectFixedLiveIdentity,
  m6CatalogVerifier = loadM6GateFArtifactCatalog,
  gateHandoffVerifier = verifyGateFCrossReleaseTarget,
  taskProcessClosureInspector = inspectGateFTaskOwnedProcessClosure,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_CUTOVER_TUPLE_INVALID";
  const tuplePathFull = absolutePath(tuplePath, code, "tuplePath");
  if (!HEX64.test(expectedTupleSha256 || "")) fail(code, "expected tuple SHA-256 is required");
  const tupleRead = readCanonicalJson(tuplePathFull, code, "cutover tuple");
  if (sha256(tupleRead.bytes) !== expectedTupleSha256
    || basename(dirname(tuplePathFull)).toLowerCase() !== expectedTupleSha256
    || basename(tuplePathFull) !== GATE_F_CUTOVER_TUPLE_FILENAME) {
    fail(code, "cutover tuple is not stored at its canonical SHA-256 address");
  }
  const shape = validateCoreTupleShape(tupleRead.value, expectedRuntimeRoot);
  const tuple = tupleRead.value;
  if (!samePath(tuplePathFull, join(
    shape.runtimeRoot, "cutover-tuples", expectedTupleSha256, GATE_F_CUTOVER_TUPLE_FILENAME,
  ))) fail(code, "tuple escaped the fixed cutover-tuples namespace");
  assertPlainRuntimeChain(shape.runtimeRoot, tuplePathFull, code);
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  const verifyTcb = (boundaryPath, targetPath, recursive = false) => tcbAclController.verify(
    buildSystemTcbAclPlan({ boundaryPath, targetPath, recursive }),
  );
  verifyTcb(shape.runtimeRoot, shape.runtimeRoot, false);
  verifyTcb(shape.runtimeRoot, tuple.release.root, true);
  for (const targetPath of [
    tuplePathFull,
    tuple.formal.binding.path,
    tuple.formal.launcher.path,
    tuple.formal.task.xml.path,
    ...tuple.activationTasks.map((task) => task.xml.path),
    tuple.runtimeBindings.m6Final.path,
    tuple.runtimeBindings.serve03.path,
    tuple.runtimeBindings.serve04.path,
    tuple.runtimeBindings.provider.path,
    tuple.runtimeBindings.secretEnvironment.path,
    tuple.runtimeBindings.digestKeyring.path,
    tuple.systemTaskClosure.orchestratorLauncher.path,
    tuple.systemTaskClosure.fastOperatorLauncher.path,
    tuple.systemTaskClosure.deviceConfig.path,
    tuple.snapshots.controlDb.snapshotPath,
    tuple.snapshots.registryDb.snapshotPath,
    ...tuple.snapshots.privateMaterial.map((row) => row.snapshotPath),
  ]) verifyTcb(shape.runtimeRoot, targetPath, false);
  verifyTcb(dirname(tuple.trustedNode.path), tuple.trustedNode.path, false);
  for (const privateRoot of tuple.xhsV3PrivateRoots) {
    verifyTcb(shape.runtimeRoot, privateRoot, true);
  }

  for (const [artifact, label] of [
    [tuple.release.manifest, "release manifest"],
    [tuple.operator, "operator"],
    [tuple.formal.binding, "formal binding"],
    [tuple.formal.launcher, "formal launcher"],
    [tuple.formal.task.xml, "formal task XML"],
    [tuple.runtimeBindings.provider, "provider config"],
  ]) assertArtifactOnDisk(artifact, shape.runtimeRoot, code, label);
  for (const [key, value] of Object.entries(tuple.systemTaskClosure)) {
    verifyIdentityArtifactOnDisk(value, "GATE_F_SYSTEM_TASK_CLOSURE_INVALID", key, {
      allowTrustedOsHardlink: key === "windowsPowerShell",
    });
  }
  const verifiedRelease = releaseVerifier({
    manifestPath: tuple.release.manifest.path,
    root: tuple.release.root,
  });
  if (!verifiedRelease?.ok) {
    fail("GATE_F_CUTOVER_RELEASE_DIRTY", "release tree differs from its formal manifest", {
      mismatches: verifiedRelease?.mismatches ?? [],
    });
  }

  const node = await nodeInspector(tuple.trustedNode.path);
  if (!samePath(node?.path, tuple.trustedNode.path) || node.version !== tuple.trustedNode.version
    || node.sha256 !== tuple.trustedNode.sha256) {
    fail("GATE_F_CUTOVER_NODE_INVALID", "trusted Node path/version/bytes drifted");
  }
  const provider = await providerInspector(shape.runtimeRoot);
  if (!samePath(provider?.path, tuple.runtimeBindings.provider.path)
    || provider.sha256 !== tuple.runtimeBindings.provider.sha256
    || provider.providerBundleDigest !== tuple.runtimeBindings.provider.providerBundleDigest) {
    fail("GATE_F_CUTOVER_PROVIDER_INVALID", "provider config or transitive bundle identity drifted");
  }
  const privateMaterial = await privateMaterialInspector({ runtimeRoot: shape.runtimeRoot });
  if (!samePath(privateMaterial?.secretEnvironment?.path, tuple.runtimeBindings.secretEnvironment.path)
    || privateMaterial.secretEnvironment.sha256 !== tuple.runtimeBindings.secretEnvironment.sha256
    || !samePath(privateMaterial?.digestKeyring?.path, tuple.runtimeBindings.digestKeyring.path)
    || privateMaterial.digestKeyring.sha256 !== tuple.runtimeBindings.digestKeyring.sha256) {
    fail("GATE_F_CUTOVER_PRIVATE_MATERIAL_INVALID", "secret/keyring identities drifted");
  }
  const m6 = parseJsonBytes(shape.decoded.m6Bytes, code, "M6 FINAL binding");
  await m6CatalogVerifier({
    path: m6.gateFArtifactCatalogPath,
    expectedHash: m6.gateFArtifactCatalogHash,
    expectedReleaseRoot: tuple.release.root,
    expectedReleaseManifestPath: tuple.release.manifest.path,
  });
  await gateHandoffVerifier({
    runtimeRoot: shape.runtimeRoot,
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    gateHandoff: tuple.gateHandoff,
    requirePointer: requireActive,
    tcbAclController,
  });

  snapshotRef(tuple.snapshots.controlDb, shape.runtimeRoot,
    join(shape.runtimeRoot, "state", "control-plane", "control.db"), code, "control DB snapshot");
  snapshotRef(tuple.snapshots.registryDb, shape.runtimeRoot,
    join(shape.runtimeRoot, "state", "orchestrator", REGISTRY_DATABASE_FILENAME), code, "registry DB snapshot");
  const expectedPrivateTargets = [
    tuple.runtimeBindings.secretEnvironment.path,
    tuple.runtimeBindings.digestKeyring.path,
  ];
  for (let index = 0; index < expectedPrivateTargets.length; index += 1) {
    snapshotRef(tuple.snapshots.privateMaterial[index], shape.runtimeRoot,
      expectedPrivateTargets[index], code, `private snapshot ${index}`);
  }

  let taskProcessClosure = null;
  if (requireActive) {
    if (typeof taskProcessClosureInspector !== "function") {
      fail(
        "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID",
        "task-owned process closure inspector is required for active verification",
      );
    }
    assertActiveCurrent(tuple);
    for (const [artifact, label] of [
      [tuple.runtimeBindings.m6Final, "M6 FINAL binding"],
      [tuple.runtimeBindings.serve03, "serve03 binding"],
      [tuple.runtimeBindings.serve04, "serve04 binding"],
    ]) assertArtifactOnDisk(artifact, shape.runtimeRoot, code, label);
    await identityVerifier({
      bindingPath: tuple.formal.binding.path,
      taskXmlPath: tuple.formal.task.xml.path,
      expectedReleaseId: tuple.release.releaseId,
      expectedSourceCommit: tuple.release.sourceCommit,
      providerConfigInspector: providerInspector,
      privateMaterialInspector,
    });
    const expectedTasks = [
      { name: FORMAL_CONTROL_PLANE_TASK_NAME, definition: shape.taskDefinition },
      ...AUXILIARY_TASK_SPECS.map((spec, index) => ({
        name: spec.name,
        definition: shape.activationTaskDefinitions[index],
      })),
    ];
    for (const expected of expectedTasks) {
      const task = await taskInspector(expected.name);
      if (task?.name !== expected.name || !sameTaskDefinition(task, expected.definition)) {
        fail("GATE_F_CUTOVER_TASK_INVALID", `${expected.name} differs from its pinned XML/action`);
      }
    }
    taskProcessClosure = normalizeGateFTaskOwnedProcessClosure(
      await taskProcessClosureInspector({ tuple }),
      { tuple },
    );
    verifyLiveIdentity(await liveIdentityInspector(shape.runtimeRoot), tuple);
  }
  return Object.freeze({
    ok: true,
    tuple,
    tuplePath: tuplePathFull,
    tupleSha256: expectedTupleSha256,
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    active: requireActive,
    taskProcessClosure,
  });
}

export function materializeGateFCutoverTuple({
  runtimeRoot,
  tuple,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "runtimeRoot");
  validateCoreTupleShape(tuple, runtime);
  const bytes = canonicalJsonBytes(tuple);
  const tupleSha256 = sha256(bytes);
  const tuplePath = join(runtime, "cutover-tuples", tupleSha256, GATE_F_CUTOVER_TUPLE_FILENAME);
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  assertPlainDirectory(runtime, "GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "runtime root");
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(runtime);
  const tuplesRoot = join(runtime, "cutover-tuples");
  if (!existsSync(tuplesRoot)) mkdirSync(tuplesRoot, { recursive: false });
  seal(tuplesRoot);
  const tupleRoot = dirname(tuplePath);
  if (!existsSync(tupleRoot)) mkdirSync(tupleRoot, { recursive: false });
  seal(tupleRoot);
  if (existsSync(tuplePath)) {
    const actual = readPlainBytes(
      tuplePath,
      "GATE_F_CUTOVER_TUPLE_INVALID",
      "existing content-addressed tuple",
    );
    if (!actual.equals(bytes)) fail("GATE_F_CUTOVER_TUPLE_INVALID", "tuple address collision");
  } else {
    writeFileSync(tuplePath, bytes, { flag: "wx", mode: 0o600 });
  }
  seal(tuplePath);
  return Object.freeze({ tuplePath, tupleSha256 });
}

export async function verifyGateFLegacyPrestate({
  prestatePath,
  expectedPrestateSha256,
  expectedRuntimeRoot = FORMAL_RUNTIME_ROOT,
  requireActive = false,
  releaseVerifier = verifyReleaseManifest,
  providerInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  nodeInspector = inspectTrustedNode,
  taskInspector = inspectLegacyScheduledTask,
  liveIdentityInspector = inspectFixedLiveIdentity,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_LEGACY_PRESTATE_INVALID";
  const path = absolutePath(prestatePath, code, "prestatePath");
  if (!HEX64.test(expectedPrestateSha256 || "")) fail(code, "expected prestate SHA-256 is required");
  const read = readCanonicalJson(path, code, "legacy prestate");
  if (sha256(read.bytes) !== expectedPrestateSha256
    || !samePath(path, join(
      expectedRuntimeRoot,
      "legacy-prestates",
      expectedPrestateSha256,
      GATE_F_LEGACY_PRESTATE_FILENAME,
    ))) fail(code, "legacy prestate escaped its canonical content address");
  const shape = validateGateFLegacyPrestateDocument(read.value, {
    expectedRuntimeRoot,
  });
  const prestate = read.value;
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  const verifyTcb = (boundaryPath, targetPath, recursive = false) => tcbAclController.verify(
    buildSystemTcbAclPlan({ boundaryPath, targetPath, recursive }),
  );
  verifyTcb(shape.runtimeRoot, shape.runtimeRoot, false);
  verifyTcb(shape.runtimeRoot, prestate.current.target, true);
  for (const targetPath of [
    path,
    prestate.releaseManifest.path,
    ...prestate.tasks.map((task) => task.xml.path),
    prestate.runtimeBindings.m6Final.path,
    prestate.runtimeBindings.serve03.path,
    prestate.runtimeBindings.serve04.path,
    prestate.runtimeBindings.provider.path,
    prestate.runtimeBindings.secretEnvironment.path,
    prestate.runtimeBindings.digestKeyring.path,
    prestate.systemTaskClosure.orchestratorLauncher.path,
    prestate.systemTaskClosure.fastOperatorLauncher.path,
    prestate.systemTaskClosure.deviceConfig.path,
    prestate.snapshots.controlDb.snapshotPath,
    prestate.snapshots.registryDb.snapshotPath,
    ...prestate.snapshots.privateMaterial.map((row) => row.snapshotPath),
  ]) verifyTcb(shape.runtimeRoot, targetPath, false);
  verifyTcb(dirname(prestate.trustedNode.path), prestate.trustedNode.path, false);

  for (const [artifact, label] of [
    [prestate.releaseManifest, "legacy release manifest"],
    ...prestate.tasks.map((task) => [task.xml, `${task.name} XML`]),
    [prestate.runtimeBindings.provider, "legacy provider config"],
  ]) assertArtifactOnDisk(artifact, shape.runtimeRoot, code, label);
  for (const [key, value] of Object.entries(prestate.systemTaskClosure)) {
    verifyIdentityArtifactOnDisk(value, "GATE_F_SYSTEM_TASK_CLOSURE_INVALID", key, {
      allowTrustedOsHardlink: key === "windowsPowerShell",
    });
  }
  const verifiedRelease = releaseVerifier({
    manifestPath: prestate.releaseManifest.path,
    root: prestate.current.target,
  });
  if (!verifiedRelease?.ok) {
    fail("GATE_F_CUTOVER_RELEASE_DIRTY", "legacy release tree differs from its manifest", {
      mismatches: verifiedRelease?.mismatches ?? [],
    });
  }
  const node = await nodeInspector(prestate.trustedNode.path);
  if (!samePath(node?.path, prestate.trustedNode.path)
    || node.version !== prestate.trustedNode.version || node.sha256 !== prestate.trustedNode.sha256) {
    fail("GATE_F_CUTOVER_NODE_INVALID", "legacy trusted Node identity drifted");
  }
  const provider = await providerInspector(shape.runtimeRoot);
  if (!samePath(provider?.path, prestate.runtimeBindings.provider.path)
    || provider.sha256 !== prestate.runtimeBindings.provider.sha256
    || provider.providerBundleDigest !== prestate.runtimeBindings.provider.providerBundleDigest) {
    fail("GATE_F_CUTOVER_PROVIDER_INVALID", "legacy provider identity drifted");
  }
  const privateMaterial = await privateMaterialInspector({ runtimeRoot: shape.runtimeRoot });
  if (!samePath(privateMaterial?.secretEnvironment?.path,
    prestate.runtimeBindings.secretEnvironment.path)
    || privateMaterial.secretEnvironment.sha256
      !== prestate.runtimeBindings.secretEnvironment.sha256
    || !samePath(privateMaterial?.digestKeyring?.path,
      prestate.runtimeBindings.digestKeyring.path)
    || privateMaterial.digestKeyring.sha256 !== prestate.runtimeBindings.digestKeyring.sha256) {
    fail("GATE_F_CUTOVER_PRIVATE_MATERIAL_INVALID", "legacy private material identity drifted");
  }
  snapshotRef(prestate.snapshots.controlDb, shape.runtimeRoot,
    join(shape.runtimeRoot, "state", "control-plane", "control.db"), code, "control DB snapshot");
  snapshotRef(prestate.snapshots.registryDb, shape.runtimeRoot,
    join(shape.runtimeRoot, "state", "orchestrator", REGISTRY_DATABASE_FILENAME), code, "registry DB snapshot");
  for (let index = 0; index < 2; index += 1) {
    snapshotRef(prestate.snapshots.privateMaterial[index], shape.runtimeRoot,
      index === 0 ? prestate.runtimeBindings.secretEnvironment.path
        : prestate.runtimeBindings.digestKeyring.path,
      code,
      `private snapshot ${index}`,
    );
  }

  if (requireActive) {
    assertActiveCurrent(prestate);
    for (const [artifact, label] of [
      [prestate.runtimeBindings.m6Final, "legacy M6 binding"],
      [prestate.runtimeBindings.serve03, "legacy serve03 binding"],
      [prestate.runtimeBindings.serve04, "legacy serve04 binding"],
    ]) assertArtifactOnDisk(artifact, shape.runtimeRoot, code, label);
    for (let index = 0; index < prestate.tasks.length; index += 1) {
      const expected = prestate.tasks[index];
      const actual = await taskInspector(expected.name);
      if (actual?.name !== expected.name
        || !sameTaskDefinition(actual, shape.taskDefinitions[index])) {
        fail("GATE_F_CUTOVER_TASK_INVALID", `${expected.name} differs from captured legacy XML/action`);
      }
    }
    verifyLiveIdentity(await liveIdentityInspector(shape.runtimeRoot), prestate);
  }
  return Object.freeze({
    ok: true,
    prestate,
    prestatePath: path,
    prestateSha256: expectedPrestateSha256,
    releaseId: prestate.current.releaseId,
    sourceCommit: prestate.current.sourceCommit,
    active: requireActive,
  });
}

export function materializeGateFLegacyPrestate({
  runtimeRoot,
  prestate,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_LEGACY_PRESTATE_INVALID", "runtimeRoot");
  validateGateFLegacyPrestateDocument(prestate, { expectedRuntimeRoot: runtime });
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const bytes = canonicalJsonBytes(prestate);
  const prestateSha256 = sha256(bytes);
  const prestatePath = join(
    runtime,
    "legacy-prestates",
    prestateSha256,
    GATE_F_LEGACY_PRESTATE_FILENAME,
  );
  materializeExactAddressedFile({
    runtimeRoot: runtime,
    path: prestatePath,
    bytes,
    tcbAclController,
    code: "GATE_F_LEGACY_PRESTATE_INVALID",
  });
  return Object.freeze({ prestatePath, prestateSha256 });
}

export async function captureGateFLegacyPrestate({
  runtimeRoot,
  snapshots,
  releaseVerifier = verifyReleaseManifest,
  providerInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  nodeInspector = inspectTrustedNode,
  systemTaskClosureInspector = inspectSystemTaskClosure,
  taskXmlInspector = inspectScheduledTaskXml,
  liveIdentityInspector = inspectFixedLiveIdentity,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_LEGACY_PRESTATE_INVALID", "runtimeRoot");
  assertPlainDirectory(runtime, "GATE_F_LEGACY_PRESTATE_INVALID", "runtime root");
  const currentPath = join(runtime, "current");
  const currentStat = lstatSync(currentPath);
  if (!currentStat.isSymbolicLink()) fail("GATE_F_LEGACY_PRESTATE_INVALID", "legacy current is not a junction");
  const releaseRoot = realpathSync(currentPath);
  if (!within(join(runtime, "releases"), releaseRoot)) {
    fail("GATE_F_LEGACY_PRESTATE_INVALID", "legacy current escaped releases");
  }
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const manifestRead = readCanonicalJson(manifestPath, "GATE_F_LEGACY_PRESTATE_INVALID", "legacy manifest");
  const manifest = manifestRead.value;
  if (manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || !RELEASE_ID.test(manifest.releaseId || "") || !HEX40.test(manifest.sourceCommit || "")
    || basename(releaseRoot) !== manifest.releaseId) {
    fail("GATE_F_LEGACY_PRESTATE_INVALID", "legacy manifest identity is invalid");
  }
  const release = releaseVerifier({ root: releaseRoot, manifestPath });
  if (!release?.ok) fail("GATE_F_CUTOVER_RELEASE_DIRTY", "legacy release is not clean");
  const provider = await providerInspector(runtime);
  const providerBytes = readPlainBytes(
    provider?.path,
    "GATE_F_LEGACY_PRESTATE_INVALID",
    "legacy provider",
  );
  if (sha256(providerBytes) !== provider?.sha256 || !HEX64.test(provider?.providerBundleDigest || "")) {
    fail("GATE_F_LEGACY_PRESTATE_INVALID", "legacy provider identity drifted during capture");
  }
  const privateMaterial = await privateMaterialInspector({ runtimeRoot: runtime });
  const trustedNode = await nodeInspector(TRUSTED_NODE_EXECUTABLE);
  const systemTaskClosure = await systemTaskClosureInspector(runtime);
  const tasks = [];
  for (let index = 0; index < TASKS_TO_ACTIVATE.length; index += 1) {
    const name = TASKS_TO_ACTIVATE[index];
    const xml = await taskXmlInspector(name);
    const definition = parseLegacyTaskDefinition(xml);
    if (definition.principal !== "SYSTEM" || definition.enabled !== true) {
      fail("GATE_F_LEGACY_PRESTATE_INVALID", `${name} is not an enabled SYSTEM task`);
    }
    const bytes = Buffer.from(xml, "utf8");
    const digest = sha256(bytes);
    const filename = index === 0 ? FORMAL_TASK_XML_FILENAME : AUXILIARY_TASK_SPECS[index - 1].filename;
    const path = join(runtime, "legacy-task-bindings", digest, filename);
    materializeExactAddressedFile({
      runtimeRoot: runtime,
      path,
      bytes,
      tcbAclController,
      code: "GATE_F_LEGACY_PRESTATE_INVALID",
    });
    tasks.push(Object.freeze({
      name,
      principal: "SYSTEM",
      xml: embeddedArtifact(path, bytes),
      action: definition.action,
    }));
  }
  const slot = (path, label) => embeddedArtifact(
    path,
    readPlainBytes(path, "GATE_F_LEGACY_PRESTATE_INVALID", label),
  );
  const actualLive = await liveIdentityInspector(runtime);
  const prestate = {
    schemaId: GATE_F_LEGACY_PRESTATE_SCHEMA_ID,
    runtimeRoot: runtime,
    current: {
      path: currentPath,
      target: releaseRoot,
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
    },
    releaseManifest: embeddedArtifact(manifestPath, manifestRead.bytes),
    tasks,
    trustedNode: {
      path: resolve(trustedNode.path),
      version: trustedNode.version,
      sha256: trustedNode.sha256,
    },
    systemTaskClosure,
    runtimeBindings: {
      m6Final: slot(join(runtime, "config", "m6-c1-runtime.v1.json"), "legacy M6 binding"),
      serve03: slot(join(runtime, "state", "control-plane", "fast-operator", "serve-launch-03.json"),
        "legacy serve03 binding"),
      serve04: slot(join(runtime, "state", "control-plane", "fast-operator", "serve-launch-04.json"),
        "legacy serve04 binding"),
      provider: embeddedArtifact(provider.path, providerBytes, {
        providerBundleDigest: provider.providerBundleDigest,
      }),
      secretEnvironment: {
        path: resolve(privateMaterial.secretEnvironment.path),
        sha256: privateMaterial.secretEnvironment.sha256,
      },
      digestKeyring: {
        path: resolve(privateMaterial.digestKeyring.path),
        sha256: privateMaterial.digestKeyring.sha256,
      },
    },
    liveIdentity: {
      controlPlane: {
        url: GATE_F_CONTROL_HEALTH_URL,
        releaseId: manifest.releaseId,
        sourceCommit: manifest.sourceCommit,
      },
      registry: {
        url: GATE_F_REGISTRY_HEALTH_URL,
        releaseId: manifest.releaseId,
        sourceCommit: manifest.sourceCommit,
      },
      gate: { url: GATE_F_STATUS_URL, mode: "CLOSED", phase: "CLOSED" },
    },
    snapshots,
  };
  validateGateFLegacyPrestateDocument(prestate, { expectedRuntimeRoot: runtime });
  verifyLiveIdentity(actualLive, prestate);
  for (const [ref, target, label] of [
    [snapshots.controlDb, join(runtime, "state", "control-plane", "control.db"), "control DB snapshot"],
    [snapshots.registryDb, join(runtime, "state", "orchestrator", REGISTRY_DATABASE_FILENAME), "registry DB snapshot"],
    [snapshots.privateMaterial[0], privateMaterial.secretEnvironment.path, "secret snapshot"],
    [snapshots.privateMaterial[1], privateMaterial.digestKeyring.path, "keyring snapshot"],
  ]) snapshotRef(ref, runtime, target, "GATE_F_LEGACY_PRESTATE_INVALID", label);
  const addressed = materializeGateFLegacyPrestate({
    runtimeRoot: runtime,
    prestate,
    tcbAclController,
  });
  const legacyReference = materializeLegacyReference({
    runtimeRoot: runtime,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    prestatePath: addressed.prestatePath,
    prestateSha256: addressed.prestateSha256,
    tcbAclController,
  });
  return Object.freeze({
    ok: true,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    prestate: Object.freeze(prestate),
    ...addressed,
    legacyReference,
  });
}

export function stageGateFTargetRuntimeBindings({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  runtimeBindingBytes,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_PREPARE_INVALID", "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "target release/source identity is invalid");
  }
  exactObject(
    runtimeBindingBytes,
    ["m6Final", "serve03", "serve04"],
    "GATE_F_TARGET_PREPARE_INVALID",
    "runtimeBindingBytes",
  );
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const releaseRoot = join(runtime, "releases", expectedReleaseId);
  assertPlainDirectory(releaseRoot, "GATE_F_TARGET_PREPARE_INVALID", "target release");
  const manifest = readCanonicalJson(
    join(releaseRoot, "release-manifest.v1.json"),
    "GATE_F_TARGET_PREPARE_INVALID",
    "target release manifest",
  ).value;
  if (manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.releaseId !== expectedReleaseId || manifest.sourceCommit !== expectedSourceCommit) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "target manifest identity drifted");
  }
  const seal = (targetPath, recursive = false) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath, recursive });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(runtime);
  seal(releaseRoot, true);
  const stagingRoot = join(runtime, "cutover-target-bindings");
  if (!existsSync(stagingRoot)) mkdirSync(stagingRoot, { recursive: false });
  seal(stagingRoot);
  const releaseStagingRoot = join(stagingRoot, expectedReleaseId);
  if (!existsSync(releaseStagingRoot)) mkdirSync(releaseStagingRoot, { recursive: false });
  seal(releaseStagingRoot);
  const specs = {
    m6Final: "m6-c1-runtime.v1.json",
    serve03: "serve-launch-03.json",
    serve04: "serve-launch-04.json",
  };
  const descriptors = {};
  for (const [key, filename] of Object.entries(specs)) {
    const bytes = runtimeBindingBytes[key];
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 1024 * 1024) {
      fail("GATE_F_TARGET_PREPARE_INVALID", `${key} candidate bytes are invalid`);
    }
    const digest = sha256(bytes);
    const addressRoot = join(releaseStagingRoot, digest);
    if (!existsSync(addressRoot)) mkdirSync(addressRoot, { recursive: false });
    seal(addressRoot);
    const path = join(addressRoot, filename);
    if (existsSync(path)) {
      const existing = readPlainBytes(path, "GATE_F_TARGET_PREPARE_INVALID", `${key} staged artifact`);
      if (!existing.equals(bytes)) fail("GATE_F_TARGET_PREPARE_INVALID", `${key} address collision`);
    } else {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    seal(path);
    descriptors[key] = Object.freeze({ path, sha256: digest });
  }
  return Object.freeze(descriptors);
}

function embeddedArtifact(path, bytes, extra = {}) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return Object.freeze({
    path: resolve(path),
    sha256: sha256(value),
    bytesBase64: value.toString("base64"),
    ...extra,
  });
}

function materializeExactAddressedFile({
  runtimeRoot,
  path,
  bytes,
  tcbAclController,
  code = "GATE_F_TARGET_PREPARE_INVALID",
}) {
  const target = resolve(path);
  if (!within(runtimeRoot, target)) fail(code, "prepared artifact escaped the runtime root");
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(parent);
  if (existsSync(target)) {
    const actual = readPlainBytes(target, code, "prepared addressed artifact");
    if (!actual.equals(bytes)) fail(code, "prepared artifact address collision");
  } else {
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  seal(target);
  return target;
}

function materializeImmutableIdentityFile({
  runtimeRoot,
  path,
  value,
  tcbAclController,
  code,
}) {
  const target = resolve(path);
  if (!within(runtimeRoot, target)) fail(code, "identity artifact escaped the runtime root");
  const bytes = canonicalJsonBytes(value);
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(parent);
  if (existsSync(target)) {
    const existing = readPlainBytes(target, code, "immutable identity artifact");
    if (!existing.equals(bytes)) fail(code, "immutable release/source identity is already bound differently");
  } else {
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  seal(target);
  return Object.freeze({ path: target, sha256: sha256(bytes) });
}

function identityRoot(runtimeRoot, namespace, releaseId, sourceCommit) {
  if (!RELEASE_ID.test(releaseId || "") || !HEX40.test(sourceCommit || "")) {
    fail("GATE_F_FIXED_IDENTITY_INVALID", "release ID/source commit is invalid");
  }
  return join(runtimeRoot, namespace, releaseId, sourceCommit);
}

async function snapshotSqliteDatabase(sourcePath, { tempRoot, tcbAclController, runtimeRoot }) {
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (!existsSync(tempRoot)) mkdirSync(tempRoot, { recursive: false });
  const rootPlan = buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: tempRoot,
    recursive: false,
  });
  tcbAclController.protect(rootPlan);
  tcbAclController.verify(rootPlan);
  const tempPath = join(tempRoot, `${randomUUID()}.sqlite`);
  let source;
  let check;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
    await backup(source, tempPath);
    source.close();
    source = null;
    const plan = buildSystemTcbAclPlan({
      boundaryPath: runtimeRoot,
      targetPath: tempPath,
      recursive: false,
    });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
    check = new DatabaseSync(tempPath, { readOnly: true, allowExtension: false });
    const quickCheck = check.prepare("PRAGMA quick_check").get();
    if (!quickCheck || !Object.values(quickCheck).includes("ok")) {
      fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "SQLite backup quick_check did not return ok");
    }
    check.close();
    check = null;
    return readPlainBytes(
      tempPath,
      "GATE_F_ROLLBACK_SNAPSHOT_INVALID",
      "SQLite backup",
      1024 * 1024 * 1024,
    );
  } catch (cause) {
    if (/^GATE_F_/u.test(cause?.code || "")) throw cause;
    fail(
      "GATE_F_ROLLBACK_SNAPSHOT_INVALID",
      `SQLite online backup failed: ${cause?.code || cause?.message || "unknown"}`,
    );
  } finally {
    try { source?.close(); } catch {}
    try { check?.close(); } catch {}
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}

function publishRollbackSnapshot({
  runtimeRoot,
  releaseId,
  sourceCommit,
  targetPath,
  filename,
  bytes,
  tcbAclController,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024 * 1024) {
    fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", `${filename} snapshot bytes are invalid`);
  }
  const digest = sha256(bytes);
  const path = join(
    identityRoot(runtimeRoot, "rollback-snapshots", releaseId, sourceCommit),
    digest,
    filename,
  );
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const seal = (target) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath: target, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(parent);
  if (existsSync(path)) {
    const existing = readPlainBytes(
      path,
      "GATE_F_ROLLBACK_SNAPSHOT_INVALID",
      filename,
      1024 * 1024 * 1024,
    );
    if (!existing.equals(bytes)) fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "snapshot address collision");
  } else {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  seal(path);
  return Object.freeze({ targetPath, snapshotPath: path, snapshotSha256: digest });
}

export async function captureFixedGateFRollbackSnapshots({
  runtimeRoot,
  databaseSnapshotter = snapshotSqliteDatabase,
  liveIdentityInspector = inspectFixedLiveIdentity,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_ROLLBACK_SNAPSHOT_INVALID", "runtimeRoot");
  if (typeof databaseSnapshotter !== "function"
    || typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "snapshotter and SYSTEM TCB controller are required");
  }
  const currentPath = join(runtime, "current");
  const stat = lstatSync(currentPath);
  if (!stat.isSymbolicLink()) fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "current is not a junction");
  const releaseRoot = realpathSync(currentPath);
  if (!within(join(runtime, "releases"), releaseRoot)) {
    fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "current escaped releases");
  }
  const manifest = readCanonicalJson(
    join(releaseRoot, "release-manifest.v1.json"),
    "GATE_F_ROLLBACK_SNAPSHOT_INVALID",
    "active release manifest",
  ).value;
  if (!RELEASE_ID.test(manifest.releaseId || "") || !HEX40.test(manifest.sourceCommit || "")
    || manifest.releaseId !== basename(releaseRoot)) {
    fail("GATE_F_ROLLBACK_SNAPSHOT_INVALID", "active release identity is invalid");
  }
  verifyLiveIdentity(await liveIdentityInspector(runtime), {
    current: { releaseId: manifest.releaseId, sourceCommit: manifest.sourceCommit },
  });
  const snapshotRoot = join(runtime, "rollback-snapshots");
  if (!existsSync(snapshotRoot)) mkdirSync(snapshotRoot, { recursive: false });
  const rootPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: snapshotRoot,
    recursive: false,
  });
  tcbAclController.protect(rootPlan);
  tcbAclController.verify(rootPlan);
  const tempRoot = join(snapshotRoot, ".sqlite-captures");
  if (!existsSync(tempRoot)) mkdirSync(tempRoot, { recursive: false });
  const tempRootPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: tempRoot,
    recursive: false,
  });
  tcbAclController.protect(tempRootPlan);
  tcbAclController.verify(tempRootPlan);
  const controlDb = join(runtime, "state", "control-plane", "control.db");
  const registryDb = join(runtime, "state", "orchestrator", REGISTRY_DATABASE_FILENAME);
  const secret = join(runtime, "secrets", "control-plane-secret-environment.v1.json");
  const keyring = join(runtime, "secrets", "xhs-evidence-digest-keyring.v1.json");
  for (const path of [controlDb, registryDb, secret, keyring]) {
    assertPlainRuntimeChain(runtime, path, "GATE_F_ROLLBACK_SNAPSHOT_INVALID");
    assertPlainFile(path, "GATE_F_ROLLBACK_SNAPSHOT_INVALID", path);
  }
  const [controlBytes, registryBytes] = await Promise.all([
    databaseSnapshotter(controlDb, { tempRoot, tcbAclController, runtimeRoot: runtime }),
    databaseSnapshotter(registryDb, { tempRoot, tcbAclController, runtimeRoot: runtime }),
  ]);
  const publish = (targetPath, filename, bytes) => publishRollbackSnapshot({
    runtimeRoot: runtime,
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    targetPath,
    filename,
    bytes,
    tcbAclController,
  });
  return Object.freeze({
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    snapshots: Object.freeze({
      controlDb: publish(controlDb, "control.db", controlBytes),
      registryDb: publish(registryDb, REGISTRY_DATABASE_FILENAME, registryBytes),
      privateMaterial: Object.freeze([
        publish(secret, "control-plane-secret-environment.v1.json", readPlainBytes(
          secret, "GATE_F_ROLLBACK_SNAPSHOT_INVALID", "secret environment", 32 * 1024,
        )),
        publish(keyring, "xhs-evidence-digest-keyring.v1.json", readPlainBytes(
          keyring, "GATE_F_ROLLBACK_SNAPSHOT_INVALID", "digest keyring", 32 * 1024,
        )),
      ]),
    }),
  });
}

export function prepareGateFCrossReleaseTarget({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  expectedGateId,
  qualificationPackageHash,
  nowMs = Date.now(),
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_CROSS_RELEASE_TARGET_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(expectedGateId || "")
    || !HEX64.test(qualificationPackageHash || "") || !Number.isFinite(Number(nowMs))) {
    fail(code, "target release/source/Gate/package identity is invalid");
  }
  const packagePath = fixedQualificationPackagePath(
    runtime,
    expectedSourceCommit,
    qualificationPackageHash,
  );
  assertPlainRuntimeChain(runtime, packagePath, code);
  const packageRead = readCanonicalJson(packagePath, code, "target qualification Gate package");
  const verified = validateM6QualificationBootstrapPackage({
    package: packageRead.value,
    issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
    m6Root: runtime,
    nowMs: Number(nowMs),
  });
  if (verified.package.packageHash !== qualificationPackageHash
    || verified.package.releaseId !== expectedReleaseId
    || verified.package.sourceCommit !== expectedSourceCommit
    || verified.package.gateId !== expectedGateId) {
    fail(code, "signed Gate package was rebound away from the exact target release");
  }
  const staged = stageM6QualificationBootstrapRotationArtifacts({
    package: verified.package,
    m6Root: runtime,
    issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
    nowMs: Number(nowMs),
  });
  const gateRoot = join(runtime, "m6-gate", expectedGateId);
  for (const [path, recursive] of [[packagePath, false], [gateRoot, true]]) {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath: path, recursive });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  }
  const locksHash = sha256(
    `xw.m6-locks.v1:${domainCanonicalJson(verified.closedEpoch.lockHashes)}`,
  );
  const value = Object.freeze({
    schemaId: GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID,
    gateId: expectedGateId,
    packageHash: qualificationPackageHash,
    package: Object.freeze({ path: packagePath, sha256: sha256(packageRead.bytes) }),
    closedEpochHash: verified.closedEpoch.epochHash,
    locksHash,
    pointer: embeddedArtifact(staged.paths.current, canonicalJsonBytes(staged.pointer)),
  });
  validateGateHandoffDescriptor(value, {
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    expectedGateId,
    code,
  });
  return value;
}

export function verifyGateFCrossReleaseTarget({
  runtimeRoot,
  releaseId,
  sourceCommit,
  gateHandoff,
  requirePointer = false,
  nowMs = Date.now(),
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_CROSS_RELEASE_TARGET_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  const descriptor = validateGateHandoffDescriptor(gateHandoff, {
    runtimeRoot: runtime,
    releaseId,
    sourceCommit,
    code,
  });
  const packageRead = readCanonicalJson(gateHandoff.package.path, code, "target Gate package");
  if (sha256(packageRead.bytes) !== gateHandoff.package.sha256) {
    fail(code, "target Gate package raw bytes drifted");
  }
  const verified = validateM6QualificationBootstrapPackage({
    package: packageRead.value,
    issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
    m6Root: runtime,
    nowMs: Number(nowMs),
  });
  if (verified.package.packageHash !== gateHandoff.packageHash
    || verified.package.releaseId !== releaseId || verified.package.sourceCommit !== sourceCommit
    || verified.package.gateId !== gateHandoff.gateId
    || verified.closedEpoch.epochHash !== gateHandoff.closedEpochHash
    || sha256(`xw.m6-locks.v1:${domainCanonicalJson(verified.closedEpoch.lockHashes)}`)
      !== gateHandoff.locksHash) {
    fail(code, "target Gate package/epoch/locks binding drifted");
  }
  const gateRoot = join(runtime, "m6-gate", gateHandoff.gateId);
  const expectedArtifacts = [
    [join(gateRoot, "locks.v1.json"), verified.package.locksRecord],
    [join(gateRoot, "epochs", `${verified.rootEpoch.epochHash}.json`), verified.package.rootEpochRecord],
    [join(gateRoot, "epochs", `${verified.closedEpoch.epochHash}.json`), verified.package.closedEpochRecord],
    [join(gateRoot, "closeouts", `${verified.package.closeout.closeoutId}.json`), verified.package.closeout],
    [join(gateRoot, "aggregate", `${verified.package.aggregate.sealHash}.json`), verified.package.aggregate],
    [join(gateRoot, "qualification-bootstrap", `${verified.package.scenarioManifest.manifestSha256}.scenario-manifest.json`), verified.package.scenarioManifest],
    [join(gateRoot, "qualification-bootstrap", `${verified.package.resourceSnapshot.snapshotSha256}.resource-snapshot.json`), verified.package.resourceSnapshot],
    [join(gateRoot, "qualification-bootstrap", `${verified.package.packageHash}.package.json`), verified.package],
  ];
  for (const [path, value] of expectedArtifacts) {
    const bytes = readPlainBytes(path, code, "staged target Gate artifact", 64 * 1024 * 1024);
    if (!bytes.equals(canonicalJsonBytes(value))) fail(code, "staged target Gate artifact drifted");
  }
  for (const [path, recursive] of [[gateHandoff.package.path, false], [gateRoot, true]]) {
    tcbAclController.verify(buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath: path, recursive }));
  }
  if (requirePointer) {
    const live = readPlainBytes(gateHandoff.pointer.path, code, "published target Gate pointer");
    if (!live.equals(descriptor.pointerBytes)) fail(code, "published target Gate pointer drifted");
    const loaded = loadM6Gate({
      m6Root: runtime,
      gateId: gateHandoff.gateId,
      issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
      requireLocks: true,
    });
    if (loaded.chain.at(-1)?.epochHash !== gateHandoff.closedEpochHash
      || loaded.currentPointer?.generation !== 0) {
      fail(code, "published target Gate does not load as the signed CLOSED generation");
    }
  }
  return Object.freeze({ verified, pointer: descriptor.pointer });
}

export async function stageGateFTargetCandidateFromFixedAssembler({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  assemblerReceiptHash,
  qualificationPackageHash,
  gateTargetPreparer = prepareGateFCrossReleaseTarget,
  snapshotCapturer = captureFixedGateFRollbackSnapshots,
  tcbAclController = createSystemTcbAclController(),
  snapshotDependencies = {},
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID", "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")
    || !HEX64.test(assemblerReceiptHash || "") || !HEX64.test(qualificationPackageHash || "")) {
    fail("GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID", "release/source/assembler receipt identity is invalid");
  }
  const assemblerRoot = identityRoot(
    runtime, "cutover-m6-assembler", expectedReleaseId, expectedSourceCommit,
  );
  const receiptPath = join(assemblerRoot, "receipts", `${assemblerReceiptHash}.json`);
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const assemblerPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: assemblerRoot,
    recursive: true,
  });
  tcbAclController.protect(assemblerPlan);
  tcbAclController.verify(assemblerPlan);
  const receipt = readCanonicalJson(
    receiptPath,
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 assembler receipt",
  ).value;
  exactObject(
    receipt,
    M64_ASSEMBLER_RECEIPT_KEYS,
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 assembler receipt",
  );
  exactObject(
    receipt.release,
    ["capabilityId", "implementationClosureHash", "manifestPath", "manifestSha256", "releaseId",
      "sourceCommit", "tcbManifestRef"],
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 assembler release",
  );
  exactObject(
    receipt.runtimeBinding,
    ["path", "sha256"],
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 assembler runtime binding",
  );
  const { receiptHash: embeddedReceiptHash, ...receiptBody } = receipt;
  if (receipt.schemaId !== M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID
    || embeddedReceiptHash !== assemblerReceiptHash
    || sha256(`${M64_FINAL_ASSEMBLER_RECEIPT_SCHEMA_ID}:${domainCanonicalJson(receiptBody)}`)
      !== assemblerReceiptHash
    || receipt.release?.releaseId !== expectedReleaseId
    || receipt.release?.sourceCommit !== expectedSourceCommit
    || receipt.privateKeyMaterialRead !== false || receipt.secretMaterialPresent !== false
    || receipt.signatureGenerated !== false
    || !HEX64.test(receipt.runtimeBinding?.sha256 || "")) {
    fail("GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID", "M6 assembler receipt identity drifted");
  }
  const m6Path = join(assemblerRoot, "config", "m6-c1-runtime.v1.json");
  if (!samePath(receipt.runtimeBinding.path, m6Path)) {
    fail("GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID", "M6 assembler output escaped its fixed root");
  }
  tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: m6Path,
    recursive: false,
  }));
  const m6Final = readPlainBytes(
    m6Path,
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 FINAL assembler output",
  );
  if (sha256(m6Final) !== receipt.runtimeBinding.sha256) {
    fail("GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID", "M6 FINAL assembler output hash drifted");
  }
  const m6FinalValue = parseJsonBytes(
    m6Final,
    "GATE_F_TARGET_ASSEMBLER_OUTPUT_INVALID",
    "M6 FINAL assembler output",
  );
  if (typeof gateTargetPreparer !== "function") {
    fail("GATE_F_CROSS_RELEASE_TARGET_INVALID", "target Gate preparer is required");
  }
  const gateHandoff = gateTargetPreparer({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    expectedGateId: m6FinalValue.gateId,
    qualificationPackageHash,
    tcbAclController,
  });
  const serve = (alias) => canonicalJsonBytes({
    schemaVersion: 2,
    runtimeRoot: runtime,
    nodeExe: TRUSTED_NODE_EXECUTABLE,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    deviceConfig: join(runtime, "secrets", "control-plane.devices.json"),
    alias,
  });
  const captured = await snapshotCapturer({
    ...snapshotDependencies,
    runtimeRoot: runtime,
    tcbAclController,
  });
  const candidate = stageGateFTargetCandidate({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    runtimeBindingBytes: { m6Final, serve03: serve("03"), serve04: serve("04") },
    snapshots: captured.snapshots,
    snapshotSource: { releaseId: captured.releaseId, sourceCommit: captured.sourceCommit },
    gateHandoff,
    tcbAclController,
  });
  return Object.freeze({
    ok: true,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    assemblerReceipt: Object.freeze({ path: receiptPath, hash: assemblerReceiptHash }),
    snapshotSource: Object.freeze({
      releaseId: captured.releaseId,
      sourceCommit: captured.sourceCommit,
    }),
    gateHandoff,
    candidate,
  });
}

export function stageGateFTargetCandidate({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  runtimeBindingBytes,
  snapshots,
  snapshotSource,
  gateHandoff,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_CANDIDATE_INVALID", "runtimeRoot");
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const preparedRuntimeBindings = stageGateFTargetRuntimeBindings({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    runtimeBindingBytes,
    tcbAclController,
  });
  exactObject(
    snapshots,
    ["controlDb", "privateMaterial", "registryDb"],
    "GATE_F_TARGET_CANDIDATE_INVALID",
    "snapshots",
  );
  if (!Array.isArray(snapshots.privateMaterial) || snapshots.privateMaterial.length !== 2) {
    fail("GATE_F_TARGET_CANDIDATE_INVALID", "exactly two private snapshots are required");
  }
  exactObject(
    snapshotSource,
    ["releaseId", "sourceCommit"],
    "GATE_F_TARGET_CANDIDATE_INVALID",
    "snapshotSource",
  );
  if (!RELEASE_ID.test(snapshotSource.releaseId || "")
    || !HEX40.test(snapshotSource.sourceCommit || "")) {
    fail("GATE_F_TARGET_CANDIDATE_INVALID", "snapshot source identity is invalid");
  }
  validateGateHandoffDescriptor(gateHandoff, {
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    code: "GATE_F_TARGET_CANDIDATE_INVALID",
  });
  const fixedTargets = [
    join(runtime, "state", "control-plane", "control.db"),
    join(runtime, "state", "orchestrator", REGISTRY_DATABASE_FILENAME),
    join(runtime, "secrets", "control-plane-secret-environment.v1.json"),
    join(runtime, "secrets", "xhs-evidence-digest-keyring.v1.json"),
  ];
  const refs = [snapshots.controlDb, snapshots.registryDb, ...snapshots.privateMaterial];
  for (let index = 0; index < refs.length; index += 1) {
    snapshotRef(
      refs[index], runtime, fixedTargets[index],
      "GATE_F_TARGET_CANDIDATE_INVALID", `candidate snapshot ${index}`,
    );
    const expectedSnapshotRoot = identityRoot(
      runtime, "rollback-snapshots", snapshotSource.releaseId, snapshotSource.sourceCommit,
    );
    if (!within(expectedSnapshotRoot, refs[index].snapshotPath)) {
      fail("GATE_F_TARGET_CANDIDATE_INVALID", "snapshot escaped its captured release/source identity");
    }
    const plan = buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath: refs[index].snapshotPath,
      recursive: false,
    });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  }
  const value = {
    schemaId: GATE_F_TARGET_CANDIDATE_SCHEMA_ID,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    preparedRuntimeBindings,
    snapshots,
    snapshotSource,
    gateHandoff,
  };
  const path = join(
    identityRoot(runtime, "cutover-candidates", expectedReleaseId, expectedSourceCommit),
    GATE_F_TARGET_CANDIDATE_FILENAME,
  );
  const addressed = materializeImmutableIdentityFile({
    runtimeRoot: runtime,
    path,
    value,
    tcbAclController,
    code: "GATE_F_TARGET_CANDIDATE_INVALID",
  });
  return Object.freeze({ ok: true, value: Object.freeze(value), ...addressed });
}

function loadFixedTargetCandidate(runtimeRoot, releaseId, sourceCommit, tcbAclController) {
  const code = "GATE_F_TARGET_CANDIDATE_INVALID";
  const path = join(
    identityRoot(runtimeRoot, "cutover-candidates", releaseId, sourceCommit),
    GATE_F_TARGET_CANDIDATE_FILENAME,
  );
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: path,
    recursive: false,
  }));
  const read = readCanonicalJson(path, code, "fixed target candidate");
  const value = exactObject(
    read.value,
    ["gateHandoff", "preparedRuntimeBindings", "releaseId", "schemaId", "snapshots", "snapshotSource", "sourceCommit"],
    code,
    "target candidate",
  );
  if (value.schemaId !== GATE_F_TARGET_CANDIDATE_SCHEMA_ID
    || value.releaseId !== releaseId || value.sourceCommit !== sourceCommit) {
    fail(code, "target candidate identity drifted");
  }
  exactObject(
    value.snapshotSource,
    ["releaseId", "sourceCommit"],
    code,
    "snapshotSource",
  );
  if (!RELEASE_ID.test(value.snapshotSource.releaseId || "")
    || !HEX40.test(value.snapshotSource.sourceCommit || "")) {
    fail(code, "snapshot source identity drifted");
  }
  exactObject(
    value.preparedRuntimeBindings,
    ["m6Final", "serve03", "serve04"],
    code,
    "preparedRuntimeBindings",
  );
  validateGateHandoffDescriptor(value.gateHandoff, {
    runtimeRoot,
    releaseId,
    sourceCommit,
    code,
  });
  return Object.freeze({ path, value });
}

function materializeTargetReference({
  runtimeRoot,
  releaseId,
  sourceCommit,
  tuplePath,
  tupleSha256,
  tcbAclController,
}) {
  const path = join(
    identityRoot(runtimeRoot, "cutover-targets", releaseId, sourceCommit),
    GATE_F_TARGET_REFERENCE_FILENAME,
  );
  return materializeImmutableIdentityFile({
    runtimeRoot,
    path,
    value: {
      schemaId: GATE_F_TARGET_REFERENCE_SCHEMA_ID,
      releaseId,
      sourceCommit,
      tuple: { path: tuplePath, sha256: tupleSha256 },
    },
    tcbAclController,
    code: "GATE_F_TARGET_REFERENCE_INVALID",
  });
}

function loadTargetReference(runtimeRoot, releaseId, sourceCommit, tcbAclController) {
  const code = "GATE_F_TARGET_REFERENCE_INVALID";
  const path = join(
    identityRoot(runtimeRoot, "cutover-targets", releaseId, sourceCommit),
    GATE_F_TARGET_REFERENCE_FILENAME,
  );
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: path,
    recursive: false,
  }));
  const read = readCanonicalJson(path, code, "target reference");
  const value = exactObject(
    read.value,
    ["releaseId", "schemaId", "sourceCommit", "tuple"],
    code,
    "target reference",
  );
  exactObject(value.tuple, ["path", "sha256"], code, "target tuple reference");
  if (value.schemaId !== GATE_F_TARGET_REFERENCE_SCHEMA_ID
    || value.releaseId !== releaseId || value.sourceCommit !== sourceCommit
    || !HEX64.test(value.tuple.sha256 || "")
    || !samePath(value.tuple.path, join(
      runtimeRoot, "cutover-tuples", value.tuple.sha256, GATE_F_CUTOVER_TUPLE_FILENAME,
    ))) fail(code, "target reference identity/address drifted");
  assertContentAddressedDocument(
    value.tuple.path, value.tuple.sha256, runtimeRoot, code, "target tuple",
  );
  return Object.freeze({ path, value });
}

function buildGateFFinalValidateOnlyCommand(runtimeRoot, tuple) {
  const code = "GATE_F_FINAL_VALIDATE_COMMAND_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!samePath(tuple?.runtimeRoot || "", runtime)
    || !RELEASE_ID.test(tuple?.release?.releaseId || "")
    || !HEX40.test(tuple?.release?.sourceCommit || "")
    || !HEX64.test(tuple?.formal?.launcher?.sha256 || "")
    || !HEX64.test(tuple?.formal?.binding?.sha256 || "")) {
    fail(code, "an exact verified Gate-F tuple is required");
  }
  const launcherPath = absolutePath(tuple.formal.launcher.path, code, "launcherPath");
  const bindingPath = absolutePath(tuple.formal.binding.path, code, "bindingPath");
  if (!within(runtime, launcherPath) || !within(runtime, bindingPath)) {
    fail(code, "launcher validation artifacts escaped the fixed runtime");
  }
  return Object.freeze({
    executable: WINDOWS_POWERSHELL_EXECUTABLE,
    arguments: Object.freeze([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", launcherPath,
      "-RuntimeRoot", runtime,
      "-IdentityBindingPath", bindingPath,
      "-ExpectedLauncherSha256", tuple.formal.launcher.sha256,
      "-ExpectedBindingSha256", tuple.formal.binding.sha256,
      "-ExpectedReleaseId", tuple.release.releaseId,
      "-ExpectedSourceCommit", tuple.release.sourceCommit,
      "-Mode", "FINAL",
      "-ValidateOnly",
    ]),
  });
}

function invokeGateFFinalValidateOnly(command) {
  const systemRoot = join("C:\\", "Windows");
  let raw;
  try {
    raw = execFileSync(command.executable, command.arguments, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: join(systemRoot, "Temp"),
        TMP: join(systemRoot, "Temp"),
        PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      },
    });
  } catch {
    fail(
      "GATE_F_FINAL_VALIDATE_EXECUTION_FAILED",
      "the content-addressed FINAL launcher rejected ValidateOnly",
    );
  }
  try { return JSON.parse(raw); }
  catch {
    fail(
      "GATE_F_FINAL_VALIDATE_RECEIPT_INVALID",
      "the content-addressed FINAL launcher returned malformed validation evidence",
    );
  }
}

function assertPresentMarkers(value) {
  return [
    "DEEPSEEK_API_KEY",
    "XW_M6_GATE_F_OPERATIONS_TOKEN",
    "XW_M6_LIVE_ENTRY_TOKEN",
    "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
  ].every((name) => value?.[name] === "present");
}

function validateGateFFinalDelegateReceipt(value, tuple) {
  const code = "GATE_F_FINAL_VALIDATE_RECEIPT_INVALID";
  exactObject(value, FINAL_LAUNCHER_VALIDATION_KEYS, code, "FINAL launcher validation receipt");
  if (value.ok !== true
    || value.schemaId !== "xw.runtime.control-plane-launcher-validation.v1"
    || value.releaseId !== tuple.release.releaseId
    || value.sourceCommit !== tuple.release.sourceCommit
    || value.launcherSha256 !== tuple.formal.launcher.sha256
    || value.bindingSha256 !== tuple.formal.binding.sha256
    || value.privateMaterial?.secretEnvironment?.sha256
      !== tuple.runtimeBindings.secretEnvironment.sha256
    || value.privateMaterial?.digestKeyring?.sha256 !== tuple.runtimeBindings.digestKeyring.sha256
    || !assertPresentMarkers(value.privateMaterial?.secretEnvironment?.requiredEnvironment)
    || value.privateMaterial?.digestKeyring?.activeKeyId !== "present"
    || value.privateMaterial?.digestKeyring?.keyMaterial !== "present"
    || value.provider?.configSha256 !== tuple.runtimeBindings.provider.sha256
    || value.provider?.providerBundleDigest !== tuple.runtimeBindings.provider.providerBundleDigest
    || value.provider?.closure !== "verified"
    || value.fixedRuntimeBindings?.m6FinalSha256 !== tuple.runtimeBindings.m6Final.sha256
    || value.fixedRuntimeBindings?.serveLaunch03Sha256 !== tuple.runtimeBindings.serve03.sha256
    || value.fixedRuntimeBindings?.serveLaunch04Sha256 !== tuple.runtimeBindings.serve04.sha256
    || value.trustedNode?.sha256 !== tuple.trustedNode.sha256
    || value.delegate?.ok !== true
    || value.delegate?.schemaId !== "xw.runtime.m6-c1-launch-validation.v1"
    || value.delegate?.runtimeMode !== "FINAL"
    || value.delegate?.releaseId !== tuple.release.releaseId
    || value.delegate?.sourceCommit !== tuple.release.sourceCommit
    || !assertPresentMarkers(value.delegate?.requiredEnvironment)) {
    fail(code, "FINAL launcher/delegate validation evidence drifted from the active tuple");
  }
  return value;
}

export async function validateGateFFinalLauncherFixed({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  expectedReleaseId,
  expectedSourceCommit,
  targetReferenceLoader = loadTargetReference,
  tupleVerifier = verifyGateFCutoverTuple,
  launcherIdentityVerifier = verifyGateFLauncherIdentity,
  launcherValidator = invokeGateFFinalValidateOnly,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_FINAL_VALIDATE_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")
    || typeof targetReferenceLoader !== "function" || typeof tupleVerifier !== "function"
    || typeof launcherIdentityVerifier !== "function" || typeof launcherValidator !== "function") {
    fail(code, "fixed release/source identity and validation dependencies are required");
  }
  const target = targetReferenceLoader(
    runtime,
    expectedReleaseId,
    expectedSourceCommit,
    tcbAclController,
  );
  if (target?.value?.releaseId !== expectedReleaseId
    || target?.value?.sourceCommit !== expectedSourceCommit
    || !HEX64.test(target?.value?.tuple?.sha256 || "")) {
    fail(code, "fixed target reference drifted from the requested identity");
  }
  const verified = await tupleVerifier({
    tuplePath: target.value.tuple.path,
    expectedTupleSha256: target.value.tuple.sha256,
    expectedRuntimeRoot: runtime,
    requireActive: true,
    tcbAclController,
  });
  const tuple = verified?.tuple;
  if (verified?.ok !== true || verified.active !== true
    || tuple?.release?.releaseId !== expectedReleaseId
    || tuple?.release?.sourceCommit !== expectedSourceCommit) {
    fail(code, "fixed target tuple failed active current/hash verification");
  }
  const activeIdentity = await launcherIdentityVerifier({
    bindingPath: tuple.formal.binding.path,
    taskXmlPath: tuple.formal.task.xml.path,
    expectedReleaseId,
    expectedSourceCommit,
  });
  if (activeIdentity?.ok !== true || activeIdentity.active !== true
    || activeIdentity.releaseId !== expectedReleaseId
    || activeIdentity.sourceCommit !== expectedSourceCommit
    || activeIdentity.launcher?.bodySha256 !== tuple.formal.launcher.sha256
    || activeIdentity.binding?.sha256 !== tuple.formal.binding.sha256) {
    fail(code, "FINAL validation requires the exact currently active launcher identity");
  }
  const command = buildGateFFinalValidateOnlyCommand(runtime, tuple);
  const delegate = validateGateFFinalDelegateReceipt(await launcherValidator(command), tuple);
  const body = Object.freeze({
    schemaId: GATE_F_FINAL_VALIDATE_FIXED_SCHEMA_ID,
    status: "VALIDATED",
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    launcherSha256: tuple.formal.launcher.sha256,
    bindingSha256: tuple.formal.binding.sha256,
    delegateReceiptSha256: sha256(canonicalJsonBytes(delegate)),
  });
  return Object.freeze({
    ...body,
    validationHash: sha256(Buffer.from(
      `${GATE_F_FINAL_VALIDATE_FIXED_SCHEMA_ID}:${domainCanonicalJson(body)}`,
      "utf8",
    )),
  });
}

function materializeLegacyReference({
  runtimeRoot,
  releaseId,
  sourceCommit,
  prestatePath,
  prestateSha256,
  tcbAclController,
}) {
  const path = join(
    identityRoot(runtimeRoot, "legacy-prestate-references", releaseId, sourceCommit),
    GATE_F_LEGACY_REFERENCE_FILENAME,
  );
  return materializeImmutableIdentityFile({
    runtimeRoot,
    path,
    value: {
      schemaId: GATE_F_LEGACY_REFERENCE_SCHEMA_ID,
      releaseId,
      sourceCommit,
      prestate: { path: prestatePath, sha256: prestateSha256 },
    },
    tcbAclController,
    code: "GATE_F_LEGACY_REFERENCE_INVALID",
  });
}

function loadLegacyReference(runtimeRoot, releaseId, sourceCommit, tcbAclController) {
  const code = "GATE_F_LEGACY_REFERENCE_INVALID";
  const path = join(
    identityRoot(runtimeRoot, "legacy-prestate-references", releaseId, sourceCommit),
    GATE_F_LEGACY_REFERENCE_FILENAME,
  );
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  tcbAclController.verify(buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: path,
    recursive: false,
  }));
  const read = readCanonicalJson(path, code, "legacy prestate reference");
  const value = exactObject(
    read.value,
    ["prestate", "releaseId", "schemaId", "sourceCommit"],
    code,
    "legacy prestate reference",
  );
  exactObject(value.prestate, ["path", "sha256"], code, "legacy prestate address");
  if (value.schemaId !== GATE_F_LEGACY_REFERENCE_SCHEMA_ID
    || value.releaseId !== releaseId || value.sourceCommit !== sourceCommit
    || !HEX64.test(value.prestate.sha256 || "")
    || !samePath(value.prestate.path, join(
      runtimeRoot, "legacy-prestates", value.prestate.sha256, GATE_F_LEGACY_PRESTATE_FILENAME,
    ))) fail(code, "legacy reference identity/address drifted");
  assertContentAddressedDocument(
    value.prestate.path, value.prestate.sha256, runtimeRoot, code, "legacy prestate",
  );
  return Object.freeze({ path, value });
}

function buildPreparedActivationTasks({ runtimeRoot, tcbAclController }) {
  return Object.freeze(AUXILIARY_TASK_SPECS.map((spec) => {
    const xml = buildGateFAuxiliaryTaskXml({ runtimeRoot, taskName: spec.name });
    const bytes = Buffer.from(xml, "utf8");
    const digest = sha256(bytes);
    const path = join(runtimeRoot, "task-bindings", digest, spec.filename);
    materializeExactAddressedFile({
      runtimeRoot,
      path,
      bytes,
      tcbAclController,
      code: "GATE_F_TARGET_TASK_PREPARE_INVALID",
    });
    const definition = parseFormalTaskDefinition(xml);
    return Object.freeze({
      name: spec.name,
      principal: "SYSTEM",
      xml: embeddedArtifact(path, bytes),
      action: definition.action,
    });
  }));
}

function readPreparedArtifact(path, runtimeRoot, label) {
  assertPlainRuntimeChain(runtimeRoot, path, "GATE_F_TARGET_PREPARE_INVALID");
  return embeddedArtifact(
    path,
    readPlainBytes(path, "GATE_F_TARGET_PREPARE_INVALID", label),
  );
}

export function assemblePreparedGateFCutoverTuple({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  preparedRuntimeBindings,
  launcherIdentity,
  snapshots,
  gateHandoff,
  providerConfigInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  nodeInspector = inspectTrustedNode,
  systemTaskClosureInspector = inspectSystemTaskClosure,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_PREPARE_INVALID", "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "target release/source identity is invalid");
  }
  if (launcherIdentity?.ok !== true || launcherIdentity.active !== false
    || launcherIdentity.releaseId !== expectedReleaseId
    || launcherIdentity.sourceCommit !== expectedSourceCommit) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "prepared launcher identity does not bind the target");
  }
  exactObject(
    preparedRuntimeBindings,
    ["m6Final", "serve03", "serve04"],
    "GATE_F_TARGET_PREPARE_INVALID",
    "preparedRuntimeBindings",
  );
  exactObject(
    snapshots,
    ["controlDb", "privateMaterial", "registryDb"],
    "GATE_F_TARGET_PREPARE_INVALID",
    "snapshots",
  );

  const releaseRoot = join(runtime, "releases", expectedReleaseId);
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const manifestRead = readCanonicalJson(
    manifestPath,
    "GATE_F_TARGET_PREPARE_INVALID",
    "target release manifest",
  );
  const manifest = manifestRead.value;
  if (manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.releaseId !== expectedReleaseId || manifest.sourceCommit !== expectedSourceCommit) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "target release manifest identity drifted");
  }
  const operatorPath = join(releaseRoot, ...GATE_F_CUTOVER_OPERATOR_RELEASE_PATH.split("/"));
  const operatorBytes = readPlainBytes(
    operatorPath,
    "GATE_F_TARGET_PREPARE_INVALID",
    "target cutover operator",
  );
  if (manifestEntry(manifest, GATE_F_CUTOVER_OPERATOR_RELEASE_PATH,
    "GATE_F_TARGET_PREPARE_INVALID").sha256 !== sha256(operatorBytes)) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "target cutover operator differs from its manifest");
  }

  const bindingRead = readCanonicalJson(
    launcherIdentity.binding.path,
    "GATE_F_TARGET_PREPARE_INVALID",
    "prepared launcher binding",
  );
  if (sha256(bindingRead.bytes) !== launcherIdentity.binding.sha256) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "prepared launcher binding receipt drifted");
  }
  const binding = bindingRead.value;
  const staged = {};
  for (const key of ["m6Final", "serve03", "serve04"]) {
    const descriptor = preparedRuntimeBindings[key];
    const bytes = readPlainBytes(
      descriptor.path,
      "GATE_F_TARGET_PREPARE_INVALID",
      `${key} staged target binding`,
    );
    if (sha256(bytes) !== descriptor.sha256) {
      fail("GATE_F_TARGET_PREPARE_INVALID", `${key} staged target binding drifted`);
    }
    staged[key] = bytes;
  }

  const provider = providerConfigInspector(runtime);
  const providerBytes = readPlainBytes(
    provider?.path,
    "GATE_F_TARGET_PREPARE_INVALID",
    "provider config",
  );
  if (sha256(providerBytes) !== provider?.sha256 || !HEX64.test(provider?.providerBundleDigest || "")) {
    fail("GATE_F_TARGET_PREPARE_INVALID", "provider closure identity drifted during preparation");
  }
  const privateMaterial = privateMaterialInspector({ runtimeRoot: runtime });
  const trustedNode = nodeInspector(TRUSTED_NODE_EXECUTABLE);
  const systemTaskClosure = systemTaskClosureInspector(runtime);
  const xhsV3PrivateRoots = provisionGateFXhsV3PrivateRoots({
    runtimeRoot: runtime,
    tcbAclController,
  });
  const formalTaskBytes = readPlainBytes(
    launcherIdentity.task.xmlPath,
    "GATE_F_TARGET_PREPARE_INVALID",
    "formal task XML",
  );
  const formalTaskDefinition = parseFormalTaskDefinition(formalTaskBytes.toString("utf8"));
  const activationTasks = buildPreparedActivationTasks({ runtimeRoot: runtime, tcbAclController });

  const tuple = {
    schemaId: GATE_F_CUTOVER_TUPLE_SCHEMA_ID,
    runtimeRoot: runtime,
    release: {
      releaseId: expectedReleaseId,
      sourceCommit: expectedSourceCommit,
      root: releaseRoot,
      manifest: embeddedArtifact(manifestPath, manifestRead.bytes),
    },
    operator: embeddedArtifact(operatorPath, operatorBytes),
    current: { path: join(runtime, "current"), target: releaseRoot },
    formal: {
      binding: embeddedArtifact(launcherIdentity.binding.path, bindingRead.bytes),
      launcher: readPreparedArtifact(launcherIdentity.launcher.bodyPath, runtime, "prepared launcher"),
      task: {
        name: FORMAL_CONTROL_PLANE_TASK_NAME,
        principal: "SYSTEM",
        xml: embeddedArtifact(launcherIdentity.task.xmlPath, formalTaskBytes),
        action: formalTaskDefinition.action,
      },
    },
    activationTasks,
    gateHandoff,
    trustedNode: {
      path: resolve(trustedNode.path),
      version: trustedNode.version,
      sha256: trustedNode.sha256,
    },
    systemTaskClosure,
    xhsV3PrivateRoots,
    runtimeBindings: {
      m6Final: embeddedArtifact(binding.m6FinalBindingPath, staged.m6Final),
      serve03: embeddedArtifact(binding.serveLaunch03Path, staged.serve03),
      serve04: embeddedArtifact(binding.serveLaunch04Path, staged.serve04),
      provider: embeddedArtifact(provider.path, providerBytes, {
        providerBundleDigest: provider.providerBundleDigest,
      }),
      secretEnvironment: {
        path: resolve(privateMaterial.secretEnvironment.path),
        sha256: privateMaterial.secretEnvironment.sha256,
      },
      digestKeyring: {
        path: resolve(privateMaterial.digestKeyring.path),
        sha256: privateMaterial.digestKeyring.sha256,
      },
    },
    liveIdentity: {
      controlPlane: {
        url: GATE_F_CONTROL_HEALTH_URL,
        releaseId: expectedReleaseId,
        sourceCommit: expectedSourceCommit,
      },
      registry: {
        url: GATE_F_REGISTRY_HEALTH_URL,
        releaseId: expectedReleaseId,
        sourceCommit: expectedSourceCommit,
      },
      gate: { url: GATE_F_STATUS_URL, mode: "CLOSED", phase: "CLOSED" },
    },
    snapshots,
  };
  validateCoreTupleShape(tuple, runtime);
  const addressed = materializeGateFCutoverTuple({ runtimeRoot: runtime, tuple, tcbAclController });
  return Object.freeze({ tuple: Object.freeze(tuple), ...addressed });
}

export async function prepareGateFCutoverTarget({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  runtimeBindingBytes,
  snapshots,
  gateHandoff,
  providerConfigInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  nodeInspector = inspectTrustedNode,
  systemTaskClosureInspector = inspectSystemTaskClosure,
  releaseVerifier = verifyReleaseManifest,
  tupleVerifier = verifyGateFCutoverTuple,
  m6CatalogVerifier = loadM6GateFArtifactCatalog,
  gateHandoffVerifier = verifyGateFCrossReleaseTarget,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_PREPARE_INVALID", "runtimeRoot");
  const releaseRoot = join(runtime, "releases", expectedReleaseId || "");
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const release = releaseVerifier({ root: releaseRoot, manifestPath });
  if (!release?.ok) fail("GATE_F_CUTOVER_RELEASE_DIRTY", "target release is not an exact clean formal release");
  const preparedRuntimeBindings = stageGateFTargetRuntimeBindings({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    runtimeBindingBytes,
    tcbAclController,
  });
  const receipt = prepareGateFTargetLauncherArtifacts({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    preparedRuntimeBindings,
    providerConfigInspector,
    privateMaterialInspector,
  });
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  for (const path of [receipt.launcher.bodyPath, receipt.binding.path, receipt.task.xmlPath]) seal(path);
  const assembled = assemblePreparedGateFCutoverTuple({
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    preparedRuntimeBindings,
    launcherIdentity: receipt,
    snapshots,
    gateHandoff,
    providerConfigInspector,
    privateMaterialInspector,
    nodeInspector,
    systemTaskClosureInspector,
    tcbAclController,
  });
  const verified = await tupleVerifier({
    tuplePath: assembled.tuplePath,
    expectedTupleSha256: assembled.tupleSha256,
    expectedRuntimeRoot: runtime,
    requireActive: false,
    releaseVerifier,
    providerInspector: providerConfigInspector,
    privateMaterialInspector,
    nodeInspector,
    m6CatalogVerifier,
    gateHandoffVerifier,
    tcbAclController,
  });
  const targetReference = materializeTargetReference({
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    tuplePath: assembled.tuplePath,
    tupleSha256: assembled.tupleSha256,
    tcbAclController,
  });
  return Object.freeze({
    ok: true,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    preparedRuntimeBindings,
    launcherIdentity: receipt,
    tuplePath: assembled.tuplePath,
    tupleSha256: assembled.tupleSha256,
    tuple: assembled.tuple,
    verified: verified?.ok === true,
    targetReference,
  });
}

export async function prepareGateFCutoverTargetFromFixedCandidate({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  tcbAclController = createSystemTcbAclController(),
  ...dependencies
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_TARGET_CANDIDATE_INVALID", "runtimeRoot");
  const candidate = loadFixedTargetCandidate(
    runtime,
    expectedReleaseId,
    expectedSourceCommit,
    tcbAclController,
  );
  const runtimeBindingBytes = {};
  for (const key of ["m6Final", "serve03", "serve04"]) {
    const descriptor = candidate.value.preparedRuntimeBindings[key];
    runtimeBindingBytes[key] = readPlainBytes(
      descriptor.path,
      "GATE_F_TARGET_CANDIDATE_INVALID",
      `${key} fixed candidate binding`,
    );
    if (sha256(runtimeBindingBytes[key]) !== descriptor.sha256) {
      fail("GATE_F_TARGET_CANDIDATE_INVALID", `${key} fixed candidate binding drifted`);
    }
  }
  return prepareGateFCutoverTarget({
    ...dependencies,
    runtimeRoot: runtime,
    expectedReleaseId,
    expectedSourceCommit,
    runtimeBindingBytes,
    snapshots: candidate.value.snapshots,
    gateHandoff: candidate.value.gateHandoff,
    tcbAclController,
  });
}

function loadTransition(path, runtimeRoot) {
  const code = "GATE_F_CUTOVER_TRANSITION_INVALID";
  const read = readCanonicalJson(path, code, "authorized transition");
  const value = read.value;
  exactObject(value, ["from", "intent", "schemaId", "to"], code, "transition");
  if (value.schemaId !== GATE_F_CUTOVER_TRANSITION_SCHEMA_ID
    || value.intent !== "GATE_F_RELEASE_CUTOVER") fail(code, "transition schema or intent drifted");
  for (const side of ["from", "to"]) {
    exactObject(value[side], ["path", "sha256"], code, side);
    absolutePath(value[side].path, code, `${side}.path`);
    if (!HEX64.test(value[side].sha256 || "")
      || !samePath(value[side].path, join(
        runtimeRoot, "cutover-tuples", value[side].sha256, GATE_F_CUTOVER_TUPLE_FILENAME,
      ))) fail(code, `${side} tuple reference escaped its content address`);
  }
  if (value.from.sha256 === value.to.sha256) fail(code, "from/to tuples must differ");
  return value;
}

function loadLegacyBootstrapAuthorization(path, runtimeRoot) {
  const code = "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID";
  const read = readCanonicalJson(path, code, "legacy bootstrap authorization");
  const value = read.value;
  exactObject(value, ["intent", "legacy", "schemaId", "to"], code, "legacy bootstrap authorization");
  if (value.schemaId !== GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_SCHEMA_ID
    || value.intent !== "GATE_F_LEGACY_BOOTSTRAP") {
    fail(code, "legacy bootstrap authorization schema or intent drifted");
  }
  for (const [side, root, filename] of [
    ["legacy", "legacy-prestates", GATE_F_LEGACY_PRESTATE_FILENAME],
    ["to", "cutover-tuples", GATE_F_CUTOVER_TUPLE_FILENAME],
  ]) {
    exactObject(value[side], ["path", "sha256"], code, side);
    if (!HEX64.test(value[side].sha256 || "")
      || !samePath(value[side].path, join(
        runtimeRoot, root, value[side].sha256, filename,
      ))) fail(code, `${side} reference escaped its fixed content address`);
  }
  return value;
}

function verifyAuthorizedTransitionTcb(runtimeRoot, transitionPath, tcbAclController) {
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  for (const targetPath of [runtimeRoot, transitionPath]) {
    tcbAclController.verify(buildSystemTcbAclPlan({
      boundaryPath: runtimeRoot,
      targetPath,
      recursive: false,
    }));
  }
}

function defaultPathOps() {
  return Object.freeze({
    exists: existsSync,
    read: readFileSync,
    realpath: realpathSync,
    rename: renameSync,
    removeFile: (path) => rmSync(path, { force: true }),
    removeLink: unlinkSync,
    symlink: symlinkSync,
    write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
  });
}

function replacePathWithBackup({ targetPath, stage, verify, remove, ops, code }) {
  const nonce = randomUUID();
  const temp = join(dirname(targetPath), `.${basename(targetPath)}.${nonce}.tmp`);
  const backup = join(dirname(targetPath), `.${basename(targetPath)}.${nonce}.backup`);
  const failed = join(dirname(targetPath), `.${basename(targetPath)}.${nonce}.failed`);
  let backupCreated = false;
  let replacementInstalled = false;
  let committed = false;
  try {
    stage(temp);
    ops.rename(targetPath, backup);
    backupCreated = true;
    ops.rename(temp, targetPath);
    replacementInstalled = true;
    verify(targetPath);
    remove(backup);
    backupCreated = false;
    committed = true;
  } catch (cause) {
    const rollbackFailures = [];
    if (replacementInstalled && ops.exists(targetPath)) {
      try { ops.rename(targetPath, failed); }
      catch (error) { rollbackFailures.push(error); }
    }
    if (backupCreated && ops.exists(backup)) {
      try { ops.rename(backup, targetPath); backupCreated = false; }
      catch (error) { rollbackFailures.push(error); }
    }
    if (ops.exists(failed)) {
      try { remove(failed); } catch (error) { rollbackFailures.push(error); }
    }
    if (rollbackFailures.length > 0) {
      fail(`${code}_BACKUP_RETAINED`, "replacement failed and its backup could not be fully restored", {
        causeCode: cause?.code || code,
        backupPath: backupCreated ? backup : null,
        rollbackFailureCount: rollbackFailures.length,
      });
    }
    throw cause;
  } finally {
    if (ops.exists(temp)) {
      try { remove(temp); } catch {}
    }
    if (committed && ops.exists(backup)) {
      try { remove(backup); } catch {}
    }
  }
}

export function replaceFileWithBackup({
  targetPath,
  bytes,
  beforeInstall = () => {},
  afterInstall = () => {},
  ops = defaultPathOps(),
} = {}) {
  const target = absolutePath(targetPath, "GATE_F_CUTOVER_SLOT_INVALID", "targetPath");
  if (!Buffer.isBuffer(bytes)) fail("GATE_F_CUTOVER_SLOT_INVALID", "replacement bytes are required");
  assertPlainFile(target, "GATE_F_CUTOVER_SLOT_INVALID", target);
  replacePathWithBackup({
    targetPath: target,
    ops,
    code: "GATE_F_CUTOVER_SLOT_REPLACE_FAILED",
    stage(temp) { ops.write(temp, bytes); beforeInstall(temp); },
    verify(installed) {
      afterInstall(installed);
      const actual = ops.read(installed);
      if (!Buffer.isBuffer(actual) || !actual.equals(bytes)) {
        fail("GATE_F_CUTOVER_SLOT_POSTCONDITION_FAILED", "installed bytes differ from the tuple");
      }
    },
    remove: ops.removeFile,
  });
}

export function replaceCurrentJunction({
  runtimeRoot,
  targetPath,
  ops = defaultPathOps(),
} = {}) {
  const target = resolve(targetPath);
  const current = join(runtimeRoot, "current");
  if (!within(join(runtimeRoot, "releases"), target)) {
    fail("GATE_F_CUTOVER_CURRENT_INVALID", "current target escaped releases");
  }
  assertPlainDirectory(target, "GATE_F_CUTOVER_CURRENT_INVALID", "release target");
  const currentStat = lstatSync(current);
  if (!currentStat.isSymbolicLink()) fail("GATE_F_CUTOVER_CURRENT_INVALID", "current is not a junction");
  replacePathWithBackup({
    targetPath: current,
    ops,
    code: "GATE_F_CUTOVER_CURRENT_REPLACE_FAILED",
    stage(temp) { ops.symlink(target, temp, process.platform === "win32" ? "junction" : "dir"); },
    verify(installed) {
      if (!samePath(ops.realpath(installed), target)) {
        fail("GATE_F_CUTOVER_CURRENT_POSTCONDITION_FAILED", "current did not resolve to the target release");
      }
    },
    remove: ops.removeLink,
  });
}

function assertContentAddressedDocument(path, expectedSha256, runtimeRoot, code, label) {
  assertPlainRuntimeChain(runtimeRoot, path, code);
  const read = readCanonicalJson(path, code, label);
  if (sha256(read.bytes) !== expectedSha256) fail(code, `${label} bytes drifted from its address`);
}

function writeFixedAuthorizationDocument({
  runtimeRoot,
  authorizationPath,
  document,
  expectedCurrentAuthorizationSha256,
  tcbAclController,
}) {
  if (!(expectedCurrentAuthorizationSha256 === null
    || HEX64.test(expectedCurrentAuthorizationSha256 || ""))) {
    fail(
      "GATE_F_AUTHORIZATION_CAS_REQUIRED",
      "expected current authorization SHA-256 (or explicit null for absent) is required",
    );
  }
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const cutoverRoot = join(runtimeRoot, "cutover");
  if (!existsSync(cutoverRoot)) mkdirSync(cutoverRoot, { recursive: false });
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  seal(runtimeRoot);
  seal(cutoverRoot);
  const lockPath = join(cutoverRoot, `${basename(authorizationPath)}.cas.lock`);
  let lockFd = null;
  let lockOwned = false;
  try {
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      lockOwned = true;
      seal(lockPath);
    } catch (cause) {
      if (cause?.code === "EEXIST") {
        fail("GATE_F_AUTHORIZATION_CAS_BUSY", "authorization compare-and-swap is already in progress");
      }
      throw cause;
    }
    const bytes = canonicalJsonBytes(document);
    const exists = existsSync(authorizationPath);
    if (exists !== (expectedCurrentAuthorizationSha256 !== null)) {
      fail("GATE_F_AUTHORIZATION_CAS_MISMATCH", "authorization slot presence changed");
    }
    if (exists) {
      const current = readPlainBytes(
        authorizationPath,
        "GATE_F_AUTHORIZATION_CAS_MISMATCH",
        "current authorization",
      );
      if (sha256(current) !== expectedCurrentAuthorizationSha256) {
        fail("GATE_F_AUTHORIZATION_CAS_MISMATCH", "authorization slot bytes changed");
      }
      replaceFileWithBackup({
        targetPath: authorizationPath,
        bytes,
        beforeInstall: seal,
        afterInstall: seal,
      });
    } else {
      const temp = join(cutoverRoot, `.${basename(authorizationPath)}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        seal(temp);
        renameSync(temp, authorizationPath);
        seal(authorizationPath);
      } finally {
        if (existsSync(temp)) rmSync(temp, { force: true });
      }
    }
    return Object.freeze({
      path: authorizationPath,
      sha256: sha256(bytes),
      previousSha256: expectedCurrentAuthorizationSha256,
    });
  } finally {
    try { if (lockFd !== null) closeSync(lockFd); } catch {}
    if (lockOwned && existsSync(lockPath)) rmSync(lockPath, { force: true });
  }
}

export function authorizeGateFCutoverTransition({
  runtimeRoot,
  fromTupleSha256,
  toTupleSha256,
  expectedCurrentAuthorizationSha256,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_TRANSITION_INVALID", "runtimeRoot");
  if (!HEX64.test(fromTupleSha256 || "") || !HEX64.test(toTupleSha256 || "")
    || fromTupleSha256 === toTupleSha256) {
    fail("GATE_F_CUTOVER_TRANSITION_INVALID", "distinct content-addressed from/to tuples are required");
  }
  const tuplePath = (digest) => join(
    runtime, "cutover-tuples", digest, GATE_F_CUTOVER_TUPLE_FILENAME,
  );
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  for (const targetPath of [runtime, tuplePath(fromTupleSha256), tuplePath(toTupleSha256)]) {
    tcbAclController.verify(buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath,
      recursive: false,
    }));
  }
  assertContentAddressedDocument(
    tuplePath(fromTupleSha256), fromTupleSha256, runtime,
    "GATE_F_CUTOVER_TRANSITION_INVALID", "from tuple",
  );
  assertContentAddressedDocument(
    tuplePath(toTupleSha256), toTupleSha256, runtime,
    "GATE_F_CUTOVER_TRANSITION_INVALID", "to tuple",
  );
  const authorizationPath = join(runtime, "cutover", "authorized-transition.v1.json");
  return writeFixedAuthorizationDocument({
    runtimeRoot: runtime,
    authorizationPath,
    document: {
      schemaId: GATE_F_CUTOVER_TRANSITION_SCHEMA_ID,
      intent: "GATE_F_RELEASE_CUTOVER",
      from: { path: tuplePath(fromTupleSha256), sha256: fromTupleSha256 },
      to: { path: tuplePath(toTupleSha256), sha256: toTupleSha256 },
    },
    expectedCurrentAuthorizationSha256,
    tcbAclController,
  });
}

export function authorizeGateFLegacyBootstrap({
  runtimeRoot,
  legacyPrestateSha256,
  toTupleSha256,
  expectedCurrentAuthorizationSha256,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(
    runtimeRoot,
    "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID",
    "runtimeRoot",
  );
  if (!HEX64.test(legacyPrestateSha256 || "") || !HEX64.test(toTupleSha256 || "")) {
    fail(
      "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID",
      "content-addressed legacy prestate and target tuple are required",
    );
  }
  const legacyPath = join(
    runtime, "legacy-prestates", legacyPrestateSha256, GATE_F_LEGACY_PRESTATE_FILENAME,
  );
  const targetPath = join(
    runtime, "cutover-tuples", toTupleSha256, GATE_F_CUTOVER_TUPLE_FILENAME,
  );
  if (typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL verifier is required");
  }
  for (const target of [runtime, legacyPath, targetPath]) {
    tcbAclController.verify(buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath: target,
      recursive: false,
    }));
  }
  assertContentAddressedDocument(
    legacyPath, legacyPrestateSha256, runtime,
    "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID", "legacy prestate",
  );
  assertContentAddressedDocument(
    targetPath, toTupleSha256, runtime,
    "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID", "target tuple",
  );
  const authorizationPath = join(runtime, "cutover", "authorized-legacy-bootstrap.v1.json");
  return writeFixedAuthorizationDocument({
    runtimeRoot: runtime,
    authorizationPath,
    document: {
      schemaId: GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_SCHEMA_ID,
      intent: "GATE_F_LEGACY_BOOTSTRAP",
      legacy: { path: legacyPath, sha256: legacyPrestateSha256 },
      to: { path: targetPath, sha256: toTupleSha256 },
    },
    expectedCurrentAuthorizationSha256,
    tcbAclController,
  });
}

export function authorizeGateFCutoverTransitionByIdentity({
  runtimeRoot,
  fromReleaseId,
  fromSourceCommit,
  toReleaseId,
  toSourceCommit,
  expectedCurrentAuthorizationSha256,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_TRANSITION_INVALID", "runtimeRoot");
  const from = loadTargetReference(runtime, fromReleaseId, fromSourceCommit, tcbAclController);
  const to = loadTargetReference(runtime, toReleaseId, toSourceCommit, tcbAclController);
  return authorizeGateFCutoverTransition({
    runtimeRoot: runtime,
    fromTupleSha256: from.value.tuple.sha256,
    toTupleSha256: to.value.tuple.sha256,
    expectedCurrentAuthorizationSha256,
    tcbAclController,
  });
}

export function authorizeGateFLegacyBootstrapByIdentity({
  runtimeRoot,
  legacyReleaseId,
  legacySourceCommit,
  toReleaseId,
  toSourceCommit,
  expectedCurrentAuthorizationSha256,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(
    runtimeRoot,
    "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID",
    "runtimeRoot",
  );
  const legacy = loadLegacyReference(runtime, legacyReleaseId, legacySourceCommit, tcbAclController);
  const target = loadTargetReference(runtime, toReleaseId, toSourceCommit, tcbAclController);
  return authorizeGateFLegacyBootstrap({
    runtimeRoot: runtime,
    legacyPrestateSha256: legacy.value.prestate.sha256,
    toTupleSha256: target.value.tuple.sha256,
    expectedCurrentAuthorizationSha256,
    tcbAclController,
  });
}

function runSchtasks(args, { tolerateFailure = false } = {}) {
  try {
    return execFileSync("schtasks.exe", args, {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
  } catch (error) {
    if (tolerateFailure) return "";
    fail("GATE_F_CUTOVER_TASK_MUTATION_FAILED", String(error?.stderr || error?.message || "schtasks failed").trim());
  }
}

function assertScheduledTaskStopped(taskName) {
  if (!TASKS_TO_ACTIVATE.includes(taskName)) {
    fail("GATE_F_CUTOVER_TASK_INVALID", "task stop verification escaped the activation set");
  }
  const script = [
    "& { param([string]$Name)",
    "$task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop",
    "$state = [string]$task.State",
    "if ($state -ne 'Ready' -and $state -ne 'Disabled') { throw ('TASK_NOT_STOPPED:' + $state) }",
    "[string]$task.State",
    "}",
  ].join(" ");
  try {
    execFileSync(
      join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script, taskName],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    );
  } catch (error) {
    fail(
      "GATE_F_CUTOVER_TASK_STOP_UNPROVEN",
      `${taskName} could not be proven stopped: ${String(error?.stderr || error?.message || "unknown").trim()}`,
    );
  }
}

function fenceIdentityFromRow(row) {
  if (!row) return null;
  let allowlist;
  try { allowlist = JSON.parse(row.allowlist_json); } catch {
    fail("GATE_F_CROSS_RELEASE_DATABASE_INVALID", "control DB fence allowlist is malformed");
  }
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

function readStandaloneFence(dbPath, label = "control DB") {
  const code = "GATE_F_CROSS_RELEASE_DATABASE_INVALID";
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    fail(code, `${label} has WAL/SHM sidecars`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
  try {
    const quick = db.prepare("PRAGMA quick_check").get();
    if (!quick || !Object.values(quick).includes("ok")) fail(code, `${label} quick_check failed`);
    const rows = db.prepare("SELECT * FROM m6_gate_fence WHERE marker='M6'").all();
    if (rows.length !== 1) fail(code, `${label} must contain exactly one M6 fence`);
    return fenceIdentityFromRow(rows[0]);
  } finally { db.close(); }
}

function verifyStandaloneSqliteDatabase(dbPath, label) {
  const code = "GATE_F_CROSS_RELEASE_DATABASE_INVALID";
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    fail(code, `${label} has WAL/SHM sidecars`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false });
  try {
    const quick = db.prepare("PRAGMA quick_check").get();
    if (!quick || !Object.values(quick).includes("ok")) fail(code, `${label} quick_check failed`);
  } finally { db.close(); }
}

function captureStoppedGateFRollbackSnapshots({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  stoppedGuard = () => TASKS_TO_ACTIVATE.forEach(assertScheduledTaskStopped),
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_CROSS_RELEASE_STOPPED_SNAPSHOT_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  stoppedGuard();
  const currentPath = join(runtime, "current");
  const stat = lstatSync(currentPath);
  if (!stat.isSymbolicLink()) fail(code, "current is not a junction");
  const releaseRoot = realpathSync(currentPath);
  const manifest = readCanonicalJson(
    join(releaseRoot, "release-manifest.v1.json"),
    code,
    "stopped active release manifest",
  ).value;
  if (manifest.releaseId !== expectedReleaseId || manifest.sourceCommit !== expectedSourceCommit) {
    fail(code, "stopped current release differs from the authorized from tuple");
  }
  const controlDb = join(runtime, "state", "control-plane", "control.db");
  const registryDb = join(runtime, "state", "orchestrator", REGISTRY_DATABASE_FILENAME);
  const secret = join(runtime, "secrets", "control-plane-secret-environment.v1.json");
  const keyring = join(runtime, "secrets", "xhs-evidence-digest-keyring.v1.json");
  for (const dbPath of [controlDb, registryDb]) {
    if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
      fail(code, "stopped database has WAL/SHM sidecars");
    }
  }
  const controlBytes = readPlainBytes(controlDb, code, "control.db", 1024 * 1024 * 1024);
  const registryBytes = readPlainBytes(registryDb, code, REGISTRY_DATABASE_FILENAME, 1024 * 1024 * 1024);
  const verificationRoot = join(runtime, "cutover-handoffs", ".staging", randomUUID());
  mkdirSync(verificationRoot, { recursive: true });
  const verificationPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: verificationRoot,
    recursive: true,
  });
  tcbAclController.protect(verificationPlan);
  tcbAclController.verify(verificationPlan);
  try {
    const controlCopy = join(verificationRoot, "control.db");
    const registryCopy = join(verificationRoot, REGISTRY_DATABASE_FILENAME);
    writeFileSync(controlCopy, controlBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(registryCopy, registryBytes, { flag: "wx", mode: 0o600 });
    readStandaloneFence(controlCopy, "stopped control DB copy");
    verifyStandaloneSqliteDatabase(registryCopy, "stopped registry DB copy");
  } finally {
    if (existsSync(verificationRoot)) rmSync(verificationRoot, { recursive: true, force: true });
  }
  const publish = (targetPath, filename, bytes, maxBytes = 1024 * 1024 * 1024) =>
    publishRollbackSnapshot({
      runtimeRoot: runtime,
      releaseId: expectedReleaseId,
      sourceCommit: expectedSourceCommit,
      targetPath,
      filename,
      bytes: bytes ?? readPlainBytes(targetPath, code, filename, maxBytes),
      tcbAclController,
    });
  return Object.freeze({
    controlDb: publish(controlDb, "control.db", controlBytes),
    registryDb: publish(registryDb, REGISTRY_DATABASE_FILENAME, registryBytes),
    privateMaterial: Object.freeze([
      publish(secret, "control-plane-secret-environment.v1.json", null, 32 * 1024),
      publish(keyring, "xhs-evidence-digest-keyring.v1.json", null, 32 * 1024),
    ]),
  });
}

export async function prepareStoppedGateFCrossReleaseHandoff({
  runtimeRoot,
  fromTuple = null,
  fromLegacyPrestate = null,
  toTuple,
  stoppedGuard,
  now = Date.now,
  stateFactory = (options) => new StateStore(options),
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const code = "GATE_F_CROSS_RELEASE_HANDOFF_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (typeof now !== "function" || typeof stateFactory !== "function") {
    fail(code, "clock and stopped database state factory are required");
  }
  const tupleSource = fromTuple !== null;
  const legacySource = fromLegacyPrestate !== null;
  if (tupleSource === legacySource) {
    fail(code, "exactly one stopped tuple or legacy prestate source is required");
  }
  const fromShape = tupleSource
    ? validateCoreTupleShape(fromTuple, runtime)
    : validateGateFLegacyPrestateDocument(fromLegacyPrestate, { expectedRuntimeRoot: runtime });
  const toShape = validateCoreTupleShape(toTuple, runtime);
  const fromRelease = tupleSource
    ? fromTuple.release
    : Object.freeze({
      releaseId: fromLegacyPrestate.current.releaseId,
      sourceCommit: fromLegacyPrestate.current.sourceCommit,
    });
  if (fromRelease.releaseId === toTuple.release.releaseId) {
    fail(code, "cross-release handoff requires distinct from/to release and Gate identities");
  }
  const target = verifyGateFCrossReleaseTarget({
    runtimeRoot: runtime,
    releaseId: toTuple.release.releaseId,
    sourceCommit: toTuple.release.sourceCommit,
    gateHandoff: toTuple.gateHandoff,
    requirePointer: false,
    nowMs: Number(now()),
    tcbAclController,
  });
  let sourceSnapshots = captureStoppedGateFRollbackSnapshots({
    runtimeRoot: runtime,
    expectedReleaseId: fromRelease.releaseId,
    expectedSourceCommit: fromRelease.sourceCommit,
    stoppedGuard,
    tcbAclController,
  });
  if (legacySource) {
    const expected = fromLegacyPrestate.snapshots;
    const verificationRoot = join(runtime, "cutover-handoffs", ".staging", randomUUID());
    mkdirSync(verificationRoot, { recursive: true });
    const verificationPlan = buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath: verificationRoot,
      recursive: true,
    });
    tcbAclController.protect(verificationPlan);
    tcbAclController.verify(verificationPlan);
    try {
      const stoppedRefs = [sourceSnapshots.controlDb, sourceSnapshots.registryDb];
      const expectedRefs = [expected.controlDb, expected.registryDb];
      for (let index = 0; index < expectedRefs.length; index += 1) {
        const stoppedCopy = join(verificationRoot, `stopped-${index}.db`);
        writeFileSync(
          stoppedCopy,
          readPlainBytes(stoppedRefs[index].snapshotPath, code, "stopped legacy database copy", 1024 * 1024 * 1024),
          { flag: "wx", mode: 0o600 },
        );
        const stoppedBackup = await snapshotSqliteDatabase(stoppedCopy, {
          tempRoot: verificationRoot,
          tcbAclController,
          runtimeRoot: runtime,
        });
        if (sha256(stoppedBackup) !== expectedRefs[index].snapshotSha256) {
          fail(code, "stopped legacy database state differs from its authorized rollback prestate");
        }
      }
    } finally {
      if (existsSync(verificationRoot)) rmSync(verificationRoot, { recursive: true, force: true });
    }
    for (let index = 0; index < expected.privateMaterial.length; index += 1) {
      const actual = sourceSnapshots.privateMaterial[index];
      const ref = expected.privateMaterial[index];
      if (!samePath(actual.targetPath, ref.targetPath)
        || sha256(readPlainBytes(ref.targetPath, code, "stopped legacy private material", 32 * 1024))
          !== ref.snapshotSha256) {
        fail(code, "stopped legacy private state differs from its authorized rollback prestate");
      }
    }
    // The authorized online-backup snapshots, rather than an unbound fresh copy,
    // are the sole source bytes for the transformed target DB and rollback receipt.
    sourceSnapshots = expected;
  }
  const fenceVerificationRoot = join(runtime, "cutover-handoffs", ".staging", randomUUID());
  mkdirSync(fenceVerificationRoot, { recursive: true });
  const fenceVerificationPlan = buildSystemTcbAclPlan({
    boundaryPath: runtime,
    targetPath: fenceVerificationRoot,
    recursive: true,
  });
  tcbAclController.protect(fenceVerificationPlan);
  tcbAclController.verify(fenceVerificationPlan);
  let sourceFence;
  try {
    const fenceCopy = join(fenceVerificationRoot, "control.db");
    writeFileSync(
      fenceCopy,
      readPlainBytes(
        sourceSnapshots.controlDb.snapshotPath,
        code,
        "stopped source snapshot",
        1024 * 1024 * 1024,
      ),
      { flag: "wx", mode: 0o600 },
    );
    sourceFence = readStandaloneFence(fenceCopy, "stopped source snapshot copy");
  } finally {
    if (existsSync(fenceVerificationRoot)) {
      rmSync(fenceVerificationRoot, { recursive: true, force: true });
    }
  }
  if (tupleSource) {
    const expectedSource = {
      gateId: fromTuple.gateHandoff.gateId,
      epochHash: fromTuple.gateHandoff.closedEpochHash,
      generation: 0,
      mode: "CLOSED",
      purpose: null,
      allowlist: ["01"],
      expiresAt: sourceFence.expiresAt,
      releaseId: fromRelease.releaseId,
      sourceCommit: fromRelease.sourceCommit,
      locksHash: fromTuple.gateHandoff.locksHash,
    };
    if (domainCanonicalJson(sourceFence) !== domainCanonicalJson(expectedSource)) {
      fail(code, "stopped source DB is not the exact authorized from Gate fence");
    }
  } else {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sourceFence.gateId || "")
      || !HEX64.test(sourceFence.epochHash || "") || !HEX64.test(sourceFence.locksHash || "")
      || sourceFence.generation !== 0 || sourceFence.mode !== "CLOSED"
      || sourceFence.purpose !== null
      || domainCanonicalJson(sourceFence.allowlist) !== domainCanonicalJson(["01"])
      || sourceFence.releaseId !== fromRelease.releaseId
      || sourceFence.sourceCommit !== fromRelease.sourceCommit
      || !Number.isFinite(Date.parse(sourceFence.expiresAt || ""))) {
      fail(code, "stopped legacy DB is not an exact release-bound generation-0 CLOSED fence");
    }
    if (sourceFence.gateId === toTuple.gateHandoff.gateId) {
      fail(code, "cross-release handoff requires distinct from/to release and Gate identities");
    }
    const sourceGateRoot = join(runtime, "m6-gate", sourceFence.gateId);
    tcbAclController.verify(buildSystemTcbAclPlan({
      boundaryPath: runtime,
      targetPath: sourceGateRoot,
      recursive: true,
    }));
    const loadedSource = loadM6Gate({
      m6Root: runtime,
      gateId: sourceFence.gateId,
      issuerAllowlistPath: join(runtime, "m6-gate", "issuer-keys.json"),
      requireLocks: true,
    });
    assertM6FileDbPointerConsistency({
      loaded: loadedSource,
      fence: sourceFence,
      pointer: loadedSource.currentPointer,
    });
  }
  const stagingRoot = join(runtime, "cutover-handoffs", ".staging", randomUUID());
  mkdirSync(stagingRoot, { recursive: true });
  const stagingPlan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath: stagingRoot, recursive: true });
  tcbAclController.protect(stagingPlan);
  tcbAclController.verify(stagingPlan);
  const workingDb = join(stagingRoot, "control.db");
  let state = null;
  try {
    writeFileSync(
      workingDb,
      readPlainBytes(sourceSnapshots.controlDb.snapshotPath, code, "stopped source DB", 1024 * 1024 * 1024),
      { flag: "wx", mode: 0o600 },
    );
    state = stateFactory({ dbPath: workingDb, now, m6RuntimeMode: "QUALIFICATION_ONLY" });
    const transformed = state.handoffM6ClosedFenceForCutover({
      expectedFence: sourceFence,
      nextEpoch: target.verified.closedEpoch,
      locksHash: toTuple.gateHandoff.locksHash,
      packageHash: toTuple.gateHandoff.packageHash,
    });
    if (Object.values(transformed.resourceCounts).some((count) => count !== 0)
      || Object.values(transformed.durableResidue).some((count) => count !== 0)) {
      fail(code, "database transformer did not prove exact zero resources/residue");
    }
    state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    state.close();
    state = null;
    const targetFence = readStandaloneFence(workingDb, "transformed target DB");
    assertM6FileDbPointerConsistency({
      loaded: { chain: [target.verified.rootEpoch, target.verified.closedEpoch] },
      fence: targetFence,
      pointer: target.pointer,
    });
    const targetSnapshot = publishRollbackSnapshot({
      runtimeRoot: runtime,
      releaseId: toTuple.release.releaseId,
      sourceCommit: toTuple.release.sourceCommit,
      targetPath: join(runtime, "state", "control-plane", "control.db"),
      filename: "control.db",
      bytes: readPlainBytes(workingDb, code, "transformed target DB", 1024 * 1024 * 1024),
      tcbAclController,
    });
    const createdAt = new Date(Number(now())).toISOString();
    const body = {
      schemaId: GATE_F_CROSS_RELEASE_HANDOFF_SCHEMA_ID,
      from: { releaseId: fromRelease.releaseId, sourceCommit: fromRelease.sourceCommit, fence: sourceFence },
      to: { releaseId: toTuple.release.releaseId, sourceCommit: toTuple.release.sourceCommit, fence: targetFence },
      packageHash: toTuple.gateHandoff.packageHash,
      packageSha256: toTuple.gateHandoff.package.sha256,
      sourceSnapshots,
      targetControlDb: targetSnapshot,
      pointer: { path: toTuple.gateHandoff.pointer.path, sha256: toTuple.gateHandoff.pointer.sha256 },
      databaseAuditHash: transformed.audit.handoffHash,
      createdAt,
    };
    const receiptHash = sha256(`${GATE_F_CROSS_RELEASE_HANDOFF_SCHEMA_ID}:${domainCanonicalJson(body)}`);
    const receipt = Object.freeze({ ...body, receiptHash });
    const receiptPath = join(
      identityRoot(runtime, "cutover-handoffs", toTuple.release.releaseId, toTuple.release.sourceCommit),
      "receipts",
      `${receiptHash}.json`,
    );
    materializeExactAddressedFile({
      runtimeRoot: runtime,
      path: receiptPath,
      bytes: canonicalJsonBytes(receipt),
      tcbAclController,
      code,
    });
    void fromShape;
    void toShape;
    return Object.freeze({ receipt, receiptPath, sourceSnapshots, targetSnapshot, targetPointer: toTuple.gateHandoff.pointer });
  } finally {
    try { state?.close(); } catch {}
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function publishAndVerifyGateFHandoffPointer({ runtimeRoot, toTuple, handoff, tcbAclController }) {
  const bytes = decodeArtifact(handoff.targetPointer, "GATE_F_CROSS_RELEASE_HANDOFF_INVALID", "target Gate pointer");
  materializeExactAddressedFile({
    runtimeRoot,
    path: handoff.targetPointer.path,
    bytes,
    tcbAclController,
    code: "GATE_F_CROSS_RELEASE_HANDOFF_INVALID",
  });
  verifyGateFCrossReleaseTarget({
    runtimeRoot,
    releaseId: toTuple.release.releaseId,
    sourceCommit: toTuple.release.sourceCommit,
    gateHandoff: toTuple.gateHandoff,
    requirePointer: true,
    tcbAclController,
  });
  const loaded = loadM6Gate({
    m6Root: runtimeRoot,
    gateId: toTuple.gateHandoff.gateId,
    issuerAllowlistPath: join(runtimeRoot, "m6-gate", "issuer-keys.json"),
    requireLocks: true,
  });
  const controlDbPath = join(runtimeRoot, "state", "control-plane", "control.db");
  if (existsSync(`${controlDbPath}-wal`) || existsSync(`${controlDbPath}-shm`)) {
    fail(
      "GATE_F_CROSS_RELEASE_DATABASE_INVALID",
      "installed target control DB acquired WAL/SHM sidecars before activation",
    );
  }
  const installedBytes = readPlainBytes(
    controlDbPath,
    "GATE_F_CROSS_RELEASE_DATABASE_INVALID",
    "installed target control DB",
    1024 * 1024 * 1024,
  );
  if (sha256(installedBytes) !== handoff.targetSnapshot.snapshotSha256) {
    fail(
      "GATE_F_CROSS_RELEASE_DATABASE_INVALID",
      "installed target control DB differs from the handoff content address",
    );
  }
  const verificationRoot = join(runtimeRoot, "cutover-handoffs", ".staging", randomUUID());
  mkdirSync(verificationRoot, { recursive: true });
  const verificationPlan = buildSystemTcbAclPlan({
    boundaryPath: runtimeRoot,
    targetPath: verificationRoot,
    recursive: true,
  });
  tcbAclController.protect(verificationPlan);
  tcbAclController.verify(verificationPlan);
  let fence;
  try {
    const verificationDb = join(verificationRoot, "control.db");
    writeFileSync(verificationDb, installedBytes, { flag: "wx", mode: 0o600 });
    fence = readStandaloneFence(verificationDb, "installed target control DB copy");
  } finally {
    if (existsSync(verificationRoot)) rmSync(verificationRoot, { recursive: true, force: true });
  }
  assertM6FileDbPointerConsistency({ loaded, fence, pointer: loaded.currentPointer });
  return Object.freeze({ fence });
}

export function createNativeGateFCutoverAdapter({
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  if (!samePath(runtimeRoot, FORMAL_RUNTIME_ROOT)) {
    fail("GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "native apply is fixed to the formal runtime root");
  }
  if (typeof tcbAclController?.protect !== "function" || typeof tcbAclController?.verify !== "function") {
    fail("GATE_F_CUTOVER_TCB_CONTROLLER_INVALID", "SYSTEM TCB ACL protect/verify controller is required");
  }
  const seal = (targetPath) => {
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtimeRoot, targetPath, recursive: false });
    tcbAclController.protect(plan);
    tcbAclController.verify(plan);
  };
  return Object.freeze({
    async stop() {
      for (const taskName of [...TASKS_TO_ACTIVATE].reverse()) {
        runSchtasks(["/End", "/TN", taskName], { tolerateFailure: true });
        assertScheduledTaskStopped(taskName);
      }
    },
    async writeRuntimeBinding(artifact) {
      const allowed = new Set([
        pathKey(join(runtimeRoot, "config", "m6-c1-runtime.v1.json")),
        pathKey(join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json")),
        pathKey(join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json")),
      ]);
      if (!allowed.has(pathKey(artifact.path))) fail("GATE_F_CUTOVER_SLOT_INVALID", "runtime binding path is not fixed");
      replaceFileWithBackup({
        targetPath: artifact.path,
        bytes: decodeArtifact(artifact, "GATE_F_CUTOVER_SLOT_INVALID", "runtime binding"),
        beforeInstall: seal,
        afterInstall: seal,
      });
    },
    async restoreSnapshot(ref) {
      const allowedTargets = new Set([
        pathKey(join(runtimeRoot, "state", "control-plane", "control.db")),
        pathKey(join(runtimeRoot, "state", "orchestrator", REGISTRY_DATABASE_FILENAME)),
        pathKey(join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json")),
        pathKey(join(runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json")),
      ]);
      if (!allowedTargets.has(pathKey(ref?.targetPath || ""))) {
        fail("GATE_F_CUTOVER_SNAPSHOT_RESTORE_INVALID", "snapshot target escaped the fixed rollback set");
      }
      const snapshotBytes = readPlainBytes(
        ref.snapshotPath,
        "GATE_F_CUTOVER_SNAPSHOT_RESTORE_INVALID",
        "rollback snapshot",
        1024 * 1024 * 1024,
      );
      if (sha256(snapshotBytes) !== ref.snapshotSha256) {
        fail("GATE_F_CUTOVER_SNAPSHOT_RESTORE_INVALID", "rollback snapshot bytes drifted");
      }
      if (/\.db$/iu.test(ref.targetPath)
        && ["-wal", "-shm"].some((suffix) => existsSync(`${ref.targetPath}${suffix}`))) {
        fail(
          "GATE_F_CUTOVER_DB_SIDECAR_PRESENT",
          "database rollback requires stopped tasks and absent WAL/SHM sidecars",
        );
      }
      replaceFileWithBackup({
        targetPath: ref.targetPath,
        bytes: snapshotBytes,
        beforeInstall: seal,
        afterInstall: seal,
      });
      if (sha256(readPlainBytes(
        ref.snapshotPath,
        "GATE_F_CUTOVER_SNAPSHOT_RESTORE_INVALID",
        "rollback snapshot",
        1024 * 1024 * 1024,
      )) !== ref.snapshotSha256) {
        fail("GATE_F_CUTOVER_SNAPSHOT_RESTORE_INVALID", "immutable rollback snapshot changed during restore");
      }
    },
    async captureTargetDigest(ref) {
      return sha256(readPlainBytes(
        ref.targetPath,
        "GATE_F_CUTOVER_SNAPSHOT_TARGET_INVALID",
        "snapshot target",
        1024 * 1024 * 1024,
      ));
    },
    async proveTargetDigest(ref, expectedSha256) {
      const actual = await this.captureTargetDigest(ref);
      if (actual !== expectedSha256) {
        fail("GATE_F_CUTOVER_SNAPSHOT_TARGET_DRIFT", "a non-started cutover changed DB/private material");
      }
    },
    async switchCurrent(target) { replaceCurrentJunction({ runtimeRoot, targetPath: target }); },
    async registerTask(task) {
      if (!TASKS_TO_ACTIVATE.includes(task?.name)) {
        fail("GATE_F_CUTOVER_TASK_INVALID", "task registration escaped the pinned activation set");
      }
      const taskXmlPath = absolutePath(task?.xml?.path, "GATE_F_CUTOVER_TASK_INVALID", "task XML path");
      const argumentsList = task.name === FORMAL_CONTROL_PLANE_TASK_NAME
        ? buildCreateOnlyTaskRegistration({ taskXmlPath, taskName: task.name }).arguments
        : ["/Create", "/TN", task.name, "/XML", taskXmlPath];
      runSchtasks([...argumentsList, "/F"]);
    },
    async start() {
      for (const taskName of TASKS_TO_ACTIVATE) runSchtasks(["/Run", "/TN", taskName]);
    },
  });
}

function settledRows(names, rows) {
  return Object.freeze(rows.map((row, index) => Object.freeze({
    component: names[index],
    status: row.status,
    ...(row.status === "rejected" ? { errorCode: row.reason?.code || "GATE_F_CUTOVER_ROLLBACK_STEP_FAILED" } : {}),
  })));
}

function tupleTasks(tuple) {
  return [tuple.formal.task, ...tuple.activationTasks];
}

function tupleSnapshotRefs(tuple) {
  return [
    tuple.snapshots.controlDb,
    tuple.snapshots.registryDb,
    ...tuple.snapshots.privateMaterial,
  ];
}

function legacyRollbackState(prestate) {
  return Object.freeze({
    current: prestate.current,
    runtimeBindings: prestate.runtimeBindings,
    formal: Object.freeze({ task: prestate.tasks[0] }),
    activationTasks: Object.freeze(prestate.tasks.slice(1)),
    snapshots: prestate.snapshots,
  });
}

function assertSharedCutoverTcb(fromState, toTuple) {
  if (!samePath(fromState.runtimeRoot, toTuple.runtimeRoot)
    || fromState.runtimeBindings.provider.sha256 !== toTuple.runtimeBindings.provider.sha256
    || fromState.runtimeBindings.secretEnvironment.sha256
      !== toTuple.runtimeBindings.secretEnvironment.sha256
    || fromState.runtimeBindings.digestKeyring.sha256
      !== toTuple.runtimeBindings.digestKeyring.sha256
    || JSON.stringify(fromState.trustedNode) !== JSON.stringify(toTuple.trustedNode)
    || JSON.stringify(fromState.systemTaskClosure) !== JSON.stringify(toTuple.systemTaskClosure)) {
    fail(
      "GATE_F_CUTOVER_SHARED_TCB_DRIFT",
      "transition attempted to switch provider/private/Node TCB identities",
    );
  }
}

function assertCutoverAdapter(adapter) {
  for (const method of [
    "captureTargetDigest", "proveTargetDigest", "registerTask", "restoreSnapshot", "start", "stop",
    "switchCurrent", "writeRuntimeBinding",
  ]) {
    if (typeof adapter?.[method] !== "function") {
      fail("GATE_F_CUTOVER_ADAPTER_INVALID", `cutover adapter is missing ${method}`);
    }
  }
}

async function settleSequential(steps) {
  const rows = [];
  for (const step of steps) {
    try {
      await step.run();
      rows.push({ status: "fulfilled", value: undefined });
    } catch (reason) {
      rows.push({ status: "rejected", reason });
    }
  }
  return settledRows(steps.map((step) => step.name), rows);
}

function assertExecutingOperator(tuple, executingOperatorPath) {
  const path = absolutePath(
    executingOperatorPath,
    "GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID",
    "executingOperatorPath",
  );
  if (!samePath(path, tuple.operator.path)) {
    fail(
      "GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID",
      "the executing operator is not the manifest-pinned source in the active release",
    );
  }
  const bytes = readPlainBytes(path, "GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID", "executing operator");
  if (sha256(bytes) !== tuple.operator.sha256) {
    fail("GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID", "executing operator bytes drifted");
  }
}

async function rollbackAllSettled(adapter, fromTuple, verifyFrom, {
  activationAttempted,
  preApplyTargetDigests,
}) {
  const stop = await settleSequential([{ name: "fixedTasks", run: () => adapter.stop() }]);
  const snapshots = tupleSnapshotRefs(fromTuple);
  const restoreSteps = [
    { name: "m6Final", run: () => adapter.writeRuntimeBinding(fromTuple.runtimeBindings.m6Final) },
    { name: "serve03", run: () => adapter.writeRuntimeBinding(fromTuple.runtimeBindings.serve03) },
    { name: "serve04", run: () => adapter.writeRuntimeBinding(fromTuple.runtimeBindings.serve04) },
    { name: "current", run: () => adapter.switchCurrent(fromTuple.current.target) },
    ...tupleTasks(fromTuple).map((task) => ({
      name: `task:${task.name}`,
      run: () => adapter.registerTask(task),
    })),
    ...snapshots.map((ref, index) => ({
      name: `${activationAttempted ? "restore" : "prove"}:snapshot:${index}`,
      run: () => activationAttempted
        ? adapter.restoreSnapshot(ref)
        : adapter.proveTargetDigest(ref, preApplyTargetDigests[index]),
    })),
  ];
  const stopped = stop.every((row) => row.status === "fulfilled");
  const restore = stopped
    ? await settleSequential(restoreSteps)
    : Object.freeze(restoreSteps.map((step) => Object.freeze({
      component: step.name,
      status: "rejected",
      errorCode: "GATE_F_CUTOVER_RESTORE_SKIPPED_TASKS_NOT_STOPPED",
    })));
  const allRestored = stop.every((row) => row.status === "fulfilled")
    && restore.every((row) => row.status === "fulfilled");
  const start = allRestored
    ? await settleSequential([{ name: "fixedTasks", run: () => adapter.start() }])
    : Object.freeze([Object.freeze({
      component: "fixedTasks",
      status: "rejected",
      errorCode: "GATE_F_CUTOVER_RESTART_SKIPPED",
    })]);
  let verified = false;
  let verificationErrorCode = null;
  if (allRestored && start[0].status === "fulfilled") {
    try { await verifyFrom(); verified = true; }
    catch (error) { verificationErrorCode = error?.code || "GATE_F_CUTOVER_ROLLBACK_POSTCONDITION_FAILED"; }
  }
  return Object.freeze({
    stop,
    restore,
    start,
    verified,
    verificationErrorCode,
  });
}

export async function executeGateFCutover({
  transitionPath = GATE_F_AUTHORIZED_TRANSITION_PATH,
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  adapter = createNativeGateFCutoverAdapter({ runtimeRoot }),
  tupleVerifier = verifyGateFCutoverTuple,
  verifierDependencies = {},
  handoffBuilder = prepareStoppedGateFCrossReleaseHandoff,
  handoffDependencies = {},
  handoffPointerPublisher = publishAndVerifyGateFHandoffPointer,
  executingOperatorPath = null,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "runtimeRoot");
  const transitionPathFull = absolutePath(transitionPath, "GATE_F_CUTOVER_TRANSITION_INVALID", "transitionPath");
  if (!samePath(transitionPathFull, join(runtime, "cutover", "authorized-transition.v1.json"))) {
    fail("GATE_F_CUTOVER_TRANSITION_INVALID", "apply accepts only the fixed authorized transition path");
  }
  verifyAuthorizedTransitionTcb(runtime, transitionPathFull, tcbAclController);
  const transition = loadTransition(transitionPathFull, runtime);
  const verifySide = (side, requireActive) => tupleVerifier({
    ...verifierDependencies,
    tuplePath: transition[side].path,
    expectedTupleSha256: transition[side].sha256,
    expectedRuntimeRoot: runtime,
    requireActive,
  });
  const from = await verifySide("from", true);
  const to = await verifySide("to", false);
  if (executingOperatorPath !== null) assertExecutingOperator(from.tuple, executingOperatorPath);
  assertSharedCutoverTcb(from.tuple, to.tuple);
  assertCutoverAdapter(adapter);
  const preApplyTargetDigests = [];
  for (const ref of tupleSnapshotRefs(from.tuple)) {
    preApplyTargetDigests.push(await adapter.captureTargetDigest(ref));
  }

  const applied = [];
  let activationAttempted = false;
  let handoff = null;
  try {
    await adapter.stop(); applied.push("fixedTasksStopped");
    handoff = await handoffBuilder({
      ...handoffDependencies,
      runtimeRoot: runtime,
      fromTuple: from.tuple,
      toTuple: to.tuple,
      tcbAclController,
    });
    applied.push("crossReleaseHandoffPrepared");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.m6Final); applied.push("m6Final");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.serve03); applied.push("serve03");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.serve04); applied.push("serve04");
    activationAttempted = true;
    await adapter.restoreSnapshot(handoff.targetSnapshot); applied.push("controlDbFence");
    handoffPointerPublisher({ runtimeRoot: runtime, toTuple: to.tuple, handoff, tcbAclController });
    applied.push("gatePointer");
    await adapter.switchCurrent(to.tuple.current.target); applied.push("current");
    for (const task of tupleTasks(to.tuple)) {
      await adapter.registerTask(task);
      applied.push(`task:${task.name}`);
    }
    await adapter.start(); applied.push("fixedTasksStarted");
    const postflight = await verifySide("to", true);
    if (!HEX64.test(postflight.taskProcessClosure?.closureSha256 || "")) {
      fail(
        "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID",
        "cutover postflight did not prove exact task-owned process ancestry",
      );
    }
    return Object.freeze({
      ok: true,
      schemaId: GATE_F_CUTOVER_RECEIPT_SCHEMA_ID,
      fromTupleSha256: from.tupleSha256,
      toTupleSha256: to.tupleSha256,
      fromReleaseId: from.releaseId,
      toReleaseId: to.releaseId,
      applied: Object.freeze(applied),
      crossReleaseHandoff: Object.freeze({
        receiptHash: handoff.receipt.receiptHash,
        receiptPath: handoff.receiptPath,
        packageHash: handoff.receipt.packageHash,
        packageSha256: handoff.receipt.packageSha256,
        targetControlDbSha256: handoff.targetSnapshot.snapshotSha256,
      }),
      postflight: Object.freeze({
        active: postflight.active,
        releaseId: postflight.releaseId,
        taskOwnedProcessClosureSha256: postflight.taskProcessClosure?.closureSha256,
      }),
      rollbackSnapshots: to.tuple.snapshots,
    });
  } catch (cause) {
    const rollback = await rollbackAllSettled(
      adapter,
      handoff ? { ...from.tuple, snapshots: handoff.sourceSnapshots } : from.tuple,
      () => verifySide("from", true),
      { activationAttempted, preApplyTargetDigests },
    );
    const code = rollback.verified
      ? "GATE_F_CUTOVER_APPLY_ROLLED_BACK" : "GATE_F_CUTOVER_ROLLBACK_INCOMPLETE";
    throw Object.assign(new Error(`${code}: cutover did not commit`), {
      code,
      causeCode: cause?.code || "GATE_F_CUTOVER_APPLY_FAILED",
      receipt: Object.freeze({
        ok: false,
        schemaId: GATE_F_CUTOVER_RECEIPT_SCHEMA_ID,
        fromTupleSha256: from.tupleSha256,
        toTupleSha256: to.tupleSha256,
        applied: Object.freeze(applied),
        rollback,
        rollbackSnapshots: from.tuple.snapshots,
      }),
    });
  }
}

export async function executeLegacyGateFBootstrap({
  authorizationPath = GATE_F_AUTHORIZED_LEGACY_BOOTSTRAP_PATH,
  runtimeRoot = FORMAL_RUNTIME_ROOT,
  adapter = createNativeGateFCutoverAdapter({ runtimeRoot }),
  legacyVerifier = verifyGateFLegacyPrestate,
  tupleVerifier = verifyGateFCutoverTuple,
  handoffBuilder = prepareStoppedGateFCrossReleaseHandoff,
  handoffDependencies = {},
  handoffPointerPublisher = publishAndVerifyGateFHandoffPointer,
  legacyVerifierDependencies = {},
  tupleVerifierDependencies = {},
  executingOperatorPath = null,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "GATE_F_CUTOVER_RUNTIME_ROOT_INVALID", "runtimeRoot");
  const path = absolutePath(
    authorizationPath,
    "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID",
    "authorizationPath",
  );
  if (!samePath(path, join(runtime, "cutover", "authorized-legacy-bootstrap.v1.json"))) {
    fail(
      "GATE_F_LEGACY_BOOTSTRAP_AUTHORIZATION_INVALID",
      "bootstrap accepts only the fixed legacy authorization path",
    );
  }
  verifyAuthorizedTransitionTcb(runtime, path, tcbAclController);
  const authorization = loadLegacyBootstrapAuthorization(path, runtime);
  const legacy = await legacyVerifier({
    ...legacyVerifierDependencies,
    prestatePath: authorization.legacy.path,
    expectedPrestateSha256: authorization.legacy.sha256,
    expectedRuntimeRoot: runtime,
    requireActive: true,
  });
  const to = await tupleVerifier({
    ...tupleVerifierDependencies,
    tuplePath: authorization.to.path,
    expectedTupleSha256: authorization.to.sha256,
    expectedRuntimeRoot: runtime,
    requireActive: false,
  });
  if (executingOperatorPath !== null) assertExecutingOperator(to.tuple, executingOperatorPath);
  assertSharedCutoverTcb(legacy.prestate, to.tuple);
  assertCutoverAdapter(adapter);
  const rollbackState = legacyRollbackState(legacy.prestate);
  const preApplyTargetDigests = [];
  for (const ref of tupleSnapshotRefs(rollbackState)) {
    preApplyTargetDigests.push(await adapter.captureTargetDigest(ref));
  }

  const applied = [];
  let activationAttempted = false;
  let handoff = null;
  try {
    await adapter.stop(); applied.push("fixedTasksStopped");
    handoff = await handoffBuilder({
      ...handoffDependencies,
      runtimeRoot: runtime,
      fromLegacyPrestate: legacy.prestate,
      toTuple: to.tuple,
      tcbAclController,
    });
    applied.push("crossReleaseHandoffPrepared");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.m6Final); applied.push("m6Final");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.serve03); applied.push("serve03");
    await adapter.writeRuntimeBinding(to.tuple.runtimeBindings.serve04); applied.push("serve04");
    activationAttempted = true;
    await adapter.restoreSnapshot(handoff.targetSnapshot); applied.push("controlDbFence");
    handoffPointerPublisher({ runtimeRoot: runtime, toTuple: to.tuple, handoff, tcbAclController });
    applied.push("gatePointer");
    await adapter.switchCurrent(to.tuple.current.target); applied.push("current");
    for (const task of tupleTasks(to.tuple)) {
      await adapter.registerTask(task);
      applied.push(`task:${task.name}`);
    }
    await adapter.start(); applied.push("fixedTasksStarted");
    const postflight = await tupleVerifier({
      ...tupleVerifierDependencies,
      tuplePath: authorization.to.path,
      expectedTupleSha256: authorization.to.sha256,
      expectedRuntimeRoot: runtime,
      requireActive: true,
    });
    if (!HEX64.test(postflight.taskProcessClosure?.closureSha256 || "")) {
      fail(
        "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID",
        "legacy bootstrap postflight did not prove exact task-owned process ancestry",
      );
    }
    return Object.freeze({
      ok: true,
      schemaId: GATE_F_CUTOVER_RECEIPT_SCHEMA_ID,
      bootstrap: true,
      legacyPrestateSha256: legacy.prestateSha256,
      fromReleaseId: legacy.releaseId,
      toTupleSha256: to.tupleSha256,
      toReleaseId: to.releaseId,
      applied: Object.freeze(applied),
      crossReleaseHandoff: Object.freeze({
        receiptHash: handoff.receipt.receiptHash,
        receiptPath: handoff.receiptPath,
        packageHash: handoff.receipt.packageHash,
        packageSha256: handoff.receipt.packageSha256,
        targetControlDbSha256: handoff.targetSnapshot.snapshotSha256,
      }),
      postflight: Object.freeze({
        active: postflight.active,
        releaseId: postflight.releaseId,
        taskOwnedProcessClosureSha256: postflight.taskProcessClosure?.closureSha256,
      }),
      rollbackSnapshots: to.tuple.snapshots,
    });
  } catch (cause) {
    const rollback = await rollbackAllSettled(
      adapter,
      rollbackState,
      () => legacyVerifier({
        ...legacyVerifierDependencies,
        prestatePath: authorization.legacy.path,
        expectedPrestateSha256: authorization.legacy.sha256,
        expectedRuntimeRoot: runtime,
        requireActive: true,
      }),
      { activationAttempted, preApplyTargetDigests },
    );
    const code = rollback.verified
      ? "GATE_F_LEGACY_BOOTSTRAP_ROLLED_BACK"
      : "GATE_F_LEGACY_BOOTSTRAP_ROLLBACK_INCOMPLETE";
    throw Object.assign(new Error(`${code}: legacy bootstrap did not commit`), {
      code,
      causeCode: cause?.code || "GATE_F_LEGACY_BOOTSTRAP_APPLY_FAILED",
      receipt: Object.freeze({
        ok: false,
        schemaId: GATE_F_CUTOVER_RECEIPT_SCHEMA_ID,
        bootstrap: true,
        legacyPrestateSha256: legacy.prestateSha256,
        toTupleSha256: to.tupleSha256,
        applied: Object.freeze(applied),
        rollback,
        rollbackSnapshots: legacy.prestate.snapshots,
      }),
    });
  }
}

function assertReleaseOperatorIdentity(runtimeRoot, releaseId, sourceCommit, executingOperatorPath) {
  const code = "GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID";
  if (!RELEASE_ID.test(releaseId || "") || !HEX40.test(sourceCommit || "")) {
    fail(code, "release/source identity is invalid");
  }
  const releaseRoot = join(runtimeRoot, "releases", releaseId);
  const expectedPath = join(releaseRoot, ...GATE_F_CUTOVER_OPERATOR_RELEASE_PATH.split("/"));
  const actualPath = absolutePath(executingOperatorPath, code, "executingOperatorPath");
  if (!samePath(actualPath, expectedPath)) {
    fail(code, "bounded preparation/authorization must execute the target manifest-pinned operator");
  }
  const manifest = readCanonicalJson(
    join(releaseRoot, "release-manifest.v1.json"),
    code,
    "release manifest",
  ).value;
  const bytes = readPlainBytes(actualPath, code, "executing operator");
  if (manifest.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.releaseId !== releaseId || manifest.sourceCommit !== sourceCommit
    || manifestEntry(manifest, GATE_F_CUTOVER_OPERATOR_RELEASE_PATH, code).sha256 !== sha256(bytes)) {
    fail(code, "bounded command operator differs from the formal release manifest");
  }
}

function parseExpectedAuthorizationHash(value) {
  if (value === "absent") return null;
  if (!HEX64.test(value || "")) {
    fail(
      "GATE_F_CUTOVER_ARGUMENT_INVALID",
      "authorization compare-and-swap token must be absent or a non-zero SHA-256",
    );
  }
  return value;
}

export function parseGateFCutoverCommand(argv) {
  if (!Array.isArray(argv)) fail("GATE_F_CUTOVER_ARGUMENT_INVALID", "arguments must be an array");
  if (argv.length === 1 && argv[0] === "preflight-authorized-fixed") return "preflight";
  if (argv.length === 1 && argv[0] === "apply-authorized-fixed") return "apply";
  if (argv.length === 1 && argv[0] === "preflight-legacy-bootstrap-fixed") {
    return "legacy-preflight";
  }
  if (argv.length === 1 && argv[0] === "bootstrap-authorized-fixed") return "legacy-bootstrap";
  if (argv.length === 3 && argv[0] === "prepare-target-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")) {
    return Object.freeze({ kind: "prepare-target", releaseId: argv[1], sourceCommit: argv[2] });
  }
  if (argv.length === 3 && argv[0] === "validate-final-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")) {
    return Object.freeze({ kind: "validate-final", releaseId: argv[1], sourceCommit: argv[2] });
  }
  if (argv.length === 5 && argv[0] === "stage-candidate-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")
    && HEX64.test(argv[3] || "") && HEX64.test(argv[4] || "")) {
    return Object.freeze({
      kind: "stage-candidate",
      releaseId: argv[1],
      sourceCommit: argv[2],
      assemblerReceiptHash: argv[3],
      qualificationPackageHash: argv[4],
    });
  }
  if (argv.length === 5 && argv[0] === "capture-legacy-prestate-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")
    && RELEASE_ID.test(argv[3] || "") && HEX40.test(argv[4] || "")) {
    return Object.freeze({
      kind: "capture-legacy",
      legacyReleaseId: argv[1],
      legacySourceCommit: argv[2],
      targetReleaseId: argv[3],
      targetSourceCommit: argv[4],
    });
  }
  if (argv.length === 6 && argv[0] === "authorize-transition-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")
    && RELEASE_ID.test(argv[3] || "") && HEX40.test(argv[4] || "")) {
    return Object.freeze({
      kind: "authorize-transition",
      fromReleaseId: argv[1],
      fromSourceCommit: argv[2],
      toReleaseId: argv[3],
      toSourceCommit: argv[4],
      expectedCurrentAuthorizationSha256: parseExpectedAuthorizationHash(argv[5]),
    });
  }
  if (argv.length === 6 && argv[0] === "authorize-legacy-bootstrap-fixed"
    && RELEASE_ID.test(argv[1] || "") && HEX40.test(argv[2] || "")
    && RELEASE_ID.test(argv[3] || "") && HEX40.test(argv[4] || "")) {
    return Object.freeze({
      kind: "authorize-legacy-bootstrap",
      legacyReleaseId: argv[1],
      legacySourceCommit: argv[2],
      toReleaseId: argv[3],
      toSourceCommit: argv[4],
      expectedCurrentAuthorizationSha256: parseExpectedAuthorizationHash(argv[5]),
    });
  }
  fail(
    "GATE_F_CUTOVER_ARGUMENT_INVALID",
    "production cutover requires one exact fixed authorization command with no paths, endpoints, tokens, or options",
  );
}

async function main(argv) {
  const command = parseGateFCutoverCommand(argv);
  const tcbAclController = createSystemTcbAclController();
  if (typeof command === "object") {
    const executingOperatorPath = fileURLToPath(import.meta.url);
    if (command.kind === "validate-final") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.releaseId,
        command.sourceCommit,
        executingOperatorPath,
      );
      const receipt = await validateGateFFinalLauncherFixed({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        expectedReleaseId: command.releaseId,
        expectedSourceCommit: command.sourceCommit,
        tcbAclController,
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return;
    }
    if (command.kind === "stage-candidate") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.releaseId,
        command.sourceCommit,
        executingOperatorPath,
      );
      const staged = await stageGateFTargetCandidateFromFixedAssembler({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        expectedReleaseId: command.releaseId,
        expectedSourceCommit: command.sourceCommit,
        assemblerReceiptHash: command.assemblerReceiptHash,
        qualificationPackageHash: command.qualificationPackageHash,
        tcbAclController,
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        releaseId: staged.releaseId,
        sourceCommit: staged.sourceCommit,
        assemblerReceipt: staged.assemblerReceipt,
        snapshotSource: staged.snapshotSource,
        gateHandoff: staged.gateHandoff,
        candidate: { path: staged.candidate.path, sha256: staged.candidate.sha256 },
      }, null, 2)}\n`);
      return;
    }
    if (command.kind === "prepare-target") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.releaseId,
        command.sourceCommit,
        executingOperatorPath,
      );
      const prepared = await prepareGateFCutoverTargetFromFixedCandidate({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        expectedReleaseId: command.releaseId,
        expectedSourceCommit: command.sourceCommit,
        tcbAclController,
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        releaseId: prepared.releaseId,
        sourceCommit: prepared.sourceCommit,
        tupleSha256: prepared.tupleSha256,
        targetReference: prepared.targetReference,
      }, null, 2)}\n`);
      return;
    }
    if (command.kind === "capture-legacy") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.targetReleaseId,
        command.targetSourceCommit,
        executingOperatorPath,
      );
      const candidate = loadFixedTargetCandidate(
        FORMAL_RUNTIME_ROOT,
        command.targetReleaseId,
        command.targetSourceCommit,
        tcbAclController,
      );
      if (candidate.value.snapshotSource.releaseId !== command.legacyReleaseId
        || candidate.value.snapshotSource.sourceCommit !== command.legacySourceCommit) {
        fail(
          "GATE_F_LEGACY_PRESTATE_INVALID",
          "target candidate snapshots were not captured from the authorized legacy identity",
        );
      }
      const captured = await captureGateFLegacyPrestate({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        snapshots: candidate.value.snapshots,
        tcbAclController,
      });
      if (captured.releaseId !== command.legacyReleaseId
        || captured.sourceCommit !== command.legacySourceCommit) {
        fail("GATE_F_LEGACY_PRESTATE_INVALID", "captured active legacy identity drifted from command");
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        releaseId: captured.releaseId,
        sourceCommit: captured.sourceCommit,
        prestateSha256: captured.prestateSha256,
        legacyReference: captured.legacyReference,
      }, null, 2)}\n`);
      return;
    }
    if (command.kind === "authorize-transition") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.fromReleaseId,
        command.fromSourceCommit,
        executingOperatorPath,
      );
      const authorized = authorizeGateFCutoverTransitionByIdentity({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        ...command,
        tcbAclController,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, authorization: authorized }, null, 2)}\n`);
      return;
    }
    if (command.kind === "authorize-legacy-bootstrap") {
      assertReleaseOperatorIdentity(
        FORMAL_RUNTIME_ROOT,
        command.toReleaseId,
        command.toSourceCommit,
        executingOperatorPath,
      );
      const authorized = authorizeGateFLegacyBootstrapByIdentity({
        runtimeRoot: FORMAL_RUNTIME_ROOT,
        ...command,
        tcbAclController,
      });
      process.stdout.write(`${JSON.stringify({ ok: true, authorization: authorized }, null, 2)}\n`);
      return;
    }
    fail("GATE_F_CUTOVER_ARGUMENT_INVALID", "bounded command kind is unsupported");
  }
  if (command === "legacy-preflight" || command === "legacy-bootstrap") {
    verifyAuthorizedTransitionTcb(
      FORMAL_RUNTIME_ROOT,
      GATE_F_AUTHORIZED_LEGACY_BOOTSTRAP_PATH,
      tcbAclController,
    );
    const authorization = loadLegacyBootstrapAuthorization(
      GATE_F_AUTHORIZED_LEGACY_BOOTSTRAP_PATH,
      FORMAL_RUNTIME_ROOT,
    );
    if (command === "legacy-preflight") {
      const legacy = await verifyGateFLegacyPrestate({
        prestatePath: authorization.legacy.path,
        expectedPrestateSha256: authorization.legacy.sha256,
        expectedRuntimeRoot: FORMAL_RUNTIME_ROOT,
        requireActive: true,
      });
      const to = await verifyGateFCutoverTuple({
        tuplePath: authorization.to.path,
        expectedTupleSha256: authorization.to.sha256,
        expectedRuntimeRoot: FORMAL_RUNTIME_ROOT,
        requireActive: false,
      });
      assertExecutingOperator(to.tuple, fileURLToPath(import.meta.url));
      assertSharedCutoverTcb(legacy.prestate, to.tuple);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        legacy: legacy.releaseId,
        to: to.releaseId,
      })}\n`);
      return;
    }
    const receipt = await executeLegacyGateFBootstrap({
      executingOperatorPath: fileURLToPath(import.meta.url),
      tcbAclController,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  verifyAuthorizedTransitionTcb(
    FORMAL_RUNTIME_ROOT,
    GATE_F_AUTHORIZED_TRANSITION_PATH,
    tcbAclController,
  );
  const transition = loadTransition(GATE_F_AUTHORIZED_TRANSITION_PATH, FORMAL_RUNTIME_ROOT);
  if (command === "preflight") {
    const from = await verifyGateFCutoverTuple({
      tuplePath: transition.from.path,
      expectedTupleSha256: transition.from.sha256,
      expectedRuntimeRoot: FORMAL_RUNTIME_ROOT,
      requireActive: true,
    });
    const to = await verifyGateFCutoverTuple({
      tuplePath: transition.to.path,
      expectedTupleSha256: transition.to.sha256,
      expectedRuntimeRoot: FORMAL_RUNTIME_ROOT,
      requireActive: false,
    });
    assertExecutingOperator(from.tuple, fileURLToPath(import.meta.url));
    process.stdout.write(`${JSON.stringify({ ok: true, from: from.releaseId, to: to.releaseId })}\n`);
    return;
  }
  const receipt = await executeGateFCutover({
    executingOperatorPath: fileURLToPath(import.meta.url),
    tcbAclController,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code || "GATE_F_CUTOVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
