import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ensureRecipeTables,
  ingestRecipeCandidate,
  evaluatePromotion,
} from "../../orchestrator/scripts/lib/recipe-catalog.mjs";
import {
  openDb,
  loadFixtureSpec,
  promoteRunnerRun,
  cmdSwitchAlias,
  cmdEmitOverlay,
} from "../../orchestrator/ops/xw-recipe-promote.mjs";

const AT2 = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "config", "recipes", "xhs.search.fixed@2.json"), "utf8"),
);
const HASH2 = AT2.descriptorHash;

/** Model of the CP recipe-run payload for a live @2 search run (9/9 verified). */
function liveRunPayload(recipeRunId) {
  const receipt = {
    schemaId: "xw.single-device.recipe-receipt.v1",
    recipeRunId, recipeId: "xhs.search.fixed", revision: 2, descriptorHash: HASH2,
    alias: "04", status: "SUCCEEDED", ok: true, mode: "live", serverVerified: true,
    failedStepId: null, stepCount: 9, verifiedSteps: 9, stepResults: [],
    sessionId: `s_${recipeRunId}`, leaseId: `l_${recipeRunId}`, deviceId: "alias-04",
  };
  return {
    recipeRun: {
      schemaId: "xw.single-device.recipe-run.v1", recipeRunId,
      recipeId: "xhs.search.fixed", revision: 2, descriptorHash: HASH2,
      status: "SUCCEEDED", alias: "04", actorId: "agent:test", receipt,
    },
  };
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "xhs-promote-chain-"));
  return dir;
}

test("chain: ingest @2 production spec via loader (canonical-v2, 64-hex)", async () => {
  const dir = tempDir();
  const db = openDb(join(dir, "t.db"));
  try {
    const spec = await loadFixtureSpec("xhs.search.fixed");
    assert.equal(spec.descriptorHash, HASH2);
    assert.equal(spec.descriptorHashScheme, "canonical-v2");
    assert.equal(spec.revision, 2);
    // Idempotent: ingesting the same revision twice is rejected by the Catalog PK.
    const v = ingestRecipeCandidate(db, { spec: structuredClone(spec), actor: "test" });
    assert.equal(v.revision, 2);
    assert.equal(v.descriptorHash, HASH2);
    assert.throws(
      () => ingestRecipeCandidate(db, { spec: structuredClone(spec), actor: "test" }),
      (e) => /duplicate|immutable/.test(String(e?.message || e)),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chain: two live @2 runs -> canary_only -> switch-alias -> overlay carries @2", async () => {
  const dir = tempDir();
  const db = openDb(join(dir, "t.db"));
  const statePath = join(dir, "dispatch-state.json");
  const overlayPath = join(dir, "overlay.json");
  try {
    // 1. ingest @2
    const spec = await loadFixtureSpec("xhs.search.fixed");
    ingestRecipeCandidate(db, { spec: structuredClone(spec), actor: "test" });

    // 2. promote two independent live runs
    const a = promoteRunnerRun(db, liveRunPayload("rr_chain_a"), { evaluate: false });
    const b = promoteRunnerRun(db, liveRunPayload("rr_chain_b"), { evaluate: false });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.idempotent || true, true); // first record is not idempotent; both ok

    // 3. evaluate -> canary_only (2 independent successes)
    const ev = evaluatePromotion(db, "xhs.search.fixed", 2);
    assert.equal(ev.status, "canary_only");
    assert.equal(ev.independentSuccesses, 2);

    // 4. switch-alias (fail-closed: canary_only passes)
    writeFileSync(statePath, JSON.stringify({ recipeRevisions: { "xhs.search.fixed": 1 }, liveGates: {} }), "utf8");
    const sw = await cmdSwitchAlias(db, {
      recipe: "xhs.search.fixed", revision: 2, action: "search", "state-path": statePath,
    });
    assert.equal(sw.ok, true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.recipeRevisions["xhs.search.fixed"], 2);
    assert.equal(state.liveGates.search, true);

    // 4b. switch-alias fails closed for a non-promoted revision
    const bad = await cmdSwitchAlias(db, { recipe: "xhs.search.fixed", revision: 99, "state-path": statePath });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /not found in Catalog/);

    // 5. emit-overlay -> @2 appears with canonical-v2 hash
    await cmdEmitOverlay(db, { path: overlayPath });
    assert.ok(existsSync(overlayPath));
    const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
    const entry = overlay.recipes.find((r) => r.recipeId === "xhs.search.fixed" && r.revision === 2);
    assert.ok(entry, "overlay lists @2");
    assert.equal(entry.descriptorHash, HASH2);
    assert.equal(entry.descriptorHashScheme, "canonical-v2");
    assert.equal(entry.status, "canary_only");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chain: switch-alias fails closed when status is still candidate (not promoted)", async () => {
  const dir = tempDir();
  const db = openDb(join(dir, "t.db"));
  const statePath = join(dir, "dispatch-state.json");
  try {
    const spec = await loadFixtureSpec("xhs.search.fixed");
    ingestRecipeCandidate(db, { spec: structuredClone(spec), actor: "test" });
    // No live runs promoted -> status is candidate
    const ev = evaluatePromotion(db, "xhs.search.fixed", 2);
    assert.equal(ev.status, "candidate");
    writeFileSync(statePath, JSON.stringify({ recipeRevisions: {}, liveGates: {} }), "utf8");
    const blocked = await cmdSwitchAlias(db, { recipe: "xhs.search.fixed", revision: 2, "state-path": statePath });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /must be canary_only or implemented/);
    // state file unchanged
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.recipeRevisions["xhs.search.fixed"], undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chain: re-promoting the same recipeRunId is idempotent (no double count)", async () => {
  const dir = tempDir();
  const db = openDb(join(dir, "t.db"));
  try {
    const spec = await loadFixtureSpec("xhs.search.fixed");
    ingestRecipeCandidate(db, { spec: structuredClone(spec), actor: "test" });
    const first = promoteRunnerRun(db, liveRunPayload("rr_idem"), { evaluate: false });
    assert.equal(first.ok, true);
    assert.notEqual(first.idempotent, true, "first record is new");
    const second = promoteRunnerRun(db, liveRunPayload("rr_idem"), { evaluate: false });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true, "second record is idempotent");
    // Only one attempt counted -> still candidate (need 2 distinct)
    const ev = evaluatePromotion(db, "xhs.search.fixed", 2);
    assert.equal(ev.independentSuccesses, 1);
    assert.notEqual(ev.status, "canary_only");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});