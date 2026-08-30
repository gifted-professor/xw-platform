import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

import {
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";
import {
  verifyM64QualificationTcbProvisionReceipt,
} from "../control-plane/lib/m6-qualification-tcb.mjs";
import { inspectControlPlanePrivateMaterial } from "./control-plane-private-material.mjs";
import {
  FORMAL_RELEASE_MANIFEST_SCHEMA_ID,
  FORMAL_RUNTIME_ROOT,
} from "./formal-release-builder.mjs";

export const M6_QUALIFICATION_TASK_NAME = "XW Platform M6 Qualification";
export const M6_QUALIFICATION_FORMAL_TASK_NAME = "XW Platform Control Plane";
export const M6_QUALIFICATION_LAUNCHER_BINDING_SCHEMA_ID =
  "xw.runtime.m6-qualification-control-plane-launcher-binding.v1";
export const M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID =
  "xw.m6-qualification-control-plane-operation-receipt.v1";
export const M6_QUALIFICATION_OPERATOR_RELEASE_PATH =
  "services/control-plane/ops/m6-qualification-launcher-operator.mjs";
export const M6_QUALIFICATION_LAUNCHER_SOURCE_PATH =
  "services/control-plane/ops/launch-control-plane.ps1";
export const M6_QUALIFICATION_RUNTIME_ENTRY_PATH =
  "services/control-plane/scripts/xw-control-plane-runtime.ps1";
export const M6_QUALIFICATION_RUNTIME_CONTRACT_PATH = "config/runtime/xw-runtime.v1.json";
export const M6_QUALIFICATION_INVENTORY_SENTINEL_HASH = sha256(
  "xw.m6-c1-qualification-bootstrap.inventory-unavailable.v1",
);

const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const TASK_STATES = new Set(["ABSENT", "DISABLED", "QUEUED", "READY", "RUNNING", "UNKNOWN"]);
const QUALIFICATION_QUIESCENCE_PORTS = Object.freeze([17920, 17930]);
const TRUSTED_NODE_EXECUTABLE = join("D:\\", "Program Files", "Node", "node.exe");
const WINDOWS_POWERSHELL_EXECUTABLE = join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const QUALIFICATION_BINDING_KEYS = Object.freeze([
  "gateFArtifactInventoryHash",
  "gateFArtifactInventoryPath",
  "gateId",
  "gateIssuerAllowlistPath",
  "releaseId",
  "releaseManifestSha256",
  "schemaId",
  "sourceCommit",
  "sourceReleaseRoot",
]);
const SECRET_ENVIRONMENT_KEYS = Object.freeze([
  "DEEPSEEK_API_KEY",
  "XW_M6_ACCOUNT_ISOLATION_BINDING_HASH",
  "XW_M6_GATE_F_OPERATIONS_TOKEN",
  "XW_M6_LIVE_ENTRY_TOKEN",
]);
const TASK_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
$name = [string]$env:XW_QUALIFICATION_TASK_NAME
$service = New-Object -ComObject "Schedule.Service"
$service.Connect()
$folder = $service.GetFolder("\")
try {
    $task = $folder.GetTask($name)
} catch {
    if ($_.Exception.HResult -eq -2147024894) {
        [ordered]@{ exists = $false; state = "ABSENT"; lastTaskResult = $null; xml = $null } |
            ConvertTo-Json -Compress
        exit 0
    }
    exit 23
}
$states = @("UNKNOWN", "DISABLED", "QUEUED", "READY", "RUNNING")
$stateIndex = [int]$task.State
$state = if ($stateIndex -ge 0 -and $stateIndex -lt $states.Count) { $states[$stateIndex] } else { "UNKNOWN" }
[ordered]@{
    exists = $true
    state = $state
    lastTaskResult = [int64]$task.LastTaskResult
    xml = [string]$task.Xml
} | ConvertTo-Json -Compress
`;
const LISTENER_INSPECTION_PROGRAM = String.raw`
$ErrorActionPreference = "Stop"
Get-Command Get-NetTCPConnection -ErrorAction Stop | Out-Null
$ports = @(17920, 17930)
$addresses = @("127.0.0.1", "0.0.0.0", "::1", "::")
$listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $ports -contains [int]$_.LocalPort -and $addresses -contains [string]$_.LocalAddress } |
        Sort-Object LocalPort, LocalAddress, OwningProcess |
        ForEach-Object {
            [ordered]@{
                localAddress = [string]$_.LocalAddress
                port = [int]$_.LocalPort
                owningProcess = [int64]$_.OwningProcess
            }
        }
)
[ordered]@{
    host = "127.0.0.1"
    ports = $ports
    listeners = $listeners
} | ConvertTo-Json -Depth 4 -Compress
`;

function qualificationError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function fail(code, message) {
  throw qualificationError(code, message);
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
  return typeof left === "string" && typeof right === "string" && pathKey(left) === pathKey(right);
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

function assertPlainFile(path, code, label, maximumBytes = 64 * 1024 * 1024) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is absent or unreadable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) {
    fail(code, `${label} must be one bounded single-link file`);
  }
  return stat;
}

function assertPlainDirectory(path, code, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, `${label} is absent or unreadable`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${label} must be one non-reparse directory`);
  }
}

function readPlainBytes(path, code, label, maximumBytes) {
  assertPlainFile(path, code, label, maximumBytes);
  return readFileSync(path);
}

function parseJsonBytes(bytes, code, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(code, `${label} is not valid UTF-8 JSON`); }
}

function readCanonicalJson(path, code, label, maximumBytes = 8 * 1024 * 1024) {
  const bytes = readPlainBytes(path, code, label, maximumBytes);
  const value = parseJsonBytes(bytes, code, label);
  if (!bytes.equals(canonicalJsonBytes(value))) fail(code, `${label} is not canonical JSON`);
  return Object.freeze({ bytes, value });
}

function manifestEntry(manifest, releasePath, code) {
  const matches = Array.isArray(manifest?.files)
    ? manifest.files.filter((entry) => entry?.path === releasePath) : [];
  if (matches.length !== 1 || !HEX64.test(matches[0]?.sha256 || "")) {
    fail(code, `${releasePath} is absent from the formal release manifest`);
  }
  return matches[0];
}

function inspectManifestArtifact({ manifest, releaseRoot, releasePath, code, label }) {
  const path = join(releaseRoot, ...releasePath.split("/"));
  const bytes = readPlainBytes(path, code, label, 256 * 1024 * 1024);
  const expected = manifestEntry(manifest, releasePath, code).sha256;
  if (sha256(bytes) !== expected) fail(code, `${label} differs from the formal release manifest`);
  return Object.freeze({ path, sha256: expected, bytes });
}

function verifyTcb(tcbAclController, boundaryPath, targetPath, recursive, code) {
  if (typeof tcbAclController?.verify !== "function") {
    fail(code, "SYSTEM TCB ACL verification is unavailable");
  }
  try {
    tcbAclController.verify(buildSystemTcbAclPlan({ boundaryPath, targetPath, recursive }));
  } catch {
    fail(code, "SYSTEM TCB ACL verification failed closed");
  }
}

function validSecret(value, minimumLength) {
  return typeof value === "string" && value.length >= minimumLength && value.length <= 4096
    && !/[\0\r\n]/u.test(value);
}

function inspectQualificationPrivateMaterial(runtimeRoot, privateMaterialInspector) {
  const code = "M6_QUALIFICATION_PRIVATE_MATERIAL_INVALID";
  let inspected;
  try { inspected = privateMaterialInspector({ runtimeRoot }); }
  catch { fail(code, "SYSTEM/Administrators private material inspection failed"); }
  const expectedPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  if (!samePath(inspected?.secretEnvironment?.path, expectedPath)
    || !HEX64.test(inspected?.secretEnvironment?.sha256 || "")) {
    fail(code, "private material path/hash escaped the fixed runtime slot");
  }
  const bytes = readPlainBytes(expectedPath, code, "secret environment", 32 * 1024);
  if (sha256(bytes) !== inspected.secretEnvironment.sha256) {
    fail(code, "secret environment changed after private ACL inspection");
  }
  const secret = parseJsonBytes(bytes, code, "secret environment");
  if (!exactObject(secret, ["schemaId", "variables"])
    || secret.schemaId !== "xw.runtime.control-plane-secret-environment.v1"
    || !exactObject(secret.variables, SECRET_ENVIRONMENT_KEYS)) {
    fail(code, "secret environment exact schema drifted");
  }
  const gateToken = secret.variables.XW_M6_GATE_F_OPERATIONS_TOKEN;
  const accountHash = secret.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH;
  if (!validSecret(gateToken, 32) || !HEX64.test(accountHash || "")) {
    fail(code, "qualification private authorities are absent or malformed");
  }
  const result = Object.freeze({
    path: expectedPath,
    sha256: inspected.secretEnvironment.sha256,
    gateOperationsTokenSha256: sha256(Buffer.from(gateToken, "utf8")),
    accountIsolationBindingHash: accountHash,
  });
  secret.variables.XW_M6_GATE_F_OPERATIONS_TOKEN = null;
  secret.variables.XW_M6_ACCOUNT_ISOLATION_BINDING_HASH = null;
  return result;
}

function inspectQualificationRuntimeBinding({ runtimeRoot, releaseRoot, manifestSha256, releaseId, sourceCommit }) {
  const code = "M6_QUALIFICATION_RUNTIME_BINDING_INVALID";
  const path = join(runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json");
  const bytes = readPlainBytes(path, code, "qualification runtime binding", 64 * 1024);
  const value = parseJsonBytes(bytes, code, "qualification runtime binding");
  const gateIssuerPath = join(runtimeRoot, "m6-gate", "issuer-keys.json");
  const inventoryPath = join(runtimeRoot, "qualification-bootstrap", "final-inventory-unavailable.json");
  const liveOwnerPath = join(runtimeRoot, "qualification-bootstrap", "live-window-owner-keys-unavailable.json");
  if (!exactObject(value, QUALIFICATION_BINDING_KEYS)
    || value.schemaId !== "xw.runtime.m6-c1-qualification-bootstrap.v1"
    || value.releaseId !== releaseId || value.sourceCommit !== sourceCommit
    || !samePath(value.sourceReleaseRoot, releaseRoot)
    || value.releaseManifestSha256 !== manifestSha256
    || typeof value.gateId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.gateId)
    || !samePath(value.gateIssuerAllowlistPath, gateIssuerPath)
    || !samePath(value.gateFArtifactInventoryPath, inventoryPath)
    || value.gateFArtifactInventoryHash !== M6_QUALIFICATION_INVENTORY_SENTINEL_HASH
    || existsSync(inventoryPath) || existsSync(liveOwnerPath)) {
    fail(code, "qualification runtime binding can expose more than the sentinel-only surface");
  }
  const gateIssuerBytes = readPlainBytes(
    gateIssuerPath,
    code,
    "Gate-F issuer allowlist",
    4 * 1024 * 1024,
  );
  return Object.freeze({
    path,
    sha256: sha256(bytes),
    gateIssuerPath,
    gateIssuerSha256: sha256(gateIssuerBytes),
  });
}

function inspectTrustedNode(path = TRUSTED_NODE_EXECUTABLE) {
  const code = "M6_QUALIFICATION_TRUSTED_NODE_INVALID";
  if (!samePath(path, TRUSTED_NODE_EXECUTABLE)) fail(code, "trusted Node path is fixed");
  const bytes = readPlainBytes(path, code, "trusted Node", 256 * 1024 * 1024);
  let version;
  try {
    version = execFileSync(path, ["-p", "process.versions.node"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim();
  } catch { fail(code, "trusted Node version probe failed"); }
  if (!/^\d+\.\d+\.\d+$/u.test(version)) fail(code, "trusted Node version is malformed");
  return Object.freeze({ path: resolve(path), sha256: sha256(bytes), version });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlQuotedPath(value) {
  const path = absolutePath(value, "M6_QUALIFICATION_TASK_XML_INVALID", "task action path");
  if (/["\r\n]/u.test(path)) fail("M6_QUALIFICATION_TASK_XML_INVALID", "task path is not safely quotable");
  return `&quot;${xmlEscape(path)}&quot;`;
}

function qualificationTaskArguments({ runtimeRoot, launcherPath, bindingPath, launcherSha256,
  bindingSha256, releaseId, sourceCommit }) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy Bypass",
    "-File", xmlQuotedPath(launcherPath),
    "-RuntimeRoot", xmlQuotedPath(runtimeRoot),
    "-IdentityBindingPath", xmlQuotedPath(bindingPath),
    "-ExpectedLauncherSha256", launcherSha256,
    "-ExpectedBindingSha256", bindingSha256,
    "-ExpectedReleaseId", releaseId,
    "-ExpectedSourceCommit", sourceCommit,
    "-Mode QUALIFICATION_ONLY",
  ].join(" ");
}

export function buildM6QualificationTaskXml(input = {}) {
  const runtimeRoot = absolutePath(input.runtimeRoot, "M6_QUALIFICATION_TASK_XML_INVALID", "runtimeRoot");
  if (!RELEASE_ID.test(input.releaseId || "") || !HEX40.test(input.sourceCommit || "")
    || !HEX64.test(input.launcherSha256 || "") || !HEX64.test(input.bindingSha256 || "")) {
    fail("M6_QUALIFICATION_TASK_XML_INVALID", "task release/hash identity is invalid");
  }
  const launcherPath = absolutePath(input.launcherPath, "M6_QUALIFICATION_TASK_XML_INVALID", "launcherPath");
  const bindingPath = absolutePath(input.bindingPath, "M6_QUALIFICATION_TASK_XML_INVALID", "bindingPath");
  const argumentsText = qualificationTaskArguments({ ...input, runtimeRoot, launcherPath, bindingPath });
  // NOTE: The XML declaration must claim UTF-16.  This Task Scheduler build
  // rejects a UTF-8 declaration at deserialization time ("unable to switch
  // encoding", (1,40)) even when the bytes are actually UTF-8 without a BOM;
  // schtasks re-encodes the document before handing it to the scheduler COM
  // API.  Every task successfully registered on this machine uses UTF-16.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>xw-platform M6 qualification</Author>
    <Description>Release-bound, qualification-only control plane. No live-entry or provider authority.</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="System">
      <UserId>SYSTEM</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>
      <Arguments>${argumentsText}</Arguments>
      <WorkingDirectory>${xmlEscape(runtimeRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function oneXmlValue(xml, tag, code) {
  const matches = [...String(xml).matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu"))];
  if (matches.length !== 1) fail(code, `task XML requires exactly one ${tag}`);
  return matches[0][1]
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function qualificationTaskDefinition(xml) {
  const code = "M6_QUALIFICATION_TASK_IDENTITY_INVALID";
  if (typeof xml !== "string" || xml.length < 256 || xml.length > 256 * 1024
    || /\.simple(?:\.|\s|&quot;|<)/iu.test(xml)
    || /InteractiveToken|BootTrigger|LogonTrigger|TimeTrigger|CalendarTrigger|EventTrigger/iu.test(xml)) {
    fail(code, "qualification task exposes an interactive, recurring, or legacy launch surface");
  }
  const triggers = /<Triggers(?:\s*\/|>([\s\S]*?)<\/Triggers)>/u.exec(xml);
  if (!triggers || String(triggers[1] || "").trim() !== "") {
    fail(code, "qualification task must have no automatic trigger");
  }
  // NOTE: LogonType is deliberately absent.  This Task Scheduler build rejects
  // the literal value "ServiceAccount" at XML deserialization time
  // (0x8004131A); for a SYSTEM principal the logon type is implied, and the
  // healthy system tasks registered by this platform omit it as well.
  if (/<LogonType>/u.test(xml)) {
    fail(code, "qualification task principal must omit LogonType");
  }
  return Object.freeze({
    userId: oneXmlValue(xml, "UserId", code),
    runLevel: oneXmlValue(xml, "RunLevel", code),
    command: oneXmlValue(xml, "Command", code),
    arguments: oneXmlValue(xml, "Arguments", code),
    workingDirectory: oneXmlValue(xml, "WorkingDirectory", code),
    multipleInstances: oneXmlValue(xml, "MultipleInstancesPolicy", code),
    allowStartOnDemand: oneXmlValue(xml, "AllowStartOnDemand", code),
    executionTimeLimit: oneXmlValue(xml, "ExecutionTimeLimit", code),
    enabled: oneXmlValue(xml, "Enabled", code),
  });
}

function sameTaskDefinition(left, right) {
  // Task Scheduler's COM API normalizes the well-known SYSTEM account to its
  // SID (S-1-5-18) when re-serializing a registered task's XML.  Treat the two
  // spellings as the same principal; every other field must match exactly.
  const normalize = (value) => value?.userId === "S-1-5-18"
    ? { ...value, userId: "SYSTEM" }
    : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function verifyTaskInspection(inspection, plan) {
  if (!inspection?.exists) return Object.freeze({ exists: false, state: "ABSENT", lastTaskResult: null });
  if (!TASK_STATES.has(inspection.state) || typeof inspection.xml !== "string") {
    fail("M6_QUALIFICATION_TASK_STATUS_INVALID", "scheduled task status is malformed");
  }
  const actual = qualificationTaskDefinition(inspection.xml);
  if (!sameTaskDefinition(actual, plan.task.definition)) {
    fail("M6_QUALIFICATION_TASK_IDENTITY_INVALID", "scheduled task differs from the release-bound task XML");
  }
  return Object.freeze({
    exists: true,
    state: inspection.state,
    lastTaskResult: Number.isSafeInteger(inspection.lastTaskResult) ? inspection.lastTaskResult : null,
  });
}

function assertCurrentRelease(runtimeRoot, releaseRoot) {
  const code = "M6_QUALIFICATION_CURRENT_RELEASE_INVALID";
  const currentPath = join(runtimeRoot, "current");
  let stat;
  try { stat = lstatSync(currentPath); }
  catch { fail(code, "current release link is absent"); }
  if (!stat.isSymbolicLink() || !samePath(realpathSync(currentPath), releaseRoot)) {
    fail(code, "current must resolve to the exact qualification release");
  }
  return currentPath;
}

export function planM6QualificationLauncher({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  executingOperatorPath = fileURLToPath(import.meta.url),
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  trustedNodeInspector = inspectTrustedNode,
  tcbAclController = createSystemTcbAclController(),
  tcbProvisionReceiptVerifier = verifyM64QualificationTcbProvisionReceipt,
} = {}) {
  const code = "M6_QUALIFICATION_LAUNCHER_PREFLIGHT_INVALID";
  const runtime = absolutePath(runtimeRoot, code, "runtimeRoot");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")) {
    fail(code, "exact release/source identity is required");
  }
  if (typeof tcbProvisionReceiptVerifier !== "function") {
    fail(code, "qualification TCB receipt verifier is required");
  }
  assertPlainDirectory(runtime, code, "runtime root");
  const releasesRoot = join(runtime, "releases");
  assertPlainDirectory(releasesRoot, code, "releases root");
  const releaseRoot = join(releasesRoot, expectedReleaseId);
  assertPlainDirectory(releaseRoot, code, "release root");
  if (!within(releasesRoot, releaseRoot) || basename(releaseRoot) !== expectedReleaseId) {
    fail(code, "release root escaped the fixed runtime layout");
  }
  const currentPath = assertCurrentRelease(runtime, releaseRoot);
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  const manifestRead = readCanonicalJson(manifestPath, code, "release manifest", 64 * 1024 * 1024);
  const manifest = manifestRead.value;
  if (manifest?.schemaId !== FORMAL_RELEASE_MANIFEST_SCHEMA_ID
    || manifest.releaseId !== expectedReleaseId || manifest.sourceCommit !== expectedSourceCommit
    || !Array.isArray(manifest.files) || manifest.nodeVersion !== "24.11.1") {
    fail(code, "release manifest identity/runtime TCB is invalid");
  }
  const releaseManifestSha256 = sha256(manifestRead.bytes);
  const operator = inspectManifestArtifact({
    manifest, releaseRoot, releasePath: M6_QUALIFICATION_OPERATOR_RELEASE_PATH,
    code, label: "qualification launcher operator",
  });
  if (!samePath(executingOperatorPath, operator.path)) {
    fail(code, "operator must execute from the exact immutable release path");
  }
  const launcher = inspectManifestArtifact({
    manifest, releaseRoot, releasePath: M6_QUALIFICATION_LAUNCHER_SOURCE_PATH,
    code, label: "tracked control-plane launcher",
  });
  const runtimeEntry = inspectManifestArtifact({
    manifest, releaseRoot, releasePath: M6_QUALIFICATION_RUNTIME_ENTRY_PATH,
    code, label: "tracked control-plane runtime entry",
  });
  const contract = inspectManifestArtifact({
    manifest, releaseRoot, releasePath: M6_QUALIFICATION_RUNTIME_CONTRACT_PATH,
    code, label: "tracked runtime contract",
  });
  const privateMaterial = inspectQualificationPrivateMaterial(runtime, privateMaterialInspector);
  const qualificationBinding = inspectQualificationRuntimeBinding({
    runtimeRoot: runtime,
    releaseRoot,
    manifestSha256: releaseManifestSha256,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
  });
  const trustedNode = trustedNodeInspector(TRUSTED_NODE_EXECUTABLE);
  if (!samePath(trustedNode?.path, TRUSTED_NODE_EXECUTABLE)
    || !HEX64.test(trustedNode?.sha256 || "") || trustedNode?.version !== manifest.nodeVersion) {
    fail(code, "trusted Node path/hash/version differs from the release manifest");
  }
  const tcbProvisionReceipt = tcbProvisionReceiptVerifier({
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
  });
  if (tcbProvisionReceipt?.releaseId !== expectedReleaseId
    || tcbProvisionReceipt?.sourceCommit !== expectedSourceCommit
    || !HEX64.test(tcbProvisionReceipt?.receiptHash || "")) {
    fail(code, "current release/source qualification TCB receipt is absent or invalid");
  }
  verifyTcb(tcbAclController, runtime, releaseRoot, true, code);
  verifyTcb(tcbAclController, runtime, qualificationBinding.path, false, code);
  verifyTcb(tcbAclController, runtime, qualificationBinding.gateIssuerPath, false, code);
  if (sha256(readPlainBytes(
    qualificationBinding.path,
    code,
    "qualification runtime binding",
    64 * 1024,
  )) !== qualificationBinding.sha256
    || sha256(readPlainBytes(
      qualificationBinding.gateIssuerPath,
      code,
      "Gate-F issuer allowlist",
      4 * 1024 * 1024,
    )) !== qualificationBinding.gateIssuerSha256) {
    fail(code, "qualification binding or issuer allowlist raced TCB verification");
  }

  const launcherPath = join(runtime, "launchers", launcher.sha256, "launch-control-plane.ps1");
  const binding = {
    schemaId: M6_QUALIFICATION_LAUNCHER_BINDING_SCHEMA_ID,
    taskName: M6_QUALIFICATION_TASK_NAME,
    mode: "QUALIFICATION_ONLY",
    runtimeRoot: runtime,
    currentPath,
    releaseRoot,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    releaseManifestPath: manifestPath,
    releaseManifestSha256,
    launcherPath,
    launcherSha256: launcher.sha256,
    launcherSourcePath: launcher.path,
    launcherSourceSha256: launcher.sha256,
    runtimeEntryPath: runtimeEntry.path,
    runtimeEntrySha256: runtimeEntry.sha256,
    contractPath: contract.path,
    contractSha256: contract.sha256,
    secretEnvironmentPath: privateMaterial.path,
    secretEnvironmentSha256: privateMaterial.sha256,
    gateOperationsTokenSha256: privateMaterial.gateOperationsTokenSha256,
    accountIsolationBindingHash: privateMaterial.accountIsolationBindingHash,
    qualificationRuntimeBindingPath: qualificationBinding.path,
    qualificationRuntimeBindingSha256: qualificationBinding.sha256,
    trustedNodePath: trustedNode.path,
    trustedNodeSha256: trustedNode.sha256,
  };
  const bindingBytes = canonicalJsonBytes(binding);
  const bindingSha256 = sha256(bindingBytes);
  const bindingPath = join(
    runtime,
    "qualification-launcher-bindings",
    bindingSha256,
    "control-plane-launcher-binding.v1.json",
  );
  const taskXml = buildM6QualificationTaskXml({
    runtimeRoot: runtime,
    launcherPath,
    bindingPath,
    launcherSha256: launcher.sha256,
    bindingSha256,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
  });
  // The declaration above claims UTF-16, so the staged bytes must actually be
  // UTF-16 (LE with BOM) for schtasks /XML to accept them on this machine.
  const taskBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, "utf16le")]);
  const taskXmlSha256 = sha256(taskBytes);
  const taskXmlPath = join(
    runtime,
    "qualification-task-bindings",
    taskXmlSha256,
    "xw-platform-m6-qualification.xml",
  );
  const definition = qualificationTaskDefinition(taskXml);
  if (definition.userId !== "SYSTEM"
    || definition.runLevel !== "HighestAvailable" || definition.multipleInstances !== "IgnoreNew"
    || definition.allowStartOnDemand !== "true" || definition.executionTimeLimit !== "PT0S"
    || definition.enabled !== "true" || !definition.arguments.endsWith("-Mode QUALIFICATION_ONLY")
    || definition.command !== "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    || !samePath(definition.workingDirectory, runtime)
    || /DEEPSEEK|LIVE_ENTRY|GATE_F_OPERATIONS_TOKEN|ACCOUNT_ISOLATION_BINDING_HASH/iu.test(taskXml)) {
    fail("M6_QUALIFICATION_TASK_XML_INVALID", "task principal/action/surface drifted");
  }
  return Object.freeze({
    schemaId: "xw.m6-qualification-control-plane-launch-plan.v1",
    runtimeRoot: runtime,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    operator: Object.freeze({ path: operator.path, sha256: operator.sha256 }),
    qualificationRuntimeBinding: Object.freeze({
      sha256: qualificationBinding.sha256,
      gateIssuerSha256: qualificationBinding.gateIssuerSha256,
    }),
    privateMaterial: Object.freeze({
      secretEnvironmentSha256: privateMaterial.sha256,
      gateOperationsTokenSha256: privateMaterial.gateOperationsTokenSha256,
      accountIsolationBindingHash: privateMaterial.accountIsolationBindingHash,
    }),
    artifacts: Object.freeze([
      Object.freeze({ kind: "launcher", path: launcherPath, sha256: launcher.sha256, bytes: launcher.bytes }),
      Object.freeze({ kind: "binding", path: bindingPath, sha256: bindingSha256, bytes: bindingBytes }),
      Object.freeze({ kind: "task-xml", path: taskXmlPath, sha256: taskXmlSha256, bytes: taskBytes }),
    ]),
    binding: Object.freeze({ path: bindingPath, sha256: bindingSha256 }),
    task: Object.freeze({
      name: M6_QUALIFICATION_TASK_NAME,
      xmlPath: taskXmlPath,
      xmlSha256: taskXmlSha256,
      definition,
    }),
  });
}

function ensurePlainDirectoryChain(runtimeRoot, targetDirectory) {
  if (!within(runtimeRoot, targetDirectory, { allowRoot: true })) {
    fail("M6_QUALIFICATION_ARTIFACT_PATH_ESCAPE", "artifact directory escaped runtime root");
  }
  const rel = relative(runtimeRoot, targetDirectory);
  let cursor = runtimeRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor, { recursive: false });
    assertPlainDirectory(cursor, "M6_QUALIFICATION_ARTIFACT_STRUCTURE_INVALID", "artifact directory");
  }
}

export function createM6QualificationArtifactPublisher({
  runtimeRoot,
  tcbAclController = createSystemTcbAclController(),
} = {}) {
  const runtime = absolutePath(runtimeRoot, "M6_QUALIFICATION_ARTIFACT_PATH_INVALID", "runtimeRoot");
  return function publish(artifact) {
    const path = absolutePath(artifact?.path, "M6_QUALIFICATION_ARTIFACT_PATH_INVALID", "artifact path");
    if (!within(runtime, path) || !Buffer.isBuffer(artifact?.bytes)
      || sha256(artifact.bytes) !== artifact.sha256 || !HEX64.test(artifact.sha256 || "")) {
      fail("M6_QUALIFICATION_ARTIFACT_INVALID", "artifact path/hash/bytes are invalid");
    }
    ensurePlainDirectoryChain(runtime, dirname(path));
    let reused = false;
    if (existsSync(path)) {
      const actual = readPlainBytes(path, "M6_QUALIFICATION_CREATE_ONLY_CONFLICT", "existing artifact", 256 * 1024 * 1024);
      if (!actual.equals(artifact.bytes)) {
        fail("M6_QUALIFICATION_CREATE_ONLY_CONFLICT", "content-addressed artifact exists with different bytes");
      }
      reused = true;
    } else {
      try { writeFileSync(path, artifact.bytes, { flag: "wx", mode: 0o600 }); }
      catch { fail("M6_QUALIFICATION_CREATE_ONLY_CONFLICT", "create-only artifact publication failed"); }
    }
    const plan = buildSystemTcbAclPlan({ boundaryPath: runtime, targetPath: path, recursive: false });
    try {
      tcbAclController.protect(plan);
      tcbAclController.verify(plan);
    } catch { fail("M6_QUALIFICATION_ARTIFACT_ACL_INVALID", "published artifact TCB ACL is not protected"); }
    if (sha256(readPlainBytes(path, "M6_QUALIFICATION_ARTIFACT_DRIFT", "published artifact", 256 * 1024 * 1024))
      !== artifact.sha256) fail("M6_QUALIFICATION_ARTIFACT_DRIFT", "published artifact drifted");
    return Object.freeze({ path, sha256: artifact.sha256, reused });
  };
}

export function createM6QualificationReceiptWriter({ runtimeRoot, publisher } = {}) {
  const runtime = absolutePath(runtimeRoot, "M6_QUALIFICATION_RECEIPT_PATH_INVALID", "runtimeRoot");
  const publish = publisher ?? createM6QualificationArtifactPublisher({ runtimeRoot: runtime });
  return function writeReceipt(body) {
    const receiptHash = sha256(`${M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID}:${JSON.stringify(body)}`);
    const value = { ...body, receiptHash };
    const bytes = canonicalJsonBytes(value);
    const path = join(
      runtime,
      "qualification-launcher",
      "receipts",
      receiptHash,
      "m6-qualification-control-plane-operation-receipt.v1.json",
    );
    publish({ path, sha256: sha256(bytes), bytes });
    return Object.freeze({ path, sha256: sha256(bytes), receiptHash, value: Object.freeze(value) });
  };
}

function normalizeInspection(value) {
  if (!value?.exists) return Object.freeze({ exists: false, state: "ABSENT", lastTaskResult: null, xml: null });
  if (!TASK_STATES.has(value.state) || typeof value.xml !== "string") {
    fail("M6_QUALIFICATION_TASK_STATUS_INVALID", "Task Scheduler returned a malformed status");
  }
  return Object.freeze({
    exists: true,
    state: value.state,
    lastTaskResult: Number.isSafeInteger(value.lastTaskResult) ? value.lastTaskResult : null,
    xml: value.xml,
  });
}

function normalizeListenerInspection(value) {
  if (!exactObject(value, ["host", "listeners", "ports"])
    || value.host !== "127.0.0.1"
    || !Array.isArray(value.ports)
    || JSON.stringify(value.ports) !== JSON.stringify(QUALIFICATION_QUIESCENCE_PORTS)
    || !Array.isArray(value.listeners)) {
    fail("M6_QUALIFICATION_LISTENER_STATUS_INVALID", "fixed listener oracle receipt is malformed");
  }
  const listeners = value.listeners.map((row) => {
    if (!exactObject(row, ["localAddress", "owningProcess", "port"])
      || !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(row.localAddress)
      || !QUALIFICATION_QUIESCENCE_PORTS.includes(row.port)
      || !Number.isSafeInteger(row.owningProcess) || row.owningProcess < 0) {
      fail("M6_QUALIFICATION_LISTENER_STATUS_INVALID", "fixed listener row is malformed");
    }
    return Object.freeze({ ...row });
  });
  return Object.freeze({
    host: value.host,
    ports: QUALIFICATION_QUIESCENCE_PORTS,
    listeners: Object.freeze(listeners),
  });
}

function assertListenerQuiescence(value) {
  const inspected = normalizeListenerInspection(value);
  if (inspected.listeners.length !== 0) {
    fail(
      "M6_QUALIFICATION_LISTENER_NOT_QUIESCENT",
      "fixed control-plane/registry listener set must be absent before qualification",
    );
  }
  return Object.freeze({ host: inspected.host, ports: inspected.ports, status: "VERIFIED_ABSENT" });
}

export function createNativeM6QualificationTaskAdapter({
  execFileSyncFn = execFileSync,
  powershellPath = WINDOWS_POWERSHELL_EXECUTABLE,
} = {}) {
  const encodedInspection = Buffer.from(TASK_INSPECTION_PROGRAM, "utf16le").toString("base64");
  const encodedListenerInspection = Buffer.from(LISTENER_INSPECTION_PROGRAM, "utf16le").toString("base64");
  const allowed = new Set([M6_QUALIFICATION_TASK_NAME, M6_QUALIFICATION_FORMAL_TASK_NAME]);
  const inspect = (taskName) => {
    if (!allowed.has(taskName)) fail("M6_QUALIFICATION_TASK_NAME_INVALID", "task inspection escaped the fixed set");
    let output;
    try {
      output = execFileSyncFn(powershellPath, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedInspection,
      ], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        env: {
          SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
          WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
          XW_QUALIFICATION_TASK_NAME: taskName,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { fail("M6_QUALIFICATION_TASK_STATUS_UNAVAILABLE", "Task Scheduler status is unavailable"); }
    try { return normalizeInspection(JSON.parse(String(output).trim())); }
    catch (error) {
      if (error?.code === "M6_QUALIFICATION_TASK_STATUS_INVALID") throw error;
      fail("M6_QUALIFICATION_TASK_STATUS_INVALID", "Task Scheduler status receipt is invalid");
    }
  };
  const schtasks = (args, { tolerateFailure = false } = {}) => {
    try {
      return execFileSyncFn("schtasks.exe", args, {
        encoding: "utf8", windowsHide: true, timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      if (tolerateFailure) return "";
      fail("M6_QUALIFICATION_TASK_MUTATION_FAILED", "fixed Scheduled Task mutation failed");
    }
  };
  return Object.freeze({
    inspect,
    inspectFixedListeners() {
      let output;
      try {
        output = execFileSyncFn(powershellPath, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-EncodedCommand", encodedListenerInspection,
        ], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 512 * 1024,
          env: {
            SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
            WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        fail("M6_QUALIFICATION_LISTENER_STATUS_UNAVAILABLE", "fixed listener oracle is unavailable");
      }
      try { return normalizeListenerInspection(JSON.parse(String(output).trim())); }
      catch (error) {
        if (/^M6_QUALIFICATION_LISTENER_/u.test(error?.code || "")) throw error;
        fail("M6_QUALIFICATION_LISTENER_STATUS_INVALID", "fixed listener oracle receipt is invalid");
      }
    },
    register({ taskName, xmlPath }) {
      if (taskName !== M6_QUALIFICATION_TASK_NAME || !isAbsolute(xmlPath)) {
        fail("M6_QUALIFICATION_TASK_REGISTRATION_INVALID", "task registration escaped the fixed identity");
      }
      schtasks(["/Create", "/TN", taskName, "/XML", resolve(xmlPath)]);
    },
    run(taskName) {
      if (taskName !== M6_QUALIFICATION_TASK_NAME) fail("M6_QUALIFICATION_TASK_NAME_INVALID", "task run escaped the fixed name");
      schtasks(["/Run", "/TN", taskName]);
    },
    end(taskName) {
      if (taskName !== M6_QUALIFICATION_TASK_NAME) fail("M6_QUALIFICATION_TASK_NAME_INVALID", "task stop escaped the fixed name");
      schtasks(["/End", "/TN", taskName], { tolerateFailure: true });
    },
    delete(taskName) {
      if (taskName !== M6_QUALIFICATION_TASK_NAME) fail("M6_QUALIFICATION_TASK_NAME_INVALID", "task delete escaped the fixed name");
      schtasks(["/Delete", "/TN", taskName, "/F"]);
    },
  });
}

async function waitForTask(adapter, taskName, predicate, { timeoutMs = 15_000, pollMs = 100 } = {}) {
  const started = Date.now();
  while (true) {
    const value = normalizeInspection(await adapter.inspect(taskName));
    if (predicate(value)) return value;
    if (Date.now() - started >= timeoutMs) {
      fail("M6_QUALIFICATION_TASK_STATE_TIMEOUT", "fixed Scheduled Task did not reach its required state");
    }
    await new Promise((accept) => setTimeout(accept, pollMs));
  }
}

function assertFormalStopped(inspection) {
  const state = normalizeInspection(inspection).state;
  if (["RUNNING", "QUEUED"].includes(state)) {
    fail("M6_QUALIFICATION_FORMAL_LISTENER_ACTIVE", "formal control plane must be stopped before qualification");
  }
  return state;
}

function operationReceiptBody({
  operation,
  plan,
  observedAt,
  task,
  formalTaskState,
  listenerQuiescence,
  outcome,
}) {
  if (!Number.isFinite(Date.parse(observedAt))) {
    fail("M6_QUALIFICATION_RECEIPT_CLOCK_INVALID", "operation receipt requires a finite timestamp");
  }
  return {
    schemaId: M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID,
    operation,
    observedAt,
    outcome,
    releaseId: plan.releaseId,
    sourceCommit: plan.sourceCommit,
    runtimeMode: "QUALIFICATION_ONLY",
    bindingSha256: plan.binding.sha256,
    qualificationRuntimeBindingSha256: plan.qualificationRuntimeBinding.sha256,
    secretEnvironmentSha256: plan.privateMaterial.secretEnvironmentSha256,
    gateOperationsTokenSha256: plan.privateMaterial.gateOperationsTokenSha256,
    accountIsolationBindingHash: plan.privateMaterial.accountIsolationBindingHash,
    task: {
      name: M6_QUALIFICATION_TASK_NAME,
      principal: "SYSTEM",
      runLevel: "HighestAvailable",
      triggerCount: 0,
      xmlSha256: plan.task.xmlSha256,
      state: task.state,
      lastTaskResult: task.lastTaskResult,
    },
    formalTaskState,
    listenerQuiescence,
  };
}

function finalizeReceipt({
  operation,
  plan,
  task,
  formalTaskState,
  listenerQuiescence,
  outcome,
  receiptWriter,
  now,
}) {
  const body = operationReceiptBody({
    operation,
    plan,
    observedAt: new Date(now()).toISOString(),
    task,
    formalTaskState,
    listenerQuiescence,
    outcome,
  });
  return receiptWriter(body);
}

function lifecycleDependencies(options, plan) {
  const adapter = options.adapter ?? createNativeM6QualificationTaskAdapter();
  const publisher = options.publisher ?? createM6QualificationArtifactPublisher({ runtimeRoot: plan.runtimeRoot });
  const receiptWriter = options.receiptWriter
    ?? createM6QualificationReceiptWriter({ runtimeRoot: plan.runtimeRoot, publisher });
  const now = options.now ?? (() => Date.now());
  if (!["inspect", "inspectFixedListeners", "register", "run", "end", "delete"]
    .every((name) => typeof adapter?.[name] === "function")
    || typeof publisher !== "function" || typeof receiptWriter !== "function" || typeof now !== "function") {
    fail("M6_QUALIFICATION_LIFECYCLE_DEPENDENCY_INVALID", "task/publisher/receipt lifecycle dependency is incomplete");
  }
  return { adapter, publisher, receiptWriter, now };
}

function buildPlan(options) {
  return options.plan ?? planM6QualificationLauncher(options);
}

export async function preflightM6QualificationLauncher(options = {}) {
  const plan = buildPlan(options);
  const deps = lifecycleDependencies(options, plan);
  const qualification = normalizeInspection(await deps.adapter.inspect(M6_QUALIFICATION_TASK_NAME));
  if (qualification.exists) {
    fail("M6_QUALIFICATION_TASK_ALREADY_PRESENT", "qualification task registration is create-only");
  }
  const formalTaskState = assertFormalStopped(await deps.adapter.inspect(M6_QUALIFICATION_FORMAL_TASK_NAME));
  const listenerQuiescence = assertListenerQuiescence(await deps.adapter.inspectFixedListeners());
  return finalizeReceipt({
    operation: "preflight",
    plan,
    task: qualification,
    formalTaskState,
    listenerQuiescence,
    outcome: "READY",
    receiptWriter: deps.receiptWriter,
    now: deps.now,
  });
}

export async function executeM6QualificationLauncher(options = {}) {
  const plan = buildPlan(options);
  const deps = lifecycleDependencies(options, plan);
  let registered = false;
  try {
    const before = normalizeInspection(await deps.adapter.inspect(M6_QUALIFICATION_TASK_NAME));
    if (before.exists) fail("M6_QUALIFICATION_TASK_ALREADY_PRESENT", "qualification task registration is create-only");
    const formalTaskState = assertFormalStopped(await deps.adapter.inspect(M6_QUALIFICATION_FORMAL_TASK_NAME));
    let listenerQuiescence = assertListenerQuiescence(await deps.adapter.inspectFixedListeners());
    for (const artifact of plan.artifacts) deps.publisher(artifact);
    assertFormalStopped(await deps.adapter.inspect(M6_QUALIFICATION_FORMAL_TASK_NAME));
    listenerQuiescence = assertListenerQuiescence(await deps.adapter.inspectFixedListeners());
    await deps.adapter.register({ taskName: M6_QUALIFICATION_TASK_NAME, xmlPath: plan.task.xmlPath });
    registered = true;
    const registeredTask = verifyTaskInspection(
      await deps.adapter.inspect(M6_QUALIFICATION_TASK_NAME),
      plan,
    );
    if (!registeredTask.exists || !["READY", "DISABLED"].includes(registeredTask.state)) {
      fail("M6_QUALIFICATION_TASK_REGISTRATION_INVALID", "registered qualification task is not startable");
    }
    await deps.adapter.run(M6_QUALIFICATION_TASK_NAME);
    const runningRaw = await waitForTask(
      deps.adapter,
      M6_QUALIFICATION_TASK_NAME,
      (value) => value.exists && value.state === "RUNNING",
      options.waitOptions,
    );
    const running = verifyTaskInspection(runningRaw, plan);
    try {
      return finalizeReceipt({
        operation: "execute",
        plan,
        task: running,
        formalTaskState,
        listenerQuiescence,
        outcome: "RUNNING",
        receiptWriter: deps.receiptWriter,
        now: deps.now,
      });
    } catch (error) {
      await deps.adapter.end(M6_QUALIFICATION_TASK_NAME);
      await deps.adapter.delete(M6_QUALIFICATION_TASK_NAME);
      throw error;
    }
  } catch (error) {
    if (registered) {
      try { await deps.adapter.end(M6_QUALIFICATION_TASK_NAME); } catch { /* fixed cleanup best effort */ }
      try { await deps.adapter.delete(M6_QUALIFICATION_TASK_NAME); } catch { /* fixed cleanup best effort */ }
    }
    throw error;
  }
}

export async function statusM6QualificationLauncher(options = {}) {
  const plan = buildPlan(options);
  const deps = lifecycleDependencies(options, plan);
  const inspection = normalizeInspection(await deps.adapter.inspect(M6_QUALIFICATION_TASK_NAME));
  const task = inspection.exists ? verifyTaskInspection(inspection, plan) : inspection;
  const formalTaskState = normalizeInspection(
    await deps.adapter.inspect(M6_QUALIFICATION_FORMAL_TASK_NAME),
  ).state;
  return finalizeReceipt({
    operation: "status",
    plan,
    task,
    formalTaskState,
    listenerQuiescence: Object.freeze({
      host: "127.0.0.1",
      ports: QUALIFICATION_QUIESCENCE_PORTS,
      status: "NOT_APPLICABLE_WHILE_OBSERVING",
    }),
    outcome: task.exists ? task.state : "ABSENT",
    receiptWriter: deps.receiptWriter,
    now: deps.now,
  });
}

export async function stopM6QualificationLauncher(options = {}) {
  const plan = buildPlan(options);
  const deps = lifecycleDependencies(options, plan);
  const inspection = normalizeInspection(await deps.adapter.inspect(M6_QUALIFICATION_TASK_NAME));
  if (inspection.exists) {
    verifyTaskInspection(inspection, plan);
    if (["RUNNING", "QUEUED"].includes(inspection.state)) {
      await deps.adapter.end(M6_QUALIFICATION_TASK_NAME);
      await waitForTask(
        deps.adapter,
        M6_QUALIFICATION_TASK_NAME,
        (value) => value.exists && ["READY", "DISABLED"].includes(value.state),
        options.waitOptions,
      );
    }
    await deps.adapter.delete(M6_QUALIFICATION_TASK_NAME);
    await waitForTask(
      deps.adapter,
      M6_QUALIFICATION_TASK_NAME,
      (value) => !value.exists,
      options.waitOptions,
    );
  }
  const absent = Object.freeze({ exists: false, state: "ABSENT", lastTaskResult: null });
  const formalTaskState = normalizeInspection(
    await deps.adapter.inspect(M6_QUALIFICATION_FORMAL_TASK_NAME),
  ).state;
  return finalizeReceipt({
    operation: "stop",
    plan,
    task: absent,
    formalTaskState,
    listenerQuiescence: Object.freeze({
      host: "127.0.0.1",
      ports: QUALIFICATION_QUIESCENCE_PORTS,
      status: "NOT_APPLICABLE_AFTER_STOP",
    }),
    outcome: "STOPPED_AND_UNREGISTERED",
    receiptWriter: deps.receiptWriter,
    now: deps.now,
  });
}

export function parseM6QualificationLauncherCommand(argv) {
  if (!Array.isArray(argv) || argv.length !== 3
    || !["preflight-fixed", "execute-fixed", "stop-fixed", "status-fixed"].includes(argv[0])
    || !RELEASE_ID.test(argv[1] || "") || !HEX40.test(argv[2] || "")) {
    fail(
      "M6_QUALIFICATION_ARGUMENT_INVALID",
      "qualification launcher requires one fixed operation plus releaseId/sourceCommit; paths, endpoints, tokens and options are forbidden",
    );
  }
  return Object.freeze({ operation: argv[0].slice(0, -"-fixed".length), releaseId: argv[1], sourceCommit: argv[2] });
}

export async function mainM6QualificationLauncher(argv = process.argv.slice(2), dependencies = {}) {
  const command = parseM6QualificationLauncherCommand(argv);
  const options = {
    runtimeRoot: FORMAL_RUNTIME_ROOT,
    expectedReleaseId: command.releaseId,
    expectedSourceCommit: command.sourceCommit,
    executingOperatorPath: fileURLToPath(import.meta.url),
    ...dependencies,
  };
  const operation = {
    preflight: preflightM6QualificationLauncher,
    execute: executeM6QualificationLauncher,
    stop: stopM6QualificationLauncher,
    status: statusM6QualificationLauncher,
  }[command.operation];
  const receipt = await operation(options);
  const publicReceipt = {
    ok: true,
    operation: command.operation,
    releaseId: command.releaseId,
    sourceCommit: command.sourceCommit,
    receipt: { path: receipt.path, sha256: receipt.sha256, receiptHash: receipt.receiptHash },
    task: receipt.value.task,
    outcome: receipt.value.outcome,
  };
  process.stdout.write(`${JSON.stringify(publicReceipt, null, 2)}\n`);
  return publicReceipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  mainM6QualificationLauncher().catch((error) => {
    process.stderr.write(`${error?.code || "M6_QUALIFICATION_LAUNCHER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
