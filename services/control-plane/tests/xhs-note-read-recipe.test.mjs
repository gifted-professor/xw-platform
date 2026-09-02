/**
 * xhs-note-read-recipe.test.mjs — offline tests for xhs.note.read.fixed@1:
 * sealing, whitelist coverage, no sealed coordinates, and cross-consumer hash
 * identity (Catalog / interpreter / runner). Mirrors xhs-browse-recipe.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  canonicalDescriptorHash,
  isCanonicalV2,
} from "../control-plane/lib/recipe-descriptor.mjs";
import { descriptorHashOf } from "../../orchestrator/scripts/lib/recipe-catalog.mjs";
import { computeDescriptorHash, validateRecipeSteps } from "../control-plane/lib/recipe-interpreter.mjs";
import { SingleDeviceRecipeRunner } from "../control-plane/lib/single-device-recipe-runner.mjs";
import {
  validateRecipeExecutor,
  RECIPE_PRIMITIVE_KINDS,
} from "../../orchestrator/scripts/lib/recipe-catalog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPEC_PATH = join(HERE, "..", "config", "recipes", "xhs.note.read.fixed@1.json");
const NOTE_READ = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const HASH = NOTE_READ.descriptorHash;

test("note.read@1: spec is canonical-v2 with a 64-hex descriptorHash", () => {
  assert.equal(isCanonicalV2(NOTE_READ), true);
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.notEqual(HASH, "0".repeat(64));
});

test("note.read@1: all 8 step kinds are in both whitelists (CP + Catalog)", () => {
  const kinds = NOTE_READ.executor.steps.map((s) => s.kind);
  for (const k of kinds) {
    assert.ok(RECIPE_PRIMITIVE_KINDS.includes(k), `step kind ${k} must be whitelisted`);
  }
  assert.equal(NOTE_READ.riskCeiling, "R0");
  assert.deepEqual(NOTE_READ.eligibleAliases, ["04"]);
});

test("note.read@1: no sealed coordinates — card selection happens at run time", () => {
  for (const step of NOTE_READ.executor.steps) {
    const p = step.params || {};
    assert.equal(p.x, undefined, `step ${step.id}: no sealed x`);
    assert.equal(p.y, undefined, `step ${step.id}: no sealed y`);
    assert.equal(p.from, undefined, `step ${step.id}: no sealed swipe from`);
    assert.equal(p.to, undefined, `step ${step.id}: no sealed swipe to`);
    assert.equal(p.deviceBound, undefined, `step ${step.id}: no sealed deviceBound`);
  }
});

test("note.read@1: tap_feed_card asserts note-detail content, not activity", () => {
  const step = NOTE_READ.executor.steps.find((s) => s.id === "tap_feed_card");
  assert.equal(step.kind, "tapFeedCard");
  // Live evidence (2026-09-02, device 04): this XHS build renders note detail
  // inside IndexActivityV2 — activityMatches is not discriminative. The detail
  // comment-bar placeholder only exists on detail screens (home feed + search
  // dumps both lack it).
  assert.deepEqual(step.postAssertions, [
    { type: "textExists", value: "说点什么" },
  ]);
  assert.deepEqual(step.params, { fallbackToAny: true, pickIndex: 0, preferKind: "image" });
});

test("note.read@1: dump step carries no params (explorer schema is strict)", () => {
  const step = NOTE_READ.executor.steps.find((s) => s.id === "dump_detail");
  assert.deepEqual(step.params, {});
});

test("note.read@1: validateRecipeSteps accepts the executor", () => {
  const v = validateRecipeSteps(NOTE_READ.executor.steps);
  assert.equal(v.ok, true);
  assert.equal(v.steps.length, 8);
  const r = validateRecipeExecutor(NOTE_READ.executor);
  assert.equal(r.kind, "primitive_steps");
  assert.equal(r.steps.length, 8);
});

test("note.read@1: three consumers produce the same canonical hash", () => {
  assert.equal(canonicalDescriptorHash(NOTE_READ), HASH);
  assert.equal(descriptorHashOf(NOTE_READ), HASH);
  assert.equal(computeDescriptorHash(NOTE_READ), HASH);
});

test("note.read@1: Runner seals a plan-mode run with the canonical hash (no device I/O)", async () => {
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
  });
  const run = await runner.start({ recipe: structuredClone(NOTE_READ), params: {}, actorId: "a:note-read", live: false });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.descriptorHash, HASH);
  assert.equal(run.receipt.mode, "plan");
  assert.deepEqual(run.steps.map((s) => s.id), [
    "launch_xhs",
    "settle_home",
    "tap_feed_card",
    "settle_detail",
    "dump_detail",
    "screenshot_detail",
    "dwell",
    "return_feed",
  ]);
});

test("note.read@1: mutation of a step param changes the canonical hash", () => {
  const mutated = structuredClone(NOTE_READ);
  mutated.executor.steps.find((s) => s.id === "settle_detail").params.ms = 900;
  assert.notEqual(canonicalDescriptorHash(mutated), HASH);
});

test("note.read@1: empty input schema rejects unexpected params", async () => {
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
  });
  await assert.rejects(
    () => runner.start({ recipe: structuredClone(NOTE_READ), params: { keyword: "x" }, actorId: "a", live: false }),
    (e) => /not allowed|additional/i.test(e.message),
  );
});