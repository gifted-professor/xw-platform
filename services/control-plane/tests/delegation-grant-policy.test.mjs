import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalGrantIssueSigningBytes,
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
  discoveryPolicy: {
    enabled: true,
    allowedPrimitives: ["screenshot", "dump", "focus", "launch", "back", "home", "tap", "swipe", "input", "restore"],
    defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 },
    maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 },
    maxParallelism: 1,
    targetScope: {
      anchors: [
        { type: "seedIdentityFingerprint", hash: "b".repeat(64) },
        { type: "searchQueryHash", hash: "a".repeat(64) },
        { type: "identityFingerprint", hash: "c".repeat(64) },
      ],
      relationKinds: ["explicit_target", "seed_profile_relation", "search_result"],
      maxHops: 1,
    },
    identityPolicy: { stableUserId: "preferred", fallback: "exact_nickname_avatar_profile_fingerprint", onAmbiguity: "stop" },
    clocks: { snapshotFreshnessMs: 5000, observationCompileWindowMs: 60000 },
    retention: { rawScreenshotDays: 7, redactedHashAuditDays: 90 },
    accessPolicy: { ownerSubjectHash: "d".repeat(64), reviewerAllowlistVersion: 1 },
  },
  validity: { expiresAt: null },
  redaction: { publicFields: ["alias", "fingerprint", "counts", "states", "evidenceHash"] },
};

test("normalizes an immutable permanent Standing Grant and its signing payload", () => {
  const normalized = validateDelegationGrantDraft(grant);
  assert.equal(normalized.validity.expiresAt, null);
  assert.equal(normalized.maxParallelism, 1);
  assert.deepEqual(normalized.discoveryPolicy.targetScope.anchors.map(({ type }) => type), ["identityFingerprint", "searchQueryHash", "seedIdentityFingerprint"]);
  assert.deepEqual(normalized.discoveryPolicy.targetScope.relationKinds, ["explicit_target", "search_result", "seed_profile_relation"]);
  assert.throws(() => { normalized.discoveryPolicy.targetScope.anchors.push({}); }, TypeError);
  assert.ok(/^[0-9a-f]{64}$/.test(delegationGrantContentHash(normalized)));
  assert.deepEqual(grantIssueSigningPayload({
    subject: "user:a1234", grantId: normalized.grantId, issuanceNonce: normalized.issuanceNonce,
    allowlistVersion: 1, grantHash: delegationGrantContentHash(normalized), grant: normalized,
  }).kind, "delegation_grant.issue.v1");
  assert.throws(() => { normalized.controllers.push("agent:other"); }, TypeError);
});

test("DiscoveryPolicy is signed canonical authority with strict anchors and governed explicit target", () => {
  const normalized = validateDelegationGrantDraft(grant);
  const changedPolicy = { ...grant, discoveryPolicy: { ...grant.discoveryPolicy, defaults: { ...grant.discoveryPolicy.defaults, maxCandidates: 9 } } };
  assert.notEqual(delegationGrantContentHash(grant), delegationGrantContentHash(changedPolicy));
  const payload = { subject: "user:a1234", grantId: grant.grantId, issuanceNonce: grant.issuanceNonce, allowlistVersion: 1, grantHash: delegationGrantContentHash(grant), grant };
  const reordered = { ...grant, discoveryPolicy: { ...grant.discoveryPolicy, targetScope: { ...grant.discoveryPolicy.targetScope, anchors: [...grant.discoveryPolicy.targetScope.anchors].reverse(), relationKinds: [...grant.discoveryPolicy.targetScope.relationKinds].reverse() } } };
  const reorderedPayload = { ...payload, grantHash: delegationGrantContentHash(reordered), grant: reordered };
  assert.equal(canonicalGrantIssueSigningBytes(payload), canonicalGrantIssueSigningBytes(reorderedPayload));
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, targetScope: { ...grant.discoveryPolicy.targetScope, relationKinds: ["seed_profile_relation"] } } }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, targetScope: { ...grant.discoveryPolicy.targetScope, anchors: [{ type: "searchQueryHash", hash: "a".repeat(64) }], relationKinds: ["explicit_target"] } } }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, targetScope: { ...grant.discoveryPolicy.targetScope, maxHops: 2 } } }), { code: "GRANT_POLICY_INVALID" });
});

test("DiscoveryPolicy rejects widening, non-R0/R1 effects, and caller role authority", () => {
  const { discoveryPolicy, ...legacyGrant } = grant;
  assert.throws(() => validateDelegationGrantDraft(legacyGrant), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, allowedPrimitives: ["screenshot", "collect"] } }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, maxima: { ...grant.discoveryPolicy.maxima, maxCandidates: 51 } } }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, accessPolicy: { ...grant.discoveryPolicy.accessPolicy, role: "reviewer" } } }), { code: "GRANT_POLICY_INVALID" });
  assert.throws(() => validateDelegationGrantDraft({ ...grant, discoveryPolicy: { ...grant.discoveryPolicy, unknownExpansion: true } }), { code: "GRANT_POLICY_INVALID" });
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
