import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../control-plane/lib/canonical.mjs";
import {
  ECorpusPassError,
  XHS_E_CORPUS_PASS_SEAL_KIND,
  createECorpusPassStore,
  createStoreBackedECorpusInterlock,
} from "../control-plane/lib/xhs-e-corpus-pass.mjs";
import { validateJsonSchema } from "../control-plane/lib/json-schema-validator.mjs";

const schemaPath = fileURLToPath(new URL("../control-plane/schema/xhs-e-corpus-pass.v1.schema.json", import.meta.url));
const orchestratorSchemaPath = fileURLToPath(new URL("../../orchestrator/contracts/xhs-e-corpus-pass.v1.schema.json", import.meta.url));

function fakeKeyring() {
  const keys = new Map([
    ["ka-1", Buffer.alloc(32, 0x11)],
    ["ka-2", Buffer.alloc(32, 0x22)],
  ]);
  let active = "ka-1";
  const digest = ({ keyId, kind, value }) => createHmac("sha256", keys.get(keyId))
    .update(`xhs-explore-v1:${keyId}:${kind}:${value}`, "utf8")
    .digest("hex");
  return {
    activeKeyId: () => active,
    sign({ kind, value }) {
      return { digestKeyId: active, digest: digest({ keyId: active, kind, value }) };
    },
    verify({ digestKeyId, kind, value, digest: actual }) {
      const expected = digest({ keyId: digestKeyId, kind, value });
      return { ok: expected === actual, keyStatus: digestKeyId === active ? "active" : "retained-readonly" };
    },
    rotate() { active = "ka-2"; },
  };
}

function owner() {
  return {
    taskName: "XW Platform Control Plane",
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
  };
}

function binding(overrides = {}) {
  return {
    releaseId: "xw-xhs-routine-v3-test",
    sourceCommit: "4".repeat(40),
    providerBundleDigest: "5".repeat(64),
    corpusManifestHash: "6".repeat(64),
    privateIndexDigest: "7".repeat(64),
    evaluatorSourceHash: "8".repeat(64),
    testReportHash: "9".repeat(64),
    digestKeyId: "ka-1",
    gateEpoch: "a".repeat(64),
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xhs-e-corpus-pass-"));
  let nowMs = 10_000;
  const keyring = fakeKeyring();
  const store = createECorpusPassStore({
    artifactRoot: root,
    canonicalArtifactRoot: root,
    owner: owner(),
    keyring,
    aclChecker: () => true,
    now: () => nowMs,
  });
  return {
    root,
    keyring,
    store,
    now(value) { nowMs = value; },
    seal() {
      return store.seal({ binding: binding(), expiresAtMs: 20_000, caller: owner() });
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ECorpusPassError && error.code === code, code);
}

test("canonical schema twins are byte-identical and a sealed artifact validates", () => {
  const cpBytes = readFileSync(schemaPath, "utf8");
  assert.equal(readFileSync(orchestratorSchemaPath, "utf8"), cpBytes, "CP/Registry schema copies must not drift");
  const f = fixture();
  try {
    const sealed = f.seal();
    const schema = JSON.parse(cpBytes);
    assert.deepEqual(validateJsonSchema(sealed.artifact, schema), []);
    const verified = f.store.verify({ ref: sealed.ref, expectedBinding: binding(), caller: owner() });
    assert.equal(verified.ok, true);
    assert.equal(verified.status, "PASS");
    assert.equal(verified.artifactHash, sealed.ref.artifactHash);
    assert.equal(verified.effectiveVisualPermitBudget, 1);
    assert.equal(readFileSync(sealed.path, "utf8"), canonicalJson(sealed.artifact));
  } finally {
    f.close();
  }
});

test("missing, non-PASS, forged, stale, key-drifted, copied-path and re-mint attempts fail closed", () => {
  const f = fixture();
  try {
    const missingRef = {
      schemaId: "xw.xhs.e-corpus-pass-ref.v1",
      artifactHash: "f".repeat(64),
      bindingHash: "e".repeat(64),
      gateEpoch: binding().gateEpoch,
      expiresAtMs: 20_000,
    };
    expectCode(
      () => f.store.verify({ ref: missingRef, expectedBinding: binding(), caller: owner() }),
      "ECORPUS_ARTIFACT_ABSENT",
    );

    const sealed = f.seal();
    expectCode(() => f.seal(), "ECORPUS_ARTIFACT_EXISTS");
    expectCode(
      () => f.store.verify({
        ref: sealed.ref,
        expectedBinding: binding(),
        caller: owner(),
        artifactPath: sealed.path,
      }),
      "ECORPUS_CALLER_FIELDS_FORBIDDEN",
    );

    const original = JSON.parse(readFileSync(sealed.path, "utf8"));
    writeFileSync(sealed.path, canonicalJson({ ...original, status: "FAIL" }));
    expectCode(
      () => f.store.verify({ ref: sealed.ref, expectedBinding: binding(), caller: owner() }),
      "ECORPUS_STATUS_NOT_PASS",
    );
    writeFileSync(sealed.path, canonicalJson({ ...original, seal: { ...original.seal, digest: "0".repeat(64) } }));
    expectCode(
      () => f.store.verify({ ref: sealed.ref, expectedBinding: binding(), caller: owner() }),
      "ECORPUS_SEAL_INVALID",
    );
    writeFileSync(sealed.path, canonicalJson(original));
    f.now(20_001);
    expectCode(
      () => f.store.verify({ ref: sealed.ref, expectedBinding: binding(), caller: owner() }),
      "ECORPUS_ARTIFACT_STALE",
    );
    f.now(10_000);
    f.keyring.rotate();
    expectCode(
      () => f.store.verify({ ref: sealed.ref, expectedBinding: binding(), caller: owner() }),
      "ECORPUS_KEY_MISMATCH",
    );
  } finally {
    f.close();
  }
});

test("task registry crash retry accepts only byte-exact existing artifact", () => {
  const f = fixture();
  try {
    const sealed = f.seal();
    const replayStore = createECorpusPassStore({
      artifactRoot: f.root,
      canonicalArtifactRoot: f.root,
      owner: owner(),
      keyring: f.keyring,
      aclChecker: () => true,
      now: () => 10_000,
      acceptExactExisting: true,
    });
    const replay = replayStore.seal({
      binding: binding(), expiresAtMs: 20_000, caller: owner(),
    });
    assert.deepEqual(replay.ref, sealed.ref);
    assert.equal(readFileSync(replay.path, "utf8"), canonicalJson(sealed.artifact));

    writeFileSync(replay.path, `${canonicalJson(sealed.artifact)}\n`);
    expectCode(
      () => replayStore.seal({ binding: binding(), expiresAtMs: 20_000, caller: owner() }),
      "ECORPUS_ARTIFACT_EXISTS",
    );
  } finally {
    f.close();
  }
});

test("release/provider/corpus/evaluator/private-index/report/key/replay and task caller bindings are exact", () => {
  const f = fixture();
  try {
    const sealed = f.seal();
    for (const [field, value, code] of [
      ["releaseId", "xw-other", "ECORPUS_RELEASE_MISMATCH"],
      ["sourceCommit", "b".repeat(40), "ECORPUS_SOURCE_MISMATCH"],
      ["providerBundleDigest", "b".repeat(64), "ECORPUS_PROVIDER_MISMATCH"],
      ["corpusManifestHash", "b".repeat(64), "ECORPUS_CORPUS_MISMATCH"],
      ["privateIndexDigest", "b".repeat(64), "ECORPUS_PRIVATE_INDEX_MISMATCH"],
      ["evaluatorSourceHash", "b".repeat(64), "ECORPUS_EVALUATOR_MISMATCH"],
      ["testReportHash", "b".repeat(64), "ECORPUS_TEST_REPORT_MISMATCH"],
      ["digestKeyId", "ka-2", "ECORPUS_KEY_MISMATCH"],
      ["gateEpoch", "b".repeat(64), "ECORPUS_REPLAY_REJECTED"],
    ]) {
      expectCode(
        () => f.store.verify({ ref: sealed.ref, expectedBinding: binding({ [field]: value }), caller: owner() }),
        code,
      );
    }
    expectCode(
      () => f.store.verify({
        ref: sealed.ref,
        expectedBinding: binding(),
        caller: { ...owner(), callerPathHash: "b".repeat(64) },
      }),
      "ECORPUS_CALLER_PATH_FORBIDDEN",
    );
    expectCode(
      () => f.store.verify({
        ref: sealed.ref,
        expectedBinding: binding(),
        caller: { ...owner(), taskBindingHash: "b".repeat(64) },
      }),
      "ECORPUS_TASK_OWNER_MISMATCH",
    );
    expectCode(
      () => createECorpusPassStore({
        artifactRoot: join(f.root, "caller-selected"),
        canonicalArtifactRoot: f.root,
        owner: owner(),
        keyring: f.keyring,
        aclChecker: () => true,
      }),
      "ECORPUS_CALLER_PATH_FORBIDDEN",
    );
  } finally {
    f.close();
  }
});

test("store-backed interlock pins runtime release/source/provider and reproduces exact PASS", () => {
  const f = fixture();
  try {
    const sealed = f.seal();
    const interlock = createStoreBackedECorpusInterlock({
      store: f.store,
      expectedBinding: binding(),
      taskCaller: owner(),
    });
    const result = interlock.verifyR3({
      ref: sealed.ref,
      releaseId: binding().releaseId,
      sourceCommit: binding().sourceCommit,
      providerBundleDigest: binding().providerBundleDigest,
    });
    assert.equal(result.ok, true);
    assert.equal(result.artifactHash, sealed.ref.artifactHash);
    for (const [patch, code] of [
      [{ releaseId: "wrong" }, "ECORPUS_RELEASE_MISMATCH"],
      [{ sourceCommit: "b".repeat(40) }, "ECORPUS_SOURCE_MISMATCH"],
      [{ providerBundleDigest: "b".repeat(64) }, "ECORPUS_PROVIDER_MISMATCH"],
    ]) {
      expectCode(() => interlock.verifyR3({
        ref: sealed.ref,
        releaseId: binding().releaseId,
        sourceCommit: binding().sourceCommit,
        providerBundleDigest: binding().providerBundleDigest,
        ...patch,
      }), code);
    }
    assert.equal(XHS_E_CORPUS_PASS_SEAL_KIND, "xhs-e-corpus-pass-artifact");
  } finally {
    f.close();
  }
});
