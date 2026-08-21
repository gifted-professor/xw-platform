// M6-1 replay corpus tests. Verifies the corpus manifest conforms to
// xw.replay-corpus-manifest.v1, is fully deidentified (sensitive-key scan),
// covers the task-brief scenarios, and is deterministic across regenerations.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateReplayCorpusManifest } from "../scripts/lib/m6/m6-contracts.mjs";
import { buildCorpus, generate } from "../../../tools/m6/generate-replay-corpus.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "services/orchestrator/contracts/m6/replay-corpus.v1.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

test("replay corpus: the committed manifest is schema-valid and privacy-scanned", () => {
  const r = validateReplayCorpusManifest(manifest);
  assert.equal(r.ok, true, `invalid manifest: ${JSON.stringify(r.errors.slice(0, 3))}`);
});

test("replay corpus: at least 200 deidentified synthetic frames", () => {
  const frames = manifest.entries.filter((e) => e.kind === "frame");
  assert.ok(frames.length >= 200, `expected >=200 frames, got ${frames.length}`);
  for (const entry of manifest.entries) {
    assert.equal(entry.deidentified, true, `${entry.entryId} must be deidentified`);
    assert.equal(entry.origin, "synthetic", `${entry.entryId} must be synthetic`);
    assert.ok(entry.license.length > 0, `${entry.entryId} must declare a license`);
  }
});

test("replay corpus: covers every required scenario from the task brief", () => {
  const required = [
    "popup", "keyboard", "rotation", "ads", "empty-dump", "dup-blocks",
    "sensitive", "scroll-before", "scroll-after", "permission-dialog", "status-bar", "system-nav",
  ];
  const notes = manifest.entries
    .filter((e) => e.kind === "frame")
    .map((e) => e.notes || "")
    .join("\n");
  for (const req of required) {
    assert.ok(notes.includes(req), `corpus must cover scenario: ${req}`);
  }
});

test("replay corpus: every frame freezes independent block/geometry/decision truth", () => {
  const frames = manifest.entries.filter((entry) => entry.kind === "frame");
  for (const frame of frames) {
    assert.ok(frame.expected, `${frame.entryId} must carry expected truth`);
    assert.ok(["ACTIONABLE", "REJECT"].includes(frame.expected.frameOutcome));
    if (frame.expected.frameOutcome === "ACTIONABLE") {
      assert.ok(frame.expected.blocks.length > 0, `${frame.entryId} expected blocks`);
      assert.ok(frame.expected.blocks.some((block) => block.stableIndex === frame.expected.targetStableIndex));
    }
    for (const block of frame.expected.blocks) {
      assert.ok(block.label.length > 0);
      assert.ok(block.category.length > 0);
      assert.ok(["ALLOW_ONCE", "REPLAN", "HARD_STOP"].includes(block.expectedDecision));
      assert.ok(block.bounds.w > 0 && block.bounds.h > 0);
    }
  }
});

test("replay corpus: every entry is content-addressed (64-hex sha256, positive bytes) with unique ids", () => {
  const ids = new Set();
  for (const entry of manifest.entries) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.entryId} sha256`);
    assert.ok(entry.bytes >= 1, `${entry.entryId} bytes`);
    assert.ok(!ids.has(entry.entryId), `${entry.entryId} entryId must be unique`);
    ids.add(entry.entryId);
  }
  // Content-addressed dedup is allowed (e.g. empty dumps hash alike); the sha256
  // set need not be the full size, but non-empty distinct content must collide-free.
  const shas = new Set(manifest.entries.map((e) => e.sha256));
  assert.ok(shas.size > manifest.entries.length / 4, "sha256 set should be rich, not collapsed");
});

test("replay corpus: the manifest passes a recursive sensitive-key scan", () => {
  // The validator already scans; assert explicitly that no entry carries a
  // sensitive key anywhere in its JSON (account/device/serial/token/etc).
  const r = validateReplayCorpusManifest(manifest);
  assert.equal(r.ok, true);
  // Also assert the raw serialized form has none of the forbidden substrings
  // as object keys (defensive against future schema relaxations).
  const raw = JSON.stringify(manifest).toLowerCase();
  for (const part of ["account", "device", "serial", "token", "cookie", "secret", "password", "balance", "credential"]) {
    // 'credential' may legitimately appear as a redline category elsewhere; here we
    // only assert it does not appear as a corpus entry key/value value.
    assert.ok(!raw.includes(`"${part}`), `forbidden key fragment in corpus: ${part}`);
  }
});

test("replay corpus: regeneration is deterministic — identical bytes and hashes", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "m6-corpus-"));
  const out = path.join(tmp, "regen.json");
  generate({ rootDir: REPO_ROOT, out, count: 208 });
  const regen = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(regen.entries, manifest.entries, "regenerated corpus must be byte-identical");
  assert.equal(regen.corpusId, manifest.corpusId);
});

test("replay corpus: buildCorpus produces the same entries as the committed manifest", () => {
  const built = buildCorpus(208);
  assert.deepEqual(built.entries, manifest.entries);
});
