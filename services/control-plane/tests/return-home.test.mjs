import assert from "node:assert/strict";
import test from "node:test";

import {
  isLauncherPackage,
  shouldReturnHomeAfterJob,
  returnDeviceHome,
} from "../control-plane/lib/return-home.mjs";

test("isLauncherPackage recognizes common OEM launchers", () => {
  assert.equal(isLauncherPackage("com.miui.home"), true);
  assert.equal(isLauncherPackage("com.android.launcher3"), true);
  assert.equal(isLauncherPackage("com.ss.android.ugc.aweme"), false);
  assert.equal(isLauncherPackage(""), false);
  assert.equal(isLauncherPackage(null), false);
});

test("shouldReturnHomeAfterJob defaults on and respects opt-out / recovery", () => {
  assert.equal(shouldReturnHomeAfterJob({ env: {} }), true);
  assert.equal(shouldReturnHomeAfterJob({ env: {}, recoveryAttempt: true }), false);
  assert.equal(shouldReturnHomeAfterJob({ env: { XHS_SKIP_RETURN_HOME: "1" } }), false);
  assert.equal(shouldReturnHomeAfterJob({ env: { XHS_RETURN_HOME_AFTER_JOB: "0" } }), false);
  assert.equal(shouldReturnHomeAfterJob({
    env: {},
    capability: { id: "xiaowei.explorer.primitive", automationPolicy: { mode: "lab_only" } },
  }), false);
  assert.equal(shouldReturnHomeAfterJob({
    env: {},
    capability: { id: "xiaowei.lab.raw", automationPolicy: { mode: "lab_only" } },
  }), false);
});

test("returnDeviceHome presses home and checks launcher focus", async () => {
  const calls = [];
  class FakeOp {
    constructor(opts) {
      this.opts = opts;
      calls.push(["ctor", opts.serial]);
    }
    async start() {
      calls.push(["start"]);
      return this;
    }
    async home() {
      calls.push(["home"]);
    }
    async currentFocus() {
      calls.push(["focus"]);
      return { package: "com.miui.home", activity: "com.miui.home.launcher.Launcher", raw: "" };
    }
    async close() {
      calls.push(["close"]);
    }
  }

  const result = await returnDeviceHome({
    device: { runtimeId: "serial-01" },
    leaseAuthorization: { leaseId: "L", token: "T", deviceId: "D" },
    GatewayOperatorImpl: FakeOp,
    settleMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.packageName, "com.miui.home");
  assert.deepEqual(calls.map((c) => c[0]), ["ctor", "start", "home", "focus", "close"]);
});

test("returnDeviceHome soft-fails when GatewayOperator.start throws", async () => {
  class BoomOp {
    constructor() {}
    async start() {
      throw new Error("gateway probe failed");
    }
  }
  const result = await returnDeviceHome({
    device: { runtimeId: "serial-01" },
    leaseAuthorization: { leaseId: "L", token: "T", deviceId: "D" },
    GatewayOperatorImpl: BoomOp,
    settleMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "return_home_error");
  assert.match(String(result.error || ""), /gateway probe failed/);
});

test("returnDeviceHome soft-fails without lease/runtime", async () => {
  const a = await returnDeviceHome({ device: {}, leaseAuthorization: { leaseId: "L", token: "T", deviceId: "D" } });
  assert.equal(a.ok, false);
  assert.equal(a.skipped, true);
  const b = await returnDeviceHome({
    device: { runtimeId: "s" },
    leaseAuthorization: {},
  });
  assert.equal(b.ok, false);
  assert.equal(b.skipped, true);
});
