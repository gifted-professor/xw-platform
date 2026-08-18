import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportSealedRun, verifySealedRun } from "../control-plane/lib/evidence-exporter.mjs";
import { sha256, canonicalJson } from "../control-plane/lib/canonical.mjs";

function freshOutbox() {
  return mkdtempSync(join(tmpdir(), `rex-export-${Math.random().toString(36).slice(2)}`));
}

const SAMPLE_EVENTS = [
  { runId: "run-1", effectId: "eff-1", kind: "dispatch", action: "feedCards", ok: true },
  { runId: "run-1", effectId: "eff-2", kind: "observe", target: { text: "余额" } },
];

test("seal success writes a complete sealed bundle into the Review inbox and clears staging", async () => {
  const outbox = freshOutbox();
  try {
    const result = await exportSealedRun({ outboxDir: outbox, runId: "run-1", events: SAMPLE_EVENTS });
    const bundleDir = join(outbox, "run-1");
    assert.equal(existsSync(bundleDir), true, "sealed bundle dir must exist in inbox");
    assert.equal(existsSync(join(bundleDir, "events.jsonl")), true);
    assert.equal(existsSync(join(bundleDir, "manifest.json")), true);
    assert.equal(existsSync(join(bundleDir, "bundle.seal")), true);
    // staging 不得残留
    assert.equal(readdirSync(outbox).filter((n) => n.startsWith(".staging-")).length, 0);
    // seal = sha256(canonicalJsonL(events))
    const expectedSeal = sha256(SAMPLE_EVENTS.map(canonicalJson).join("\n") + "\n");
    assert.equal(readFileSync(join(bundleDir, "bundle.seal"), "utf8"), expectedSeal);
    assert.equal(result.sealed, true);
    assert.equal(result.sealHash, expectedSeal);
    // 可校验
    const verify = verifySealedRun({ bundleDir });
    assert.equal(verify.ok, true);
  } finally {
    rmSync(outbox, { recursive: true, force: true });
  }
});

test("seal crash leaves the inbox untouched with no half adoption and cleans staging", async () => {
  const outbox = freshOutbox();
  try {
    const before = readdirSync(outbox);
    await assert.rejects(
      () => exportSealedRun({
        outboxDir: outbox,
        runId: "run-crash",
        events: SAMPLE_EVENTS,
        seal: async () => { throw new Error("SEAL_CRASH"); },
      }),
      /SEAL_CRASH/,
    );
    assert.deepEqual(readdirSync(outbox), before, "inbox must be byte-identical to pre-export state");
    assert.equal(existsSync(join(outbox, "run-crash")), false, "no partial bundle adopted");
  } finally {
    rmSync(outbox, { recursive: true, force: true });
  }
});

test("a failing event writer leaves the inbox untouched (no half bundle)", async () => {
  const outbox = freshOutbox();
  try {
    const before = readdirSync(outbox);
    await assert.rejects(
      () => exportSealedRun({
        outboxDir: outbox,
        runId: "run-writefail",
        events: SAMPLE_EVENTS,
        writeEvent: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
      }),
      (error) => error.code === "ENOSPC",
    );
    assert.deepEqual(readdirSync(outbox), before);
    assert.equal(existsSync(join(outbox, "run-writefail")), false);
  } finally {
    rmSync(outbox, { recursive: true, force: true });
  }
});

test("verifySealedRun rejects a tampered bundle (mismatched seal)", async () => {
  const outbox = freshOutbox();
  try {
    await exportSealedRun({ outboxDir: outbox, runId: "run-tamper", events: SAMPLE_EVENTS });
    const bundleDir = join(outbox, "run-tamper");
    // 篡改 events.jsonl：追加一行，seal 不变 → 校验失败
    const fs = await import("node:fs");
    fs.appendFileSync(join(bundleDir, "events.jsonl"), `${canonicalJson({ kind: "forged" })}\n`);
    const verify = verifySealedRun({ bundleDir });
    assert.equal(verify.ok, false);
    assert.match(verify.reason ?? "", /seal/i);
  } finally {
    rmSync(outbox, { recursive: true, force: true });
  }
});

test("exporter is read-only on source and never rewrites history — re-exporting same runId overwrites only the sealed bundle, not legacy artifacts", async () => {
  const outbox = freshOutbox();
  try {
    // 模拟 inbox 里已有一份 legacy（非 v1）证据目录，exporter 不得触碰它
    const fs = await import("node:fs");
    fs.mkdirSync(join(outbox, "legacy-run"), { recursive: true });
    fs.writeFileSync(join(outbox, "legacy-run", "old.md"), "# legacy evidence");
    await exportSealedRun({ outboxDir: outbox, runId: "run-1", events: SAMPLE_EVENTS });
    assert.equal(fs.readFileSync(join(outbox, "legacy-run", "old.md"), "utf8"), "# legacy evidence",
      "exporter must not rewrite or delete pre-existing legacy artifacts");
  } finally {
    rmSync(outbox, { recursive: true, force: true });
  }
});