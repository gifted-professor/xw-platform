import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  authorizeGateFLegacyBootstrap,
  authorizeGateFCutoverTransition,
  buildGateFAuxiliaryTaskXml,
  captureFixedGateFRollbackSnapshots,
  captureGateFLegacyPrestate,
  executeGateFCutover,
  executeLegacyGateFBootstrap,
  GATE_F_CONTROL_HEALTH_URL,
  GATE_F_CUTOVER_OPERATOR_RELEASE_PATH,
  GATE_F_CUTOVER_TRANSITION_SCHEMA_ID,
  GATE_F_CUTOVER_TUPLE_SCHEMA_ID,
  GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID,
  GATE_F_FINAL_VALIDATE_FIXED_SCHEMA_ID,
  GATE_F_LEGACY_PRESTATE_SCHEMA_ID,
  GATE_F_REGISTRY_HEALTH_URL,
  GATE_F_STATUS_URL,
  materializeGateFCutoverTuple,
  normalizeGateFTaskOwnedProcessClosure,
  prepareGateFCutoverTargetFromFixedCandidate,
  parseFormalTaskDefinition,
  parseLegacyTaskDefinition,
  parseGateFCutoverCommand,
  replaceCurrentJunction,
  replaceFileWithBackup,
  stageGateFTargetCandidateFromFixedAssembler,
  validateGateFFinalLauncherFixed,
  validateGateFCutoverTupleDocument,
  verifyGateFLegacyPrestate,
  verifyGateFCutoverTuple,
  gateFAuxiliaryTaskFilename,
  WINDOWS_POWERSHELL_EXECUTABLE,
} from "../ops/gate-f-cutover-operator.mjs";
import {
  buildFormalControlPlaneTaskXml,
  FORMAL_BINDING_FILENAME,
  FORMAL_CONTROL_PLANE_TASK_NAME,
  FORMAL_LAUNCHER_FILENAME,
  FORMAL_TASK_XML_FILENAME,
  GATE_F_LAUNCHER_BINDING_SCHEMA_ID,
  TRUSTED_NODE_EXECUTABLE,
} from "../ops/gate-f-launcher-identity.mjs";
import { canonicalJson as domainCanonicalJson } from
  "../control-plane/lib/canonical.mjs";
import { loadM6Gate, writeImmutableJson } from
  "../control-plane/lib/m6-gate-loader.mjs";
import { assertM6FileDbPointerConsistency } from
  "../control-plane/lib/m6-gate-promoter.mjs";
import { stageM6QualificationBootstrapRotationArtifacts } from
  "../control-plane/lib/m6-qualification-bootstrap.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import {
  assembleM64QualificationBootstrapPackage,
  buildM64QualificationBootstrapSigningDraft,
} from "../../../tools/m6/m6-4-qualification-bootstrap-operator.mjs";

const NODE_VERSION = "24.11.1";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifact(path, bytes, extra = {}) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return { path, sha256: hash(value), bytesBase64: value.toString("base64"), ...extra };
}

function jsonArtifact(path, value, extra = {}) {
  return artifact(path, canonical(value), extra);
}

function buildSignedClosedGatePackage({
  runtimeRoot,
  releaseId,
  sourceCommit,
  actor,
  privateKey,
  issuerAllowlistPath,
  nowMs,
  timeline = {
    rootIssuedAt: "2030-01-01T00:00:00.000Z",
    closeoutCommittedAt: "2030-01-01T00:00:01.000Z",
    closedIssuedAt: "2030-01-01T00:00:02.000Z",
    promotedAt: "2030-01-01T00:00:03.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z",
  },
}) {
  const gateId = `m6-4-gate-f-${sourceCommit.slice(0, 7)}`;
  const lockHashes = {
    runtimeProfile: hash(`runtime-profile-${releaseId}`),
    hardRedlinePolicy: hash(`hard-redline-${releaseId}`),
    groundingRuntime: hash(`grounding-runtime-${releaseId}`),
  };
  const draft = buildM64QualificationBootstrapSigningDraft({
    releaseId,
    sourceCommit,
    gateId,
    locksRecord: {
      schemaId: "xw.m6-locks.v1",
      releaseId,
      sourceCommit,
      lockHashes,
    },
    actor,
    rootIssuedAt: timeline.rootIssuedAt,
    closeoutCommittedAt: timeline.closeoutCommittedAt,
    closedIssuedAt: timeline.closedIssuedAt,
    promotedAt: timeline.promotedAt,
    expiresAt: timeline.expiresAt,
    issuerAllowlistSha256: hash(readFileSync(issuerAllowlistPath)),
  });
  const proof = (epochHash) => ({
    keyId: "gate-f-cutover-test-key",
    subject: actor,
    allowlistVersion: 1,
    signature: sign(null, Buffer.from(epochHash, "hex"), privateKey).toString("base64"),
    algorithm: "ed25519",
  });
  const pkg = assembleM64QualificationBootstrapPackage({
    draft,
    rootProof: proof(draft.rootEpoch.epochHash),
    closedProof: proof(draft.closedEpoch.epochHash),
    issuerAllowlistPath,
    runtimeRoot,
    nowMs,
  });
  const staged = stageM6QualificationBootstrapRotationArtifacts({
    package: pkg,
    m6Root: runtimeRoot,
    issuerAllowlistPath,
    nowMs,
  });
  return {
    ...staged,
    locksHash: hash(`xw.m6-locks.v1:${domainCanonicalJson(lockHashes)}`),
  };
}

function makeTuple(runtimeRoot, marker) {
  const releaseId = `xw-gate-${marker}`;
  const sourceCommit = marker.repeat(40);
  const gateId = `m6-4-gate-f-${sourceCommit.slice(0, 7)}`;
  const packageHash = hash(`package-${marker}`);
  const rootEpochHash = hash(`root-epoch-${marker}`);
  const closedEpochHash = hash(`closed-epoch-${marker}`);
  const pointerValue = {
    chain: [rootEpochHash, closedEpochHash],
    tailEpochHash: closedEpochHash,
    generation: 0,
    promotedAt: "2030-01-01T00:00:00.000Z",
  };
  const gateHandoff = {
    schemaId: GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID,
    gateId,
    packageHash,
    package: {
      path: join(
        runtimeRoot,
        "m6-audit",
        `m6-c1-qualification-bootstrap-${sourceCommit.slice(0, 7)}`,
        "packages",
        `${packageHash}.package.json`,
      ),
      sha256: hash(`package-bytes-${marker}`),
    },
    closedEpochHash,
    locksHash: hash(`locks-${marker}`),
    pointer: jsonArtifact(join(runtimeRoot, "m6-gate", gateId, "current.json"), pointerValue),
  };
  const releaseRoot = join(runtimeRoot, "releases", releaseId);
  const operatorPath = join(releaseRoot, ...GATE_F_CUTOVER_OPERATOR_RELEASE_PATH.split("/"));
  const operator = artifact(operatorPath, `operator-${marker}\n`);
  const runtimeModules = {
    controlPlane: artifact(
      join(releaseRoot, "services", "control-plane", "control-plane", "server.mjs"),
      `control-plane-${marker}\n`,
    ),
    registry: artifact(
      join(releaseRoot, "services", "orchestrator", "registry.mjs"),
      `registry-${marker}\n`,
    ),
    fastOperator: artifact(
      join(releaseRoot, "services", "control-plane", "scripts", "fast-operator.mjs"),
      `fast-operator-${marker}\n`,
    ),
  };
  const launcherBytes = Buffer.from(`launcher-${marker}\n`, "utf8");
  const launcherSha256 = hash(launcherBytes);
  const launcherPath = join(runtimeRoot, "launchers", launcherSha256, FORMAL_LAUNCHER_FILENAME);
  const launcher = artifact(launcherPath, launcherBytes);
  const providerBundleDigest = "9".repeat(64);
  const providerPath = join(
    runtimeRoot,
    "state",
    "orchestrator",
    "xhs-exploration-vision-provider.v1.json",
  );
  const provider = jsonArtifact(providerPath, { schemaId: "fixture.provider.v1", fixed: true }, {
    providerBundleDigest,
  });
  const manifest = {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit,
    sourceTreeSha: "8".repeat(40),
    runtimeProfile: "legacy_compat",
    nodeVersion: NODE_VERSION,
    npmVersion: null,
    services: {
      orchestrator: { path: "services/orchestrator", treeSha256: "7".repeat(64) },
      controlPlane: { path: "services/control-plane", treeSha256: "6".repeat(64) },
    },
    files: [
      [GATE_F_CUTOVER_OPERATOR_RELEASE_PATH, operator],
      ["services/control-plane/control-plane/server.mjs", runtimeModules.controlPlane],
      ["services/orchestrator/registry.mjs", runtimeModules.registry],
      ["services/control-plane/scripts/fast-operator.mjs", runtimeModules.fastOperator],
    ].map(([path, value], index) => ({
      path,
      gitMode: "100644",
      gitBlobOid: String(5 + index).repeat(40),
      sha256: value.sha256,
    })),
    runtimeCutoverAllowed: false,
  };
  const manifestArtifact = jsonArtifact(join(releaseRoot, "release-manifest.v1.json"), manifest);
  const m6Path = join(runtimeRoot, "config", "m6-c1-runtime.v1.json");
  const m6 = jsonArtifact(m6Path, {
    schemaId: "xw.runtime.m6-c1-runtime.v1",
    releaseId,
    sourceCommit,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256: manifestArtifact.sha256,
    gateFArtifactCatalogPath: join(runtimeRoot, "state", `gate-f-catalog-${marker}.json`),
    gateFArtifactCatalogHash: "4".repeat(64),
    gateId,
  });
  const serve = (alias) => jsonArtifact(
    join(runtimeRoot, "state", "control-plane", "fast-operator", `serve-launch-${alias}.json`),
    {
      schemaVersion: 2,
      runtimeRoot,
      nodeExe: TRUSTED_NODE_EXECUTABLE,
      releaseId,
      sourceCommit,
      deviceConfig: join(runtimeRoot, "secrets", "control-plane.devices.json"),
      alias,
    },
  );
  const serve03 = serve("03");
  const serve04 = serve("04");
  const secretEnvironmentPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  const digestKeyringPath = join(runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json");
  const privateBytes = {
    secret: Buffer.from("fixture-secret-snapshot", "utf8"),
    keyring: Buffer.from("fixture-keyring-snapshot", "utf8"),
  };
  const systemTaskClosureBytes = {
    orchestratorLauncher: Buffer.from("fixture-orchestrator-launcher", "utf8"),
    fastOperatorLauncher: Buffer.from("fixture-fast-operator-launcher", "utf8"),
    deviceConfig: Buffer.from("fixture-device-config", "utf8"),
  };
  const systemTaskClosure = {
    windowsPowerShell: {
      path: WINDOWS_POWERSHELL_EXECUTABLE,
      sha256: hash(readFileSync(WINDOWS_POWERSHELL_EXECUTABLE)),
    },
    orchestratorLauncher: {
      path: join(runtimeRoot, "secrets", "launch-orchestrator.ps1"),
      sha256: hash(systemTaskClosureBytes.orchestratorLauncher),
    },
    fastOperatorLauncher: {
      path: join(runtimeRoot, "launch-fast-operator-serve.ps1"),
      sha256: hash(systemTaskClosureBytes.fastOperatorLauncher),
    },
    deviceConfig: {
      path: join(runtimeRoot, "secrets", "control-plane.devices.json"),
      sha256: hash(systemTaskClosureBytes.deviceConfig),
    },
  };
  const trustedNodeSha256 = hash(Buffer.from("trusted-node-fixture", "utf8"));
  const binding = {
    schemaId: GATE_F_LAUNCHER_BINDING_SCHEMA_ID,
    taskName: FORMAL_CONTROL_PLANE_TASK_NAME,
    mode: "FINAL",
    runtimeRoot,
    currentPath: join(runtimeRoot, "current"),
    releaseRoot,
    releaseId,
    sourceCommit,
    releaseManifestPath: manifestArtifact.path,
    releaseManifestSha256: manifestArtifact.sha256,
    launcherPath,
    launcherSha256,
    providerConfigPath: provider.path,
    providerConfigSha256: provider.sha256,
    providerBundleDigest,
    m6FinalBindingPath: m6.path,
    m6FinalBindingSha256: m6.sha256,
    serveLaunch03Path: serve03.path,
    serveLaunch03Sha256: serve03.sha256,
    serveLaunch04Path: serve04.path,
    serveLaunch04Sha256: serve04.sha256,
    secretEnvironmentPath,
    secretEnvironmentSha256: hash(privateBytes.secret),
    digestKeyringPath,
    digestKeyringSha256: hash(privateBytes.keyring),
    trustedNodePath: TRUSTED_NODE_EXECUTABLE,
    trustedNodeSha256,
  };
  const bindingBytes = canonical(binding);
  const bindingSha256 = hash(bindingBytes);
  const bindingPath = join(runtimeRoot, "launcher-bindings", bindingSha256, FORMAL_BINDING_FILENAME);
  const bindingArtifact = artifact(bindingPath, bindingBytes);
  const taskXml = buildFormalControlPlaneTaskXml({
    runtimeRoot,
    launcherPath,
    bindingPath,
    launcherSha256,
    bindingSha256,
    releaseId,
    sourceCommit,
  });
  const taskXmlBytes = Buffer.from(taskXml, "utf8");
  const taskXmlSha256 = hash(taskXmlBytes);
  const taskXmlPath = join(runtimeRoot, "task-bindings", taskXmlSha256, FORMAL_TASK_XML_FILENAME);
  const taskDefinition = parseFormalTaskDefinition(taskXml);
  const auxiliaryNames = [
    "XW Platform Orchestrator",
    "XW Platform FastOperator 03",
    "XW Platform FastOperator 04",
  ];
  const activationTasks = auxiliaryNames.map((name) => {
    const xml = buildGateFAuxiliaryTaskXml({ runtimeRoot, taskName: name });
    const bytes = Buffer.from(xml, "utf8");
    const sha256 = hash(bytes);
    const definition = parseFormalTaskDefinition(xml);
    return {
      name,
      principal: "SYSTEM",
      xml: artifact(join(runtimeRoot, "task-bindings", sha256, gateFAuxiliaryTaskFilename(name)), bytes),
      action: definition.action,
      definition,
    };
  });
  const snapshot = (name, targetPath, bytes) => ({
    targetPath,
    snapshotPath: join(runtimeRoot, "rollback-snapshots", marker, name),
    snapshotSha256: hash(bytes),
  });
  return {
    tuple: {
      schemaId: GATE_F_CUTOVER_TUPLE_SCHEMA_ID,
      runtimeRoot,
      release: { releaseId, sourceCommit, root: releaseRoot, manifest: manifestArtifact },
      operator,
      current: { path: join(runtimeRoot, "current"), target: releaseRoot },
      formal: {
        binding: bindingArtifact,
        launcher,
        task: {
          name: FORMAL_CONTROL_PLANE_TASK_NAME,
          principal: "SYSTEM",
          xml: artifact(taskXmlPath, taskXmlBytes),
          action: taskDefinition.action,
        },
      },
      activationTasks: activationTasks.map(({ definition: _definition, ...task }) => task),
      gateHandoff,
      trustedNode: { path: TRUSTED_NODE_EXECUTABLE, version: NODE_VERSION, sha256: trustedNodeSha256 },
      systemTaskClosure,
      xhsV3PrivateRoots: ["invocations", "captures", "corpus-sets", "runs", "acceptance"]
        .map((name) => join(runtimeRoot, "private", "xhs-v3", name)),
      runtimeBindings: {
        m6Final: m6,
        serve03,
        serve04,
        provider,
        secretEnvironment: { path: secretEnvironmentPath, sha256: hash(privateBytes.secret) },
        digestKeyring: { path: digestKeyringPath, sha256: hash(privateBytes.keyring) },
      },
      liveIdentity: {
        controlPlane: { url: GATE_F_CONTROL_HEALTH_URL, releaseId, sourceCommit },
        registry: { url: GATE_F_REGISTRY_HEALTH_URL, releaseId, sourceCommit },
        gate: { url: GATE_F_STATUS_URL, mode: "CLOSED", phase: "CLOSED" },
      },
      snapshots: {
        controlDb: snapshot(
          "control.snapshot.db",
          join(runtimeRoot, "state", "control-plane", "control.db"),
          Buffer.from(`control-${marker}`, "utf8"),
        ),
        registryDb: snapshot(
          "registry.snapshot.db",
          join(runtimeRoot, "state", "orchestrator", "registry.db"),
          Buffer.from(`registry-${marker}`, "utf8"),
        ),
        privateMaterial: [
          snapshot("secret.snapshot.json", secretEnvironmentPath, privateBytes.secret),
          snapshot("keyring.snapshot.json", digestKeyringPath, privateBytes.keyring),
        ],
      },
    },
    snapshotBytes: {
      "control.snapshot.db": Buffer.from(`control-${marker}`, "utf8"),
      "registry.snapshot.db": Buffer.from(`registry-${marker}`, "utf8"),
      "secret.snapshot.json": privateBytes.secret,
      "keyring.snapshot.json": privateBytes.keyring,
    },
    systemTaskClosureBytes,
    runtimeModules,
    taskDefinition,
    activationTaskDefinitions: Object.fromEntries(activationTasks.map((task) => [task.name, task.definition])),
  };
}

function writeArtifact(value) {
  mkdirSync(dirname(value.path), { recursive: true });
  writeFileSync(value.path, Buffer.from(value.bytesBase64, "base64"));
}

function materializeFixture(t, marker = "a") {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-gate-cutover-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const fixture = makeTuple(runtimeRoot, marker);
  const tuple = fixture.tuple;
  for (const value of [
    tuple.release.manifest,
    tuple.operator,
    ...Object.values(fixture.runtimeModules),
    tuple.formal.binding,
    tuple.formal.launcher,
    tuple.formal.task.xml,
    ...tuple.activationTasks.map((task) => task.xml),
    tuple.runtimeBindings.m6Final,
    tuple.runtimeBindings.serve03,
    tuple.runtimeBindings.serve04,
    tuple.runtimeBindings.provider,
  ]) writeArtifact(value);
  for (const value of [tuple.runtimeBindings.secretEnvironment, tuple.runtimeBindings.digestKeyring]) {
    mkdirSync(dirname(value.path), { recursive: true });
    writeFileSync(value.path, value === tuple.runtimeBindings.secretEnvironment
      ? fixture.snapshotBytes["secret.snapshot.json"] : fixture.snapshotBytes["keyring.snapshot.json"]);
  }
  for (const key of ["orchestratorLauncher", "fastOperatorLauncher", "deviceConfig"]) {
    mkdirSync(dirname(tuple.systemTaskClosure[key].path), { recursive: true });
    writeFileSync(tuple.systemTaskClosure[key].path, fixture.systemTaskClosureBytes[key]);
  }
  for (const value of [tuple.snapshots.controlDb, tuple.snapshots.registryDb, ...tuple.snapshots.privateMaterial]) {
    mkdirSync(dirname(value.snapshotPath), { recursive: true });
    writeFileSync(value.snapshotPath, fixture.snapshotBytes[basename(value.snapshotPath)]);
  }
  symlinkSync(tuple.release.root, tuple.current.path, process.platform === "win32" ? "junction" : "dir");
  const addressed = materializeGateFCutoverTuple({
    runtimeRoot,
    tuple,
    tcbAclController: { protect() {}, verify() {} },
  });
  return { ...fixture, runtimeRoot, ...addressed };
}

function exactClosedLive(tuple) {
  return {
    controlPlane: {
      ok: true,
      authority: true,
      activeLeases: 0,
      releaseId: tuple.release.releaseId,
      sourceCommit: tuple.release.sourceCommit,
    },
    registry: {
      ok: true,
      releaseId: tuple.release.releaseId,
      sourceCommit: tuple.release.sourceCommit,
    },
    gate: {
      gate: {
        schemaId: "xw.m6-gate-f-operations-status.v1",
        mode: "CLOSED",
        phase: "CLOSED",
        tripleConsistent: true,
        activeAuthorizationCount: 0,
        actionCount: 0,
        errors: [],
        resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
      },
    },
  };
}

function exactTaskOwnedProcessClosure(fixture) {
  const tuple = fixture.tuple;
  const specs = [
    ["controlPlane", FORMAL_CONTROL_PLANE_TASK_NAME, fixture.runtimeModules.controlPlane.sha256],
    ["registry", "XW Platform Orchestrator", fixture.runtimeModules.registry.sha256],
    ["serve03", "XW Platform FastOperator 03", fixture.runtimeModules.fastOperator.sha256],
    ["serve04", "XW Platform FastOperator 04", fixture.runtimeModules.fastOperator.sha256],
  ];
  return {
    schemaId: "xw.runtime.gate-f-task-owned-process-closure.v1",
    releaseId: tuple.release.releaseId,
    sourceCommit: tuple.release.sourceCommit,
    inspectedAt: "2030-01-01T00:00:10.000Z",
    rows: specs.map(([role, taskName, moduleSha256], index) => ({
      role,
      taskName,
      taskInstanceSha256: hash(`task-instance-${index}`),
      enginePid: 4000 + (index * 10),
      engineParentPid: 2000,
      engineCreatedAt: "2030-01-01T00:00:00.000Z",
      pid: 4001 + (index * 10),
      parentPid: 4000 + (index * 10),
      createdAt: "2030-01-01T00:00:01.000Z",
      moduleSha256,
      listenerIdentitySha256: hash(`listener-${index}`),
    })),
  };
}

function verifierDependencies(fixture, { releaseOk = true } = {}) {
  const tuple = fixture.tuple;
  return {
    releaseVerifier: () => ({ ok: releaseOk, mismatches: releaseOk ? [] : [{ kind: "sha256" }] }),
    identityVerifier: () => ({ ok: true }),
    providerInspector: () => ({
      path: tuple.runtimeBindings.provider.path,
      sha256: tuple.runtimeBindings.provider.sha256,
      providerBundleDigest: tuple.runtimeBindings.provider.providerBundleDigest,
    }),
    privateMaterialInspector: () => ({
      secretEnvironment: tuple.runtimeBindings.secretEnvironment,
      digestKeyring: tuple.runtimeBindings.digestKeyring,
    }),
    nodeInspector: () => tuple.trustedNode,
    taskInspector: (name) => ({
      name,
      principal: "SYSTEM",
      enabled: true,
      action: name === FORMAL_CONTROL_PLANE_TASK_NAME
        ? fixture.taskDefinition.action : fixture.activationTaskDefinitions[name].action,
    }),
    liveIdentityInspector: () => exactClosedLive(tuple),
    m6CatalogVerifier: () => ({ ok: true }),
    gateHandoffVerifier: () => ({ ok: true }),
    taskProcessClosureInspector: () => exactTaskOwnedProcessClosure(fixture),
    tcbAclController: { verify() {} },
  };
}

function materializeTargetPrepareFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-gate-target-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const releasesRoot = join(runtimeRoot, "releases");
  const activeRoot = join(releasesRoot, "xw-legacy-active");
  const releaseId = "xw-gate-target-b";
  const sourceCommit = "c".repeat(40);
  const releaseRoot = join(releasesRoot, releaseId);
  mkdirSync(activeRoot, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  const activeReleaseId = basename(activeRoot);
  const activeSourceCommit = "a".repeat(40);
  writeFileSync(join(activeRoot, "release-manifest.v1.json"), canonical({
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: activeReleaseId,
    sourceCommit: activeSourceCommit,
  }));
  const sourcePaths = [
    "config/runtime/xw-runtime.v1.json",
    "services/control-plane/ops/gate-f-cutover-operator.mjs",
    "services/control-plane/ops/launch-control-plane.ps1",
    "services/control-plane/scripts/xw-control-plane-runtime.ps1",
  ];
  for (const relativePath of sourcePaths) {
    const source = join(REPO_ROOT, ...relativePath.split("/"));
    const target = join(releaseRoot, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const manifest = {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit,
    sourceTreeSha: "d".repeat(40),
    runtimeProfile: "legacy_compat",
    nodeVersion: NODE_VERSION,
    npmVersion: null,
    services: {
      orchestrator: { path: "services/orchestrator", treeSha256: "1".repeat(64) },
      controlPlane: { path: "services/control-plane", treeSha256: "2".repeat(64) },
    },
    files: sourcePaths.sort().map((path) => ({
      path,
      gitMode: "100644",
      gitBlobOid: "3".repeat(40),
      sha256: hash(readFileSync(join(releaseRoot, ...path.split("/")))),
    })),
    runtimeCutoverAllowed: false,
  };
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  writeFileSync(manifestPath, canonical(manifest));
  const manifestSha256 = hash(readFileSync(manifestPath));
  const currentPath = join(runtimeRoot, "current");
  symlinkSync(activeRoot, currentPath, process.platform === "win32" ? "junction" : "dir");

  const liveM6Path = join(runtimeRoot, "config", "m6-c1-runtime.v1.json");
  const liveServe03Path = join(
    runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-03.json",
  );
  const liveServe04Path = join(
    runtimeRoot, "state", "control-plane", "fast-operator", "serve-launch-04.json",
  );
  for (const [path, bytes] of [
    [liveM6Path, Buffer.from("active-a-m6")],
    [liveServe03Path, Buffer.from("active-a-serve03")],
    [liveServe04Path, Buffer.from("active-a-serve04")],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const controlDbPath = join(runtimeRoot, "state", "control-plane", "control.db");
  const registryDbPath = join(runtimeRoot, "state", "orchestrator", "registry.db");
  mkdirSync(dirname(controlDbPath), { recursive: true });
  mkdirSync(dirname(registryDbPath), { recursive: true });
  writeFileSync(controlDbPath, "active-control-db");
  writeFileSync(registryDbPath, "active-registry-db");
  const fixtureHash = "4".repeat(64);
  const m6Final = canonical({
    schemaId: "xw.runtime.m6-c1-runtime.v1",
    releaseId,
    sourceCommit,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256: manifestSha256,
    dependencyRoot: join(runtimeRoot, "dependencies"),
    dependencyLayerHash: fixtureHash,
    modelProfileRoot: join(runtimeRoot, "model-profile"),
    modelProfileHash: fixtureHash,
    providerBaseUrl: "https://api.deepseek.com",
    manifestRoot: join(runtimeRoot, "manifests"),
    runtimeSnapshotPath: join(runtimeRoot, "state", "runtime-snapshot.json"),
    dshPersistenceRoot: join(runtimeRoot, "state", "dsh"),
    gateId: "gate-f-target-prepare",
    gateIssuerAllowlistPath: join(runtimeRoot, "config", "gate-issuers.json"),
    liveAuthorizationIssuerAllowlistPath: join(runtimeRoot, "config", "live-issuers.json"),
    gateFArtifactCatalogPath: join(runtimeRoot, "state", "gate-f-catalog.json"),
    gateFArtifactCatalogHash: fixtureHash,
    gateFArtifactCatalogSha256: fixtureHash,
    targetEnvironmentAttestationPath: join(runtimeRoot, "state", "target-attestation.json"),
    targetEnvironmentAttestationHash: fixtureHash,
    environmentQualificationPath: join(runtimeRoot, "state", "environment-qualification.json"),
    environmentQualificationSha256: fixtureHash,
    productionDependencyBindingPath: join(runtimeRoot, "state", "production-dependencies.json"),
    productionDependencyBindingHash: fixtureHash,
  });
  const serve = (alias) => canonical({
    schemaVersion: 2,
    runtimeRoot,
    nodeExe: TRUSTED_NODE_EXECUTABLE,
    releaseId,
    sourceCommit,
    deviceConfig: join(runtimeRoot, "secrets", "control-plane.devices.json"),
    alias,
  });
  const runtimeBindingBytes = {
    m6Final,
    serve03: serve("03"),
    serve04: serve("04"),
  };
  const providerPath = join(
    runtimeRoot, "state", "orchestrator", "xhs-exploration-vision-provider.v1.json",
  );
  mkdirSync(dirname(providerPath), { recursive: true });
  writeFileSync(providerPath, canonical({ schemaId: "fixture.provider.v1" }));
  const provider = {
    path: providerPath,
    sha256: hash(readFileSync(providerPath)),
    providerBundleDigest: "5".repeat(64),
  };
  const secretPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  const keyringPath = join(runtimeRoot, "secrets", "xhs-evidence-digest-keyring.v1.json");
  mkdirSync(dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, "fixture-secret");
  writeFileSync(keyringPath, "fixture-keyring");
  const privateMaterial = {
    secretEnvironment: {
      path: secretPath,
      sha256: hash(readFileSync(secretPath)),
      requiredEnvironment: ["FIXTURE"],
    },
    digestKeyring: {
      path: keyringPath,
      sha256: hash(readFileSync(keyringPath)),
      activeKeyId: "fixture",
      keyMaterial: "present",
    },
  };
  const systemTaskClosure = {
    windowsPowerShell: {
      path: WINDOWS_POWERSHELL_EXECUTABLE,
      sha256: hash(readFileSync(WINDOWS_POWERSHELL_EXECUTABLE)),
    },
    orchestratorLauncher: {
      path: join(runtimeRoot, "secrets", "launch-orchestrator.ps1"),
      sha256: null,
    },
    fastOperatorLauncher: {
      path: join(runtimeRoot, "launch-fast-operator-serve.ps1"),
      sha256: null,
    },
    deviceConfig: {
      path: join(runtimeRoot, "secrets", "control-plane.devices.json"),
      sha256: null,
    },
  };
  for (const key of ["orchestratorLauncher", "fastOperatorLauncher", "deviceConfig"]) {
    mkdirSync(dirname(systemTaskClosure[key].path), { recursive: true });
    writeFileSync(systemTaskClosure[key].path, `fixture-${key}`);
    systemTaskClosure[key].sha256 = hash(readFileSync(systemTaskClosure[key].path));
  }
  const snapshot = (filename, targetPath, bytes) => {
    const snapshotPath = join(runtimeRoot, "rollback-snapshots", "target-b", filename);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, bytes);
    return { targetPath, snapshotPath, snapshotSha256: hash(bytes) };
  };
  const snapshots = {
    controlDb: snapshot(
      "control.db", join(runtimeRoot, "state", "control-plane", "control.db"), Buffer.from("control-db"),
    ),
    registryDb: snapshot(
      "registry.db", join(runtimeRoot, "state", "orchestrator", "registry.db"), Buffer.from("registry-db"),
    ),
    privateMaterial: [
      snapshot("secret.json", secretPath, readFileSync(secretPath)),
      snapshot("keyring.json", keyringPath, readFileSync(keyringPath)),
    ],
  };
  const node = {
    path: TRUSTED_NODE_EXECUTABLE,
    version: NODE_VERSION,
    sha256: hash(readFileSync(TRUSTED_NODE_EXECUTABLE)),
  };
  return {
    runtimeRoot,
    releaseId,
    sourceCommit,
    releaseRoot,
    activeRoot,
    activeReleaseId,
    activeSourceCommit,
    currentPath,
    liveM6Path,
    liveServe03Path,
    liveServe04Path,
    controlDbPath,
    registryDbPath,
    runtimeBindingBytes,
    provider,
    privateMaterial,
    systemTaskClosure,
    snapshots,
    node,
  };
}

test("legacy task parser accepts only the native SYSTEM SID and default-enabled omission", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task>
  <Principals><Principal><UserId>S-1-5-18</UserId></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions><Exec>
    <Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>
    <Arguments>-NoProfile -File &quot;C:\\Users\\Public\\xw-runtime\\launch-control-plane.simple.ps1&quot;</Arguments>
    <WorkingDirectory>C:\\Users\\Public\\xw-runtime</WorkingDirectory>
  </Exec></Actions>
</Task>`;
  assert.deepEqual(parseLegacyTaskDefinition(xml), {
    principal: "SYSTEM",
    enabled: true,
    action: {
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      arguments: "-NoProfile -File \"C:\\Users\\Public\\xw-runtime\\launch-control-plane.simple.ps1\"",
      workingDirectory: "C:\\Users\\Public\\xw-runtime",
    },
  });
  assert.throws(() => parseFormalTaskDefinition(xml), { code: "GATE_F_CUTOVER_TASK_INVALID" });
  assert.equal(parseLegacyTaskDefinition(xml.replace("S-1-5-18", "S-1-5-19")).principal, "S-1-5-19");
  assert.equal(parseLegacyTaskDefinition(xml.replace(
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<Enabled>false</Enabled>",
  )).enabled, false);
  assert.throws(() => parseLegacyTaskDefinition(xml.replace(
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<Enabled>true</Enabled><Enabled>true</Enabled>",
  )), { code: "GATE_F_CUTOVER_TASK_INVALID" });
  assert.throws(() => parseLegacyTaskDefinition(xml.replace(
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
    "",
  )), { code: "GATE_F_CUTOVER_TASK_INVALID" });
});

test("tuple schema pins every rollback byte set, fixed identity, and tracked operator", () => {
  const runtimeRoot = join(tmpdir(), "xw-gate-cutover-shape");
  const { tuple } = makeTuple(runtimeRoot, "a");
  const validated = validateGateFCutoverTupleDocument(tuple, { expectedRuntimeRoot: runtimeRoot });
  assert.equal(validated.binding.releaseId, tuple.release.releaseId);
  assert.equal(validated.manifest.files[0].path, GATE_F_CUTOVER_OPERATOR_RELEASE_PATH);
  assert.equal(validated.taskDefinition.principal, "SYSTEM");
});

test("mutation matrix rejects release/current/operator/task/node/runtime/private/snapshot/live drift", () => {
  const runtimeRoot = join(tmpdir(), "xw-gate-cutover-mutations");
  const base = makeTuple(runtimeRoot, "a").tuple;
  const mutations = [
    (v) => { v.extra = true; },
    (v) => { v.release.sourceCommit = "b".repeat(40); },
    (v) => { v.current.target = join(runtimeRoot, "releases", "elsewhere"); },
    (v) => { v.operator.bytesBase64 = Buffer.from("replaced").toString("base64"); },
    (v) => { v.formal.task.principal = "INTERACTIVE"; },
    (v) => { v.formal.task.action.arguments += " -Injected"; },
    (v) => { v.activationTasks[1].action.arguments += " -Injected"; },
    (v) => { v.activationTasks[2].name = "XW Platform Attacker"; },
    (v) => { v.trustedNode.version = "24.11.2"; },
    (v) => { v.systemTaskClosure.fastOperatorLauncher.path = join(runtimeRoot, "attacker.ps1"); },
    (v) => { v.xhsV3PrivateRoots[0] = join(runtimeRoot, "public"); },
    (v) => { v.runtimeBindings.m6Final.bytesBase64 = Buffer.from("{}").toString("base64"); },
    (v) => { v.runtimeBindings.serve03.sha256 = "1".repeat(64); },
    (v) => { v.runtimeBindings.provider.providerBundleDigest = "2".repeat(64); },
    (v) => { v.runtimeBindings.secretEnvironment.sha256 = "3".repeat(64); },
    (v) => { v.runtimeBindings.digestKeyring.sha256 = "4".repeat(64); },
    (v) => { v.snapshots.controlDb.snapshotPath = join(runtimeRoot, "outside.db"); },
    (v) => { v.liveIdentity.controlPlane.url = "http://127.0.0.1:1/"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.throws(
      () => validateGateFCutoverTupleDocument(candidate, { expectedRuntimeRoot: runtimeRoot }),
      /GATE_F_/u,
    );
  }
});

test("full preflight verifies active current, formal artifacts, node version, identities and snapshots", async (t) => {
  const fixture = materializeFixture(t, "a");
  const result = await verifyGateFCutoverTuple({
    tuplePath: fixture.tuplePath,
    expectedTupleSha256: fixture.tupleSha256,
    expectedRuntimeRoot: fixture.runtimeRoot,
    requireActive: true,
    ...verifierDependencies(fixture),
  });
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.match(result.taskProcessClosure.closureSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(
    verifyGateFCutoverTuple({
      tuplePath: fixture.tuplePath,
      expectedTupleSha256: fixture.tupleSha256,
      expectedRuntimeRoot: fixture.runtimeRoot,
      ...verifierDependencies(fixture, { releaseOk: false }),
    }),
    /GATE_F_CUTOVER_RELEASE_DIRTY/u,
  );
});

test("manual exact-module processes fail the task-owned ancestry oracle", (t) => {
  const fixture = materializeFixture(t, "a");
  const manual = exactTaskOwnedProcessClosure(fixture);
  manual.rows[0].parentPid = 9999;
  assert.throws(
    () => normalizeGateFTaskOwnedProcessClosure(manual, { tuple: fixture.tuple }),
    /GATE_F_TASK_PROCESS_OWNERSHIP_INVALID/u,
  );
});

test("real signed Gate/SQLite rollback then A -> B -> A -> B stay triple-consistent", (t) => {
  const runtimeRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "xw-gate-real-handoff-")));
  let state = null;
  t.after(() => {
    try { state?.close(); } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
  const nowMs = Date.now();
  const at = (offsetMs) => new Date(nowMs + offsetMs).toISOString();
  const timeline = {
    rootIssuedAt: at(-5_000),
    closeoutCommittedAt: at(-4_000),
    closedIssuedAt: at(-3_000),
    promotedAt: at(-2_000),
    expiresAt: at(24 * 60 * 60 * 1_000),
  };
  const actor = "operator:gate-f-cutover-test";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerAllowlistPath = join(runtimeRoot, "m6-gate", "issuer-keys.json");
  mkdirSync(dirname(issuerAllowlistPath), { recursive: true });
  writeFileSync(issuerAllowlistPath, canonical({
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "gate-f-cutover-test-key",
      subject: actor,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  }));
  const gates = {
    a: buildSignedClosedGatePackage({
      runtimeRoot,
      releaseId: "xw-gate-a",
      sourceCommit: "a".repeat(40),
      actor,
      privateKey,
      issuerAllowlistPath,
      nowMs,
      timeline,
    }),
    b: buildSignedClosedGatePackage({
      runtimeRoot,
      releaseId: "xw-gate-b",
      sourceCommit: "b".repeat(40),
      actor,
      privateKey,
      issuerAllowlistPath,
      nowMs,
      timeline,
    }),
  };
  const dbPath = join(runtimeRoot, "state", "control-plane", "control.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  state = new StateStore({
    dbPath,
    now: () => nowMs,
    m6RuntimeMode: "QUALIFICATION_ONLY",
  });
  state.seedM6QualificationBootstrapFence({
    epoch: gates.a.closedEpoch,
    locksHash: gates.a.locksHash,
  });
  writeImmutableJson(gates.a.paths.current, gates.a.pointer);

  const prove = (gate) => {
    if (!existsSync(gate.paths.current)) writeImmutableJson(gate.paths.current, gate.pointer);
    const loaded = loadM6Gate({
      m6Root: runtimeRoot,
      gateId: gate.closedEpoch.gateId,
      issuerAllowlistPath,
      requireLocks: true,
    });
    assert.doesNotThrow(() => assertM6FileDbPointerConsistency({
      loaded,
      fence: state.getM6GateFence(),
      pointer: loaded.currentPointer,
    }));
  };
  prove(gates.a);
  const closeState = () => {
    state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    state.close();
    state = null;
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);
  };
  const reopenState = () => {
    state = new StateStore({
      dbPath,
      now: () => nowMs,
      m6RuntimeMode: "QUALIFICATION_ONLY",
    });
  };
  closeState();
  const exactSourceDb = readFileSync(dbPath);
  const exactSourceDbSha256 = hash(exactSourceDb);
  reopenState();
  state.handoffM6ClosedFenceForCutover({
    expectedFence: state.getM6GateFence(),
    nextEpoch: gates.b.closedEpoch,
    locksHash: gates.b.locksHash,
    packageHash: gates.b.package.packageHash,
  });
  prove(gates.b);
  // Model an activation/postflight fault: rollback must restore the exact stopped A bytes,
  // after which the old A file/DB/pointer triple is valid again.
  closeState();
  writeFileSync(dbPath, exactSourceDb);
  assert.equal(hash(readFileSync(dbPath)), exactSourceDbSha256);
  reopenState();
  prove(gates.a);

  for (const target of [gates.b, gates.a, gates.b]) {
    const handoff = state.handoffM6ClosedFenceForCutover({
      expectedFence: state.getM6GateFence(),
      nextEpoch: target.closedEpoch,
      locksHash: target.locksHash,
      packageHash: target.package.packageHash,
    });
    assert.ok(Object.values(handoff.resourceCounts).every((count) => count === 0));
    assert.ok(Object.values(handoff.durableResidue).every((count) => count === 0));
    prove(target);
  }
  assert.equal(state.getM6GateFence().releaseId, "xw-gate-b");
});

test("legacy bootstrap installs a real transformed SQLite fence before publishing the signed target pointer", async (t) => {
  const runtimeRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "xw-gate-real-legacy-bootstrap-")));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const nowMs = Date.now();
  const at = (offsetMs) => new Date(nowMs + offsetMs).toISOString();
  const timeline = {
    rootIssuedAt: at(-5_000),
    closeoutCommittedAt: at(-4_000),
    closedIssuedAt: at(-3_000),
    promotedAt: at(-2_000),
    expiresAt: at(24 * 60 * 60 * 1_000),
  };
  const actor = "operator:gate-f-legacy-bootstrap-test";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuerAllowlistPath = join(runtimeRoot, "m6-gate", "issuer-keys.json");
  mkdirSync(dirname(issuerAllowlistPath), { recursive: true });
  writeFileSync(issuerAllowlistPath, canonical({
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 1,
    keys: [{
      keyId: "gate-f-cutover-test-key",
      subject: actor,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  }));
  const signed = {
    a: buildSignedClosedGatePackage({
      runtimeRoot,
      releaseId: "xw-gate-a",
      sourceCommit: "a".repeat(40),
      actor,
      privateKey,
      issuerAllowlistPath,
      nowMs,
      timeline,
    }),
    b: buildSignedClosedGatePackage({
      runtimeRoot,
      releaseId: "xw-gate-b",
      sourceCommit: "b".repeat(40),
      actor,
      privateKey,
      issuerAllowlistPath,
      nowMs,
      timeline,
    }),
  };
  writeImmutableJson(signed.a.paths.current, signed.a.pointer);

  const sourceFixture = makeTuple(runtimeRoot, "a");
  const targetFixture = makeTuple(runtimeRoot, "b");
  const sourceTuple = sourceFixture.tuple;
  const targetTuple = targetFixture.tuple;
  const targetPackagePath = join(
    runtimeRoot,
    "m6-audit",
    `m6-c1-qualification-bootstrap-${targetTuple.release.sourceCommit.slice(0, 7)}`,
    "packages",
    `${signed.b.package.packageHash}.package.json`,
  );
  mkdirSync(dirname(targetPackagePath), { recursive: true });
  writeFileSync(targetPackagePath, canonical(signed.b.package));
  targetTuple.gateHandoff = {
    schemaId: GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID,
    gateId: signed.b.package.gateId,
    packageHash: signed.b.package.packageHash,
    package: {
      path: targetPackagePath,
      sha256: hash(readFileSync(targetPackagePath)),
    },
    closedEpochHash: signed.b.closedEpoch.epochHash,
    locksHash: signed.b.locksHash,
    pointer: jsonArtifact(signed.b.paths.current, signed.b.pointer),
  };

  writeArtifact(sourceTuple.release.manifest);
  writeArtifact(targetTuple.operator);
  const currentPath = join(runtimeRoot, "current");
  symlinkSync(sourceTuple.release.root, currentPath, process.platform === "win32" ? "junction" : "dir");
  const controlDbPath = join(runtimeRoot, "state", "control-plane", "control.db");
  mkdirSync(dirname(controlDbPath), { recursive: true });
  const sourceState = new StateStore({
    dbPath: controlDbPath,
    now: () => nowMs,
    m6RuntimeMode: "QUALIFICATION_ONLY",
  });
  sourceState.seedM6QualificationBootstrapFence({
    epoch: signed.a.closedEpoch,
    locksHash: signed.a.locksHash,
  });
  sourceState.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  sourceState.close();
  const registryDbPath = join(runtimeRoot, "state", "orchestrator", "registry.db");
  mkdirSync(dirname(registryDbPath), { recursive: true });
  const registry = new DatabaseSync(registryDbPath);
  registry.exec("CREATE TABLE fixture_registry (id TEXT PRIMARY KEY); INSERT INTO fixture_registry VALUES ('legacy');");
  registry.close();
  for (const [path, bytes] of [
    [sourceTuple.runtimeBindings.secretEnvironment.path, sourceFixture.snapshotBytes["secret.snapshot.json"]],
    [sourceTuple.runtimeBindings.digestKeyring.path, sourceFixture.snapshotBytes["keyring.snapshot.json"]],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const tcbAclController = { protect() {}, verify() {} };
  const captured = await captureFixedGateFRollbackSnapshots({
    runtimeRoot,
    liveIdentityInspector: () => exactClosedLive(sourceTuple),
    tcbAclController,
  });
  const sourceTasks = [sourceTuple.formal.task, ...sourceTuple.activationTasks].map((task, index) => {
    const bytes = Buffer.from(task.xml.bytesBase64, "base64");
    const filename = index === 0 ? FORMAL_TASK_XML_FILENAME : gateFAuxiliaryTaskFilename(task.name);
    return {
      ...task,
      xml: artifact(join(runtimeRoot, "legacy-task-bindings", hash(bytes), filename), bytes),
    };
  });
  const legacyPrestate = {
    schemaId: GATE_F_LEGACY_PRESTATE_SCHEMA_ID,
    runtimeRoot,
    current: {
      path: currentPath,
      target: sourceTuple.release.root,
      releaseId: sourceTuple.release.releaseId,
      sourceCommit: sourceTuple.release.sourceCommit,
    },
    releaseManifest: sourceTuple.release.manifest,
    tasks: sourceTasks,
    trustedNode: sourceTuple.trustedNode,
    systemTaskClosure: sourceTuple.systemTaskClosure,
    runtimeBindings: sourceTuple.runtimeBindings,
    liveIdentity: sourceTuple.liveIdentity,
    snapshots: captured.snapshots,
  };
  const legacyBytes = canonical(legacyPrestate);
  const legacyHash = hash(legacyBytes);
  const legacyPath = join(
    runtimeRoot,
    "legacy-prestates",
    legacyHash,
    "gate-f-legacy-prestate.v1.json",
  );
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, legacyBytes);
  const targetAddress = materializeGateFCutoverTuple({
    runtimeRoot,
    tuple: targetTuple,
    tcbAclController,
  });
  const authorization = authorizeGateFLegacyBootstrap({
    runtimeRoot,
    legacyPrestateSha256: legacyHash,
    toTupleSha256: targetAddress.tupleSha256,
    expectedCurrentAuthorizationSha256: null,
    tcbAclController,
  });

  let running = true;
  const adapter = {
    async captureTargetDigest(ref) { return hash(readFileSync(ref.targetPath)); },
    async proveTargetDigest(ref, expected) { assert.equal(hash(readFileSync(ref.targetPath)), expected); },
    async stop() { running = false; },
    async writeRuntimeBinding(value) {
      mkdirSync(dirname(value.path), { recursive: true });
      writeFileSync(value.path, Buffer.from(value.bytesBase64, "base64"));
    },
    async restoreSnapshot(ref) {
      if (existsSync(`${ref.targetPath}-wal`)) throw Object.assign(new Error("WAL present"), { code: "FIXTURE_WAL_PRESENT" });
      if (existsSync(`${ref.targetPath}-shm`)) throw Object.assign(new Error("SHM present"), { code: "FIXTURE_SHM_PRESENT" });
      mkdirSync(dirname(ref.targetPath), { recursive: true });
      copyFileSync(ref.snapshotPath, ref.targetPath);
    },
    async switchCurrent(target) {
      unlinkSync(currentPath);
      symlinkSync(target, currentPath, process.platform === "win32" ? "junction" : "dir");
    },
    async registerTask() {},
    async start() { running = true; },
  };
  const proveTriple = (gate) => {
    const state = new StateStore({
      dbPath: controlDbPath,
      now: () => nowMs,
      m6RuntimeMode: "QUALIFICATION_ONLY",
    });
    try {
      const loaded = loadM6Gate({
        m6Root: runtimeRoot,
        gateId: gate.package.gateId,
        issuerAllowlistPath,
        requireLocks: true,
      });
      assert.doesNotThrow(() => assertM6FileDbPointerConsistency({
        loaded,
        fence: state.getM6GateFence(),
        pointer: loaded.currentPointer,
      }));
    } finally {
      state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      state.close();
    }
  };
  const legacyVerifier = async ({ requireActive }) => {
    assert.equal(requireActive, true);
    assert.equal(running, true);
    assert.equal(realpathSync(currentPath), sourceTuple.release.root);
    proveTriple(signed.a);
    return {
      ok: true,
      prestate: legacyPrestate,
      prestateSha256: legacyHash,
      releaseId: sourceTuple.release.releaseId,
      sourceCommit: sourceTuple.release.sourceCommit,
      active: true,
    };
  };
  let failTargetPostflight = true;
  const tupleVerifier = async ({ expectedTupleSha256, requireActive }) => {
    assert.equal(expectedTupleSha256, targetAddress.tupleSha256);
    if (requireActive) {
      assert.equal(running, true);
      assert.equal(realpathSync(currentPath), targetTuple.release.root);
      proveTriple(signed.b);
      if (failTargetPostflight) {
        failTargetPostflight = false;
        throw Object.assign(new Error("injected postflight fault"), {
          code: "FIXTURE_REAL_POSTFLIGHT_FAULT",
        });
      }
    }
    return {
      ok: true,
      tuple: targetTuple,
      tupleSha256: targetAddress.tupleSha256,
      releaseId: targetTuple.release.releaseId,
      sourceCommit: targetTuple.release.sourceCommit,
      active: requireActive,
      taskProcessClosure: requireActive ? { closureSha256: hash("real-legacy-bootstrap-closure") } : null,
    };
  };
  const input = {
    authorizationPath: authorization.path,
    runtimeRoot,
    adapter,
    legacyVerifier,
    tupleVerifier,
    handoffDependencies: { stoppedGuard: () => {}, now: () => nowMs },
    executingOperatorPath: targetTuple.operator.path,
    tcbAclController,
  };
  await assert.rejects(executeLegacyGateFBootstrap(input), (error) => {
    assert.equal(error.code, "GATE_F_LEGACY_BOOTSTRAP_ROLLED_BACK");
    assert.equal(error.causeCode, "FIXTURE_REAL_POSTFLIGHT_FAULT");
    assert.equal(error.receipt.rollback.verified, true);
    return true;
  });
  assert.equal(realpathSync(currentPath), sourceTuple.release.root);
  proveTriple(signed.a);
  const receipt = await executeLegacyGateFBootstrap(input);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.applied.slice(0, 3), [
    "fixedTasksStopped",
    "crossReleaseHandoffPrepared",
    "m6Final",
  ]);
  assert.ok(receipt.applied.indexOf("controlDbFence") < receipt.applied.indexOf("gatePointer"));
  assert.ok(receipt.applied.indexOf("gatePointer") < receipt.applied.indexOf("current"));
  assert.equal(receipt.crossReleaseHandoff.packageHash, signed.b.package.packageHash);
  assert.equal(receipt.crossReleaseHandoff.packageSha256, hash(readFileSync(targetPackagePath)));
  assert.match(receipt.crossReleaseHandoff.targetControlDbSha256, /^[0-9a-f]{64}$/u);
  proveTriple(signed.b);
});

test("target preparation builds staged bindings, four task artifacts and tuple without switching current or live slots", async (t) => {
  const fixture = materializeTargetPrepareFixture(t);
  const before = {
    current: realpathSync(fixture.currentPath),
    m6: readFileSync(fixture.liveM6Path),
    serve03: readFileSync(fixture.liveServe03Path),
    serve04: readFileSync(fixture.liveServe04Path),
    controlDb: readFileSync(fixture.controlDbPath),
    registryDb: readFileSync(fixture.registryDbPath),
    secret: readFileSync(fixture.privateMaterial.secretEnvironment.path),
    keyring: readFileSync(fixture.privateMaterial.digestKeyring.path),
  };
  const tcb = { protect() {}, verify() {} };
  rmSync(join(fixture.runtimeRoot, "rollback-snapshots"), { recursive: true, force: true });
  const assemblerRoot = join(
    fixture.runtimeRoot,
    "cutover-m6-assembler",
    fixture.releaseId,
    fixture.sourceCommit,
  );
  const assemblerM6Path = join(assemblerRoot, "config", "m6-c1-runtime.v1.json");
  mkdirSync(dirname(assemblerM6Path), { recursive: true });
  writeFileSync(assemblerM6Path, fixture.runtimeBindingBytes.m6Final);
  const receiptBody = {
    schemaId: "xw.m6-4-production-release-assembler-receipt.v1",
    release: {
      releaseId: fixture.releaseId,
      sourceCommit: fixture.sourceCommit,
      manifestPath: join(fixture.releaseRoot, "release-manifest.v1.json"),
      manifestSha256: hash(readFileSync(join(fixture.releaseRoot, "release-manifest.v1.json"))),
      capabilityId: "m6.grounded-run",
      implementationClosureHash: "6".repeat(64),
      tcbManifestRef: "fixture-tcb",
    },
    inventories: [],
    artifactCatalog: {},
    productionDependencyBinding: {},
    runtimeBinding: { path: assemblerM6Path, sha256: hash(fixture.runtimeBindingBytes.m6Final) },
    publicationDurability: {},
    privateKeyMaterialRead: false,
    secretMaterialPresent: false,
    signatureGenerated: false,
  };
  const receiptHash = hash(
    `xw.m6-4-production-release-assembler-receipt.v1:${domainCanonicalJson(receiptBody)}`,
  );
  const receiptPath = join(assemblerRoot, "receipts", `${receiptHash}.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, canonical({ ...receiptBody, receiptHash }));
  const qualificationPackageHash = hash("fixture-qualification-package");
  const closedEpochHash = hash("fixture-closed-epoch");
  const staged = await stageGateFTargetCandidateFromFixedAssembler({
    runtimeRoot: fixture.runtimeRoot,
    expectedReleaseId: fixture.releaseId,
    expectedSourceCommit: fixture.sourceCommit,
    assemblerReceiptHash: receiptHash,
    qualificationPackageHash,
    gateTargetPreparer: ({ expectedGateId }) => ({
      schemaId: GATE_F_CROSS_RELEASE_TARGET_SCHEMA_ID,
      gateId: expectedGateId,
      packageHash: qualificationPackageHash,
      package: {
        path: join(
          fixture.runtimeRoot,
          "m6-audit",
          `m6-c1-qualification-bootstrap-${fixture.sourceCommit.slice(0, 7)}`,
          "packages",
          `${qualificationPackageHash}.package.json`,
        ),
        sha256: hash("fixture-qualification-package-bytes"),
      },
      closedEpochHash,
      locksHash: hash("fixture-locks"),
      pointer: jsonArtifact(
        join(fixture.runtimeRoot, "m6-gate", expectedGateId, "current.json"),
        {
          chain: [hash("fixture-root-epoch"), closedEpochHash],
          tailEpochHash: closedEpochHash,
          generation: 0,
          promotedAt: "2030-01-01T00:00:00.000Z",
        },
      ),
    }),
    snapshotDependencies: {
      databaseSnapshotter: async (path) => Buffer.from(readFileSync(path)),
      liveIdentityInspector: () => exactClosedLive({
        release: {
          releaseId: fixture.activeReleaseId,
          sourceCommit: fixture.activeSourceCommit,
        },
      }),
    },
    tcbAclController: tcb,
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.snapshotSource.releaseId, fixture.activeReleaseId);
  assert.ok(existsSync(staged.candidate.value.snapshots.controlDb.snapshotPath));
  let releaseChecks = 0;
  const prepared = await prepareGateFCutoverTargetFromFixedCandidate({
    runtimeRoot: fixture.runtimeRoot,
    expectedReleaseId: fixture.releaseId,
    expectedSourceCommit: fixture.sourceCommit,
    providerConfigInspector: () => fixture.provider,
    privateMaterialInspector: () => fixture.privateMaterial,
    nodeInspector: () => fixture.node,
    systemTaskClosureInspector: () => fixture.systemTaskClosure,
    releaseVerifier: ({ root }) => {
      releaseChecks += 1;
      assert.equal(root, fixture.releaseRoot);
      return { ok: true, mismatches: [] };
    },
    m6CatalogVerifier: () => ({ ok: true }),
    gateHandoffVerifier: () => ({ ok: true }),
    tcbAclController: tcb,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.verified, true);
  assert.equal(prepared.launcherIdentity.active, false);
  assert.ok(releaseChecks >= 2);
  assert.equal(realpathSync(fixture.currentPath), before.current);
  assert.ok(readFileSync(fixture.liveM6Path).equals(before.m6));
  assert.ok(readFileSync(fixture.liveServe03Path).equals(before.serve03));
  assert.ok(readFileSync(fixture.liveServe04Path).equals(before.serve04));
  assert.ok(readFileSync(fixture.controlDbPath).equals(before.controlDb));
  assert.ok(readFileSync(fixture.registryDbPath).equals(before.registryDb));
  assert.ok(readFileSync(fixture.privateMaterial.secretEnvironment.path).equals(before.secret));
  assert.ok(readFileSync(fixture.privateMaterial.digestKeyring.path).equals(before.keyring));
  assert.equal(prepared.tuple.activationTasks.length, 3);
  assert.equal(
    prepared.tuple.runtimeBindings.m6Final.path,
    fixture.liveM6Path,
  );
  assert.equal(
    prepared.tuple.runtimeBindings.m6Final.sha256,
    hash(fixture.runtimeBindingBytes.m6Final),
  );
  assert.notEqual(prepared.preparedRuntimeBindings.m6Final.path, fixture.liveM6Path);
  assert.ok(existsSync(prepared.tuplePath));
  assert.ok(existsSync(prepared.targetReference.path));
  for (const task of [prepared.tuple.formal.task, ...prepared.tuple.activationTasks]) {
    assert.ok(existsSync(task.xml.path));
  }
  assert.equal(prepared.tuple.xhsV3PrivateRoots.length, 5);
  assert.ok(prepared.tuple.xhsV3PrivateRoots.every((path) => existsSync(path)));
});

test("legacy prestate capture pins clean release, all task XML, live slots, snapshots and active identity", async (t) => {
  const fixture = materializeFixture(t, "a");
  const tuple = fixture.tuple;
  const taskXmlByName = new Map([
    [tuple.formal.task.name, Buffer.from(tuple.formal.task.xml.bytesBase64, "base64").toString("utf8")],
    ...tuple.activationTasks.map((task) => [
      task.name,
      Buffer.from(task.xml.bytesBase64, "base64").toString("utf8"),
    ]),
  ]);
  const dependencies = verifierDependencies(fixture);
  const captured = await captureGateFLegacyPrestate({
    runtimeRoot: fixture.runtimeRoot,
    snapshots: tuple.snapshots,
    releaseVerifier: dependencies.releaseVerifier,
    providerInspector: dependencies.providerInspector,
    privateMaterialInspector: dependencies.privateMaterialInspector,
    nodeInspector: dependencies.nodeInspector,
    taskXmlInspector: (name) => taskXmlByName.get(name),
    liveIdentityInspector: dependencies.liveIdentityInspector,
    tcbAclController: { protect() {}, verify() {} },
  });
  assert.equal(captured.ok, true);
  assert.equal(captured.prestate.tasks.length, 4);
  assert.ok(existsSync(captured.legacyReference.path));
  const verified = await verifyGateFLegacyPrestate({
    prestatePath: captured.prestatePath,
    expectedPrestateSha256: captured.prestateSha256,
    expectedRuntimeRoot: fixture.runtimeRoot,
    requireActive: true,
    releaseVerifier: dependencies.releaseVerifier,
    providerInspector: dependencies.providerInspector,
    privateMaterialInspector: dependencies.privateMaterialInspector,
    nodeInspector: dependencies.nodeInspector,
    taskInspector: dependencies.taskInspector,
    liveIdentityInspector: dependencies.liveIdentityInspector,
    tcbAclController: { verify() {} },
  });
  assert.equal(verified.active, true);
  const bytes = readFileSync(captured.prestatePath);
  bytes[bytes.length - 2] ^= 1;
  writeFileSync(captured.prestatePath, bytes);
  await assert.rejects(
    verifyGateFLegacyPrestate({
      prestatePath: captured.prestatePath,
      expectedPrestateSha256: captured.prestateSha256,
      expectedRuntimeRoot: fixture.runtimeRoot,
      ...dependencies,
    }),
    /GATE_F_LEGACY_PRESTATE_INVALID/u,
  );
});

function tupleHash(tuple) {
  return hash(canonical(tuple));
}

function writeTransition(runtimeRoot, from, to) {
  const transitionPath = join(runtimeRoot, "cutover", "authorized-transition.v1.json");
  mkdirSync(dirname(transitionPath), { recursive: true });
  writeFileSync(transitionPath, canonical({
    schemaId: GATE_F_CUTOVER_TRANSITION_SCHEMA_ID,
    intent: "GATE_F_RELEASE_CUTOVER",
    from: {
      path: join(runtimeRoot, "cutover-tuples", from.hash, "gate-f-cutover-tuple.v1.json"),
      sha256: from.hash,
    },
    to: {
      path: join(runtimeRoot, "cutover-tuples", to.hash, "gate-f-cutover-tuple.v1.json"),
      sha256: to.hash,
    },
  }));
  return transitionPath;
}

function writeAddressedDocument(runtimeRoot, namespace, digest, filename, value) {
  const path = join(runtimeRoot, namespace, digest, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonical(value));
  return path;
}

function legacyStateFromTuple(tuple) {
  return {
    runtimeRoot: tuple.runtimeRoot,
    current: {
      ...tuple.current,
      releaseId: tuple.release.releaseId,
      sourceCommit: tuple.release.sourceCommit,
    },
    runtimeBindings: tuple.runtimeBindings,
    trustedNode: tuple.trustedNode,
    systemTaskClosure: tuple.systemTaskClosure,
    snapshots: tuple.snapshots,
    tasks: [tuple.formal.task, ...tuple.activationTasks],
  };
}

function transactionHarness(t) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-gate-transaction-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const a = { tuple: makeTuple(runtimeRoot, "a").tuple };
  const b = { tuple: makeTuple(runtimeRoot, "b").tuple };
  a.hash = tupleHash(a.tuple);
  b.hash = tupleHash(b.tuple);
  const byHash = new Map([[a.hash, a], [b.hash, b]]);
  const state = {
    target: a.tuple.current.target,
    m6: a.tuple.runtimeBindings.m6Final.sha256,
    serve03: a.tuple.runtimeBindings.serve03.sha256,
    serve04: a.tuple.runtimeBindings.serve04.sha256,
    tasks: Object.fromEntries([
      a.tuple.formal.task,
      ...a.tuple.activationTasks,
    ].map((task) => [task.name, task.xml.sha256])),
    running: true,
  };
  const calls = [];
  const adapter = {
    async captureTargetDigest(ref) { return `digest:${ref.targetPath}`; },
    async proveTargetDigest(ref, expected) {
      calls.push(`prove:${basename(ref.targetPath)}`);
      assert.equal(expected, `digest:${ref.targetPath}`);
    },
    async restoreSnapshot(ref) { calls.push(`restore:${basename(ref.targetPath)}`); },
    async stop() { calls.push("stop"); state.running = false; },
    async writeRuntimeBinding(value) {
      const key = value.path.endsWith("m6-c1-runtime.v1.json") ? "m6"
        : value.path.endsWith("serve-launch-03.json") ? "serve03" : "serve04";
      calls.push(`write:${key}:${basename(dirname(value.path))}`);
      state[key] = value.sha256;
    },
    async switchCurrent(target) { calls.push(`current:${basename(target)}`); state.target = target; },
    async registerTask(task) {
      calls.push(`task:${task.name}:${task.xml.sha256.slice(0, 8)}`);
      state.tasks[task.name] = task.xml.sha256;
    },
    async start() { calls.push("start"); state.running = true; },
  };
  let failActiveHash = null;
  const tupleVerifier = async ({ expectedTupleSha256, requireActive }) => {
    const row = byHash.get(expectedTupleSha256);
    assert.ok(row, "known content-addressed tuple");
    if (requireActive) {
      const tuple = row.tuple;
      assert.equal(state.target, tuple.current.target);
      assert.equal(state.m6, tuple.runtimeBindings.m6Final.sha256);
      assert.equal(state.serve03, tuple.runtimeBindings.serve03.sha256);
      assert.equal(state.serve04, tuple.runtimeBindings.serve04.sha256);
      for (const task of [tuple.formal.task, ...tuple.activationTasks]) {
        assert.equal(state.tasks[task.name], task.xml.sha256);
      }
      assert.equal(state.running, true);
      if (failActiveHash === expectedTupleSha256) {
        failActiveHash = null;
        throw Object.assign(new Error("postflight fault"), { code: "FIXTURE_POSTFLIGHT_FAULT" });
      }
    }
    return {
      ok: true,
      tuple: row.tuple,
      tupleSha256: expectedTupleSha256,
      releaseId: row.tuple.release.releaseId,
      sourceCommit: row.tuple.release.sourceCommit,
      active: requireActive,
      taskProcessClosure: requireActive
        ? { closureSha256: hash(`task-process-closure:${expectedTupleSha256}`) }
        : null,
    };
  };
  const handoffBuilder = async ({ fromTuple = null, fromLegacyPrestate = null, toTuple }) => {
    const source = fromTuple?.release ?? fromLegacyPrestate.current;
    const receiptHash = hash(
      `handoff:${source.releaseId}:${toTuple.release.releaseId}`,
    );
    return {
      receipt: {
        receiptHash,
        packageHash: toTuple.gateHandoff.packageHash,
        packageSha256: toTuple.gateHandoff.package.sha256,
      },
      receiptPath: join(runtimeRoot, "cutover-handoffs", `${receiptHash}.json`),
      sourceSnapshots: fromTuple?.snapshots ?? fromLegacyPrestate.snapshots,
      targetSnapshot: toTuple.snapshots.controlDb,
      targetPointer: toTuple.gateHandoff.pointer,
    };
  };
  const cutoverDependencies = {
    handoffBuilder,
    handoffPointerPublisher: () => ({ ok: true }),
  };
  return {
    runtimeRoot, a, b, state, calls, adapter, tupleVerifier, cutoverDependencies,
    failNextActive(row) { failActiveHash = row.hash; },
  };
}

test("A -> B, B -> A, and A -> B commit the complete exact tuple", async (t) => {
  const h = transactionHarness(t);
  let transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  const forward = await executeGateFCutover({
    transitionPath,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    tupleVerifier: h.tupleVerifier,
    ...h.cutoverDependencies,
    tcbAclController: { verify() {} },
  });
  assert.equal(forward.ok, true);
  assert.equal(forward.fromReleaseId, "xw-gate-a");
  assert.equal(forward.toReleaseId, "xw-gate-b");
  transitionPath = writeTransition(h.runtimeRoot, h.b, h.a);
  const reverse = await executeGateFCutover({
    transitionPath,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    tupleVerifier: h.tupleVerifier,
    ...h.cutoverDependencies,
    tcbAclController: { verify() {} },
  });
  assert.equal(reverse.ok, true);
  assert.equal(reverse.toReleaseId, "xw-gate-a");
  assert.equal(h.state.target, h.a.tuple.current.target);
  transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  const reforward = await executeGateFCutover({
    transitionPath,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    tupleVerifier: h.tupleVerifier,
    ...h.cutoverDependencies,
    tcbAclController: { verify() {} },
  });
  assert.equal(reforward.toReleaseId, "xw-gate-b");
  assert.equal(h.state.target, h.b.tuple.current.target);
});

test("failed A -> B uses all-settled rollback, proves A, then re-forwards to B", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  h.failNextActive(h.b);
  let failure;
  try {
    await executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      tcbAclController: { verify() {} },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "GATE_F_CUTOVER_APPLY_ROLLED_BACK");
  assert.equal(failure.receipt.rollback.verified, true);
  assert.deepEqual(
    failure.receipt.rollback.restore.map((row) => [row.component, row.status]),
    [
      ["m6Final", "fulfilled"],
      ["serve03", "fulfilled"],
      ["serve04", "fulfilled"],
      ["current", "fulfilled"],
      ["task:XW Platform Control Plane", "fulfilled"],
      ["task:XW Platform Orchestrator", "fulfilled"],
      ["task:XW Platform FastOperator 03", "fulfilled"],
      ["task:XW Platform FastOperator 04", "fulfilled"],
      ["restore:snapshot:0", "fulfilled"],
      ["restore:snapshot:1", "fulfilled"],
      ["restore:snapshot:2", "fulfilled"],
      ["restore:snapshot:3", "fulfilled"],
    ],
  );
  assert.equal(h.state.target, h.a.tuple.current.target);
  const reforward = await executeGateFCutover({
    transitionPath,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    tupleVerifier: h.tupleVerifier,
    ...h.cutoverDependencies,
    tcbAclController: { verify() {} },
  });
  assert.equal(reforward.ok, true);
  assert.equal(h.state.target, h.b.tuple.current.target);
});

test("A -> B rolls back when active health lacks task-owned process ancestry", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  const tupleVerifier = async (input) => {
    const verified = await h.tupleVerifier(input);
    if (input.requireActive && input.expectedTupleSha256 === h.b.hash) {
      return { ...verified, taskProcessClosure: null };
    }
    return verified;
  };
  await assert.rejects(executeGateFCutover({
    transitionPath,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    tupleVerifier,
    ...h.cutoverDependencies,
    tcbAclController: { verify() {} },
  }), (error) => {
    assert.equal(error.code, "GATE_F_CUTOVER_APPLY_ROLLED_BACK");
    assert.equal(error.causeCode, "GATE_F_TASK_PROCESS_OWNERSHIP_INVALID");
    assert.equal(error.receipt.rollback.verified, true);
    return true;
  });
  assert.equal(h.state.target, h.a.tuple.current.target);
});

test("legacy bootstrap is authorized by pinned prestate and target operator, rolls back, then re-forwards", async (t) => {
  const h = transactionHarness(t);
  const legacyPrestate = legacyStateFromTuple(h.a.tuple);
  const legacyDocument = { fixture: "captured-legacy-prestate", releaseId: h.a.tuple.release.releaseId };
  const legacyHash = hash(canonical(legacyDocument));
  const legacyPath = writeAddressedDocument(
    h.runtimeRoot,
    "legacy-prestates",
    legacyHash,
    "gate-f-legacy-prestate.v1.json",
    legacyDocument,
  );
  writeAddressedDocument(
    h.runtimeRoot,
    "cutover-tuples",
    h.b.hash,
    "gate-f-cutover-tuple.v1.json",
    h.b.tuple,
  );
  writeArtifact(h.a.tuple.operator);
  writeArtifact(h.b.tuple.operator);
  const authorization = authorizeGateFLegacyBootstrap({
    runtimeRoot: h.runtimeRoot,
    legacyPrestateSha256: legacyHash,
    toTupleSha256: h.b.hash,
    expectedCurrentAuthorizationSha256: null,
    tcbAclController: { protect() {}, verify() {} },
  });
  const legacyVerifier = async ({ expectedPrestateSha256, prestatePath, requireActive }) => {
    assert.equal(expectedPrestateSha256, legacyHash);
    assert.equal(prestatePath, legacyPath);
    assert.equal(hash(readFileSync(prestatePath)), legacyHash);
    if (requireActive) {
      assert.equal(h.state.target, h.a.tuple.current.target);
      assert.equal(h.state.running, true);
    }
    return {
      ok: true,
      prestate: legacyPrestate,
      prestateSha256: legacyHash,
      releaseId: h.a.tuple.release.releaseId,
      sourceCommit: h.a.tuple.release.sourceCommit,
      active: requireActive,
    };
  };
  await assert.rejects(
    executeLegacyGateFBootstrap({
      authorizationPath: authorization.path,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      legacyVerifier,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      executingOperatorPath: h.a.tuple.operator.path,
      tcbAclController: { verify() {} },
    }),
    /GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID/u,
  );
  assert.deepEqual(h.calls, []);

  h.failNextActive(h.b);
  let failure;
  try {
    await executeLegacyGateFBootstrap({
      authorizationPath: authorization.path,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      legacyVerifier,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      executingOperatorPath: h.b.tuple.operator.path,
      tcbAclController: { verify() {} },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "GATE_F_LEGACY_BOOTSTRAP_ROLLED_BACK");
  assert.equal(failure.receipt.rollback.verified, true);
  assert.equal(h.state.target, h.a.tuple.current.target);

  const receipt = await executeLegacyGateFBootstrap({
    authorizationPath: authorization.path,
    runtimeRoot: h.runtimeRoot,
    adapter: h.adapter,
    legacyVerifier,
    tupleVerifier: h.tupleVerifier,
    ...h.cutoverDependencies,
    executingOperatorPath: h.b.tuple.operator.path,
    tcbAclController: { verify() {} },
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.bootstrap, true);
  assert.equal(h.state.target, h.b.tuple.current.target);
});

test("fixed authorization writers use content addresses and explicit compare-and-swap", (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-gate-authorize-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const a = makeTuple(runtimeRoot, "a").tuple;
  const b = makeTuple(runtimeRoot, "b").tuple;
  const aHash = tupleHash(a);
  const bHash = tupleHash(b);
  writeAddressedDocument(runtimeRoot, "cutover-tuples", aHash, "gate-f-cutover-tuple.v1.json", a);
  writeAddressedDocument(runtimeRoot, "cutover-tuples", bHash, "gate-f-cutover-tuple.v1.json", b);
  assert.throws(
    () => authorizeGateFCutoverTransition({
      runtimeRoot,
      fromTupleSha256: aHash,
      toTupleSha256: bHash,
      expectedCurrentAuthorizationSha256: null,
      tcbAclController: {
        protect() {},
        verify() { throw Object.assign(new Error("weak ref ACL"), { code: "SYSTEM_TCB_ACL_DACL_INVALID" }); },
      },
    }),
    /weak ref ACL/u,
  );
  assert.equal(existsSync(join(runtimeRoot, "cutover", "authorized-transition.v1.json")), false);
  const tcb = { protect() {}, verify() {} };
  const first = authorizeGateFCutoverTransition({
    runtimeRoot,
    fromTupleSha256: aHash,
    toTupleSha256: bHash,
    expectedCurrentAuthorizationSha256: null,
    tcbAclController: tcb,
  });
  assert.ok(existsSync(first.path));
  const beforeBusy = readFileSync(first.path);
  const casLockPath = join(
    runtimeRoot,
    "cutover",
    "authorized-transition.v1.json.cas.lock",
  );
  writeFileSync(casLockPath, "concurrent-writer");
  assert.throws(
    () => authorizeGateFCutoverTransition({
      runtimeRoot,
      fromTupleSha256: bHash,
      toTupleSha256: aHash,
      expectedCurrentAuthorizationSha256: first.sha256,
      tcbAclController: tcb,
    }),
    /GATE_F_AUTHORIZATION_CAS_BUSY/u,
  );
  assert.deepEqual(readFileSync(first.path), beforeBusy);
  unlinkSync(casLockPath);
  assert.throws(
    () => authorizeGateFCutoverTransition({
      runtimeRoot,
      fromTupleSha256: bHash,
      toTupleSha256: aHash,
      expectedCurrentAuthorizationSha256: null,
      tcbAclController: tcb,
    }),
    /GATE_F_AUTHORIZATION_CAS_MISMATCH/u,
  );
  const second = authorizeGateFCutoverTransition({
    runtimeRoot,
    fromTupleSha256: bHash,
    toTupleSha256: aHash,
    expectedCurrentAuthorizationSha256: first.sha256,
    tcbAclController: tcb,
  });
  assert.notEqual(second.sha256, first.sha256);
});

test("fixed FINAL ValidateOnly derives the active content-addressed launcher and returns only hash evidence", async () => {
  const runtimeRoot = "C:\\fixture\\runtime";
  const releaseId = "xw-release-a";
  const sourceCommit = "a".repeat(40);
  const launcherSha256 = "1".repeat(64);
  const bindingSha256 = "2".repeat(64);
  const tupleSha256 = "3".repeat(64);
  const hashes = {
    secret: "4".repeat(64),
    keyring: "5".repeat(64),
    provider: "6".repeat(64),
    bundle: "7".repeat(64),
    m6: "8".repeat(64),
    serve03: "9".repeat(64),
    serve04: "a".repeat(64),
    node: "b".repeat(64),
  };
  const tuple = {
    runtimeRoot,
    release: { releaseId, sourceCommit },
    formal: {
      launcher: {
        path: join(runtimeRoot, "launchers", launcherSha256, "launch-control-plane.ps1"),
        sha256: launcherSha256,
      },
      binding: {
        path: join(runtimeRoot, "launcher-bindings", bindingSha256, "control-plane-launcher-binding.v1.json"),
        sha256: bindingSha256,
      },
      task: { xml: { path: join(runtimeRoot, "task-bindings", "fixture", "xw-platform-control-plane.xml") } },
    },
    runtimeBindings: {
      secretEnvironment: { sha256: hashes.secret },
      digestKeyring: { sha256: hashes.keyring },
      provider: { sha256: hashes.provider, providerBundleDigest: hashes.bundle },
      m6Final: { sha256: hashes.m6 },
      serve03: { sha256: hashes.serve03 },
      serve04: { sha256: hashes.serve04 },
    },
    trustedNode: { sha256: hashes.node },
  };
  const requiredEnvironment = {
    DEEPSEEK_API_KEY: "present",
    XW_M6_GATE_F_OPERATIONS_TOKEN: "present",
    XW_M6_LIVE_ENTRY_TOKEN: "present",
    XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: "present",
  };
  const launcherReceipt = {
    ok: true,
    schemaId: "xw.runtime.control-plane-launcher-validation.v1",
    releaseId,
    sourceCommit,
    launcherSha256,
    bindingSha256,
    privateMaterial: {
      secretEnvironment: { sha256: hashes.secret, requiredEnvironment },
      digestKeyring: { sha256: hashes.keyring, activeKeyId: "present", keyMaterial: "present" },
    },
    provider: { configSha256: hashes.provider, providerBundleDigest: hashes.bundle, closure: "verified" },
    fixedRuntimeBindings: {
      m6FinalSha256: hashes.m6,
      serveLaunch03Sha256: hashes.serve03,
      serveLaunch04Sha256: hashes.serve04,
    },
    trustedNode: { sha256: hashes.node },
    delegate: {
      ok: true,
      schemaId: "xw.runtime.m6-c1-launch-validation.v1",
      runtimeMode: "FINAL",
      releaseId,
      sourceCommit,
      requiredEnvironment,
    },
  };
  const commands = [];
  const dependencies = {
    runtimeRoot,
    expectedReleaseId: releaseId,
    expectedSourceCommit: sourceCommit,
    targetReferenceLoader: (runtime, release, source) => {
      assert.equal(runtime, runtimeRoot);
      assert.equal(release, releaseId);
      assert.equal(source, sourceCommit);
      return { value: { releaseId, sourceCommit, tuple: { path: join(runtimeRoot, "cutover-tuples", tupleSha256, "gate-f-cutover-tuple.v1.json"), sha256: tupleSha256 } } };
    },
    tupleVerifier: async ({ requireActive }) => {
      assert.equal(requireActive, true);
      return { ok: true, active: true, tuple };
    },
    launcherIdentityVerifier: () => ({
      ok: true,
      active: true,
      releaseId,
      sourceCommit,
      launcher: { bodySha256: launcherSha256 },
      binding: { sha256: bindingSha256 },
    }),
    launcherValidator: (command) => {
      commands.push(command);
      return launcherReceipt;
    },
    tcbAclController: { verify: () => {} },
  };
  const result = await validateGateFFinalLauncherFixed(dependencies);
  assert.equal(result.schemaId, GATE_F_FINAL_VALIDATE_FIXED_SCHEMA_ID);
  assert.equal(result.status, "VALIDATED");
  assert.equal(result.releaseId, releaseId);
  assert.equal(result.sourceCommit, sourceCommit);
  assert.match(result.validationHash, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /[\\/]|PRIVATE KEY|secretEnvironment|DEEPSEEK/u);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].executable, WINDOWS_POWERSHELL_EXECUTABLE);
  assert.deepEqual(commands[0].arguments.slice(-3), ["-Mode", "FINAL", "-ValidateOnly"]);
  assert.ok(commands[0].arguments.includes(tuple.formal.launcher.path));
  assert.ok(commands[0].arguments.includes(tuple.formal.binding.path));

  await assert.rejects(validateGateFFinalLauncherFixed({
    ...dependencies,
    launcherValidator: () => ({ ...launcherReceipt, bindingSha256: "c".repeat(64) }),
  }), { code: "GATE_F_FINAL_VALIDATE_RECEIPT_INVALID" });
  await assert.rejects(validateGateFFinalLauncherFixed({
    ...dependencies,
    tupleVerifier: async ({ requireActive, expectedTupleSha256 }) => {
      assert.equal(requireActive, true);
      assert.equal(expectedTupleSha256, tupleSha256);
      return { ok: true, active: false, tuple };
    },
  }), { code: "GATE_F_FINAL_VALIDATE_INVALID" });
});

test("production CLI refuses generic apply and every caller path/endpoint/token override", () => {
  assert.equal(parseGateFCutoverCommand(["preflight-authorized-fixed"]), "preflight");
  assert.equal(parseGateFCutoverCommand(["apply-authorized-fixed"]), "apply");
  assert.equal(parseGateFCutoverCommand(["bootstrap-authorized-fixed"]), "legacy-bootstrap");
  assert.deepEqual(
    parseGateFCutoverCommand(["prepare-target-fixed", "xw-release-a", "a".repeat(40)]),
    { kind: "prepare-target", releaseId: "xw-release-a", sourceCommit: "a".repeat(40) },
  );
  assert.deepEqual(
    parseGateFCutoverCommand(["validate-final-fixed", "xw-release-a", "a".repeat(40)]),
    { kind: "validate-final", releaseId: "xw-release-a", sourceCommit: "a".repeat(40) },
  );
  assert.deepEqual(
    parseGateFCutoverCommand([
      "stage-candidate-fixed", "xw-release-a", "a".repeat(40), "1".repeat(64),
      "2".repeat(64),
    ]),
    {
      kind: "stage-candidate",
      releaseId: "xw-release-a",
      sourceCommit: "a".repeat(40),
      assemblerReceiptHash: "1".repeat(64),
      qualificationPackageHash: "2".repeat(64),
    },
  );
  assert.equal(
    parseGateFCutoverCommand([
      "authorize-transition-fixed",
      "xw-release-a", "a".repeat(40),
      "xw-release-b", "b".repeat(40),
      "absent",
    ]).expectedCurrentAuthorizationSha256,
    null,
  );
  for (const argv of [
    [],
    ["apply"],
    ["apply-authorized-fixed", "--path", "C:\\attacker.json"],
    ["apply-authorized-fixed", "--endpoint", "http://127.0.0.1:1"],
    ["apply-authorized-fixed", "--token", "secret"],
    ["prepare-target-fixed", "C:\\attacker", "a".repeat(40)],
    ["validate-final-fixed", "xw-release-a", "a".repeat(40), "C:\\attacker.ps1"],
    ["stage-candidate-fixed", "xw-release-a", "a".repeat(40), "C:\\receipt"],
    ["authorize-transition-fixed", "xw-release-a", "a".repeat(40), "xw-release-b", "b".repeat(40), "C:\\auth"],
  ]) assert.throws(() => parseGateFCutoverCommand(argv), /GATE_F_CUTOVER_ARGUMENT_INVALID/u);
});

test("apply rejects an unprotected authorization or a non-release executing operator before mutation", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  await assert.rejects(
    executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      tcbAclController: {
        verify() { throw Object.assign(new Error("weak ACL"), { code: "SYSTEM_TCB_ACL_DACL_INVALID" }); },
      },
    }),
    /weak ACL/u,
  );
  assert.deepEqual(h.calls, []);
  await assert.rejects(
    executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      tcbAclController: { verify() {} },
      executingOperatorPath: join(h.runtimeRoot, "attacker-operator.mjs"),
    }),
    /GATE_F_CUTOVER_OPERATOR_IDENTITY_INVALID/u,
  );
  assert.deepEqual(h.calls, []);
});

test("tuple content address rejects replacement before any verifier dependency", async (t) => {
  const fixture = materializeFixture(t, "a");
  const bytes = readFileSync(fixture.tuplePath);
  bytes[bytes.length - 2] ^= 1;
  writeFileSync(fixture.tuplePath, bytes);
  await assert.rejects(
    verifyGateFCutoverTuple({
      tuplePath: fixture.tuplePath,
      expectedTupleSha256: fixture.tupleSha256,
      expectedRuntimeRoot: fixture.runtimeRoot,
      ...verifierDependencies(fixture),
    }),
    /GATE_F_CUTOVER_TUPLE_INVALID/u,
  );
});

test("Windows-safe fixed file replacement restores the backup after a postcondition failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xw-gate-replace-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "slot.json");
  writeFileSync(path, "old-bytes");
  replaceFileWithBackup({ targetPath: path, bytes: Buffer.from("new-bytes") });
  assert.equal(readFileSync(path, "utf8"), "new-bytes");
  assert.throws(
    () => replaceFileWithBackup({
      targetPath: path,
      bytes: Buffer.from("attacker-bytes"),
      afterInstall() { throw Object.assign(new Error("postcondition"), { code: "FIXTURE_POSTCONDITION" }); },
    }),
    /postcondition/u,
  );
  assert.equal(readFileSync(path, "utf8"), "new-bytes");
  assert.deepEqual(readdirSync(root).sort(), ["slot.json"]);
});

test("junction replacement restores old current and removes partial backup on verification failure", (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xw-gate-replace-current-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const releases = join(runtimeRoot, "releases");
  const a = join(releases, "release-a");
  const b = join(releases, "release-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const current = join(runtimeRoot, "current");
  symlinkSync(a, current, process.platform === "win32" ? "junction" : "dir");
  const ops = {
    exists: existsSync,
    read: readFileSync,
    realpath: () => a,
    rename: renameSync,
    removeFile: (path) => rmSync(path, { force: true }),
    removeLink: unlinkSync,
    symlink: symlinkSync,
    write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx" }),
  };
  assert.throws(
    () => replaceCurrentJunction({ runtimeRoot, targetPath: b, ops }),
    /GATE_F_CUTOVER_CURRENT_POSTCONDITION_FAILED/u,
  );
  assert.equal(realpathSync(current), realpathSync(a));
  assert.deepEqual(readdirSync(runtimeRoot).sort(), ["current", "releases"]);
});

test("rollback remains ordered and attempts every later restore after one component fails", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  h.failNextActive(h.b);
  let restoreCount = 0;
  h.adapter.restoreSnapshot = async (ref) => {
    restoreCount += 1;
    h.calls.push(`restore:${basename(ref.targetPath)}`);
    // Call 1 installs the transformed target fence; call 2 is rollback snapshot 0.
    if (restoreCount === 2) {
      throw Object.assign(new Error("snapshot fault"), { code: "FIXTURE_SNAPSHOT_FAULT" });
    }
  };
  let failure;
  try {
    await executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      tcbAclController: { verify() {} },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "GATE_F_CUTOVER_ROLLBACK_INCOMPLETE");
  assert.equal(restoreCount, 5);
  assert.equal(failure.receipt.rollback.restore[8].status, "rejected");
  assert.deepEqual(
    failure.receipt.rollback.restore.slice(8).map((row) => row.component),
    ["restore:snapshot:0", "restore:snapshot:1", "restore:snapshot:2", "restore:snapshot:3"],
  );
  assert.equal(failure.receipt.rollback.start[0].errorCode, "GATE_F_CUTOVER_RESTART_SKIPPED");
});

test("rollback performs no restore when fixed tasks cannot be proven stopped", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  h.failNextActive(h.b);
  const originalStop = h.adapter.stop;
  let stopCount = 0;
  h.adapter.stop = async () => {
    stopCount += 1;
    if (stopCount === 2) {
      h.calls.push("stop-fail");
      throw Object.assign(new Error("task remains running"), {
        code: "GATE_F_CUTOVER_TASK_STOP_UNPROVEN",
      });
    }
    return originalStop();
  };
  let failure;
  try {
    await executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      tcbAclController: { verify() {} },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "GATE_F_CUTOVER_ROLLBACK_INCOMPLETE");
  assert.ok(failure.receipt.rollback.restore.every((row) =>
    row.errorCode === "GATE_F_CUTOVER_RESTORE_SKIPPED_TASKS_NOT_STOPPED"));
  const stopFailureIndex = h.calls.indexOf("stop-fail");
  assert.deepEqual(h.calls.slice(stopFailureIndex + 1), []);
});

test("failure before Gate handoff mutation proves DB/private targets unchanged instead of restoring them", async (t) => {
  const h = transactionHarness(t);
  const transitionPath = writeTransition(h.runtimeRoot, h.a, h.b);
  let failure;
  try {
    await executeGateFCutover({
      transitionPath,
      runtimeRoot: h.runtimeRoot,
      adapter: h.adapter,
      tupleVerifier: h.tupleVerifier,
      ...h.cutoverDependencies,
      handoffBuilder: async () => {
        throw Object.assign(new Error("handoff preflight fault"), {
          code: "FIXTURE_HANDOFF_PREFLIGHT_FAULT",
        });
      },
      tcbAclController: { verify() {} },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "GATE_F_CUTOVER_APPLY_ROLLED_BACK");
  assert.deepEqual(
    failure.receipt.rollback.restore.slice(8).map((row) => row.component),
    ["prove:snapshot:0", "prove:snapshot:1", "prove:snapshot:2", "prove:snapshot:3"],
  );
  assert.equal(h.calls.filter((row) => row.startsWith("restore:")).length, 0);
  assert.equal(h.calls.filter((row) => row.startsWith("prove:")).length, 4);
});
