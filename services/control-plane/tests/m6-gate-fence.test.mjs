import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { canonicalJson, sha256 } from "../control-plane/lib/canonical.mjs";
import { CURRENT_CONTROL_SCHEMA_VERSION, StateStore } from "../control-plane/lib/state-store.mjs";

function closedEpoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate",
    mode: "CLOSED",
    status: "closed",
    releaseId: "release-v19-test",
    sourceCommit: "a".repeat(40),
    actor: "operator:test",
    lockHashes: {
      runtimeProfile: "1".repeat(64),
      hardRedlinePolicy: "2".repeat(64),
      groundingRuntime: "3".repeat(64),
    },
    allowlist: ["01"],
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-02T00:00:00Z",
    parentEpochHash: null,
    closeoutRef: { id: "close", sha256: "4".repeat(64) },
    aggregateSealRef: { id: "aggregate", sha256: "5".repeat(64) },
    rollbackTargetEpochHash: null,
    ...overrides,
  };
  return { ...raw, epochHash: sha256(`xw.m6-live-gate.v1:${canonicalJson(raw)}`) };
}

test("v19 migration creates an empty fence and seeds generation 0 only from a self-hashed v1 CLOSED tail", () => {
  const root = mkdtempSync(join(tmpdir(), "m6-fence-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    assert.equal(CURRENT_CONTROL_SCHEMA_VERSION, 19);
    assert.equal(state.db.prepare("PRAGMA user_version").get().user_version, 19);
    assert.equal(state.getM6GateFence(), null);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ mode: "OBSERVE_ONLY", status: "active" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_SEED_INVALID",
    });
    const epoch = closedEpoch();
    const fence = state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) });
    assert.equal(fence.epochHash, epoch.epochHash);
    assert.equal(fence.generation, 0);
    assert.equal(fence.mode, "CLOSED");
    assert.equal(state.seedM6GateFence({ epoch, locksHash: "6".repeat(64) }).epochHash, epoch.epochHash);
    assert.throws(() => state.seedM6GateFence({ epoch: closedEpoch({ actor: "other" }), locksHash: "6".repeat(64) }), {
      code: "M6_GATE_FENCE_ALREADY_SEEDED",
    });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fence promotion is BEGIN IMMEDIATE CAS and file/DB mismatch fails closed", () => {
  const state = new StateStore();
  try {
    const seed = closedEpoch();
    state.seedM6GateFence({ epoch: seed, locksHash: "6".repeat(64) });
    const next = {
      gateId: seed.gateId,
      epochHash: "7".repeat(64),
      mode: "GROUNDED_ACTION",
      purpose: "M6_4_ACTION_SMOKE",
      allowlist: ["01"],
      expiresAt: "2030-01-01T01:00:00Z",
      releaseId: seed.releaseId,
      sourceCommit: seed.sourceCommit,
      locksHash: "8".repeat(64),
    };
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: "9".repeat(64), expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const consumption = { nonce: "hot-close-nonce", authorizationHash: "d".repeat(64), reasonCode: "SAFETY_STOP" };
    const promoted = state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next, emergencyCloseConsumption: consumption });
    assert.equal(promoted.generation, 1);
    assert.equal(promoted.mode, "GROUNDED_ACTION");
    assert.equal(state.assertM6GateFence(promoted).epochHash, next.epochHash);
    assert.throws(() => state.assertM6GateFence({ ...promoted, generation: 2 }), { code: "M6_GATE_FENCE_MISMATCH" });
    assert.throws(() => state.promoteM6GateFence({ expectedEpochHash: seed.epochHash, expectedGeneration: 0, next }), {
      code: "M6_GATE_FENCE_CAS_MISMATCH",
    });
    const next2 = { ...next, epochHash: "e".repeat(64), mode: "CLOSED", purpose: "M6_4_CLOSEOUT" };
    assert.throws(() => state.promoteM6GateFence({
      expectedEpochHash: next.epochHash,
      expectedGeneration: 1,
      next: next2,
      emergencyCloseConsumption: consumption,
    }), { code: "M6_GATE_EMERGENCY_CLOSE_REPLAY" });
    assert.equal(state.getM6GateFence().generation, 1);
    assert.equal(state.getM6EmergencyCloseConsumption(consumption.nonce).reasonCode, "SAFETY_STOP");
  } finally {
    state.close();
  }
});
