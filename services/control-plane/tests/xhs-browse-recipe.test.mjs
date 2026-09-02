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
import { computeDescriptorHash } from "../control-plane/lib/recipe-interpreter.mjs";
import { SingleDeviceRecipeRunner } from "../control-plane/lib/single-device-recipe-runner.mjs";
import {
  validateRecipeExecutor,
  RECIPE_PRIMITIVE_KINDS,
} from "../../orchestrator/scripts/lib/recipe-catalog.mjs";
import { planAction } from "../../orchestrator/scripts/lib/xw-xhs-dispatcher.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPEC_PATH = join(HERE, "..", "config", "recipes", "xhs.browse.fixed@1.json");
const BROWSE = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const HASH = BROWSE.descriptorHash;

function makeRunner() {
  return new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
  });
}

test("browse@1: spec is canonical-v2 with a 64-hex descriptorHash", () => {
  assert.equal(isCanonicalV2(BROWSE), true);
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.notEqual(HASH, "0".repeat(64));
});

test("browse@1: all 13 step kinds are in the primitive whitelist (R0 read-only)", () => {
  const kinds = BROWSE.executor.steps.map((s) => s.kind);
  for (const k of kinds) {
    assert.ok(RECIPE_PRIMITIVE_KINDS.includes(k), `step kind ${k} must be whitelisted`);
  }
  // R0 read-only: no tap/input/callCapability (no interaction, no effect)
  const interactive = kinds.filter((k) => ["tapSelector", "input", "callCapability"].includes(k));
  assert.deepEqual(interactive, [], "browse is R0 read-only — no tap/input/callCapability steps");
  assert.equal(BROWSE.riskCeiling, "R0");
  assert.deepEqual(BROWSE.eligibleAliases, ["04"]);
});

test("browse@1: validateRecipeExecutor accepts the step list", () => {
  const r = validateRecipeExecutor(BROWSE.executor);
  assert.equal(r.kind, "primitive_steps");
  assert.equal(r.steps.length, 13);
});

test("browse@1: five consumers produce the same canonical hash", () => {
  assert.equal(canonicalDescriptorHash(BROWSE), HASH);
  assert.equal(descriptorHashOf(BROWSE), HASH);
  assert.equal(computeDescriptorHash(BROWSE), HASH);
});

test("browse@1: Runner seals a plan-mode run with the canonical hash (no device I/O)", async () => {
  const runner = makeRunner();
  const run = await runner.start({ recipe: structuredClone(BROWSE), params: {}, actorId: "a:w3", live: false });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.descriptorHash, HASH);
  assert.equal(run.receipt.mode, "plan");
});

test("browse@1: mutation of a swipe coordinate changes the canonical hash", () => {
  const mutated = structuredClone(BROWSE);
  mutated.executor.steps.find((s) => s.id === "swipe_1").params.from.x = 999;
  assert.notEqual(canonicalDescriptorHash(mutated), HASH);
});

test("browse@1: dispatcher plans browse -> xhs.browse.fixed@1 (R0, route RECIPE)", () => {
  // S0 truth fix: the plan takes no params — recipe@1 performs exactly 5 sealed
  // static swipes; the old minutes/swipes inputs never bound to a step.
  const plan = planAction({ actionId: "browse", params: {} });
  assert.equal(plan.recipeId, "xhs.browse.fixed");
  assert.equal(plan.recipeRevision, 1);
  assert.equal(plan.effectClass, "none");
  assert.equal(plan.adaptiveRoute, "RECIPE");
  assert.equal(plan.gate, "W3");
  assert.equal(plan.alias, "04");
  assert.throws(
    () => planAction({ actionId: "browse", params: { minutes: 10, swipes: 3 } }),
    (e) => e.code === "PARAMS_UNKNOWN",
    "unbound minutes/swipes inputs must be rejected at plan stage",
  );
});