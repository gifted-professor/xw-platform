import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewRunBundle } from "../scripts/review-run-bundle.mjs";
import {
  currentTaskCloseoutContractSha256,
  canonicalJson,
  sha256Bytes,
} from "../scripts/lib/task-closeout-contract.mjs";

const tmp = mkdtempSync(join(tmpdir(), "rex-review-run-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function writeCloseoutBundle(name, { tamperSeal = false } = {}) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const contractSha = currentTaskCloseoutContractSha256();
  const commit = "a".repeat(40);
  const observation = { status: "not_applicable", observedAt: null, evidenceRefs: [] };
  const closeout = {
    schemaId: "xhs.task-closeout.v1",
    schemaVersion: 1,
    taskId: "task_closeout_review",
    runId: "run_closeout_review_1",
    actor: "windows:test",
    machine: { id: "DESKTOP-TEST", platform: "windows" },
    mode: "explorer",
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:01:00.000Z",
    producer: {
      name: "xw-closeout",
      version: "1",
      commit,
      scriptSha256: "b".repeat(64),
      contractSha256: contractSha,
    },
    sources: [{
      repo: "xhs-registry",
      branch: "main",
      head: commit,
      worktree: "clean",
      changedFiles: [],
      commit,
      ahead: 0,
      behind: 0,
      pushed: true,
    }],
    checks: [],
    runtime: { deployment: observation, reload: observation, serve: observation },
    deviceRefs: {
      devices: [],
      runs: ["run_closeout_review_1"],
      jobs: [],
      sessions: [],
      leases: [],
      evidenceRefs: [],
    },
    effects: [],
    artifacts: [],
    candidates: [],
    closure: { status: "completed", completed: ["done"], remainingWork: [], blockers: [] },
    claims: [],
    evidenceDebt: [],
    acceptanceConditions: [],
  };
  const closeoutBytes = Buffer.from(`${canonicalJson(closeout)}\n`);
  writeFileSync(join(dir, "closeout.v1.json"), closeoutBytes);
  const manifest = {
    schemaId: "xhs.task-closeout-manifest.v1",
    schemaVersion: 1,
    runId: closeout.runId,
    producerCommit: commit,
    contractSha256: contractSha,
    files: [{ path: "closeout.v1.json", sha256: sha256Bytes(closeoutBytes), bytes: closeoutBytes.length }],
  };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  writeFileSync(join(dir, "manifest.json"), manifestBytes);
  writeFileSync(join(dir, "manifest.sha256"), `${tamperSeal ? "0".repeat(64) : sha256Bytes(manifestBytes)}\n`);
  return dir;
}

function writeBundle(name, overrides = {}, events = [{ runId: "run_review_1", producerCommit: "a".repeat(40), kind: "observe" }]) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const { _artifactFiles = {}, ...manifestOverrides } = overrides;
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
    ...manifestOverrides,
  };
  for (const [path, content] of Object.entries(_artifactFiles)) {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const lined = events.map((event) => `${canonicalJson(event)}\n`).join("");
  writeFileSync(join(dir, "events.jsonl"), lined);
  writeFileSync(join(dir, "manifest.json"), `${canonicalJson(manifest)}\n`);
  writeFileSync(join(dir, "bundle.seal"), createHash("sha256").update(lined).digest("hex"));
  return dir;
}

function writeAggregateBundle(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const files = [];
  const put = (path, content) => {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    const bytes = Buffer.from(content);
    writeFileSync(target, bytes);
    files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    return files.at(-1);
  };
  for (const runId of ["run_aggregate_primary", "run_aggregate_replay"]) {
    const jobId = `job_${runId}`;
    const result = put(`runs/${runId}/evidence/result.json`, canonicalJson({ output: {}, verification: { ok: true } }));
    put(`runs/${runId}/events.jsonl`, [
      canonicalJson({ type: "run.initialized", jobId, capabilityId: "xhs.observe.feed" }),
      canonicalJson({ type: "job.succeeded", jobId }),
      "",
    ].join("\n"));
    put(`runs/${runId}/manifest.json`, canonicalJson({
      runId,
      jobId,
      capabilityId: "xhs.observe.feed",
      gitCommit: "a".repeat(40),
      evidence: [{ kind: "result", path: "evidence\\result.json", sha256: result.sha256, bytes: result.bytes, runId, jobId }],
    }));
  }
  const manifest = {
    schemaVersion: "xhs.review-bundle.v1",
    bundleId: name,
    producerCommit: "a".repeat(40),
    releaseId: "rel-aggregate",
    app: "xhs",
    externalEffect: false,
    paymentTransport: 0,
    evidenceDebt: [{ type: "missing_screenshot" }],
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  writeFileSync(join(dir, "manifest.json"), manifestBytes);
  writeFileSync(join(dir, "manifest.sha256"), `${manifestSha256}\n`);
  mkdirSync(join(dir, "mac-review"), { recursive: true });
  writeFileSync(join(dir, "mac-review/mac-independent-review-receipt.json"), JSON.stringify({
    schemaId: "xhs.review-receipt.v1",
    schemaVersion: 1,
    reviewId: "review_aggregate",
    runId: "run_aggregate_primary",
    manifestSha256,
    producerCommit: "a".repeat(40),
    reviewedAt: "2026-08-02T08:22:59Z",
    claims: [],
    evidenceDebt: [],
  }, null, 2));
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

test("repairable xhs.observe.feed evidence debt emits a machine proposal and knowledge envelope", () => {
  const dir = writeBundle("feed-evidence-debt", {
    capabilityId: "xhs.observe.feed",
    candidateFiles: [],
  }, [{
    runId: "run_review_1",
    producerCommit: "a".repeat(40),
    capabilityId: "xhs.observe.feed",
    output: {},
  }]);
  const result = reviewRunBundle(dir, { reviewedAt: "2026-08-02T02:00:00.000Z" });
  assert.equal(result.ok, false, "evidence completeness review fails closed without changing the business run result");
  assert.equal(result.receipt.findings.length, 1);
  assert.equal(result.receipt.findings[0].code, "XHS_OBSERVE_FEED_EVIDENCE_INCOMPLETE");
  assert.deepEqual(result.receipt.findings[0].observed.missing, [
    "screenshot artifact",
    "UI dump artifact",
    "output.pageClass",
    "output.cardCount",
    "output.artifactRefs",
  ]);
  assert.equal(result.repairProposals.length, 1);
  assert.equal(result.repairProposals[0].source.manifestSha256, result.receipt.manifestSha256);
  assert.equal(result.repairProposals[0].finding.findingId, result.receipt.findings[0].findingId);
  assert.equal(result.repairProposals[0].policy.evidenceFailureMode, "debt_only");
  assert.equal(result.knowledgeEntries[0].id, result.repairProposals[0].proposalId);
  assert.deepEqual(JSON.parse(result.knowledgeEntries[0].content), result.repairProposals[0]);
});

test("complete xhs.observe.feed projection and artifacts do not create a repair proposal", () => {
  const screenshot = Buffer.from("redacted screenshot");
  const uiDump = Buffer.from("<hierarchy redacted=\"true\" />");
  const dir = writeBundle("feed-evidence-complete", {
    capabilityId: "xhs.observe.feed",
    _artifactFiles: {
      "artifacts/screenshot.png": screenshot,
      "artifacts/ui.xml": uiDump,
    },
    artifacts: [
      { id: "artifact:screenshot", kind: "screenshot", path: "artifacts/screenshot.png", sha256: createHash("sha256").update(screenshot).digest("hex") },
      { id: "artifact:ui-dump", kind: "ui_dump", path: "artifacts/ui.xml", sha256: createHash("sha256").update(uiDump).digest("hex") },
    ],
  }, [{
    runId: "run_review_1",
    producerCommit: "a".repeat(40),
    capabilityId: "xhs.observe.feed",
    output: { pageClass: "feed", cardCount: 3, artifactRefs: ["artifact:screenshot", "artifact:ui-dump"] },
  }]);
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.receipt.findings, []);
  assert.deepEqual(result.repairProposals, []);
});

test("tampered xhs.observe.feed bundle never emits a repair proposal", () => {
  const dir = writeBundle("feed-tampered", {
    capabilityId: "xhs.observe.feed",
  }, [{
    runId: "run_review_1",
    producerCommit: "a".repeat(40),
    capabilityId: "xhs.observe.feed",
    output: {},
  }]);
  writeFileSync(join(dir, "bundle.seal"), "0".repeat(64));
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.equal(result.receipt.findings.length, 1, "finding remains visible as an untrusted review fact");
  assert.deepEqual(result.repairProposals, [], "integrity failure must fail closed before proposal creation");
});

test("manifest-only producer or capability claims cannot produce a proposal", () => {
  const wrongCommit = writeBundle("feed-manifest-commit-tampered", {
    capabilityId: "xhs.observe.feed",
    producerCommit: "b".repeat(40),
  }, [{
    runId: "run_review_1",
    producerCommit: "a".repeat(40),
    capabilityId: "xhs.observe.feed",
    output: {},
  }]);
  const wrongCommitResult = reviewRunBundle(wrongCommit);
  assert.equal(wrongCommitResult.ok, false);
  assert.deepEqual(wrongCommitResult.repairProposals, []);

  const missingEventClaims = writeBundle("feed-event-claims-missing", {
    capabilityId: "xhs.observe.feed",
  }, [{ runId: "run_review_1", output: {} }]);
  const missingResult = reviewRunBundle(missingEventClaims);
  assert.equal(missingResult.ok, false);
  assert.deepEqual(missingResult.receipt.findings, []);
  assert.deepEqual(missingResult.repairProposals, []);
});

test("unreadable, unhashed or unbound artifact references remain repairable debt", () => {
  const dir = writeBundle("feed-artifact-unbound", {
    capabilityId: "xhs.observe.feed",
    artifacts: [
      { id: "artifact:screenshot", kind: "screenshot", path: "artifacts/missing.png", sha256: "1".repeat(64) },
    ],
  }, [{
    runId: "run_review_1",
    producerCommit: "a".repeat(40),
    capabilityId: "xhs.observe.feed",
    output: { pageClass: "feed", cardCount: 1, artifactRefs: ["artifact:not-in-manifest"] },
  }]);
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "manifest-artifact-integrity" && item.status === "fail"));
  assert.equal(result.receipt.findings.length, 1);
  assert.deepEqual(result.repairProposals, []);
});

test("aggregate review bundle is hash-checked and reproducibly emits a Skill-bound proposal", () => {
  const dir = writeAggregateBundle("aggregate-feed");
  const options = {
    reviewedAt: "2026-08-02T09:30:00.000Z",
    targetSkillBinding: {
      path: "skills/xhs/xhs-observe-feed/SKILL.md",
      version: "0.1",
      sourceSha256: "2".repeat(64),
    },
  };
  const first = reviewRunBundle(dir, options);
  const second = reviewRunBundle(dir, { ...options, reviewedAt: "2026-08-02T10:30:00.000Z" });
  assert.equal(first.ok, false, "missing evidence stays debt-only");
  assert.ok(first.aggregateClaims.every((item) => item.status === "pass"));
  assert.equal(first.repairProposals.length, 1);
  assert.equal(first.repairProposals[0].proposalId, second.repairProposals[0].proposalId);
  assert.deepEqual(first.repairProposals[0].target.skillBinding, options.targetSkillBinding);
});

test("valid closeout bundle produces a bound review receipt", () => {
  const dir = writeCloseoutBundle("closeout-valid");
  const result = reviewRunBundle(dir, { reviewedAt: "2026-08-04T12:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.schemaId, "xhs.review-receipt.v1");
  assert.equal(result.receipt.runId, "run_closeout_review_1");
  assert.equal(result.receipt.bundleKind, "closeout");
  assert.ok(result.receipt.claims.every((item) => item.status === "pass"));
  assert.equal(result.repairProposals.length, 0);
});

test("tampered closeout seal fails review without mutating closeout bytes", () => {
  const dir = writeCloseoutBundle("closeout-seal-bad", { tamperSeal: true });
  const before = readFileSync(join(dir, "closeout.v1.json"));
  const result = reviewRunBundle(dir);
  assert.equal(result.ok, false);
  assert.ok(result.receipt.claims.some((item) => item.id === "bundle-seal" && item.status === "fail"));
  assert.deepEqual(readFileSync(join(dir, "closeout.v1.json")), before);
});
