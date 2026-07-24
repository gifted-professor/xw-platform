import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const device = state.upsertDevice({
      alias: "01",
      physicalLabel: "rack-01",
      nodeId: "DESKTOP-3I1EVHE",
      runtimeId: "private-runtime",
    });
    const created = state.createJob({
      idempotencyKey: "evidence",
      actorId: "agent-a",
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
    const content = readFileSync(join(root, "runs", created.runId, record.path), "utf8");
    assert.doesNotMatch(content, /private-runtime|private-token|private-serial/);
    assert.deepEqual(redactRuntimeData({ ok: true, apiKey: "x" }), { ok: true });
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
