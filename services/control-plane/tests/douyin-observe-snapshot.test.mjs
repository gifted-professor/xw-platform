import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDouyinAdapter } from "../apps/douyin/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import {
  semanticSnapshot,
  parseAllUiNodes,
  findSearchEntry,
  findLikeBtn,
  likeStateFromDesc,
  extractTabs,
} from "../scripts/douyin-operator.mjs";

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

test("registry loads douyin snapshot/search/like dry-run", () => {
  for (const [id, action] of [
    ["douyin.observe.snapshot", "snapshot"],
    ["douyin.observe.search", "search"],
    ["douyin.like.dry_run", "like-dry-run"],
    ["douyin.collect.dry_run", "collect-dry-run"],
    ["douyin.follow.dry_run", "follow-dry-run"],
  ]) {
    const capability = registry.require(id);
    assert.equal(capability.appId, "douyin");
    assert.equal(capability.implementation.action, action);
    assert.equal(capability.availability, "implemented");
  }
});

test("Douyin adapter snapshot verify requires aweme focus and nodes", async () => {
  const calls = [];
  const adapter = createDouyinAdapter({
    run: async (exe, args, options) => {
      calls.push({ exe, args, env: options.env });
      return {
        ok: true,
        focus: { package: "com.ss.android.ugc.aweme", activity: "splash.SplashActivity" },
        nodes: [{ label: "推荐", bounds: [0, 0, 100, 100] }],
        nodeCount: 1,
      };
    },
  });
  const capability = registry.require("douyin.observe.snapshot");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: {},
    leaseAuthorization,
  });
  assert.equal(calls[0].args.includes("snapshot"), true);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
});

test("Douyin adapter search passes keyword and verifies tabs+backHome", async () => {
  const calls = [];
  const adapter = createDouyinAdapter({
    run: async (_exe, args) => {
      calls.push(args);
      return {
        ok: true,
        focus: { package: "com.ss.android.ugc.aweme", activity: "splash.SplashActivity" },
        tabs: ["综合", "视频"],
        backHome: true,
        stoppedBeforeOpen: true,
      };
    },
  });
  const capability = registry.require("douyin.observe.search");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: { keyword: "阿勒泰" },
    leaseAuthorization,
  });
  assert.equal(calls[0].includes("--keyword"), true);
  assert.equal(calls[0].includes("阿勒泰"), true);
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
});

test("Douyin adapter like-dry-run verify requires locate-not-tap", async () => {
  const adapter = createDouyinAdapter({
    run: async () => ({
      ok: true,
      locatedNotTapped: true,
      dryRun: true,
      likeXy: { x: 998, y: 1399 },
      likeState: "unliked",
      likeBefore: "未点赞，喜欢20.4万，按钮",
    }),
  });
  const capability = registry.require("douyin.like.dry_run");
  const execution = await adapter.execute({
    capability,
    device: privateDevice,
    params: {},
    leaseAuthorization,
  });
  assert.deepEqual(await adapter.verify({ capability, execution }), { ok: true, mode: "state" });
});

test("douyin helpers: search entry / tabs / like btn", () => {
  const doc = parseAllUiNodes(`<hierarchy>
    <node text="搜索" content-desc="" class="android.widget.TextView" bounds="[900,100][1080,190]" clickable="true" />
    <node text="综合" content-desc="" class="android.widget.TextView" bounds="[20,200][120,280]" clickable="true" />
    <node text="视频" content-desc="" class="android.widget.TextView" bounds="[140,200][240,280]" clickable="true" />
    <node text="" content-desc="未点赞，喜欢20.4万，按钮" class="android.widget.Button" bounds="[980,1300][1060,1500]" clickable="true" />
  </hierarchy>`);
  assert.equal(findSearchEntry(doc.nodes).matched, "搜索");
  assert.deepEqual(extractTabs(doc.nodes).map((t) => t.text), ["综合", "视频"]);
  const like = findLikeBtn(doc.nodes);
  assert.equal(likeStateFromDesc(like.desc), "unliked");
  assert.equal(semanticSnapshot(doc).length >= 3, true);
});
