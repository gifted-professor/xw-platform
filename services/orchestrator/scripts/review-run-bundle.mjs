#!/usr/bin/env node
/**
 * review-run-bundle — Mac governance 对显式 Windows sealed bundle 做纯离线机械复核。
 *
 * 输出 xhs.review-receipt.v1 JSON；不 SSH、不碰设备、不写源仓、不执行 adopt。
 * 主观能力评判仍由 modes/governance.md 约束的人/agent 完成。
 *
 *   node scripts/review-run-bundle.mjs <bundleDir>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readBundle, verifyBundleSeal } from "./lib/evidence-contract.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

function claim(id, ok, detail) {
  return { id, status: ok ? "pass" : "fail", detail };
}
function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

export function reviewRunBundle(dir, { reviewedAt = new Date().toISOString() } = {}) {
  const bundle = readBundle(dir);
  const claims = [];
  const reviewDebt = bundle.debt.map((item) => ({ ...item }));
  const fail = (id, detail, code = id.toUpperCase().replaceAll("-", "_")) => {
    claims.push(claim(id, false, detail));
    reviewDebt.push({ layer: "review", code, cause: detail });
  };
  const pass = (id, detail) => claims.push(claim(id, true, detail));

  let manifestBytes = null;
  let manifestSha256 = "0".repeat(64);
  try {
    manifestBytes = readFileSync(join(dir, "manifest.json"));
    manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    pass("manifest-readable", `sha256:${manifestSha256}`);
  } catch (error) {
    fail("manifest-readable", error.message, "MANIFEST_READ_FAIL");
  }

  const isV1 = bundle.kind === "v1" || bundle.kind === "both";
  if (isV1) pass("bundle-kind", bundle.kind);
  else fail("bundle-kind", `expected v1/both, got ${bundle.kind}`, "BUNDLE_KIND_UNSUPPORTED");

  const seal = verifyBundleSeal(bundle);
  if (seal.ok && isV1) pass("bundle-seal", seal.sealHash ?? seal.reason);
  else fail("bundle-seal", seal.reason ?? "v1 seal unavailable", "BUNDLE_SEAL_INVALID");

  const manifest = bundle.manifest;
  const schemaOk = manifest?.schemaId === "xhs.explorer-run.v1" && manifest?.schemaVersion === 1;
  if (schemaOk) pass("manifest-schema", "xhs.explorer-run.v1@1");
  else fail("manifest-schema", "expected xhs.explorer-run.v1 schemaVersion=1", "MANIFEST_SCHEMA_INVALID");

  const runId = typeof manifest?.runId === "string" && manifest.runId.startsWith("run_") ? manifest.runId : null;
  if (runId) pass("run-id", runId);
  else fail("run-id", "manifest.runId must start with run_", "RUN_ID_INVALID");

  const producerCommit = SHA40.test(manifest?.producerCommit ?? "") ? manifest.producerCommit : null;
  if (producerCommit) pass("producer-commit", producerCommit);
  else fail("producer-commit", "manifest.producerCommit must be a full 40-hex SHA", "PRODUCER_COMMIT_INVALID");

  const eventMismatches = runId
    ? bundle.events.filter((event) => event?.runId != null && event.runId !== runId).length
    : bundle.events.length;
  if (eventMismatches === 0) pass("event-run-binding", `${bundle.events.length} events`);
  else fail("event-run-binding", `${eventMismatches} event(s) do not bind to manifest.runId`, "EVENT_RUN_MISMATCH");

  const eventCommitMismatches = producerCommit
    ? bundle.events.filter((event) => event?.producerCommit != null && event.producerCommit !== producerCommit).length
    : bundle.events.length;
  if (eventCommitMismatches === 0) pass("event-commit-binding", "no producerCommit mismatch");
  else fail("event-commit-binding", `${eventCommitMismatches} event(s) have a different producerCommit`, "EVENT_COMMIT_MISMATCH");

  for (const field of ["effects", "artifacts", "evidenceDebt"]) {
    if (Array.isArray(manifest?.[field])) pass(`manifest-${field}`, `${manifest[field].length} item(s)`);
    else fail(`manifest-${field}`, `manifest.${field} must be an array`, `MANIFEST_${field.toUpperCase()}_INVALID`);
  }

  const candidates = manifest?.candidateFiles ?? [];
  if (!Array.isArray(candidates)) {
    fail("candidate-files", "manifest.candidateFiles must be an array when present", "CANDIDATE_FILES_INVALID");
  } else {
    const seen = new Set();
    const invalid = [];
    for (const item of candidates) {
      const path = item?.path;
      if (!safeRelativePath(path) || !SHA256.test(item?.sha256 ?? "") || seen.has(path)) invalid.push(path ?? "(missing)");
      if (typeof path === "string") seen.add(path);
    }
    if (invalid.length === 0) pass("candidate-files", `${candidates.length} explicit candidate(s)`);
    else fail("candidate-files", `invalid path/hash/duplicate: ${invalid.join(", ")}`, "CANDIDATE_FILES_INVALID");
  }

  const claimsOk = claims.every((item) => item.status === "pass");
  const receipt = {
    schemaId: "xhs.review-receipt.v1",
    schemaVersion: 1,
    reviewId: `review_${manifestSha256.slice(0, 16)}`,
    runId: runId ?? "run_invalid",
    manifestSha256,
    producerCommit: producerCommit ?? "0".repeat(40),
    reviewedAt,
    claims,
    evidenceDebt: reviewDebt,
  };

  return { ok: claimsOk && reviewDebt.length === 0, receipt };
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.log("用法: node scripts/review-run-bundle.mjs <bundleDir>");
    process.exitCode = 4;
  } else {
    const result = reviewRunBundle(dir);
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  }
}
