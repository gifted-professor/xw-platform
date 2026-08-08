import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalPaymentApprovalBytes, PaymentApprovalVerifier } from "../control-plane/lib/payment-approval-verifier.mjs";
import { ProtectedHumanCommit } from "../control-plane/lib/protected-human-commit.mjs";

const baseMission = {
  missionId: "mission_test", status: "active", validity: { expiresAt: "2099-07-29T16:00:00Z" },
  scope: { actions: ["follow", "publish", "delete"], targets: { values: ["target-a"] } },
  policy: { publish: "confirm", delete: "confirm", payment: "confirm" },
};

test("PHC covers payment and publish/delete; allow_within_scope never releases publish to ECP", async () => {
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
  assert.equal(released.decision, "phc");
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

test("payment approval is signed, purpose-bound, exact-field-bound, expiring, and one-time", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const allowlist = {
    version: 3,
    keys: [{
      keyId: "payment-human-1",
      subject: "human:owner",
      role: "human",
      status: "active",
      purposes: ["financial_commit"],
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
    }],
  };
  let nowMs = Date.parse("2026-08-01T06:00:00.000Z");
  const verifier = new PaymentApprovalVerifier({ allowlist, now: () => nowMs });
  let sequence = 0;
  let executeCalls = 0;
  let cancelCalls = 0;
  const ecp = {
    async prepare() { sequence += 1; return { status: "prepared", effect: { effectId: `effect-payment-${sequence}` } }; },
    markWaitingAuthorization(input) { return input; },
    async executePrepared() { executeCalls += 1; return { status: "verified" }; },
    async cancelPrepared() { cancelCalls += 1; return { status: "cancelled" }; },
  };
  const phc = new ProtectedHumanCommit({
    ecp,
    approvalVerifier: verifier,
    now: () => nowMs,
    approvalTtlMs: 60000,
  });
  const mission = {
    ...baseMission,
    app: "fixture-pay",
    account: "redacted:account",
  };
  const begin = () => phc.begin({
    mission,
    action: "payment",
    target: "observed-final-control",
    runId: "run_fixture_payment",
    payment: {
      payeeRef: "redacted:merchant",
      amount: "88.00",
      currency: "CNY",
      snapshotHash: "a".repeat(64),
      deviceId: "fixture-device",
    },
  });
  const signApproval = (binding, overrides = {}) => {
    const unsigned = {
      schemaId: "xhs.payment-approval.v1",
      schemaVersion: 1,
      ...binding,
      purpose: "financial_commit",
      issuer: { subject: "human:owner", role: "human", keyId: "payment-human-1", allowlistVersion: 3 },
      ...overrides,
    };
    return { ...unsigned, signature: sign(null, canonicalPaymentApprovalBytes(unsigned), privateKey).toString("base64") };
  };

  const pending = await begin();
  assert.equal(pending.status, "waiting_authorization");
  const mismatched = signApproval(pending.approvalBinding, { amount: "99.00" });
  const mismatchResult = await phc.decide(pending.commitId, { decision: "approve", approval: mismatched });
  assert.equal(mismatchResult.status, "waiting_authorization");
  assert.equal(mismatchResult.code, "PAYMENT_APPROVAL_BINDING_MISMATCH");
  assert.equal(executeCalls, 0);

  const badSignature = signApproval(pending.approvalBinding);
  badSignature.signature = `${badSignature.signature[0] === "A" ? "B" : "A"}${badSignature.signature.slice(1)}`;
  const signatureResult = await phc.decide(pending.commitId, { decision: "approve", approval: badSignature });
  assert.equal(signatureResult.status, "waiting_authorization");
  assert.equal(signatureResult.code, "PAYMENT_APPROVAL_SIGNATURE_INVALID");
  assert.equal(executeCalls, 0);

  const approved = await phc.decide(pending.commitId, {
    decision: "approve",
    approval: signApproval(pending.approvalBinding),
  });
  assert.equal(approved.status, "verified");
  assert.equal(executeCalls, 1);
  assert.equal((await phc.decide(pending.commitId, { decision: "approve" })).code, "PROTECTED_COMMIT_NOT_FOUND");

  const expiring = await begin();
  nowMs += 60001;
  const expired = await phc.decide(expiring.commitId, {
    decision: "approve",
    approval: signApproval(expiring.approvalBinding),
  });
  assert.equal(expired.code, "PAYMENT_APPROVAL_EXPIRED");
  assert.equal(executeCalls, 1);
  assert.equal(cancelCalls, 1);

  assert.throws(() => new PaymentApprovalVerifier({
    allowlist: {
      version: 1,
      keys: [{
        keyId: "standing-grant-key",
        subject: "human:owner",
        role: "human",
        status: "active",
        purposes: ["standing_grant"],
        publicKey: publicKey.export({ type: "spki", format: "pem" }),
      }],
    },
  }), /financial_commit/);
  assert.throws(() => new PaymentApprovalVerifier({
    allowlist: {
      version: 1,
      keys: [{
        keyId: "agent-key",
        subject: "agent:runner",
        role: "agent",
        status: "active",
        purposes: ["financial_commit"],
        publicKey: publicKey.export({ type: "spki", format: "pem" }),
      }],
    },
  }), /human/);
});
