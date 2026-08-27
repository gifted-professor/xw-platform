/**
 * xhs-routine-plan.test.mjs — sealed routine plan catalog tests (direct-routine
 * plan V2 §1/§2/§4/§7): three call surfaces -> one planHash; publish/alias/
 * commentMax=3 rejected before any I/O; sealed JSON tamper-rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planRoutine,
  acceptSealedRoutinePlan,
  normalizeRoutineParams,
  parseDwellSeconds,
  listRoutineTemplates,
  resolveRoutineTemplateFromGoal,
  seedToRngState,
  RoutinePlanError,
  ROUTINE_SCHEMA_ID,
  COMMENT_MAX_CAP,
  LIKE_MAX_CAP,
} from "../scripts/lib/xhs-routine-plan.mjs";

test("catalog has exactly the four V2 templates", () => {
  const ids = listRoutineTemplates().map((t) => t.id);
  assert.deepEqual(ids, [
    "xhs.scout.home.v1",
    "xhs.feed-play.v1",
    "xhs.nurture-lite.v1",
    "xhs.nurture-grounded.v1",
  ]);
});

test("planRoutine is deterministic: identical inputs -> identical planHash", () => {
  const a = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8, seed: "daily" } });
  const b = planRoutine({ templateId: "xhs.feed-play.v1", params: { seed: "daily", items: 8 } });
  assert.equal(a.planHash, b.planHash);
  assert.equal(a.routineRunId, b.routineRunId);
  assert.match(a.planHash, /^[0-9a-f]{64}$/);
  assert.equal(a.routineRunId, `rr_${a.planHash.slice(0, 16)}`);
});

test("planHash changes when params change", () => {
  const a = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8 } });
  const b = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 9 } });
  assert.notEqual(a.planHash, b.planHash);
});

test("planHash changes when template changes", () => {
  const a = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8 } });
  const b = planRoutine({ templateId: "xhs.scout.home.v1", params: { items: 8 } });
  assert.notEqual(a.planHash, b.planHash);
});

test("three call surfaces produce the same canonical plan", () => {
  // surface 1: CLI flags equivalent   /xw xhs routine feed-play --items 8 --dwell 5:12
  const cli = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8, dwell: "5:12" }, actor: "a" });
  // surface 2: sealed JSON submission
  const { templateSpec, ...sealable } = cli;
  const resealed = acceptSealedRoutinePlan(JSON.parse(JSON.stringify(sealable)));
  assert.equal(resealed.planHash, cli.planHash);
  // surface 3: compose NL mapping
  assert.equal(resolveRoutineTemplateFromGoal("帮我刷一会小红书 feed"), "xhs.feed-play.v1");
  const composed = planRoutine({ templateId: resolveRoutineTemplateFromGoal("刷小红书"), params: { items: 8, dwell: "5:12" }, actor: "a", goalSignature: "刷小红书" });
  assert.equal(composed.planHash, cli.planHash);
});

test("04-only: alias 01/02/03 rejected at plan stage with ROUTINE_ALIAS_NOT_04", () => {
  for (const alias of ["01", "02", "03"]) {
    assert.throws(
      () => planRoutine({ templateId: "xhs.feed-play.v1", params: {}, alias }),
      (e) => e.code === "ROUTINE_ALIAS_NOT_04",
    );
  }
  const p = planRoutine({ templateId: "xhs.feed-play.v1", params: {} });
  assert.equal(p.alias, "04");
});

test("no publish/DM/follow/collect template exists — invented ones are rejected", () => {
  for (const invented of [
    "xhs.publish.v1", "xhs.dm.v1", "xhs.follow.v1", "xhs.collect.v1",
    "xhs.payment.v1", "xhs.account.v1", "publish", "dm",
  ]) {
    assert.throws(
      () => planRoutine({ templateId: invented, params: {} }),
      (e) => e.code === "ROUTINE_TEMPLATE_UNKNOWN",
      `${invented} must not plan`,
    );
  }
});

test("comment.max schema cap fixed at 2 — commentMax=3 rejected before I/O", () => {
  assert.equal(COMMENT_MAX_CAP, 2);
  assert.throws(
    () => planRoutine({ templateId: "xhs.nurture-grounded.v1", params: { commentMax: 3 } }),
    (e) => e.code === "ROUTINE_PARAM_INVALID",
  );
  const ok = planRoutine({ templateId: "xhs.nurture-grounded.v1", params: { commentMax: 2 } });
  assert.equal(ok.params.commentMax, 2);
  const lite = planRoutine({ templateId: "xhs.nurture-grounded.v1", params: { commentMax: 0 } });
  assert.equal(lite.params.commentMax, 0, "comment-max is a cap — 0 means zero comments");
});

test("like.max cap fixed at 1 (cap, not quota)", () => {
  assert.equal(LIKE_MAX_CAP, 1);
  assert.throws(
    () => planRoutine({ templateId: "xhs.nurture-lite.v1", params: { likeMax: 2 } }),
    (e) => e.code === "ROUTINE_PARAM_INVALID",
  );
  assert.equal(planRoutine({ templateId: "xhs.nurture-lite.v1", params: { likeMax: 0 } }).params.likeMax, 0);
});

test("dwell validation: min<=max, live floor 2s, ceiling 60s", () => {
  assert.deepEqual(parseDwellSeconds("5:12", { min: 2, max: 60 }), { min: 5, max: 12 });
  assert.deepEqual(parseDwellSeconds("2:3", { min: 2, max: 60 }), { min: 2, max: 3 });
  for (const bad of ["12:5", "1:12", "5:61", "5", ":12", "5:12:13", "abc"]) {
    assert.throws(() => parseDwellSeconds(bad, { min: 2, max: 60 }), RoutinePlanError, bad);
  }
  assert.throws(
    () => planRoutine({ templateId: "xhs.feed-play.v1", params: { dwell: "12:5" } }),
    (e) => e.code === "ROUTINE_DWELL_INVALID",
  );
});

test("unknown params rejected fail-closed", () => {
  assert.throws(
    () => planRoutine({ templateId: "xhs.feed-play.v1", params: { publish: true } }),
    (e) => e.code === "ROUTINE_PARAM_UNKNOWN",
  );
});

test("acceptSealedRoutinePlan rejects tampered templates/params/hash", () => {
  const plan = planRoutine({ templateId: "xhs.nurture-grounded.v1", params: { commentMax: 1 }, actor: "a" });
  const { templateSpec, ...sealable } = plan;

  const tamperedParams = JSON.parse(JSON.stringify(sealable));
  tamperedParams.params.commentMax = 2;
  assert.throws(() => acceptSealedRoutinePlan(tamperedParams), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const tamperedAlias = JSON.parse(JSON.stringify(sealable));
  tamperedAlias.alias = "01";
  assert.throws(() => acceptSealedRoutinePlan(tamperedAlias), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const badHash = JSON.parse(JSON.stringify(sealable));
  badHash.planHash = "0".repeat(64);
  assert.throws(() => acceptSealedRoutinePlan(badHash), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const wrongRunId = JSON.parse(JSON.stringify(sealable));
  wrongRunId.routineRunId = "rr_" + "0".repeat(16);
  assert.throws(() => acceptSealedRoutinePlan(wrongRunId), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const withTemplateSpec = JSON.parse(JSON.stringify(sealable));
  withTemplateSpec.templateSpec = {};
  assert.throws(() => acceptSealedRoutinePlan(withTemplateSpec), (e) => e.code === "ROUTINE_PLAN_SEALED");
});

test("seed hashing is stable and parameterized across processes", () => {
  assert.equal(typeof seedToRngState("daily"), "number");
  assert.equal(seedToRngState("daily"), seedToRngState("daily"));
  assert.notEqual(seedToRngState("daily"), seedToRngState("other"));
});

test("scout template is read-only with no effect params", () => {
  const p = planRoutine({ templateId: "xhs.scout.home.v1", params: { items: 5 } });
  assert.equal(p.effectClass, "none");
  assert.throws(
    () => planRoutine({ templateId: "xhs.scout.home.v1", params: { likeMax: 1 } }),
    (e) => e.code === "ROUTINE_PARAM_UNKNOWN",
  );
});

test("goal mapping never invents quantities", () => {
  assert.equal(resolveRoutineTemplateFromGoal("只读探索采集语料"), "xhs.scout.home.v1");
  assert.equal(resolveRoutineTemplateFromGoal("养号 带grounded评论"), "xhs.nurture-grounded.v1");
  assert.equal(resolveRoutineTemplateFromGoal("养号"), "xhs.nurture-lite.v1");
  assert.equal(resolveRoutineTemplateFromGoal("完全无关的目标"), null);
});