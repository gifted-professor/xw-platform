import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
} from "../control-plane/lib/implementation-closure.mjs";
import {
  M6_GROUNDED_RUN_CAPABILITY_ID,
  M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS,
  M6_GROUNDED_RUN_TCB_MANIFEST_ID,
  M6_GROUNDED_RUN_TCB_MANIFEST_PATH,
  verifyM6GroundedRunCapabilitySeal,
} from "../control-plane/lib/m6-grounded-run-capability-seal.mjs";
import { createTcbManifest } from "../control-plane/lib/tcb-manifest.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const appsRoot = fileURLToPath(new URL("../apps", import.meta.url));
const productionManifestPath = join(repositoryRoot, ...M6_GROUNDED_RUN_TCB_MANIFEST_PATH.split("/"));

function groundedCapability() {
  return CapabilityRegistry.load(appsRoot).require(M6_GROUNDED_RUN_CAPABILITY_ID);
}

function copyClosure(root) {
  for (const relativePath of M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS) {
    const target = join(root, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repositoryRoot, ...relativePath.split("/")), target);
  }
  const targetManifest = join(root, ...M6_GROUNDED_RUN_TCB_MANIFEST_PATH.split("/"));
  mkdirSync(dirname(targetManifest), { recursive: true });
  const manifest = createTcbManifest({
    manifestId: M6_GROUNDED_RUN_TCB_MANIFEST_ID,
    rootDir: root,
    paths: M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS,
    capabilityIds: [M6_GROUNDED_RUN_CAPABILITY_ID],
    contentHashProfile: M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  });
  writeFileSync(targetManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath: targetManifest };
}

function capabilityBoundTo(manifest) {
  const capability = structuredClone(groundedCapability());
  capability.implementation.implementationClosureHash = manifest.implementationClosureHash;
  return capability;
}

test("grounded-run capability reproduces its checked-in production TCB closure", () => {
  const capability = groundedCapability();
  const manifest = JSON.parse(readFileSync(productionManifestPath, "utf8"));
  const verified = verifyM6GroundedRunCapabilitySeal({ capability });
  assert.equal(verified.capabilityId, M6_GROUNDED_RUN_CAPABILITY_ID);
  assert.equal(verified.tcbManifestRef, M6_GROUNDED_RUN_TCB_MANIFEST_ID);
  assert.equal(
    verified.contentHashProfile,
    M6_GROUNDED_RUN_CAPABILITY_SELF_BINDING_CONTENT_HASH_PROFILE,
  );
  assert.equal(verified.implementationClosureHash, capability.implementation.implementationClosureHash);
  assert.equal(verified.pathCount, M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS.length);
  assert.equal(manifest.implementationClosureHash, capability.implementation.implementationClosureHash);
  assert.deepEqual(manifest.capabilityIds, [M6_GROUNDED_RUN_CAPABILITY_ID]);
  assert.deepEqual(manifest.paths, M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS);
  assert.match(capability.capabilityContractHash, /^[a-f0-9]{64}$/u);
});

test("one-byte closure drift fails closed before production callback construction", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "m6-grounded-tcb-drift-"));
  try {
    const { manifest, manifestPath } = copyClosure(tempRoot);
    const capability = capabilityBoundTo(manifest);
    assert.doesNotThrow(() => verifyM6GroundedRunCapabilitySeal({ capability, rootDir: tempRoot, manifestPath }));
    const mutated = M6_GROUNDED_RUN_IMPLEMENTATION_CLOSURE_PATHS.find((path) => path.endsWith("m6-grounded-tcb.mjs"));
    appendFileSync(join(tempRoot, ...mutated.split("/")), "\n// one-byte-equivalent authority drift\n", "utf8");
    assert.throws(
      () => verifyM6GroundedRunCapabilitySeal({ capability, rootDir: tempRoot, manifestPath }),
      { code: "IMPLEMENTATION_CONTRACT_CHANGED" },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("capability hash/ref and manifest path-set substitutions fail closed", () => {
  const capability = groundedCapability();
  const reboundHash = structuredClone(capability);
  reboundHash.implementation.implementationClosureHash = "0".repeat(64);
  assert.throws(
    () => verifyM6GroundedRunCapabilitySeal({ capability: reboundHash }),
    { code: "M6_GROUNDED_RUN_CAPABILITY_SEAL_MISMATCH" },
  );

  const reboundRef = structuredClone(capability);
  reboundRef.implementation.tcbManifestRef = "xw.m6-grounded-run.tcb.unreviewed";
  assert.throws(
    () => verifyM6GroundedRunCapabilitySeal({ capability: reboundRef }),
    { code: "M6_GROUNDED_RUN_CAPABILITY_SEAL_INVALID" },
  );

  const tempRoot = mkdtempSync(join(tmpdir(), "m6-grounded-tcb-paths-"));
  try {
    const { manifest: generatedManifest, manifestPath } = copyClosure(tempRoot);
    const generatedCapability = capabilityBoundTo(generatedManifest);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.paths = manifest.paths.slice(1);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.throws(
      () => verifyM6GroundedRunCapabilitySeal({ capability: generatedCapability, rootDir: tempRoot, manifestPath }),
      { code: "M6_GROUNDED_RUN_TCB_PATHS_MISMATCH" },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("grounded-run seal rejects a manifest without the exact self-binding profile", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "m6-grounded-tcb-profile-"));
  try {
    const { manifest, manifestPath } = copyClosure(tempRoot);
    const capability = capabilityBoundTo(manifest);
    const unprofiled = structuredClone(manifest);
    delete unprofiled.contentHashProfile;
    delete unprofiled.closure.contentHashProfile;
    writeFileSync(manifestPath, `${JSON.stringify(unprofiled, null, 2)}\n`, "utf8");
    assert.throws(
      () => verifyM6GroundedRunCapabilitySeal({ capability, rootDir: tempRoot, manifestPath }),
      { code: "M6_GROUNDED_RUN_TCB_IDENTITY_MISMATCH" },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
