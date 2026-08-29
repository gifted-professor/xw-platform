import { createHash } from "node:crypto";
import {
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

import { inspectControlPlanePrivateMaterial } from "./control-plane-private-material.mjs";
import { resolvePinnedVisionConfig } from "../../orchestrator/scripts/lib/xhs-exploration-vision.mjs";
import { verifyPythonRuntimeClosure } from
  "../../orchestrator/scripts/lib/xhs-exploration-provider-bundle.mjs";
import { verifyResolvedPrivateProviderConfig } from
  "../../orchestrator/scripts/lib/xhs-exploration-private-runtime.mjs";
import { EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST } from "../../orchestrator/ops/xw-xhs-vision-pin.mjs";

export const GATE_F_LAUNCHER_BINDING_SCHEMA_ID = "xw.runtime.control-plane-launcher-binding.v1";
export const GATE_F_LAUNCHER_INSTALL_SCHEMA_ID = "xw.runtime.control-plane-launcher-install.v1";
export const FORMAL_CONTROL_PLANE_TASK_NAME = "XW Platform Control Plane";
export const FORMAL_LAUNCHER_FILENAME = "launch-control-plane.ps1";
export const FORMAL_BINDING_FILENAME = "control-plane-launcher-binding.v1.json";
export const FORMAL_TASK_XML_FILENAME = "xw-platform-control-plane.xml";

const HEX40 = /^(?!0{40}$)[0-9a-f]{40}$/u;
const HEX64 = /^(?!0{64}$)[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const M6_FINAL_BINDING_KEYS = Object.freeze([
  "schemaId", "releaseId", "sourceCommit", "sourceReleaseRoot", "releaseManifestSha256",
  "dependencyRoot", "dependencyLayerHash", "modelProfileRoot", "modelProfileHash",
  "providerBaseUrl", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot", "gateId",
  "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath",
  "gateFArtifactCatalogPath", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
  "targetEnvironmentAttestationPath", "targetEnvironmentAttestationHash",
  "environmentQualificationPath", "environmentQualificationSha256",
  "productionDependencyBindingPath", "productionDependencyBindingHash",
]);
const M6_FINAL_PATH_KEYS = Object.freeze([
  "dependencyRoot", "modelProfileRoot", "manifestRoot", "runtimeSnapshotPath", "dshPersistenceRoot",
  "gateIssuerAllowlistPath", "liveAuthorizationIssuerAllowlistPath", "gateFArtifactCatalogPath",
  "targetEnvironmentAttestationPath", "environmentQualificationPath", "productionDependencyBindingPath",
]);
const M6_FINAL_HASH_KEYS = Object.freeze([
  "dependencyLayerHash", "modelProfileHash", "gateFArtifactCatalogHash", "gateFArtifactCatalogSha256",
  "targetEnvironmentAttestationHash", "environmentQualificationSha256", "productionDependencyBindingHash",
]);
const SERVE_LAUNCH_KEYS = Object.freeze([
  "schemaVersion", "runtimeRoot", "nodeExe", "releaseId", "sourceCommit", "deviceConfig", "alias",
]);
const PREPARED_RUNTIME_BINDING_KEYS = Object.freeze(["m6Final", "serve03", "serve04"]);
const PREPARED_RUNTIME_ARTIFACT_KEYS = Object.freeze(["path", "sha256"]);
export const TRUSTED_NODE_EXECUTABLE = join("D:\\", "Program Files", "Node", "node.exe");
const BINDING_KEYS = Object.freeze([
  "contractPath",
  "contractSha256",
  "currentPath",
  "digestKeyringPath",
  "digestKeyringSha256",
  "launcherPath",
  "launcherSha256",
  "launcherSourcePath",
  "launcherSourceSha256",
  "m6FinalBindingPath",
  "m6FinalBindingSha256",
  "mode",
  "providerBundleDigest",
  "providerConfigPath",
  "providerConfigSha256",
  "releaseId",
  "releaseManifestPath",
  "releaseManifestSha256",
  "releaseRoot",
  "runtimeEntryPath",
  "runtimeEntrySha256",
  "runtimeRoot",
  "schemaId",
  "secretEnvironmentPath",
  "secretEnvironmentSha256",
  "serveLaunch03Path",
  "serveLaunch03Sha256",
  "serveLaunch04Path",
  "serveLaunch04Sha256",
  "sourceCommit",
  "taskName",
  "trustedNodePath",
  "trustedNodeSha256",
]);

function fail(code, message) {
  throw new Error(`${code}: ${message}`);
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
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

function assertAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code, "path must be absolute");
  return resolve(value);
}

function assertPlainFile(path, code) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(code, `${path} must be a single-link regular file`);
  }
}

function assertPlainDirectory(path, code) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${path} must be a non-reparse directory`);
  }
}

function assertAddressedFile(path, expectedHash, expectedFilename, code) {
  assertPlainFile(path, code);
  if (!HEX64.test(expectedHash) || basename(path) !== expectedFilename
    || basename(dirname(path)).toLowerCase() !== expectedHash
    || sha256File(path) !== expectedHash) {
    fail(code, `${path} is not stored under its exact SHA-256 address`);
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quotedPowerShellArgument(value, label) {
  if (typeof value !== "string" || value === "" || /["\r\n]/u.test(value)) {
    fail("GATE_F_TASK_ARGUMENT_INVALID", `${label} is not safely quotable`);
  }
  return `&quot;${xmlEscape(value)}&quot;`;
}

export function buildFormalControlPlaneTaskXml({
  runtimeRoot,
  launcherPath,
  bindingPath,
  launcherSha256,
  bindingSha256,
  releaseId,
  sourceCommit,
  taskName = FORMAL_CONTROL_PLANE_TASK_NAME,
} = {}) {
  for (const [label, value] of Object.entries({ runtimeRoot, launcherPath, bindingPath })) {
    assertAbsolutePath(value, `GATE_F_TASK_${label.toUpperCase()}_INVALID`);
  }
  if (!HEX64.test(launcherSha256 || "") || !HEX64.test(bindingSha256 || "")) {
    fail("GATE_F_TASK_HASH_INVALID", "launcher and binding hashes must be non-zero SHA-256 values");
  }
  if (!HEX40.test(sourceCommit || "") || !RELEASE_ID.test(releaseId || "")) {
    fail("GATE_F_TASK_RELEASE_INVALID", "release identity is invalid");
  }
  if (taskName !== FORMAL_CONTROL_PLANE_TASK_NAME) {
    fail("GATE_F_TASK_NAME_INVALID", "the formal task name is fixed");
  }
  const argumentsText = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy Bypass",
    "-File", quotedPowerShellArgument(resolve(launcherPath), "launcherPath"),
    "-RuntimeRoot", quotedPowerShellArgument(resolve(runtimeRoot), "runtimeRoot"),
    "-IdentityBindingPath", quotedPowerShellArgument(resolve(bindingPath), "bindingPath"),
    "-ExpectedLauncherSha256", launcherSha256,
    "-ExpectedBindingSha256", bindingSha256,
    "-ExpectedReleaseId", releaseId,
    "-ExpectedSourceCommit", sourceCommit,
    "-Mode FINAL",
  ].join(" ");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>xw-platform Gate F</Author>
    <Description>Content-addressed formal control-plane launcher.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>SYSTEM</UserId>
      <LogonType>ServiceAccount</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
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
      <WorkingDirectory>${xmlEscape(resolve(runtimeRoot))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
  if (/\.simple(?:\.|\s|&quot;|<)/iu.test(xml)) {
    fail("GATE_F_TASK_SIMPLE_LAUNCHER_FORBIDDEN", "formal task action may not invoke a .simple launcher");
  }
  return xml;
}

export function buildCreateOnlyTaskRegistration({
  taskXmlPath,
  taskName = FORMAL_CONTROL_PLANE_TASK_NAME,
} = {}) {
  const taskXmlPathFull = assertAbsolutePath(taskXmlPath, "GATE_F_TASK_XML_PATH_INVALID");
  if (taskName !== FORMAL_CONTROL_PLANE_TASK_NAME) {
    fail("GATE_F_TASK_NAME_INVALID", "the formal task name is fixed");
  }
  return Object.freeze({
    executable: "schtasks.exe",
    arguments: Object.freeze(["/Create", "/TN", taskName, "/XML", taskXmlPathFull]),
    overwrite: false,
  });
}

function readCanonicalJson(path, code) {
  assertPlainFile(path, code);
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, `${path} is not JSON`);
  }
  if (!bytes.equals(canonicalJsonBytes(value))) fail(code, `${path} is not canonical LF JSON`);
  return { bytes, value };
}

function manifestEntry(manifest, path) {
  const entries = Array.isArray(manifest?.files) ? manifest.files : [];
  const matches = entries.filter((entry) => entry?.path === path);
  if (matches.length !== 1 || !HEX64.test(matches[0]?.sha256 || "")) {
    fail("GATE_F_MANIFEST_ENTRY_INVALID", `manifest does not uniquely pin ${path}`);
  }
  return matches[0];
}

function assertManifestFile(binding, manifest, absolutePath, releaseRelativePath, expectedHash, code) {
  const expectedPath = join(binding.releaseRoot, ...releaseRelativePath.split("/"));
  if (!samePath(absolutePath, expectedPath)) fail(code, `${releaseRelativePath} path drifted`);
  assertPlainFile(absolutePath, code);
  const declared = manifestEntry(manifest, releaseRelativePath).sha256;
  const actual = sha256File(absolutePath);
  if (actual !== expectedHash || declared !== expectedHash) {
    fail(code, `${releaseRelativePath} bytes do not match binding and release manifest`);
  }
}

export function inspectGateFProviderConfigClosure(runtimeRoot) {
  const path = join(runtimeRoot, "state", "orchestrator", "xhs-exploration-vision-provider.v1.json");
  try {
    assertPlainFile(path, "GATE_F_PROVIDER_CONFIG_INVALID");
    const resolved = resolvePinnedVisionConfig(path);
    if (resolved.provider.providerBundleDigest !== EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST) {
      fail("GATE_F_PROVIDER_BUNDLE_IDENTITY_MISMATCH", "runtime provider differs from the P4A release bundle");
    }
    assertPlainFile(resolved.bundle.manifest.path, "GATE_F_PROVIDER_BUNDLE_INVALID");
    for (const pin of [resolved.pin.python, resolved.pin.script, resolved.pin.model, ...resolved.pin.data]) {
      assertPlainFile(pin.path, "GATE_F_PROVIDER_BUNDLE_INVALID");
    }
    verifyPythonRuntimeClosure({
      python: resolved.pin.python.path,
      dataFiles: resolved.pin.data,
    });
    verifyResolvedPrivateProviderConfig(resolved);
    return Object.freeze({
      path,
      sha256: sha256File(path),
      providerBundleDigest: resolved.provider.providerBundleDigest,
    });
  } catch (error) {
    if (/^GATE_F_/u.test(error?.message || "")) throw error;
    fail("GATE_F_PROVIDER_CONFIG_INVALID", "provider config or transitive bundle closure did not verify");
  }
}

function readJson(path, code) {
  assertPlainFile(path, code);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(code, `${path} is not valid JSON`);
  }
}

function validateM6FinalBinding(value, {
  releaseId,
  sourceCommit,
  releaseRoot,
  releaseManifestSha256,
}) {
  if (!exactObject(value, M6_FINAL_BINDING_KEYS)
    || value.schemaId !== "xw.runtime.m6-c1-runtime.v1"
    || value.releaseId !== releaseId
    || value.sourceCommit !== sourceCommit
    || !samePath(value.sourceReleaseRoot, releaseRoot)
    || value.releaseManifestSha256 !== releaseManifestSha256
    || value.providerBaseUrl !== "https://api.deepseek.com"
    || typeof value.gateId !== "string"
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.gateId)) {
    fail("GATE_F_M6_FINAL_BINDING_INVALID", "M6 FINAL binding identity or exact schema drifted");
  }
  for (const key of M6_FINAL_PATH_KEYS) {
    assertAbsolutePath(value[key], "GATE_F_M6_FINAL_BINDING_INVALID");
  }
  for (const key of M6_FINAL_HASH_KEYS) {
    if (!HEX64.test(value[key] || "")) {
      fail("GATE_F_M6_FINAL_BINDING_INVALID", `${key} must be a non-zero SHA-256`);
    }
  }
}

function validateServeLaunch(value, alias, {
  runtimeRoot,
  releaseId,
  sourceCommit,
}) {
  if (!exactObject(value, SERVE_LAUNCH_KEYS)
    || value.schemaVersion !== 2
    || value.alias !== alias
    || value.releaseId !== releaseId
    || value.sourceCommit !== sourceCommit
    || !samePath(value.runtimeRoot, runtimeRoot)
    || !samePath(value.nodeExe, TRUSTED_NODE_EXECUTABLE)
    || !samePath(value.deviceConfig, join(runtimeRoot, "secrets", "control-plane.devices.json"))) {
    fail("GATE_F_SERVE_LAUNCH_BINDING_INVALID", `serve launch ${alias} identity or exact schema drifted`);
  }
}

function inspectFixedRuntimeBindings(runtimeRoot, releaseIdentity) {
  const rows = {
    m6Final: join(runtimeRoot, "config", "m6-c1-runtime.v1.json"),
    serve03: join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json"),
    serve04: join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json"),
  };
  try {
    const m6Final = readJson(rows.m6Final, "GATE_F_FIXED_RUNTIME_BINDING_INVALID");
    const serve03 = readJson(rows.serve03, "GATE_F_FIXED_RUNTIME_BINDING_INVALID");
    const serve04 = readJson(rows.serve04, "GATE_F_FIXED_RUNTIME_BINDING_INVALID");
    validateM6FinalBinding(m6Final, releaseIdentity);
    validateServeLaunch(serve03, "03", { runtimeRoot, ...releaseIdentity });
    validateServeLaunch(serve04, "04", { runtimeRoot, ...releaseIdentity });
    return Object.freeze({
      m6Final: Object.freeze({ path: rows.m6Final, sha256: sha256File(rows.m6Final) }),
      serve03: Object.freeze({ path: rows.serve03, sha256: sha256File(rows.serve03) }),
      serve04: Object.freeze({ path: rows.serve04, sha256: sha256File(rows.serve04) }),
    });
  } catch (error) {
    if (/^GATE_F_/u.test(error?.message || "")) throw error;
    fail("GATE_F_FIXED_RUNTIME_BINDING_INVALID", "a required fixed runtime binding is absent or unreadable");
  }
}

function inspectPreparedRuntimeBindings(runtimeRoot, releaseIdentity, preparedRuntimeBindings) {
  if (!exactObject(preparedRuntimeBindings, PREPARED_RUNTIME_BINDING_KEYS)) {
    fail("GATE_F_PREPARED_RUNTIME_BINDINGS_INVALID", "prepared runtime binding set drifted");
  }
  const specs = {
    m6Final: { filename: "m6-c1-runtime.v1.json", livePath: join(runtimeRoot, "config", "m6-c1-runtime.v1.json") },
    serve03: {
      filename: "serve-launch-03.json",
      livePath: join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json"),
    },
    serve04: {
      filename: "serve-launch-04.json",
      livePath: join(runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json"),
    },
  };
  const loaded = {};
  for (const [key, spec] of Object.entries(specs)) {
    const descriptor = preparedRuntimeBindings[key];
    if (!exactObject(descriptor, PREPARED_RUNTIME_ARTIFACT_KEYS)
      || !HEX64.test(descriptor.sha256 || "")
      || !samePath(descriptor.path, join(
        runtimeRoot,
        "cutover-target-bindings",
        releaseIdentity.releaseId,
        descriptor.sha256,
        spec.filename,
      ))) {
      fail("GATE_F_PREPARED_RUNTIME_BINDINGS_INVALID", `${key} escaped its fixed content address`);
    }
    assertPlainFile(descriptor.path, "GATE_F_PREPARED_RUNTIME_BINDINGS_INVALID");
    if (sha256File(descriptor.path) !== descriptor.sha256) {
      fail("GATE_F_PREPARED_RUNTIME_BINDINGS_INVALID", `${key} staged bytes drifted`);
    }
    loaded[key] = {
      path: spec.livePath,
      sha256: descriptor.sha256,
      value: readJson(descriptor.path, "GATE_F_PREPARED_RUNTIME_BINDINGS_INVALID"),
    };
  }
  validateM6FinalBinding(loaded.m6Final.value, releaseIdentity);
  validateServeLaunch(loaded.serve03.value, "03", { runtimeRoot, ...releaseIdentity });
  validateServeLaunch(loaded.serve04.value, "04", { runtimeRoot, ...releaseIdentity });
  return Object.freeze({
    m6Final: Object.freeze({ path: loaded.m6Final.path, sha256: loaded.m6Final.sha256 }),
    serve03: Object.freeze({ path: loaded.serve03.path, sha256: loaded.serve03.sha256 }),
    serve04: Object.freeze({ path: loaded.serve04.path, sha256: loaded.serve04.sha256 }),
  });
}

function validateBindingShape(binding) {
  if (!exactObject(binding, BINDING_KEYS)
    || binding.schemaId !== GATE_F_LAUNCHER_BINDING_SCHEMA_ID
    || binding.mode !== "FINAL"
    || binding.taskName !== FORMAL_CONTROL_PLANE_TASK_NAME
    || !RELEASE_ID.test(binding.releaseId || "")
    || !HEX40.test(binding.sourceCommit || "")) {
    fail("GATE_F_LAUNCHER_BINDING_INVALID", "binding schema or release identity is invalid");
  }
  for (const key of [
    "launcherSha256", "launcherSourceSha256", "releaseManifestSha256",
    "runtimeEntrySha256", "contractSha256", "secretEnvironmentSha256",
    "digestKeyringSha256", "providerConfigSha256", "providerBundleDigest",
    "m6FinalBindingSha256", "serveLaunch03Sha256", "serveLaunch04Sha256",
    "trustedNodeSha256",
  ]) {
    if (!HEX64.test(binding[key] || "")) {
      fail("GATE_F_LAUNCHER_BINDING_INVALID", `${key} must be a non-zero SHA-256`);
    }
  }
  for (const key of [
    "runtimeRoot", "currentPath", "releaseRoot", "releaseManifestPath",
    "launcherPath", "launcherSourcePath", "runtimeEntryPath", "contractPath",
    "secretEnvironmentPath", "digestKeyringPath", "providerConfigPath",
    "m6FinalBindingPath", "serveLaunch03Path", "serveLaunch04Path",
    "trustedNodePath",
  ]) {
    assertAbsolutePath(binding[key], "GATE_F_LAUNCHER_BINDING_INVALID");
  }
}

export function verifyGateFLauncherIdentity({
  bindingPath,
  taskXmlPath,
  expectedReleaseId,
  expectedSourceCommit,
  providerConfigInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  preparedRuntimeBindings = null,
} = {}) {
  const bindingPathFull = assertAbsolutePath(bindingPath, "GATE_F_LAUNCHER_BINDING_PATH_INVALID");
  const taskXmlPathFull = assertAbsolutePath(taskXmlPath, "GATE_F_TASK_XML_PATH_INVALID");
  const bindingRead = readCanonicalJson(bindingPathFull, "GATE_F_LAUNCHER_BINDING_INVALID");
  const binding = bindingRead.value;
  validateBindingShape(binding);
  const bindingSha256 = sha256(bindingRead.bytes);
  assertAddressedFile(
    bindingPathFull,
    bindingSha256,
    FORMAL_BINDING_FILENAME,
    "GATE_F_LAUNCHER_BINDING_ADDRESS_INVALID",
  );
  if (!samePath(bindingPathFull, join(
    binding.runtimeRoot,
    "launcher-bindings",
    bindingSha256,
    FORMAL_BINDING_FILENAME,
  ))) {
    fail("GATE_F_LAUNCHER_BINDING_ADDRESS_INVALID", "binding escaped its fixed runtime namespace");
  }
  if (binding.releaseId !== expectedReleaseId || binding.sourceCommit !== expectedSourceCommit
    || !HEX40.test(expectedSourceCommit || "")) {
    fail("GATE_F_SOURCE_IDENTITY_MISMATCH", "expected source identity does not match binding");
  }

  assertPlainDirectory(binding.runtimeRoot, "GATE_F_RUNTIME_ROOT_INVALID");
  if (!samePath(binding.trustedNodePath, TRUSTED_NODE_EXECUTABLE)) {
    fail("GATE_F_TRUSTED_NODE_INVALID", "trusted Node path drifted from the machine TCB");
  }
  assertPlainFile(binding.trustedNodePath, "GATE_F_TRUSTED_NODE_INVALID");
  if (sha256File(binding.trustedNodePath) !== binding.trustedNodeSha256) {
    fail("GATE_F_TRUSTED_NODE_INVALID", "trusted Node bytes drifted from the launcher binding");
  }
  const privateMaterial = privateMaterialInspector({ runtimeRoot: binding.runtimeRoot });
  if (!samePath(binding.secretEnvironmentPath, privateMaterial.secretEnvironment.path)
    || binding.secretEnvironmentSha256 !== privateMaterial.secretEnvironment.sha256
    || !samePath(binding.digestKeyringPath, privateMaterial.digestKeyring.path)
    || binding.digestKeyringSha256 !== privateMaterial.digestKeyring.sha256) {
    fail("GATE_F_PRIVATE_MATERIAL_BINDING_INVALID", "private material path or hash drifted");
  }
  const providerConfig = providerConfigInspector(binding.runtimeRoot);
  if (!samePath(binding.providerConfigPath, providerConfig.path)
    || binding.providerConfigSha256 !== providerConfig.sha256
    || binding.providerBundleDigest !== providerConfig.providerBundleDigest) {
    fail("GATE_F_PROVIDER_BINDING_INVALID", "provider config path, hash, or bundle digest drifted");
  }
  const releaseIdentity = {
    releaseId: binding.releaseId,
    sourceCommit: binding.sourceCommit,
    releaseRoot: binding.releaseRoot,
    releaseManifestSha256: binding.releaseManifestSha256,
  };
  const fixedRuntime = preparedRuntimeBindings === null
    ? inspectFixedRuntimeBindings(binding.runtimeRoot, releaseIdentity)
    : inspectPreparedRuntimeBindings(binding.runtimeRoot, releaseIdentity, preparedRuntimeBindings);
  if (!samePath(binding.m6FinalBindingPath, fixedRuntime.m6Final.path)
    || binding.m6FinalBindingSha256 !== fixedRuntime.m6Final.sha256
    || !samePath(binding.serveLaunch03Path, fixedRuntime.serve03.path)
    || binding.serveLaunch03Sha256 !== fixedRuntime.serve03.sha256
    || !samePath(binding.serveLaunch04Path, fixedRuntime.serve04.path)
    || binding.serveLaunch04Sha256 !== fixedRuntime.serve04.sha256) {
    fail("GATE_F_FIXED_RUNTIME_BINDING_DRIFT", "M6 or serve launch binding drifted");
  }
  const releasesRoot = join(binding.runtimeRoot, "releases");
  assertPlainDirectory(releasesRoot, "GATE_F_RELEASES_ROOT_INVALID");
  assertPlainDirectory(binding.releaseRoot, "GATE_F_RELEASE_ROOT_INVALID");
  if (!within(releasesRoot, binding.releaseRoot)
    || !samePath(binding.currentPath, join(binding.runtimeRoot, "current"))) {
    fail("GATE_F_CURRENT_RELEASE_INVALID", "current/release paths escape the runtime layout");
  }
  if (preparedRuntimeBindings === null) {
    const currentStat = lstatSync(binding.currentPath);
    if (!currentStat.isSymbolicLink() || !samePath(realpathSync(binding.currentPath), binding.releaseRoot)) {
      fail("GATE_F_CURRENT_RELEASE_INVALID", "current must be a reparse link to the exact bound release");
    }
  }

  const manifestRead = readCanonicalJson(binding.releaseManifestPath, "GATE_F_RELEASE_MANIFEST_INVALID");
  const manifest = manifestRead.value;
  if (sha256(manifestRead.bytes) !== binding.releaseManifestSha256
    || !samePath(binding.releaseManifestPath, join(binding.releaseRoot, "release-manifest.v1.json"))
    || manifest?.schemaId !== "xw.runtime.release-manifest.v1"
    || manifest?.releaseId !== binding.releaseId
    || manifest?.sourceCommit !== binding.sourceCommit
    || basename(binding.releaseRoot) !== binding.releaseId) {
    fail("GATE_F_RELEASE_MANIFEST_INVALID", "manifest/current/binding release identity drifted");
  }

  assertAddressedFile(
    binding.launcherPath,
    binding.launcherSha256,
    FORMAL_LAUNCHER_FILENAME,
    "GATE_F_LAUNCHER_BODY_INVALID",
  );
  if (!samePath(binding.launcherPath, join(
    binding.runtimeRoot,
    "launchers",
    binding.launcherSha256,
    FORMAL_LAUNCHER_FILENAME,
  ))) {
    fail("GATE_F_LAUNCHER_BODY_INVALID", "launcher escaped launchers/<sha256>");
  }
  assertManifestFile(
    binding,
    manifest,
    binding.launcherSourcePath,
    "services/control-plane/ops/launch-control-plane.ps1",
    binding.launcherSourceSha256,
    "GATE_F_LAUNCHER_SOURCE_INVALID",
  );
  if (binding.launcherSourceSha256 !== binding.launcherSha256) {
    fail("GATE_F_LAUNCHER_SOURCE_BODY_MISMATCH", "installed launcher is not byte-identical to tracked source");
  }
  assertManifestFile(
    binding,
    manifest,
    binding.runtimeEntryPath,
    "services/control-plane/scripts/xw-control-plane-runtime.ps1",
    binding.runtimeEntrySha256,
    "GATE_F_RUNTIME_ENTRY_INVALID",
  );
  assertManifestFile(
    binding,
    manifest,
    binding.contractPath,
    "config/runtime/xw-runtime.v1.json",
    binding.contractSha256,
    "GATE_F_RUNTIME_CONTRACT_INVALID",
  );

  const expectedXml = buildFormalControlPlaneTaskXml({
    runtimeRoot: binding.runtimeRoot,
    launcherPath: binding.launcherPath,
    bindingPath: bindingPathFull,
    launcherSha256: binding.launcherSha256,
    bindingSha256,
    releaseId: binding.releaseId,
    sourceCommit: binding.sourceCommit,
    taskName: binding.taskName,
  });
  assertPlainFile(taskXmlPathFull, "GATE_F_TASK_XML_INVALID");
  const taskXml = readFileSync(taskXmlPathFull, "utf8");
  const taskXmlSha256 = sha256(Buffer.from(taskXml, "utf8"));
  if (taskXml !== expectedXml
    || basename(taskXmlPathFull) !== FORMAL_TASK_XML_FILENAME
    || basename(dirname(taskXmlPathFull)).toLowerCase() !== taskXmlSha256
    || !samePath(taskXmlPathFull, join(
      binding.runtimeRoot,
      "task-bindings",
      taskXmlSha256,
      FORMAL_TASK_XML_FILENAME,
    ))
    || /\.simple(?:\.|\s|&quot;|<)/iu.test(taskXml)
    || !taskXml.includes("<UserId>SYSTEM</UserId>")) {
    fail("GATE_F_TASK_XML_INVALID", "task XML/action/principal is not the exact formal binding");
  }

  return {
    ok: true,
    schemaId: GATE_F_LAUNCHER_INSTALL_SCHEMA_ID,
    releaseId: binding.releaseId,
    sourceCommit: binding.sourceCommit,
    identity: {
      source: expectedSourceCommit,
      binding: binding.sourceCommit,
      current: preparedRuntimeBindings === null ? manifest.sourceCommit : null,
      manifest: manifest.sourceCommit,
    },
    launcher: {
      sourcePath: binding.launcherSourcePath,
      sourceSha256: binding.launcherSourceSha256,
      bodyPath: binding.launcherPath,
      bodySha256: binding.launcherSha256,
    },
    binding: { path: bindingPathFull, sha256: bindingSha256 },
    task: {
      name: binding.taskName,
      principal: "SYSTEM",
      xmlPath: taskXmlPathFull,
      xmlSha256: taskXmlSha256,
      registration: buildCreateOnlyTaskRegistration({ taskXmlPath: taskXmlPathFull, taskName: binding.taskName }),
    },
    releaseManifest: {
      path: binding.releaseManifestPath,
      sha256: binding.releaseManifestSha256,
    },
    privateMaterial: {
      secretEnvironment: {
        sha256: binding.secretEnvironmentSha256,
        requiredEnvironment: privateMaterial.secretEnvironment.requiredEnvironment,
      },
      digestKeyring: {
        sha256: binding.digestKeyringSha256,
        activeKeyId: "present",
        keyMaterial: "present",
      },
    },
    provider: {
      configSha256: binding.providerConfigSha256,
      providerBundleDigest: binding.providerBundleDigest,
      closure: "verified",
    },
    fixedRuntimeBindings: {
      m6FinalSha256: binding.m6FinalBindingSha256,
      serveLaunch03Sha256: binding.serveLaunch03Sha256,
      serveLaunch04Sha256: binding.serveLaunch04Sha256,
    },
    trustedNode: {
      sha256: binding.trustedNodeSha256,
    },
    active: preparedRuntimeBindings === null,
  };
}

function writeCreateOnly(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    fail("GATE_F_CREATE_ONLY_CONFLICT", `${path}: ${error.code || error.message}`);
  }
}

export function installGateFLauncherArtifacts({
  runtimeRoot,
  expectedReleaseId,
  expectedSourceCommit,
  taskName = FORMAL_CONTROL_PLANE_TASK_NAME,
  providerConfigInspector = inspectGateFProviderConfigClosure,
  privateMaterialInspector = inspectControlPlanePrivateMaterial,
  preparedRuntimeBindings = null,
} = {}) {
  const runtimeRootFull = assertAbsolutePath(runtimeRoot, "GATE_F_RUNTIME_ROOT_INVALID");
  assertPlainDirectory(runtimeRootFull, "GATE_F_RUNTIME_ROOT_INVALID");
  if (!RELEASE_ID.test(expectedReleaseId || "") || !HEX40.test(expectedSourceCommit || "")) {
    fail("GATE_F_SOURCE_IDENTITY_INVALID", "expected release/source identity is required");
  }
  if (taskName !== FORMAL_CONTROL_PLANE_TASK_NAME) {
    fail("GATE_F_TASK_NAME_INVALID", "the formal task name is fixed");
  }

  const currentPath = join(runtimeRootFull, "current");
  const releasesRoot = join(runtimeRootFull, "releases");
  assertPlainDirectory(releasesRoot, "GATE_F_RELEASES_ROOT_INVALID");
  let releaseRoot;
  if (preparedRuntimeBindings === null) {
    const currentStat = lstatSync(currentPath);
    if (!currentStat.isSymbolicLink()) fail("GATE_F_CURRENT_RELEASE_INVALID", "current is not a reparse link");
    releaseRoot = realpathSync(currentPath);
  } else {
    releaseRoot = join(releasesRoot, expectedReleaseId);
  }
  assertPlainDirectory(releaseRoot, "GATE_F_RELEASE_ROOT_INVALID");
  if (!within(releasesRoot, releaseRoot) || basename(releaseRoot) !== expectedReleaseId) {
    fail("GATE_F_CURRENT_RELEASE_INVALID", "current does not resolve to the expected immutable release");
  }

  const releaseManifestPath = join(releaseRoot, "release-manifest.v1.json");
  const manifestRead = readCanonicalJson(releaseManifestPath, "GATE_F_RELEASE_MANIFEST_INVALID");
  const manifest = manifestRead.value;
  if (manifest?.schemaId !== "xw.runtime.release-manifest.v1"
    || manifest?.releaseId !== expectedReleaseId
    || manifest?.sourceCommit !== expectedSourceCommit) {
    fail("GATE_F_SOURCE_IDENTITY_MISMATCH", "current manifest does not match expected release/source identity");
  }

  const launcherSourcePath = join(releaseRoot, "services", "control-plane", "ops", FORMAL_LAUNCHER_FILENAME);
  const runtimeEntryPath = join(releaseRoot, "services", "control-plane", "scripts", "xw-control-plane-runtime.ps1");
  const contractPath = join(releaseRoot, "config", "runtime", "xw-runtime.v1.json");
  for (const [path, releasePath] of [
    [launcherSourcePath, "services/control-plane/ops/launch-control-plane.ps1"],
    [runtimeEntryPath, "services/control-plane/scripts/xw-control-plane-runtime.ps1"],
    [contractPath, "config/runtime/xw-runtime.v1.json"],
  ]) {
    assertPlainFile(path, "GATE_F_RELEASE_ARTIFACT_INVALID");
    if (manifestEntry(manifest, releasePath).sha256 !== sha256File(path)) {
      fail("GATE_F_RELEASE_ARTIFACT_INVALID", `${releasePath} differs from the release manifest`);
    }
  }
  const privateMaterial = privateMaterialInspector({ runtimeRoot: runtimeRootFull });
  assertPlainFile(TRUSTED_NODE_EXECUTABLE, "GATE_F_TRUSTED_NODE_INVALID");
  const trustedNodeSha256 = sha256File(TRUSTED_NODE_EXECUTABLE);
  const providerConfig = providerConfigInspector(runtimeRootFull);
  const releaseIdentity = {
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    releaseRoot,
    releaseManifestSha256: sha256(manifestRead.bytes),
  };
  const fixedRuntime = preparedRuntimeBindings === null
    ? inspectFixedRuntimeBindings(runtimeRootFull, releaseIdentity)
    : inspectPreparedRuntimeBindings(runtimeRootFull, releaseIdentity, preparedRuntimeBindings);

  const launcherBytes = readFileSync(launcherSourcePath);
  const launcherSha256 = sha256(launcherBytes);
  const launcherPath = join(runtimeRootFull, "launchers", launcherSha256, FORMAL_LAUNCHER_FILENAME);
  const binding = {
    schemaId: GATE_F_LAUNCHER_BINDING_SCHEMA_ID,
    taskName,
    mode: "FINAL",
    runtimeRoot: runtimeRootFull,
    currentPath,
    releaseRoot,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    releaseManifestPath,
    releaseManifestSha256: sha256(manifestRead.bytes),
    launcherPath,
    launcherSha256,
    launcherSourcePath,
    launcherSourceSha256: launcherSha256,
    runtimeEntryPath,
    runtimeEntrySha256: sha256File(runtimeEntryPath),
    contractPath,
    contractSha256: sha256File(contractPath),
    secretEnvironmentPath: privateMaterial.secretEnvironment.path,
    secretEnvironmentSha256: privateMaterial.secretEnvironment.sha256,
    digestKeyringPath: privateMaterial.digestKeyring.path,
    digestKeyringSha256: privateMaterial.digestKeyring.sha256,
    providerConfigPath: providerConfig.path,
    providerConfigSha256: providerConfig.sha256,
    providerBundleDigest: providerConfig.providerBundleDigest,
    m6FinalBindingPath: fixedRuntime.m6Final.path,
    m6FinalBindingSha256: fixedRuntime.m6Final.sha256,
    serveLaunch03Path: fixedRuntime.serve03.path,
    serveLaunch03Sha256: fixedRuntime.serve03.sha256,
    serveLaunch04Path: fixedRuntime.serve04.path,
    serveLaunch04Sha256: fixedRuntime.serve04.sha256,
    trustedNodePath: TRUSTED_NODE_EXECUTABLE,
    trustedNodeSha256,
  };
  const bindingBytes = canonicalJsonBytes(binding);
  const bindingSha256 = sha256(bindingBytes);
  const bindingPath = join(runtimeRootFull, "launcher-bindings", bindingSha256, FORMAL_BINDING_FILENAME);
  const taskXml = buildFormalControlPlaneTaskXml({
    runtimeRoot: runtimeRootFull,
    launcherPath,
    bindingPath,
    launcherSha256,
    bindingSha256,
    releaseId: expectedReleaseId,
    sourceCommit: expectedSourceCommit,
    taskName,
  });
  const taskXmlBytes = Buffer.from(taskXml, "utf8");
  const taskXmlSha256 = sha256(taskXmlBytes);
  const taskXmlPath = join(runtimeRootFull, "task-bindings", taskXmlSha256, FORMAL_TASK_XML_FILENAME);

  const artifactRows = [
    [launcherPath, launcherBytes],
    [bindingPath, bindingBytes],
    [taskXmlPath, taskXmlBytes],
  ];
  const existing = new Set();
  for (const [target, expectedBytes] of artifactRows) {
    try {
      lstatSync(target);
      if (preparedRuntimeBindings === null) {
        fail("GATE_F_CREATE_ONLY_CONFLICT", `${target} already exists`);
      }
      assertPlainFile(target, "GATE_F_CREATE_ONLY_CONFLICT");
      if (!readFileSync(target).equals(expectedBytes)) {
        fail("GATE_F_CREATE_ONLY_CONFLICT", `${target} exists with different bytes`);
      }
      existing.add(target);
    } catch (error) {
      if (error?.message?.startsWith("GATE_F_CREATE_ONLY_CONFLICT")) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const [target, bytes] of artifactRows) {
    if (!existing.has(target)) writeCreateOnly(target, bytes);
  }

  return verifyGateFLauncherIdentity({
    bindingPath,
    taskXmlPath,
    expectedReleaseId,
    expectedSourceCommit,
    providerConfigInspector,
    privateMaterialInspector,
    preparedRuntimeBindings,
  });
}

export function prepareGateFTargetLauncherArtifacts(options = {}) {
  if (!options?.preparedRuntimeBindings) {
    fail("GATE_F_PREPARED_RUNTIME_BINDINGS_REQUIRED", "target preparation requires staged M6/serve bindings");
  }
  return installGateFLauncherArtifacts(options);
}
