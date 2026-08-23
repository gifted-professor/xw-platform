import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  requestM64TargetEnvironmentQualificationJob,
  runM64TargetEnvironmentQualification,
  writeM64TargetEnvironmentQualificationArtifacts,
} from "../apps/xiaowei/m6-target-environment-qualification-runtime.mjs";
import {
  M6_TARGET_ENVIRONMENT_READS,
  collectM64TargetEnvironmentQualification,
  deriveM64TargetEnvironmentCommandRegistryHash,
} from "../apps/xiaowei/m6-target-environment-qualification.mjs";
import { main as qualificationCliMain } from "../../../tools/m6/m6-4-target-environment-qualification.mjs";

const H = (character) => character.repeat(64);
const ACCOUNT_BINDING_HASH = H("a");
const CONTROL_TOKEN = "gate-f-status-token-with-more-than-32-bytes";
const PRIVATE_RUNTIME = "SERIAL-ALIAS01-PRIVATE-DO-NOT-LEAK";
const CONTROL_PLANE_URL = "http://127.0.0.1:17920/";

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-env-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function closedGate(overrides = {}) {
  return {
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: "CLOSED",
    phase: "CLOSED",
    purpose: null,
    epochHash: H("b"),
    generation: 9,
    locksHash: H("c"),
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 0,
    actionCount: 0,
    resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
    ...overrides,
  };
}

function gateFetch(snapshots, events = []) {
  let index = 0;
  return async (url, options) => {
    events.push({ type: "gate", url: String(url), options });
    const gate = snapshots[Math.min(index, snapshots.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      url: "http://127.0.0.1:17920/control/v1/internal/m6/gate-f/status",
      async json() { return { gate }; },
    };
  };
}

function fixtureTransport(events = []) {
  const names = Object.keys(M6_TARGET_ENVIRONMENT_READS);
  const commandNames = new Map(Object.entries(M6_TARGET_ENVIRONMENT_READS).map(([name, command]) => [command, name]));
  const calls = [];
  let index = 0;
  return {
    calls,
    async runExclusive(callback) {
      events.push({ type: "exclusive-start" });
      const result = await callback({
        async invoke(request) {
          calls.push(structuredClone(request));
          events.push({ type: "device-read" });
          assert.equal(request.action, "adb_shell");
          assert.equal(request.devices, PRIVATE_RUNTIME);
          const name = commandNames.get(request.data?.command);
          assert.ok(name, "only a frozen read command may reach the transport");
          index += 1;
          assert.ok(index <= names.length * 2);
          return { data: { [PRIVATE_RUNTIME]: `${name}-stable` } };
        },
      });
      events.push({ type: "exclusive-end" });
      return result;
    },
  };
}

function qualificationJob(events = [], transport = fixtureTransport(events)) {
  return async ({ gateSnapshot, accountIsolationBindingHash, now }) => {
    events.push({ type: "qualification-job", gateSnapshot });
    const result = await collectM64TargetEnvironmentQualification({
      transport,
      serial: PRIVATE_RUNTIME,
      alias: "01",
      gateMode: gateSnapshot.mode,
      accountIsolationBindingHash,
      now,
    });
    return { jobId: "job-m6-env-test", runId: "run-m6-env-test", ...result };
  };
}

test("default preflight is local-only and performs no network, job, device transport, or write", async (t) => {
  const root = makeRoot(t);
  const artifactRoot = join(root, "must-not-exist");
  const result = await runM64TargetEnvironmentQualification({
    execute: false,
    artifactRoot,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    fetchImpl: async () => { throw new Error("network must remain at zero"); },
    jobClient: () => { throw new Error("job/device path must remain at zero"); },
    artifactWriter: () => { throw new Error("writer must remain at zero"); },
  });
  assert.deepEqual(result, {
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    actionCount: 0,
  });
  assert.equal(existsSync(artifactRoot), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE_RUNTIME, "u"));
  await assert.rejects(() => runM64TargetEnvironmentQualification({
    execute: false,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    controlPlaneUrl: "http://example.invalid/",
    fetchImpl: async () => { throw new Error("network must remain at zero"); },
  }), { code: "M6_ENV_CONTROL_PLANE_NOT_LOOPBACK" });
});

test("execute proves CLOSED first, performs the fixed double sample, re-proves the generation, and writes canonical addresses", async (t) => {
  const root = makeRoot(t);
  const artifactRoot = join(root, "runtime-artifacts");
  const events = [];
  const transport = fixtureTransport(events);
  const result = await runM64TargetEnvironmentQualification({
    execute: true,
    artifactRoot,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    controlPlaneUrl: CONTROL_PLANE_URL,
    controlToken: CONTROL_TOKEN,
    fetchImpl: gateFetch([closedGate(), closedGate()], events),
    jobClient: qualificationJob(events, transport),
    now: () => Date.parse("2026-08-23T16:00:00.000Z"),
  });

  assert.equal(events[0].type, "gate");
  assert.equal(events.filter((event) => event.type === "gate").length, 2);
  assert.equal(events.findIndex((event) => event.type === "qualification-job") > 0, true);
  assert.equal(transport.calls.length, Object.keys(M6_TARGET_ENVIRONMENT_READS).length * 2);
  for (const call of transport.calls) {
    assert.deepEqual(Object.keys(call.data), ["command"]);
    assert.doesNotMatch(call.data.command, /\b(?:input|tap|swipe|am start|monkey|force-stop|pm clear)\b/iu);
  }
  for (const event of events.filter((item) => item.type === "gate")) {
    assert.equal(event.url, "http://127.0.0.1:17920/control/v1/internal/m6/gate-f/status");
    assert.equal(event.options.method, "GET");
    assert.equal(event.options.redirect, "error");
    assert.equal(event.options.headers["x-control-token"], CONTROL_TOKEN);
    assert.equal(event.options.body, undefined);
  }

  assert.deepEqual(Object.keys(result).sort(), [
    "actionCount", "attestationHash", "commandRegistryHash", "qualificationHash",
  ]);
  assert.equal(result.actionCount, 0);
  assert.match(result.attestationHash, /^[0-9a-f]{64}$/u);
  assert.match(result.qualificationHash, /^[0-9a-f]{64}$/u);
  const attestationPath = join(artifactRoot, "attestations", `${result.attestationHash}.json`);
  const qualificationPath = join(artifactRoot, "qualifications", `${result.qualificationHash}.json`);
  const attestationBytes = readFileSync(attestationPath);
  const qualificationBytes = readFileSync(qualificationPath);
  const attestation = JSON.parse(attestationBytes);
  const qualification = JSON.parse(qualificationBytes);
  assert.equal(attestationBytes.toString("utf8"), `${canonicalJson(attestation)}\n`);
  assert.equal(qualificationBytes.toString("utf8"), `${canonicalJson(qualification)}\n`);
  assert.equal(sha256(qualificationBytes), result.qualificationHash);
  assert.deepEqual(qualification.qualifiedAttestationHashes, [result.attestationHash]);
  assert.equal(qualification.actionCount, 0);
  assert.doesNotMatch(`${JSON.stringify(result)}\n${attestationBytes}\n${qualificationBytes}`, new RegExp(PRIVATE_RUNTIME, "u"));
  assert.doesNotMatch(`${attestationBytes}\n${qualificationBytes}`, new RegExp(CONTROL_TOKEN, "u"));
  assert.deepEqual(readdirSync(join(artifactRoot, "attestations")), [`${result.attestationHash}.json`]);
  assert.deepEqual(readdirSync(join(artifactRoot, "qualifications")), [`${result.qualificationHash}.json`]);
});

test("production qualifier reaches alias 01 only through one formal canary job and returns no private runtime identity", async () => {
  const capturedAt = Date.parse("2026-08-23T16:00:00.000Z");
  const evidence = await collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(),
    serial: PRIVATE_RUNTIME,
    gateMode: "CLOSED",
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    now: () => capturedAt,
  });
  const requests = [];
  const fetchImpl = async (url, options) => {
    const href = String(url);
    const path = new URL(href).pathname;
    requests.push({ href, path, options });
    let payload;
    if (path === "/control/v1/devices") {
      payload = { devices: [{ deviceId: "public-device-01", alias: "01", online: true, quarantined: false }] };
    } else if (path === "/control/v1/jobs" && options.method === "POST") {
      payload = {
        job: {
          jobId: "job-m6-env-formal",
          runId: "run-m6-env-formal",
          deviceId: "public-device-01",
          capabilityId: "xiaowei.m6.qualify_environment",
          canary: true,
          status: "queued",
        },
      };
    } else if (path === "/control/v1/jobs/job-m6-env-formal") {
      payload = {
        job: {
          jobId: "job-m6-env-formal",
          runId: "run-m6-env-formal",
          deviceId: "public-device-01",
          capabilityId: "xiaowei.m6.qualify_environment",
          canary: true,
          status: "succeeded",
          result: { output: { m6EnvironmentQualification: evidence } },
        },
      };
    } else {
      throw new Error(`unexpected request ${options.method} ${path}`);
    }
    return { ok: true, status: 200, url: href, async json() { return payload; } };
  };
  const result = await requestM64TargetEnvironmentQualificationJob({
    fetchImpl,
    controlPlaneUrl: CONTROL_PLANE_URL,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    gateSnapshot: closedGate(),
    token: CONTROL_TOKEN,
    now: () => capturedAt,
    maxStatusPolls: 2,
    statusPollDelayMs: 0,
    waitForPoll: async () => {},
  });
  assert.equal(result.jobId, "job-m6-env-formal");
  assert.equal(result.attestation.attestationHash, evidence.attestation.attestationHash);
  const submitted = JSON.parse(requests.find((request) => request.path === "/control/v1/jobs").options.body);
  assert.deepEqual(submitted, {
    actorId: "operator:m6-target-environment-qualification",
    capabilityId: "xiaowei.m6.qualify_environment",
    idempotencyKey: submitted.idempotencyKey,
    params: {
      accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
      gateEpochHash: closedGate().epochHash,
      gateGeneration: closedGate().generation,
      gateLocksHash: closedGate().locksHash,
    },
    canary: true,
    deviceId: "public-device-01",
    expectedGateEpochHash: closedGate().epochHash,
    expectedGateGeneration: closedGate().generation,
    expectedGateLocksHash: closedGate().locksHash,
  });
  assert.match(submitted.idempotencyKey, /^m6-env-[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(PRIVATE_RUNTIME, "u"));
  assert.equal(requests.every((request) => request.options.headers["x-control-token"] === CONTROL_TOKEN), true);
});

test("open or fail-closed Gate F rejects before transport construction and leaves no artifacts", async (t) => {
  const root = makeRoot(t);
  const artifactRoot = join(root, "not-created");
  let jobs = 0;
  await assert.rejects(() => runM64TargetEnvironmentQualification({
    execute: true,
    artifactRoot,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    controlToken: CONTROL_TOKEN,
    fetchImpl: gateFetch([closedGate({ mode: "GROUNDED_ACTION", phase: "GROUNDED_ACTION", purpose: "M6_4_ACTION_SMOKE", activeAuthorizationCount: 1 })]),
    jobClient: () => { jobs += 1; throw new Error("must remain unreachable"); },
  }), { code: "M6_ENV_QUALIFICATION_GATE_NOT_CLOSED" });
  assert.equal(jobs, 0);
  assert.equal(existsSync(artifactRoot), false);
});

test("legacy CLOSED status without exact zero resource counts fails closed before transport construction", async (t) => {
  const root = makeRoot(t);
  const artifactRoot = join(root, "not-created");
  const legacyStatus = closedGate();
  delete legacyStatus.resourceCounts;
  let jobs = 0;
  await assert.rejects(() => runM64TargetEnvironmentQualification({
    execute: true,
    artifactRoot,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    controlToken: CONTROL_TOKEN,
    fetchImpl: gateFetch([legacyStatus]),
    jobClient: () => { jobs += 1; throw new Error("must remain unreachable"); },
  }), { code: "M6_ENV_QUALIFICATION_GATE_NOT_CLOSED" });
  assert.equal(jobs, 0);
  assert.equal(existsSync(artifactRoot), false);
});

test("Gate-F generation drift after the read-only sample rejects before artifact persistence", async (t) => {
  const root = makeRoot(t);
  const artifactRoot = join(root, "not-created");
  const first = closedGate();
  const second = closedGate({ epochHash: H("d"), generation: first.generation + 1 });
  await assert.rejects(() => runM64TargetEnvironmentQualification({
    execute: true,
    artifactRoot,
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    controlToken: CONTROL_TOKEN,
    fetchImpl: gateFetch([first, second]),
    jobClient: qualificationJob([], fixtureTransport()),
    now: () => Date.parse("2026-08-23T16:00:00.000Z"),
  }), { code: "M6_ENV_QUALIFICATION_GATE_DRIFT" });
  assert.equal(existsSync(artifactRoot), false);
});

test("artifact writer rejects extra secret-bearing fields and link/junction path escapes", async (t) => {
  const root = makeRoot(t);
  const result = await collectM64TargetEnvironmentQualification({
    transport: fixtureTransport(),
    serial: PRIVATE_RUNTIME,
    gateMode: "CLOSED",
    accountIsolationBindingHash: ACCOUNT_BINDING_HASH,
    now: () => Date.parse("2026-08-23T16:00:00.000Z"),
  });
  await assert.rejects(async () => writeM64TargetEnvironmentQualificationArtifacts({
    artifactRoot: join(root, "secret-reject"),
    attestation: { ...result.attestation, runtimeId: PRIVATE_RUNTIME },
    qualification: result.qualification,
  }), { code: "M6_ENV_ATTESTATION_INVALID" });
  assert.equal(existsSync(join(root, "secret-reject")), false);

  const outside = join(root, "outside");
  const link = join(root, "junction");
  writeFileSync(join(root, "placeholder"), "plain");
  // Directory junctions do not require elevation on Windows. Some restricted
  // test hosts still forbid link creation; that platform limitation is not a
  // product failure and is recorded as a skip.
  try {
    mkdirSyncForTest(outside);
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => writeM64TargetEnvironmentQualificationArtifacts({
    artifactRoot: join(link, "escaped-root"),
    ...result,
  }), { code: "M6_ENV_ARTIFACT_PATH_UNSAFE" });
  assert.equal(existsSync(join(outside, "escaped-root")), false);
});

function mkdirSyncForTest(path) {
  // Kept local so the production module's filesystem surface remains the only
  // code under test; this helper does not enter any runtime API.
  const parent = join(path, "..");
  assert.ok(existsSync(parent));
  return mkdirSync(path);
}

test("CLI main remains dependency-injectable and emits hashes/actionCount only in preflight", async (t) => {
  const root = makeRoot(t);
  let stdout = "";
  const result = await qualificationCliMain([
    "--account-isolation-binding-hash", ACCOUNT_BINDING_HASH,
  ], {
    env: { XW_M6_GATE_F_OPERATIONS_TOKEN: CONTROL_TOKEN },
    fetchImpl: async () => { throw new Error("network must stay unused"); },
    jobClient: () => { throw new Error("job/device path must stay unused"); },
    stdout: { write(value) { stdout += value; } },
  });
  assert.deepEqual(result, {
    commandRegistryHash: deriveM64TargetEnvironmentCommandRegistryHash(),
    actionCount: 0,
  });
  assert.deepEqual(JSON.parse(stdout), result);
  assert.doesNotMatch(stdout, new RegExp(PRIVATE_RUNTIME, "u"));
  assert.doesNotMatch(stdout, new RegExp(CONTROL_TOKEN, "u"));
});
