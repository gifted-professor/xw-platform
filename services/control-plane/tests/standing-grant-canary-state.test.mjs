import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../control-plane/lib/state-store.mjs";

test("one-time collect canary marker survives restart and blocks every retry after ambiguity", () => {
  const root = mkdtempSync(join(tmpdir(), "standing-grant-canary-"));
  const dbPath = join(root, "control.db");
  let state = new StateStore({ dbPath });
  try {
    state.reserveStandingGrantCanary({ idempotencyKey: "preflight-only", grantId: "grant-1", sourceJobId: "observe-0" });
    assert.equal(state.releaseStandingGrantCanaryReservation({ idempotencyKey: "preflight-only" }).released, true);
    const reserved = state.reserveStandingGrantCanary({ idempotencyKey: "canary-1", grantId: "grant-1", sourceJobId: "observe-1" });
    assert.equal(reserved.reused, false);
    state.bindStandingGrantCanary({ missionId: "mission-1", deviceRunId: "device-run-1", collectJobId: "collect-1" });
    state.finishStandingGrantCanary({ status: "ambiguous", outcome: "ADAPTER_TIMEOUT" });
    state.close();
    state = new StateStore({ dbPath });
    assert.equal(state.getStandingGrantCanary().status, "ambiguous");
    assert.throws(() => state.reserveStandingGrantCanary({ idempotencyKey: "canary-2", grantId: "grant-1", sourceJobId: "observe-2" }), { code: "CANARY_ALREADY_RESERVED" });
    assert.equal(state.reserveStandingGrantCanary({ idempotencyKey: "canary-1", grantId: "grant-1", sourceJobId: "observe-1" }).reused, true);
  } finally {
    try { state.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
