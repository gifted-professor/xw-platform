import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  M6_GROUNDED_RUN_CAPABILITIES_PATH,
  M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
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

function writeGroundedRunCapabilities(root, {
  closureHash = "a".repeat(64),
  matchCount = 1,
  includeClosureHash = true,
  risk = "R1",
} = {}) {
  const target = (index) => ({
    id: "xiaowei.m6.grounded_run",
    risk,
    implementation: {
      adapter: "xiaowei",
      action: "m6_grounded_run",
      ...(includeClosureHash ? { implementationClosureHash: closureHash } : {}),
      tcbManifestRef: "xw.m6-grounded-run.tcb.v1",
      fixtureIndex: index,
    },
  });
  const document = {
    schemaVersion: 1,
    capabilities: [
      { id: "xiaowei.device.list", implementation: { adapter: "xiaowei", action: "list" } },
      ...Array.from({ length: matchCount }, (_, index) => target(index)),
    ],
  };
  const path = join(root, ...M6_GROUNDED_RUN_CAPABILITIES_PATH.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function computeSelfBindingClosure(root) {
  return computeImplementationClosureFromFiles({
    rootDir: root,
    paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH],
    contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  });
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

test("M6 self-binding profile zeroes only the grounded-run closure hash before canonical JSON hashing", () => {
  const root = fixtureRoot();
  try {
    writeGroundedRunCapabilities(root, { closureHash: "a".repeat(64) });
    const before = computeSelfBindingClosure(root);
    const genericBefore = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH],
    });

    writeGroundedRunCapabilities(root, { closureHash: "b".repeat(64) });
    const rebound = computeSelfBindingClosure(root);
    const genericRebound = computeImplementationClosureFromFiles({
      rootDir: root,
      paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH],
    });

    assert.equal(before.implementationClosureHash, rebound.implementationClosureHash);
    assert.equal(before.document.entries[0].sha256, rebound.document.entries[0].sha256);
    assert.notEqual(genericBefore.implementationClosureHash, genericRebound.implementationClosureHash);
    assert.equal(
      before.document.contentHashProfile,
      M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
    );

    writeGroundedRunCapabilities(root, { closureHash: "b".repeat(64), risk: "R2" });
    const semanticDrift = computeSelfBindingClosure(root);
    assert.notEqual(before.implementationClosureHash, semanticDrift.implementationClosureHash);
    assert.notEqual(before.document.entries[0].sha256, semanticDrift.document.entries[0].sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M6 self-binding profile normalizes UTF-8 text EOL while generic hashing stays EOL-sensitive", () => {
  const root = fixtureRoot();
  const runtimePath = "src/runtime.mjs";
  const runtimeFile = join(root, ...runtimePath.split("/"));
  const profiled = () => computeImplementationClosureFromFiles({
    rootDir: root,
    paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH, runtimePath],
    contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  });
  const generic = () => computeImplementationClosureFromFiles({
    rootDir: root,
    paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH, runtimePath],
  });
  try {
    writeGroundedRunCapabilities(root);
    mkdirSync(dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, "export const value = 1;\nexport default value;\n", "utf8");
    const profileLf = profiled();
    const genericLf = generic();

    writeFileSync(runtimeFile, "export const value = 1;\r\nexport default value;\r\n", "utf8");
    const profileCrlf = profiled();
    const genericCrlf = generic();
    assert.equal(profileLf.implementationClosureHash, profileCrlf.implementationClosureHash);
    assert.notEqual(genericLf.implementationClosureHash, genericCrlf.implementationClosureHash);

    writeFileSync(runtimeFile, "export const value = 1;\rexport default value;\r", "utf8");
    const profileLoneCr = profiled();
    assert.equal(profileLf.implementationClosureHash, profileLoneCr.implementationClosureHash);

    writeFileSync(runtimeFile, "export const value = 2;\r\nexport default value;\r\n", "utf8");
    assert.notEqual(profileLf.implementationClosureHash, profiled().implementationClosureHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M6 self-binding profile is part of the closure hash", () => {
  const entries = [{ path: M6_GROUNDED_RUN_CAPABILITIES_PATH, sha256: "a".repeat(64) }];
  const generic = buildImplementationClosureDocument(entries);
  const profiled = buildImplementationClosureDocument(entries, {
    contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  });
  assert.notEqual(computeImplementationClosureHash(generic), computeImplementationClosureHash(profiled));
});

test("control-plane and orchestrator schema twins expose the same optional exact content hash profile", () => {
  const schemas = [
    new URL("../control-plane/schema/implementation-closure.v1.schema.json", import.meta.url),
    new URL("../control-plane/schema/tcb.manifest.v1.schema.json", import.meta.url),
    new URL("../../orchestrator/contracts/implementation-closure.v1.schema.json", import.meta.url),
    new URL("../../orchestrator/contracts/tcb.manifest.v1.schema.json", import.meta.url),
  ].map((url) => JSON.parse(readFileSync(url, "utf8")));

  for (const schema of schemas) {
    assert.deepEqual(schema.properties.contentHashProfile, {
      const: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
    });
    assert.equal(schema.required.includes("contentHashProfile"), false);
  }
});

test("M6 self-binding profile rejects missing, duplicate, bad-hash, and unknown targets", () => {
  const root = fixtureRoot();
  try {
    assert.throws(
      () => computeImplementationClosureFromFiles({
        rootDir: root,
        paths: ["apps/xianyu/adapter.mjs"],
        contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
      }),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_PATH_MISSING" },
    );

    writeGroundedRunCapabilities(root, { matchCount: 0 });
    assert.throws(
      () => computeSelfBindingClosure(root),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_INVALID" },
    );

    writeGroundedRunCapabilities(root, { matchCount: 2 });
    assert.throws(
      () => computeSelfBindingClosure(root),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_INVALID" },
    );

    writeGroundedRunCapabilities(root, { includeClosureHash: false });
    assert.throws(
      () => computeSelfBindingClosure(root),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_HASH_INVALID" },
    );

    writeGroundedRunCapabilities(root, { closureHash: "g".repeat(64) });
    assert.throws(
      () => computeSelfBindingClosure(root),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TARGET_HASH_INVALID" },
    );

    writeGroundedRunCapabilities(root);
    const binaryPath = join(root, "binary.dat");
    writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0x00]));
    assert.throws(
      () => computeImplementationClosureFromFiles({
        rootDir: root,
        paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH, "binary.dat"],
        contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
      }),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_TEXT_INVALID" },
    );

    assert.throws(
      () => computeImplementationClosureFromFiles({
        rootDir: root,
        paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH],
        contentHashProfile: "xhs.unknown-content-hash-profile.v1",
      }),
      { code: "IMPLEMENTATION_CLOSURE_CONTENT_HASH_PROFILE_UNKNOWN" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TCB manifest carries the profile and rejects manifest/embedded-closure mismatch", () => {
  const root = fixtureRoot();
  try {
    writeGroundedRunCapabilities(root);
    const manifest = createTcbManifest({
      manifestId: "tcb.fixture.m6-grounded-run",
      rootDir: root,
      paths: [M6_GROUNDED_RUN_CAPABILITIES_PATH],
      capabilityIds: ["xiaowei.m6.grounded_run"],
      contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
    });
    assert.equal(manifest.contentHashProfile, M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE);
    assert.equal(manifest.closure.contentHashProfile, manifest.contentHashProfile);
    assert.doesNotThrow(() => verifyTcbManifestAgainstRoot(manifest, root));

    const mismatch = structuredClone(manifest);
    delete mismatch.closure.contentHashProfile;
    assert.equal(validateTcbManifest(mismatch).ok, false);
    assert.throws(
      () => verifyTcbManifestAgainstRoot(mismatch, root),
      { code: "TCB_MANIFEST_INVALID" },
    );

    const unknown = structuredClone(manifest);
    unknown.contentHashProfile = "xhs.unknown-content-hash-profile.v1";
    unknown.closure.contentHashProfile = unknown.contentHashProfile;
    assert.equal(validateTcbManifest(unknown).ok, false);
    assert.throws(
      () => verifyTcbManifestAgainstRoot(unknown, root),
      { code: "TCB_MANIFEST_INVALID" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

