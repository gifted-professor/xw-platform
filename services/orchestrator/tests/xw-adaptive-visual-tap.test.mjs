import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRedlineLabel,
  readPngDims,
  isOutOfBounds,
  isSystemArea,
  blockCenter,
  canonicalBlock,
  computeBlockId,
  rectOverlap,
  selectBlock,
  consumeActionRef,
  sha256File,
} from "../ops/xw-adaptive-visual-tap.mjs";

const DIMS = { width: 1080, height: 2400 };
const okBounds = (x = 100, y = 200, w = 200, h = 80) => ({ x, y, w, h });

test("isRedlineLabel detects payment/delete/auth labels", () => {
  assert.ok(isRedlineLabel("立即支付"));
  assert.ok(isRedlineLabel("删除账号"));
  assert.ok(isRedlineLabel("输入验证码"));
  assert.ok(isRedlineLabel("Login"));
  assert.ok(!isRedlineLabel("搜索"));
  assert.ok(!isRedlineLabel("深圳攀岩"));
});

test("isOutOfBounds rejects negative, zero-size, over-frame", () => {
  assert.ok(isOutOfBounds({ x: -1, y: 200, w: 100, h: 80 }, DIMS));
  assert.ok(isOutOfBounds({ x: 0, y: 0, w: 0, h: 80 }, DIMS));
  assert.ok(isOutOfBounds({ x: 1000, y: 2300, w: 200, h: 200 }, DIMS));
  assert.ok(!isOutOfBounds(okBounds(), DIMS));
});

test("isSystemArea rejects top status bar and bottom nav", () => {
  assert.ok(isSystemArea({ x: 0, y: 10, w: 1080, h: 40 }, DIMS)); // 顶栏
  assert.ok(isSystemArea({ x: 0, y: 2360, w: 1080, h: 40 }, DIMS)); // 底栏
  assert.ok(!isSystemArea(okBounds(100, 200, 200, 80), DIMS));
});

test("blockCenter is deterministic midpoint", () => {
  assert.deepEqual(blockCenter({ x: 100, y: 200, w: 200, h: 80 }), { x: 200, y: 240 });
  assert.deepEqual(blockCenter({ x: 0, y: 0, w: 1080, h: 2400 }), { x: 540, y: 1200 });
});

test("computeBlockId is content-addressed and deterministic", () => {
  const b = { label: "搜索", region: "home", bounds: okBounds() };
  const id1 = computeBlockId(b);
  const id2 = computeBlockId(b);
  assert.equal(id1, id2);
  assert.ok(id1.startsWith("blk_"));
  const b2 = { ...b, bounds: okBounds(101, 200, 200, 80) };
  assert.notEqual(computeBlockId(b2), id1);
});

test("rectOverlap detects overlapping and disjoint", () => {
  const a = okBounds(100, 200, 200, 80);
  assert.ok(rectOverlap(a, okBounds(150, 220, 100, 50)));
  assert.ok(!rectOverlap(a, okBounds(400, 400, 100, 50)));
});

test("selectBlock returns unique target block", () => {
  const blocks = [
    { label: "搜索", bounds: okBounds(440, 120, 200, 80), confidence: 0.9 },
    { label: "菜单", bounds: okBounds(40, 120, 100, 80), confidence: 0.8 },
  ];
  const r = selectBlock(blocks, "搜索", { dims: DIMS, confidenceThreshold: 0.5 });
  assert.equal(r.reason, "VISION_OK");
  assert.deepEqual(r.center, { x: 540, y: 160 });
  assert.ok(r.blockId.startsWith("blk_"));
});

test("selectBlock rejects redline label", () => {
  const blocks = [{ label: "立即支付", bounds: okBounds(), confidence: 0.9 }];
  assert.throws(
    () => selectBlock(blocks, "支付", { dims: DIMS }),
    /VISION_REDLINE/,
  );
});

test("selectBlock rejects out-of-bounds", () => {
  const blocks = [{ label: "搜索", bounds: { x: 1000, y: 2300, w: 200, h: 200 }, confidence: 0.9 }];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS }), /VISION_OUT_OF_BOUNDS/);
});

test("selectBlock rejects system area", () => {
  const blocks = [{ label: "搜索", bounds: { x: 0, y: 10, w: 200, h: 40 }, confidence: 0.9 }];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS }), /VISION_SYSTEM_AREA/);
});

test("selectBlock rejects low confidence", () => {
  const blocks = [{ label: "搜索", bounds: okBounds(), confidence: 0.2 }];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS, confidenceThreshold: 0.5 }), /VISION_LOW_CONFIDENCE/);
});

test("selectBlock rejects ambiguous overlapping candidates", () => {
  const blocks = [
    { label: "搜索", bounds: okBounds(440, 120, 200, 80), confidence: 0.9 },
    { label: "搜索", bounds: okBounds(460, 130, 200, 80), confidence: 0.9 }, // 重叠
  ];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS }), /VISION_AMBIGUOUS/);
});

test("selectBlock rejects multiple disjoint same-label blocks", () => {
  const blocks = [
    { label: "搜索", bounds: okBounds(440, 120, 200, 80), confidence: 0.9 },
    { label: "搜索", bounds: okBounds(440, 600, 200, 80), confidence: 0.9 }, // 不重叠但同名
  ];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS }), /VISION_AMBIGUOUS.*2/);
});

test("selectBlock rejects empty blocks", () => {
  assert.throws(() => selectBlock([], "x", { dims: DIMS }), /VISION_NO_BLOCKS/);
});

test("selectBlock rejects target not found", () => {
  const blocks = [{ label: "菜单", bounds: okBounds(), confidence: 0.9 }];
  assert.throws(() => selectBlock(blocks, "搜索", { dims: DIMS }), /VISION_TARGET_NOT_FOUND/);
});

test("consumeActionRef is single-use per screenshot+block", () => {
  const dir = mkdtempSync(join(tmpdir(), "vistap-ledger-"));
  const ledger = join(dir, "ledger.jsonl");
  const args = { screenshotHash: "h1", blockId: "blk_1", sessionId: "s1", ledgerPath: ledger };
  const ref1 = consumeActionRef(args);
  assert.ok(ref1.startsWith("act_"));
  assert.throws(() => consumeActionRef(args), /VISION_ACTIONREF_CONSUMED/);
  // 不同截图/块可再消费
  const ref3 = consumeActionRef({ ...args, blockId: "blk_2" });
  assert.ok(ref3.startsWith("act_"));
  rmSync(dir, { recursive: true, force: true });
});

test("readPngDims parses a minimal PNG IHDR", () => {
  // 构造 8-byte sig + IHDR chunk (len=13, "IHDR", w=1080, h=2400, bitdepth=8, colortype=2, ...)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrBody = Buffer.alloc(13);
  ihdrBody.writeUInt32BE(1080, 0);
  ihdrBody.writeUInt32BE(2400, 4);
  ihdrBody[8] = 8; ihdrBody[9] = 2; ihdrBody[10] = 0; ihdrBody[11] = 0; ihdrBody[12] = 0;
  const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
  const type = Buffer.from("IHDR");
  const png = Buffer.concat([sig, len, type, ihdrBody]);
  const dims = readPngDims(png);
  assert.equal(dims.width, 1080);
  assert.equal(dims.height, 2400);
});

test("readPngDims returns null for non-PNG", () => {
  assert.equal(readPngDims(Buffer.from("not a png")), null);
  assert.equal(readPngDims(Buffer.alloc(10)), null);
});

test("sha256File matches crypto", () => {
  const dir = mkdtempSync(join(tmpdir(), "vistap-hash-"));
  const f = join(dir, "a.png");
  writeFileSync(f, Buffer.from("hello"));
  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(sha256File(f), expected);
  rmSync(dir, { recursive: true, force: true });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "ops", "xw-adaptive-visual-tap.mjs");

function makeMinimalPng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(13);
  body.writeUInt32BE(w, 0);
  body.writeUInt32BE(h, 4);
  body[8] = 8; body[9] = 2; body[10] = 0; body[11] = 0; body[12] = 0;
  const len = Buffer.alloc(4); len.writeUInt32BE(13, 0);
  const type = Buffer.from("IHDR");
  return Buffer.concat([sig, len, type, body]);
}

test("--probe CLI emits PROBE_READY with hash/dims for an existing PNG", () => {
  const dir = mkdtempSync(join(tmpdir(), "vistap-probe-"));
  const png = join(dir, "probe.png");
  const buf = makeMinimalPng(1080, 2400);
  writeFileSync(png, buf);
  const out = execFileSync(process.execPath, [SCRIPT, "--probe", "--screenshot", png, "--captured-at", String(Date.now() - 1000)], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /PROBE_READY/);
  assert.match(out, /WIDTH=1080/);
  assert.match(out, /HEIGHT=2400/);
  assert.match(out, /HASH=[0-9a-f]{64}/);
  rmSync(dir, { recursive: true, force: true });
});

test("--probe CLI rejects alias != 04 when session capture requested", () => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SCRIPT, "--probe", "--alias", "01", "--session-file", "x"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  assert.match(out, /VISUAL_PROBE_ALIAS_NOT_04/);
});