import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeRecoveryVisualAnalysis } from "../control-plane/lib/recovery-inspection.mjs";
import { buildRecoveryAnalysis } from "../scripts/build-recovery-analysis.mjs";

test("builds a path-free hash-bound visual analysis envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-analysis-"));
  try {
    const imagePath = join(root, "screen.png");
    writeFileSync(imagePath, Buffer.from("png-bytes"));
    const envelope = buildRecoveryAnalysis({
      imagePath,
      elementsDocument: {
        resolution: [1080, 2400],
        timings: { hot_path_s: 1.2 },
        elements: [{ id: "home", label: "闲鱼", bounds: [0, 2140, 220, 2320], conf: 0.9, source: "ocr" }],
      },
    });
    assert.equal(envelope.schemaVersion, "xhs.visual-elements.v1");
    assert.match(envelope.image.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(envelope), /recovery-analysis-|screen\.png/);

    const normalized = normalizeRecoveryVisualAnalysis(envelope, {
      expectedImageSha256: envelope.image.sha256,
      focus: { package: "com.taobao.idlefish", activity: "MainActivity" },
    });
    assert.equal(normalized.image.sha256, envelope.image.sha256);
    assert.equal(normalized.elements[0].center[1], 2230);
    assert.equal(normalized.pageClassification.safeStateVerified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects elements outside the audited screenshot resolution", () => {
  assert.throws(() => normalizeRecoveryVisualAnalysis({
    schemaVersion: "xhs.visual-elements.v1",
    image: { sha256: "a".repeat(64), resolution: [1080, 2400] },
    analyzer: { name: "test", version: "1" },
    elements: [{ label: "bad", bounds: [0, 0, 2000, 3000] }],
  }, {
    expectedImageSha256: "a".repeat(64),
  }), { code: "RECOVERY_ANALYSIS_SCHEMA_INVALID" });
});

function normalizeFixture(elements, focus) {
  const sha256 = "b".repeat(64);
  return normalizeRecoveryVisualAnalysis({
    schemaVersion: "xhs.visual-elements.v1",
    image: { sha256, resolution: [1080, 2400] },
    analyzer: { name: "test", version: "1" },
    elements: elements.map(([label, bounds]) => ({ label, bounds, source: "human-visual" })),
  }, { expectedImageSha256: sha256, focus });
}

test("accepts exact MIUI launcher focus only with a strong visual fingerprint", () => {
  const normalized = normalizeFixture([
    ["设置", [70, 760, 235, 920]],
    ["高德地图", [310, 760, 480, 920]],
    ["计算器", [580, 760, 750, 920]],
    ["微信输入法", [840, 760, 1030, 920]],
    ["相册", [580, 1010, 750, 1170]],
    ["日历", [840, 1010, 1030, 1170]],
    ["应用商店", [580, 1420, 750, 1580]],
  ], {
    package: "com.miui.home",
    activity: "com.miui.home.launcher.Launcher",
  });
  assert.equal(normalized.pageClassification.pageType, "main-safe");
  assert.equal(normalized.pageClassification.safeStateVerified, true);
  assert.equal(normalized.pageClassification.confidence, 0.99);
});

test("rejects launcher focus without visual anchors or with a blocking overlay", () => {
  const focus = {
    package: "com.miui.home",
    activity: "com.miui.home.launcher.Launcher",
  };
  const empty = normalizeFixture([], focus);
  assert.equal(empty.pageClassification.pageType, "unknown");
  assert.equal(empty.pageClassification.safeStateVerified, false);

  const blocked = normalizeFixture([
    ["设置", [70, 760, 235, 920]],
    ["高德地图", [310, 760, 480, 920]],
    ["计算器", [580, 760, 750, 920]],
    ["微信输入法", [840, 760, 1030, 920]],
    ["相册", [580, 1010, 750, 1170]],
    ["日历", [840, 1010, 1030, 1170]],
    ["应用商店", [580, 1420, 750, 1580]],
    ["允许访问设备", [180, 900, 900, 1100]],
  ], focus);
  assert.equal(blocked.pageClassification.pageType, "unknown");
  assert.equal(blocked.pageClassification.safeStateVerified, false);

  const consentOverlay = normalizeFixture([
    ["首页", [20, 2160, 190, 2360]],
    ["朋友", [220, 2160, 390, 2360]],
    ["消息", [680, 2160, 850, 2360]],
    ["我", [880, 2160, 1060, 2360]],
    ["同意并继续", [250, 1450, 830, 1620]],
  ], focus);
  assert.equal(consentOverlay.pageClassification.pageType, "unknown");
  assert.equal(consentOverlay.pageClassification.safeStateVerified, false);
});

test("does not trust launcher-looking labels under another foreground package", () => {
  const normalized = normalizeFixture([
    ["设置", [70, 760, 235, 920]],
    ["高德地图", [310, 760, 480, 920]],
    ["计算器", [580, 760, 750, 920]],
    ["微信输入法", [840, 760, 1030, 920]],
    ["相册", [580, 1010, 750, 1170]],
    ["日历", [840, 1010, 1030, 1170]],
    ["应用商店", [580, 1420, 750, 1580]],
  ], {
    package: "com.example.fake",
    activity: "com.miui.home.launcher.Launcher",
  });
  assert.equal(normalized.pageClassification.pageType, "unknown");
  assert.equal(normalized.pageClassification.safeStateVerified, false);
});

test("rejects MIUI labels without a launcher grid layout", () => {
  const normalized = normalizeFixture([
    ["设置", [20, 760, 150, 900]],
    ["高德地图", [170, 760, 300, 900]],
    ["计算器", [320, 760, 450, 900]],
    ["微信输入法", [470, 760, 600, 900]],
    ["相册", [620, 760, 750, 900]],
    ["日历", [770, 760, 900, 900]],
    ["应用商店", [920, 760, 1060, 900]],
  ], {
    package: "com.miui.home",
    activity: "com.miui.home.launcher.Launcher",
  });
  assert.equal(normalized.pageClassification.pageType, "unknown");
  assert.equal(normalized.pageClassification.safeStateVerified, false);
});

test("accepts Douyin main only with exact focus and complete bottom navigation", () => {
  const normalized = normalizeFixture([
    ["首页", [20, 2160, 190, 2360]],
    ["朋友", [220, 2160, 390, 2360]],
    ["消息", [680, 2160, 850, 2360]],
    ["我", [880, 2160, 1060, 2360]],
  ], {
    package: "com.ss.android.ugc.aweme",
    activity: "com.ss.android.ugc.aweme.splash.SplashActivity",
  });
  assert.equal(normalized.pageClassification.pageType, "main-safe");
  assert.equal(normalized.pageClassification.safeStateVerified, true);
  assert.equal(normalized.pageClassification.confidence, 0.98);
});

test("rejects incomplete or blocked Douyin main fingerprints", () => {
  const focus = {
    package: "com.ss.android.ugc.aweme",
    activity: "com.ss.android.ugc.aweme.splash.SplashActivity",
  };
  const incomplete = normalizeFixture([
    ["首页", [20, 2160, 190, 2360]],
    ["我", [880, 2160, 1060, 2360]],
  ], focus);
  assert.equal(incomplete.pageClassification.pageType, "unknown");

  const blocked = normalizeFixture([
    ["首页", [20, 2160, 190, 2360]],
    ["朋友", [220, 2160, 390, 2360]],
    ["消息", [680, 2160, 850, 2360]],
    ["我", [880, 2160, 1060, 2360]],
    ["开启青少年模式", [180, 700, 900, 1000]],
  ], focus);
  assert.equal(blocked.pageClassification.pageType, "unknown");
  assert.equal(blocked.pageClassification.safeStateVerified, false);
});
