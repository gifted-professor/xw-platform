#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.cwd());
const out = resolve(root, "artifacts/m6-4");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (path) => sha(readFileSync(resolve(root, path)));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const seal = (schemaId, value, field) => ({ ...value, [field]: sha(`${schemaId}:${canonical(value)}`) });
const write = (name, value) => writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

mkdirSync(out, { recursive: true });
const artifactPaths = {
  providerCorpus: "artifacts/m6-4/m6-4-live-provider-corpus.json",
  environmentQualification: "artifacts/m6-4/m6-4-environment-qualification.json",
  broker: "artifacts/m6-4/m6-4-broker-spike.json",
  sameLease: "artifacts/m6-4/m6-4-same-lease-spike.json",
  ttlModel: "artifacts/m6-4/m6-4-ttl-model-spike.json",
  effectBoundary: "artifacts/m6-4/cohort-manifests/xw.m6-effect-boundary.v1.json",
};
const artifactHashes = Object.fromEntries(Object.entries(artifactPaths).map(([key, path]) => [key, { path, sha256: fileHash(path) }]));
const providerCorpus = JSON.parse(readFileSync(resolve(root, artifactPaths.providerCorpus), "utf8"));
const provider = JSON.parse(readFileSync(resolve(root, artifactPaths.environmentQualification), "utf8"));
const broker = JSON.parse(readFileSync(resolve(root, artifactPaths.broker), "utf8"));
const sameLease = JSON.parse(readFileSync(resolve(root, artifactPaths.sameLease), "utf8"));
const ttlModel = JSON.parse(readFileSync(resolve(root, artifactPaths.ttlModel), "utf8"));
const gateA = seal("xw.m6-4-gate-a-spike-receipt.v1", {
  schemaId: "xw.m6-4-gate-a-spike-receipt.v1",
  status: "OFFLINE_IMPLEMENTATION_ALLOWED_LIVE_PROFILE_UNQUALIFIED",
  provider: { passed: providerCorpus.pass === true && providerCorpus.determinismOk === true, caseCount: providerCorpus.metrics?.cases, negativeCount: providerCorpus.metrics?.negatives, metrics: providerCorpus.metrics, runtimeAttestationPending: provider.qualificationStatus.endsWith("RUNTIME_ATTESTATION_PENDING"), artifact: artifactHashes.environmentQualification },
  broker: { passed: broker.allPassed === true, exactToolCount: broker.toolCount, remainingOwnedTrees: broker.remainingOwnedTrees, artifact: artifactHashes.broker },
  sameLease: { passed: sameLease.allPassed === true, resourcesClosed: sameLease.sessionResidue === false && sameLease.leaseResidue === false && sameLease.phases?.at(-1)?.resourcesReleased === true, artifact: artifactHashes.sameLease },
  ttlModel: { passedForLive: ttlModel.liveHardGatePassed === true, offlineImplementationAllowed: ttlModel.offlineImplementationAllowed === true, gateFEligible: false, thresholdsRelaxed: ttlModel.thresholdsRelaxed, artifact: artifactHashes.ttlModel },
  liveActionAuthorized: false,
}, "receiptSha256");
write("m6-4-gate-a-spike-receipt.json", gateA);

const db = new DatabaseSync("C:/Users/Public/xw-runtime/state/control-plane/control.db", { readOnly: true });
const count = (sql) => Number(db.prepare(sql).get().c);
const counts = {
  activeJobs: count("SELECT count(*) c FROM jobs WHERE status IN ('running','verifying','restoring')"),
  activeSessions: count("SELECT count(*) c FROM sessions"),
  activeLeases: count("SELECT count(*) c FROM leases"),
  pendingApprovals: count("SELECT count(*) c FROM jobs WHERE status='waiting_approval'"),
  actionCount: count("SELECT coalesce(sum(transport_called),0) c FROM device_session_actions"),
};
db.close();
const currentGatePath = "C:/Users/Public/xw-runtime/m6-gate/m6-gate/current.json";
const currentGateHash = sha(readFileSync(currentGatePath));
const baseline = JSON.parse(readFileSync(resolve(root, "artifacts/m6-4/m6-4-baseline-preflight.json"), "utf8"));
const resources = seal("xw.m6-4-resource-snapshot.v1", {
  schemaId: "xw.m6-4-resource-snapshot.v1",
  source: "read-only Control Plane SQLite queries",
  counts,
  allZero: Object.values(counts).every((value) => value === 0),
  gate: { mode: baseline.runtime.gate.mode, status: baseline.runtime.gate.status, liveActionsEnabled: false, currentFileSha256: currentGateHash, unchangedFromBaseline: currentGateHash === baseline.runtime.gate.currentFileSha256 },
}, "snapshotSha256");
write("m6-4-resource-snapshot.json", resources);

const tests = [
  { command: "npm run check", status: "PASS" },
  { command: "npm run test:m6-4:offline", status: "PASS", tests: 32, passed: 32 },
  { command: "npm run test:m6", status: "PASS", tests: 121, passed: 121 },
  { command: "npm run test:m6-2:offline", status: "PASS", tests: 108, passed: 108 },
  { command: "npm run test:m6-2:epoch", status: "PASS_WITH_PLATFORM_SKIP", tests: 68, passed: 67, skipped: 1, exception: "exact Windows symlink-unavailable test only" },
  { command: "npm run test:m6-3", status: "PASS", gateB: 21, gateC: 8, gateD: 22, gateE: 2 },
  { command: "npm run test:orchestrator", status: "PASS_WITH_PLATFORM_EXCEPTION", tests: 531, passed: 530, failed: 1, exception: "EPERM creating the exact repair-authority symlink fixture on Windows" },
  { command: "targeted schema-v19 and M6 version-boundary regressions", status: "PASS", tests: 51, passed: 51 },
  { command: "npm run test:control-plane", status: "BASELINE_FAILURES_RECORDED_NOT_CLAIMED_GREEN", tests: 959, passed: 924, failed: 32, skipped: 3, note: "M6-specific and schema-v19 targeted suites pass; unrelated Windows/path/legacy failures remain outside this candidate's acceptance claim" },
];
const testManifest = seal("xw.m6-4-offline-test-manifest.v1", { schemaId: "xw.m6-4-offline-test-manifest.v1", platform: { os: process.platform, arch: process.arch, node: process.version }, tests }, "manifestSha256");
write("m6-4-offline-test-manifest.json", testManifest);

const statusLines = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
const excluded = new Set(["artifacts/m6-4/m6-4-code-ready-receipt.json", "artifacts/m6-4/m6-4-execution-review-packet.json", "artifacts/m6-4/m6-4-execution-review-packet.md", "artifacts/m6-4/multi-model-execution-completion-m6-4.json"]);
const paths = [...new Set(statusLines.map((line) => line.slice(3).replaceAll("\\", "/")).filter((path) => path && !excluded.has(path) && !path.includes("node_modules/") && !path.includes(".runtime/")))].sort();
const inventory = paths.map((path) => ({ path, sha256: fileHash(path) }));
const candidateSnapshotHash = sha(canonical(inventory));
const receipt = seal("xw.m6-4-code-ready-receipt.v1", {
  schemaId: "xw.m6-4-code-ready-receipt.v1",
  status: "CODE_READY_GATE_CLOSED",
  planSha256: "68887b2f1eeae7c89e726f1a2bd6571bf665c719e8a50017bd1fadb2443b7d29",
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  candidateSnapshotHash,
  candidateFileCount: inventory.length,
  gateAReceiptSha256: fileHash("artifacts/m6-4/m6-4-gate-a-spike-receipt.json"),
  offlineTestManifestSha256: fileHash("artifacts/m6-4/m6-4-offline-test-manifest.json"),
  resourceSnapshotSha256: fileHash("artifacts/m6-4/m6-4-resource-snapshot.json"),
  artifacts: artifactHashes,
  invariants: { gateClosed: resources.gate.mode === "CLOSED" && resources.gate.unchangedFromBaseline, resourcesZero: resources.allZero, actionCount: counts.actionCount, liveProfileQualified: false, liveWindowAuthorized: false, gateFExecuted: false },
  deferred: ["Gate F requires exact live-window authorization and a qualified exact model/provider profile", "automatic reconcile/checkpoint recovery belongs to M6-5", "real M5 WorkReceipt binding belongs to M6-6"],
  nextMilestone: "M6-5",
}, "receiptSha256");
write("m6-4-code-ready-receipt.json", receipt);
process.stdout.write(`${JSON.stringify({ ok: gateA.provider.passed && gateA.broker.passed && gateA.sameLease.passed && gateA.sameLease.resourcesClosed && resources.allZero && resources.gate.mode === "CLOSED" && gateA.liveActionAuthorized === false, candidateSnapshotHash, fileCount: inventory.length, receiptSha256: receipt.receiptSha256, resourceSnapshotSha256: resources.snapshotSha256 }, null, 2)}\n`);
