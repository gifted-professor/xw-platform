/**
 * Foundation PR3 — Transport Boundary offline tests (INV-02 / INV-08).
 * No device I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../control-plane/lib/state-store.mjs";
import {
  assertProductionBypassClosed,
  isWritePurpose,
} from "../control-plane/lib/transport-action-authorization.mjs";
import {
  createAuthorizedTypedTransport,
  createFakeTypedTransport,
} from "../control-plane/lib/typed-transport.mjs";
import { requireRecordedLabBypass } from "../control-plane/lib/operator-access.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const contract = "c".repeat(64);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pr3-tauth-"));
  const store = new StateStore({ dbPath: join(dir, "control.db") });
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("user_version is 15 with transport_action_authorizations", async () => {
  await withStore((store) => {
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 15);
    const cols = store.db.prepare("PRAGMA table_info(transport_action_authorizations)").all();
    assert.ok(cols.some((c) => c.name === "nonce_hash"));
    assert.ok(cols.some((c) => c.name === "consumed_at"));
  });
});

test("StateStore persists auth and consume is one-time", async () => {
  await withStore((store) => {
    const issued = store.issueTransportActionAuthorization({
      kind: "capability_job",
      purpose: "execute",
      jobId: "job_pr3",
      runId: "run_pr3",
      leaseId: "lease_pr3",
      deviceId: "dev_pr3",
      operationKey: "op_pr3",
      capabilityContractHash: contract,
      jobStatus: "running",
      source: "capability_job",
    });
    assert.ok(issued.token.nonce);
    assert.ok(issued.authorization.authorizationId);
    assert.equal(issued.authorization.consumedAt, null);

    const once = store.consumeTransportActionAuthorization({
      authorizationId: issued.token.authorizationId,
      token: issued.token,
      expectedPurpose: "execute",
      expectedDeviceId: "dev_pr3",
      expectedLeaseId: "lease_pr3",
    });
    assert.ok(once.consumedAt);

    assert.throws(
      () => store.consumeTransportActionAuthorization({
        authorizationId: issued.token.authorizationId,
        token: issued.token,
        expectedPurpose: "execute",
        expectedDeviceId: "dev_pr3",
        expectedLeaseId: "lease_pr3",
      }),
      (e) => e.code === "TRANSPORT_AUTH_REPLAY",
    );
  });
});

test("authorized TypedTransport consumes before underlying invoke", async () => {
  await withStore(async (store) => {
    const issued = store.issueTransportActionAuthorization({
      kind: "capability_job",
      purpose: "execute",
      jobId: "job_tt",
      runId: "run_tt",
      leaseId: "lease_tt",
      deviceId: "dev_tt",
      operationKey: "op_tt",
      capabilityContractHash: contract,
      jobStatus: "running",
    });
    const calls = [];
    const transport = createAuthorizedTypedTransport({
      consume: (args) => store.consumeTransportActionAuthorization(args),
      underlyingInvoke: async (req) => {
        calls.push(req);
        return { ok: true, action: req.action };
      },
    });
    const out = await transport.invoke({
      purpose: "execute",
      action: "tap",
      transportToken: issued.token,
      deviceId: "dev_tt",
      leaseId: "lease_tt",
    });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "tap");
    assert.equal(calls[0].transportToken, undefined);

    await assert.rejects(
      () => transport.invoke({
        purpose: "execute",
        action: "tap",
        transportToken: issued.token,
        deviceId: "dev_tt",
        leaseId: "lease_tt",
      }),
      (e) => Boolean(e.code),
    );
    assert.equal(calls.length, 1);
  });
});

test("fake TypedTransport rejects missing purpose", async () => {
  const fake = createFakeTypedTransport();
  await assert.rejects(() => fake.invoke({ action: "x" }), (e) => e.code === "TYPED_TRANSPORT_PURPOSE");
});

test("write purposes are closed under XHS_ALLOW_BYPASS", () => {
  for (const purpose of ["execute", "restore", "return_home"]) {
    assert.equal(isWritePurpose(purpose), true);
    assert.throws(
      () => assertProductionBypassClosed({ env: { XHS_ALLOW_BYPASS: "1" }, purpose }),
      (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
    );
  }
  assert.doesNotThrow(() => assertProductionBypassClosed({
    env: { XHS_ALLOW_BYPASS: "1" },
    purpose: "observe",
  }));
});

test("requireRecordedLabBypass: write bypass fail-closed; observe may audit", () => {
  assert.throws(
    () => requireRecordedLabBypass("legacy", {
      env: { XHS_ALLOW_BYPASS: "1", XHS_BYPASS_REASON: "lab" },
      purpose: "execute",
      logger: () => {},
    }),
    (e) => e.code === "TRANSPORT_BYPASS_DISABLED_P0",
  );
  const events = [];
  const result = requireRecordedLabBypass("legacy", {
    env: { XHS_ALLOW_BYPASS: "1", XHS_BYPASS_REASON: "x".repeat(250) },
    purpose: "observe",
    logger: (event) => events.push(event),
  });
  assert.deepEqual(result, { authorized: true, bypass: true, write: false });
  assert.equal(events[0].reason.length, 200);
  assert.equal(events[0].purpose, "observe");
});

test("INV-08: adapter import lint forbids ambient device channels", () => {
  const script = join(root, "scripts", "check-adapter-imports.mjs");
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, true);
});
