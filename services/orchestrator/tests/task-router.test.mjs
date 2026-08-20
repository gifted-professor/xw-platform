import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../control-plane/control-plane/lib/json-schema-validator.mjs";
import { classifyTask, classificationHash, MAX_WORKERS } from "../scripts/lib/task-router.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/orchestration/task-classification.v1.schema.json"), "utf8"));
const CATALOG = [
  { skillId: "xw.collect.snapshot", roles: ["collect"] },
  { skillId: "xw.search.web", roles: ["search"] },
  { skillId: "xw.validate.report", roles: ["validate"] },
];

function assertSchema(value) {
  assert.deepEqual(validateJsonSchema(value, SCHEMA), []);
}

test("natural collection output validates against the canonical schema", () => {
  const value = classifyTask({ goal: "四台机器各采集一次首页快照", catalog: CATALOG, devices: 4 });
  assertSchema(value);
  assert.equal(value.taskType, "collection");
  assert.equal(value.parallel, true);
  assert.equal(value.workers, 4);
  assert.equal(value.strategy, "fan_out_collect");
  assert.deepEqual(value.sourceSkills, ["xw.collect.snapshot"]);
});

test("the M5 four-device card-count goal stays a collection route", () => {
  const value = classifyTask({
    goal: "四台机器各刷一次首页并汇总卡片数",
    catalog: CATALOG,
    devices: 4
  });
  assert.equal(value.taskType, "collection");
  assert.equal(value.validatorRequired, true);
  assert.equal(value.workers, 4);
});

test("structured type works without natural-language text", () => {
  const value = classifyTask({ goal: { type: "collection" }, catalog: CATALOG, devices: 2 });
  assertSchema(value);
  assert.equal(value.taskType, "collection");
  assert.equal(value.workers, 2);
});

test("unknown structured type fails closed", () => {
  const value = classifyTask({ goal: { type: "publish" }, catalog: CATALOG });
  assertSchema(value);
  assert.equal(value.taskType, "needs_human");
  assert.equal(value.needsHumanReason, "unknown_structured_type");
});

test("structured type conflicting with text is ambiguous", () => {
  const value = classifyTask({ goal: { type: "validation", text: "全网搜索价格" }, catalog: CATALOG });
  assert.equal(value.taskType, "needs_human");
  assert.equal(value.needsHumanReason, "ambiguous_goal");
});

test("natural-language multi-class ambiguity fails closed", () => {
  const value = classifyTask({ goal: "搜索每台设备首页", catalog: CATALOG });
  assert.equal(value.taskType, "needs_human");
  assert.equal(value.needsHumanReason, "ambiguous_goal");
});

test("missing and empty goals return needs_human rather than throwing", () => {
  for (const goal of [undefined, "", "   ", {}]) {
    const value = classifyTask({ goal, catalog: CATALOG });
    assertSchema(value);
    assert.equal(value.taskType, "needs_human");
    assert.equal(value.needsHumanReason, "missing_goal");
  }
});

test("workers are clamped to MAX_WORKERS=4", () => {
  assert.equal(classifyTask({ goal: "采集设备状态", catalog: CATALOG, devices: 12 }).workers, MAX_WORKERS);
  assert.equal(classifyTask({ goal: "采集设备状态", catalog: CATALOG, devices: 0 }).workers, 1);
});

test("explicit aliases select the schema-declared alias strategy", () => {
  const value = classifyTask({ goal: "02 和 04 各刷一次首页", catalog: CATALOG });
  assertSchema(value);
  assert.equal(value.strategy, "alias_fan_out_reduce");
});

test("search references only registered search-role skills", () => {
  const value = classifyTask({ goal: "全网搜索各平台价格并对比", catalog: CATALOG });
  assertSchema(value);
  assert.equal(value.taskType, "search");
  assert.deepEqual(value.sourceSkills, ["xw.search.web"]);
});

test("validation is sequential, single-worker, and references only validators", () => {
  const value = classifyTask({ goal: "核对验收结果", catalog: CATALOG, devices: 4 });
  assertSchema(value);
  assert.equal(value.taskType, "validation");
  assert.equal(value.workers, 1);
  assert.deepEqual(value.sourceSkills, ["xw.validate.report"]);
});

test("every concrete task type needs a registered matching role", () => {
  for (const [goal, reason] of [
    ["采集设备状态", "no_registered_collect_skill"],
    ["搜索价格", "no_registered_search_skill"],
    ["核对结果", "no_registered_validate_skill"],
  ]) {
    const value = classifyTask({ goal, catalog: [] });
    assert.equal(value.taskType, "needs_human");
    assert.equal(value.needsHumanReason, reason);
  }
});

test("external-effect goals fail closed", () => {
  for (const goal of ["发布一条商品信息", "给该笔记点赞", "私信买家确认价格", "取消订单并退款"]) {
    const value = classifyTask({ goal, catalog: CATALOG });
    assert.equal(value.taskType, "needs_human", goal);
    assert.equal(value.needsHumanReason, "external_effect_not_allowed", goal);
  }
});

test("unclassified goal fails closed", () => {
  const value = classifyTask({ goal: "帮我看看今天天气怎么样", catalog: CATALOG });
  assert.equal(value.taskType, "needs_human");
  assert.equal(value.needsHumanReason, "unclassified_goal");
});

test("forbidden authority and transport fields are rejected recursively", () => {
  for (const field of ["leaseId", "transportChannel", "paymentRef", "capabilityId", "executor", "rawCommand"]) {
    assert.throws(
      () => classifyTask({ goal: { text: "采集首页", nested: { [field]: "x" } }, catalog: CATALOG }),
      (error) => error.code === "TASK_FORBIDDEN_FIELD",
      field,
    );
  }
});

test("invalid and duplicate catalog registrations are rejected", () => {
  assert.throws(() => classifyTask({ goal: "采集", catalog: [{ skillId: "BAD", roles: ["collect"] }] }), { code: "TASK_CATALOG_INVALID" });
  assert.throws(() => classifyTask({ goal: "采集", catalog: [
    { skillId: "xw.collect.snapshot", roles: ["collect"] },
    { skillId: "xw.collect.snapshot", roles: ["collect"] },
  ] }), { code: "TASK_CATALOG_INVALID" });
});

test("results and sourceSkills are deeply frozen", () => {
  const value = classifyTask({ goal: "采集首页", catalog: CATALOG });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.sourceSkills));
});

test("classification hash is deterministic and changes with worker count", () => {
  const first = classifyTask({ goal: "采集首页", catalog: CATALOG, devices: 4 });
  const same = classifyTask({ goal: "采集首页", catalog: CATALOG, devices: 4 });
  const changed = classifyTask({ goal: "采集首页", catalog: CATALOG, devices: 3 });
  assert.equal(classificationHash(first), classificationHash(same));
  assert.notEqual(classificationHash(first), classificationHash(changed));
  assert.match(classificationHash(first), /^[0-9a-f]{64}$/);
});
