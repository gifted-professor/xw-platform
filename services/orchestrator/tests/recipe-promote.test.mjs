import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  getRecipe,
  evaluatePromotion,
} from "../scripts/lib/recipe-catalog.mjs";
import {
  buildRunnerAttemptReceipt,
  promoteRunnerRun,
  RUNNER_ATTEMPT_RECEIPT_SCHEMA,
} from "../ops/xw-recipe-promote.mjs";
import { XHS_SEARCH_FIXED_RECIPE } from "../../control-plane/tests/fixtures/xhs-search-fixed.recipe.mjs";

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "recipe-promote-"));
  const db = new DatabaseSync(join(dir, "t.db"));
  ensureRecipeTables(db);
  return { db, dir };
}

/** Model of the CP GET /recipe-runs/:id payload (receipt shape from the live run). */
function recipeRunPayload({ recipeRunId, status = "SUCCEEDED", ok = true, serverVerified = true,
  mode = "live", verifiedSteps = 9, stepCount = 9, failedStepId = null, recipeId = "xhs.search.fixed",
  revision = 1, descriptorHash = "rh_ce41a6a2c6f975b4a66b52c8" }) {
  const receipt = {
    schemaId: "xw.single-device.recipe-receipt.v1",
    recipeRunId,
    recipeId,
    revision,
    descriptorHash,
    alias: "04",
    status: status === "SUCCEEDED" ? "SUCCEEDED" : status,
    ok,
    mode,
    serverVerified,
    failedStepId,
    stepCount,
    verifiedSteps,
    stepResults: [],
    sessionId: `session_${recipeRunId}`,
    leaseId: `lease_${recipeRunId}`,
    deviceId: `dev_${recipeRunId}`,
    error: null,
    plannedCalls: [],
    createdAt: "2026-08-26T17:17:15.692Z",
    finishedAt: "2026-08-26T17:17:30.002Z",
  };
  return {
    recipeRun: {
      schemaId: "xw.single-device.recipe-run.v1",
      recipeRunId,
      recipeId,
      revision,
      descriptorHash,
      status,
      alias: "04",
      actorId: "claude-pilot-20260809",
      input: { keyword: "深圳攀岩", pages: 1 },
      steps: [],
      stepResults: [],
      sessionId: receipt.sessionId,
      leaseId: receipt.leaseId,
      deviceId: receipt.deviceId,
      createdAt: receipt.createdAt,
      updatedAt: receipt.finishedAt,
      finishedAt: receipt.finishedAt,
      receipt,
      error: null,
    },
  };
}

test("buildRunnerAttemptReceipt produces a sealed receipt for a successful live run", () => {
  const p = recipeRunPayload({ recipeRunId: "rr_aaa" });
  const out = buildRunnerAttemptReceipt(p, { recipeId: "xhs.search.fixed", revision: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.receipt.schemaId, RUNNER_ATTEMPT_RECEIPT_SCHEMA);
  assert.equal(out.receipt.recipeId, "xhs.search.fixed");
  assert.equal(out.receipt.revision, 1);
  assert.equal(out.receipt.runId, "rr_aaa");
  assert.equal(out.receipt.jobId, "rr_aaa");
  assert.ok(out.receipt.receiptHash && out.receipt.receiptHash.length === 64);
  assert.equal(out.receipt.verificationOk, true);
  assert.equal(out.receipt.restorationOk, true);
});

test("buildRunnerAttemptReceipt rejects non-succeeded / non-live / not-server-verified / partial", () => {
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r1", status: "FAILED" })).ok, false);
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r2", ok: false })).ok, false);
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r3", serverVerified: false })).ok, false);
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r4", mode: "shadow" })).ok, false);
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r5", verifiedSteps: 8, stepCount: 9 })).ok, false);
  assert.equal(buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r6", failedStepId: "input_keyword" })).ok, false);
});

test("buildRunnerAttemptReceipt rejects recipeId/revision mismatch", () => {
  assert.equal(
    buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r7" }), { recipeId: "other.recipe" }).ok,
    false,
  );
  assert.equal(
    buildRunnerAttemptReceipt(recipeRunPayload({ recipeRunId: "r8" }), { revision: 2 }).ok,
    false,
  );
});

test("two independent live Runner runs promote candidate -> canary_only via the formal chain", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: XHS_SEARCH_FIXED_RECIPE, actor: "test" });
    let g = getRecipe(db, "xhs.search.fixed");
    assert.equal(g.latest.status, "candidate");

    const o1 = promoteRunnerRun(db, recipeRunPayload({ recipeRunId: "rr_run_one" }));
    assert.equal(o1.ok, true, JSON.stringify(o1));
    assert.ok(o1.attempt, "first run recorded as an attempt");
    // 1 success alone cannot clear the 2-success threshold.
    assert.equal(o1.promotion.status, "candidate");
    assert.equal(o1.promotion.changed, false);

    const o2 = promoteRunnerRun(db, recipeRunPayload({ recipeRunId: "rr_run_two" }));
    assert.equal(o2.ok, true);
    assert.equal(o2.promotion.status, "canary_only");
    assert.equal(o2.promotion.independentSuccesses, 2);
    assert.equal(o2.promotion.changed, true);
    // The chain candidate -> replay_verified -> promotable -> canary_only in one evaluate pass.
    const reasons = o2.promotion.transitions.map((t) => t.reason);
    assert.deepEqual(reasons, ["two_independent_successes", "two_independent_successes", "two_independent_successes"]);

    g = getRecipe(db, "xhs.search.fixed");
    assert.equal(g.attempts.length, 2);
    assert.equal(g.transitions.length, 1 + 3); // ingest seed + 3 promotion transitions
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-recording the same recipeRunId is idempotent (no duplicate attempt)", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: XHS_SEARCH_FIXED_RECIPE, actor: "test" });
    promoteRunnerRun(db, recipeRunPayload({ recipeRunId: "rr_dup" }));
    const again = promoteRunnerRun(db, recipeRunPayload({ recipeRunId: "rr_dup" }));
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    const g = getRecipe(db, "xhs.search.fixed");
    assert.equal(g.attempts.length, 1, "no duplicate attempt for same recipeRunId");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("four independent live Runner runs promote canary_only -> implemented", () => {
  const { db, dir } = openTempDb();
  try {
    ingestRecipeCandidate(db, { spec: XHS_SEARCH_FIXED_RECIPE, actor: "test" });
    for (const id of ["rr_a", "rr_b", "rr_c", "rr_d"]) {
      promoteRunnerRun(db, recipeRunPayload({ recipeRunId: id }));
    }
    // After 2 it is canary_only; after 4 evaluatePromotion should reach implemented.
    const ev = evaluatePromotion(db, "xhs.search.fixed", 1);
    assert.equal(ev.status, "implemented");
    assert.equal(ev.independentSuccesses, 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});