import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductionBypassClosed,
  assertPurposeAllowedForJobStatus,
  assertWritableAuthoritySource,
  consumeTransportActionAuthorization,
  issueTransportActionAuthorization,
  TRANSPORT_AUTH_KINDS,
} from "../scripts/lib/transport-action-authorization.mjs";
import {
  createAuthorizedTypedTransport,
  createFakeTypedTransport,
} from "../scripts/lib/typed-transport.mjs";

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

test("production bypass cannot mint write transport authority", () => {
  assert.throws(
    () => assertProductionBypassClosed({ env: { XHS_ALLOW_BYPASS: "1" }, purpose: "execute" }),
    (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
  );
  assert.doesNotThrow(() => assertProductionBypassClosed({
    env: { XHS_ALLOW_BYPASS: "1" },
    purpose: "observe",
  }));
});

test("authorized TypedTransport consumes before underlying invoke", async () => {
  const { authorization, token } = issueJob();
  const calls = [];
  let stored = authorization;
  const transport = createAuthorizedTypedTransport({
    consume: (args) => {
      stored = consumeTransportActionAuthorization({
        stored,
        token: args.token,
        expectedPurpose: args.expectedPurpose,
        expectedDeviceId: args.expectedDeviceId,
        expectedLeaseId: args.expectedLeaseId,
      });
      return stored;
    },
    underlyingInvoke: async (req) => {
      calls.push(req);
      return { ok: true };
    },
  });
  await transport.invoke({
    purpose: "execute",
    action: "tap",
    transportToken: token,
    deviceId: "dev_1",
    leaseId: "lease_1",
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => transport.invoke({
      purpose: "execute",
      action: "tap",
      transportToken: token,
      deviceId: "dev_1",
      leaseId: "lease_1",
    }),
    (e) => e.code === "TRANSPORT_AUTH_REPLAY",
  );
  assert.equal(calls.length, 1);
});

test("fake TypedTransport rejects missing purpose", async () => {
  const fake = createFakeTypedTransport();
  await assert.rejects(() => fake.invoke({ action: "x" }), (e) => e.code === "TYPED_TRANSPORT_PURPOSE");
});
