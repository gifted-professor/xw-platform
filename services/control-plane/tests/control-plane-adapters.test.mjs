import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWechatAdapter } from "../apps/wechat/adapter.mjs";
import { createXhsAdapter } from "../apps/xhs/adapter.mjs";
import { createXianyuAdapter } from "../apps/xianyu/adapter.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const privateDevice = {
  deviceId: "dev-test",
  alias: "01",
  nodeId: "DESKTOP-3I1EVHE",
  runtimeId: "private-runtime-id",
  metadata: { xhsServePort: 17895, adbPath: "adb.exe" },
};

test("XHS adapter uses a per-device loopback serve and fail-closed verifier", async () => {
  const calls = [];
  const adapter = createXhsAdapter({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        ok: true,
        result: { cards: [] },
        metrics: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const capability = registry.require("xhs.observe.feed");
  const execution = await adapter.execute({ capability, device: privateDevice, params: {} });
  assert.equal(new URL(calls[0].url).hostname, "127.0.0.1");
  assert.equal(new URL(calls[0].url).port, "17895");
  assert.equal(calls[0].body.action, "feedCards");
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });

  const send = registry.require("xhs.comment.send");
  assert.deepEqual(await adapter.verify({
    capability: send,
    execution: { output: { ok: true } },
  }), { ok: false, ambiguous: true, mode: "custom" });
});

test("XHS adapter surfaces inner serve rejection instead of masking it as verification failure", async () => {
  const adapter = createXhsAdapter({
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      result: { ok: false, step: "notOnNote", activity: "IndexActivityV2", log: [["focus", {}]] },
      metrics: {},
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const send = registry.require("xhs.comment.send");
  await assert.rejects(
    adapter.execute({ capability: send, device: privateDevice, params: { text: "probe" } }),
    (error) => {
      assert.equal(error.code, "ADAPTER_ACTION_REJECTED");
      assert.equal(error.details.step, "notOnNote");
      return true;
    },
  );
});

test("Xianyu adapter preserves stop-before-publish and discard verification", async () => {
  const calls = [];
  const fakeOperator = fileURLToPath(new URL("../package.json", import.meta.url));
  const adapter = createXianyuAdapter({
    operatorPath: fakeOperator,
    run: async (_command, args) => {
      calls.push(args);
      if (args.includes("discard-dry-run")) return { ok: true, savedDraft: false };
      if (args.includes("input-dry-run")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          audit: {
            inputAccepted: true,
            textVerified: true,
            clearedVerified: true,
            imeRestored: false,
            imeKeptOnXw: true,
          },
        };
      }
      if (args.includes("image-dry-run")) {
        return {
          ok: true,
          stoppedBeforePublish: true,
          step: "images-uploaded",
          upload: { ok: true, step: "images-uploaded", picked: 2, imgCount: 2 },
        };
      }
      return { ok: true };
    },
  });
  const capability = registry.require("xianyu.publish.input_dry_run");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { text: "probe" },
  });
  assert.equal((await adapter.verify({ capability, execution })).ok, true);
  assert.equal((await adapter.restore({ capability, device: privateDevice })).ok, true);
  assert.equal(calls.some((args) => args.includes("discard-dry-run")), true);

  const imageCap = registry.require("xianyu.publish.image_dry_run");
  const imageExec = await adapter.execute({
    capability: imageCap,
    device: privateDevice,
    params: {
      images: [{ phonePath: "/sdcard/Pictures/XianyuStaging/a.png", sha256: "a".repeat(64) }],
      imageAlbum: "XianyuStaging",
    },
  });
  assert.equal((await adapter.verify({ capability: imageCap, execution: imageExec })).ok, true);
  assert.equal(calls.some((args) => args.includes("image-dry-run")), true);
});

test("WeChat adapter requires title match and baseline restoration", async () => {
  const fakeOperator = fileURLToPath(new URL("../package.json", import.meta.url));
  const adapter = createWechatAdapter({
    operatorPath: fakeOperator,
    run: async () => ({
      ok: true,
      titleMatched: true,
      evidence: { baselineHeld: true },
    }),
  });
  const capability = registry.require("wechat.navigate.conversation");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { title: "local-test-contact" },
    evidenceDirectory: fileURLToPath(new URL("../control-plane/runtime", import.meta.url)),
  });
  assert.equal((await adapter.verify({ capability, execution })).ok, true);
});

test("Xiaowei raw adapter is canary-only and allowlisted", async () => {
  const calls = [];
  const adapter = createXiaoweiAdapter({
    transport: {
      async invoke(input) {
        calls.push(input);
        return { code: 10000, data: [] };
      },
    },
  });
  const capability = registry.require("xiaowei.lab.raw");
  await assert.rejects(
    adapter.execute({
      capability,
      device: privateDevice,
      params: { action: "list", data: {} },
      job: { canary: false },
    }),
    { code: "CANARY_REQUIRED" },
  );
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { action: "list", data: {} },
    job: { canary: true },
  });
  assert.equal(execution.vendorCode, 10000);
  assert.equal(calls[0].devices, "private-runtime-id");
});
