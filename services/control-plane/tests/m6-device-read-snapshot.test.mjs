import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import {
  M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID,
  M64_DEVICE_READ_TICKET_SCHEMA_ID,
  M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
  M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID,
  canonicalM64SignedDeviceReadRequestBytes,
  createM64DeviceReadSnapshotSurface,
  deriveM64ObservedStateHash,
  validateM64DeviceReadSnapshot,
} from "../control-plane/lib/m6-device-read-snapshot.mjs";
import { deriveM64ObservationRequestHash } from "../control-plane/lib/m6-live-production-dependencies.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { createControlServer } from "../control-plane/server.mjs";

const H = (value) => sha256(`test:${value}`);
const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const RESET = ["return_to_feed", "dismiss_keyboard"];

function request() {
  const authority = {
    purpose: "M6_4_ACTION_SMOKE",
    manifestHash: H("manifest"),
    scenarioKey: "m6_4_action_smoke-01",
    primaryFamily: "xhs-search",
    oracleHash: H("oracle"),
    effectBoundaryHash: H("boundary"),
    environmentAttestationHash: H("environment"),
    accountIsolationHash: H("account"),
    expectedArtifactHash: H("expectation"),
    independentAuthorHash: H("author"),
    phase: "after",
  };
  const base = {
    schemaId: M64_OBSERVATION_WORK_REQUEST_SCHEMA_ID,
    ...authority,
    expectedStateHash: null,
    requestHash: deriveM64ObservationRequestHash(authority),
  };
  return Object.freeze({
    ...base,
    expectedStateHash: deriveM64ObservedStateHash({ request: base, observedEffects: [], resetObligations: RESET }),
  });
}

function signed(ticket, privateKey, keyId = "observation-observer-01") {
  const unsigned = {
    schemaId: M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID,
    observerKeyId: keyId,
    signatureAlgorithm: "Ed25519",
    requestHash: ticket.request.requestHash,
    ticketHash: ticket.ticketHash,
  };
  return {
    ...unsigned,
    signature: sign(null, canonicalM64SignedDeviceReadRequestBytes(unsigned), privateKey).toString("base64"),
  };
}

test("pending signed request captures on the supplied active-run callback exactly once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "m64-device-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  let clock = NOW;
  let captures = 0;
  const surface = createM64DeviceReadSnapshotSurface({
    workRoot: root,
    observerKeyId: "observation-observer-01",
    observerPublicKey: keys.publicKey,
    now: () => clock,
  });
  const work = request();
  const registration = {
    authority: work,
    expectation: work,
    phase: work.phase,
    gateEpochHash: H("active-gate"),
    resetObligations: RESET,
    capture: async () => {
      captures += 1;
      return {
        gateEpochHash: H("active-gate"),
        frameRef: H("frame"),
        evidenceSha256: H("frame-manifest"),
        capturedAt: new Date(clock).toISOString(),
      };
    },
  };
  const ticket = surface.register(registration);
  assert.equal(ticket.schemaId, M64_DEVICE_READ_TICKET_SCHEMA_ID);
  const persisted = JSON.parse(readFileSync(join(root, `${work.requestHash}.work-request.json`), "utf8"));
  assert.equal(canonicalJson(persisted), canonicalJson(ticket));
  const restarted = createM64DeviceReadSnapshotSurface({
    workRoot: root,
    observerKeyId: "observation-observer-01",
    observerPublicKey: keys.publicKey,
    now: () => clock,
  });
  assert.equal(restarted.register(registration).ticketHash, ticket.ticketHash);
  const snapshot = await restarted.consume(signed(ticket, keys.privateKey));
  assert.equal(captures, 1);
  assert.equal(snapshot.actionCount, 0);
  assert.equal(snapshot.transportCount, 0);
  assert.equal(snapshot.actualStateHash, work.expectedStateHash);
  assert.equal(validateM64DeviceReadSnapshot(snapshot, { request: work, maxAgeMs: 30_000, nowMs: clock }).sourceKind, "DEVICE_READ_SNAPSHOT");
  restarted.complete(work.requestHash);
  await assert.rejects(restarted.consume(signed(ticket, keys.privateKey)), { code: "M64_DEVICE_READ_REQUEST_NOT_PENDING" });
  assert.throws(() => restarted.register(registration), { code: "M64_DEVICE_READ_WORK_TERMINAL" });
  assert.equal(captures, 1);
});

test("surface rejects forged, non-pending, and expired signed work without capture", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "m64-device-snapshot-negative-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  let clock = NOW;
  let captures = 0;
  const surface = createM64DeviceReadSnapshotSurface({
    workRoot: root,
    observerKeyId: "observation-observer-01",
    observerPublicKey: keys.publicKey,
    maxAgeMs: 100,
    now: () => clock,
  });
  const work = request();
  const ticket = surface.register({
    authority: work, expectation: work, phase: work.phase, gateEpochHash: H("gate"), resetObligations: RESET,
    capture: async () => { captures += 1; },
  });
  await assert.rejects(surface.consume(signed(ticket, attacker.privateKey)), { code: "M64_SIGNED_DEVICE_READ_REQUEST_SIGNATURE_INVALID" });
  assert.equal(captures, 0);
  clock += 101;
  await assert.rejects(surface.consume(signed(ticket, keys.privateKey)), { code: "M64_DEVICE_READ_REQUEST_STALE_OR_REPLAY" });
  const unknown = { ...signed(ticket, keys.privateKey), requestHash: H("unknown") };
  await assert.rejects(surface.consume(unknown), { code: "M64_DEVICE_READ_REQUEST_NOT_PENDING" });
  assert.equal(captures, 0);
});

test("router exposes only the exact POST device-read snapshot surface", async () => {
  const accepted = { schemaId: M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID, requestHash: H("request") };
  let received = null;
  const router = new ControlRouter({
    control: {}, state: {}, capabilities: {}, evidence: {},
    m6DeviceReadSnapshot: {
      consume: async (value) => {
        received = value;
        return { schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID, requestHash: value.requestHash };
      },
    },
  });
  const response = await router.handle({
    method: "POST", path: "/control/v1/m6/device-read-snapshot", body: accepted,
  });
  assert.equal(received, accepted);
  assert.deepEqual(response, {
    status: 200,
    body: { snapshot: { schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID, requestHash: accepted.requestHash } },
  });
  await assert.rejects(
    router.handle({ method: "GET", path: "/control/v1/m6/device-read-snapshot" }),
    { code: "M6_FACADE_UNAVAILABLE" },
  );
});

test("HTTP server preserves the signed request body and snapshot response contract", async (t) => {
  const requestHash = H("http-request");
  let received = null;
  const router = new ControlRouter({
    control: {}, state: {}, capabilities: {}, evidence: {},
    m6DeviceReadSnapshot: {
      consume: async (value) => {
        received = value;
        return { schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID, requestHash };
      },
    },
  });
  const server = createControlServer({ router });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = { schemaId: M64_SIGNED_DEVICE_READ_REQUEST_SCHEMA_ID, requestHash };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/control/v1/m6/device-read-snapshot`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, payload);
  assert.deepEqual(await response.json(), {
    snapshot: { schemaId: M64_DEVICE_READ_SNAPSHOT_SCHEMA_ID, requestHash },
  });
});
