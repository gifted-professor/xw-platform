import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared canonical source (the single implementation all consumers import).
import {
  canonicalDescriptorHash,
  canonicalJson,
  isCanonicalV2,
} from "../control-plane/lib/recipe-descriptor.mjs";
// Catalog side
import {
  descriptorHashOf,
  ingestRecipeCandidate,
  recordVerifiedAttempt,
  evaluatePromotion,
  buildOverlayDocument,
  ensureRecipeTables,
} from "../../orchestrator/scripts/lib/recipe-catalog.mjs";
// CP Runner side
import { computeDescriptorHash } from "../control-plane/lib/recipe-interpreter.mjs";
import { SingleDeviceRecipeRunner } from "../control-plane/lib/single-device-recipe-runner.mjs";
// Promotion bridge
import { buildRunnerAttemptReceipt } from "../../orchestrator/ops/xw-recipe-promote.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPEC_PATH = join(HERE, "..", "config", "recipes", "xhs.search.fixed@2.json");
const AT2 = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
// The independently stamped production descriptorHash (authoritative oracle).
const EXPECTED_HASH = AT2.descriptorHash;

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "f1-hash-"));
  const db = new DatabaseSync(join(dir, "t.db"));
  ensureRecipeTables(db);
  return { db, dir };
}

function makeRunner() {
  // live:false (plan-mode) never invokes these, but the constructor requires them.
  return new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
  });
}

// --- F1-independent-canonical-bytes -----------------------------------------

test("F1: @2 spec is canonical-v2 and carries a 64-hex descriptorHash", () => {
  assert.equal(isCanonicalV2(AT2), true);
  assert.match(EXPECTED_HASH, /^[0-9a-f]{64}$/);
  assert.notEqual(EXPECTED_HASH, "0".repeat(64), "must not be the placeholder");
});

test("F1: shared canonicalDescriptorHash is byte-identical to the stamped hash", () => {
  // Recompute from the spec with descriptorHash + status + originRunId removed
  // (independent oracle). These three are non-sealed: descriptorHash is
  // self-referential, status mutates across the promotion lifecycle, and
  // originRunId is Catalog provenance bookkeeping the hand-authored spec lacks.
  const { descriptorHash: _omitHash, status: _omitStatus, originRunId: _omitOrigin, ...rest } = AT2;
  const recomputed = createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
  assert.equal(recomputed, EXPECTED_HASH);
  assert.equal(canonicalDescriptorHash(AT2), EXPECTED_HASH);
});

test("F1: Catalog descriptorHashOf === shared canonicalDescriptorHash === stamped", () => {
  assert.equal(descriptorHashOf(AT2), EXPECTED_HASH);
  assert.equal(descriptorHashOf(AT2), canonicalDescriptorHash(AT2));
});

test("F1: CP computeDescriptorHash is scheme-aware and emits the same 64-hex for @2", () => {
  // @2 (canonical-v2) -> 64-hex full-spec hash, matching Catalog/shared.
  assert.equal(computeDescriptorHash(AT2), EXPECTED_HASH);
  assert.match(computeDescriptorHash(AT2), /^[0-9a-f]{64}$/);
  // legacy spec (no scheme) still emits rh_+24 (regression guard for @1).
  const legacy = { recipeId: "x", revision: 1, executor: { kind: "primitive_steps", steps: [] } };
  assert.match(computeDescriptorHash(legacy), /^rh_[0-9a-f]{24}$/);
});

test("F1: Runner seals a plan-mode run with the canonical 64-hex (no device I/O)", async () => {
  const runner = makeRunner();
  const run = await runner.start({ recipe: structuredClone(AT2), params: { keyword: "深圳攀岩" }, actorId: "a:f1", live: false });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.descriptorHash, EXPECTED_HASH);
  assert.match(run.descriptorHash, /^[0-9a-f]{64}$/);
  assert.equal(run.receipt.mode, "plan");
});

test("F1: Catalog ingest stores the same 64-hex; overlay + promotion receipt match", () => {
  const { db, dir } = tempDb();
  try {
    const v = ingestRecipeCandidate(db, { spec: structuredClone(AT2), actor: "f1" });
    assert.equal(v.descriptorHash, EXPECTED_HASH);
    assert.equal(v.spec.descriptorHash, EXPECTED_HASH);
    assert.equal(v.revision, 2);

    // Two independent signed successes -> canary_only, then overlay carries @2.
    const ok = (runId, job, win) => recordVerifiedAttempt(db, {
      recipeId: "xhs.search.fixed", revision: 2, runId, jobId: job,
      receipt: {
        ok: true, result: "succeeded", verificationOk: true, restorationOk: true,
        receipt: {
          recipeId: "xhs.search.fixed", revision: 2, runId, jobId: job,
          receiptHash: createHash("sha256").update(runId).digest("hex"),
          evidenceIds: [], evidenceHashes: [],
        },
      },
      workerWindowId: win,
    });
    ok("rr_f1a", "rr_f1a", "ow1");
    ok("rr_f1b", "rr_f1b", "ow2");
    const promo = evaluatePromotion(db, "xhs.search.fixed", 2);
    assert.equal(promo.status, "canary_only");

    const overlay = buildOverlayDocument(db);
    const entry = overlay.recipes.find((r) => r.recipeId === "xhs.search.fixed" && r.revision === 2);
    assert.ok(entry, "overlay lists @2");
    assert.equal(entry.descriptorHash, EXPECTED_HASH);
    assert.equal(entry.descriptorHashScheme, "canonical-v2");
    // The overlay entry's full spec reproduces the hash (byte-identical canonical JSON).
    assert.equal(canonicalDescriptorHash(entry), EXPECTED_HASH);

    // Promotion bridge receipt carries the same 64-hex from the Runner receipt.
    const recipeRun = {
      recipeRunId: "rr_f1a",
      status: "SUCCEEDED",
      receipt: {
        ok: true, serverVerified: true, mode: "live",
        recipeId: "xhs.search.fixed", revision: 2,
        recipeRunId: "rr_f1a",
        descriptorHash: EXPECTED_HASH,
        verifiedSteps: 9, stepCount: 9, alias: "04",
      },
    };
    const built = buildRunnerAttemptReceipt(recipeRun, { recipeId: "xhs.search.fixed", revision: 2 });
    assert.equal(built.ok, true);
    assert.equal(built.receipt.descriptorHash, EXPECTED_HASH);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F1-hash-mutation --------------------------------------------------------

function at2With(patch) {
  const clone = structuredClone(AT2);
  return { ...clone, ...patch };
}

test("F1 mutation: changing clearFirst changes the canonical hash", () => {
  const step = AT2.executor.steps.find((s) => s.id === "input_keyword");
  const mutated = structuredClone(AT2);
  const mStep = mutated.executor.steps.find((s) => s.id === "input_keyword");
  mStep.params.clearFirst = false;
  assert.notEqual(canonicalDescriptorHash(mutated), EXPECTED_HASH);
  assert.notEqual(descriptorHashOf(mutated), EXPECTED_HASH);
  assert.notEqual(computeDescriptorHash(mutated), EXPECTED_HASH);
  void step;
});

test("F1 mutation: changing pages max changes the canonical hash", () => {
  const mutated = structuredClone(AT2);
  mutated.inputSchema.properties.pages.maximum = 5;
  assert.notEqual(canonicalDescriptorHash(mutated), EXPECTED_HASH);
});

test("F1 mutation: changing a postAssertion changes the canonical hash", () => {
  const mutated = structuredClone(AT2);
  mutated.executor.steps[0].postAssertions[0].value = "com.other";
  assert.notEqual(canonicalDescriptorHash(mutated), EXPECTED_HASH);
});

test("F1 mutation: Runner rejects a stale/tampered descriptorHash before live execution", async () => {
  const tampered = structuredClone(AT2);
  tampered.descriptorHash = "f".repeat(64); // wrong 64-hex, not placeholder
  const runner = makeRunner();
  await assert.rejects(
    runner.start({ recipe: tampered, params: { keyword: "x" }, actorId: "a:f1", live: false }),
    (e) => e.code === "RECIPE_DESCRIPTOR_HASH_MISMATCH",
  );
});

test("F1 mutation: Runner accepts the placeholder descriptorHash (recomputed+sealed)", async () => {
  const fresh = structuredClone(AT2);
  fresh.descriptorHash = "0".repeat(64); // placeholder -> overwritten with computed
  const runner = makeRunner();
  const run = await runner.start({ recipe: fresh, params: { keyword: "x" }, actorId: "a:f1", live: false });
  assert.equal(run.descriptorHash, EXPECTED_HASH);
});

// --- F1 path exercise --------------------------------------------------------

test("F1 path exercise: every consumer compared the @2 hash (none skipped)", () => {
  // Belt-and-braces: explicitly assert each consumer returned the expected hash
  // rather than silently passing behind an optional guard.
  const consumers = {
    "shared.canonicalDescriptorHash": canonicalDescriptorHash(AT2),
    "catalog.descriptorHashOf": descriptorHashOf(AT2),
    "cp.computeDescriptorHash": computeDescriptorHash(AT2),
  };
  for (const [name, h] of Object.entries(consumers)) {
    assert.equal(h, EXPECTED_HASH, `${name} did not match the stamped hash`);
  }
});