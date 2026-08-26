import test from "node:test";
import assert from "node:assert/strict";
import {
  STOP_THRESHOLD,
  ROUTES,
  incFailure,
  shouldStop,
  reduceReason,
  postconditionFailed,
} from "../ops/adaptive-state.mjs";

test("STOP_THRESHOLD is 2", () => {
  assert.equal(STOP_THRESHOLD, 2);
});

test("ROUTES contains the four fast-lane routes", () => {
  assert.deepEqual([...ROUTES].sort(), ["DUMP", "RECIPE", "STOP", "VISION"].sort());
});

test("incFailure increments and carries reasonCode", () => {
  const r = incFailure(0, "DUMP_FAILED");
  assert.equal(r.count, 1);
  assert.equal(r.reasonCode, "DUMP_FAILED");
  assert.equal(incFailure(1).count, 2);
});

test("incFailure treats non-numeric count as 0", () => {
  assert.equal(incFailure(NaN).count, 1);
  assert.equal(incFailure(undefined).count, 1);
});

test("shouldStop: redline stops regardless of count", () => {
  assert.ok(shouldStop({ count: 0, redline: true }));
});

test("shouldStop: count reaches threshold", () => {
  assert.ok(!shouldStop({ count: 0 }));
  assert.ok(!shouldStop({ count: 1 }));
  assert.ok(shouldStop({ count: 2 }));
  assert.ok(shouldStop({ count: 3 }));
});

test("reduceReason: redline dominates", () => {
  assert.equal(reduceReason({ recipeMatch: true, redline: true }), "REDLINE");
});

test("reduceReason: recipe match wins over dump", () => {
  assert.equal(reduceReason({ recipeMatch: true, dumpUnique: true }), "EXACT_RECIPE");
});

test("reduceReason: dump ordering unique > sparse > failed > ambiguous", () => {
  assert.equal(reduceReason({ dumpUnique: true, dumpSparse: true }), "UNIQUE_DUMP");
  assert.equal(reduceReason({ dumpSparse: true }), "DUMP_SPARSE");
  assert.equal(reduceReason({ dumpFailed: true }), "DUMP_FAILED");
  assert.equal(reduceReason({}), "AMBIGUOUS");
});

test("postconditionFailed increments count and is not a silent refresh", () => {
  const r = postconditionFailed(1);
  assert.equal(r.count, 2);
  assert.equal(r.reasonCode, "POSTCONDITION_FAILED");
  assert.ok(shouldStop({ count: r.count }));
});

test("full failure arc: two failures -> STOP, no route reset", () => {
  let count = 0;
  // 第一次：定位周期无唯一目标
  count = incFailure(count, "AMBIGUOUS").count;
  assert.equal(count, 1);
  assert.ok(!shouldStop({ count }));
  // 换 route 不重置：tap 失败
  count = incFailure(count, "SECOND_FAILURE").count;
  assert.equal(count, 2);
  assert.ok(shouldStop({ count }));
});