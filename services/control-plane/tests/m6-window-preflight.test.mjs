// M6-2 W9 Gate A #4 — window preflight arbiter tests.
// The arbiter decides, before any capture, whether a scenario may run. It must
// refuse a duplicate receipt (the exact-80 invariant forbids skipping), refuse
// a window tag inherited from a tombstoned epoch, and derive the idempotency
// tag from the active epoch hash — never a hardcoded value.
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyScenarioAttempt,
  deriveWindowTag,
  freezeWindowPlan,
  refuseTombstonedTag,
} from "../scripts/lib/m6-window-preflight.mjs";

const EPOCH = "fe4be755fede64637f1936e219101ec448e7885ad11c2012dbb567c437df5d3d";
const TOMBSTONED = "2c20f01be8c6b8732d063887e49f0b8ac9e2a9297e1db3f178ccb4a2f892b124";

function manifest(epochHash) {
  const scenarios = [];
  for (const alias of ["01", "02", "03", "04"]) {
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      scenarios.push({ scenarioId: `observe-${alias}-${String(ordinal).padStart(2, "0")}`, alias, ordinal, expectedStatus: ordinal === 20 ? "rejected" : "accepted" });
    }
  }
  return { epochHash, scenarios };
}

test("window tag is derived from the active epoch hash, not hardcoded", () => {
  assert.equal(deriveWindowTag(EPOCH), "fe4be755");
  assert.equal(deriveWindowTag("a".repeat(64)), "aaaaaaaa");
  assert.throws(() => deriveWindowTag("not-hex"), /64-hex/);
});

test("a tombstoned epoch tag is refused", () => {
  assert.equal(refuseTombstonedTag("fe4be755", ["2c20f01b", TOMBSTONED]), null);
  assert.match(refuseTombstonedTag(TOMBSTONED.slice(0, 8), [TOMBSTONED, "2c20f01b"]), /tombstoned/);
});

test("freezeWindowPlan computes the exact 4x20 distribution and rejects a duplicate", () => {
  const plan = freezeWindowPlan(manifest(EPOCH), { tombstonedTags: [TOMBSTONED] });
  assert.equal(plan.tag, "fe4be755");
  assert.equal(plan.scenarioCount, 80);
  assert.equal(plan.counts["01"], 20);
  assert.equal(plan.counts["02"], 20);
  assert.equal(plan.counts["03"], 20);
  assert.equal(plan.counts["04"], 20);
  assert.match(plan.manifestSha256, /^[0-9a-f]{64}$/);

  const dup = { epochHash: EPOCH, scenarios: [manifest(EPOCH).scenarios[0], manifest(EPOCH).scenarios[0]] };
  assert.throws(() => freezeWindowPlan(dup, {}), /duplicate scenario/);
});

test("freezeWindowPlan has a deterministic manifest hash across call order", () => {
  const p1 = freezeWindowPlan(manifest(EPOCH), {});
  const p2 = freezeWindowPlan(manifest(EPOCH), {});
  assert.equal(p1.manifestSha256, p2.manifestSha256);
});

test("classifyScenarioAttempt refuses a pre-existing receipt instead of skipping", () => {
  const existing = { attemptId: "att-observe-01-01", status: "accepted", errorCodes: null };
  const dup = classifyScenarioAttempt({ scenarioId: "observe-01-01", alias: "01", ordinal: 1, existing });
  assert.equal(dup.decision, "duplicate");
  assert.equal(dup.reason, "already-landed");
  assert.equal(dup.attemptId, "att-observe-01-01");

  const fresh = classifyScenarioAttempt({ scenarioId: "observe-01-02", alias: "01", ordinal: 2, existing: null });
  assert.equal(fresh.decision, "run");
  assert.equal(fresh.ordinal, 2);
});
