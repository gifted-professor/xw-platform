import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeRecoveryVisualAnalysis } from "../control-plane/lib/recovery-inspection.mjs";
import { buildRecoveryAnalysis } from "../scripts/build-recovery-analysis.mjs";

test("builds a path-free hash-bound visual analysis envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-analysis-"));
  try {
    const imagePath = join(root, "screen.png");
    writeFileSync(imagePath, Buffer.from("png-bytes"));
    const envelope = buildRecoveryAnalysis({
      imagePath,
      elementsDocument: {
        resolution: [1080, 2400],
        timings: { hot_path_s: 1.2 },
        elements: [{ id: "home", label: "闲鱼", bounds: [0, 2140, 220, 2320], conf: 0.9, source: "ocr" }],
      },
    });
    assert.equal(envelope.schemaVersion, "xhs.visual-elements.v1");
    assert.match(envelope.image.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(envelope), /recovery-analysis-|screen\.png/);

    const normalized = normalizeRecoveryVisualAnalysis(envelope, {
      expectedImageSha256: envelope.image.sha256,
      focus: { package: "com.taobao.idlefish", activity: "MainActivity" },
    });
    assert.equal(normalized.image.sha256, envelope.image.sha256);
    assert.equal(normalized.elements[0].center[1], 2230);
    assert.equal(normalized.pageClassification.safeStateVerified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects elements outside the audited screenshot resolution", () => {
  assert.throws(() => normalizeRecoveryVisualAnalysis({
    schemaVersion: "xhs.visual-elements.v1",
    image: { sha256: "a".repeat(64), resolution: [1080, 2400] },
    analyzer: { name: "test", version: "1" },
    elements: [{ label: "bad", bounds: [0, 0, 2000, 3000] }],
  }, {
    expectedImageSha256: "a".repeat(64),
  }), { code: "RECOVERY_ANALYSIS_SCHEMA_INVALID" });
});
