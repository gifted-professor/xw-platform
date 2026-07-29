import assert from "node:assert/strict";
import test from "node:test";

import { ProtectedHumanCommit } from "../control-plane/lib/protected-human-commit.mjs";

const baseMission = {
  missionId: "mission_test", status: "active", validity: { expiresAt: "2099-07-29T16:00:00Z" },
  scope: { actions: ["follow", "publish", "delete"], targets: { values: ["target-a"] } },
  policy: { publish: "confirm", delete: "confirm", payment: "confirm" },
};

test("PHC is per-commit only for payment and unreleased publish/delete", async () => {
  const calls = [];
  const ecp = {
    async prepare(input) { calls.push(["prepare", input.action]); return { status: "prepared", effect: { effectId: `effect-${input.action}` } }; },
    markWaitingAuthorization(input) { calls.push(["waiting", input.effect.effectId]); return input; },
    async executePrepared(input) { calls.push(["execute", input.action]); return { status: "verified" }; },
    async restore(input) { calls.push(["restore", input.action]); return { ok: true }; },
  };
  const phc = new ProtectedHumanCommit({ ecp, audit: () => {} });

  const payment = await phc.begin({ mission: baseMission, action: "payment", target: "target-a" });
  assert.equal(payment.status, "waiting_authorization");
  assert.deepEqual(calls, [["prepare", "payment"], ["waiting", "effect-payment"]]);
  const approved = await phc.decide(payment.commitId, { decision: "approve", actorId: "human:operator" });
  assert.equal(approved.status, "verified");

  const social = await phc.route({ mission: baseMission, action: "follow", target: "target-a" });
  assert.equal(social.decision, "ecp");
  const released = await phc.route({
    mission: { ...baseMission, policy: { ...baseMission.policy, publish: "allow_within_scope" } },
    action: "publish", target: "target-a",
  });
  assert.equal(released.decision, "ecp");
});

test("PHC denial restores a single pending commit and never turns scope failure into approval", async () => {
  const calls = [];
  const ecp = {
    async prepare(input) { calls.push(["prepare", input.action]); return { status: "prepared", effect: { effectId: "effect-delete" } }; },
    markWaitingAuthorization(input) { calls.push(["waiting", input.effect.effectId]); return input; },
    async executePrepared() { calls.push(["execute"]); return { status: "verified" }; },
    async restore() { calls.push(["restore"]); return { ok: true }; },
  };
  const phc = new ProtectedHumanCommit({ ecp, audit: () => {} });
  const pending = await phc.begin({ mission: baseMission, action: "delete", target: "target-a" });
  const denied = await phc.decide(pending.commitId, { decision: "deny", actorId: "human:operator" });
  assert.equal(denied.status, "cancelled");
  assert.deepEqual(calls, [["prepare", "delete"], ["waiting", "effect-delete"], ["restore"]]);
  const outOfScope = await phc.route({ mission: baseMission, action: "follow", target: "outside-target" });
  assert.equal(outOfScope.code, "SCOPE_VIOLATION");
});
