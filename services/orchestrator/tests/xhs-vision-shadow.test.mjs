// xhs-vision-shadow.test.mjs — S4 vision shadow + R0 one-shot navigation
// permit (direct-routine plan V2 §5/§10.9), offline.
//
// Acceptance §10.9: vision tests use independently labeled real PNGs; fixture
// provider, low confidence, multi-block, effect controls, and expired/replayed
// permits are all tap=0. Shadow mode NEVER authorizes a tap.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VISION_PROVIDERS,
  isEffectControlLabel,
  screenshotEvidence,
  visionShadowCompare,
  r0NavigationTap,
} from "../scripts/lib/xhs-vision-shadow.mjs";
import { sha256File, readPngDims } from "../ops/xw-adaptive-visual-tap.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REAL_PNG_A = join(ROOT, "services/control-plane/tests/fixtures/m6-xiaowei/screen-a.png");
const REAL_PNG_B = join(ROOT, "services/control-plane/tests/fixtures/m6-xiaowei/screen-b.png");
const DIMS = { width: 1080, height: 2400 };
const CAPTURED_AT = 1_700_000_000_000;
const okBlock = (over = {}) => ({
  label: "搜索",
  region: "home",
  bounds: { x: 100, y: 200, w: 200, h: 80 },
  confidence: 0.9,
  capturedAt: CAPTURED_AT,
  ...over,
});

test("screenshotEvidence: real PNG keeps provider/model/frameHash/dims together", () => {
  const ev = screenshotEvidence({
    pngPath: REAL_PNG_A,
    provider: VISION_PROVIDERS.REAL,
    modelId: "glm-v",
    capturedAt: CAPTURED_AT,
    live: false,
  });
  assert.ok(ev.frameHash.startsWith("0") || /^[0-9a-f]{64}$/.test(ev.frameHash));
  assert.deepEqual(ev.dims, { width: 1080, height: 2400 });
  assert.equal(ev.provider, "real");
  assert.equal(ev.modelId, "glm-v");
  // frame hash is content-addressed: same bytes -> same hash
  const ev2 = screenshotEvidence({ pngPath: REAL_PNG_A, provider: "real", capturedAt: 0 });
  assert.equal(ev.frameHash, ev2.frameHash);
  // the two fixture frames are byte-identical copies of one real capture:
  // same content -> same frame hash (content addressing, not file identity)
  const evB = screenshotEvidence({ pngPath: REAL_PNG_B, provider: "real", capturedAt: 0 });
  assert.equal(ev.frameHash, evB.frameHash);
});

test("fixture screenshot provider fails closed in live runtime (§10.9)", () => {
  assert.throws(
    () => screenshotEvidence({ pngPath: REAL_PNG_A, provider: VISION_PROVIDERS.FIXTURE, live: true }),
    (e) => e.reasonCode === "VISION_PROVIDER_REJECTED",
  );
  // offline the fixture provider is fine for plumbing tests
  const ev = screenshotEvidence({ pngPath: REAL_PNG_A, provider: VISION_PROVIDERS.FIXTURE, live: false });
  assert.equal(ev.provider, "fixture");
});

test("shadow comparison records agreement but never authorizes a tap", () => {
  const dump = { page: "HOME_FEED", cards: [{ cardKind: "video" }, { cardKind: "note" }] };
  const vision = { page: "HOME_FEED", blocks: [okBlock({ label: "视频 深圳攀岩" }), okBlock({ label: "笔记 攀岩入门" })] };
  const r = visionShadowCompare({ dump, vision });
  assert.equal(r.pageAgree, true);
  assert.equal(r.mediaAgree, true);
  assert.equal(r.tapAuthorized, false, "shadow is tap=0 even on full agreement");
  // disagreement is recorded, still tap=0
  const r2 = visionShadowCompare({ dump, vision: { page: "OTHER", blocks: [okBlock({ label: "笔记 x" })] } });
  assert.equal(r2.pageAgree, false);
  assert.equal(r2.mediaAgree, false);
  assert.equal(r2.mismatches.length, 2);
  assert.equal(r2.tapAuthorized, false);
});

test("r0NavigationTap: unique navigation block taps once with deterministic center", () => {
  const tmp = mkdtempSync(join(tmpdir(), "r0-"));
  const ledger = join(tmp, "ledger.jsonl");
  try {
    const blocks = [okBlock({ label: "搜索" })];
    const res = r0NavigationTap({
      blocks, target: "搜索", dims: DIMS, frameHash: "f".repeat(64), ledgerPath: ledger, clock: { nowMs: () => CAPTURED_AT },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.center, { x: 200, y: 240 });
    assert.ok(res.actionRef.startsWith("act_"));
    void sha256File; void readPngDims; // exercised elsewhere
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("r0NavigationTap: multi-block match is tap=0 (VISION_AMBIGUOUS)", () => {
  const blocks = [okBlock({ bounds: { x: 100, y: 200, w: 200, h: 80 } }), okBlock({ bounds: { x: 700, y: 200, w: 200, h: 80 } })];
  assert.throws(
    () => r0NavigationTap({ blocks, target: "搜索", dims: DIMS, frameHash: "f".repeat(64), clock: { nowMs: () => CAPTURED_AT } }),
    (e) => e.reasonCode === "AMBIGUOUS",
  );
});

test("r0NavigationTap: low confidence is tap=0", () => {
  const blocks = [okBlock({ confidence: 0.3 })];
  assert.throws(
    () => r0NavigationTap({ blocks, target: "搜索", dims: DIMS, frameHash: "f".repeat(64), confidenceThreshold: 0.6, clock: { nowMs: () => CAPTURED_AT } }),
    (e) => e.reasonCode === "AMBIGUOUS",
  );
});

test("r0NavigationTap: effect controls never tap (点赞/评论/发送)", () => {
  assert.ok(isEffectControlLabel("评论发送"));
  for (const label of ["点赞 12", "评论 3", "评论发送", "收藏", "关注", "私信"]) {
    const blocks = [okBlock({ label })];
    assert.throws(
      () => r0NavigationTap({ blocks, target: label, dims: DIMS, frameHash: "f".repeat(64), clock: { nowMs: () => CAPTURED_AT } }),
      (e) => e.reasonCode === "REDLINE",
      label,
    );
  }
});

test("r0NavigationTap: replayed (frame,block) is tap=0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "r0-replay-"));
  const ledger = join(tmp, "ledger.jsonl");
  try {
    const args = {
      blocks: [okBlock()], target: "搜索", dims: DIMS, frameHash: "f".repeat(64),
      ledgerPath: ledger, clock: { nowMs: () => CAPTURED_AT },
    };
    const first = r0NavigationTap(args);
    assert.equal(first.ok, true);
    assert.throws(() => r0NavigationTap(args), (e) => e.reasonCode === "AMBIGUOUS");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("r0NavigationTap: expired screenshot is tap=0", () => {
  // clock 31s after capture, ttl 30s
  assert.throws(
    () => r0NavigationTap({
      blocks: [okBlock()], target: "搜索", dims: DIMS, frameHash: "f".repeat(64),
      ttlMs: 30_000, clock: { nowMs: () => CAPTURED_AT + 31_000 },
    }),
    (e) => e.reasonCode === "AMBIGUOUS",
  );
});

test("r0NavigationTap: unbound frame hash is tap=0", () => {
  assert.throws(
    () => r0NavigationTap({ blocks: [okBlock()], target: "搜索", dims: DIMS, frameHash: null, clock: { nowMs: () => CAPTURED_AT } }),
    (e) => e.reasonCode === "AMBIGUOUS",
  );
});