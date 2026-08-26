import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDescriptorHash,
  RECIPE_PRIMITIVE_KINDS,
} from "../control-plane/lib/recipe-interpreter.mjs";
import {
  SingleDeviceRecipeRunner,
  resolveLiveRecipe,
  CANARY_RECIPE_STATUSES,
  LIVE_RECIPE_STATUSES,
} from "../control-plane/lib/single-device-recipe-runner.mjs";
import { mapRecipeKindToPrimitiveParams } from "../control-plane/lib/recipe-primitive-handlers.mjs";

const BASE_RECIPE = (overrides = {}) => ({
  recipeId: "xhs.test.fixed",
  revision: 1,
  status: "canary_only",
  eligibleAliases: ["04"],
  deviceProfile: { alias: "04" },
  descriptorHash: undefined,
  inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
  executor: {
    kind: "primitive_steps",
    steps: [
      { id: "s1", kind: "launch", params: { appId: "com.xingin.xhs" } },
      { id: "s2", kind: "back", params: {} },
    ],
  },
  ...overrides,
});

test("computeDescriptorHash is deterministic and content-addressed", () => {
  const r = BASE_RECIPE();
  const h1 = computeDescriptorHash(r);
  const h2 = computeDescriptorHash(r);
  assert.equal(h1, h2);
  assert.ok(h1.startsWith("rh_"));
  assert.equal(h1.length, 3 + 24);
});

test("computeDescriptorHash changes when a step param mutates", () => {
  const r = BASE_RECIPE();
  const h1 = computeDescriptorHash(r);
  const mutated = BASE_RECIPE({
    executor: {
      kind: "primitive_steps",
      steps: [
        { id: "s1", kind: "launch", params: { appId: "com.xingin.xhs", forceStop: true } },
        { id: "s2", kind: "back", params: {} },
      ],
    },
  });
  assert.notEqual(computeDescriptorHash(mutated), h1);
});

test("computeDescriptorHash is key-order independent", () => {
  const r = BASE_RECIPE();
  const reordered = { ...r, executor: { kind: "primitive_steps", steps: r.executor.steps }, inputSchema: r.inputSchema, eligibleAliases: r.eligibleAliases };
  assert.equal(computeDescriptorHash(reordered), computeDescriptorHash(r));
});

test("CANARY_RECIPE_STATUSES includes candidate; LIVE does not", () => {
  assert.ok(CANARY_RECIPE_STATUSES.includes("candidate"));
  assert.ok(!LIVE_RECIPE_STATUSES.includes("candidate"));
  assert.ok(LIVE_RECIPE_STATUSES.includes("canary_only"));
  assert.ok(LIVE_RECIPE_STATUSES.includes("implemented"));
});

test("resolveLiveRecipe rejects candidate without canaryMode", () => {
  const r = BASE_RECIPE({ status: "candidate" });
  assert.throws(
    () => resolveLiveRecipe(r, { alias: "04", requireLiveStatus: true }),
    (e) => e.code === "RECIPE_STATUS_NOT_LIVE",
  );
});

test("resolveLiveRecipe accepts candidate with allowCandidate (canary mode)", () => {
  const r = BASE_RECIPE({ status: "candidate" });
  const out = resolveLiveRecipe(r, { alias: "04", requireLiveStatus: true, allowCandidate: true });
  assert.equal(out.fixedAlias, "04");
});

test("live start rejects inline recipe when server resolver is configured", async () => {
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
    resolveRecipe: () => null, // server resolver present → inline forbidden for live
  });
  await assert.rejects(
    runner.start({ recipe: BASE_RECIPE(), params: { keyword: "x" }, actorId: "a:test", live: true }),
    (e) => e.code === "INLINE_RECIPE_LIVE_FORBIDDEN",
  );
});

test("live start rejects descriptorHash tamper on server-sealed recipe", async () => {
  const real = BASE_RECIPE({ status: "canary_only" });
  const realHash = computeDescriptorHash(real);
  // server resolver returns a recipe whose sealed hash disagrees with its spec
  const tampered = { ...real, descriptorHash: "rh_deadbeefdeadbeefdeadbeef" };
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
    resolveRecipe: () => tampered,
  });
  await assert.rejects(
    runner.start({ recipeId: "xhs.test.fixed", revision: 1, params: { keyword: "x" }, actorId: "a:test", live: true }),
    (e) => e.code === "RECIPE_DESCRIPTOR_HASH_MISMATCH",
  );
  // sanity: the real hash is different from the tampered placeholder
  assert.notEqual(realHash, "rh_deadbeefdeadbeefdeadbeef");
});

test("live start accepts server-resolved recipe with matching descriptorHash", async () => {
  const real = BASE_RECIPE({ status: "canary_only" });
  const realHash = computeDescriptorHash(real);
  const serverRecipe = { ...real, descriptorHash: realHash };
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
    resolveRecipe: () => serverRecipe,
  });
  const run = await runner.start({ recipeId: "xhs.test.fixed", revision: 1, params: { keyword: "x" }, actorId: "a:test", live: true });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.descriptorHash, realHash);
  assert.equal(run.receipt.descriptorHash, realHash);
  assert.equal(run.receipt.serverVerified, true);
});

test("canaryMode allows server-resolved candidate recipe live run", async () => {
  const cand = BASE_RECIPE({ status: "candidate" });
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s", leaseId: "l", token: "t", deviceId: "d" }),
    executeSessionAction: async () => ({ jobId: "j", status: "succeeded", result: { output: {} } }),
    releaseSession: async () => {},
    resolveRecipe: () => cand,
  });
  const run = await runner.start({ recipeId: "xhs.test.fixed", revision: 1, params: { keyword: "x" }, actorId: "a:test", live: true, canaryMode: true });
  assert.equal(run.status, "SUCCEEDED");
});

test("input mapping: noRefocus omits refocus coords (XwIME tap-first sequence)", () => {
  const p = mapRecipeKindToPrimitiveParams("input", { text: "深圳攀岩", noRefocus: true, clearFirst: true, enter: true });
  assert.equal(p.primitive, "input_text");
  assert.equal(p.text, "深圳攀岩");
  assert.equal(p.clearFirst, true);
  assert.equal(p.enter, true);
  assert.equal(p.refocusX, undefined);
  assert.equal(p.refocusY, undefined);
});

test("input mapping: refocusX/refocusY passed when provided", () => {
  const p = mapRecipeKindToPrimitiveParams("input", { text: "x", refocusX: 540, refocusY: 200 });
  assert.equal(p.refocusX, 540);
  assert.equal(p.refocusY, 200);
});

test("input mapping: deferRestore passed through", () => {
  const p = mapRecipeKindToPrimitiveParams("input", { text: "x", deferRestore: true });
  assert.equal(p.deferRestore, true);
});

test("RECIPE_PRIMITIVE_KINDS includes wait", () => {
  assert.ok(RECIPE_PRIMITIVE_KINDS.includes("wait"));
});