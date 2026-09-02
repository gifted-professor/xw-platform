/**
 * PR1 Single-Device Recipe Runner — offline tests (no device I/O).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RECIPE_PRIMITIVE_KINDS,
  bindRecipeInput,
  evaluateRecipeAssertion,
  evaluateRecipeAssertions,
  validateRecipeInputParams,
  validateRecipeSteps,
  executeRecipeInSession,
} from "../control-plane/lib/recipe-interpreter.mjs";
import {
  createRecipePrimitiveHandlers,
  mapRecipeKindToPrimitiveParams,
} from "../control-plane/lib/recipe-primitive-handlers.mjs";
import {
  DEFAULT_RPA_ALIAS,
  FIXED_ALIAS,
  SingleDeviceRecipeRunner,
  prepareRecipeSteps,
  resolveFixedRpaAlias,
  resolveLiveRecipe,
} from "../control-plane/lib/single-device-recipe-runner.mjs";
import { XHS_SEARCH_FIXED_RECIPE } from "./fixtures/xhs-search-fixed.recipe.mjs";

test("whitelist includes wait", () => {
  assert.ok(RECIPE_PRIMITIVE_KINDS.includes("wait"));
});

test("validateRecipeSteps accepts wait", () => {
  const { ok, steps } = validateRecipeSteps([
    { id: "w", kind: "wait", params: { ms: 100 } },
  ]);
  assert.equal(ok, true);
  assert.equal(steps[0].params.ms, 100);
  assert.throws(
    () => validateRecipeSteps([{ id: "w", kind: "wait", params: { ms: 99999 } }]),
    /exceeds max/,
  );
});

test("bindRecipeInput replaces $input paths and preserves types", () => {
  assert.equal(bindRecipeInput("$input.keyword", { keyword: "攀岩" }), "攀岩");
  assert.equal(bindRecipeInput("$input.pages", { pages: 2 }), 2);
  assert.equal(bindRecipeInput("pre-$input.keyword-post", { keyword: "x" }), "pre-x-post");
  assert.equal(bindRecipeInput("$$input.keyword", { keyword: "x" }), "$input.keyword");
  assert.deepEqual(
    bindRecipeInput({ text: "$input.keyword", n: "$input.pages" }, { keyword: "a", pages: 1 }),
    { text: "a", n: 1 },
  );
  assert.throws(() => bindRecipeInput("$input.missing", {}), /missing input path/);
});

test("validateRecipeInputParams enforces schema", () => {
  const schema = XHS_SEARCH_FIXED_RECIPE.inputSchema;
  assert.deepEqual(validateRecipeInputParams(schema, { keyword: "ok" }), { keyword: "ok" });
  assert.throws(() => validateRecipeInputParams(schema, {}), /required/);
  assert.throws(() => validateRecipeInputParams(schema, { keyword: "ok", extra: 1 }), /not allowed/);
  assert.throws(() => validateRecipeInputParams(schema, { keyword: 1 }), /string/);
});

test("evaluateRecipeAssertion sparse set", () => {
  const obs = {
    package: "com.xingin.xhs",
    activity: "com.xingin.xhs.index.v2.IndexActivityV2",
    dumpXml: '<node resource-id="com.xingin.xhs:id/search" text="搜索"/>',
  };
  assert.equal(evaluateRecipeAssertion({ type: "packageEquals", value: "com.xingin.xhs" }, obs).ok, true);
  assert.equal(evaluateRecipeAssertion({ type: "activityContains", value: "IndexActivity" }, obs).ok, true);
  assert.equal(evaluateRecipeAssertion({ type: "textExists", value: "搜索" }, obs).ok, true);
  assert.equal(evaluateRecipeAssertion({ type: "resourceIdExists", value: "com.xingin.xhs:id/search" }, obs).ok, true);
  assert.equal(evaluateRecipeAssertion({ type: "packageEquals", value: "other" }, obs).ok, false);
  assert.equal(evaluateRecipeAssertion({ type: "unknownType", value: "x" }, obs).ok, false);
});

test("mapRecipeKindToPrimitiveParams covers PR1 kinds", () => {
  assert.equal(mapRecipeKindToPrimitiveParams("screenshot", {}).primitive, "screen");
  assert.equal(mapRecipeKindToPrimitiveParams("dump", {}).primitive, "dump_ui");
  assert.equal(mapRecipeKindToPrimitiveParams("launch", { appId: "com.xingin.xhs" }).package, "com.xingin.xhs");
  assert.deepEqual(mapRecipeKindToPrimitiveParams("tapSelector", { x: 10, y: 20 }), {
    primitive: "tap",
    x: 10,
    y: 20,
  });
  assert.throws(
    () => mapRecipeKindToPrimitiveParams("tapSelector", { selector: "搜索" }),
    (e) => e && e.code === "TAP_SELECTOR_UNRESOLVED",
  );
});

test("handlers call executePrimitive; wait uses sleepFn", async () => {
  const calls = [];
  const handlers = createRecipePrimitiveHandlers({
    executePrimitive: async ({ params }) => {
      calls.push(params.primitive);
      return { jobId: "j1", status: "succeeded", result: { output: { ok: true } } };
    },
    sleepFn: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
  });
  await handlers.back({ session: {}, call: { op: "back", args: {} }, step: { id: "b", kind: "back", params: {} } });
  await handlers.wait({ call: { op: "wait", args: { ms: 5 } }, step: { id: "w", kind: "wait", params: { ms: 5 } } });
  assert.deepEqual(calls, ["back", "sleep:5"]);
});

test("prepareRecipeSteps binds xhs.search.fixed keyword", () => {
  const prepared = prepareRecipeSteps(XHS_SEARCH_FIXED_RECIPE, { keyword: "深圳攀岩", pages: 1 });
  const inputStep = prepared.steps.find((s) => s.id === "input_keyword");
  assert.equal(inputStep.params.text, "深圳攀岩");
  assert.equal(inputStep.params.enter, true);
  assert.ok(prepared.steps.some((s) => s.kind === "wait"));
});

test("resolveFixedRpaAlias defaults to 04 and accepts override", () => {
  assert.equal(DEFAULT_RPA_ALIAS, "04");
  assert.equal(resolveFixedRpaAlias({}, null), "04");
  assert.equal(resolveFixedRpaAlias({ XHS_RPA_ALIAS: "04" }, null), "04");
  assert.equal(resolveFixedRpaAlias({}, "03"), "03");
  assert.throws(() => resolveFixedRpaAlias({ XHS_RPA_ALIAS: "99" }, null), /01\.\.07/);
});

test("resolveLiveRecipe gates status and alias", () => {
  const ok = resolveLiveRecipe(XHS_SEARCH_FIXED_RECIPE, {
    alias: FIXED_ALIAS,
    fixedAlias: FIXED_ALIAS,
  });
  assert.equal(ok.recipe.recipeId, "xhs.search.fixed");
  assert.throws(
    () => resolveLiveRecipe({ ...XHS_SEARCH_FIXED_RECIPE, status: "candidate" }, {
      alias: FIXED_ALIAS,
      fixedAlias: FIXED_ALIAS,
    }),
    (e) => e && e.code === "RECIPE_STATUS_NOT_LIVE",
  );
  assert.throws(
    () => resolveLiveRecipe(XHS_SEARCH_FIXED_RECIPE, { alias: "01", fixedAlias: FIXED_ALIAS }),
    (e) => e && e.code === "SINGLE_DEVICE_ALIAS_REQUIRED",
  );
});

test("runner plan-only dryRun succeeds without session", async () => {
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => {
      throw new Error("should not create session");
    },
    executeSessionAction: async () => {
      throw new Error("should not act");
    },
    releaseSession: async () => {},
  });
  const run = await runner.start({
    recipe: XHS_SEARCH_FIXED_RECIPE,
    params: { keyword: "test" },
    actorId: "agent:test",
    dryRun: true,
  });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.receipt.mode, "plan");
  assert.equal(run.receipt.serverVerified, true);
  assert.equal(run.alias, FIXED_ALIAS);
});

test("runner rejects concurrent live runs", async () => {
  let releaseResolve;
  const releaseGate = new Promise((r) => {
    releaseResolve = r;
  });
  let sessionCount = 0;
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => {
      sessionCount += 1;
      return {
        sessionId: `s${sessionCount}`,
        leaseId: `l${sessionCount}`,
        token: `t${sessionCount}`,
        deviceId: "dev01",
      };
    },
    executeSessionAction: async (_sid, _tok, { params }) => {
      if (params.primitive === "focus") {
        return {
          jobId: "jf",
          status: "succeeded",
          result: { output: { package: "com.xingin.xhs", activity: "com.xingin.xhs.search.SearchActivity" } },
        };
      }
      if (params.primitive === "dump_ui") {
        return {
          jobId: "jd",
          status: "succeeded",
          result: { output: { xml: '<hierarchy><node text="ok"/></hierarchy>' } },
        };
      }
      return { jobId: "ja", status: "succeeded", result: { output: { ok: true } } };
    },
    releaseSession: async () => {
      await releaseGate;
    },
    sleepFn: async () => {},
    observeForAssert: async () => ({
      package: "com.xingin.xhs",
      activity: "com.xingin.xhs.search.GlobalSearchActivity",
      dumpXml: '<node text="搜索"/>',
    }),
  });

  const first = runner.start({
    recipe: {
      ...XHS_SEARCH_FIXED_RECIPE,
      executor: {
        kind: "primitive_steps",
        steps: [
          { id: "launch_xhs", kind: "launch", params: { appId: "com.xingin.xhs" } },
          { id: "wait", kind: "wait", params: { ms: 1 } },
        ],
      },
    },
    params: { keyword: "a" },
    actorId: "agent:test",
    live: true,
  });

  // Give first run time to become active
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    () =>
      runner.start({
        recipe: XHS_SEARCH_FIXED_RECIPE,
        params: { keyword: "b" },
        actorId: "agent:test",
        live: true,
      }),
    (e) => e.code === "RECIPE_RUN_BUSY",
  );
  releaseResolve();
  const done = await first;
  assert.equal(done.status, "SUCCEEDED");
});

test("runner live path verifies assertions and releases session", async () => {
  const released = [];
  const primitives = [];
  const runner = new SingleDeviceRecipeRunner({
    createSession: async ({ placement, capabilityId, canary }) => {
      assert.equal(placement.alias, FIXED_ALIAS);
      assert.equal(capabilityId, "xiaowei.explorer.primitive");
      assert.equal(canary, true);
      return { sessionId: "s1", leaseId: "l1", token: "tok", deviceId: "d1" };
    },
    executeSessionAction: async (_sid, _tok, { params }) => {
      primitives.push(params.primitive);
      return { jobId: `j-${params.primitive}`, status: "succeeded", result: { output: { ok: true } } };
    },
    releaseSession: async (sid, tok) => {
      released.push({ sid, tok });
    },
    sleepFn: async () => {},
    observeForAssert: async () => ({
      package: "com.xingin.xhs",
      activity: "com.xingin.xhs.search.GlobalSearchActivity",
      dumpXml: '<node resource-id="com.xingin.xhs:id/search" text="搜索"/>',
    }),
  });

  const run = await runner.start({
    recipe: XHS_SEARCH_FIXED_RECIPE,
    params: { keyword: "深圳攀岩" },
    actorId: "agent:test",
    live: true,
  });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.receipt.ok, true);
  assert.ok(run.stepResults.length >= 1);
  assert.ok(primitives.includes("launch_app"));
  assert.ok(primitives.includes("tap"));
  assert.ok(primitives.includes("input_text"));
  assert.deepEqual(released, [{ sid: "s1", tok: "tok" }]);
  assert.equal(run.sessionToken, undefined);
});

test("runner stops on postAssertion failure as REPAIR_REQUIRED", async () => {
  const released = [];
  const runner = new SingleDeviceRecipeRunner({
    createSession: async () => ({ sessionId: "s1", leaseId: "l1", token: "tok", deviceId: "d1" }),
    executeSessionAction: async (_sid, _tok, { params }) => {
      if (params.primitive === "screen") {
        return { jobId: "js", status: "succeeded", result: { output: { ok: true } } };
      }
      return { jobId: "j", status: "succeeded", result: { output: { ok: true } } };
    },
    releaseSession: async () => {
      released.push(1);
    },
    sleepFn: async () => {},
    observeForAssert: async () => ({
      package: "com.android.settings",
      activity: "Settings",
      dumpXml: "<hierarchy/>",
    }),
  });

  const run = await runner.start({
    recipe: {
      ...XHS_SEARCH_FIXED_RECIPE,
      executor: {
        kind: "primitive_steps",
        steps: [
          {
            id: "launch_xhs",
            kind: "launch",
            params: { appId: "com.xingin.xhs" },
            postAssertions: [{ type: "packageEquals", value: "com.xingin.xhs" }],
          },
        ],
      },
    },
    params: { keyword: "x" },
    actorId: "agent:test",
    live: true,
  });
  assert.equal(run.status, "REPAIR_REQUIRED");
  assert.equal(run.error.code, "POST_ASSERTION_FAILED");
  assert.equal(released.length, 1);
  assert.equal(run.receipt.ok, false);
});

test("injected handlers clear LIVE_HANDLERS_NOT_WIRED path", async () => {
  const handlers = createRecipePrimitiveHandlers({
    executePrimitive: async () => ({ ok: true }),
    sleepFn: async () => {},
  });
  const out = await executeRecipeInSession({
    steps: [{ id: "a", kind: "back", params: {} }],
    live: true,
    session: { sessionId: "s", leaseId: "l", leased: true },
    handlers: {
      back: (...args) => handlers.back(...args),
    },
  });
  // executeRecipeInSession is sync and does not await async handlers — still mode live
  assert.equal(out.mode, "live");
  assert.equal(out.code, undefined);
});

test("evaluateRecipeAssertions all-or-nothing", () => {
  const r = evaluateRecipeAssertions(
    [{ type: "packageEquals", value: "a" }, { type: "textExists", value: "nope" }],
    { package: "a", dumpXml: "<x/>" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
});
