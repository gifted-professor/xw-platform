import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateJsonSchema } from "../../control-plane/control-plane/lib/json-schema-validator.mjs";
import { lowerXhsRpaProgramToM5 } from "../scripts/lib/xhs-rpa-m5-adapter.mjs";
import {
  deriveNodeSeed,
  compileXhsRpaProgram,
  hashXhsRpa,
  projectXhsRpaCatalog,
  XHS_RPA_BUDGET_POLICY,
  XHS_RPA_EVIDENCE_POLICY,
  XHS_RPA_FAILURE_POLICY,
  XHS_RPA_FORBIDDEN_ACTIONS,
  XHS_RPA_MISFIRE_POLICY,
  XHS_RPA_RETENTION_POLICY,
  XHS_RPA_SEED_POLICY,
} from "../scripts/lib/xhs-rpa-program.mjs";
import { makeCatalog, makeProgram, RPA_ACCOUNT, RPA_RUNTIME } from "./fixtures/xhs-rpa-fixtures.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/orchestration/xhs-rpa-program.v1.schema.json"), "utf8"));
const DAG_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/orchestration/dag.v1.schema.json"), "utf8"));
const SKILL_REF_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "packages/kernel/contracts/skill/skill-version-ref.v1.schema.json"), "utf8"));
DAG_SCHEMA.$defs.skillVersionRef = SKILL_REF_SCHEMA;
DAG_SCHEMA.$defs.node.properties.skillVersionRef = { $ref: "#/$defs/skillVersionRef" };

test("P7 program compiler is deterministic, schema-valid, disabled and TaskPlanV2-only", () => {
  const one = makeProgram("explore");
  const two = makeProgram("explore");
  assert.equal(one.program.programHash, two.program.programHash);
  assert.equal(one.program.taskPlanHash, two.program.taskPlanHash);
  assert.deepEqual(validateJsonSchema(one.program, SCHEMA), []);
  assert.equal(one.program.enabled, false);
  assert.equal(one.program.recurringEnabled, false);
  assert.equal(one.program.programVersion, 1);
  assert.equal(one.program.ownerRef, "own_xhs_v3_rpa_foundation");
  assert.equal(one.program.rollbackGeneration, 0);
  assert.equal(one.program.externalEffects, 0);
  assert.equal(one.program.writeTransportBudget, 0);
  assert.deepEqual(one.program.forbiddenActions, XHS_RPA_FORBIDDEN_ACTIONS);
  assert.deepEqual(one.program.seedPolicy, XHS_RPA_SEED_POLICY);
  assert.deepEqual(one.program.budgetPolicy, XHS_RPA_BUDGET_POLICY);
  assert.deepEqual(one.program.failurePolicy, XHS_RPA_FAILURE_POLICY);
  assert.deepEqual(one.program.misfirePolicy, XHS_RPA_MISFIRE_POLICY);
  assert.deepEqual(one.program.evidencePolicy, XHS_RPA_EVIDENCE_POLICY);
  assert.deepEqual(one.program.retentionPolicy, XHS_RPA_RETENTION_POLICY);
  assert.deepEqual(one.program.pacing, {
    accountConcurrency: 1,
    dailyStarts: 1,
    minimumIntervalMs: 1_800_000,
    preIoRetryMax: 1,
  });
  const lowered = lowerXhsRpaProgramToM5({ program: one.program, catalogSnapshot: one.catalogSnapshot });
  assert.equal(lowered.dag.schemaId, "xw.orchestration.dag.v1");
  assert.deepEqual(validateJsonSchema(lowered.dag, DAG_SCHEMA), []);
  assert.equal(lowered.taskPlan.schemaId, "xhs.task-plan.v2");
  assert.equal(lowered.taskPlan.planHash, one.program.taskPlanHash);
  assert.equal(lowered.thirdSchedulerIntroduced, false);
  assert.deepEqual(lowered.taskPlan.nodes[0].shards.map((shard) => shard.placement.alias), ["03", "04"]);
  assert.equal(lowered.taskPlan.nodes[0].executor.kind, "session_workflow");
});

test("catalog evidence projection keeps candidate/search/browse/social/inactive/stale/missing acceptance ineligible", () => {
  const catalog = makeCatalog();
  const byId = new Map(catalog.entries.map((entry) => [entry.entryId, entry]));
  for (const id of [
    "xhs.search.candidate", "xhs.browse.candidate", "xhs.social.bad",
    "xhs.inactive.read", "xhs.stale.read", "xhs.missing.acceptance",
  ]) assert.equal(byId.get(id).eligible, false, id);
  assert.ok(byId.get("xhs.search.candidate").reasons.includes("CURRENT_CANDIDATE_INELIGIBLE"));
  assert.ok(byId.get("xhs.browse.candidate").reasons.includes("CURRENT_CANDIDATE_INELIGIBLE"));
  assert.ok(byId.get("xhs.social.bad").reasons.includes("EFFECT_NOT_NONE"));
  assert.ok(byId.get("xhs.inactive.read").reasons.includes("REVISION_INACTIVE"));
  assert.ok(byId.get("xhs.stale.read").reasons.includes("STALE_RELEASE"));
  assert.ok(byId.get("xhs.missing.acceptance").reasons.includes("ACCEPTANCE_MISSING"));
});

test("compiler rejects catalog presence without acceptance and every procedure-bearing parameter", () => {
  const catalogSnapshot = makeCatalog();
  const rejected = catalogSnapshot.entries.find((entry) => entry.entryId === "xhs.search.candidate");
  const catalogRef = Object.fromEntries([
    "entryId", "kind", "revision", "templateHash", "descriptorHash", "effectClass",
    "placement", "maturity", "status", "acceptanceReceiptHashes", "runner",
    "cleanupContractHash", "expectedReceiptSchema",
  ].map((key) => [key, rejected[key]]));
  assert.throws(() => compileXhsRpaProgram({
    programId: "xrp_candidate_rejected",
    programVersion: 1,
    ownerRef: "own_candidate_rejected",
    accountRef: RPA_ACCOUNT,
    rollbackGeneration: 0,
    catalogSnapshot,
    nodes: [{
      nodeId: "candidate",
      catalogRef,
      fixedParams: {},
      inputPrivateRefs: [],
      dependsOn: [],
    }],
  }), { code: "XHS_RPA_CATALOG_INELIGIBLE" });

  for (const params of [
    { shell: "no" }, { nested: { endpoint: "no" } }, { path: "no" },
    { coordinate: { x: 1, y: 2 } }, { providerAlias: "03" }, { moduleName: "no" },
  ]) assert.throws(() => makeProgram("feed", { params }), { code: "XHS_RPA_FORBIDDEN_FIELD" });
  assert.throws(() => makeProgram("feed", { params: { operation: "like" } }), {
    code: "XHS_RPA_TRANSITIVE_EFFECT_FORBIDDEN",
  });
  for (const value of ["https://caller.invalid", "C:\\caller\\module.mjs", "adb shell input tap 1 1"]) {
    assert.throws(() => makeProgram("feed", { params: { value } }), { code: "XHS_RPA_FORBIDDEN_FIELD" });
  }
});

test("projection input and program pacing are exact and bounded", () => {
  assert.throws(() => projectXhsRpaCatalog({ entries: [], runtime: { ...RPA_RUNTIME, extra: true } }), {
    code: "XHS_RPA_CATALOG_INPUT_INVALID",
  });
  assert.throws(() => compileXhsRpaProgram({
    programId: "xrp_unknown_key_test",
    programVersion: 1,
    ownerRef: "own_unknown_key_test",
    accountRef: RPA_ACCOUNT,
    rollbackGeneration: 0,
    catalogSnapshot: makeCatalog(),
    nodes: [],
    callerEndpoint: "forbidden",
  }), { code: "XHS_RPA_PROGRAM_INPUT_INVALID" });
  assert.throws(() => makeProgram("feed", { pacing: { minimumIntervalMs: 299_999 } }), {
    code: "XHS_RPA_PACING_INVALID",
  });
  assert.throws(() => makeProgram("feed", { pacing: { dailyStarts: 5 } }), {
    code: "XHS_RPA_PACING_INVALID",
  });
  assert.throws(() => makeProgram("feed", { pacing: { callerAlias: "03" } }), {
    code: "XHS_RPA_PACING_INVALID",
  });
  assert.throws(() => lowerXhsRpaProgramToM5({
    program: makeProgram("feed").program,
    catalogSnapshot: makeCatalog(),
    executor: "caller-chosen",
  }), { code: "XHS_RPA_ADAPTER_INPUT_INVALID" });
});

test("§3.5 policy, identity, catalog-ref and opaque-private-ref mutations reject before lowering", () => {
  assert.throws(() => makeProgram("feed", { programVersion: 0 }), { code: "XHS_RPA_PROGRAM_IDENTITY_INVALID" });
  assert.throws(() => makeProgram("feed", { ownerRef: "raw owner" }), { code: "XHS_RPA_PROGRAM_IDENTITY_INVALID" });
  assert.throws(() => makeProgram("feed", { rollbackGeneration: 2 }), { code: "XHS_RPA_PROGRAM_IDENTITY_INVALID" });
  assert.throws(() => makeProgram("feed", { externalEffects: 1 }), { code: "XHS_RPA_EFFECT_POLICY_INVALID" });
  assert.throws(() => makeProgram("feed", { writeTransportBudget: 1 }), { code: "XHS_RPA_EFFECT_POLICY_INVALID" });
  assert.throws(() => makeProgram("feed", { forbiddenActions: XHS_RPA_FORBIDDEN_ACTIONS.slice(1) }), { code: "XHS_RPA_EFFECT_POLICY_INVALID" });
  for (const [field, value, code] of [
    ["seedPolicy", { ...XHS_RPA_SEED_POLICY, callerRandomness: true }, "XHS_RPA_SEED_POLICY_INVALID"],
    ["budgetPolicy", { ...XHS_RPA_BUDGET_POLICY, maxProgramNodes: 9 }, "XHS_RPA_BUDGET_POLICY_INVALID"],
    ["failurePolicy", { ...XHS_RPA_FAILURE_POLICY, nodeFailure: "continue" }, "XHS_RPA_FAILURE_POLICY_INVALID"],
    ["misfirePolicy", { ...XHS_RPA_MISFIRE_POLICY, mode: "catch_up" }, "XHS_RPA_MISFIRE_POLICY_INVALID"],
    ["evidencePolicy", { ...XHS_RPA_EVIDENCE_POLICY, validator: "optional" }, "XHS_RPA_EVIDENCE_POLICY_INVALID"],
    ["retentionPolicy", { ...XHS_RPA_RETENTION_POLICY, privateRawDays: 8 }, "XHS_RPA_RETENTION_POLICY_INVALID"],
  ]) assert.throws(() => makeProgram("feed", { [field]: value }), { code });
  assert.throws(() => makeProgram("feed", { inputPrivateRefs: ["raw query text"] }), { code: "XHS_RPA_NODE_INVALID" });

  const base = makeProgram("feed");
  const ref = base.program.nodes[0].catalogRef;
  const mutations = [
    { kind: "recipe_revision" },
    { templateHash: "f".repeat(64) },
    { descriptorHash: "f".repeat(64) },
    { effectClass: "social" },
    { placement: { mode: "fixed", aliases: ["04"] } },
    { maturity: "candidate" },
    { status: "inactive" },
    { acceptanceReceiptHashes: ["f".repeat(64)] },
    { runner: { ...ref.runner, contractHash: "f".repeat(64) } },
    { cleanupContractHash: "f".repeat(64) },
    { expectedReceiptSchema: "xhs.other-receipt.v1" },
  ];
  for (const mutation of mutations) {
    assert.throws(() => makeProgram("feed", { catalogRef: { ...ref, ...mutation } }), { code: "XHS_RPA_CATALOG_DRIFT" });
  }
});

test("node seed is reproduced solely from program hash + Asia/Shanghai local slot + node id", () => {
  const { program } = makeProgram("feed");
  const first = deriveNodeSeed(program.programHash, "2026-08-30", "feed_read");
  assert.equal(first, deriveNodeSeed(program.programHash, "2026-08-30", "feed_read"));
  assert.notEqual(first, deriveNodeSeed(program.programHash, "2026-08-31", "feed_read"));
  assert.notEqual(first, deriveNodeSeed(program.programHash, "2026-08-30", "feed_other"));
  assert.throws(() => deriveNodeSeed(program.programHash, "2026-08-30", "bad/random"), {
    code: "XHS_RPA_SEED_INPUT_INVALID",
  });
});

test("execution adapter revalidates the whole catalog snapshot and every sealed node ref", () => {
  const base = makeProgram("feed");
  const rawEntries = base.catalogSnapshot.entries.map(({ eligible: _eligible, reasons: _reasons, ...entry }) => structuredClone(entry));
  rawEntries.find((entry) => entry.entryId === "xhs.browse.candidate").templateHash = "f".repeat(64);
  const driftedSnapshot = projectXhsRpaCatalog({ entries: rawEntries, runtime: RPA_RUNTIME });
  assert.throws(() => lowerXhsRpaProgramToM5({ program: base.program, catalogSnapshot: driftedSnapshot }), {
    code: "XHS_RPA_PROGRAM_SEAL_INVALID",
  });

  const node = base.program.nodes[0];
  const nodes = [{
    ...node,
    catalogRef: { ...node.catalogRef, expectedReceiptSchema: "xhs.forged-receipt.v1" },
  }];
  const body = {
    ...base.program,
    nodes,
    dagHash: hashXhsRpa({ nodes, edges: base.program.edges }),
  };
  delete body.programHash;
  const forged = { ...body, programHash: hashXhsRpa(body) };
  assert.throws(() => lowerXhsRpaProgramToM5({ program: forged, catalogSnapshot: base.catalogSnapshot }), {
    code: "XHS_RPA_CATALOG_DRIFT",
  });
});
