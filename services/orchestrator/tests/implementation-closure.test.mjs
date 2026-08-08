import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildImplementationClosureDocument,
  computeImplementationClosureFromFiles,
  computeImplementationClosureHash,
  toPosixRepoPath,
} from "../scripts/lib/implementation-closure.mjs";
import {
  createTcbManifest,
  validateTcbManifest,
  verifyTcbManifestAgainstRoot,
} from "../scripts/lib/tcb-manifest.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "impl-closure-reg-"));
  mkdirSync(join(root, "apps", "xianyu"), { recursive: true });
  writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "export const adapter = 1;\n", "utf8");
  writeFileSync(join(root, "apps", "xianyu", "helper.mjs"), "export const helper = 2;\n", "utf8");
  return root;
}

test("RI-01: closure hash stable across separators and order", () => {
  const root = fixtureRoot();
  try {
    const a = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs", "apps/xianyu/helper.mjs"],
    });
    const b = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: [join(root, "apps", "xianyu", "helper.mjs"), join(root, "apps", "xianyu", "adapter.mjs")],
    });
    const winStyle = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps\\xianyu\\adapter.mjs", "apps\\xianyu\\helper.mjs"],
    });
    assert.equal(a.implementationClosureHash, b.implementationClosureHash);
    assert.equal(a.implementationClosureHash, winStyle.implementationClosureHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RI-01: one-byte change and missing path fail-closed", () => {
  const root = fixtureRoot();
  try {
    const before = computeImplementationClosureFromFiles({ rootDir: root, paths: ["apps/xianyu/adapter.mjs"] });
    writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "export const adapter = 1;\nX", "utf8");
    const after = computeImplementationClosureFromFiles({ rootDir: root, paths: ["apps/xianyu/adapter.mjs"] });
    assert.notEqual(before.implementationClosureHash, after.implementationClosureHash);
    assert.throws(
      () => computeImplementationClosureFromFiles({ rootDir: root, paths: ["apps/xianyu/missing.mjs"] }),
      { code: "IMPLEMENTATION_CLOSURE_MISSING" },
    );
    assert.throws(
      () => toPosixRepoPath(root, join(root, "..", "outside.mjs")),
      { code: "IMPLEMENTATION_CLOSURE_PATH_ESCAPE" },
    );
    assert.throws(() => buildImplementationClosureDocument([]), { code: "IMPLEMENTATION_CLOSURE_EMPTY" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TCB manifest verify + drift", () => {
  const root = fixtureRoot();
  try {
    const manifest = createTcbManifest({
      manifestId: "tcb.fixture.xianyu",
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs", "apps/xianyu/helper.mjs"],
      capabilityIds: ["xianyu.publish.full_dry_run"],
    });
    assert.equal(validateTcbManifest(manifest).ok, true);
    assert.equal(verifyTcbManifestAgainstRoot(manifest, root).implementationClosureHash, manifest.implementationClosureHash);
    writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "tampered\n", "utf8");
    assert.throws(() => verifyTcbManifestAgainstRoot(manifest, root), { code: "IMPLEMENTATION_CONTRACT_CHANGED" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("document hash is order-independent for object keys", () => {
  const doc = buildImplementationClosureDocument([
    { path: "b.mjs", sha256: "b".repeat(64) },
    { path: "a.mjs", sha256: "a".repeat(64) },
  ]);
  assert.deepEqual(doc.entries.map((e) => e.path), ["a.mjs", "b.mjs"]);
  assert.equal(
    computeImplementationClosureHash(doc),
    computeImplementationClosureHash({ algorithm: doc.algorithm, schemaId: doc.schemaId, entries: doc.entries }),
  );
});
