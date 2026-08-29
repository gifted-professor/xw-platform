import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  executeM6QualificationFinalRelay,
  executeM6QualificationLegacyQuiesce,
  executeM6QualificationLegacyRestore,
  M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH,
  M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID,
  normalizeM6QualificationLegacyListeners,
  parseM6QualificationLegacyWindowCommand,
  planM6QualificationLegacyWindow,
} from "../ops/m6-qualification-legacy-window-operator.mjs";
import { canonicalJson as domainCanonicalJson } from "../control-plane/lib/canonical.mjs";
import { GATE_F_CUTOVER_OPERATOR_RELEASE_PATH } from "../ops/gate-f-cutover-operator.mjs";
import { TRUSTED_NODE_EXECUTABLE } from "../ops/gate-f-launcher-identity.mjs";

const LEGACY_ID = "xw-legacy-window-fixture";
const LEGACY_COMMIT = "a".repeat(40);
const TARGET_ID = "xw-target-window-fixture";
const TARGET_COMMIT = "b".repeat(40);
const TARGET_B_ID = "xw-target-window-fixture-b";
const TARGET_B_COMMIT = "c".repeat(40);
const CONTROL_MODULE = "services/control-plane/control-plane/server.mjs";
const REGISTRY_MODULE = "services/orchestrator/registry.mjs";
const STATE_STORE_MODULE = "services/control-plane/control-plane/lib/state-store.mjs";
const REGISTRY_DATABASE_FILENAME = ["registry", "db"].join(".");
const COMMAND_LINE_SECRET = "command-line-secret-must-never-enter-receipt";
const LEGACY_QUALIFICATION_BINDING = Object.freeze({
  schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
  gateId: "m6-legacy-gate",
  releaseId: LEGACY_ID,
  sourceCommit: LEGACY_COMMIT,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

const noopTcb = Object.freeze({
  protect: () => Object.freeze({ ok: true }),
  verify: () => Object.freeze({ ok: true }),
});

function manifest({ releaseId, sourceCommit, files }) {
  return {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit,
    sourceTreeSha: "c".repeat(40),
    runtimeProfile: "legacy_compat",
    nodeVersion: "24.11.1",
    npmVersion: "11.6.2",
    services: {
      orchestrator: { path: "services/orchestrator", treeSha256: "d".repeat(64) },
      controlPlane: { path: "services/control-plane", treeSha256: "e".repeat(64) },
    },
    files,
    runtimeCutoverAllowed: false,
  };
}

function materializeRelease(runtimeRoot, { releaseId, sourceCommit, values }) {
  const root = join(runtimeRoot, "releases", releaseId);
  const files = [];
  for (const [path, value] of Object.entries(values)) {
    const bytes = Buffer.from(value, "utf8");
    write(join(root, ...path.split("/")), bytes);
    files.push({
      path,
      gitMode: "100644",
      gitBlobOid: "f".repeat(40),
      sha256: sha256(bytes),
    });
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  write(join(root, "release-manifest.v1.json"), canonical(manifest({ releaseId, sourceCommit, files })));
  return root;
}

function taskXml(runtimeRoot) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task>
  <Principals><Principal><UserId>S-1-5-18</UserId></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions><Exec>
    <Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>
    <Arguments>-NoProfile -File &quot;${runtimeRoot}\\launch-control-plane.simple.ps1&quot; -RuntimeRoot &quot;${runtimeRoot}&quot; -Opaque ${COMMAND_LINE_SECRET}</Arguments>
    <WorkingDirectory>${runtimeRoot}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-legacy-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const legacyRoot = materializeRelease(runtimeRoot, {
    releaseId: LEGACY_ID,
    sourceCommit: LEGACY_COMMIT,
    values: {
      [CONTROL_MODULE]: "export const control = true;\n",
      [REGISTRY_MODULE]: "export const registry = true;\n",
    },
  });
  const targetRoot = materializeRelease(runtimeRoot, {
    releaseId: TARGET_ID,
    sourceCommit: TARGET_COMMIT,
    values: {
      [M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH]: "export const operator = true;\n",
      [GATE_F_CUTOVER_OPERATOR_RELEASE_PATH]: "export const cutover = true;\n",
      [CONTROL_MODULE]: "export const targetControl = true;\n",
      [REGISTRY_MODULE]: "export const targetRegistry = true;\n",
      [STATE_STORE_MODULE]: "export const CURRENT_CONTROL_SCHEMA_VERSION = 21;\n",
    },
  });
  symlinkSync(legacyRoot, join(runtimeRoot, "current"), process.platform === "win32" ? "junction" : "dir");
  for (const [path, bytes] of [
    [["state", "control-plane", "control.db"], "control-db-live"],
    [["state", "orchestrator", REGISTRY_DATABASE_FILENAME], "registry-db-live"],
    [["secrets", "control-plane-secret-environment.v1.json"], canonical({ secret: "private-token" })],
    [["secrets", "xhs-evidence-digest-keyring.v1.json"], canonical({ key: "private-digest-key" })],
    [["config", "m6-c1-qualification-bootstrap.v1.json"], canonical(LEGACY_QUALIFICATION_BINDING)],
  ]) write(join(runtimeRoot, ...path), bytes);
  const xml = taskXml(runtimeRoot);
  const modules = {
    controlPlane: {
      path: join(legacyRoot, ...CONTROL_MODULE.split("/")),
      sha256: sha256(readFileSync(join(legacyRoot, ...CONTROL_MODULE.split("/")))),
    },
    registry: {
      path: join(legacyRoot, ...REGISTRY_MODULE.split("/")),
      sha256: sha256(readFileSync(join(legacyRoot, ...REGISTRY_MODULE.split("/")))),
    },
  };
  const trustedNode = { path: TRUSTED_NODE_EXECUTABLE, sha256: "9".repeat(64), version: "24.11.1" };
  const activeListeners = () => ({
    host: "127.0.0.1",
    ports: [17920, 17930],
    listeners: [
      {
        port: 17920,
        pid: 4200,
        parentPid: 4100,
        createdAt: "20260830010101.000000+000",
        executablePath: TRUSTED_NODE_EXECUTABLE,
        modulePath: modules.controlPlane.path,
      },
      {
        port: 17930,
        pid: 4300,
        parentPid: 4100,
        createdAt: "20260830010102.000000+000",
        executablePath: TRUSTED_NODE_EXECUTABLE,
        modulePath: modules.registry.path,
      },
    ],
  });
  const health = () => ({
    controlPlane: { ok: true, releaseId: LEGACY_ID, sourceCommit: LEGACY_COMMIT },
    registry: { ok: true, releaseId: LEGACY_ID, sourceCommit: LEGACY_COMMIT },
  });
  const options = {
    runtimeRoot,
    expectedReleaseId: TARGET_ID,
    expectedSourceCommit: TARGET_COMMIT,
    executingOperatorPath: join(targetRoot, ...M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH.split("/")),
    releaseVerifier: () => ({ ok: true, mismatches: [] }),
    trustedNodeInspector: () => trustedNode,
    tcbAclController: noopTcb,
  };
  return {
    root,
    runtimeRoot,
    legacyRoot,
    targetRoot,
    xml,
    modules,
    trustedNode,
    activeListeners,
    health,
    options,
  };
}

function createAdapter(fixtureValue, {
  detachedAfterStart = false,
  failFirstTargetSwitch = false,
} = {}) {
  const calls = [];
  let active = true;
  let listenerModules = fixtureValue.modules;
  let task = { exists: true, state: "RUNNING", xml: fixtureValue.xml };
  let current = fixtureValue.legacyRoot;
  let terminated = 0;
  let targetSwitches = 0;
  return {
    calls,
    commandLine: `node server.mjs --token ${COMMAND_LINE_SECRET}`,
    get active() { return active; },
    get current() { return current; },
    set current(value) { current = value; },
    activateRelay(modules) {
      active = true;
      listenerModules = modules;
    },
    inspectTask() {
      calls.push(["inspect-task", task.state]);
      return structuredClone(task);
    },
    inspectFixedTask(name) {
      calls.push(["inspect-fixed-task", name]);
      return name === "XW Platform Control Plane"
        ? structuredClone(task)
        : { exists: false, state: "ABSENT", xml: null };
    },
    inspectQualificationTask() {
      calls.push(["inspect-qualification-task"]);
      return { exists: false, state: "ABSENT", xml: null };
    },
    inspectListeners() {
      calls.push(["inspect-listeners", active]);
      return active
        ? {
          ...fixtureValue.activeListeners(),
          listeners: fixtureValue.activeListeners().listeners.map((row) => ({
            ...row,
            modulePath: row.port === 17920
              ? listenerModules.controlPlane.path
              : listenerModules.registry.path,
          })),
        }
        : { host: "127.0.0.1", ports: [17920, 17930], listeners: [] };
    },
    inspectHealth() {
      calls.push(["inspect-health"]);
      return fixtureValue.health();
    },
    endTask() {
      calls.push(["end-task"]);
      task = { ...task, state: "READY" };
    },
    terminateVerifiedProcess(row) {
      calls.push(["terminate", row.port, row.pid]);
      terminated += 1;
      if (terminated === 2) {
        active = false;
      }
      return "terminated";
    },
    assertWalSafe() {
      calls.push(["wal-safe"]);
    },
    inspectCurrent() {
      calls.push(["inspect-current", current]);
      return current;
    },
    restoreCurrent(target) {
      calls.push(["restore-current", target]);
      current = target;
    },
    switchCurrent(target) {
      calls.push(["switch-current", target]);
      targetSwitches += 1;
      if (failFirstTargetSwitch && targetSwitches === 1) {
        throw Object.assign(new Error("fixture target switch failure"), {
          code: "M6_QUALIFICATION_LEGACY_TARGET_ACTIVATION_FAILED",
        });
      }
      current = target;
    },
    restoreFile(ref) {
      calls.push(["restore-file", ref.targetPath, ref.sha256]);
    },
    registerTaskXml(path) {
      calls.push(["register-task", path]);
      task = { exists: true, state: "READY", xml: readFileSync(path, "utf8") };
    },
    runTask() {
      calls.push(["run-task"]);
      task = { ...task, state: detachedAfterStart ? "READY" : "RUNNING" };
      terminated = 0;
      active = true;
    },
    cleanupFinalTasks() {
      calls.push(["cleanup-final-tasks"]);
      task = { exists: false, state: "ABSENT", xml: null };
      active = false;
    },
    restoreRelaySlot(ref) {
      calls.push(["restore-relay-slot", ref.targetPath, ref.present]);
    },
    registerFixedTaskXml(name, path) {
      calls.push(["register-fixed-task", name, path]);
    },
  };
}

test("CLI accepts only a fixed command plus new formal release identity", () => {
  assert.deepEqual(parseM6QualificationLegacyWindowCommand([
    "quiesce-fixed", TARGET_ID, TARGET_COMMIT,
  ]), { kind: "quiesce", releaseId: TARGET_ID, sourceCommit: TARGET_COMMIT });
  assert.deepEqual(parseM6QualificationLegacyWindowCommand([
    "restore-fixed", TARGET_ID, TARGET_COMMIT,
  ]), { kind: "restore", releaseId: TARGET_ID, sourceCommit: TARGET_COMMIT });
  assert.deepEqual(parseM6QualificationLegacyWindowCommand([
    "relay-final-fixed", TARGET_ID, TARGET_COMMIT, "7".repeat(64),
  ]), {
    kind: "relay-final",
    releaseId: TARGET_ID,
    sourceCommit: TARGET_COMMIT,
    assemblerReceiptHash: "7".repeat(64),
  });
  for (const argv of [
    ["quiesce-fixed", TARGET_ID, TARGET_COMMIT, "--pid", "42"],
    ["quiesce-fixed", "C:\\runtime", TARGET_COMMIT],
    ["restore-fixed", TARGET_ID, TARGET_COMMIT, "secret-token"],
    ["quiesce", TARGET_ID, TARGET_COMMIT],
  ]) assert.throws(() => parseM6QualificationLegacyWindowCommand(argv), /M6_QUALIFICATION_LEGACY_ARGUMENT_INVALID/u);
});

test("preflight binds current manifest, fixed task, trusted Node, exact modules, listeners, and health", async (t) => {
  const value = fixture(t);
  const plan = await planM6QualificationLegacyWindow({
    ...value.options,
    taskInspector: () => ({ exists: true, state: "RUNNING", xml: value.xml }),
    listenerInspector: value.activeListeners,
    healthInspector: value.health,
  });
  assert.equal(plan.legacyRelease.releaseId, LEGACY_ID);
  assert.equal(plan.targetRelease.releaseId, TARGET_ID);
  assert.deepEqual(plan.listeners.map((row) => row.port), [17920, 17930]);
  assert.equal("commandLine" in plan.listeners[0], false);
  assert.doesNotMatch(JSON.stringify(plan.listeners), /command-line-secret/u);
});

test("legacy native defaults never admit a non-SYSTEM SID or explicitly disabled task", async (t) => {
  const value = fixture(t);
  const invalidXml = [
    value.xml.replace("S-1-5-18", "S-1-5-19"),
    value.xml.replace(
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<Enabled>false</Enabled>",
    ),
  ];
  for (const xml of invalidXml) {
    await assert.rejects(planM6QualificationLegacyWindow({
      ...value.options,
      taskInspector: () => ({ exists: true, state: "RUNNING", xml }),
      listenerInspector: value.activeListeners,
      healthInspector: value.health,
    }), { code: "M6_QUALIFICATION_LEGACY_TASK_INVALID" });
  }
});

test("listener oracle rejects missing, shared, foreign executable, or wrong-module owners", (t) => {
  const value = fixture(t);
  const base = value.activeListeners();
  const normalize = (receipt) => normalizeM6QualificationLegacyListeners(receipt, {
    modules: value.modules,
    trustedNode: value.trustedNode,
    requireActive: true,
  });
  assert.throws(() => normalize({ ...base, listeners: base.listeners.slice(0, 1) }), /LISTENER_INVALID/u);
  assert.throws(() => normalize({
    ...base,
    listeners: base.listeners.map((row) => ({ ...row, pid: 4200 })),
  }), /LISTENER_INVALID/u);
  assert.throws(() => normalize({
    ...base,
    listeners: base.listeners.map((row, index) => index === 0
      ? { ...row, executablePath: "C:\\foreign\\node.exe" } : row),
  }), /LISTENER_INVALID/u);
  assert.throws(() => normalize({
    ...base,
    listeners: base.listeners.map((row, index) => index === 1
      ? { ...row, modulePath: value.modules.controlPlane.path } : row),
  }), /LISTENER_INVALID/u);
});

test("quiesce seals content-addressed prestate before stopping only the verified legacy listeners", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  const receipt = await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  assert.equal(receipt.outcome, "QUIESCED");
  assert.equal(adapter.active, false);
  assert.equal(adapter.current, value.targetRoot);
  assert.deepEqual(
    adapter.calls.filter((row) => row[0] === "terminate").map((row) => row.slice(1)),
    [[17920, 4200], [17930, 4300]],
  );
  assert.match(receipt.prestateSha256, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /command-line-secret|private-token|private-digest-key/u);
  const referencePath = join(
    value.runtimeRoot,
    "qualification-legacy-windows",
    "by-release",
    TARGET_ID,
    TARGET_COMMIT,
    "window-reference.v1.json",
  );
  const reference = JSON.parse(readFileSync(referencePath, "utf8"));
  const prestateRaw = readFileSync(reference.prestate.path, "utf8");
  assert.equal(sha256(prestateRaw), receipt.prestateSha256);
  assert.doesNotMatch(prestateRaw, /command-line-secret|private-token|private-digest-key/u);
  const prestate = JSON.parse(prestateRaw);
  assert.equal(prestate.resources.qualificationBinding.present, true);
  assert.equal(
    prestate.resources.qualificationBinding.targetPath,
    join(value.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json"),
  );
  const processRaw = readFileSync(prestate.processes.snapshot.path, "utf8");
  assert.doesNotMatch(processRaw, /command-line-secret/u);
});

test("restore uses only sealed prestate, restores fixed resources/current/task, then proves health", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  adapter.current = value.targetRoot;
  const receipt = await executeM6QualificationLegacyRestore({
    ...value.options,
    adapter,
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  assert.equal(receipt.outcome, "RESTORED");
  assert.equal(adapter.current, value.legacyRoot);
  assert.equal(adapter.active, true);
  assert.equal(adapter.calls.filter((row) => row[0] === "restore-file").length, 5);
  assert.equal(adapter.calls.some((row) => row[0] === "register-task"), true);
  assert.equal(adapter.calls.some((row) => row[0] === "run-task"), true);
  assert.doesNotMatch(JSON.stringify(receipt), /command-line-secret|private-token/u);
});

test("A restore reinstalls the sealed legacy binding before B quiesce and old-identity rotation check", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  const recordedRestoreFile = adapter.restoreFile.bind(adapter);
  adapter.restoreFile = (ref) => {
    recordedRestoreFile(ref);
    if (ref.present === false) {
      rmSync(ref.targetPath, { force: true });
    } else {
      write(ref.targetPath, readFileSync(ref.path));
    }
  };
  const bindingPath = join(value.runtimeRoot, "config", "m6-c1-qualification-bootstrap.v1.json");
  const snapshotter = async (path) => Buffer.from(`consistent-backup:${path}`, "utf8");
  const timing = { timeoutMs: 50, pollMs: 0, delayFn: async () => {} };

  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: snapshotter,
    ...timing,
  });
  const aReferencePath = join(
    value.runtimeRoot,
    "qualification-legacy-windows",
    "by-release",
    TARGET_ID,
    TARGET_COMMIT,
    "window-reference.v1.json",
  );
  const aReference = JSON.parse(readFileSync(aReferencePath, "utf8"));
  const aPrestateBytes = readFileSync(aReference.prestate.path);

  // Model A rotation/qualification replacing the fixed binding while A is current.
  write(bindingPath, canonical({
    schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
    gateId: "m6-a-gate",
    releaseId: TARGET_ID,
    sourceCommit: TARGET_COMMIT,
  }));
  await executeM6QualificationLegacyRestore({
    ...value.options,
    adapter,
    ...timing,
  });
  assert.deepEqual(JSON.parse(readFileSync(bindingPath, "utf8")), LEGACY_QUALIFICATION_BINDING);

  const targetBRoot = materializeRelease(value.runtimeRoot, {
    releaseId: TARGET_B_ID,
    sourceCommit: TARGET_B_COMMIT,
    values: {
      [M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH]: "export const operatorB = true;\n",
      [GATE_F_CUTOVER_OPERATOR_RELEASE_PATH]: "export const cutoverB = true;\n",
      [CONTROL_MODULE]: "export const targetControlB = true;\n",
      [REGISTRY_MODULE]: "export const targetRegistryB = true;\n",
      [STATE_STORE_MODULE]: "export const CURRENT_CONTROL_SCHEMA_VERSION = 21;\n",
    },
  });
  const bOptions = {
    ...value.options,
    expectedReleaseId: TARGET_B_ID,
    expectedSourceCommit: TARGET_B_COMMIT,
    executingOperatorPath: join(
      targetBRoot,
      ...M6_QUALIFICATION_LEGACY_WINDOW_OPERATOR_RELEASE_PATH.split("/"),
    ),
  };
  await executeM6QualificationLegacyQuiesce({
    ...bOptions,
    adapter,
    databaseSnapshotter: snapshotter,
    ...timing,
  });

  // This is the identity equality required by rotation's old fence/binding verifier.
  const beforeBRotation = JSON.parse(readFileSync(bindingPath, "utf8"));
  const simulatedOldFence = {
    gateId: LEGACY_QUALIFICATION_BINDING.gateId,
    releaseId: LEGACY_QUALIFICATION_BINDING.releaseId,
    sourceCommit: LEGACY_QUALIFICATION_BINDING.sourceCommit,
  };
  assert.deepEqual({
    gateId: beforeBRotation.gateId,
    releaseId: beforeBRotation.releaseId,
    sourceCommit: beforeBRotation.sourceCommit,
  }, simulatedOldFence);
  write(bindingPath, canonical({
    schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
    gateId: "m6-b-gate",
    releaseId: TARGET_B_ID,
    sourceCommit: TARGET_B_COMMIT,
  }));
  assert.deepEqual(readFileSync(aReference.prestate.path), aPrestateBytes);
  assert.equal(adapter.current, targetBRoot);
});

test("a post-stop failure automatically restores the exact sealed legacy authority", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value, { failFirstTargetSwitch: true });
  await assert.rejects(executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    assert.equal(error.code, "M6_QUALIFICATION_LEGACY_QUIESCE_ROLLED_BACK");
    assert.equal(error.receipt.autoRestore, true);
    assert.equal(error.receipt.outcome, "RESTORED");
    assert.doesNotMatch(JSON.stringify(error.receipt), /command-line-secret|private-token/u);
    return true;
  });
  assert.equal(adapter.current, value.legacyRoot);
  assert.equal(adapter.active, true);
});

test("restore rejects any drift in the content-addressed sealed prestate", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const reference = JSON.parse(readFileSync(join(
    value.runtimeRoot,
    "qualification-legacy-windows",
    "by-release",
    TARGET_ID,
    TARGET_COMMIT,
    "window-reference.v1.json",
  ), "utf8"));
  writeFileSync(reference.prestate.path, `${readFileSync(reference.prestate.path, "utf8")} `);
  await assert.rejects(executeM6QualificationLegacyRestore({
    ...value.options,
    adapter,
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), /M6_QUALIFICATION_LEGACY_PRESTATE_INVALID/u);
});

test("restore accepts a detached launcher that becomes READY after exact listeners and health converge", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value, { detachedAfterStart: true });
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const receipt = await executeM6QualificationLegacyRestore({
    ...value.options,
    adapter,
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  assert.equal(receipt.outcome, "RESTORED");
  assert.equal(adapter.inspectTask().state, "READY");
  assert.equal(adapter.active, true);
});

function relayFixtureState(value) {
  const reference = JSON.parse(readFileSync(join(
    value.runtimeRoot,
    "qualification-legacy-windows",
    "by-release",
    TARGET_ID,
    TARGET_COMMIT,
    "window-reference.v1.json",
  ), "utf8"));
  const prestate = JSON.parse(readFileSync(reference.prestate.path, "utf8"));
  const snapshots = {
    controlDb: { marker: "qualified-control" },
    registryDb: { marker: "qualified-registry" },
    privateMaterial: [{ marker: "qualified-secret" }, { marker: "qualified-keyring" }],
  };
  const preparedRuntimeBindings = {
    m6Final: { path: join(value.runtimeRoot, "prepared", "m6.json"), sha256: "1".repeat(64) },
    serve03: { path: join(value.runtimeRoot, "prepared", "03.json"), sha256: "2".repeat(64) },
    serve04: { path: join(value.runtimeRoot, "prepared", "04.json"), sha256: "3".repeat(64) },
  };
  const candidatePath = join(
    value.runtimeRoot,
    "cutover-candidates",
    TARGET_ID,
    TARGET_COMMIT,
    "gate-f-target-candidate.v1.json",
  );
  const candidateValue = {
    releaseId: TARGET_ID,
    sourceCommit: TARGET_COMMIT,
    snapshots,
    preparedRuntimeBindings,
  };
  const candidateBytes = Buffer.from(canonical(candidateValue), "utf8");
  const candidateSha256 = sha256(candidateBytes);
  write(candidatePath, candidateBytes);
  const tuple = {
    release: { releaseId: TARGET_ID, sourceCommit: TARGET_COMMIT, root: value.targetRoot },
    current: { target: value.targetRoot },
    formal: { task: { name: "XW Platform Control Plane", xml: { path: "formal.xml" } } },
    activationTasks: [
      { name: "XW Platform Orchestrator", xml: { path: "orchestrator.xml" } },
      { name: "XW Platform FastOperator 03", xml: { path: "03.xml" } },
      { name: "XW Platform FastOperator 04", xml: { path: "04.xml" } },
    ],
    trustedNode: value.trustedNode,
    runtimeBindings: {
      m6Final: { ...preparedRuntimeBindings.m6Final },
      serve03: { ...preparedRuntimeBindings.serve03 },
      serve04: { ...preparedRuntimeBindings.serve04 },
      secretEnvironment: { sha256: prestate.resources.privateMaterial[0].sha256 },
      digestKeyring: { sha256: prestate.resources.privateMaterial[1].sha256 },
    },
    snapshots,
  };
  const tupleBytes = Buffer.from(canonical(tuple), "utf8");
  const tupleSha256 = sha256(tupleBytes);
  const tuplePath = join(
    value.runtimeRoot,
    "cutover-tuples",
    tupleSha256,
    "gate-f-cutover-tuple.v1.json",
  );
  write(tuplePath, tupleBytes);
  const qualification = {
    schemaId: "xw.runtime.m6-qualification-resume-state.v1",
    releaseId: TARGET_ID,
    sourceCommit: TARGET_COMMIT,
    databaseVersion: 21,
    databaseSha256: "6".repeat(64),
    fenceHash: "7".repeat(64),
    resources: { jobs: 0, sessions: 0, leases: 0, actionCount: 0, pendingApprovals: 0 },
    durableResidue: {
      emergencyCloseConsumptions: 0,
      groundingPermits: 0,
      actionClaims: 0,
      groundedActionDetails: 0,
      liveWindowAuthorizations: 0,
      liveScenarioClaims: 0,
      safetyCloseArms: 0,
    },
    binding: { sha256: "8".repeat(64) },
    receipt: { receiptHash: "9".repeat(64), packageHash: "c".repeat(64) },
  };
  return {
    prestate,
    qualification,
    staged: {
      ok: true,
      snapshotSource: { releaseId: TARGET_ID, sourceCommit: TARGET_COMMIT },
      candidate: {
        ok: true,
        path: candidatePath,
        sha256: candidateSha256,
        value: candidateValue,
      },
    },
    prepared: { ok: true, tuplePath, tupleSha256, tuple },
  };
}

test("relay-final preserves qualified schema-21 DB and activates the exact Gate-F tuple", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  const cutoverCalls = [];
  let activeAttempts = 0;
  const receipt = await executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async (artifact) => cutoverCalls.push(["write", artifact.sha256]),
      switchCurrent: async (target) => { cutoverCalls.push(["current", target]); adapter.current = target; },
      registerTask: async (task) => cutoverCalls.push(["register", task.name]),
      start: async () => {
        cutoverCalls.push(["start"]);
        adapter.activateRelay({
          controlPlane: { path: join(value.targetRoot, ...CONTROL_MODULE.split("/")) },
          registry: { path: join(value.targetRoot, ...REGISTRY_MODULE.split("/")) },
        });
      },
    },
    qualificationInspector: ({ requireStandalone }) => ({
      ...state.qualification,
      databaseSha256: requireStandalone ? state.qualification.databaseSha256 : null,
    }),
    candidateStager: async (input) => {
      assert.equal(typeof input.snapshotCapturer, "function");
      return state.staged;
    },
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => {
      if (requireActive && activeAttempts++ === 0) throw new Error("listener not ready yet");
      return {
        ok: true,
        active: requireActive,
        releaseId: TARGET_ID,
        sourceCommit: TARGET_COMMIT,
        ...(requireActive ? {
          taskProcessClosure: { closureSha256: "d".repeat(64) },
        } : {}),
      };
    },
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  assert.deepEqual(Object.keys(receipt).sort(), ["code", "receiptHash", "receiptRef"]);
  assert.equal(receipt.code, "M6_QUALIFICATION_FINAL_RELAY_COMMITTED");
  assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.receiptRef.path, join(
    value.runtimeRoot,
    "qualification-final-relays",
    "receipts",
    `${receipt.receiptHash}.json`,
  ));
  const receiptBytes = readFileSync(receipt.receiptRef.path);
  const persisted = JSON.parse(receiptBytes);
  const { receiptHash, ...receiptBody } = persisted;
  assert.equal(receiptHash, receipt.receiptHash);
  assert.equal(sha256(receiptBytes), receipt.receiptRef.sha256);
  assert.equal(receiptHash, sha256(
    `${M6_QUALIFICATION_FINAL_RELAY_RECEIPT_SCHEMA_ID}:${domainCanonicalJson(receiptBody)}`,
  ));
  assert.equal(receiptBody.outcome, "FINAL_ACTIVE");
  assert.equal(receiptBody.qualificationFenceHash, state.qualification.fenceHash);
  assert.equal(receiptBody.targetTupleSha256, state.prepared.tupleSha256);
  assert.equal(receiptBody.postflight.taskOwnedProcessClosureSha256, "d".repeat(64));
  assert.doesNotMatch(receiptBytes.toString("utf8"), /command-line-secret|private-token|private-digest-key/u);
  assert.equal(activeAttempts, 2);
  assert.equal(adapter.calls.some((row) => row[0] === "restore-file"), false);
  assert.deepEqual(cutoverCalls.filter((row) => row[0] === "register").map((row) => row[1]), [
    "XW Platform Control Plane",
    "XW Platform Orchestrator",
    "XW Platform FastOperator 03",
    "XW Platform FastOperator 04",
  ]);
});

test("relay-final rolls back when health is live but task-owned ancestry proof is absent", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value, { detachedAfterStart: true });
  const restoreCurrent = adapter.restoreCurrent.bind(adapter);
  adapter.restoreCurrent = (target) => {
    restoreCurrent(target);
    // Model the sealed legacy launcher resolving its modules from restored current.
    adapter.activateRelay(value.modules);
  };
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  await assert.rejects(executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async () => {},
      switchCurrent: async (target) => { adapter.current = target; },
      registerTask: async () => {},
      start: async () => {
        adapter.activateRelay({
          controlPlane: { path: join(value.targetRoot, ...CONTROL_MODULE.split("/")) },
          registry: { path: join(value.targetRoot, ...REGISTRY_MODULE.split("/")) },
        });
      },
    },
    qualificationInspector: ({ requireStandalone }) => ({
      ...state.qualification,
      databaseSha256: requireStandalone ? state.qualification.databaseSha256 : null,
    }),
    candidateStager: async () => state.staged,
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => ({
      ok: true,
      active: requireActive,
      releaseId: TARGET_ID,
      sourceCommit: TARGET_COMMIT,
      // Exact health/module identity without a Task Scheduler ancestry receipt is insufficient.
    }),
    timeoutMs: 200,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    const persisted = JSON.parse(readFileSync(error.receiptRef.path, "utf8"));
    assert.equal(error.code, "M6_QUALIFICATION_FINAL_RELAY_ROLLED_BACK");
    assert.equal(persisted.causeCode, "M6_QUALIFICATION_FINAL_RELAY_POSTFLIGHT_TIMEOUT");
    assert.equal(persisted.rollback.verified, true);
    return true;
  });
  assert.equal(adapter.current, value.legacyRoot);
});

test("relay-final rejects an authorization writer that did not seal the exact canonical transition", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value);
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  let mutationCount = 0;
  await assert.rejects(executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async () => { mutationCount += 1; },
      switchCurrent: async () => { mutationCount += 1; },
      registerTask: async () => { mutationCount += 1; },
      start: async () => { mutationCount += 1; },
    },
    qualificationInspector: () => state.qualification,
    candidateStager: async () => state.staged,
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => ({
      ok: true,
      active: requireActive,
      releaseId: TARGET_ID,
      sourceCommit: TARGET_COMMIT,
      ...(requireActive ? {
        taskProcessClosure: { closureSha256: "d".repeat(64) },
      } : {}),
    }),
    authorizationWriter: () => ({
      document: {},
      path: join(value.runtimeRoot, "not-the-fixed-authorization.json"),
      sha256: "b".repeat(64),
    }),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    assert.equal(error.code, "M6_QUALIFICATION_FINAL_RELAY_AUTHORIZATION_INVALID");
    assert.equal("receiptHash" in error, false);
    return true;
  });
  assert.equal(mutationCount, 0);
});

test("relay-final receipt persistence failure is visible after best-effort legacy rollback", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value, { detachedAfterStart: true });
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  await assert.rejects(executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async () => {},
      switchCurrent: async (target) => { adapter.current = target; },
      registerTask: async () => {},
      start: async () => {
        adapter.activateRelay({
          controlPlane: { path: join(value.targetRoot, ...CONTROL_MODULE.split("/")) },
          registry: { path: join(value.targetRoot, ...REGISTRY_MODULE.split("/")) },
        });
      },
    },
    qualificationInspector: ({ requireStandalone }) => ({
      ...state.qualification,
      databaseSha256: requireStandalone ? state.qualification.databaseSha256 : null,
    }),
    candidateStager: async () => state.staged,
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => ({
      ok: true,
      active: requireActive,
      releaseId: TARGET_ID,
      sourceCommit: TARGET_COMMIT,
      ...(requireActive ? {
        taskProcessClosure: { closureSha256: "d".repeat(64) },
      } : {}),
    }),
    receiptWriter: () => {
      throw Object.assign(new Error("fixture receipt writer unavailable"), {
        code: "FIXTURE_RECEIPT_WRITE_FAILED",
      });
    },
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    assert.equal(error.code, "M6_QUALIFICATION_FINAL_RELAY_RECEIPT_PERSIST_FAILED");
    assert.equal("receiptHash" in error, false);
    assert.doesNotMatch(JSON.stringify(error), /fixture receipt writer unavailable/u);
    return true;
  });
  assert.equal(adapter.current, value.legacyRoot);
  assert.equal(adapter.active, true);
  assert.equal(adapter.inspectTask().state, "READY");
});

test("relay-final failure restores sealed legacy DB/private/current/task and pre-relay live slots", async (t) => {
  const value = fixture(t);
  const adapter = createAdapter(value, { detachedAfterStart: true });
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  let writes = 0;
  await assert.rejects(executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async () => {
        writes += 1;
        if (writes === 2) throw Object.assign(new Error("fixture write failure"), { code: "WRITE_FAILED" });
      },
      switchCurrent: async (target) => { adapter.current = target; },
      registerTask: async () => {},
      start: async () => {},
    },
    qualificationInspector: () => state.qualification,
    candidateStager: async () => state.staged,
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => ({
      ok: true,
      active: requireActive,
      releaseId: TARGET_ID,
      sourceCommit: TARGET_COMMIT,
      ...(requireActive ? {
        taskProcessClosure: { closureSha256: "d".repeat(64) },
      } : {}),
    }),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    assert.equal(error.code, "M6_QUALIFICATION_FINAL_RELAY_ROLLED_BACK");
    assert.match(error.receiptHash, /^[0-9a-f]{64}$/u);
    assert.equal(error.receiptRef.path, join(
      value.runtimeRoot,
      "qualification-final-relays",
      "receipts",
      `${error.receiptHash}.json`,
    ));
    assert.equal("receipt" in error, false);
    assert.equal("causeCode" in error, false);
    const persisted = JSON.parse(readFileSync(error.receiptRef.path, "utf8"));
    assert.equal(persisted.outcome, "LEGACY_RESTORED");
    assert.equal(persisted.causeCode, "WRITE_FAILED");
    assert.equal(persisted.rollback.verified, true);
    assert.doesNotMatch(JSON.stringify(persisted), /command-line-secret|private-token|private-digest-key/u);
    assert.doesNotMatch(JSON.stringify(error), /command-line-secret|private-token/u);
    return true;
  });
  assert.equal(adapter.current, value.legacyRoot);
  assert.equal(adapter.active, true);
  assert.equal(adapter.inspectTask().state, "READY");
  assert.equal(adapter.calls.filter((row) => row[0] === "restore-file").length, 5);
  assert.equal(adapter.calls.filter((row) => row[0] === "restore-relay-slot").length, 3);
});

test("relay rollback settles every sealed resource and live slot before refusing a mixed restart", async (t) => {
  const value = fixture(t);
  const baseAdapter = createAdapter(value);
  await executeM6QualificationLegacyQuiesce({
    ...value.options,
    adapter: baseAdapter,
    databaseSnapshotter: async (path) => Buffer.from(`consistent-backup:${path}`, "utf8"),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  });
  const state = relayFixtureState(value);
  let overlayAttempts = 0;
  const adapter = {
    ...baseAdapter,
    restoreRelaySlot(ref) {
      overlayAttempts += 1;
      baseAdapter.restoreRelaySlot(ref);
      if (overlayAttempts === 1) throw Object.assign(new Error("overlay restore failed"), { code: "OVERLAY_FAILED" });
    },
  };
  await assert.rejects(executeM6QualificationFinalRelay({
    ...value.options,
    assemblerReceiptHash: "a".repeat(64),
    adapter,
    cutoverAdapter: {
      writeRuntimeBinding: async () => { throw Object.assign(new Error("apply failed"), { code: "APPLY_FAILED" }); },
      switchCurrent: async () => {},
      registerTask: async () => {},
      start: async () => {},
    },
    qualificationInspector: () => state.qualification,
    candidateStager: async () => state.staged,
    targetPreparer: async () => state.prepared,
    tupleVerifier: async ({ requireActive }) => ({
      ok: true,
      active: requireActive,
      releaseId: TARGET_ID,
      sourceCommit: TARGET_COMMIT,
      ...(requireActive ? {
        taskProcessClosure: { closureSha256: "d".repeat(64) },
      } : {}),
    }),
    timeoutMs: 50,
    pollMs: 0,
    delayFn: async () => {},
  }), (error) => {
    assert.equal(error.code, "M6_QUALIFICATION_FINAL_RELAY_ROLLBACK_INCOMPLETE");
    assert.match(error.receiptHash, /^[0-9a-f]{64}$/u);
    assert.equal("receipt" in error, false);
    assert.equal("rollbackCode" in error, false);
    const persisted = JSON.parse(readFileSync(error.receiptRef.path, "utf8"));
    assert.equal(persisted.outcome, "ROLLBACK_INCOMPLETE");
    assert.equal(persisted.rollbackCode, "OVERLAY_FAILED");
    assert.equal(persisted.rollback.resources.length, 5);
    assert.equal(persisted.rollback.overlay.length, 3);
    assert.equal(persisted.rollback.overlay.filter((row) => row.status === "fulfilled").length, 2);
    assert.equal(persisted.rollback.restart.length, 0);
    assert.doesNotMatch(JSON.stringify(persisted), /command-line-secret|private-token|private-digest-key/u);
    return true;
  });
  assert.equal(overlayAttempts, 3);
  assert.equal(baseAdapter.calls.filter((row) => row[0] === "restore-file").length, 5);
  assert.equal(baseAdapter.active, false);
  assert.equal(baseAdapter.current, value.targetRoot);
});
