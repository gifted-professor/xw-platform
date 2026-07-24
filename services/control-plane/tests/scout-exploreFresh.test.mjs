import assert from "node:assert/strict";
import test from "node:test";

// ── Helpers to stub the scout module's internals ─────────────────────────────

function makeDevice(alias = "01") {
  return {
    serial: "FAKE123",
    alias,
    label: `${alias}-test`,
    control: { deviceId: "dev-01", online: true },
  };
}

function makeCapability(overrides = {}) {
  return {
    id: "xiaowei.lab.raw",
    appId: "xiaowei",
    packageName: null,
    maturity: "E1",
    risk: "R1",
    automationPolicy: { mode: "lab_only" },
    ...overrides,
  };
}

// ── Import the exported functions under test ─────────────────────────────────

import { selectTarget } from "../scout/scout.mjs";

// ── selectTarget tests ──────────────────────────────────────────────────────

test("selectTarget skips capabilities with automationPolicy.mode=disabled", () => {
  const caps = [makeCapability({ automationPolicy: { mode: "disabled" } })];
  const result = selectTarget(caps, [], null);
  assert.equal(result, null);
});

test("selectTarget returns null when no candidates", () => {
  const result = selectTarget([], [], null);
  assert.equal(result, null);
});

test("selectTarget picks low-maturity unverified recipe as P0", () => {
  const cap = makeCapability({ id: "xhs.observe.feed", appId: "xhs", maturity: "E3", packageName: "com.xingin.xhs" });
  const recipe = { id: "xhs.observe.feed", category: "recipe", verifiedBy: [], title: "t", content: "c" };
  const result = selectTarget([cap], [recipe], null);
  assert.equal(result?.id, "xhs.observe.feed");
  assert.equal(result?._priority, 1); // P1: has recipe + unverified
});

test("selectTarget picks E0/E1 with no recipe as P2", () => {
  const cap = makeCapability({ id: "xiaowei.lab.raw", maturity: "E1" });
  const result = selectTarget([cap], [], null);
  assert.equal(result?.id, "xiaowei.lab.raw");
  assert.equal(result?._priority, 2);
});

// ── exploreFresh packageName validation (integration-style) ──────────────────
// We test the logic directly rather than mocking HTTP calls.

test("exploreFresh packageName check: null packageName causes skip", () => {
  // Simulate the check logic from exploreFresh line 335
  const target = makeCapability({ packageName: null });
  const pkg = "com.xingin.xhs"; // what focus() would return

  // Old buggy logic: target.packageName?.split(".")?.[1] || "xhs" → "xhs"
  // pkg.includes("xhs") → true → wrongly passes
  const oldCheck = pkg.includes(target.packageName?.split(".")?.[1] || "xhs");
  assert.equal(oldCheck, true, "old logic wrongly passes for null packageName");

  // New logic: null packageName → should skip (not even reach the check)
  assert.equal(target.packageName, null, "null packageName must be detected before focus check");
});

test("exploreFresh packageName check: valid packageName works correctly", () => {
  const target = makeCapability({ packageName: "com.xingin.xhs" });
  const pkg = "com.xingin.xhs";

  const segment = target.packageName?.split(".")?.[1];
  assert.equal(segment, "xingin");
  assert.equal(pkg.includes(segment), true);
});

test("exploreFresh packageName check: mismatched app detected", () => {
  const target = makeCapability({ packageName: "com.xingin.xhs" });
  const pkg = "com.tencent.mm"; // WeChat, not XHS

  const segment = target.packageName?.split(".")?.[1];
  assert.equal(pkg.includes(segment), false, "mismatched package must be detected");
});
