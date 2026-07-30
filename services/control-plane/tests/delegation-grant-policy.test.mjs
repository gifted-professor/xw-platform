import assert from "node:assert/strict";
import test from "node:test";

import {
  delegationGrantContentHash,
  grantIssueSigningPayload,
  validateDelegationGrantDraft,
} from "../control-plane/lib/delegation-grant-policy.mjs";
import { validateMissionPolicy } from "../control-plane/lib/mission-policy.mjs";

const grant = {
  schemaVersion: 1,
  grantId: "grant_test_001",
  issuanceNonce: "nonce_test_001",
  issuer: { subject: "user:a1234", keyId: "test-key" },
  app: "xhs",
  accountFingerprint: "account-fingerprint",
  controllers: ["agent:runner"],
  maxParallelism: 1,
  authorization: {
    primitives: ["screenshot", "dump", "launch", "back", "home", "tap", "swipe", "input", "restore"],
    socialActions: ["follow", "like", "collect", "comment", "dm"],
    missionOnlyActions: [],
    prohibitedActions: ["payment", "publish"],
  },
  targets: { mode: "verified_discovery" },
  budget: {
    maxima: { totalCount: 5, perTargetCount: 1, frequency: { count: 2, windowSeconds: 3600 } },
    defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } },
  },
  validity: { expiresAt: null },
  redaction: { publicFields: ["alias", "fingerprint", "counts", "states", "evidenceHash"] },
};

test("normalizes an immutable permanent Standing Grant and its signing payload", () => {
  const normalized = validateDelegationGrantDraft(grant);
  assert.equal(normalized.validity.expiresAt, null);
  assert.equal(normalized.maxParallelism, 1);
  assert.ok(/^[0-9a-f]{64}$/.test(delegationGrantContentHash(normalized)));
  assert.deepEqual(grantIssueSigningPayload({
    subject: "user:a1234", grantId: normalized.grantId, issuanceNonce: normalized.issuanceNonce,
    allowlistVersion: 1, grantHash: delegationGrantContentHash(normalized), grant: normalized,
  }).kind, "delegation_grant.issue.v1");
  assert.throws(() => { normalized.controllers.push("agent:other"); }, TypeError);
});

test("rejects prohibited widening, bad parallelism, and invalid budget defaults", () => {
  assert.throws(() => validateDelegationGrantDraft({ ...grant, maxParallelism: 2 }), { code: "PARALLELISM_UNSUPPORTED" });
  assert.throws(() => validateDelegationGrantDraft({
    ...grant, authorization: { ...grant.authorization, prohibitedActions: ["payment"] },
  }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({
    ...grant, budget: { ...grant.budget, defaults: { ...grant.budget.defaults, totalCount: 6 } },
  }), { code: "GRANT_POLICY_INVALID" });
});

test("finite parent time bounds and discovery target modes are explicit", () => {
  assert.throws(() => validateDelegationGrantDraft({
    ...grant, validity: { expiresAt: "not-a-date" },
  }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({
    ...grant, targets: { mode: "verified_discovery", values: ["target-hash"] },
  }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateMissionPolicy({
    issuer: { actorId: "human:operator" }, idempotencyKey: "mission-discovery", app: "xhs", account: "account-fingerprint",
    parallelism: 1, controllers: ["agent:runner"],
    scope: {
      actions: ["follow"],
      targets: { kind: "verified_discovery", values: ["target-hash"] },
      totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 },
    }, validity: { expiresAt: "2099-01-01T00:00:00Z" },
  }), { code: "MISSION_POLICY_INVALID" });
});

test("Standing Grant v1 rejects unknown fields and unsupported delete/profile/settings authority", () => {
  assert.throws(() => validateDelegationGrantDraft({ ...grant, unreviewedExpansion: true }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({
    ...grant,
    authorization: { ...grant.authorization, missionOnlyActions: ["delete"] },
  }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({
    ...grant,
    authorization: { ...grant.authorization, socialActions: ["follow"], unreviewedExpansion: true },
  }), { code: "GRANT_POLICY_INVALID" });
});
