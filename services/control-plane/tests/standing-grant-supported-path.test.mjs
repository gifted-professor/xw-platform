import assert from "node:assert/strict";
import test from "node:test";

import { main as devicectl } from "../control-plane/devicectl.mjs";
import { ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { ControlRouter } from "../control-plane/router.mjs";

test("router exposes only signed Standing Grant install/list/show/revoke operations", async () => {
  const calls = [];
  const grant = {
    grantId: "grant_public",
    grantHash: "a".repeat(64),
    status: "active",
    issuer: { subject: "user:a1234", keyId: "private-key-id" },
    accountFingerprint: "private-account",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: null,
  };
  const delegationGrants = {
    issue(input) { calls.push(["install", input]); return { grant, reused: false }; },
    prepareRevoke(id, input) { calls.push(["prepare-revoke", id, input]); return { grantId: id, grantHash: grant.grantHash, signingBytesBase64: "cmV2b2tlLWJ5dGVz" }; },
    list() { calls.push(["list"]); return [grant]; },
    show(id) { calls.push(["show", id]); return grant; },
    revoke(id, input) { calls.push(["revoke", id, input]); return grant; },
  };
  const control = {
    prepareExplicitTargetGrant(input) { calls.push(["prepare", input]); return { grant: { grantId: "grant_public", targets: { mode: "explicit_fingerprints", values: ["server-target"] } }, grantHash: "a".repeat(64), signingBytesBase64: "c2lnbmVkLWJ5dGVz" }; },
    async runStandingGrantCollectCanary(input) { calls.push(["canary", input]); return { status: "completed", jobId: "job_collect", runId: "run_collect" }; },
  };
  const router = new ControlRouter({ control, state: {}, capabilities: {}, evidence: {}, delegationGrants });
  const envelope = { grant: { grantId: "grant_public" }, proof: { signature: "offline-signature" } };
  const installed = await router.handle({ method: "POST", path: "/control/v1/grants", body: envelope });
  const prepared = await router.handle({ method: "POST", path: "/control/v1/grants/prepare-explicit-target", body: { sourceJobId: "job_observe", adapterReceiptId: "receipt_observe", draft: { grantId: "grant_public" }, allowlistVersion: 1 } });
  const canary = await router.handle({ method: "POST", path: "/control/v1/missions/collect-canary", body: { parentGrantId: "grant_public" } });
  const listed = await router.handle({ method: "GET", path: "/control/v1/grants" });
  const shown = await router.handle({ method: "GET", path: "/control/v1/grants/grant_public" });
  const preparedRevoke = await router.handle({ method: "POST", path: "/control/v1/grants/grant_public/prepare-revoke", body: { revocationNonce: "revoke-1", reason: "canary_complete", allowlistVersion: 1 } });
  const revoked = await router.handle({ method: "POST", path: "/control/v1/grants/grant_public/revoke", body: { proof: { signature: "offline-revoke-signature" }, reason: "canary_complete" } });

  assert.equal(installed.status, 201);
  assert.equal(listed.body.grants.length, 1);
  assert.equal(shown.body.grant.grantId, "grant_public");
  assert.equal(revoked.body.grant.grantId, "grant_public");
  assert.equal(preparedRevoke.body.grantId, "grant_public");
  assert.equal(prepared.body.grant.targets.values[0], "server-target");
  assert.equal(canary.body.status, "completed");
  assert.deepEqual(calls.map(([name]) => name), ["install", "prepare", "canary", "list", "show", "prepare-revoke", "revoke"]);
  for (const result of [installed, listed, shown, revoked]) {
    assert.doesNotMatch(JSON.stringify(result.body), /private-key-id|private-account|offline-signature/);
  }
});

test("devicectl grant commands use the audited control-plane endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ grant: { grantId: "grant_public" }, grants: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  console.log = () => {};
  try {
    await devicectl(["--local", "grant", "install", "--envelope", JSON.stringify({ grant: {}, proof: {} })]);
    await devicectl(["--local", "grant", "prepare", "--job", "job_observe", "--receipt", "receipt_observe", "--draft", JSON.stringify({ grantId: "grant_public" }), "--allowlist-version", "1"]);
    await devicectl(["--local", "mission", "collect-canary", "--actor", "user:a1234", "--idempotency-key", "canary-1", "--grant", "grant_public", "--job", "job_observe", "--receipt", "receipt_observe"]);
    await devicectl(["--local", "grant", "list"]);
    await devicectl(["--local", "grant", "show", "--grant", "grant_public"]);
    await devicectl(["--local", "grant", "prepare-revoke", "--grant", "grant_public", "--revocation-nonce", "revoke-1", "--reason", "canary_complete", "--allowlist-version", "1"]);
    await devicectl(["--local", "grant", "revoke", "--grant", "grant_public", "--envelope", JSON.stringify({ proof: {}, reason: "canary_complete" })]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.deepEqual(requests.map(({ path, method }) => [method, path]), [
    ["POST", "/control/v1/grants"],
    ["POST", "/control/v1/grants/prepare-explicit-target"],
    ["POST", "/control/v1/missions/collect-canary"],
    ["GET", "/control/v1/grants"],
    ["GET", "/control/v1/grants/grant_public"],
    ["POST", "/control/v1/grants/grant_public/prepare-revoke"],
    ["POST", "/control/v1/grants/grant_public/revoke"],
  ]);
});

test("note-detail receipt prepares canonical collect-only signing bytes without trusting a caller target", () => {
  const target = "b".repeat(64);
  const sourceJob = {
    jobId: "job_observe",
    runId: "run_observe",
    status: "succeeded",
    capabilityId: "xhs.observe.note_detail",
    capability: { implementation: { adapter: "xhs" } },
  };
  const fake = {
    state: { getJob(id) { assert.equal(id, sourceJob.jobId); return sourceJob; } },
    adapters: { require(id) { assert.equal(id, "xhs"); return { getExplicitObservationReceipt() { return { targetFingerprint: target, pageFingerprint: "c".repeat(64), observedAt: new Date().toISOString(), evidenceId: "evidence_observe", evidenceHash: "d".repeat(64) }; } }; } },
    evidence: { findByIdAndHash(id, hash) { assert.equal(id, "evidence_observe"); assert.equal(hash, "d".repeat(64)); return { evidenceId: id }; } },
    receiptAuthorityAllowlist: new Set(["xhs.observe.note_detail:xhs"]),
  };
  const draft = {
    schemaVersion: 1, grantId: "grant_canary_001", issuanceNonce: "nonce_canary_001",
    issuer: { subject: "user:a1234", keyId: "offline-key" }, app: "xhs", accountFingerprint: "account-confirmed-by-signer",
    controllers: ["agent:runner"], maxParallelism: 1,
    authorization: { primitives: ["screenshot"], socialActions: ["collect"], missionOnlyActions: [], prohibitedActions: ["payment", "publish"] },
    budget: { maxima: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } }, defaults: { totalCount: 1, perTargetCount: 1, frequency: { count: 1, windowSeconds: 3600 } } },
    discoveryPolicy: { enabled: false, allowedPrimitives: ["screenshot"], defaults: { durationMs: 600000, maxPrimitives: 80, maxCandidates: 10 }, maxima: { durationMs: 1800000, maxPrimitives: 300, maxCandidates: 50 }, maxParallelism: 1, targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 }, identityPolicy: { stableUserId: "preferred", fallback: "exact_nickname_avatar_profile_fingerprint", onAmbiguity: "stop" }, clocks: { snapshotFreshnessMs: 5000, observationCompileWindowMs: 60000 }, retention: { rawScreenshotDays: 7, redactedHashAuditDays: 90 }, accessPolicy: { ownerSubjectHash: "e".repeat(64), reviewerAllowlistVersion: 1 } },
    validity: { expiresAt: null }, redaction: { publicFields: ["alias"] },
  };
  const prepared = ControlPlane.prototype.prepareExplicitTargetGrant.call(fake, { sourceJobId: sourceJob.jobId, adapterReceiptId: "receipt_observe", draft, allowlistVersion: 1 });
  assert.deepEqual(prepared.grant.targets, { mode: "explicit_fingerprints", values: [target] });
  assert.deepEqual(prepared.grant.authorization.primitives, ["screenshot"]);
  assert.deepEqual(prepared.grant.authorization.socialActions, ["collect"]);
  assert.equal(prepared.grant.budget.maxima.totalCount, 1);
  assert.deepEqual(prepared.grant.discoveryPolicy.targetScope, { anchors: [{ type: "identityFingerprint", hash: target }], relationKinds: ["explicit_target"], maxHops: 1 });
  const signedPayload = JSON.parse(Buffer.from(prepared.signingBytesBase64, "base64").toString("utf8"));
  assert.equal(signedPayload.kind, "delegation_grant.issue.v1");
  assert.equal(signedPayload.grant.targets.values[0], target);
  assert.throws(() => ControlPlane.prototype.prepareExplicitTargetGrant.call(fake, { sourceJobId: sourceJob.jobId, adapterReceiptId: "receipt_observe", draft: { ...draft, targets: { mode: "explicit_fingerprints", values: ["caller-target"] } }, allowlistVersion: 1 }), { code: "GRANT_CEREMONY_INVALID" });
});
