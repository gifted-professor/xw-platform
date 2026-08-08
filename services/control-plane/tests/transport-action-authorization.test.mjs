import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionBypassClosed,
  assertPurposeAllowedForJobStatus,
  assertWritableAuthoritySource,
  consumeTransportActionAuthorization,
  issueTransportActionAuthorization,
  TRANSPORT_AUTH_KINDS,
} from "../control-plane/lib/transport-action-authorization.mjs";

const contract = "a".repeat(64);
const closure = "b".repeat(64);

function issueJob(over = {}) {
  return issueTransportActionAuthorization({
    kind: "capability_job",
    purpose: "execute",
    jobId: "job_1",
    runId: "run_1",
    leaseId: "lease_1",
    deviceId: "dev_1",
    operationKey: "op_1",
    capabilityContractHash: contract,
    implementationClosureHash: closure,
    jobStatus: "running",
    ...over,
  });
}

test("INV-02: only capability_job|mission_device_run kinds are issuable", () => {
  assert.deepEqual([...TRANSPORT_AUTH_KINDS], ["capability_job", "mission_device_run"]);
  assert.throws(
    () => assertWritableAuthoritySource({ kind: "session", purpose: "execute" }),
    (e) => e.code === "TRANSPORT_AUTH_KIND_FORBIDDEN",
  );
});

test("INV-02: session/recovery/bypass cannot mint write authority", () => {
  for (const source of ["session", "explorer", "recovery", "bypass", "lab_bypass"]) {
    assert.throws(
      () => issueJob({ source, purpose: "execute" }),
      (e) => e.code === "TRANSPORT_AUTH_WRITE_FORBIDDEN",
      source,
    );
  }
  // observe (non-write) may still be kind-checked but source gate only blocks write purposes
  const observed = issueJob({ purpose: "observe", jobStatus: "running", source: "session" });
  assert.equal(observed.authorization.purpose, "observe");
});

test("purpose matrix matches job status table", () => {
  assert.throws(
    () => assertPurposeAllowedForJobStatus("execute", "queued"),
    (e) => e.code === "TRANSPORT_AUTH_PURPOSE_STATUS_MISMATCH",
  );
  assert.equal(assertPurposeAllowedForJobStatus("verify", "verifying"), true);
  assert.equal(assertPurposeAllowedForJobStatus("restore", "restoring"), true);
  assert.equal(assertPurposeAllowedForJobStatus("return_home", "restoring"), true);
});

test("nonce is single-consume; replay fails closed", () => {
  const { authorization, token } = issueJob();
  const once = consumeTransportActionAuthorization({
    stored: authorization,
    token,
    expectedPurpose: "execute",
    expectedDeviceId: "dev_1",
    expectedLeaseId: "lease_1",
  });
  assert.ok(once.consumedAt);
  assert.throws(
    () => consumeTransportActionAuthorization({
      stored: once,
      token,
      expectedPurpose: "execute",
      expectedDeviceId: "dev_1",
      expectedLeaseId: "lease_1",
    }),
    (e) => e.code === "TRANSPORT_AUTH_REPLAY",
  );
});

test("expired or wrong nonce/purpose/device fail closed", () => {
  const past = Date.parse("2020-01-01T00:00:00.000Z");
  const { authorization, token } = issueJob({ now: () => past, ttlMs: 1 });
  assert.throws(
    () => consumeTransportActionAuthorization({
      stored: authorization,
      token,
      expectedPurpose: "execute",
      now: () => past + 10_000,
    }),
    (e) => e.code === "TRANSPORT_AUTH_EXPIRED",
  );

  const fresh = issueJob();
  assert.throws(
    () => consumeTransportActionAuthorization({
      stored: fresh.authorization,
      token: { ...fresh.token, nonce: "00".repeat(24) },
      expectedPurpose: "execute",
    }),
    (e) => e.code === "TRANSPORT_AUTH_NONCE_INVALID",
  );
  assert.throws(
    () => consumeTransportActionAuthorization({
      stored: fresh.authorization,
      token: fresh.token,
      expectedPurpose: "verify",
    }),
    (e) => e.code === "TRANSPORT_AUTH_PURPOSE_MISMATCH",
  );
});

test("production bypass cannot mint write transport authority", () => {
  assert.throws(
    () => assertProductionBypassClosed({ env: { XHS_ALLOW_BYPASS: "1" }, purpose: "execute" }),
    (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
  );
  assert.deepEqual(
    assertProductionBypassClosed({ env: { XHS_ALLOW_BYPASS: "1" }, purpose: "observe" }),
    { bypassEnabled: false },
  );
  assert.deepEqual(
    assertProductionBypassClosed({ env: {}, purpose: "execute" }),
    { bypassEnabled: false },
  );
});
