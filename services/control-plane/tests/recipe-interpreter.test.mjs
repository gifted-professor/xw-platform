/**
 * Phase 5 Recipe Interpreter — plan-only / validate tests.
 * Never touches a device (no live session, no handlers that hit hardware).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  RECIPE_PRIMITIVE_KINDS,
  validateRecipeSteps,
  resolveRecipeExecutor,
  executeRecipeInSession,
  planRecipeFromExecutor,
} from "../control-plane/lib/recipe-interpreter.mjs";

const ALL_KINDS = [
  "callCapability",
  "dump",
  "focus",
  "screenshot",
  "tapSelector",
  "swipe",
  "input",
  "back",
  "launch",
];

test("whitelist matches Phase 5 plan primitives", () => {
  assert.deepEqual([...RECIPE_PRIMITIVE_KINDS], ALL_KINDS);
});

test("validateRecipeSteps accepts a full whitelist recipe", () => {
  const { ok, steps } = validateRecipeSteps([
    {
      id: "open",
      kind: "launch",
      params: { appId: "com.ss.android.ugc.aweme" },
      timeoutMs: 15_000,
    },
    {
      id: "shot",
      kind: "screenshot",
      params: { label: "home" },
      preAssertions: ["home"],
      postAssertions: [{ type: "label", value: "home" }],
      restore: false,
    },
    {
      id: "tap_search",
      kind: "tapSelector",
      params: { selector: { text: "搜索" } },
    },
    {
      id: "type_q",
      kind: "input",
      params: { text: "hello", clear: true },
    },
    {
      id: "scroll",
      kind: "swipe",
      params: { direction: "up" },
    },
    {
      id: "focus_box",
      kind: "focus",
      params: { resourceId: "com.example:id/edit" },
    },
    { id: "dump_ui", kind: "dump", params: { format: "xml" } },
    { id: "go_back", kind: "back", params: {} },
    {
      id: "wrap_cap",
      kind: "callCapability",
      params: { capabilityId: "douyin.observe.snapshot", params: { q: "x" } },
    },
  ]);
  assert.equal(ok, true);
  assert.equal(steps.length, 9);
  assert.equal(steps[0].kind, "launch");
  assert.equal(steps[2].params.selector.text, "搜索");
  assert.equal(steps[8].params.capabilityId, "douyin.observe.snapshot");
});

test("validateRecipeSteps rejects unknown kind", () => {
  assert.throws(
    () => validateRecipeSteps([{ id: "bad", kind: "adbShell", params: {} }]),
    /not in whitelist/,
  );
});

test("validateRecipeSteps rejects unknown top-level field", () => {
  assert.throws(
    () =>
      validateRecipeSteps([
        { id: "a", kind: "back", params: {}, sneaky: true },
      ]),
    /unknown field/,
  );
});

test("validateRecipeSteps rejects empty / non-array", () => {
  assert.throws(() => validateRecipeSteps([]), /non-empty/);
  assert.throws(() => validateRecipeSteps(null), /must be an array/);
});

test("tapSelector prefers semantic selector; coord fallback needs deviceBound", () => {
  const ok = validateRecipeSteps([
    { id: "t1", kind: "tapSelector", params: { selector: "搜索" } },
  ]);
  assert.equal(ok.ok, true);

  assert.throws(
    () =>
      validateRecipeSteps([
        { id: "t2", kind: "tapSelector", params: { x: 10, y: 20 } },
      ]),
    /deviceBound/,
  );

  const withBound = validateRecipeSteps([
    {
      id: "t3",
      kind: "tapSelector",
      params: { x: 10, y: 20, deviceBound: { alias: "01", appVersion: "1.0" } },
    },
  ]);
  assert.equal(withBound.steps[0].params.x, 10);
  assert.equal(withBound.steps[0].params.deviceBound.alias, "01");
});

test("callCapability / launch / input typed params", () => {
  assert.throws(
    () => validateRecipeSteps([{ id: "c", kind: "callCapability", params: {} }]),
    /capabilityId/,
  );
  assert.throws(
    () => validateRecipeSteps([{ id: "l", kind: "launch", params: {} }]),
    /appId/,
  );
  assert.throws(
    () => validateRecipeSteps([{ id: "i", kind: "input", params: { text: 1 } }]),
    /text/,
  );
});

test("resolveRecipeExecutor: Phase 1 capability wrapper default", () => {
  const a = resolveRecipeExecutor({
    capabilityId: "douyin.observe.snapshot",
    paramsTemplate: { q: "{{q}}" },
  });
  assert.equal(a.kind, "capability_wrapper");
  assert.equal(a.capabilityId, "douyin.observe.snapshot");
  assert.deepEqual(a.paramsTemplate, { q: "{{q}}" });

  const b = resolveRecipeExecutor({
    kind: "capability_wrapper",
    capabilityId: "xhs.collect.standing_grant",
  });
  assert.equal(b.kind, "capability_wrapper");
});

test("resolveRecipeExecutor: primitive_steps uses interpreter validate", () => {
  const r = resolveRecipeExecutor({
    kind: "primitive_steps",
    steps: [
      { id: "s1", kind: "screenshot", params: { label: "a" } },
      { id: "s2", kind: "back", params: {} },
    ],
  });
  assert.equal(r.kind, "primitive_steps");
  assert.equal(r.steps.length, 2);

  assert.throws(
    () =>
      resolveRecipeExecutor({
        kind: "primitive_steps",
        steps: [{ id: "x", kind: "rm -rf", params: {} }],
      }),
    /not in whitelist/,
  );
});

test("executeRecipeInSession is plan-only by default (no device)", () => {
  const steps = [
    { id: "a", kind: "dump", params: {} },
    { id: "b", kind: "screenshot", params: { label: "x" } },
  ];
  const plan = executeRecipeInSession({ steps });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "plan");
  assert.equal(plan.live, false);
  assert.equal(plan.plannedCalls.length, 2);
  assert.equal(plan.plannedCalls[0].call.op, "dump");
  assert.match(plan.message, /plan-only/i);
  assert.match(plan.message, /leased/i);
});

test("executeRecipeInSession live:true without leased session refuses I/O", () => {
  const steps = [{ id: "a", kind: "back", params: {} }];
  const rejected = executeRecipeInSession({
    steps,
    live: true,
    session: { sessionId: "sess_1" }, // no lease evidence
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.mode, "rejected");
  assert.equal(rejected.code, "LEASED_SESSION_REQUIRED");
  assert.equal(rejected.live, false);
});

test("executeRecipeInSession live+lease without handlers stays scaffolding stub", () => {
  const steps = [{ id: "a", kind: "back", params: {} }];
  const stub = executeRecipeInSession({
    steps,
    live: true,
    session: { sessionId: "sess_1", leaseId: "lease_1", leased: true },
  });
  assert.equal(stub.ok, true);
  assert.equal(stub.mode, "live_stub");
  assert.equal(stub.code, "LIVE_HANDLERS_NOT_WIRED");
  assert.equal(stub.live, false);
  assert.equal(stub.session.leaseId, "lease_1");
});

test("executeRecipeInSession with injected handlers (still no real device)", () => {
  const calls = [];
  const steps = [
    { id: "a", kind: "back", params: {} },
    { id: "b", kind: "dump", params: { format: "json" } },
  ];
  const out = executeRecipeInSession({
    steps,
    live: true,
    session: { leaseId: "L1", leased: true },
    handlers: {
      back: ({ call }) => {
        calls.push(call.op);
        return { ok: true };
      },
      dump: ({ call }) => {
        calls.push(call.op);
        return { ok: true, format: call.args.format };
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "live");
  assert.equal(out.live, true);
  assert.deepEqual(calls, ["back", "dump"]);
});

test("planRecipeFromExecutor wires capability wrapper vs primitive_steps", () => {
  const wrap = planRecipeFromExecutor({
    capabilityId: "douyin.observe.snapshot",
    paramsTemplate: {},
  });
  assert.equal(wrap.executorKind, "capability_wrapper");
  assert.equal(wrap.mode, "plan");
  assert.equal(wrap.plannedCalls[0].kind, "callCapability");

  const prim = planRecipeFromExecutor({
    kind: "primitive_steps",
    steps: [{ id: "s", kind: "screenshot", params: {} }],
  });
  assert.equal(prim.executorKind, "primitive_steps");
  assert.equal(prim.mode, "plan");
  assert.equal(prim.plannedCalls[0].kind, "screenshot");
});

test("evidenceCollector.note is invoked in plan mode", () => {
  const notes = [];
  executeRecipeInSession({
    steps: [{ id: "a", kind: "back", params: {} }],
    evidenceCollector: { note: (n) => notes.push(n) },
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].event, "recipe_plan");
  assert.equal(notes[0].live, false);
});
