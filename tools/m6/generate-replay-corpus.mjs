#!/usr/bin/env node
/**
 * M6-1 replay corpus generator.
 *
 * Produces a deterministic, deidentified, fully-synthetic replay corpus manifest
 * (xw.replay-corpus-manifest.v1) of >=200 frames plus their per-frame evidence
 * entries. No Math.random, no Date.now, no real device capture: every byte is a
 * program-generated stable pattern keyed on the frame index. The manifest is the
 * single content-addressed record; the synthetic evidence bytes live alongside it
 * as deterministic strings hashed at generation time.
 *
 * Coverage (task brief §M6-1): popups, keyboard, rotation, ads, empty dump,
 * repeated blocks, sensitive labels, scroll before/after, permission-dialog,
 * status-bar, system-navigation.
 *
 * Usage: node tools/m6/generate-replay-corpus.mjs [--out <path>] [--count <n>]
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_OUT = "services/orchestrator/contracts/m6/replay-corpus.v1.json";
const FRAME_COUNT = 208;

const SCENARIOS = Object.freeze([
  { id: "popup", note: "permission/confirm popup", kind: "popup" },
  { id: "keyboard", note: "on-screen keyboard active", kind: "keyboard" },
  { id: "rotation", note: "orientation change (landscape)", kind: "rotation" },
  { id: "ads", note: "ad block present", kind: "ads" },
  { id: "empty-dump", note: "empty accessibility dump", kind: "empty-dump" },
  { id: "dup-blocks", note: "repeated candidate blocks", kind: "dup-blocks" },
  { id: "sensitive", note: "sensitive payment/delete label", kind: "sensitive" },
  { id: "scroll-before", note: "feed before scroll", kind: "scroll-before" },
  { id: "scroll-after", note: "feed after scroll", kind: "scroll-after" },
  { id: "permission-dialog", note: "system permission dialog", kind: "permission-dialog" },
  { id: "status-bar", note: "status bar region", kind: "status-bar" },
  { id: "system-nav", note: "system navigation region", kind: "system-nav" },
  { id: "content-search", note: "content search block (benign)", kind: "content-search" },
]);

// Frozen synthetic scene truth. This is the annotation source, not the
// GroundingRuntime/provider output. Metrics consume the committed `expected`
// records below, so a provider that drops, relabels, reorders or moves a block
// fails recall/top-1/geometry instead of rewriting its own answer key.
const SCENE_BLOCKS = Object.freeze({
  popup: [["取消", "permission-dialog"], ["确定", "permission-dialog"], ["内容", "content"]],
  keyboard: [["输入框", "content"], ["键盘", "keyboard"], ["返回", "system-navigation"]],
  rotation: [["横屏内容", "content"], ["返回", "system-navigation"]],
  ads: [["跳过广告", "content"], ["广告", "ads"]],
  "empty-dump": [],
  "dup-blocks": [["滚动内容", "content"], ["滚动内容", "content"]],
  sensitive: [["确认支付", "payment"], ["返回", "system-navigation"]],
  "scroll-before": [["第一条", "content"], ["滚动内容", "content"]],
  "scroll-after": [["第二条", "content"], ["加载更多", "content"]],
  "permission-dialog": [["允许", "permission-dialog"], ["拒绝", "permission-dialog"]],
  "status-bar": [["搜索", "content"], ["状态栏", "status-bar"]],
  "system-nav": [["返回", "system-navigation"], ["标题", "content"]],
  "content-search": [["搜索", "content"], ["发现", "system-navigation"]],
});

export function syntheticBounds(stableIndex) {
  return { x: 100, y: 100 + stableIndex * 180, w: 360, h: 120 };
}

export function expectedScene(scenarioId) {
  const specs = SCENE_BLOCKS[scenarioId];
  if (!specs) throw new Error(`unknown synthetic replay scenario: ${scenarioId}`);
  const duplicateLabels = new Set(specs
    .map(([label]) => label)
    .filter((label, index, labels) => labels.indexOf(label) !== index));
  const blocks = specs.map(([label, category], stableIndex) => ({
    stableIndex,
    label,
    category,
    bounds: syntheticBounds(stableIndex),
    expectedDecision: category === "payment" || category === "delete"
      ? "HARD_STOP"
      : duplicateLabels.has(label) ? "REPLAN" : "ALLOW_ONCE",
  }));
  return scenarioId === "empty-dump"
    ? { frameOutcome: "REJECT", blocks }
    : { frameOutcome: "ACTIONABLE", targetStableIndex: 0, blocks };
}

function sha256(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Deterministic synthetic evidence for one frame. Stable across runs and platforms.
export function syntheticEvidence(frameIndex, scenarioId) {
  const seed = `${frameIndex}:${scenarioId}`;
  const screenshotA = `synthetic-frame-${seed}`;
  const screenshotB = screenshotA; // stable frame
  const dump = scenarioId === "empty-dump" ? "" : `dump-${seed}`;
  const focus = `focus-${seed}`;
  const orientation = scenarioId === "rotation" ? "landscape" : "portrait";
  return { screenshotA, screenshotB, dump, focus, orientation };
}

export function frameManifestContent(frameIndex, scenarioId, evidence = syntheticEvidence(frameIndex, scenarioId)) {
  const aSha = sha256(evidence.screenshotA);
  const bSha = sha256(evidence.screenshotB);
  const dSha = sha256(evidence.dump || "empty");
  const fSha = sha256(evidence.focus);
  return JSON.stringify({ frameIndex, scenario: scenarioId, aSha, bSha, dSha, fSha, orientation: evidence.orientation });
}

export function buildCorpus(count = FRAME_COUNT) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const scenario = SCENARIOS[i % SCENARIOS.length];
    const ev = syntheticEvidence(i, scenario.id);
    const frameEntryId = `frame-${String(i).padStart(4, "0")}-${scenario.id}`;
    // The frame entry content binds its evidence sha256 set + scenario metadata.
    const aSha = sha256(ev.screenshotA);
    const bSha = sha256(ev.screenshotB);
    const dSha = sha256(ev.dump || "empty");
    const fSha = sha256(ev.focus);
    const frameContent = frameManifestContent(i, scenario.id, ev);
    const frameSha = sha256(frameContent);
    const frameBytes = Buffer.byteLength(frameContent, "utf8");

    entries.push({
      entryId: frameEntryId,
      kind: "frame",
      sha256: frameSha,
      bytes: frameBytes,
      source: "tools/m6/generate-replay-corpus.mjs (deterministic synthetic generator)",
      license: "repo-internal (synthetic, no third-party assets)",
      deidentified: true,
      origin: "synthetic",
      notes: `scenario=${scenario.id}; ${scenario.note}; orientation=${ev.orientation}`,
      expected: expectedScene(scenario.id),
    });
    // One evidence entry per capture artifact so the corpus is content-addressed
    // at the artifact level too (screenshot/dump/focus kinds per schema).
    entries.push({
      entryId: `${frameEntryId}:screenshot`,
      kind: "screenshot",
      sha256: aSha,
      bytes: Buffer.byteLength(ev.screenshotA, "utf8"),
      source: "tools/m6/generate-replay-corpus.mjs (synthetic screenshot)",
      license: "repo-internal (synthetic)",
      deidentified: true,
      origin: "synthetic",
      notes: "synthetic stable frame screenshot A==B",
    });
    entries.push({
      entryId: `${frameEntryId}:dump`,
      kind: "dump",
      sha256: dSha,
      bytes: Buffer.byteLength(ev.dump || "empty", "utf8"),
      source: "tools/m6/generate-replay-corpus.mjs (synthetic accessibility dump)",
      license: "repo-internal (synthetic)",
      deidentified: true,
      origin: "synthetic",
      notes: scenario.id === "empty-dump" ? "empty dump scenario" : "synthetic dump content",
    });
    entries.push({
      entryId: `${frameEntryId}:focus`,
      kind: "focus",
      sha256: fSha,
      bytes: Buffer.byteLength(ev.focus, "utf8"),
      source: "tools/m6/generate-replay-corpus.mjs (synthetic focus state)",
      license: "repo-internal (synthetic)",
      deidentified: true,
      origin: "synthetic",
      notes: "synthetic focus fingerprint seed",
    });
  }
  return {
    schemaId: "xw.replay-corpus-manifest.v1",
    schemaVersion: 1,
    corpusId: "m6-1-hermetic-replay-corpus",
    createdAt: "2026-08-21T00:00:00.000Z",
    entries,
  };
}

export function generate({ rootDir = REPO_ROOT, out = DEFAULT_OUT, count = FRAME_COUNT } = {}) {
  const manifest = buildCorpus(count);
  const resolvedOut = out || DEFAULT_OUT;
  const outPath = path.isAbsolute(resolvedOut) ? resolvedOut : path.join(rootDir, resolvedOut);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outPath, frameCount: count, entryCount: manifest.entries.length };
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const out = argOf("--out");
  const count = argOf("--count") ? Number(argOf("--count")) : FRAME_COUNT;
  const result = generate({ out, count });
  process.stdout.write(`REPLAY_CORPUS_GENERATED frames=${result.frameCount} entries=${result.entryCount} -> ${result.outPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
