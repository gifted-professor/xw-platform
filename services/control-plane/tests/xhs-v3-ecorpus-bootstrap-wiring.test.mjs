import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createXhsV3TaskECorpusInterlockBridge } from
  "../control-plane/bootstrap.mjs";
import {
  createECorpusPassStore,
  createStoreBackedECorpusInterlock,
  XHS_E_CORPUS_PASS_SEAL_KIND,
} from "../control-plane/lib/xhs-e-corpus-pass.mjs";
import { createXhsV3TaskBootstrap } from
  "../../orchestrator/scripts/lib/xhs-v3-task-bootstrap.mjs";

const REF = Object.freeze({
  schemaId: "xw.xhs.e-corpus-pass-ref.v1",
  artifactHash: "1".repeat(64),
  bindingHash: "2".repeat(64),
  gateEpoch: "3".repeat(64),
  expiresAtMs: 3_610_000,
});

const VERIFY_REQUEST = Object.freeze({
  ref: REF,
  releaseId: "release-a",
  sourceCommit: "4".repeat(40),
  providerBundleDigest: "5".repeat(64),
});

function taskBootstrapFixture() {
  let interlockCalls = 0;
  let persisted = false;
  const registry = {
    async sealPass() {
      persisted = true;
      return { ref: REF, evaluation: { testReportHash: "6".repeat(64) } };
    },
    createInterlock(input = {}) {
      assert.deepEqual(input, {});
      return {
        verifyR3(request) {
          interlockCalls += 1;
          assert.deepEqual(request, VERIFY_REQUEST);
          return {
            ok: true,
            status: "PASS",
            artifactHash: REF.artifactHash,
            effectiveVisualPermitBudget: 1,
          };
        },
      };
    },
  };
  const task = createXhsV3TaskBootstrap({
    runner: { async run() { return { ok: true }; } },
    async loadTaskInvocation() {
      return {
        schemaId: "xw.xhs.v3-task-invocation.v1",
        plan: { mission: { vision: { eCorpusPassRef: null } } },
        privatePayload: {},
      };
    },
    async buildTaskInvocation() {
      return {
        schemaId: "xw.xhs.v3-task-invocation.v1",
        plan: { mission: { vision: { rolloutPhase: "R0", eCorpusPassRef: null } } },
        privatePayload: {},
      };
    },
    async persistTaskInvocation({ phase, invocationId }) {
      return { phase, invocationId, invocationHash: "7".repeat(64) };
    },
    corpusAssembler: {
      async prepareReview() { return {}; },
      async submitReview() { return {}; },
      async assemble() { return {}; },
    },
    async evaluateCorpusSet() { return {}; },
    runRecordStore: {
      async beginAttempt({ phase, invocationId }) {
        return { phase, invocationId, attemptHash: "9".repeat(64), created: true };
      },
      async loadAttemptIfPresent() { return null; },
      async persist({ phase, invocationId }) {
        return { phase, invocationId, runRecordHash: "8".repeat(64) };
      },
      async loadIfPresent() { return null; },
    },
    async closeoutAcceptance() { return {}; },
    async createCorpusSealer() { return registry; },
    openECorpusArtifact(artifactHash) {
      if (!persisted || artifactHash !== REF.artifactHash) {
        throw Object.assign(new Error("absent"), { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" });
      }
      return {
        ref: REF,
        interlock: registry.createInterlock({}),
        verification: { status: "PASS", artifactHash: REF.artifactHash },
      };
    },
    async assertGateFReady() { return true; },
    now: () => 10_000,
  });
  return { task, interlockCalls: () => interlockCalls };
}

function fixedKeyring() {
  const keyId = "ka-1";
  const digest = ({ kind, value }) => createHash("sha256")
    .update(`test-key:${keyId}:${kind}:${value}`, "utf8")
    .digest("hex");
  return {
    activeKeyId: () => keyId,
    sign(input) { return { digestKeyId: keyId, digest: digest(input) }; },
    verify(input) {
      return {
        ok: input.digestKeyId === keyId && input.digest === digest(input),
        keyStatus: "active",
      };
    },
  };
}

function realRegistryFixture() {
  const root = mkdtempSync(join(tmpdir(), "xhs-v3-cp-ecorpus-"));
  let nowMs = 10_000;
  const owner = Object.freeze({
    taskName: "XW Platform Control Plane",
    taskBindingHash: "a".repeat(64),
    launcherHash: "b".repeat(64),
    callerPathHash: "c".repeat(64),
  });
  const binding = Object.freeze({
    releaseId: "release-a",
    sourceCommit: "4".repeat(40),
    providerBundleDigest: "5".repeat(64),
    corpusManifestHash: "6".repeat(64),
    privateIndexDigest: "7".repeat(64),
    evaluatorSourceHash: "8".repeat(64),
    testReportHash: "9".repeat(64),
    digestKeyId: "ka-1",
    gateEpoch: "d".repeat(64),
  });
  const store = createECorpusPassStore({
    artifactRoot: root,
    canonicalArtifactRoot: root,
    owner,
    keyring: fixedKeyring(),
    aclChecker: () => true,
    now: () => nowMs,
  });
  let sealedRef = null;
  const registry = {
    async sealPass({ expiresAtMs }) {
      const sealed = store.seal({ binding, expiresAtMs, caller: owner });
      sealedRef = sealed.ref;
      return sealed;
    },
    createInterlock(input = {}) {
      assert.deepEqual(input, {});
      return createStoreBackedECorpusInterlock({
        store,
        expectedBinding: binding,
        taskCaller: owner,
      });
    },
  };
  return {
    root,
    binding,
    registry,
    openECorpusArtifact(artifactHash) {
      if (!sealedRef || sealedRef.artifactHash !== artifactHash) {
        throw Object.assign(new Error("absent"), { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" });
      }
      const interlock = registry.createInterlock({});
      const verification = interlock.verifyR3({
        ref: sealedRef,
        releaseId: binding.releaseId,
        sourceCommit: binding.sourceCommit,
        providerBundleDigest: binding.providerBundleDigest,
      });
      return { ref: sealedRef, interlock, verification };
    },
    setNow(value) { nowMs = value; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("production E-Corpus bridge stays locked until the exact task bootstrap is installed", () => {
  let installed = null;
  const bridge = createXhsV3TaskECorpusInterlockBridge({
    resolveTaskBootstrap: () => installed,
  });
  assert.throws(
    () => bridge.verifyR3(VERIFY_REQUEST),
    { code: "ECORPUS_INTERLOCK_NOT_CONFIGURED", status: 503 },
  );

  let delegated = 0;
  installed = {
    verifyECorpusR3(request) {
      delegated += 1;
      assert.equal(request, VERIFY_REQUEST);
      return { ok: true, status: "PASS" };
    },
  };
  assert.deepEqual(bridge.verifyR3(VERIFY_REQUEST), { ok: true, status: "PASS" });
  assert.equal(delegated, 1);
});

test("task bootstrap reopens only the exact persisted registry artifact for the CP R3 bridge", async () => {
  const fixture = taskBootstrapFixture();
  assert.throws(
    () => fixture.task.verifyECorpusR3(VERIFY_REQUEST),
    { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" },
  );

  await fixture.task.sealECorpus({
    corpusSetId: "set-001",
    expiryPolicy: "GATE_F_SHORT",
  });
  const verified = fixture.task.verifyECorpusR3(VERIFY_REQUEST);
  assert.equal(verified.status, "PASS");
  assert.equal(verified.artifactHash, REF.artifactHash);
  assert.equal(verified.effectiveVisualPermitBudget, 1);
  assert.equal(fixture.interlockCalls(), 1);

  assert.throws(
    () => fixture.task.verifyECorpusR3({
      ...VERIFY_REQUEST,
      ref: { ...REF, artifactHash: "9".repeat(64) },
    }),
    { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" },
  );
});

test("dynamic CP bridge re-verifies task HMAC, freshness, release and provider on every R3 check", async () => {
  const real = realRegistryFixture();
  try {
    const task = createXhsV3TaskBootstrap({
      runner: { async run() { return { ok: true }; } },
      async loadTaskInvocation() { return {}; },
      async buildTaskInvocation() { return {}; },
      async persistTaskInvocation({ phase, invocationId }) {
        return { phase, invocationId, invocationHash: "e".repeat(64) };
      },
      corpusAssembler: {
        async prepareReview() { return {}; },
        async submitReview() { return {}; },
        async assemble() { return {}; },
      },
      async evaluateCorpusSet() { return {}; },
      runRecordStore: {
        async beginAttempt({ phase, invocationId }) {
          return { phase, invocationId, attemptHash: "a".repeat(64), created: true };
        },
        async loadAttemptIfPresent() { return null; },
        async persist({ phase, invocationId }) {
          return { phase, invocationId, runRecordHash: "f".repeat(64) };
        },
        async loadIfPresent() { return null; },
      },
      async closeoutAcceptance() { return {}; },
      async createCorpusSealer() { return real.registry; },
      openECorpusArtifact: real.openECorpusArtifact,
      async assertGateFReady() { return true; },
      now: () => 10_000,
    });
    const bridge = createXhsV3TaskECorpusInterlockBridge({
      resolveTaskBootstrap: () => task,
    });
    const sealed = await task.sealECorpus({
      corpusSetId: "set-real",
      expiryPolicy: "GATE_F_SHORT",
    });
    const request = {
      ref: sealed.ref,
      releaseId: real.binding.releaseId,
      sourceCommit: real.binding.sourceCommit,
      providerBundleDigest: real.binding.providerBundleDigest,
    };
    assert.equal(bridge.verifyR3(request).effectiveVisualPermitBudget, 1);
    assert.throws(
      () => bridge.verifyR3({ ...request, releaseId: "release-forged" }),
      { code: "ECORPUS_RELEASE_MISMATCH", status: 403 },
    );
    assert.throws(
      () => bridge.verifyR3({ ...request, providerBundleDigest: "0".repeat(64) }),
      { code: "ECORPUS_PROVIDER_MISMATCH", status: 403 },
    );
    assert.throws(
      () => bridge.verifyR3({
        ...request,
        ref: { ...sealed.ref, bindingHash: "0".repeat(64) },
      }),
      { code: "XHS_V3_E_CORPUS_REF_DRIFT" },
    );
    real.setNow(sealed.ref.expiresAtMs);
    assert.throws(
      () => bridge.verifyR3(request),
      { code: "ECORPUS_ARTIFACT_STALE", status: 403 },
    );
    assert.equal(XHS_E_CORPUS_PASS_SEAL_KIND, "xhs-e-corpus-pass-artifact");
  } finally {
    real.cleanup();
  }
});
