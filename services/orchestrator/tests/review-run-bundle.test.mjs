import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewRunBundle } from "../scripts/review-run-bundle.mjs";

const tmp = mkdtempSync(join(tmpdir(), "rex-review-run-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function writeBundle(name, overrides = {}, events = [{ runId: "run_review_1", kind: "observe" }]) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaId: "xhs.explorer-run.v1",
    schemaVersion: 1,
    runId: "run_review_1",
    taskId: "task-1",
    actor: "windows:explorer",
    app: "xhs",
    deviceId: "01",
    startedAt: "2026-08-02T00:00:00.000Z",
    producerCommit: "a".repeat(40),
    releaseId: "rel-test",
    policyMode: "shadow",
    evidenceMode: "dual",
    effects: [],
    artifacts: [],
    candidateFiles: [{ path: "skills/xhs/xhs-search/SKILL.md", sha256: "b".repeat(64) }],
    evidenceDebt: [],
    contractSha256: "c".repeat(64),
    ...overrides,
  };
  const lined = events.map((event) => `${canonicalJson(event)}\n`).join("");
  writeFileSync(join(dir, "events.jsonl"), lined);
  writeFileSync(join(dir, "manifest.json"), `${canonicalJson(manifest)}\n`);
  writeFileSync(join(dir, "bundle.seal"), createHash("sha256").update(lined).digest("hex"));
  return dir;
}

test("valid explorer bundle produces a bound review receipt", () => {
  const dir = writeBundle("valid");
  const result = reviewRunBundle(dir, { reviewedAt: "2026-08-02T01:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.schemaId, "xhs.review-receipt.v1");
  assert.equal(result.receipt.runId, "run_review_1");
  assert.equal(result.receipt.producerCommit, "a".repeat(40));
  assert.equal(result.receipt.manifestSha256, createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex"));
  assert.equal(result.receipt.evidenceDebt.length, 0);
  assert.ok(result.receipt.claims.every((item) => item.status === "pass"));
});
test("seal mismatch fails review without mutating the bundle", () => {
  const dir = writeBundle("seal-bad");
  const before = readFileSync(join(dir, "events.jsonl"));
  writeFileSync(join(dir, "bundle.seal"), "0".repeat(64));
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "bundle-seal" && item.status === "fail"));
  assert.deepEqual(readFileSync(join(dir, "events.jsonl")), before);
});

test("event runId mismatch fails the receipt binding", () => {
  const dir = writeBundle("run-mismatch", {}, [{ runId: "run_other", kind: "observe" }]);
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "event-run-binding" && item.status === "fail"));
});

test("candidate traversal, invalid hash and duplicate path fail closed", () => {
  const dir = writeBundle("candidate-bad", {
    candidateFiles: [
      { path: "../registry.mjs", sha256: "b".repeat(64) },
      { path: "skills/xhs/x/SKILL.md", sha256: "bad" },
      { path: "skills/xhs/x/SKILL.md", sha256: "b".repeat(64) },
    ],
  });
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "candidate-files" && item.status === "fail"));
});

test("legacy-only evidence remains readable but cannot produce a passing v1 review receipt", () => {
  const dir = join(tmp, "legacy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ACCEPTANCE-XHS-test.md"), "# legacy\nexit=0\n");
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "bundle-kind" && item.status === "fail"));
});
