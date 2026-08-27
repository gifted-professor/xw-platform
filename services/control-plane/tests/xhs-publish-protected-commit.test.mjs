// xhs-publish-protected-commit.test.mjs — W6 publish protected commit (PUBLISH).
//
// Three probes (plan V2 §10.6 / contract PUBLISH):
//   1. envelope integrity + drift fail-closed — the commit envelope freezes the
//      publish context; any drift (content/screenshot/device/account/target/
//      plan) is detected and blocks the publish.
//   2. prepare = transport=0 — the publish prepare builds the envelope proof
//      WITHOUT transporting; the dispatcher's "publish prepare" is effectClass
//      none (a dry-run). The actual one-tap send happens only on decide("approve").
//   3. approve -> one execute; restart-lost-handle / drift / expiry all
//      fail-closed with NO execute. The human decide("approve") is the only gate
//      that releases the single publish tap (plan V2 §10.5, the sole human point).
//
// The handler reuses the real ProtectedHumanCommit kernel (payment-specialized
// but action-agnostic) with a stub ECP; publish is a non-payment protected commit.
import assert from "node:assert/strict";
import test from "node:test";

import { planAction } from "../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";
import { PublishCommitHandler } from "../apps/xhs/publish-commit.mjs";
import {
  buildPublishEnvelope,
  canonicalEnvelopeHash,
  contentHashOf,
  detectEnvelopeDrift,
  screenshotHashOf,
  verifyEnvelopeIntegrity,
} from "../apps/xhs/publish-envelope.mjs";
import { ProtectedHumanCommit } from "../control-plane/lib/protected-human-commit.mjs";

// --- mission: publish is a protected action routed to PHC ---------------------
const mission = {
  missionId: "mission_publish", status: "active",
  validity: { expiresAt: "2099-07-29T16:00:00Z" },
  scope: { actions: ["publish", "follow"], targets: { values: ["target-note-1"] } },
  policy: { publish: "confirm", delete: "confirm", payment: "confirm" },
};

const CONTENT = "今日攀岩v4线路总结：三点动态重心转移";
const SCREENSHOT = "png-bytes-proofscreenshot";
const ENVELOPE_INPUT = {
  prepareRunId: "run_prepare_1",
  planHash: "planhash_publish_001",
  content: CONTENT,
  screenshot: SCREENSHOT,
  deviceFingerprint: "dev-fp-04",
  accountFingerprint: "acct-fp-alias04",
  targetFingerprint: "target-note-1",
};

function stubEcp() {
  const calls = [];
  const ecp = {
    async prepare(input) {
      calls.push(["prepare", input.action]);
      return { status: "prepared", effect: { effectId: `effect-${input.action}-${calls.length}` } };
    },
    markWaitingAuthorization(input) { calls.push(["waiting", input.effect.effectId]); return input; },
    async executePrepared(input) { calls.push(["execute", input.action]); return { status: "verified" }; },
    async cancelPrepared(input) { calls.push(["cancel", input.action]); return { status: "cancelled" }; },
    async restore(input) { calls.push(["restore", input.action]); return { ok: true }; },
  };
  return { ecp, calls };
}

function makeHandler(nowMs = Date.now(), approvalTtlMs = 300000) {
  const { ecp, calls } = stubEcp();
  let now = nowMs;
  const clock = () => now;
  const phc = new ProtectedHumanCommit({ ecp, audit: () => {}, now: clock, approvalTtlMs });
  const handler = new PublishCommitHandler({ phc, now: clock, approvalTtlMs });
  // allow a test to advance the clock after construction (expiry probe).
  handler.__advanceClock = (ms) => { now = ms; };
  return { handler, calls, ecp };
}

// =================== Probe 1: envelope integrity + drift ====================

test("PUBLISH probe 1a: buildPublishEnvelope is frozen, 64-hex hash, self-consistent", () => {
  const env = buildPublishEnvelope({
    ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT),
    expiresAt: "2099-07-29T16:00:00Z",
  });
  assert.equal(Object.isFrozen(env), true);
  assert.equal(env.schemaId, "xhs.publish.commit-envelope.v1");
  assert.match(env.envelopeHash, /^[0-9a-f]{64}$/);
  assert.equal(verifyEnvelopeIntegrity(env), true);
});

test("PUBLISH probe 1b: canonical hash excludes envelopeHash + status (bookkeeping not binding)", () => {
  const a = buildPublishEnvelope({
    ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT), expiresAt: "2099-07-29T16:00:00Z",
  });
  // mutate status only -> hash unchanged (status is not a binding field).
  const statusMutated = { ...a, status: "approved" };
  assert.equal(canonicalEnvelopeHash(statusMutated), a.envelopeHash);
  // mutate envelopeHash only -> hash unchanged (the hash is not a binding field).
  const hashMutated = { ...a, envelopeHash: "0".repeat(64) };
  assert.equal(canonicalEnvelopeHash(hashMutated), a.envelopeHash);
  // mutate a binding field (content) -> hash changes.
  const contentMutated = { ...a, contentHash: contentHashOf("different content") };
  assert.notEqual(canonicalEnvelopeHash(contentMutated), a.envelopeHash);
});

test("PUBLISH probe 1c: drift in any binding field is detected (fail-closed basis)", () => {
  const env = buildPublishEnvelope({
    ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT), expiresAt: "2099-07-29T16:00:00Z",
  });
  const base = { content: CONTENT, screenshot: SCREENSHOT, deviceFingerprint: "dev-fp-04", accountFingerprint: "acct-fp-alias04", targetFingerprint: "target-note-1", planHash: "planhash_publish_001" };
  assert.equal(detectEnvelopeDrift(env, base), null, "identical observed state -> no drift");

  assert.equal(detectEnvelopeDrift(env, { ...base, content: "篡改内容" }), "content");
  assert.equal(detectEnvelopeDrift(env, { ...base, screenshot: "fake-screenshot" }), "screenshot");
  assert.equal(detectEnvelopeDrift(env, { ...base, deviceFingerprint: "dev-fp-99" }), "device");
  assert.equal(detectEnvelopeDrift(env, { ...base, accountFingerprint: "acct-fp-evil" }), "account");
  assert.equal(detectEnvelopeDrift(env, { ...base, targetFingerprint: "target-note-2" }), "target");
  assert.equal(detectEnvelopeDrift(env, { ...base, planHash: "planhash_tampered" }), "plan");
});

test("PUBLISH probe 1d: tampering a frozen envelope's binding field breaks integrity", () => {
  const env = buildPublishEnvelope({
    ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT), expiresAt: "2099-07-29T16:00:00Z",
  });
  // a frozen object can't be mutated in place; simulate a forged copy w/ a
  // changed binding field but the ORIGINAL hash (the tamper-evident attack).
  const forged = { ...env, contentHash: contentHashOf("forged content") };
  assert.equal(verifyEnvelopeIntegrity(forged), false, "forged envelope with stale hash fails integrity");
});

test("PUBLISH probe 1e: missing required binding field rejects envelope construction", () => {
  assert.throws(
    () => buildPublishEnvelope({ ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT), expiresAt: "2099-07-29T16:00:00Z", deviceFingerprint: "" }),
    /missing binding field: deviceFingerprint/,
  );
  assert.throws(
    () => buildPublishEnvelope({ ...ENVELOPE_INPUT, contentHash: contentHashOf(CONTENT), screenshotHash: screenshotHashOf(SCREENSHOT), expiresAt: "2099-07-29T16:00:00Z", prepareRunId: undefined }),
    /missing binding field: prepareRunId/,
  );
});

// =================== Probe 2: prepare = transport=0 ===========================

test("PUBLISH probe 2a: dispatcher 'publish prepare' is effectClass none (transport=0 dry-run)", () => {
  const plan = planAction({ actionId: "publish prepare", params: { title: "攀岩v4", body: CONTENT } });
  assert.equal(plan.budget.effectClass, "none");
  assert.deepEqual(plan.budget.missions, []);
  assert.equal(plan.budget.operationKeyDeferred, true);
  // publish prepare carries no effect mission -> transport=0. The envelope, not
  // a send, is the proof. The actual send is "publish send" (gated W6).
});

test("PUBLISH probe 2b: beginPublish prepares + waits WITHOUT executing (envelope is the proof)", async () => {
  const { handler, calls } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  assert.equal(begun.status, "waiting_authorization");
  assert.ok(begun.commitId);
  assert.match(begun.envelopeHash, /^[0-9a-f]{64}$/);
  assert.equal(verifyEnvelopeIntegrity(begun.envelope), true);
  // prepare called once; execute NEVER called at begin (transport=0).
  assert.deepEqual(calls.map((c) => c[0]), ["prepare", "waiting"]);
  assert.ok(calls.every((c) => c[0] !== "execute"), "no execute at prepare time");
});

// =================== Probe 3: approve/deny + fail-closed paths =================

test("PUBLISH probe 3a: approve with identical observed state -> one execute (verified)", async () => {
  const { handler, calls } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  const observed = { content: CONTENT, screenshot: SCREENSHOT, deviceFingerprint: "dev-fp-04", accountFingerprint: "acct-fp-alias04", targetFingerprint: "target-note-1", planHash: "planhash_publish_001" };
  const result = await handler.decidePublish(begun.commitId, { decision: "approve", actorId: "human:owner", observed });
  assert.equal(result.status, "verified");
  // exactly one execute (the one-tap publish); no restore/cancel.
  const executes = calls.filter((c) => c[0] === "execute");
  assert.equal(executes.length, 1, "exactly one execute on approve");
  assert.ok(calls.every((c) => c[0] !== "restore" && c[0] !== "cancel"), "no restore/cancel on approve");
});

test("PUBLISH probe 3b: drift at approve time -> PUBLISH_ENVELOPE_DRIFT, NO execute", async () => {
  const { handler, calls } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  const drifted = { content: "内容被篡改了", screenshot: SCREENSHOT, deviceFingerprint: "dev-fp-04", accountFingerprint: "acct-fp-alias04", targetFingerprint: "target-note-1", planHash: "planhash_publish_001" };
  const result = await handler.decidePublish(begun.commitId, { decision: "approve", actorId: "human:owner", observed: drifted });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "PUBLISH_ENVELOPE_DRIFT");
  assert.equal(result.field, "content");
  assert.ok(calls.every((c) => c[0] !== "execute"), "drift blocks execute");
});

test("PUBLISH probe 3c: restart-lost-handle -> PUBLISH_HANDLE_LOST, NO execute", async () => {
  const { handler, calls } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  // simulate control-plane restart: the in-process envelope mirror is lost.
  handler.envelopes.clear();
  const observed = { content: CONTENT, screenshot: SCREENSHOT, deviceFingerprint: "dev-fp-04", accountFingerprint: "acct-fp-alias04", targetFingerprint: "target-note-1", planHash: "planhash_publish_001" };
  const result = await handler.decidePublish(begun.commitId, { decision: "approve", actorId: "human:owner", observed });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "PUBLISH_HANDLE_LOST");
  assert.ok(calls.every((c) => c[0] !== "execute"), "lost handle blocks execute (no silent publish)");
});

test("PUBLISH probe 3d: expiry -> cancelled, NO execute (approval window elapsed)", async () => {
  const startMs = Date.parse("2026-08-27T10:00:00.000Z");
  const { handler, calls } = makeHandler(startMs, 60_000); // 60s approval window
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  // advance past the approval window
  handler.__advanceClock(startMs + 120_000);
  const observed = { content: CONTENT, screenshot: SCREENSHOT, deviceFingerprint: "dev-fp-04", accountFingerprint: "acct-fp-alias04", targetFingerprint: "target-note-1", planHash: "planhash_publish_001" };
  const result = await handler.decidePublish(begun.commitId, { decision: "approve", actorId: "human:owner", observed });
  assert.notEqual(result.status, "verified", "expired publish is not verified");
  assert.ok(calls.every((c) => c[0] !== "execute"), "expiry blocks execute");
});

test("PUBLISH probe 3e: deny -> cancelled, NO execute", async () => {
  const { handler, calls } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  const result = await handler.decidePublish(begun.commitId, { decision: "deny", actorId: "human:owner" });
  assert.equal(result.status, "cancelled");
  assert.ok(calls.every((c) => c[0] !== "execute"), "deny blocks execute");
});

test("PUBLISH probe 3f: approve without observed state -> blocked (drift check needs the current state)", async () => {
  const { handler } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  const result = await handler.decidePublish(begun.commitId, { decision: "approve", actorId: "human:owner" });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "PUBLISH_OBSERVED_STATE_REQUIRED");
});

test("PUBLISH probe 3g: invalid decision -> blocked", async () => {
  const { handler } = makeHandler();
  const begun = await handler.beginPublish({ mission, target: "target-note-1", ...ENVELOPE_INPUT });
  const result = await handler.decidePublish(begun.commitId, { decision: "bogus", actorId: "human:owner", observed: { content: CONTENT } });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "PUBLISH_DECISION_INVALID");
});