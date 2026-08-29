import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { sha256 } from "../../services/control-plane/control-plane/lib/canonical.mjs";
import {
  assembleM64QualificationBootstrapPackageFile,
  createM64QualificationSigningDraftFile,
  packageM64QualificationBootstrapFixed,
  parseM64QualificationPackageFixedArgs,
  main,
  signM64QualificationDraftWithProtectedLocalIssuer,
} from "./m6-4-qualification-bootstrap-signing.mjs";

const FIXED_NOW = Date.parse("2030-01-01T00:00:03.000Z");
const FIXED_RELEASE = "xw-fixed-qualification-test";
const FIXED_SOURCE = "b".repeat(40);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function fixture({ mismatch = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "m64-qualification-signing-")));
  const runtimeRoot = join(root, "runtime");
  const keyId = "issuer-01";
  const subject = "human:operator-01";
  const expected = generateKeyPairSync("ed25519");
  const installed = mismatch ? generateKeyPairSync("ed25519") : expected;
  const allowlistPath = writeJson(join(runtimeRoot, "m6-gate", "issuer-keys.json"), {
    schemaId: "xw.m6-gate-issuer-allowlist.v1",
    version: 7,
    keys: [{
      keyId,
      subject,
      publicKey: expected.publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
    }],
  });
  const keyPath = join(runtimeRoot, "secrets", "operator-keys", `${keyId}.pkcs8.pem`);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, installed.privateKey.export({ type: "pkcs8", format: "pem" }));
  const now = Date.now();
  const inputPath = writeJson(join(root, "handoff", "draft-input.json"), {
    actor: subject,
    closedIssuedAt: new Date(now - 2_000).toISOString(),
    closeoutCommittedAt: new Date(now - 3_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    gateId: "qualification-signing-test-gate",
    issuerAllowlistSha256: sha256(readFileSync(allowlistPath)),
    locksRecord: {
      schemaId: "xw.m6-locks.v1",
      releaseId: "qualification-signing-test-release",
      sourceCommit: "a".repeat(40),
      lockHashes: {
        groundingRuntime: "1".repeat(64),
        hardRedlinePolicy: "2".repeat(64),
        runtimeProfile: "3".repeat(64),
      },
    },
    promotedAt: new Date(now - 1_000).toISOString(),
    releaseId: "qualification-signing-test-release",
    rootIssuedAt: new Date(now - 4_000).toISOString(),
    sourceCommit: "a".repeat(40),
  });
  return {
    root,
    runtimeRoot,
    keyId,
    keyPath,
    inputPath,
    draftPath: join(root, "handoff", "draft.json"),
    rootProofPath: join(root, "handoff", "root-proof.json"),
    closedProofPath: join(root, "handoff", "closed-proof.json"),
    packagePath: join(root, "handoff", "package.json"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function acceptingAcl(calls) {
  return Object.freeze({
    verify(plan) {
      calls.push(plan);
      return Object.freeze({ ok: true });
    },
  });
}

function fixedFixture() {
  const f = fixture();
  const releaseRoot = join(f.runtimeRoot, "releases", FIXED_RELEASE);
  writeJson(join(releaseRoot, "release-manifest.v1.json"), {
    schemaId: "xw.release-manifest.test.v1",
    releaseId: FIXED_RELEASE,
    sourceCommit: FIXED_SOURCE,
  });
  const lockBytes = {
    runtimeProfile: Buffer.from('{"runtime":"fixed"}\n', "utf8"),
    hardRedlinePolicy: Buffer.from('{"redline":"fixed"}\n', "utf8"),
    groundingRuntime: Buffer.from('{"tcb":"fixed"}\n', "utf8"),
  };
  const lockPaths = {
    runtimeProfile: join(releaseRoot, "packages", "kernel", "contracts", "runtime-profile.v1.json"),
    hardRedlinePolicy: join(releaseRoot, "integrations", "dsh-xw", "config", "hard-redline-policy.v1.json"),
    groundingRuntime: join(releaseRoot, "artifacts", "m6-4", "tcb-manifests", "xw.m6-grounded-run.tcb.v1.json"),
  };
  for (const [kind, path] of Object.entries(lockPaths)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lockBytes[kind]);
  }
  return { ...f, releaseRoot, lockBytes, lockPaths };
}

test("protected local signer uses the fixed allowlisted key and returns only proof hashes/refs", () => {
  const f = fixture();
  const aclCalls = [];
  try {
    const draft = createM64QualificationSigningDraftFile({
      inputPath: f.inputPath,
      outputPath: f.draftPath,
    });
    const signed = signM64QualificationDraftWithProtectedLocalIssuer({
      draftPath: f.draftPath,
      runtimeRoot: f.runtimeRoot,
      keyId: f.keyId,
      rootProofPath: f.rootProofPath,
      closedProofPath: f.closedProofPath,
    }, { aclController: acceptingAcl(aclCalls) });
    assert.equal(aclCalls.length, 1);
    assert.equal(aclCalls[0].targetPath, f.keyPath);
    assert.equal(aclCalls[0].boundaryPath, join(f.runtimeRoot, "secrets"));
    assert.equal(signed.proofs.length, 2);
    assert.doesNotMatch(JSON.stringify(signed), /signature|PRIVATE KEY/u);
    const assembled = assembleM64QualificationBootstrapPackageFile({
      draftPath: f.draftPath,
      runtimeRoot: f.runtimeRoot,
      rootProofPath: f.rootProofPath,
      closedProofPath: f.closedProofPath,
      outputPath: f.packagePath,
    });
    assert.equal(assembled.draftHash, draft.draftHash);
    assert.equal(existsSync(assembled.packagePath), true);
    assert.doesNotMatch(JSON.stringify(assembled), /signature|PRIVATE KEY/u);
  } finally {
    f.cleanup();
  }
});

test("protected local signer rejects ACL failure and allowlist/private-key mismatch before proof publication", () => {
  const aclFailure = fixture();
  try {
    createM64QualificationSigningDraftFile({
      inputPath: aclFailure.inputPath,
      outputPath: aclFailure.draftPath,
    });
    let signerCalls = 0;
    assert.throws(() => signM64QualificationDraftWithProtectedLocalIssuer({
      draftPath: aclFailure.draftPath,
      runtimeRoot: aclFailure.runtimeRoot,
      keyId: aclFailure.keyId,
      rootProofPath: aclFailure.rootProofPath,
      closedProofPath: aclFailure.closedProofPath,
    }, {
      aclController: { verify() { throw Object.assign(new Error("bad ACL"), { code: "ACL_BAD" }); } },
      protectedSigner() { signerCalls += 1; },
    }), { code: "ACL_BAD" });
    assert.equal(signerCalls, 0);
    assert.equal(existsSync(aclFailure.rootProofPath), false);
  } finally {
    aclFailure.cleanup();
  }

  const mismatch = fixture({ mismatch: true });
  try {
    createM64QualificationSigningDraftFile({
      inputPath: mismatch.inputPath,
      outputPath: mismatch.draftPath,
    });
    assert.throws(() => signM64QualificationDraftWithProtectedLocalIssuer({
      draftPath: mismatch.draftPath,
      runtimeRoot: mismatch.runtimeRoot,
      keyId: mismatch.keyId,
      rootProofPath: mismatch.rootProofPath,
      closedProofPath: mismatch.closedProofPath,
    }, { aclController: acceptingAcl([]) }), {
      code: "M64_QUALIFICATION_SIGNING_PRIVATE_KEY_MISMATCH",
    });
    assert.equal(existsSync(mismatch.rootProofPath), false);
  } finally {
    mismatch.cleanup();
  }
});

test("package-fixed derives the formal release, exact locks, active issuer, 48h chain, and content-addressed ref", () => {
  const f = fixedFixture();
  const aclCalls = [];
  try {
    const first = packageM64QualificationBootstrapFixed({
      releaseId: FIXED_RELEASE,
      sourceCommit: FIXED_SOURCE,
    }, {
      runtimeRoot: f.runtimeRoot,
      now: () => FIXED_NOW,
      verifyManifest: () => ({ ok: true, mismatches: [] }),
      aclController: acceptingAcl(aclCalls),
      verifyTcbProvisionReceipt: () => ({
        releaseId: FIXED_RELEASE,
        sourceCommit: FIXED_SOURCE,
        receiptHash: "9".repeat(64),
      }),
    });
    assert.deepEqual(Object.keys(first).sort(), [
      "ok", "packageHash", "packageRef", "replay", "schemaId",
    ]);
    assert.equal(first.replay, false);
    assert.equal(
      first.packageRef,
      join(
        f.runtimeRoot,
        "m6-audit",
        `m6-c1-qualification-bootstrap-${FIXED_SOURCE.slice(0, 7)}`,
        "packages",
        `${first.packageHash}.package.json`,
      ),
    );
    const record = JSON.parse(readFileSync(first.packageRef, "utf8"));
    assert.equal(record.packageHash, first.packageHash);
    assert.equal(record.gateId, `m6-4-gate-f-${FIXED_SOURCE.slice(0, 7)}`);
    assert.equal(record.releaseId, FIXED_RELEASE);
    assert.equal(record.sourceCommit, FIXED_SOURCE);
    assert.equal(Date.parse(record.promotedAt), FIXED_NOW);
    assert.equal(
      Date.parse(record.rootEpochRecord.expiresAt) - Date.parse(record.rootEpochRecord.issuedAt),
      48 * 60 * 60 * 1_000,
    );
    assert.deepEqual(record.locksRecord.lockHashes, {
      groundingRuntime: sha256(f.lockBytes.groundingRuntime),
      hardRedlinePolicy: sha256(f.lockBytes.hardRedlinePolicy),
      runtimeProfile: sha256(f.lockBytes.runtimeProfile),
    });
    assert.equal(aclCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(first), /signature|PRIVATE KEY/u);

    const replay = packageM64QualificationBootstrapFixed({
      releaseId: FIXED_RELEASE,
      sourceCommit: FIXED_SOURCE,
    }, {
      runtimeRoot: f.runtimeRoot,
      now: () => FIXED_NOW,
      verifyManifest: () => ({ ok: true, mismatches: [] }),
      aclController: acceptingAcl([]),
      verifyTcbProvisionReceipt: () => ({
        releaseId: FIXED_RELEASE,
        sourceCommit: FIXED_SOURCE,
        receiptHash: "9".repeat(64),
      }),
    });
    assert.equal(replay.packageHash, first.packageHash);
    assert.equal(replay.packageRef, first.packageRef);
    assert.equal(replay.replay, true);
  } finally {
    f.cleanup();
  }
});

test("package-fixed fails closed before signing when the current TCB receipt is absent", () => {
  const f = fixedFixture();
  let signerCalled = false;
  try {
    assert.throws(() => packageM64QualificationBootstrapFixed({
      releaseId: FIXED_RELEASE,
      sourceCommit: FIXED_SOURCE,
    }, {
      runtimeRoot: f.runtimeRoot,
      now: () => FIXED_NOW,
      verifyManifest: () => ({ ok: true, mismatches: [] }),
      aclController: acceptingAcl([]),
      protectedSigner() {
        signerCalled = true;
        throw new Error("signer must remain unreachable");
      },
      verifyTcbProvisionReceipt: () => null,
    }), { code: "M64_QUALIFICATION_TCB_RECEIPT_INVALID" });
    assert.equal(signerCalled, false);
  } finally {
    f.cleanup();
  }
});

test("package-fixed CLI grammar rejects every caller path/input/key/token/PID selector", () => {
  assert.deepEqual(
    parseM64QualificationPackageFixedArgs(["package-fixed", FIXED_RELEASE, FIXED_SOURCE]),
    { releaseId: FIXED_RELEASE, sourceCommit: FIXED_SOURCE },
  );
  for (const argv of [
    ["package-fixed", FIXED_RELEASE, FIXED_SOURCE, "--runtime-root=C:\\tmp"],
    ["package-fixed", FIXED_RELEASE, FIXED_SOURCE, "C:\\caller\\input.json"],
    ["package-fixed", FIXED_RELEASE, "--input"],
    ["draft", "--input", "C:\\caller\\input.json"],
    ["package-fixed", FIXED_RELEASE, FIXED_SOURCE, "1234"],
  ]) {
    assert.throws(() => parseM64QualificationPackageFixedArgs(argv), {
      code: "M64_QUALIFICATION_SIGNING_ARGUMENT_INVALID",
    });
  }
});

test("signing CLI has no caller-supplied private-key path and tampered draft domains fail closed", async () => {
  const f = fixture();
  try {
    createM64QualificationSigningDraftFile({
      inputPath: f.inputPath,
      outputPath: f.draftPath,
    });
    const draft = JSON.parse(readFileSync(f.draftPath, "utf8"));
    draft.signingRequests[0].payloadHex = "f".repeat(64);
    writeJson(join(f.root, "handoff", "tampered-draft.json"), draft);
    assert.throws(() => signM64QualificationDraftWithProtectedLocalIssuer({
      draftPath: join(f.root, "handoff", "tampered-draft.json"),
      runtimeRoot: f.runtimeRoot,
      keyId: f.keyId,
      rootProofPath: f.rootProofPath,
      closedProofPath: f.closedProofPath,
    }, { aclController: acceptingAcl([]) }), {
      code: "M64_QUALIFICATION_DRAFT_INVALID",
    });

    let stderr = "";
    const exitCode = await main([
      "sign-local-protected",
      "--draft", f.draftPath,
      "--runtime-root", f.runtimeRoot,
      "--issuer", f.keyId,
      "--root-proof", f.rootProofPath,
      "--closed-proof", f.closedProofPath,
      "--key-file", f.keyPath,
    ], {
      stdout: { write() {} },
      stderr: { write(value) { stderr += value; } },
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /M64_QUALIFICATION_SIGNING_ARGUMENT_INVALID/u);
    assert.doesNotMatch(stderr, /BEGIN PRIVATE KEY/u);
  } finally {
    f.cleanup();
  }
});
