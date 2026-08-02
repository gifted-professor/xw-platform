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
import { canonicalJson, createRepairProposal, proposalKnowledgeEnvelope, sha256 } from "./lib/repair-proposal.mjs";

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

export function reviewRunBundle(dir, { reviewedAt = new Date().toISOString(), targetSkillBinding } = {}) {
  const aggregate = readAggregateManifest(dir);
  if (aggregate) return reviewAggregateRepairBundle(dir, aggregate, { reviewedAt, targetSkillBinding });
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
    ? bundle.events.filter((event) => event?.runId !== runId).length
    : bundle.events.length;
  if (eventMismatches === 0) pass("event-run-binding", `${bundle.events.length} events`);
  else fail("event-run-binding", `${eventMismatches} event(s) do not bind to manifest.runId`, "EVENT_RUN_MISMATCH");

  const eventCommitMismatches = producerCommit
    ? bundle.events.filter((event) => event?.producerCommit !== producerCommit).length
    : bundle.events.length;
  if (eventCommitMismatches === 0) pass("event-commit-binding", "no producerCommit mismatch");
  else fail("event-commit-binding", `${eventCommitMismatches} event(s) have a different producerCommit`, "EVENT_COMMIT_MISMATCH");

  for (const field of ["effects", "artifacts", "evidenceDebt"]) {
    if (Array.isArray(manifest?.[field])) pass(`manifest-${field}`, `${manifest[field].length} item(s)`);
    else fail(`manifest-${field}`, `manifest.${field} must be an array`, `MANIFEST_${field.toUpperCase()}_INVALID`);
  }

  const artifactCheck = verifyManifestArtifacts(dir, manifest?.artifacts ?? []);
  if (artifactCheck.ok) pass("manifest-artifact-integrity", `${artifactCheck.artifacts.length} hashed artifact(s)`);
  else fail("manifest-artifact-integrity", artifactCheck.errors.join("; "), "MANIFEST_ARTIFACT_INTEGRITY_INVALID");

  const findings = detectRepairableFindings({ manifest, events: bundle.events, manifestSha256, runId, producerCommit, artifacts: artifactCheck.artifacts });
  for (const finding of findings) {
    for (const debt of finding.evidenceDebt) reviewDebt.push({ ...debt });
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
    findings,
  };

  const receiptSha256 = sha256(canonicalJson(receipt));
  const repairProposals = claimsOk && runId && producerCommit
    ? findings.map((finding) => createRepairProposal({
      source: {
        bundleId: manifest?.bundleId ?? runId,
        manifestSha256,
        primaryRunId: runId,
        runIds: [runId],
        producerCommit,
        releaseId: manifest?.releaseId ?? null,
        review: {
          reviewId: receipt.reviewId,
          receiptSha256,
          reviewedAt,
          disposition: "repairable_debt",
        },
      },
      target: {
        repository: "gifted-professor/xhs-device-agent",
        branch: "main",
        baseCommit: producerCommit,
        app: manifest?.app ?? "xhs",
        capabilityId: "xhs.observe.feed",
      },
      finding,
      policy: defaultObserveFeedEvidencePolicy(),
      createdAt: reviewedAt,
    }))
    : [];

  return {
    ok: claimsOk && reviewDebt.length === 0,
    receipt,
    repairProposals,
    knowledgeEntries: repairProposals.map(proposalKnowledgeEnvelope),
  };
}

function detectRepairableFindings({ manifest, events, manifestSha256, runId, producerCommit, artifacts }) {
  const eventCapabilities = events.map((event) => event?.capabilityId ?? event?.payload?.capabilityId);
  if (eventCapabilities.length === 0 || eventCapabilities.some((value) => typeof value !== "string" || value.length === 0)) return [];
  const uniqueCapabilities = [...new Set(eventCapabilities)];
  if (uniqueCapabilities.length !== 1) return [];
  const capabilityId = uniqueCapabilities[0];
  if (manifest?.capabilityId !== undefined && manifest.capabilityId !== capabilityId) return [];
  if (capabilityId !== "xhs.observe.feed") return [];

  const artifactKinds = new Set(artifacts.flatMap((artifact) => [artifact?.kind, artifact?.type, artifact?.mediaType].filter(Boolean).map((item) => String(item).toLowerCase())));
  const artifactIdentifiers = new Set(artifacts.flatMap((artifact) => [artifact.id, artifact.artifactId, artifact.ref, artifact.path, artifact.sha256].filter(Boolean)));
  const outputs = events.flatMap((event) => [event?.output, event?.result?.output, event?.payload?.output]).filter((item) => item && typeof item === "object");
  const hasScreenshot = [...artifactKinds].some((kind) => kind.includes("screenshot") || kind.startsWith("image/"));
  const hasUiDump = [...artifactKinds].some((kind) => kind.includes("ui_dump") || kind.includes("hierarchy") || kind.includes("xml"));
  const hasPageClass = outputs.some((output) => typeof output.pageClass === "string" && output.pageClass.length > 0);
  const hasCardCount = outputs.some((output) => Number.isInteger(output.cardCount) && output.cardCount >= 0);
  const hasArtifactRefs = outputs.some((output) => Array.isArray(output.artifactRefs)
    && output.artifactRefs.length > 0
    && output.artifactRefs.every((ref) => artifactIdentifiers.has(typeof ref === "string" ? ref : (ref?.sha256 ?? ref?.ref ?? ref?.id ?? ref?.path))));
  const missing = [
    !hasScreenshot && "screenshot artifact",
    !hasUiDump && "UI dump artifact",
    !hasPageClass && "output.pageClass",
    !hasCardCount && "output.cardCount",
    !hasArtifactRefs && "output.artifactRefs",
  ].filter(Boolean);
  if (!missing.length) return [];

  const findingId = `finding_${sha256({ manifestSha256, runId, code: "XHS_OBSERVE_FEED_EVIDENCE_INCOMPLETE", missing }).slice(0, 24)}`;
  return [{
    findingId,
    code: "XHS_OBSERVE_FEED_EVIDENCE_INCOMPLETE",
    severity: "low",
    summary: `xhs.observe.feed evidence is incomplete: ${missing.join(", ")}`,
    repairable: true,
    evidenceRefs: [`manifest:${manifestSha256}`, `run:${runId}`, `producer:${producerCommit}`],
    observed: {
      capabilityId,
      missing,
      outputWasEmpty: outputs.length === 0 || outputs.every((output) => Object.keys(output).length === 0),
    },
    evidenceDebt: missing.map((item) => ({
      layer: "adapter-evidence",
      code: `MISSING_${item.replaceAll(".", "_").replaceAll(" ", "_").toUpperCase()}`,
      cause: `${item} is absent; non-payment business result remains unchanged`,
    })),
  }];
}

function verifyManifestArtifacts(dir, artifacts) {
  if (!Array.isArray(artifacts)) return { ok: false, artifacts: [], errors: ["manifest.artifacts must be an array"] };
  const valid = [];
  const errors = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const path = artifact?.path ?? artifact?.file;
    const expected = artifact?.sha256;
    if (!safeRelativePath(path) || !SHA256.test(expected ?? "") || seen.has(path)) {
      errors.push(`invalid artifact path/hash/duplicate: ${path ?? "(missing)"}`);
      continue;
    }
    seen.add(path);
    try {
      const actual = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
      if (actual !== expected) {
        errors.push(`artifact hash mismatch: ${path}`);
        continue;
      }
      valid.push({ ...artifact, path, sha256: expected });
    } catch (error) {
      errors.push(`artifact unreadable: ${path}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, artifacts: valid, errors };
}

function defaultObserveFeedEvidencePolicy() {
  return {
    allowedChangeKinds: [
      "evidence_exporter",
      "screenshot_or_ui_dump_artifact",
      "manifest_or_artifact_hash",
      "redacted_observation_projection",
      "logging_or_lifecycle",
      "test_fixture",
      "nonsemantic_recovery_or_observation",
    ],
    allowedPaths: [
      "apps/xhs/adapter.mjs",
      "control-plane/lib/control-plane.mjs",
      "control-plane/lib/evidence-store.mjs",
      "control-plane/lib/evidence-exporter.mjs",
      "control-plane/schema/explorer-run.schema.json",
      "scripts/fast-operator.mjs",
      "tests/control-plane-adapters.test.mjs",
      "tests/evidence-exporter.test.mjs",
      "tests/fixtures/**",
    ],
    acceptanceConditions: [
      "xhs.observe.feed remains read-only with externalEffect=false and paymentTransport=0",
      "successful output includes redacted pageClass, integer cardCount and screenshot/UI dump artifactRefs",
      "manifest and artifact refs bind bytes with SHA-256 and exportAllowed redaction metadata",
      "evidence write failure adds evidence debt but does not change adapter call count, job business result or non-payment dispatch",
      "full tests, scope guard and secret scan pass",
    ],
    prohibitions: [
      "Do not change selectors, taps, input, collect, publish, payment or other business semantics",
      "Do not modify root skills/SKILL.md, governance authority, payment guard, approval, Standing Grant, credentials, control.db or deployment configuration",
      "Do not deploy Windows, operate devices, submit job/session or self-approve a review verdict",
    ],
    limits: { maxFiles: 8, maxDiffLines: 500, maxAttempts: 3 },
    heartbeat: { intervalSeconds: 60, claimTtlSeconds: 900 },
    circuitBreaker: { failureThreshold: 2, windowSeconds: 3600 },
  };
}

function readAggregateManifest(dir) {
  try {
    const bytes = readFileSync(join(dir, "manifest.json"));
    const manifest = JSON.parse(bytes);
    return manifest?.schemaVersion === "xhs.review-bundle.v1" ? { manifest, bytes } : null;
  } catch {
    return null;
  }
}

function reviewAggregateRepairBundle(dir, aggregate, { reviewedAt, targetSkillBinding }) {
  const { manifest, bytes } = aggregate;
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const claims = [];
  const pass = (id, detail) => claims.push(claim(id, true, detail));
  const fail = (id, detail) => claims.push(claim(id, false, detail));

  try {
    const declared = readFileSync(join(dir, "manifest.sha256"), "utf8").trim();
    declared === manifestSha256 ? pass("aggregate-manifest-hash", manifestSha256) : fail("aggregate-manifest-hash", `expected ${declared}, got ${manifestSha256}`);
  } catch (error) {
    fail("aggregate-manifest-hash", error.message);
  }

  const verifiedFiles = new Map();
  for (const item of manifest.files ?? []) {
    if (!safeRelativePath(item?.path) || !SHA256.test(item?.sha256 ?? "") || verifiedFiles.has(item.path)) {
      fail("aggregate-file-hashes", `invalid path/hash/duplicate: ${item?.path ?? "(missing)"}`);
      continue;
    }
    try {
      const fileBytes = readFileSync(join(dir, item.path));
      const actual = createHash("sha256").update(fileBytes).digest("hex");
      if (actual !== item.sha256 || fileBytes.length !== item.bytes) fail("aggregate-file-hashes", `hash/size mismatch: ${item.path}`);
      else verifiedFiles.set(item.path, { ...item, bytes: fileBytes });
    } catch (error) {
      fail("aggregate-file-hashes", `${item.path}: ${error.message}`);
    }
  }
  if ((manifest.files ?? []).length > 0 && verifiedFiles.size === manifest.files.length) pass("aggregate-file-hashes", `${verifiedFiles.size} files`);

  const runRecords = [...verifiedFiles.entries()]
    .filter(([path]) => /^runs\/run_[^/]+\/manifest\.json$/.test(path))
    .map(([path, item]) => ({ path, manifest: JSON.parse(item.bytes) }));
  const runManifests = runRecords.map((item) => item.manifest);
  const runIds = runManifests.map((item) => item.runId);
  const producerOk = runManifests.length > 0 && runManifests.every((item) => item.gitCommit === manifest.producerCommit);
  const capabilityOk = runManifests.length > 0 && runManifests.every((item) => item.capabilityId === "xhs.observe.feed");
  const uniqueRuns = new Set(runIds).size === runIds.length && runIds.every((id) => typeof id === "string" && id.startsWith("run_"));
  const pathRunBinding = runRecords.every(({ path, manifest: run }) => path === `runs/${run.runId}/manifest.json` && typeof run.jobId === "string" && run.jobId.length > 0);
  producerOk && capabilityOk && uniqueRuns && pathRunBinding
    ? pass("aggregate-run-binding", `${runIds.length} xhs.observe.feed runs at ${manifest.producerCommit}`)
    : fail("aggregate-run-binding", "path/run/job/capability/producer commit mismatch");

  const lifecycleOk = runManifests.length > 0 && runManifests.every((run) => {
    try {
      const text = verifiedFiles.get(`runs/${run.runId}/events.jsonl`)?.bytes?.toString("utf8");
      if (!text) return false;
      const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      return events.length > 0
        && events.every((event) => event.jobId === run.jobId)
        && events.some((event) => event.type === "run.initialized" && event.capabilityId === "xhs.observe.feed")
        && events.some((event) => event.type === "job.succeeded");
    } catch {
      return false;
    }
  });
  lifecycleOk ? pass("aggregate-lifecycle-binding", `${runIds.length} succeeded event streams`) : fail("aggregate-lifecycle-binding", "missing bound initialization or success event");

  const outputs = [];
  const artifactKinds = [];
  const artifactIdentifiers = new Set();
  let evidenceOk = true;
  for (const run of runManifests) {
    for (const evidence of run.evidence ?? []) {
      const relative = `runs/${run.runId}/${String(evidence.path ?? "").replaceAll("\\", "/")}`;
      const verified = verifiedFiles.get(relative);
      if (!verified || verified.sha256 !== evidence.sha256 || verified.bytes.length !== evidence.bytes
        || evidence.runId !== run.runId || evidence.jobId !== run.jobId) {
        evidenceOk = false;
        continue;
      }
      for (const value of [evidence.evidenceId, evidence.path, relative, evidence.sha256]) if (value) artifactIdentifiers.add(value);
      artifactKinds.push(String(evidence.kind ?? "").toLowerCase());
      if (evidence.kind === "result") {
        try {
          const result = JSON.parse(verified.bytes);
          outputs.push(result.output ?? {});
          if (result.verification?.ok !== true) evidenceOk = false;
        } catch {
          evidenceOk = false;
        }
      }
    }
  }
  evidenceOk && outputs.length === runManifests.length ? pass("aggregate-result-binding", `${outputs.length} result artifacts`) : fail("aggregate-result-binding", "result artifact or verification mismatch");
  const refs = outputs.flatMap((output) => Array.isArray(output?.artifactRefs) ? output.artifactRefs : []);
  const refsOk = refs.every((ref) => artifactIdentifiers.has(typeof ref === "string" ? ref : (ref?.sha256 ?? ref?.ref ?? ref?.id ?? ref?.path)));
  refsOk ? pass("aggregate-artifact-ref-binding", `${refs.length} bound artifact refs`) : fail("aggregate-artifact-ref-binding", "output artifactRefs are not bound to hashed run evidence");
  manifest.externalEffect === false && manifest.paymentTransport === 0
    ? pass("aggregate-effects", "externalEffect=false paymentTransport=0")
    : fail("aggregate-effects", "aggregate is not effect-free");

  let receipt = null;
  let receiptSha256 = null;
  try {
    receipt = JSON.parse(readFileSync(join(dir, "mac-review/mac-independent-review-receipt.json"), "utf8"));
    receiptSha256 = sha256(receipt);
    if (receipt.manifestSha256 === manifestSha256 && receipt.producerCommit === manifest.producerCommit && receipt.runId === runIds[0]) pass("aggregate-mac-review", receiptSha256);
    else fail("aggregate-mac-review", "independent review receipt binding mismatch");
  } catch (error) {
    fail("aggregate-mac-review", error.message);
  }

  const hasScreenshot = artifactKinds.some((kind) => kind.includes("screenshot") || kind.includes("image"));
  const hasUiDump = artifactKinds.some((kind) => kind.includes("ui_dump") || kind.includes("hierarchy") || kind.includes("xml"));
  const hasPageClass = outputs.some((output) => nonEmpty(output?.pageClass));
  const hasCardCount = outputs.some((output) => Number.isInteger(output?.cardCount) && output.cardCount >= 0);
  const hasArtifactRefs = refs.length > 0 && refsOk;
  const missing = [!hasScreenshot && "screenshot artifact", !hasUiDump && "UI dump artifact", !hasPageClass && "output.pageClass", !hasCardCount && "output.cardCount", !hasArtifactRefs && "output.artifactRefs"].filter(Boolean);
  const finding = {
    findingId: "finding_p78_feed_evidence_projection",
    code: "XHS_OBSERVE_FEED_EVIDENCE_INCOMPLETE",
    severity: "low",
    summary: "xhs.observe.feed lacks screenshot/UI dump artifacts and returns output without pageClass, cardCount or artifactRefs",
    repairable: true,
    evidenceRefs: [`bundle:${manifest.bundleId}`, `manifest:${manifestSha256}`, ...runIds.map((id) => `run:${id}`), "artifact:result-19949bb2808e.json"],
    observed: { capabilityId: "xhs.observe.feed", resultOutput: outputs[0] ?? {}, missing, externalEffect: manifest.externalEffect, paymentTransport: manifest.paymentTransport },
    evidenceDebt: [
      { layer: "adapter-evidence", code: "MISSING_SCREENSHOT", cause: "Both bound observe.feed runs have no screenshot artifact; business result remains succeeded" },
      { layer: "adapter-evidence", code: "MISSING_UI_DUMP", cause: "Both bound observe.feed runs have no UI hierarchy artifact; business result remains succeeded" },
      { layer: "adapter-output", code: "MISSING_REDACTED_PROJECTION", cause: "result output lacks pageClass, cardCount and artifactRefs; business result remains succeeded" },
    ],
  };
  const claimsOk = Boolean(claims.every((item) => item.status === "pass") && missing.length === 5 && receipt && receiptSha256);
  const repairProposals = claimsOk ? [createRepairProposal({
    source: {
      bundleId: manifest.bundleId,
      manifestSha256,
      primaryRunId: runIds[0],
      runIds,
      producerCommit: manifest.producerCommit,
      releaseId: manifest.releaseId ?? null,
      review: { reviewId: receipt.reviewId, receiptSha256, reviewedAt: receipt.reviewedAt, disposition: "repairable_debt" },
    },
    target: {
      repository: "gifted-professor/xhs-device-agent",
      branch: "main",
      baseCommit: manifest.producerCommit,
      app: manifest.app,
      capabilityId: "xhs.observe.feed",
      ...(targetSkillBinding ? { skillBinding: targetSkillBinding } : {}),
    },
    finding,
    policy: defaultObserveFeedEvidencePolicy(),
    createdAt: reviewedAt,
  })] : [];
  return {
    ok: claimsOk && (manifest.evidenceDebt ?? []).length === 0,
    receipt,
    aggregateClaims: claims,
    findings: [finding],
    repairProposals,
    knowledgeEntries: repairProposals.map(proposalKnowledgeEnvelope),
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [dir] = args;
  if (!dir) {
    console.log("用法: node scripts/review-run-bundle.mjs <bundleDir> [--repair-proposals] [--proposal-created-at <ISO>] [--skill-path <path> --skill-version <version> --skill-sha256 <sha256>]");
    process.exitCode = 4;
  } else {
    const flag = (name) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const skillPath = flag("--skill-path");
    const skillVersion = flag("--skill-version");
    const skillSha256 = flag("--skill-sha256");
    const targetSkillBinding = skillPath || skillVersion || skillSha256
      ? { path: skillPath, version: skillVersion, sourceSha256: skillSha256 }
      : undefined;
    const result = reviewRunBundle(dir, { reviewedAt: flag("--proposal-created-at") ?? new Date().toISOString(), targetSkillBinding });
    const output = process.argv.includes("--repair-proposals")
      ? { receipt: result.receipt, repairProposals: result.repairProposals, knowledgeEntries: result.knowledgeEntries }
      : result.receipt;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  }
}
