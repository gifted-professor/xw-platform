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
} from "../control-plane/lib/implementation-closure.mjs";
import {
  createTcbManifest,
  validateTcbManifest,
  verifyTcbManifestAgainstRoot,
} from "../control-plane/lib/tcb-manifest.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "impl-closure-"));
  mkdirSync(join(root, "apps", "xianyu"), { recursive: true });
  writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "export const adapter = 1;\n", "utf8");
  writeFileSync(join(root, "apps", "xianyu", "helper.mjs"), "export const helper = 2;\n", "utf8");
  return root;
}

test("RI-01: closure hash is stable across path separator and absolute root forms", () => {
  const root = fixtureRoot();
  try {
    const a = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs", "apps/xianyu/helper.mjs"],
    });
    const b = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: [
        join(root, "apps", "xianyu", "helper.mjs"),
        join(root, "apps", "xianyu", "adapter.mjs"),
      ],
    });
    const winStyle = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps\\xianyu\\adapter.mjs", "apps\\xianyu\\helper.mjs"],
    });
    assert.equal(a.implementationClosureHash, b.implementationClosureHash);
    assert.equal(a.implementationClosureHash, winStyle.implementationClosureHash);
    assert.equal(a.document.entries[0].path, "apps/xianyu/adapter.mjs");
    assert.equal(a.document.entries[1].path, "apps/xianyu/helper.mjs");
    assert.match(a.implementationClosureHash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RI-01: one-byte file change changes closure hash", () => {
  const root = fixtureRoot();
  try {
    const before = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs"],
    });
    writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "export const adapter = 1;\nX", "utf8");
    const after = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs"],
    });
    assert.notEqual(before.implementationClosureHash, after.implementationClosureHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RI-01: missing or escaping paths fail closed", () => {
  const root = fixtureRoot();
  try {
    assert.throws(
      () => computeImplementationClosureFromFiles({ rootDir: root, paths: ["apps/xianyu/missing.mjs"] }),
      { code: "IMPLEMENTATION_CLOSURE_MISSING" },
    );
    assert.throws(
      () => toPosixRepoPath(root, join(root, "..", "outside.mjs")),
      { code: "IMPLEMENTATION_CLOSURE_PATH_ESCAPE" },
    );
    assert.throws(
      () => buildImplementationClosureDocument([]),
      { code: "IMPLEMENTATION_CLOSURE_EMPTY" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical document hash ignores object key insertion order via canonicalize", () => {
  const doc = buildImplementationClosureDocument([
    { path: "b.mjs", sha256: "b".repeat(64) },
    { path: "a.mjs", sha256: "a".repeat(64) },
  ]);
  assert.deepEqual(doc.entries.map((e) => e.path), ["a.mjs", "b.mjs"]);
  const hash = computeImplementationClosureHash(doc);
  assert.equal(hash, computeImplementationClosureHash({
    algorithm: doc.algorithm,
    schemaId: doc.schemaId,
    entries: doc.entries,
  }));
});

test("TCB manifest validates and verifies against root; drift fails IMPLEMENTATION_CONTRACT_CHANGED", () => {
  const root = fixtureRoot();
  try {
    const manifest = createTcbManifest({
      manifestId: "tcb.fixture.xianyu",
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs", "apps/xianyu/helper.mjs"],
      capabilityIds: ["xianyu.publish.full_dry_run"],
    });
    assert.equal(validateTcbManifest(manifest).ok, true);
    const verified = verifyTcbManifestAgainstRoot(manifest, root);
    assert.equal(verified.implementationClosureHash, manifest.implementationClosureHash);

    writeFileSync(join(root, "apps", "xianyu", "adapter.mjs"), "tampered\n", "utf8");
    assert.throws(
      () => verifyTcbManifestAgainstRoot(manifest, root),
      { code: "IMPLEMENTATION_CONTRACT_CHANGED" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TCB manifest rejects absolute/Windows paths and ../ segments; allows v1..0.mjs style names", () => {
  const badAbs = validateTcbManifest({
    schemaId: "xhs.tcb.manifest.v1",
    schemaVersion: 1,
    manifestId: "bad",
    implementationClosureHash: "a".repeat(64),
    paths: ["C:\\Users\\Public\\xhs-routing-v1-1\\apps\\xianyu\\adapter.mjs"],
  });
  assert.equal(badAbs.ok, false);

  const badDotDot = validateTcbManifest({
    schemaId: "xhs.tcb.manifest.v1",
    schemaVersion: 1,
    manifestId: "bad",
    implementationClosureHash: "a".repeat(64),
    paths: ["apps/../secret.mjs"],
  });
  assert.equal(badDotDot.ok, false);

  const okDotsInName = validateTcbManifest({
    schemaId: "xhs.tcb.manifest.v1",
    schemaVersion: 1,
    manifestId: "ok",
    implementationClosureHash: "a".repeat(64),
    paths: ["apps/xianyu/v1..0.mjs"],
  });
  assert.equal(okDotsInName.ok, true);

  const doc = buildImplementationClosureDocument([
    { path: "apps/xianyu/v1..0.mjs", sha256: "a".repeat(64) },
  ]);
  assert.equal(doc.entries[0].path, "apps/xianyu/v1..0.mjs");
});

/** Golden vector shared with registry twin — must stay byte-identical across repos. */
const GOLDEN_CLOSURE_HASH = "14b9231325de0d86433a871bf19a659fb2b6a2a15051d82e03adc9b1eb30fad6";

test("RI-01 cross-repo golden: same fixture bytes yield pinned closure hash", () => {
  const root = fixtureRoot();
  try {
    const { implementationClosureHash, document } = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: ["apps/xianyu/adapter.mjs", "apps/xianyu/helper.mjs"],
    });
    assert.equal(implementationClosureHash, GOLDEN_CLOSURE_HASH);
    assert.equal(document.entries[0].sha256, "4c2488e1d089991c07dcfb1398e4746e7cf669ed008e8726866675f1a6bec9b8");
    assert.equal(document.entries[1].sha256, "979613b99cf4a596c5481e22bace9d140ef67e2e6b9fe1e7d989ca0f456837a1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

