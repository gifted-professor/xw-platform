import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateJsonSchema } from "../../control-plane/control-plane/lib/json-schema-validator.mjs";
import { compileDag, hashDag, validateDagNodes } from "../scripts/lib/dag-compiler.mjs";
import { classifyTask } from "../scripts/lib/task-router.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DAG_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/orchestration/dag.v1.schema.json"), "utf8"));
const REF_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/skill/skill-version-ref.v1.schema.json"), "utf8"));
DAG_SCHEMA.$defs.skillVersionRef = REF_SCHEMA;
DAG_SCHEMA.$defs.node.properties.skillVersionRef = { $ref: "#/$defs/skillVersionRef" };

function fullRef(skillId) {
  return {
    skillId,
    skillVersion: "1.0.0",
    skillSpecSha256: "b".repeat(64),
    sourceCommit: "f337079d93b6e16993b93f7d28783f57da9a5184",
    sourcePath: `services/orchestrator/skills/${skillId}/SKILL.md`,
    sourceBlobSha: "a".repeat(40),
  };
}

function entry(skillId, roles, options = {}) {
  const localValidator = options.localValidator === true;
  return {
    skillId,
    roles,
    effectClass: options.effectClass ?? "none",
    localValidator,
    executor: options.executor ?? (localValidator
      ? { kind: "local", module: "services/orchestrator/scripts/lib/typed-job-worker.mjs", exportName: "validateBusinessOutput" }
      : { kind: "capability", capabilityId: skillId }),
    skillVersionRef: options.skillVersionRef ?? fullRef(skillId),
  };
}

const CATALOG = [
  entry("xw.collect.snapshot", ["collect"]),
  entry("xw.search.web", ["search"]),
  entry("xw.validate.report", ["validate"], { localValidator: true }),
];

function classification(goal, catalog = CATALOG, overrides = {}) {
  return { ...classifyTask({ goal, catalog }), ...overrides };
}

function compile(goal, options = {}) {
  const catalog = options.catalog ?? CATALOG;
  return compileDag({
    classification: options.classification ?? classification(goal, catalog),
    catalog,
    aliases: options.aliases ?? [],
    traceId: options.traceId ?? "trace-test",
    params: options.params ?? {},
  });
}

function assertSchema(value) {
  assert.deepEqual(validateJsonSchema(value, DAG_SCHEMA), []);
}

test("collection DAG validates against canonical schema and is deeply frozen", () => {
  const dag = compile("四台机器各采集一次首页快照");
  assertSchema(dag);
  assert.match(dag.catalogHash, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(dag));
  assert.ok(Object.isFrozen(dag.nodes));
  for (const node of dag.nodes) assert.ok(Object.isFrozen(node.skillVersionRef));
});

test("collection DAG contains per-worker nodes and one terminal local validator", () => {
  const dag = compile("四台机器各采集一次首页快照");
  const work = dag.nodes.filter((node) => !node.localValidator);
  const validator = dag.nodes.find((node) => node.localValidator);
  assert.equal(work.length, 4);
  assert.equal(validator.skillId, "xw.validate.report");
  assert.deepEqual(validator.dependsOn, work.map((node) => node.nodeId));
  assert.equal(validator.expectedEffectClass, "none");
});

test("explicit aliases target exactly those devices", () => {
  const dag = compile("02 和 04 各刷一次首页", { aliases: ["02", "04"] });
  assert.deepEqual(dag.nodes.filter((node) => !node.localValidator).map((node) => node.targetAliases), [["02"], ["04"]]);
});

test("invalid aliases fail instead of being silently dropped", () => {
  assert.throws(() => compile("采集首页", { aliases: ["02", "05"] }), { code: "DAG_COMPILE_ALIAS" });
});

test("search fans out to the registered sourceSkills and then validates", () => {
  const catalog = [...CATALOG, entry("xw.search.beta", ["search"])];
  const dag = compile("全网搜索各平台价格并对比", { catalog });
  assert.deepEqual(dag.nodes.filter((node) => !node.localValidator).map((node) => node.skillId).sort(), ["xw.search.beta", "xw.search.web"]);
  assertSchema(dag);
});

test("validation is a single registered local validator node", () => {
  const dag = compile("核对验收结果");
  assert.equal(dag.nodes.length, 1);
  assert.equal(dag.nodes[0].skillId, "xw.validate.report");
  assert.equal(dag.nodes[0].localValidator, true);
});

test("missing local validator fails closed and never reuses a collect skill", () => {
  const catalog = [entry("xw.collect.snapshot", ["collect"])];
  assert.throws(() => compile("采集首页", { catalog }), { code: "DAG_COMPILE_NO_VALIDATOR" });
});

test("read-only DAG is execution-ready with no human gate", () => {
  const dag = compile("采集首页");
  assert.equal(dag.executionReady, true);
  assert.equal(dag.humanGate, null);
  assert.ok(dag.nodes.every((node) => node.requiresHuman === false));
});

test("trusted business effect derives requiresHuman and WAIT_HUMAN", () => {
  const catalog = [
    entry("xw.publish.probe", ["collect"], { effectClass: "publish" }),
    entry("xw.validate.report", ["validate"], { localValidator: true }),
  ];
  const dag = compile("采集首页", { catalog });
  assert.equal(dag.executionReady, false);
  assert.equal(dag.humanGate, "WAIT_HUMAN");
  assert.equal(dag.nodes[0].requiresHuman, true);
  assert.equal(dag.nodes[0].expectedEffectClass, "publish");
  assertSchema(dag);
});

test("non-business primary skill is preferred when a role has both", () => {
  const catalog = [
    entry("xw.publish.probe", ["collect"], { effectClass: "publish" }),
    ...CATALOG,
  ];
  const dag = compile("采集首页", { catalog });
  assert.equal(dag.nodes[0].skillId, "xw.collect.snapshot");
  assert.equal(dag.executionReady, true);
});

test("legacy caller-supplied externalEffect is rejected as untrusted", () => {
  const catalog = [{ ...entry("xw.collect.snapshot", ["collect"]), externalEffect: false }, CATALOG[2]];
  assert.throws(() => compile("采集首页", { catalog }), { code: "DAG_CATALOG_UNTRUSTED_EFFECT" });
});

test("authorization-significant effect changes planHash", () => {
  const readOnly = [entry("xw.collect.snapshot", ["collect"]), CATALOG[2]];
  const business = [entry("xw.collect.snapshot", ["collect"], { effectClass: "publish" }), CATALOG[2]];
  const a = compile("采集首页", { catalog: readOnly });
  const b = compile("采集首页", { catalog: business });
  assert.notEqual(a.planHash, b.planHash);
  assert.notEqual(a.dagId, b.dagId);
});

test("dagId is the documented prefix of planHash", () => {
  const dag = compile("采集首页");
  assert.equal(dag.dagId, `dag_${dag.planHash.slice(0, 16)}`);
});

test("traceId is required and propagated", () => {
  assert.throws(() => compileDag({ classification: classification("采集首页"), catalog: CATALOG }), { code: "DAG_TRACE_ID_REQUIRED" });
  const dag = compile("采集首页", { traceId: "trace-abc" });
  assert.equal(dag.traceId, "trace-abc");
});

test("needs_human classifications cannot compile", () => {
  const value = classifyTask({ goal: "发布一条商品信息", catalog: CATALOG });
  assert.throws(() => compileDag({ classification: value, catalog: CATALOG, traceId: "trace-needs-human" }), { code: "DAG_COMPILE_NEEDS_HUMAN" });
});

test("forged unregistered sourceSkills fail before node creation", () => {
  const forged = classification("采集首页", CATALOG, { sourceSkills: ["xw.ghost.skill"] });
  assert.throws(() => compile("采集首页", { classification: forged }), { code: "DAG_COMPILE_UNREGISTERED_SKILL" });
});

test("SkillVersionRef must be complete and match the registration skillId", () => {
  const missing = [{ ...entry("xw.collect.snapshot", ["collect"]), skillVersionRef: { skillId: "xw.collect.snapshot", skillVersion: "1.0.0" } }, CATALOG[2]];
  assert.throws(() => compile("采集首页", { catalog: missing }), { code: "DAG_CATALOG_ENTRY" });

  const mismatched = [entry("xw.collect.snapshot", ["collect"], { skillVersionRef: fullRef("xw.other.skill") }), CATALOG[2]];
  assert.throws(() => compile("采集首页", { catalog: mismatched }), { code: "DAG_CATALOG_ENTRY" });
});

test("duplicate catalog registrations fail closed", () => {
  const validClassification = classification("采集首页");
  assert.throws(
    () => compileDag({
      classification: validClassification,
      catalog: [CATALOG[0], CATALOG[0], CATALOG[2]],
      traceId: "trace-duplicate-catalog"
    }),
    { code: "DAG_CATALOG_ENTRY" }
  );
});

test("classification contract identity, task type, and worker bounds are enforced", () => {
  assert.throws(() => compile("采集首页", { classification: { ...classification("采集首页"), schemaVersion: 2 } }), { code: "DAG_COMPILE_CLASSIFICATION" });
  assert.throws(() => compile("采集首页", { classification: { ...classification("采集首页"), taskType: "mystery" } }), { code: "DAG_COMPILE_UNKNOWN_TYPE" });
  assert.throws(() => compile("采集首页", { classification: { ...classification("采集首页"), workers: 99 } }), { code: "DAG_COMPILE_CLASSIFICATION" });
});

test("forbidden authority fields are rejected recursively in params", () => {
  for (const field of ["leaseId", "transportChannel", "paymentRef", "capabilityId", "executor", "rawCommand"]) {
    assert.throws(() => compile("采集首页", { params: { nested: { [field]: "x" } } }), { code: "DAG_FORBIDDEN_FIELD" });
  }
});

test("same input is deterministic; params change planHash", () => {
  const a = compile("采集首页", { params: { collect: { depth: 1 } } });
  const b = compile("采集首页", { params: { collect: { depth: 1 } } });
  const changed = compile("采集首页", { params: { collect: { depth: 2 } } });
  assert.equal(a.planHash, b.planHash);
  assert.equal(a.dagId, b.dagId);
  assert.notEqual(a.planHash, changed.planHash);
  assert.equal(hashDag(a), hashDag(b));
});

test("compiler clones refs and params instead of freezing caller inputs", () => {
  const catalog = CATALOG.map((item) => ({ ...item, roles: [...item.roles], skillVersionRef: { ...item.skillVersionRef } }));
  const params = { collect: { depth: 1 } };
  compile("采集首页", { catalog, params });
  assert.equal(Object.isFrozen(catalog[0].skillVersionRef), false);
  assert.equal(Object.isFrozen(params.collect), false);
});

test("manual cyclic DAG is rejected", () => {
  const nodes = [
    { nodeId: "n1", dependsOn: ["n2"], targetAliases: [], localValidator: false },
    { nodeId: "n2", dependsOn: ["n1"], targetAliases: [], localValidator: false },
  ];
  assert.throws(() => validateDagNodes(nodes), { code: "DAG_COMPILE_CYCLE" });
});

test("self, unknown, duplicate dependencies and invalid aliases are rejected", () => {
  assert.throws(() => validateDagNodes([{ nodeId: "n1", dependsOn: ["n1"], targetAliases: [], localValidator: false }]), { code: "DAG_COMPILE_CYCLE" });
  assert.throws(() => validateDagNodes([{ nodeId: "n1", dependsOn: ["n2"], targetAliases: [], localValidator: false }]), { code: "DAG_COMPILE_UNKNOWN_DEP" });
  assert.throws(() => validateDagNodes([
    { nodeId: "n1", dependsOn: [], targetAliases: [], localValidator: false },
    { nodeId: "n1", dependsOn: [], targetAliases: [], localValidator: false },
  ]), { code: "DAG_COMPILE_DUPLICATE_NODE" });
  assert.throws(() => validateDagNodes([{ nodeId: "n1", dependsOn: [], targetAliases: ["05"], localValidator: false }]), { code: "DAG_COMPILE_ALIAS" });
});

test("local validator nodes must remain terminal", () => {
  const nodes = [
    { nodeId: "n1", dependsOn: [], targetAliases: [], localValidator: true },
    { nodeId: "n2", dependsOn: ["n1"], targetAliases: [], localValidator: false },
  ];
  assert.throws(() => validateDagNodes(nodes), { code: "DAG_COMPILE_VALIDATOR_NON_TERMINAL" });
});

test("params flow into cloned node inputs", () => {
  const dag = compile("采集首页", { params: { collect: { mode: "snapshot" }, reduce: { field: "cardCount" } } });
  assert.deepEqual(dag.nodes[0].inputs, { mode: "snapshot" });
  assert.deepEqual(dag.nodes.at(-1).inputs, { reduce: { field: "cardCount" } });
});
