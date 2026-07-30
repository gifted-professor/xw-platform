import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { EvidenceStore, redactRuntimeData } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

test("runtime evidence uses real hashes and removes credentials and runtime IDs", () => {
  const root = mkdtempSync(join(tempBase, "evidence-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const capabilities = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
    state.syncCapabilities(capabilities);
    state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
    const device = state.upsertDevice({
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: "private-runtime",
      routingProfile: { enabled: true, capabilityIds: ["xhs.observe.metrics"] },
    });
    const created = state.createJob({
      idempotencyKey: "evidence",
      actorId: "agent-a",
      authorityNodeId: "DESKTOP-3I1EVHE",
      deviceId: device.deviceId,
      capability: capabilities.require("xhs.observe.metrics"),
      params: {},
    }).job;
    const evidence = new EvidenceStore({
      runsRoot: join(root, "runs"),
      state,
      minFreeBytes: 0,
      minExternalEffectFreeBytes: 0,
    });
    evidence.initializeRun({ job: created, device });
    const record = evidence.writeJson({
      job: created,
      kind: "result",
      label: "audit",
      value: {
        ok: true,
        runtimeId: "private-runtime",
        token: "private-token",
        nested: { serial: "private-serial", status: "verified" },
      },
    });
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const manifest = evidence.getManifest(created.runId);
    assert.equal(manifest.evidence[0].sha256, record.sha256);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.routeDecision.selectedDeviceId, device.deviceId);
    assert.equal(manifest.storage.manifestPath, join(root, "runs", created.runId, "manifest.json"));
    const events = readFileSync(manifest.storage.eventsPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "route.assigned");
    const content = readFileSync(join(root, "runs", created.runId, record.path), "utf8");
    assert.doesNotMatch(content, /private-runtime|private-token|private-serial/);
    assert.deepEqual(redactRuntimeData({ ok: true, apiKey: "x" }), { ok: true });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("EvidenceStore resolves an exact evidence id and hash without exposing its path", () => {
  const root = mkdtempSync(join(tempBase, "discovery-evidence-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
    assert.throws(() => evidence.findByIdAndHash("evidence-missing", "a".repeat(64)), { code: "EVIDENCE_NOT_FOUND" });
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("EvidenceStore fails closed on missing, escaped, or tampered private evidence files", () => {
  const root = mkdtempSync(join(tempBase, "discovery-evidence-integrity-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
    const runId = "run-private";
    const relativePath = join("evidence", "receipt.json");
    const absolutePath = join(root, "runs", runId, relativePath);
    mkdirSync(join(root, "runs", runId, "evidence"), { recursive: true });
    writeFileSync(absolutePath, "trusted\n");
    const hash = createHash("sha256").update("trusted\n").digest("hex");
    const record = state.recordEvidence({ jobId: null, runId, kind: "discovery_receipt", path: relativePath, sha256: hash, bytes: 8 });
    assert.equal(evidence.findByIdAndHash(record.evidenceId, hash).evidenceId, record.evidenceId);
    writeFileSync(absolutePath, "tampered\n");
    assert.throws(() => evidence.findByIdAndHash(record.evidenceId, hash), { code: "EVIDENCE_HASH_MISMATCH" });
    unlinkSync(absolutePath);
    assert.throws(() => evidence.findByIdAndHash(record.evidenceId, hash), { code: "EVIDENCE_FILE_MISSING" });
    const escaped = state.recordEvidence({ jobId: null, runId, kind: "discovery_receipt", path: "../outside.json", sha256: hash, bytes: 8 });
    assert.throws(() => evidence.findByIdAndHash(escaped.evidenceId, hash), { code: "EVIDENCE_PATH_INVALID" });
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
