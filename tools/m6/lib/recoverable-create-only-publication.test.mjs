import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectRecoverableCreateOnlyPublication,
  publishRecoverableCreateOnly,
  recoverablePublicationPendingPath,
  RECOVERABLE_PUBLICATION_CUTS,
} from "./recoverable-create-only-publication.mjs";

const BYTES = Buffer.from('{"schemaId":"xw.test.recoverable-publication.v1","value":"exact"}\n', "utf8");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m6-recoverable-publish-"));
  const targetPath = join(root, "final.json");
  const pendingPath = recoverablePublicationPendingPath(targetPath, BYTES);
  return {
    root,
    targetPath,
    pendingPath,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("every publication cut recovers without a partial final path", async (t) => {
  for (const cut of RECOVERABLE_PUBLICATION_CUTS) {
    await t.test(cut, () => {
      const f = fixture();
      const crash = Object.assign(new Error(`crash:${cut}`), { code: `TEST_${cut}` });
      try {
        assert.throws(() => publishRecoverableCreateOnly({
          targetPath: f.targetPath,
          bytes: BYTES,
          faultAfter(point) {
            if (point === cut) throw crash;
          },
        }), { code: crash.code });
        if (["PENDING_CREATED", "PENDING_MID_WRITE", "PENDING_WRITTEN", "PENDING_FSYNCED"].includes(cut)) {
          assert.equal(existsSync(f.targetPath), false, "pending failure must never expose a final path");
          assert.equal(existsSync(f.pendingPath), true);
        }
        if (cut === "FINAL_PUBLISHED") {
          assert.equal(lstatSync(f.targetPath, { bigint: true }).nlink, 2n);
          assert.equal(lstatSync(f.pendingPath, { bigint: true }).nlink, 2n);
        }
        const recovered = publishRecoverableCreateOnly({ targetPath: f.targetPath, bytes: BYTES });
        assert.equal(readFileSync(f.targetPath).equals(BYTES), true);
        assert.equal(lstatSync(f.targetPath, { bigint: true }).nlink, 1n);
        assert.equal(existsSync(f.pendingPath), false);
        assert.equal(recovered.status, cut === "FINAL_PUBLISHED" || cut === "PENDING_UNLINKED" || cut === "DIRECTORY_FSYNCED"
          ? "REPLAYED" : "CREATED");
        if (["PENDING_WRITTEN", "PENDING_FSYNCED"].includes(cut)) {
          assert.deepEqual(recovered.recovered, ["EXACT_PENDING_REFLUSHED"]);
        }
      } finally { f.cleanup(); }
    });
  }
});

test("partial pending left by an ENOSPC-shaped mid-write failure is replaced and published", () => {
  const f = fixture();
  try {
    assert.throws(() => publishRecoverableCreateOnly({
      targetPath: f.targetPath,
      bytes: BYTES,
      faultAfter(point) {
        if (point === "PENDING_MID_WRITE") {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
      },
    }), { code: "ENOSPC" });
    assert.equal(existsSync(f.targetPath), false);
    assert.ok(readFileSync(f.pendingPath).length > 0);
    assert.ok(readFileSync(f.pendingPath).length < BYTES.length);
    const recovered = publishRecoverableCreateOnly({ targetPath: f.targetPath, bytes: BYTES });
    assert.equal(recovered.status, "CREATED");
    assert.deepEqual(recovered.recovered, ["PARTIAL_PENDING"]);
    assert.equal(readFileSync(f.targetPath).equals(BYTES), true);
  } finally { f.cleanup(); }
});

test("pure inspection recognizes exact pending and paired nlink=2 without mutation", () => {
  const pendingOnly = fixture();
  try {
    assert.throws(() => publishRecoverableCreateOnly({
      targetPath: pendingOnly.targetPath,
      bytes: BYTES,
      faultAfter(point) {
        if (point === "PENDING_FSYNCED") throw Object.assign(new Error("crash"), { code: "TEST_CRASH" });
      },
    }), { code: "TEST_CRASH" });
    assert.deepEqual(inspectRecoverableCreateOnlyPublication({
      targetPath: pendingOnly.targetPath,
      bytes: BYTES,
    }), {
      exactFinal: false,
      finalLinkCount: 0,
      needsRecovery: true,
      pending: "EXACT",
      recoverable: true,
      pendingPath: pendingOnly.pendingPath,
      targetPath: pendingOnly.targetPath,
    });
  } finally { pendingOnly.cleanup(); }

  const paired = fixture();
  try {
    assert.throws(() => publishRecoverableCreateOnly({
      targetPath: paired.targetPath,
      bytes: BYTES,
      faultAfter(point) {
        if (point === "FINAL_PUBLISHED") throw Object.assign(new Error("crash"), { code: "TEST_CRASH" });
      },
    }), { code: "TEST_CRASH" });
    const inspected = inspectRecoverableCreateOnlyPublication({ targetPath: paired.targetPath, bytes: BYTES });
    assert.equal(inspected.exactFinal, true);
    assert.equal(inspected.finalLinkCount, 2);
    assert.equal(inspected.needsRecovery, true);
    assert.equal(inspected.pending, "EXACT");
    assert.equal(lstatSync(paired.targetPath, { bigint: true }).nlink, 2n, "inspection must be pure read");
  } finally { paired.cleanup(); }
});

test("different final, external hard links, and symlink final fail closed", (t) => {
  const different = fixture();
  try {
    writeFileSync(different.targetPath, "different\n", "utf8");
    assert.throws(
      () => publishRecoverableCreateOnly({ targetPath: different.targetPath, bytes: BYTES }),
      { reason: "TARGET_DIFFERENT" },
    );
  } finally { different.cleanup(); }

  const hardlink = fixture();
  try {
    const source = join(hardlink.root, "external.json");
    writeFileSync(source, BYTES);
    linkSync(source, hardlink.targetPath);
    assert.throws(
      () => publishRecoverableCreateOnly({ targetPath: hardlink.targetPath, bytes: BYTES }),
      { reason: "TARGET_EXTERNAL_HARDLINK" },
    );
  } finally { hardlink.cleanup(); }

  const linkedPending = fixture();
  try {
    writeFileSync(linkedPending.pendingPath, BYTES);
    linkSync(linkedPending.pendingPath, join(linkedPending.root, "external-pending-link"));
    assert.throws(
      () => publishRecoverableCreateOnly({ targetPath: linkedPending.targetPath, bytes: BYTES }),
      { reason: "PENDING_EXTERNAL_HARDLINK" },
    );
  } finally { linkedPending.cleanup(); }

  const symlink = fixture();
  try {
    const source = join(symlink.root, "symlink-source.json");
    writeFileSync(source, BYTES);
    try { symlinkSync(source, symlink.targetPath, "file"); } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.diagnostic("Windows symlink privilege unavailable");
        return;
      }
      throw error;
    }
    assert.throws(
      () => publishRecoverableCreateOnly({ targetPath: symlink.targetPath, bytes: BYTES }),
      { reason: "TARGET_UNSAFE" },
    );
  } finally { symlink.cleanup(); }
});
