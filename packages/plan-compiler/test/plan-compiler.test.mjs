import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PARALLELISM_MODES, compilePlan } from "../lib/plan-compiler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
}

function loadFixture(name) {
  return loadJson(`packages/plan-compiler/fixtures/${name}`);
}

// Minimal hand-written validators mirroring the JSON schemas (same style as
// packages/kernel/lib/skill-runtime.mjs): required keys, no extra keys, consts.
function checkKeys(doc, keys, label) {
  for (const key of Object.keys(doc)) {
    assert.ok(keys.includes(key), `${label}: unexpected key ${key}`);
  }
}

const SKILL_VERSION_REF_KEYS = [
  "skillId",
  "skillVersion",
  "skillSpecSha256",
  "sourceCommit",
  "sourcePath",
  "sourceBlobSha",
];

const PLAN_KEYS = [
  "schemaId",
  "schemaVersion",
  "planRunId",
  "skillId",
  "skillVersionRef",
  "requestedWorkers",
  "selectedWorkers",
  "shards",
  "join",
  "reduce",
  "verification",
];

function validateSkillVersionRef(ref) {
  checkKeys(ref, SKILL_VERSION_REF_KEYS, "skillVersionRef");
  assert.match(ref.skillId, /^[a-z0-9]+(\.[a-z0-9-]+)+$/);
  assert.match(ref.skillVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.match(ref.skillSpecSha256, /^[0-9a-f]{64}$/);
  assert.match(ref.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(ref.sourceBlobSha, /^[0-9a-f]{40}$/);
  assert.ok(ref.sourcePath.length > 0);
}

function validateExecutionPlan(plan) {
  checkKeys(plan, PLAN_KEYS, "execution-plan");
  assert.equal(plan.schemaId, "xw.execution.plan.v1");
  assert.equal(plan.schemaVersion, 1);
  assert.ok(plan.planRunId.length > 0);
  assert.match(plan.skillId, /^[a-z0-9]+(\.[a-z0-9-]+)+$/);
  validateSkillVersionRef(plan.skillVersionRef);
  assert.ok(Number.isInteger(plan.requestedWorkers) && plan.requestedWorkers >= 1);
  assert.ok(Number.isInteger(plan.selectedWorkers) && plan.selectedWorkers >= 0);
  assert.ok(Array.isArray(plan.shards) && plan.shards.length >= 1);
  for (const shard of plan.shards) {
    checkKeys(shard, ["shardRunId", "input", "assignedDeviceId"], "shard");
    assert.ok(shard.shardRunId.length > 0);
    assert.ok(shard.input && typeof shard.input === "object");
    assert.ok(shard.assignedDeviceId === undefined || typeof shard.assignedDeviceId === "string" || shard.assignedDeviceId === null);
  }
  checkKeys(plan.join, ["waitPolicy", "minimum"], "join");
  assert.ok(["all", "minimum", "quorum", "first", "best_effort"].includes(plan.join.waitPolicy));
  checkKeys(plan.reduce, ["strategy", "dedupeKey"], "reduce");
  assert.ok(plan.reduce.strategy.length > 0);
  if (plan.verification !== undefined) {
    checkKeys(plan.verification, ["mode", "sampleRate"], "verification");
    assert.ok(plan.verification.mode.length > 0);
  }
  // red line: an execution plan never carries lease/transport/payment fields
  assert.doesNotMatch(JSON.stringify(plan), /"[^"]*(lease|transport|payment)[^"]*"\s*:/i);
}

const PARALLELISM_SPEC_KEYS = [
  "schemaId",
  "schemaVersion",
  "mode",
  "verificationMode",
  "splitDimensions",
  "minWorkers",
  "maxWorkers",
  "reassignable",
  "deviceRequirements",
  "completionPolicy",
  "minimumSuccessfulShards",
  "quorumOf",
  "quorumTotal",
  "merge",
  "verification",
  "dataClassification",
];

function validateParallelismSpec(spec) {
  checkKeys(spec, PARALLELISM_SPEC_KEYS, "parallelism-spec");
  assert.equal(spec.schemaId, "xw.skill.parallelism.v1");
  assert.equal(spec.schemaVersion, 1);
  assert.ok(PARALLELISM_MODES.includes(spec.mode));
  assert.ok(
    ["all_success", "minimum_success", "quorum", "first_success", "best_effort"].includes(
      spec.completionPolicy,
    ),
  );
  if (spec.completionPolicy === "minimum_success") {
    assert.ok(Number.isInteger(spec.minimumSuccessfulShards));
  }
  if (spec.completionPolicy === "quorum") {
    assert.ok(Number.isInteger(spec.quorumOf) && Number.isInteger(spec.quorumTotal));
  }
  if (spec.dataClassification?.classification === "financial_sensitive") {
    assert.equal(spec.dataClassification.rawValueInHarnessLog, false);
  }
}

function devices(count, { offline = [] } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const deviceId = `dev-${String(index + 1).padStart(2, "0")}`;
    return { deviceId, status: offline.includes(deviceId) ? "offline" : "online" };
  });
}

const skillVersion = {
  skillId: "xhs.collect",
  skillVersionRef: {
    skillId: "xhs.collect",
    skillVersion: "1.1.0",
    skillSpecSha256: "b".repeat(64),
    sourceCommit: "f337079d93b6e16993b93f7d28783f57da9a5184",
    sourcePath: "services/orchestrator/skills/xhs/xhs-collect/SKILL.md",
    sourceBlobSha: "a".repeat(40),
  },
};

function baseSpec(overrides = {}) {
  return {
    schemaId: "xw.skill.parallelism.v1",
    schemaVersion: 1,
    mode: "shardable",
    completionPolicy: "all_success",
    ...overrides,
  };
}

test("five modes x device-count matrix", () => {
  const variants = [{ input: { q: 1 } }, { input: { q: 2 } }, { input: { q: 3 } }];
  const cases = [
    { mode: "single", goal: { input: { q: 1 } }, spec: {}, counts: [1, 4], expect: 1 },
    { mode: "shardable", goal: { variants }, spec: { maxWorkers: 2 }, counts: [1, 4], expect: [1, 2] },
    { mode: "replicated", goal: { input: { q: 1 }, replicas: 3 }, spec: { maxWorkers: 3 }, counts: [2, 5], expect: [2, 3] },
    {
      mode: "device_affine",
      goal: { variants: [{ deviceId: "dev-01", input: {} }, { deviceId: "dev-02", input: {} }] },
      spec: { maxWorkers: 2, reassignable: false },
      counts: [1, 3],
      expect: [1, 2],
    },
    {
      mode: "quorum_verify",
      goal: { input: { q: 1 } },
      spec: { maxWorkers: 3, completionPolicy: "quorum", quorumOf: 2, quorumTotal: 3, minWorkers: 2 },
      counts: [2, 4],
      expect: [2, 3],
    },
  ];
  for (const { mode, goal, spec, counts, expect } of cases) {
    for (const [index, count] of counts.entries()) {
      const plan = compilePlan({
        goal,
        skillVersion,
        parallelismSpec: baseSpec({ mode, ...spec }),
        availableDevices: devices(count),
        budget: {},
      });
      const wanted = Array.isArray(expect) ? expect[index] : expect;
      assert.equal(plan.selectedWorkers, wanted, `${mode} with ${count} devices`);
      validateExecutionPlan(plan);
    }
  }
});

test("concurrency formula: min(spec.maxWorkers, devices, shards, budget.maxWorkers)", () => {
  const goal = { variants: [{ input: { q: 1 } }, { input: { q: 2 } }] };
  const plan = compilePlan({
    goal,
    skillVersion,
    parallelismSpec: baseSpec({ maxWorkers: 8 }),
    availableDevices: devices(5),
    budget: { maxWorkers: 3 },
  });
  assert.equal(plan.selectedWorkers, 2);
  const cappedByBudget = compilePlan({
    goal: { variants: Array.from({ length: 9 }, (_, i) => ({ input: { q: i } })) },
    skillVersion,
    parallelismSpec: baseSpec({ maxWorkers: 8 }),
    availableDevices: devices(5),
    budget: { maxWorkers: 3 },
  });
  assert.equal(cappedByBudget.selectedWorkers, 3);
  assert.equal(cappedByBudget.requestedWorkers, 3);
});

test("INSUFFICIENT_DEVICES is fail-closed", () => {
  assert.throws(
    () =>
      compilePlan({
        goal: { variants: [{ input: {} }] },
        skillVersion,
        parallelismSpec: baseSpec({ minWorkers: 2 }),
        availableDevices: devices(1),
        budget: {},
      }),
    { code: "INSUFFICIENT_DEVICES" },
  );
  assert.throws(
    () =>
      compilePlan({
        goal: { input: {} },
        skillVersion,
        parallelismSpec: baseSpec({ mode: "single", minWorkers: 1 }),
        availableDevices: [{ deviceId: "dev-01", status: "offline" }],
        budget: {},
      }),
    { code: "INSUFFICIENT_DEVICES" },
  );
});

test("device_affine pins shards and never re-binds an offline device", () => {
  const plan = compilePlan({
    goal: {
      variants: [
        { deviceId: "dev-01", input: {} },
        { deviceId: "dev-02", input: {} },
      ],
    },
    skillVersion,
    parallelismSpec: baseSpec({ mode: "device_affine", maxWorkers: 2, reassignable: false }),
    availableDevices: devices(2, { offline: ["dev-02"] }),
    budget: {},
  });
  assert.equal(plan.shards[0].assignedDeviceId, "dev-01");
  assert.equal(plan.shards[1].assignedDeviceId, null);
  assert.throws(
    () =>
      compilePlan({
        goal: { variants: [{ deviceId: "dev-01", input: {} }] },
        skillVersion,
        parallelismSpec: baseSpec({ mode: "device_affine", reassignable: true }),
        availableDevices: devices(1),
        budget: {},
      }),
    { code: "INVALID_PARALLELISM_SPEC" },
  );
});

test("quorum thresholds and quorum_verify shard count", () => {
  const plan = compilePlan({
    goal: { input: { account: "main" } },
    skillVersion,
    parallelismSpec: baseSpec({
      mode: "quorum_verify",
      completionPolicy: "quorum",
      quorumOf: 2,
      quorumTotal: 3,
      minWorkers: 2,
    }),
    availableDevices: devices(3),
    budget: {},
  });
  assert.equal(plan.shards.length, 3);
  assert.equal(plan.join.waitPolicy, "quorum");
  assert.equal(plan.join.minimum, 2);
  assert.throws(
    () =>
      compilePlan({
        goal: { input: {} },
        skillVersion,
        parallelismSpec: baseSpec({
          mode: "quorum_verify",
          completionPolicy: "quorum",
          quorumOf: 4,
          quorumTotal: 3,
        }),
        availableDevices: devices(3),
        budget: {},
      }),
    { code: "INVALID_PARALLELISM_SPEC" },
  );
});

test("minimum_success boundary: minimum must not exceed shard count", () => {
  const goal = { variants: [{ input: { q: 1 } }, { input: { q: 2 } }] };
  const ok = compilePlan({
    goal,
    skillVersion,
    parallelismSpec: baseSpec({ completionPolicy: "minimum_success", minimumSuccessfulShards: 2 }),
    availableDevices: devices(2),
    budget: {},
  });
  assert.equal(ok.join.waitPolicy, "minimum");
  assert.equal(ok.join.minimum, 2);
  assert.throws(
    () =>
      compilePlan({
        goal,
        skillVersion,
        parallelismSpec: baseSpec({ completionPolicy: "minimum_success", minimumSuccessfulShards: 3 }),
        availableDevices: devices(2),
        budget: {},
      }),
    { code: "INVALID_PARALLELISM_SPEC" },
  );
});

test("plans are deep-frozen and recompilation is deterministic", () => {
  const input = {
    goal: { variants: [{ input: { q: 1 } }, { input: { q: 2 } }] },
    skillVersion,
    parallelismSpec: baseSpec({ maxWorkers: 2 }),
    availableDevices: devices(2),
    budget: {},
  };
  const plan = compilePlan(input);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.shards));
  assert.ok(Object.isFrozen(plan.shards[0]));
  assert.ok(Object.isFrozen(plan.shards[0].input));
  assert.throws(() => {
    plan.selectedWorkers = 99;
  }, TypeError);
  const again = compilePlan(input);
  assert.deepEqual(again, plan);
});

test("plan inputs must not carry lease/transport/payment fields", () => {
  assert.throws(
    () =>
      compilePlan({
        goal: { input: {}, leaseId: "lease_1" },
        skillVersion,
        parallelismSpec: baseSpec({ mode: "single" }),
        availableDevices: devices(1),
        budget: {},
      }),
    { code: "PLAN_FORBIDDEN_FIELD" },
  );
});

test("all plan fixtures compile to their frozen expected plan and validate", () => {
  for (const name of [
    "plan-shardable-search.v1.json",
    "plan-device-affine.v1.json",
    "plan-quorum-verify.v1.json",
  ]) {
    const fixture = loadFixture(name);
    validateParallelismSpec(fixture.input.parallelismSpec);
    const plan = compilePlan(fixture.input);
    validateExecutionPlan(plan);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), fixture.expected, name);
  }
});

test("kernel parallelism fixture validates against the spec contract", () => {
  const spec = loadJson("packages/kernel/contracts/parallelism/fixtures/xhs-collect.parallelism.v1.json");
  validateParallelismSpec(spec);
  assert.equal(spec.mode, "shardable");
  assert.equal(spec.minimumSuccessfulShards, 3);
  assert.equal(spec.merge.dedupeKey, "canonicalNoteId");
  const skillSpecFixture = loadJson("packages/kernel/contracts/skill/fixtures/xhs-collect.spec.v1.json");
  assert.equal(
    skillSpecFixture.parallelismRef.path,
    "packages/kernel/contracts/parallelism/fixtures/xhs-collect.parallelism.v1.json",
  );
  assert.match(skillSpecFixture.parallelismRef.sha256, /^[0-9a-f]{64}$/);
});

test("parallelism contract schemas keep urn $id and closed shape", () => {
  const expected = {
    "skill-parallelism-spec.v1.schema.json": ["urn:xw:contract:skill-parallelism-spec:v1", "xw.skill.parallelism.v1"],
    "execution-plan.v1.schema.json": ["urn:xw:contract:execution-plan:v1", "xw.execution.plan.v1"],
    "shard-run.v1.schema.json": ["urn:xw:contract:shard-run:v1", "xw.shard.run.v1"],
    "placement-decision.v1.schema.json": ["urn:xw:contract:placement-decision:v1", "xw.placement.decision.v1"],
  };
  for (const [file, [$id, schemaId]] of Object.entries(expected)) {
    const schema = loadJson(`packages/kernel/contracts/parallelism/${file}`);
    assert.equal(schema.$id, $id);
    assert.equal(schema.properties.schemaId.const, schemaId);
    assert.equal(schema.additionalProperties, false);
  }
  const correlation = loadJson("packages/kernel/contracts/skill/correlation-ids.v1.schema.json");
  for (const key of [
    "planRunId",
    "shardRunId",
    "workerRunId",
    "placementDecisionId",
    "leaseId",
    "joinRunId",
    "reducerRunId",
    "verificationRunId",
  ]) {
    assert.ok(correlation.properties[key], `correlation-ids missing ${key}`);
  }
  assert.deepEqual(correlation.required, ["traceId"]);
});
