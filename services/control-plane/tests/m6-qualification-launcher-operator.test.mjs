import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
  createM6QualificationArtifactPublisher,
  createM6QualificationReceiptWriter,
  executeM6QualificationLauncher,
  M6_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  M6_QUALIFICATION_LAUNCHER_BINDING_SCHEMA_ID,
  M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID,
  M6_QUALIFICATION_TASK_NAME,
  parseM6QualificationLauncherCommand,
  planM6QualificationLauncher,
  preflightM6QualificationLauncher,
  statusM6QualificationLauncher,
  stopM6QualificationLauncher,
} from "../ops/m6-qualification-launcher-operator.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const RELEASE_ID = "xw-xhs-v3-qualification-fixture";
const SOURCE_COMMIT = "a".repeat(40);
const TRUSTED_NODE_PATH = "D:\\Program Files\\Node\\node.exe";
const FIXTURE_SECRETS = Object.freeze({
  provider: "provider-secret-never-print",
  gate: "gate-secret-1234567890-abcdefghijklmnopqrstuvwxyz",
  live: "live-secret-1234567890-abcdefghijklmnopqrstuvwxyz",
  account: "8".repeat(64),
});
const RELEASE_PATHS = Object.freeze([
  "services/control-plane/ops/m6-qualification-launcher-operator.mjs",
  "services/control-plane/ops/launch-control-plane.ps1",
  "services/control-plane/scripts/xw-control-plane-runtime.ps1",
  "config/runtime/xw-runtime.v1.json",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

const noopTcb = Object.freeze({
  protect: () => Object.freeze({ ok: true }),
  verify: () => Object.freeze({ ok: true }),
});

function fixturePrivateInspector({ runtimeRoot }) {
  const path = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  return {
    secretEnvironment: {
      path,
      sha256: sha256(readFileSync(path)),
      requiredEnvironment: Object.freeze({}),
    },
  };
}

function materializeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-qualification-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const releaseRoot = join(runtimeRoot, "releases", RELEASE_ID);
  mkdirSync(releaseRoot, { recursive: true });
  for (const releasePath of RELEASE_PATHS) {
    const source = join(REPO_ROOT, ...releasePath.split("/"));
    const target = join(releaseRoot, ...releasePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const files = RELEASE_PATHS.map((path) => ({
    path,
    gitMode: "100644",
    gitBlobOid: "b".repeat(40),
    sha256: sha256(readFileSync(join(releaseRoot, ...path.split("/")))),
  }));
  const manifest = {
    schemaId: "xw.runtime.release-manifest.v1",
    releaseId: RELEASE_ID,
    sourceRepo: "gifted-professor/xw-platform",
    sourceCommit: SOURCE_COMMIT,
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
  const manifestPath = join(releaseRoot, "release-manifest.v1.json");
  write(manifestPath, canonicalJson(manifest));
  const releaseManifestSha256 = sha256(readFileSync(manifestPath));
  const secretsPath = join(runtimeRoot, "secrets", "control-plane-secret-environment.v1.json");
  write(secretsPath, canonicalJson({
    schemaId: "xw.runtime.control-plane-secret-environment.v1",
    variables: {
      DEEPSEEK_API_KEY: FIXTURE_SECRETS.provider,
      XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: FIXTURE_SECRETS.account,
      XW_M6_GATE_F_OPERATIONS_TOKEN: FIXTURE_SECRETS.gate,
      XW_M6_LIVE_ENTRY_TOKEN: FIXTURE_SECRETS.live,
    },
  }));
  const gateIssuerPath = join(runtimeRoot, "m6-gate", "issuer-keys.json");
  write(gateIssuerPath, canonicalJson({ schemaId: "fixture.issuer-keys.v1", issuers: [] }));
  const qualificationBindingPath = join(
    runtimeRoot,
    "config",
    "m6-c1-qualification-bootstrap.v1.json",
  );
  write(qualificationBindingPath, canonicalJson({
    schemaId: "xw.runtime.m6-c1-qualification-bootstrap.v1",
    releaseId: RELEASE_ID,
    sourceCommit: SOURCE_COMMIT,
    sourceReleaseRoot: releaseRoot,
    releaseManifestSha256,
    gateId: "m6-gate-f",
    gateIssuerAllowlistPath: gateIssuerPath,
    gateFArtifactInventoryPath: join(
      runtimeRoot,
      "qualification-bootstrap",
      "final-inventory-unavailable.json",
    ),
    gateFArtifactInventoryHash: M6_QUALIFICATION_INVENTORY_SENTINEL_HASH,
  }));
  const currentPath = join(runtimeRoot, "current");
  symlinkSync(releaseRoot, currentPath, process.platform === "win32" ? "junction" : "dir");
  const executingOperatorPath = join(
    releaseRoot,
    "services",
    "control-plane",
    "ops",
    "m6-qualification-launcher-operator.mjs",
  );
  const options = {
    runtimeRoot,
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: SOURCE_COMMIT,
    executingOperatorPath,
    privateMaterialInspector: fixturePrivateInspector,
    trustedNodeInspector: () => ({
      path: TRUSTED_NODE_PATH,
      sha256: "f".repeat(64),
      version: "24.11.1",
    }),
    tcbProvisionReceiptVerifier: () => ({
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      receiptHash: "9".repeat(64),
    }),
    tcbAclController: noopTcb,
  };
  return { root, runtimeRoot, releaseRoot, manifestPath, qualificationBindingPath, options };
}

function planFixture(t) {
  const fixture = materializeFixture(t);
  return { ...fixture, plan: planM6QualificationLauncher(fixture.options) };
}

test("qualification launcher preflight fails closed when the current-closure TCB receipt is absent", (t) => {
  const fixture = materializeFixture(t);
  assert.throws(() => planM6QualificationLauncher({
    ...fixture.options,
    tcbProvisionReceiptVerifier: () => null,
  }), { code: "M6_QUALIFICATION_LAUNCHER_PREFLIGHT_INVALID" });
});

function taskXml(plan) {
  const bytes = plan.artifacts.find((artifact) => artifact.kind === "task-xml").bytes;
  assert.equal(bytes[0], 0xff, "task XML must carry a UTF-16 LE BOM");
  return bytes.subarray(2).toString("utf16le");
}

function bindingValue(plan) {
  return JSON.parse(plan.artifacts.find((artifact) => artifact.kind === "binding").bytes.toString("utf8"));
}

function createReceiptSink(root) {
  const bodies = [];
  return {
    bodies,
    writer(body) {
      bodies.push(structuredClone(body));
      const receiptHash = sha256(`${body.operation}:${body.observedAt}:${bodies.length}`);
      return {
        path: join(root, `${receiptHash}.json`),
        sha256: "1".repeat(64),
        receiptHash,
        value: Object.freeze({ ...body, receiptHash }),
      };
    },
  };
}

function createTaskAdapter(plan) {
  const calls = [];
  let qualification = { exists: false, state: "ABSENT", lastTaskResult: null, xml: null };
  const formal = { exists: true, state: "READY", lastTaskResult: 0, xml: "<Task />" };
  return {
    calls,
    inspectFixedListeners() {
      calls.push(["inspect-fixed-listeners"]);
      return { host: "127.0.0.1", ports: [17920, 17930], listeners: [] };
    },
    inspect(name) {
      calls.push(["inspect", name]);
      return name === M6_QUALIFICATION_TASK_NAME ? structuredClone(qualification) : structuredClone(formal);
    },
    register({ taskName, xmlPath }) {
      calls.push(["register", taskName, xmlPath]);
      qualification = { exists: true, state: "READY", lastTaskResult: 0, xml: taskXml(plan) };
    },
    run(name) {
      calls.push(["run", name]);
      qualification = { ...qualification, state: "RUNNING" };
    },
    end(name) {
      calls.push(["end", name]);
      qualification = { ...qualification, state: "READY" };
    },
    delete(name) {
      calls.push(["delete", name]);
      qualification = { exists: false, state: "ABSENT", lastTaskResult: null, xml: null };
    },
  };
}

test("qualification plan binds release, runtime binding and private authority hashes without token bytes", (t) => {
  const { plan, runtimeRoot, releaseRoot } = planFixture(t);
  const binding = bindingValue(plan);
  assert.equal(binding.schemaId, M6_QUALIFICATION_LAUNCHER_BINDING_SCHEMA_ID);
  assert.equal(binding.releaseId, RELEASE_ID);
  assert.equal(binding.sourceCommit, SOURCE_COMMIT);
  assert.equal(binding.releaseRoot, releaseRoot);
  assert.equal(binding.runtimeRoot, runtimeRoot);
  assert.equal(binding.accountIsolationBindingHash, FIXTURE_SECRETS.account);
  assert.equal(binding.gateOperationsTokenSha256, sha256(FIXTURE_SECRETS.gate));
  assert.equal(binding.qualificationRuntimeBindingSha256, plan.qualificationRuntimeBinding.sha256);
  assert.match(plan.binding.path.replaceAll("\\", "/"), new RegExp(
    `/qualification-launcher-bindings/${plan.binding.sha256}/control-plane-launcher-binding\\.v1\\.json$`,
    "u",
  ));
  const serialized = plan.artifacts.map((artifact) => artifact.bytes.toString("utf8")).join("\n");
  assert.equal(serialized.includes(FIXTURE_SECRETS.gate), false);
  assert.equal(serialized.includes(FIXTURE_SECRETS.provider), false);
  assert.equal(serialized.includes(FIXTURE_SECRETS.live), false);
});

test("qualification task is SYSTEM Highest, triggerless and exposes only the fixed qualification launcher", (t) => {
  const { plan, runtimeRoot } = planFixture(t);
  const xml = taskXml(plan);
  assert.match(xml, /<UserId>SYSTEM<\/UserId>/u);
  assert.doesNotMatch(xml, /<LogonType>/u);
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/u);
  assert.match(xml, /<Triggers \/>/u);
  assert.match(xml, /-Mode QUALIFICATION_ONLY/u);
  assert.match(xml, new RegExp(`-ExpectedReleaseId ${RELEASE_ID}`, "u"));
  assert.match(xml, new RegExp(`-ExpectedSourceCommit ${SOURCE_COMMIT}`, "u"));
  assert.match(xml, new RegExp(plan.binding.sha256, "u"));
  assert.match(xml, new RegExp(runtimeRoot.replaceAll("\\", "\\\\"), "u"));
  assert.doesNotMatch(xml, /InteractiveToken|BootTrigger|TimeTrigger|\.simple/iu);
  const argumentsText = /<Arguments>([\s\S]*?)<\/Arguments>/u.exec(xml)?.[1] ?? "";
  assert.doesNotMatch(argumentsText, /https?:|DEEPSEEK|LIVE_ENTRY|GATE_F_OPERATIONS_TOKEN|ACCOUNT_ISOLATION_BINDING_HASH/iu);
  for (const secret of Object.values(FIXTURE_SECRETS)) assert.equal(xml.includes(secret), false);
});

test("fixed command parser rejects caller paths, endpoints, tokens and free-form options", () => {
  assert.deepEqual(
    parseM6QualificationLauncherCommand(["execute-fixed", RELEASE_ID, SOURCE_COMMIT]),
    { operation: "execute", releaseId: RELEASE_ID, sourceCommit: SOURCE_COMMIT },
  );
  for (const argv of [
    ["execute-fixed", RELEASE_ID, SOURCE_COMMIT, "--runtime-root=C:\\tmp"],
    ["preflight", RELEASE_ID, SOURCE_COMMIT],
    ["status-fixed", "C:\\runtime", SOURCE_COMMIT],
    ["stop-fixed", RELEASE_ID, "https://example.invalid"],
    ["execute-fixed", RELEASE_ID, SOURCE_COMMIT, FIXTURE_SECRETS.gate],
  ]) assert.throws(() => parseM6QualificationLauncherCommand(argv), /M6_QUALIFICATION_ARGUMENT_INVALID/u);
});

test("preflight, execute, status and stop emit receipts around one exact SYSTEM task lifecycle", async (t) => {
  const { plan, root } = planFixture(t);
  const adapter = createTaskAdapter(plan);
  const receiptSink = createReceiptSink(root);
  const published = [];
  const options = {
    plan,
    adapter,
    publisher: (artifact) => published.push(artifact.kind),
    receiptWriter: receiptSink.writer,
    now: () => Date.parse("2026-08-30T08:00:00.000Z"),
    waitOptions: { timeoutMs: 100, pollMs: 1 },
  };
  const preflight = await preflightM6QualificationLauncher(options);
  assert.equal(preflight.value.outcome, "READY");
  assert.deepEqual(published, []);
  const execute = await executeM6QualificationLauncher(options);
  assert.equal(execute.value.outcome, "RUNNING");
  assert.deepEqual(published, ["launcher", "binding", "task-xml"]);
  const status = await statusM6QualificationLauncher(options);
  assert.equal(status.value.task.state, "RUNNING");
  const stop = await stopM6QualificationLauncher(options);
  assert.equal(stop.value.outcome, "STOPPED_AND_UNREGISTERED");
  assert.deepEqual(receiptSink.bodies.map((body) => body.operation), [
    "preflight", "execute", "status", "stop",
  ]);
  for (const body of receiptSink.bodies) {
    assert.equal(body.schemaId, M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID);
    assert.equal(body.task.name, M6_QUALIFICATION_TASK_NAME);
    assert.equal(body.task.principal, "SYSTEM");
    assert.equal(body.task.runLevel, "HighestAvailable");
    assert.equal(body.task.triggerCount, 0);
    assert.deepEqual(body.listenerQuiescence.ports, [17920, 17930]);
    assert.equal(JSON.stringify(body).includes(FIXTURE_SECRETS.gate), false);
  }
  assert.ok(adapter.calls.some((row) => row[0] === "register"));
  assert.ok(adapter.calls.some((row) => row[0] === "run"));
  assert.ok(adapter.calls.some((row) => row[0] === "end"));
  assert.ok(adapter.calls.some((row) => row[0] === "delete"));
});

test("execute removes a just-created task when Task Scheduler returns a rebound XML", async (t) => {
  const { plan, root } = planFixture(t);
  let qualification = { exists: false, state: "ABSENT", lastTaskResult: null, xml: null };
  const calls = [];
  const adapter = {
    inspectFixedListeners() {
      return { host: "127.0.0.1", ports: [17920, 17930], listeners: [] };
    },
    inspect(name) {
      return name === M6_QUALIFICATION_TASK_NAME
        ? structuredClone(qualification)
        : { exists: true, state: "READY", lastTaskResult: 0, xml: "<Task />" };
    },
    register() {
      calls.push("register");
      qualification = {
        exists: true,
        state: "READY",
        lastTaskResult: 0,
        xml: taskXml(plan).replace("HighestAvailable", "LeastPrivilege"),
      };
    },
    run() { calls.push("run"); },
    end() { calls.push("end"); qualification = { ...qualification, state: "READY" }; },
    delete() {
      calls.push("delete");
      qualification = { exists: false, state: "ABSENT", lastTaskResult: null, xml: null };
    },
  };
  await assert.rejects(() => executeM6QualificationLauncher({
    plan,
    adapter,
    publisher: () => {},
    receiptWriter: createReceiptSink(root).writer,
    now: () => Date.parse("2026-08-30T08:00:00.000Z"),
  }), /M6_QUALIFICATION_TASK_IDENTITY_INVALID/u);
  assert.deepEqual(calls, ["register", "end", "delete"]);
});

test("task Ready plus a detached 17920/17930 listener fails preflight and execute without killing it", async (t) => {
  const { plan, root } = planFixture(t);
  for (const port of [17920, 17930]) {
    const adapter = createTaskAdapter(plan);
    adapter.inspectFixedListeners = () => ({
      host: "127.0.0.1",
      ports: [17920, 17930],
      listeners: [{ localAddress: "127.0.0.1", port, owningProcess: 4242 }],
    });
    const published = [];
    const options = {
      plan,
      adapter,
      publisher: (artifact) => published.push(artifact.kind),
      receiptWriter: createReceiptSink(root).writer,
      now: () => Date.parse("2026-08-30T08:00:00.000Z"),
    };
    await assert.rejects(
      () => preflightM6QualificationLauncher(options),
      /M6_QUALIFICATION_LISTENER_NOT_QUIESCENT/u,
    );
    await assert.rejects(
      () => executeM6QualificationLauncher(options),
      /M6_QUALIFICATION_LISTENER_NOT_QUIESCENT/u,
    );
    assert.deepEqual(published, []);
    assert.equal(adapter.calls.some((row) => ["register", "run", "end", "delete"].includes(row[0])), false);
  }
});

test("artifact and operation receipts are content-addressed, ACL-sealed and never overwritten", (t) => {
  const { runtimeRoot } = materializeFixture(t);
  const protectedPaths = [];
  const tcbAclController = {
    protect(plan) { protectedPaths.push(plan.targetPath); },
    verify: () => {},
  };
  const publisher = createM6QualificationArtifactPublisher({ runtimeRoot, tcbAclController });
  const bytes = Buffer.from("qualification-artifact\n", "utf8");
  const digest = sha256(bytes);
  const path = join(runtimeRoot, "qualification-launcher", "fixtures", digest, "artifact.txt");
  const first = publisher({ path, sha256: digest, bytes });
  assert.equal(first.reused, false);
  const second = publisher({ path, sha256: digest, bytes });
  assert.equal(second.reused, true);
  assert.equal(protectedPaths.includes(path), true);
  writeFileSync(path, "drift\n");
  assert.throws(
    () => publisher({ path, sha256: digest, bytes }),
    /M6_QUALIFICATION_CREATE_ONLY_CONFLICT/u,
  );

  const receiptPublisher = createM6QualificationArtifactPublisher({ runtimeRoot, tcbAclController });
  const receiptWriter = createM6QualificationReceiptWriter({ runtimeRoot, publisher: receiptPublisher });
  const body = {
    schemaId: M6_QUALIFICATION_OPERATION_RECEIPT_SCHEMA_ID,
    operation: "status",
    observedAt: "2026-08-30T08:00:00.000Z",
    outcome: "ABSENT",
  };
  const receipt = receiptWriter(body);
  assert.match(receipt.path.replaceAll("\\", "/"), new RegExp(
    `/qualification-launcher/receipts/${receipt.receiptHash}/m6-qualification-control-plane-operation-receipt\\.v1\\.json$`,
    "u",
  ));
  assert.deepEqual(JSON.parse(readFileSync(receipt.path, "utf8")), receipt.value);
});

test("tracked PowerShell launcher keeps FINAL delegation and seals the qualification authority", () => {
  const source = readFileSync(
    join(REPO_ROOT, "services", "control-plane", "ops", "launch-control-plane.ps1"),
    "utf8",
  );
  for (const marker of [
    '[ValidateSet("FINAL", "QUALIFICATION_ONLY")]',
    "M6_QUALIFICATION_SYSTEM_IDENTITY_REQUIRED",
    "Import-QualificationPrivateMaterial",
    "gateOperationsTokenSha256",
    "accountIsolationBindingHash",
    '"-Mode", "QUALIFICATION_ONLY"',
    '"-Mode", "FINAL"',
    "M6_QUALIFICATION_DELEGATE_SECRET_OUTPUT_FORBIDDEN",
  ]) assert.equal(source.includes(marker), true, marker);
  assert.doesNotMatch(source, /Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|schtasks(?:\.exe)?/iu);
});

test("PS 5.1 scripts stay ASCII-only (no-BOM files are misread as ANSI)", () => {
  for (const relative of [
    ["services", "control-plane", "ops", "launch-control-plane.ps1"],
    ["services", "control-plane", "scripts", "xw-control-plane-runtime.ps1"],
    ["services", "control-plane", "scripts", "control-plane-task.ps1"],
    ["services", "control-plane", "scripts", "control-plane-worker.ps1"],
  ]) {
    const source = readFileSync(join(REPO_ROOT, ...relative), "utf8");
    assert.doesNotMatch(
      source,
      /[^\x00-\x7F]/u,
      `${relative} must be ASCII-only: PS 5.1 reads UTF-8-no-BOM as ANSI and a single non-ASCII char corrupts param binding`,
    );
  }
});
