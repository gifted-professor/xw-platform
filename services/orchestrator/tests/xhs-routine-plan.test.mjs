/**
 * xhs-routine-plan.test.mjs — sealed routine plan catalog tests (direct-routine
 * plan V2 §1/§2/§4/§7 + placement policy v1: deterministic semantic hash,
 * 03-first single execution, explicit read-only [03,04] concurrency, and
 * execution identity allocated independently from planHash.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planRoutine,
  acceptSealedRoutinePlan,
  bindRoutineExecution,
  bindRoutineExecutionBatch,
  validateRoutineExecutionBinding,
  normalizeRoutineParams,
  parseDwellSeconds,
  listRoutineTemplates,
  resolveRoutineTemplateFromGoal,
  seedToRngState,
  RoutinePlanError,
  ROUTINE_SCHEMA_ID,
  ROUTINE_SCHEMA_VERSION,
  ROUTINE_PRIMARY_ALIAS,
  ROUTINE_SECONDARY_ALIAS,
  ROUTINE_PLACEMENT_POLICY_ID,
  COMMENT_MAX_CAP,
  LIKE_MAX_CAP,
} from "../scripts/lib/xhs-routine-plan.mjs";

test("catalog has the four V2 templates plus the V3 exploration template", () => {
  const ids = listRoutineTemplates().map((t) => t.id);
  assert.deepEqual(ids, [
    "xhs.scout.home.v1",
    "xhs.feed-play.v1",
    "xhs.nurture-lite.v1",
    "xhs.nurture-grounded.v1",
    "xhs.explore.goal.v1",
  ]);
});

test("planRoutine is deterministic: identical inputs -> identical planHash", () => {
  const a = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 8, seed: "daily" } });
  const b = planRoutine({ templateId: "xhs.feed-play.v1", params: { seed: "daily", items: 8 } });
  assert.equal(a.planHash, b.planHash);
  assert.match(a.planHash, /^[0-9a-f]{64}$/);
  assert.equal(a.schemaVersion, 2);
  assert.equal(ROUTINE_SCHEMA_VERSION, 2);
  const serialized = JSON.parse(JSON.stringify(a));
  assert.equal(serialized.routineRunId, undefined, "plan-only document has no routine execution identity");
  assert.equal(serialized.executionRunId, undefined, "plan-only document has no parent execution identity");
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

test("placement v1: default/explicit single is 03; 01/02 rejected; 04 alone fails closed", () => {
  const implicit = planRoutine({ templateId: "xhs.feed-play.v1", params: {} });
  const explicit = planRoutine({ templateId: "xhs.feed-play.v1", params: {}, alias: "03" });
  assert.equal(implicit.alias, ROUTINE_PRIMARY_ALIAS);
  assert.equal(implicit.planHash, explicit.planHash);
  assert.equal(implicit.parallel, 1);
  assert.equal(implicit.placement.policyId, ROUTINE_PLACEMENT_POLICY_ID);
  assert.equal(implicit.placement.automaticFallback, false);
  assert.deepEqual(implicit.placement.aliases, ["03"]);
  assert.deepEqual(implicit.children.map((child) => child.alias), ["03"]);

  for (const alias of ["01", "02"]) {
    assert.throws(
      () => planRoutine({ templateId: "xhs.feed-play.v1", params: {}, alias }),
      (e) => e.code === "ROUTINE_ALIAS_NOT_ALLOWED",
    );
  }
  assert.throws(
    () => planRoutine({ templateId: "xhs.feed-play.v1", params: {}, alias: ROUTINE_SECONDARY_ALIAS }),
    (e) => e.code === "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY",
  );
});

test("only explicit parallel=2 forms exact read-only [03,04]; social secondary is forbidden", () => {
  const batch = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2 }, parallel: 2 });
  assert.equal(batch.parallel, 2);
  assert.equal(batch.placement.mode, "explicit_concurrency");
  assert.equal(batch.placement.automaticFallback, false);
  assert.deepEqual(batch.placement.aliases, ["03", "04"]);
  assert.deepEqual(batch.children.map((child) => child.alias), ["03", "04"]);
  assert.ok(batch.children.every((child) => child.effectClass === "none" && child.externalEffects === 0));

  const expressedFromSecondary = planRoutine({
    templateId: "xhs.feed-play.v1",
    params: { items: 2 },
    alias: "04",
    parallel: 2,
  });
  assert.equal(expressedFromSecondary.planHash, batch.planHash, "explicit concurrency has one canonical [03,04] meaning");

  assert.throws(
    () => planRoutine({ templateId: "xhs.nurture-lite.v1", params: {}, parallel: 2 }),
    (e) => e.code === "ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN",
  );
  for (const parallel of [0, 3, "all", true]) {
    assert.throws(
      () => planRoutine({ templateId: "xhs.feed-play.v1", params: {}, parallel }),
      (e) => e.code === "ROUTINE_PARALLEL_INVALID",
    );
  }
});

test("execution IDs are bound after planning, random, validated, and never derived from planHash", () => {
  const plan = planRoutine({ templateId: "xhs.feed-play.v1", params: { items: 2 } });
  const first = bindRoutineExecution(plan, {
    randomUUIDFn: () => "00000000-0000-4000-8000-000000000001",
  });
  const second = bindRoutineExecution(plan, {
    randomUUIDFn: () => "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(first.planHash, second.planHash);
  assert.notEqual(first.executionRunId, second.executionRunId);
  assert.notEqual(first.routineRunId, second.routineRunId);
  assert.equal(first.alias, "03");
  assert.equal(first.planAlias, "03");
  assert.equal(validateRoutineExecutionBinding(first), first);
  assert.ok(!first.executionRunId.includes(plan.planHash.slice(0, 16)));
  assert.throws(
    () => validateRoutineExecutionBinding({ ...first, routineRunId: "rr_00000000000040008000000000000009" }),
    (e) => e.code === "ROUTINE_EXECUTION_BINDING_TAMPERED",
  );
  assert.throws(
    () => bindRoutineExecution(plan, { alias: "04" }),
    (e) => e.code === "ROUTINE_SECONDARY_REQUIRES_EXPLICIT_CONCURRENCY",
  );
});

test("parallel execution binding shares executionRunId and gives exact children unique routineRunIds", () => {
  const plan = planRoutine({ templateId: "xhs.scout.home.v1", params: { items: 2 }, parallel: 2 });
  const uuids = [
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
  ];
  const batch = bindRoutineExecutionBatch(plan, { randomUUIDFn: () => uuids.shift() });
  assert.deepEqual(batch.aliases, ["03", "04"]);
  assert.equal(batch.children[0].executionRunId, batch.executionRunId);
  assert.equal(batch.children[1].executionRunId, batch.executionRunId);
  assert.notEqual(batch.children[0].routineRunId, batch.children[1].routineRunId);
  assert.ok(batch.children.every((child) => validateRoutineExecutionBinding(child) === child));
  assert.ok(batch.children.every((child) => child.effectClass === "none"));
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

  const tamperedPlacement = JSON.parse(JSON.stringify(sealable));
  tamperedPlacement.placement.aliases.push("04");
  assert.throws(() => acceptSealedRoutinePlan(tamperedPlacement), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const tamperedConcurrency = JSON.parse(JSON.stringify(sealable));
  tamperedConcurrency.perDeviceConcurrency = 2;
  assert.throws(() => acceptSealedRoutinePlan(tamperedConcurrency), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const inventedTopLevel = { ...JSON.parse(JSON.stringify(sealable)), publish: true };
  assert.throws(() => acceptSealedRoutinePlan(inventedTopLevel), (e) => e.code === "ROUTINE_PLAN_SEALED");

  const badHash = JSON.parse(JSON.stringify(sealable));
  badHash.planHash = "0".repeat(64);
  assert.throws(() => acceptSealedRoutinePlan(badHash), (e) => e.code === "ROUTINE_PLAN_TAMPERED");

  const injectedRunId = JSON.parse(JSON.stringify(sealable));
  injectedRunId.routineRunId = "rr_" + "0".repeat(32);
  assert.throws(() => acceptSealedRoutinePlan(injectedRunId), (e) => e.code === "ROUTINE_PLAN_SEALED");

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
