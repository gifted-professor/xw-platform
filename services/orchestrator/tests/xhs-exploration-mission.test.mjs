// xhs-exploration-mission.test.mjs — P1 mission compiler (plan §3, V3-I03/I06).
//
// The compiler turns a natural-language goal into a sealed public mission:
// digests are deployment-keyed, mixed/unbounded intent rejects the WHOLE plan,
// budgets only go lower, placement is frozen to [03=feed_lane,04=search_lane],
// and the plan template integrates without touching legacy plan hashes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  EXPLORATION_MISSION_SCHEMA_ID,
  EXPLORATION_TEMPLATE_ID,
  EXPLORATION_SESSION_PROFILE,
  EXPLORATION_BUDGET_CAPS,
  compileExplorationMission,
  validateSealedMission,
  verifyPrivatePayload,
  normalizeGoalText,
} from "../scripts/lib/xhs-exploration-mission.mjs";
import { planExplorationGoalRoutine, planRoutine } from "../scripts/lib/xhs-routine-plan.mjs";

const KEY = Buffer.from(createHash("sha256").update("offline-digest-key").digest("hex"), "utf8").subarray(0, 32);

function compile({ goal = "探索低卡早餐相关的笔记版式", queries = ["低卡早餐"], ...rest } = {}) {
  return compileExplorationMission({ digestKey: KEY, goal, queries, ...rest });
}

test("goal normalization + canonical digests are deployment-keyed HMACs", () => {
  assert.equal(normalizeGoalText("  低卡 早餐\n探索 "), "低卡 早餐 探索");
  const { mission, privatePayload } = compile();
  assert.equal(mission.goalRef.digestKeyId, "ka-1");
  assert.match(mission.goalRef.digest, /^[0-9a-f]{64}$/);
  assert.equal(mission.queries.length, 1);
  assert.match(mission.queries[0].digest, /^[0-9a-f]{64}$/);
  // the private payload never appears in the sealed body
  const sealedText = JSON.stringify(mission);
  assert.ok(!sealedText.includes("低卡早餐"), "raw goal text must not leak into the sealed mission");
  assert.deepEqual(privatePayload.queries, ["低卡早餐"]);
});

test("mixed social effect intent rejects the whole plan (no clamping)", () => {
  for (const bad of ["先看看低卡早餐再点个赞", "find notes and like them", "浏览顺便发评论"]) {
    assert.throws(() => compile({ goal: bad }), (error) => error.code === "EXPLORATION_GOAL_MIXED_EFFECT", bad);
  }
  assert.throws(
    () => compile({ queries: ["低卡早餐", "关注我的人"] }),
    (error) => error.code === "EXPLORATION_GOAL_MIXED_EFFECT" || error.code === "EXPLORATION_QUERY_INVALID" || error.code === "EXPLORATION_QUERY_CAP_EXCEEDED",
  );
});

test("unbounded language and oversized goals reject", () => {
  assert.throws(() => compile({ goal: "把所有内容都看一遍" }), (error) => error.code === "EXPLORATION_GOAL_UNBOUNDED");
  assert.throws(() => compile({ goal: "leftright".repeat(80) }), (error) => error.code === "EXPLORATION_GOAL_TOO_LONG");
  assert.throws(() => compile({ goal: "" }), (error) => error.code === "EXPLORATION_GOAL_REQUIRED");
});

test("queries are capped; sealed query budget cannot exceed two", () => {
  assert.throws(
    () => compile({ queries: ["a", "b", "c"] }),
    (error) => error.code === "EXPLORATION_QUERY_CAP_EXCEEDED",
  );
});

test("budgets may only go lower than the sealed caps", () => {
  const lowered = compile({ budgets: { reservedPrimitives: 10, novelOpens: 1 } });
  assert.equal(lowered.mission.budgets.reservedPrimitives, 10);
  assert.equal(lowered.mission.budgets.novelOpens, 1);
  assert.equal(lowered.mission.budgets.sealedQueries, EXPLORATION_BUDGET_CAPS.sealedQueries);
  assert.throws(
    () => compile({ budgets: { reservedPrimitives: 81 } }),
    (error) => error.code === "EXPLORATION_BUDGET_CAP_EXCEEDED",
  );
  assert.throws(
    () => compile({ budgets: { novelOpens: -1 } }),
    (error) => error.code === "EXPLORATION_BUDGET_INVALID",
  );
});

test("placement is frozen to [03=feed_lane,04=search_lane] with closed vocabulary", () => {
  const { mission } = compile();
  assert.deepEqual(mission.placement.lanes, [
    { index: 0, alias: "03", role: "feed_lane" },
    { index: 1, alias: "04", role: "search_lane" },
  ]);
  assert.equal(mission.externalEffects, 0);
  assert.equal(mission.profile, EXPLORATION_SESSION_PROFILE);
  assert.equal(mission.schemaId, EXPLORATION_MISSION_SCHEMA_ID);
  assert.equal(mission.templateId, EXPLORATION_TEMPLATE_ID);
  assert.ok(EXPLORATION_BUDGET_CAPS.visionMaxIssuedPermits === 1 || mission.budgets.visionMaxIssuedPermits <= 1);
  assert.equal(mission.vision.mode, "off", "an unpinned mission is DUMP-only by default");
  assert.equal(mission.vision.rolloutPhase, "R0");
  assert.equal(mission.vision.effectiveVisualPermitBudget, 0);
  assert.equal(mission.budgets.visionMaxIssuedPermits, 0);
  assert.equal(mission.budgets.visionMaxPhysicalTaps, 0);
});

test("shadow/canary vision requires providerBundleDigest plus complete audit hashes", () => {
  assert.throws(
    () => compile({ vision: { mode: "shadow", provider: { modelHash: "a".repeat(64) } } }),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_UNPINNED",
  );
  const provider = {
    providerBundleDigest: "0".repeat(64),
    pythonHash: "1".repeat(64),
    modelHash: "2".repeat(64),
    scriptHash: "3".repeat(64),
    configHash: "4".repeat(64),
  };
  const { providerBundleDigest: _omitted, ...partialFourHashIdentity } = provider;
  assert.throws(
    () => compile({ vision: { mode: "shadow", provider: partialFourHashIdentity } }),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_UNPINNED",
    "the legacy four hashes are audit detail, not a complete provider identity",
  );
  const ref = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "5".repeat(64),
    bindingHash: "6".repeat(64),
    gateEpoch: "7".repeat(64),
    expiresAtMs: 9_999_999_999_999,
  };
  const { mission: shadow } = compile({
    vision: { mode: "shadow", provider },
    rolloutPhase: "R2",
  });
  assert.equal(shadow.vision.effectiveVisualPermitBudget, 0);
  assert.equal(shadow.budgets.visionMaxIssuedPermits, 0);
  assert.equal(shadow.budgets.visionMaxPhysicalTaps, 0);
  const { mission } = compile({
    vision: { mode: "canary1", provider },
    rolloutPhase: "R3",
    eCorpusPassRef: ref,
    eCorpusVerifier: ({ ref: actual }) => ({
      ok: true,
      status: "PASS",
      artifactHash: actual.artifactHash,
      effectiveVisualPermitBudget: 1,
    }),
  });
  assert.deepEqual(mission.vision.provider, { kind: "local-pinned", ...provider });
  assert.equal(mission.vision.rolloutPhase, "R3");
  assert.equal(mission.vision.effectiveVisualPermitBudget, 1);
  assert.doesNotThrow(() => validateSealedMission(mission));
  assert.throws(
    () => compile({ vision: { mode: "off", provider } }),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_INVALID",
  );
});

test("sealed mission round-trips: hash reproduction + tamper detection", () => {
  const { mission } = compile();
  assert.doesNotThrow(() => validateSealedMission(mission));
  for (const [field, value] of [
    ["externalEffects", 1],
    ["seed", "tampered-seed"],
  ]) {
    const forged = JSON.parse(JSON.stringify(mission));
    forged[field] = value;
    assert.throws(() => validateSealedMission(forged), undefined, `tampering ${field} must fail`);
  }
  const forged = JSON.parse(JSON.stringify(mission));
  forged.extraField = true;
  assert.throws(() => validateSealedMission(forged));
  const forgedBudget = JSON.parse(JSON.stringify(mission));
  forgedBudget.budgets.novelOpens = 99;
  assert.throws(() => validateSealedMission(forgedBudget));
});

test("private payload verification requires the SAME digest key before any I/O", () => {
  const { mission, privatePayload } = compile();
  const verified = verifyPrivatePayload({ mission, privatePayload, digestKey: KEY });
  assert.equal(verified.goal, "探索低卡早餐相关的笔记版式");
  assert.deepEqual(verified.queries, ["低卡早餐"]);
  const otherKey = Buffer.from(createHash("sha256").update("different").digest("hex"), "utf8").subarray(0, 32);
  assert.throws(
    () => verifyPrivatePayload({ mission, privatePayload, digestKey: otherKey }),
    (error) => error.code === "EXPLORATION_PAYLOAD_MISMATCH",
  );
  assert.throws(
    () => verifyPrivatePayload({ mission, privatePayload: { goal: "其他目标", queries: [] }, digestKey: KEY }),
    (error) => error.code === "EXPLORATION_PAYLOAD_MISMATCH",
  );
});

test("plan template xhs.explore.goal.v1 seals a [03,04] parallel plan from the mission", () => {
  const { mission } = compile();
  const plan = planExplorationGoalRoutine({ mission, actor: "explorer-operator" });
  assert.ok(plan);
  assert.ok(plan.planHash, "plan must seal a canonical planHash");
});

test("legacy V2 plan hash bytes stay stable (mission key absent)", () => {
  // identical inputs must reproduce the legacy hash byte-for-byte; the
  // mission body key enters the canonical hash ONLY for mission templates
  const a = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8, seed: "daily" } });
  const b = planRoutine({ templateId: "xhs.feed-play.v1", params: { seed: "daily", items: 8 } });
  assert.equal(a.planHash, b.planHash);
  assert.match(a.planHash, /^[0-9a-f]{64}$/);
  assert.ok(!("mission" in JSON.parse(JSON.stringify(a))), "legacy plan body carries no mission key");
  // explore plans are mission-bound: different seeds hash differently
  const { mission: m1 } = compile({ seed: "s1" });
  const { mission: m2 } = compile({ seed: "s2" });
  const p1 = planExplorationGoalRoutine({ mission: m1 });
  const p2 = planExplorationGoalRoutine({ mission: m2 });
  assert.notEqual(p1.planHash, p2.planHash);
});

test("digest key must be 256 bits — compiler refuses to seal without it", () => {
  assert.throws(
    () => compileExplorationMission({ goal: "低卡早餐探索", queries: [], digestKey: Buffer.from("short") }),
    (error) => error.code === "EXPLORATION_DIGEST_KEY_INVALID",
  );
  assert.throws(
    () => compileExplorationMission({ goal: "低卡早餐探索", queries: [], digestKey: "not-a-buffer" }),
    (error) => error.code === "EXPLORATION_DIGEST_KEY_INVALID",
  );
});
