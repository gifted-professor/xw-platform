import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationStore,
  buildRunManifest,
  isBusinessEffectPlan,
} from "../scripts/lib/orchestration-store.mjs";
import { createTaskPlanV2 } from "../scripts/lib/task-plan-v2.mjs";
import { EXECUTION_PLAN_SCHEMA_ID } from "../scripts/lib/task-plan-capability-binding.mjs";
import { bindFixturePlan } from "./helpers/bind-fixture-plan.mjs";

test("buildRunManifest assigns stable operationKeys without attemptIndex", () => {
  const plan = createTaskPlanV2({
    goal: "prep",
    requestKey: "orch-manifest-1",
    nodes: [{
      nodeId: "n1",
      executor: {
        kind: "typed_job",
        capabilityId: "xianyu.publish.full_dry_run",
        appId: "xianyu",
        effectClass: "external_effect",
        replaySafety: "replay_safe",
      },
      shards: [{ shardIndex: 0, params: { saveDraft: false }, placement: { alias: "01" } }],
    }],
  });
  const { executionPlan, executionPlanHash } = bindFixturePlan(plan, {
    "xianyu.publish.full_dry_run": {
      capabilityContractHash: "c".repeat(64),
      implementationClosureHash: "a".repeat(64),
      normalizedEffect: { class: "publish", phase: "prepare", commitBoundary: "automatic" },
    },
  });
  const manifest = buildRunManifest({
    taskRunId: "run_manifest_1",
    plan,
    executionPlan,
    executionPlanHash,
  });
  assert.equal(manifest.schemaId, "xhs.run-manifest.v2");
  assert.equal(manifest.workUnits.length, 1);
  assert.equal(manifest.workUnits[0].operationKey, `m2:run_manifest_1:${plan.nodes[0].shards[0].shardKey}`);
  assert.equal(manifest.workUnits[0].operationKey.includes(":a"), false);
  assert.equal(manifest.workUnits[0].deviceId, null);
  assert.equal(manifest.workUnits[0].alias, "01");
  assert.equal(isBusinessEffectPlan(plan, executionPlan), true);
});

test("buildRunManifest rejects unbound ExecutionPlan", () => {
  const plan = createTaskPlanV2({
    goal: "prep",
    requestKey: "orch-manifest-unbound",
    nodes: [{
      nodeId: "n1",
      executor: {
        kind: "typed_job",
        capabilityId: "cap.a",
        appId: "xhs",
        effectClass: "none",
        replaySafety: "read_only",
      },
      shards: [{ shardIndex: 0, params: {}, placement: { alias: "01" } }],
    }],
  });
  assert.throws(
    () => buildRunManifest({ taskRunId: "run_x", plan, executionPlan: null }),
    (e) => e.code === "EXECUTION_PLAN_REQUIRED",
  );
  assert.throws(
    () => buildRunManifest({
      taskRunId: "run_x",
      plan,
      executionPlan: {
        schemaId: EXECUTION_PLAN_SCHEMA_ID,
        executionPlanHash: "e".repeat(64),
        sourcePlanHash: "f".repeat(64),
        nodes: [{ nodeId: "n1" }],
      },
    }),
    (e) => e.code === "EXECUTION_PLAN_SOURCE_MISMATCH",
  );
});

test("init writes run-manifest atomically before state and rejects plan conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-store-"));
  try {
    const plan = createTaskPlanV2({
      goal: "prep2",
      requestKey: "orch-manifest-2",
      nodes: [{
        nodeId: "n1",
        executor: {
          kind: "typed_job",
          capabilityId: "xianyu.observe.snapshot",
          appId: "xianyu",
          effectClass: "none",
          replaySafety: "read_only",
        },
        shards: [{ shardIndex: 0, params: {}, placement: { alias: "01" } }],
      }],
    });
    const { executionPlan, executionPlanHash } = bindFixturePlan(plan, {
      "xianyu.observe.snapshot": { capabilityContractHash: "a".repeat(64) },
    });
    const store = new OrchestrationStore({ taskRunId: "run_orch_2", workRoot: root });
    const state = store.init(plan, { executionPlan, executionPlanHash });
    assert.equal(state.planHash, plan.planHash);
    assert.equal(existsSync(store.manifestPath), true);
    const manifest = store.loadManifest();
    assert.equal(manifest.executionPlanHash, executionPlanHash);
    assert.equal(manifest.workUnits[0].operationKey.startsWith("m2:run_orch_2:"), true);

    // resume same plan ok
    store.init(plan, { executionPlan, executionPlanHash });

    // conflict on different planHash
    const other = createTaskPlanV2({
      goal: "other",
      requestKey: "orch-manifest-3",
      nodes: [{
        nodeId: "n1",
        executor: {
          kind: "typed_job",
          capabilityId: "xianyu.observe.snapshot",
          appId: "xianyu",
          effectClass: "none",
          replaySafety: "read_only",
        },
        shards: [{ shardIndex: 0, params: { x: 1 }, placement: { alias: "02" } }],
      }],
    });
    assert.throws(() => store.init(other, { ...bindFixturePlan(other) }), /TASK_RUN_PLAN_CONFLICT/);

    // bind device after preflight
    const unit = store.bindWorkUnitDevice({
      shardKey: plan.nodes[0].shards[0].shardKey,
      alias: "01",
      deviceId: "dev_test_1",
    });
    assert.equal(unit.deviceId, "dev_test_1");
    assert.equal(store.loadManifest().workUnits[0].deviceId, "dev_test_1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
