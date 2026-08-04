import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { classifyWechatScreen } from "../scripts/wechat-operator.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const privateDevice = {
  deviceId: "dev-test",
  alias: "01",
  nodeId: "DESKTOP-3I1EVHE",
  runtimeId: "private-runtime-id",
};
const leaseAuthorization = {
  leaseId: "lease-test",
  token: "lease-token-secret",
  deviceId: privateDevice.deviceId,
  controlUrl: "http://127.0.0.1:17920",
};

test("registry loads wechat observe main/probe as implemented", () => {
  const main = registry.require("wechat.observe.main");
  const probe = registry.require("wechat.observe.probe");
  assert.equal(main.availability, "implemented");
  assert.equal(probe.availability, "implemented");
  assert.equal(registry.require("wechat.navigate.conversation").availability, "dependency_pending_wechat_ocr");
});

test("classifyWechatScreen maps LauncherUI to main.messages", () => {
  assert.equal(classifyWechatScreen({
    package: "com.tencent.mm",
    activity: "com.tencent.mm.ui.LauncherUI",
  }).screenId, "wechat.main.messages");
  assert.equal(classifyWechatScreen({
    package: "com.tencent.mm",
    activity: "com.tencent.mm.plugin.fts.ui.FTSMainUI",
  }).screenId, "wechat.search");
});

test("WeChat adapter inspect verify requires main.messages", async () => {
  const calls = [];
  const adapter = createWechatAdapter({
    run: async (_exe, args, options) => {
      calls.push({ args, env: options.env });
      return {
        ok: true,
        screenId: "wechat.main.messages",
        focus: { package: "com.tencent.mm", activity: "com.tencent.mm.ui.LauncherUI" },
        evidence: { path: "C:/tmp/a.png", sha256: "abc" },
      };
    },
  });
  const capability = registry.require("wechat.observe.main");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: {},
    evidenceDirectory: "C:/tmp/evidence",
    leaseAuthorization,
  });
  assert.equal(calls[0].args.includes("inspect"), true);
  assert.equal(calls[0].env.XHS_OPERATOR_LEASE_ID, leaseAuthorization.leaseId);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
});

test("WeChat adapter probe verify returns hash", async () => {
  const adapter = createWechatAdapter({
    run: async () => ({
      ok: true,
      screenId: "wechat.main.messages",
      focus: { package: "com.tencent.mm", activity: "com.tencent.mm.ui.LauncherUI" },
      evidence: { path: "C:/tmp/a.png", sha256: "deadbeef" },
    }),
  });
  const capability = registry.require("wechat.observe.probe");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { label: "smoke" },
    evidenceDirectory: "C:/tmp/evidence",
    leaseAuthorization,
  });
  const verified = await adapter.verify({ capability, execution });
  assert.equal(verified.ok, true);
  assert.equal(verified.hash, "deadbeef");
});
