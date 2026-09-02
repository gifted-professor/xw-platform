import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { createPinnedExplorationVisionAnalyzer } from "../scripts/lib/xhs-exploration-vision-process.mjs";

const SCRIPT = new URL("../providers/xhs-exploration-local-pause/analyze.py", import.meta.url);
const MODEL = new URL("../providers/xhs-exploration-local-pause/pause-zone-model.v1.json", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  name.copy(out, 4);
  payload.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, payload])), 8 + payload.length);
  return out;
}

function rgbPng(width, height, pixel) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    rows[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      rows[offset] = r;
      rows[offset + 1] = g;
      rows[offset + 2] = b;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pythonExecutable() {
  const commands = [
    process.env.XW_TEST_PYTHON,
    process.platform === "win32" ? "python.exe" : "python3",
    "python",
  ].filter(Boolean);
  for (const command of commands) {
    const probe = spawnSync(command, ["-c", "import sys;print(sys.executable)"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const resolved = String(probe.stdout ?? "").trim();
    if (probe.status === 0 && isAbsolute(resolved) && existsSync(resolved)) return resolved;
  }
  return null;
}

function providerConfig(python, overrides = {}) {
  const scriptPath = SCRIPT.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");
  const modelPath = MODEL.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");
  return {
    pin: {
      python: { path: python, sha256: sha256(readFileSync(python)) },
      script: { path: scriptPath, sha256: sha256(readFileSync(SCRIPT)) },
      model: { path: modelPath, sha256: sha256(readFileSync(MODEL)) },
    },
    analysis: {
      protocol: "xw.xhs.exploration-vision-process.v1",
      maxBufferBytes: 64 * 1024,
      timeoutMs: 8_000,
    },
    ...overrides,
  };
}

function candidateRect(
  model,
  width,
  height,
  column = 1,
  row = 1,
  page = "VIDEO_NOTE",
  role = "PAUSE_VIDEO_SAFE_ZONE",
) {
  const route = model.routes.find((entry) => (
    entry.page === page && entry.role === role
  ));
  const region = route.searchRegion;
  const candidate = route.candidate;
  const rx = Math.round(region.x * width);
  const ry = Math.round(region.y * height);
  const rw = Math.round(region.w * width);
  const rh = Math.round(region.h * height);
  const cw = Math.max(8, Math.round(candidate.width * width));
  const ch = Math.max(8, Math.round(candidate.height * height));
  const cx = rx + Math.floor(cw / 2)
    + Math.round(column * (rw - cw) / (candidate.columns - 1));
  const cy = ry + Math.floor(ch / 2)
    + Math.round(row * (rh - ch) / (candidate.rows - 1));
  return {
    x: Math.max(0, Math.min(width - cw, cx - Math.floor(cw / 2))),
    y: Math.max(0, Math.min(height - ch, cy - Math.floor(ch / 2))),
    w: cw,
    h: ch,
  };
}

function routeFixture(page, role, width = 360, height = 640) {
  const model = JSON.parse(readFileSync(MODEL, "utf8"));
  const route = model.routes.find((entry) => entry.page === page && entry.role === role);
  assert.ok(route, `missing route ${page}/${role}`);
  const candidates = [];
  for (let row = 0; row < route.candidate.rows; row += 1) {
    for (let column = 0; column < route.candidate.columns; column += 1) {
      candidates.push(candidateRect(model, width, height, column, row, page, role));
    }
  }
  const target = candidates[0];
  const margin = model.analysis.sampleStridePx + 1;
  const inside = (rect, x, y, inset = 0) => (
    x >= rect.x + inset && x < rect.x + rect.w - inset
    && y >= rect.y + inset && y < rect.y + rect.h - inset
  );
  return {
    route,
    target,
    bytes: rgbPng(width, height, (x, y) => {
      if (route.selection === "MIN_EDGE") {
        if (x >= target.x - margin && x < target.x + target.w + margin
          && y >= target.y - margin && y < target.y + target.h + margin) {
          return [128, 128, 128];
        }
        const value = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0 ? 24 : 232;
        return [value, value, value];
      }
      const uniquelyInsideTarget = inside(target, x, y, margin)
        && candidates.slice(1).every((candidate) => !inside(candidate, x, y));
      if (uniquelyInsideTarget) {
        const value = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0 ? 24 : 232;
        return [value, value, value];
      }
      return [128, 128, 128];
    }),
  };
}

function uniqueQuietFrame(width = 160, height = 240) {
  const model = JSON.parse(readFileSync(MODEL, "utf8"));
  const quiet = candidateRect(model, width, height);
  const margin = model.analysis.sampleStridePx + 1;
  return {
    quiet,
    bytes: rgbPng(width, height, (x, y) => {
      if (x >= quiet.x - margin && x < quiet.x + quiet.w + margin
        && y >= quiet.y - margin && y < quiet.y + quiet.h + margin) {
        return [128, 128, 128];
      }
      const value = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0 ? 24 : 232;
      return [value, value, value];
    }),
  };
}

test("local provider analyzes real PNG pixels through the pinned process protocol", async (t) => {
  const python = pythonExecutable();
  if (!python) return t.skip("a local Python interpreter is required to exercise the production provider source");
  const root = mkdtempSync(join(tmpdir(), "xhs-local-pause-provider-"));
  const { bytes, quiet } = uniqueQuietFrame();
  const analyzer = createPinnedExplorationVisionAnalyzer(providerConfig(python), {
    stagingRoot: join(root, "staging"),
    env: {},
  });
  try {
    const blocks = await analyzer.analyze({
      frame: {
        bytes,
        frameHash: sha256(bytes),
        capturedAt: 1234,
      },
      page: "VIDEO_NOTE",
      requestedRole: "PAUSE_VIDEO_SAFE_ZONE",
      deadlineMs: 8_000,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].label, "暂停视频安全区");
    assert.deepEqual(blocks[0].bounds, quiet);
    assert.ok(blocks[0].confidence >= 0.9 && blocks[0].confidence <= 0.99);
    assert.equal(blocks[0].capturedAt, 1234);
    assert.deepEqual(analyzer.stats(), { active: 0 });
  } finally {
    await analyzer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visually ambiguous frames return zero candidates", async (t) => {
  const python = pythonExecutable();
  if (!python) return t.skip("a local Python interpreter is required to exercise the production provider source");
  const root = mkdtempSync(join(tmpdir(), "xhs-local-pause-ambiguous-"));
  const bytes = rgbPng(160, 240, () => [128, 128, 128]);
  const analyzer = createPinnedExplorationVisionAnalyzer(providerConfig(python), {
    stagingRoot: join(root, "staging"),
    env: {},
  });
  try {
    assert.deepEqual(await analyzer.analyze({
      frame: { bytes, frameHash: sha256(bytes), capturedAt: 5678 },
      page: "VIDEO_NOTE",
      requestedRole: "PAUSE_VIDEO_SAFE_ZONE",
      deadlineMs: 8_000,
    }), []);
  } finally {
    await analyzer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one pinned source handles only the closed offline corpus page/role pairs", async (t) => {
  const python = pythonExecutable();
  if (!python) return t.skip("a local Python interpreter is required to exercise the production provider source");
  const root = mkdtempSync(join(tmpdir(), "xhs-local-navigation-routes-"));
  const analyzer = createPinnedExplorationVisionAnalyzer(providerConfig(python), {
    stagingRoot: join(root, "staging"),
    env: {},
  });
  const routes = [
    ["HOME_FEED", "OPEN_CONTENT_CARD", "打开内容卡片安全区"],
    ["SEARCH_RESULTS", "OPEN_CONTENT_CARD", "打开内容卡片安全区"],
    ["IMAGE_NOTE", "OPEN_COMMENT_PANEL", "打开评论面板导航区"],
    ["VIDEO_NOTE", "OPEN_COMMENT_PANEL", "打开评论面板导航区"],
    ["VIDEO_NOTE", "PAUSE_VIDEO_SAFE_ZONE", "暂停视频安全区"],
    ["COMMENT_PANEL", "BACK", "返回导航区"],
  ];
  try {
    for (const [page, requestedRole, label] of routes) {
      const { bytes, target } = routeFixture(page, requestedRole);
      const blocks = await analyzer.analyze({
        frame: { bytes, frameHash: sha256(bytes), capturedAt: 7_000 },
        page,
        requestedRole,
        deadlineMs: 8_000,
      });
      assert.equal(blocks.length, 1, `${page}/${requestedRole}`);
      assert.equal(blocks[0].label, label);
      assert.deepEqual(blocks[0].bounds, target);
      assert.ok(blocks[0].confidence >= 0.9 && blocks[0].confidence <= 0.99);
    }
  } finally {
    await analyzer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("1080x2400 analysis remains below the sealed 8000ms provider deadline", async (t) => {
  const python = pythonExecutable();
  if (!python) return t.skip("a local Python interpreter is required to exercise the production provider source");
  const root = mkdtempSync(join(tmpdir(), "xhs-local-pause-deadline-"));
  const { bytes } = uniqueQuietFrame(1080, 2400);
  const analyzer = createPinnedExplorationVisionAnalyzer(providerConfig(python), {
    stagingRoot: join(root, "staging"),
    env: {},
  });
  try {
    const startedAt = performance.now();
    const blocks = await analyzer.analyze({
      frame: { bytes, frameHash: sha256(bytes), capturedAt: 9012 },
      page: "VIDEO_NOTE",
      requestedRole: "PAUSE_VIDEO_SAFE_ZONE",
      deadlineMs: 8_000,
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(blocks.length, 1);
    assert.ok(elapsedMs < 8_000, `provider took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await analyzer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the child independently rejects frame/model binding drift and writes no result", (t) => {
  const python = pythonExecutable();
  if (!python) return t.skip("a local Python interpreter is required to exercise the production provider source");
  const root = mkdtempSync(join(tmpdir(), "xhs-local-pause-binding-"));
  try {
    const { bytes } = uniqueQuietFrame();
    const input = join(root, "frame.png");
    const output = join(root, "elements.json");
    writeFileSync(input, bytes);
    const baseEnv = {
      XW_VISION_MODEL_PATH: MODEL.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"),
      XW_VISION_MODEL_SHA256: sha256(readFileSync(MODEL)),
      XW_VISION_FRAME_SHA256: sha256(bytes),
      XW_VISION_PAGE: "VIDEO_NOTE",
      XW_VISION_REQUESTED_ROLE: "PAUSE_VIDEO_SAFE_ZONE",
    };
    const frameDrift = spawnSync(
      python,
      [SCRIPT.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"), input, "-o", output],
      { env: { ...baseEnv, XW_VISION_FRAME_SHA256: "0".repeat(64) }, encoding: "utf8", windowsHide: true },
    );
    assert.equal(frameDrift.status, 2);
    assert.match(frameDrift.stderr, /FRAME_HASH_MISMATCH/);
    assert.equal(existsSync(output), false);

    const modelDrift = spawnSync(
      python,
      [SCRIPT.pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"), input, "-o", output],
      { env: { ...baseEnv, XW_VISION_MODEL_SHA256: "0".repeat(64) }, encoding: "utf8", windowsHide: true },
    );
    assert.equal(modelDrift.status, 2);
    assert.match(modelDrift.stderr, /MODEL_HASH_MISMATCH/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
