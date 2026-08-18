import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  recordAttempt,
  evaluatePromotion,
  degradeRecipe,
  descriptorHashOf,
  canonicalJson,
  getRecipe,
  enqueueEvolve,
  buildOverlayDocument,
  writeOverlayFromDb,
  validateRecipeExecutor,
  RECIPE_PRIMITIVE_KINDS,
} from "../scripts/lib/recipe-catalog.mjs";

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "recipe-catalog-"));
  const dbPath = join(dir, "t.db");
  const db = new DatabaseSync(dbPath);
  ensureRecipeTables(db);
  return { db, dir };
}

function signedSuccess(db, { runId, jobId, result = "succeeded", workerWindowId = null, recipeId = "recipe.douyin.observe.snapshot" }) {
  return recordAttempt(db, {
    recipeId,
    revision: 1,
    runId,
    jobId,
    result,
    verificationOk: true,
    restorationOk: true,
    receiptHash: createHash("sha256").update(`${runId}:${jobId}`).digest("hex"),
    workerWindowId,
    legacyClientTrust: true,
  });
}

function sampleSpec(overrides = {}) {
  return {
    schemaId: "xhs.recipe-candidate.v1",
    recipeId: "recipe.douyin.observe.snapshot",
    revision: 1,
    appId: "douyin",
    intentAliases: ["抖音快照", "douyin snapshot"],
    inputSchema: { type: "object", properties: {}, required: [] },
    executor: {
      capabilityId: "douyin.observe.snapshot",
      paramsTemplate: {},
    },
    preconditions: [],
    assertions: ["home visible"],
    restoration: { required: true },
    validityEnvelope: {},
    riskCeiling: "R0",
    originRunId: "run_test_origin",
    evidenceHashes: ["abc"],
    ...overrides,
  };
}

test("ingest creates immutable revision 1 as candidate", () => {
  const { db, dir } = openTempDb();
  try {
    const v = ingestRecipeCandidate(db, { spec: sampleSpec(), actor: "test" });
    assert.equal(v.revision, 1);
    assert.equal(v.status, "candidate");
    assert.equal(v.descriptorHash, descriptorHashOf(sampleSpec()));
    assert.equal(v.spec.descriptorHash, v.descriptorHash);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest from knowledge starts as observed", () => {
  const { db, dir } = openTempDb();
  try {
    const v = ingestRecipeCandidate(db, {
      spec: sampleSpec({ recipeId: "recipe.from.knowledge", fromKnowledge: true }),
    });
    assert.equal(v.status, "observed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate descriptor_hash for same recipe_id+revision is rejected", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    assert.throws(
      () => ingestRecipeCandidate(db, { spec: sampleSpec() }),
      (e) => e.status === 409 && /duplicate descriptor_hash/i.test(e.message),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revision is immutable — different body cannot overwrite same revision", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    assert.throws(
      () =>
        ingestRecipeCandidate(db, {
          spec: sampleSpec({ assertions: ["changed"] }),
        }),
      (e) => e.status === 409,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two independent successes promote candidate chain to canary_only", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    signedSuccess(db, { runId: "run_a", jobId: "job_a", workerWindowId: "w1" });
    signedSuccess(db, { runId: "run_b", jobId: "job_b", workerWindowId: "w2" });
    const ev = evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    assert.equal(ev.status, "canary_only");
    assert.equal(ev.independentSuccesses, 2);
    assert.ok(ev.changed);
    assert.ok(ev.transitions.every((t) => t.receiptHash));
    assert.equal(getRecipe(db, "recipe.douyin.observe.snapshot").latest.status, "canary_only");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two more independent successes promote canary_only to implemented", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    let i = 0;
    for (const [runId, jobId] of [
      ["run_1", "job_1"],
      ["run_2", "job_2"],
      ["run_3", "job_3"],
      ["run_4", "job_4"],
    ]) {
      i += 1;
      signedSuccess(db, { runId, jobId, workerWindowId: `w${i}` });
    }
    const ev = evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    assert.equal(ev.status, "implemented");
    assert.equal(ev.independentSuccesses, 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env failures do not change status", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    signedSuccess(db, { runId: "run_env_1", jobId: "job_env_1", result: "lease_busy", workerWindowId: "w1" });
    signedSuccess(db, { runId: "run_env_2", jobId: "job_env_2", result: "device_offline", workerWindowId: "w2" });
    const ev = evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    assert.equal(ev.status, "candidate");
    assert.equal(ev.independentSuccesses, 0);
    assert.equal(ev.changed, false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client-trusted booleans without legacy flag are rejected", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    assert.throws(
      () => recordAttempt(db, {
        recipeId: "recipe.douyin.observe.snapshot",
        revision: 1,
        runId: "run_x",
        jobId: "job_x",
        result: "succeeded",
        verificationOk: true,
        restorationOk: true,
      }),
      /client-trusted/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsigned successes do not promote; degrade requires receiptHash", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    recordAttempt(db, {
      recipeId: "recipe.douyin.observe.snapshot",
      revision: 1,
      runId: "run_u1",
      jobId: "job_u1",
      legacyClientTrust: true,
      verificationOk: true,
      restorationOk: true,
      result: "succeeded",
      // no receiptHash
    });
    recordAttempt(db, {
      recipeId: "recipe.douyin.observe.snapshot",
      revision: 1,
      runId: "run_u2",
      jobId: "job_u2",
      legacyClientTrust: true,
      verificationOk: true,
      restorationOk: true,
      result: "succeeded",
    });
    const ev = evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    assert.equal(ev.status, "candidate");
    assert.equal(ev.independentSuccesses, 0);

    signedSuccess(db, { runId: "run_a", jobId: "job_a", workerWindowId: "w1" });
    signedSuccess(db, { runId: "run_b", jobId: "job_b", workerWindowId: "w2" });
    evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    const deg = degradeRecipe(db, {
      recipeId: "recipe.douyin.observe.snapshot",
      revision: 1,
      reason: "untrusted_pilot",
      receiptHash: "a".repeat(64),
    });
    assert.equal(deg.status, "degraded");
    assert.throws(
      () => degradeRecipe(db, { recipeId: "recipe.douyin.observe.snapshot", revision: 1, reason: "x" }),
      /receiptHash/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueueEvolve writes queued row", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    const q = enqueueEvolve(db, {
      recipeId: "recipe.douyin.observe.snapshot",
      revision: 1,
    });
    assert.equal(q.state, "queued");
    assert.ok(q.queueId);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOverlayDocument lists canary_only+implemented with sha256", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    let i = 0;
    for (const [runId, jobId] of [
      ["run_1", "job_1"],
      ["run_2", "job_2"],
      ["run_3", "job_3"],
      ["run_4", "job_4"],
    ]) {
      i += 1;
      signedSuccess(db, { runId, jobId, workerWindowId: `ow${i}` });
    }
    evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    const doc = buildOverlayDocument(db);
    assert.equal(doc.schemaId, "xhs.recipe-overlay.v1");
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.recipes.length, 1);
    assert.equal(doc.recipes[0].status, "implemented");
    assert.match(doc.sha256, /^[0-9a-f]{64}$/);
    const { sha256: _omit, ...body } = doc;
    const recomputed = createHash("sha256").update(canonicalJson(body)).digest("hex");
    assert.equal(doc.sha256, recomputed);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOverlayAtomically writes json + sha256 sidecar", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: sampleSpec() });
    // Force canary via two successes then write
    signedSuccess(db, { runId: "run_a", jobId: "job_a", workerWindowId: "wa" });
    signedSuccess(db, { runId: "run_b", jobId: "job_b", workerWindowId: "wb" });
    evaluatePromotion(db, "recipe.douyin.observe.snapshot", 1);
    const overlayPath = join(dir, "generated-overlay", "recipe-catalog.json");
    const written = writeOverlayFromDb(db, { path: overlayPath });
    assert.equal(written.recipeCount, 1);
    assert.ok(existsSync(overlayPath));
    assert.ok(existsSync(`${overlayPath}.sha256`));
    const onDisk = JSON.parse(readFileSync(overlayPath, "utf8"));
    assert.equal(onDisk.sha256, written.sha256);
    assert.equal(readFileSync(`${overlayPath}.sha256`, "utf8").trim(), written.sha256);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: ingest accepts executor.kind=primitive_steps with whitelist steps", () => {
  const { db, dir } = openTempDb();
  try {
    const spec = sampleSpec({
      recipeId: "recipe.primitive.demo",
      executor: {
        kind: "primitive_steps",
        steps: [
          { id: "launch", kind: "launch", params: { appId: "com.ss.android.ugc.aweme" } },
          { id: "shot", kind: "screenshot", params: { label: "home" } },
          { id: "tap", kind: "tapSelector", params: { selector: { text: "搜索" } } },
        ],
      },
    });
    const v = ingestRecipeCandidate(db, { spec, actor: "test" });
    assert.equal(v.status, "candidate");
    assert.equal(v.spec.executor.kind, "primitive_steps");
    assert.equal(v.spec.executor.steps.length, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: ingest rejects unknown primitive kind", () => {
  const { db, dir } = openTempDb();
  try {
    assert.throws(
      () =>
        ingestRecipeCandidate(db, {
          spec: sampleSpec({
            recipeId: "recipe.bad.primitive",
            executor: {
              kind: "primitive_steps",
              steps: [{ id: "x", kind: "shell", params: { cmd: "echo" } }],
            },
          }),
        }),
      /not in whitelist/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: validateRecipeExecutor keeps capability wrapper default", () => {
  const wrap = validateRecipeExecutor({
    capabilityId: "douyin.observe.snapshot",
    paramsTemplate: {},
  });
  assert.equal(wrap.kind, "capability_wrapper");
  assert.deepEqual([...RECIPE_PRIMITIVE_KINDS].sort(), [
    "back",
    "callCapability",
    "dump",
    "focus",
    "input",
    "launch",
    "screenshot",
    "swipe",
    "tapSelector",
  ]);
});
