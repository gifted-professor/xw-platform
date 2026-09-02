import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  XHS_CORPUS_REQUIRED_ROUTES,
  XHS_CORPUS_ZERO_RESOURCES,
  buildCpBoundCaptureReceipt,
  buildOfflineFixtureCaptureReceipt,
  canonicalJson,
  createFixtureCorpusAdapter,
  createOfflineCorpusOperator,
  sealBlindLabels,
  sealCorpusBundle,
  validatePublicCorpusPrivacy,
  validateSealedCorpusBundle,
  verifyCaptureReceipt,
} from "../scripts/lib/xhs-exploration-corpus-operator.mjs";
import { createVerifiedECorpusSealer } from "../scripts/lib/xhs-e-corpus-registry.mjs";
import { runCli } from "../ops/xw-xhs-exploration-corpus.mjs";

const KEY = Buffer.alloc(32, 0x23);
const KEY_HEX = KEY.toString("hex");
const KEY_ID = "fixture-key-20260830";
const RUNTIME = Object.freeze({
  releaseId: "xw-xhs-v3-fixture-release",
  sourceCommit: "a".repeat(40),
  providerBundleDigest: "b".repeat(64),
});
const ROLE_BY_ROUTE = Object.freeze({
  HOME_FEED: "OPEN_CONTENT_CARD",
  SEARCH_RESULTS: "OPEN_CONTENT_CARD",
  IMAGE_NOTE: "OPEN_COMMENT_PANEL",
  VIDEO_NOTE: "PAUSE_VIDEO_SAFE_ZONE",
  COMMENT_PANEL: "BACK",
});

function png(width, height, salt) {
  const bytes = Buffer.alloc(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(salt, 32);
  return bytes;
}

function buildCaptures({
  phases = ["R1", "R1", "R2"],
  duplicatePngRoute = null,
  sameSurfaceRoute = null,
  runtimeMutationAt = -1,
} = {}) {
  const captures = [];
  let ordinal = 0;
  for (const route of XHS_CORPUS_REQUIRED_ROUTES) {
    let firstPng = null;
    for (let sample = 0; sample < 3; sample += 1) {
      ordinal += 1;
      const phase = phases[sample];
      const alias = route === "HOME_FEED"
        ? "03"
        : route === "SEARCH_RESULTS"
          ? "04"
          : sample === 2 ? "04" : "03";
      const laneRole = alias === "03" ? "FEED" : "SEARCH";
      let pngBytes = png(1080, 2400, ordinal);
      if (sample === 0) firstPng = pngBytes;
      if (route === duplicatePngRoute && sample === 1) pngBytes = Buffer.from(firstPng);
      const dumpVerdict = sample === 0
        ? "COMPLETE_SAFE_UNIQUE"
        : sample === 1 ? "AMBIGUOUS_SAFE" : "ABSENT_OR_INVALID";
      captures.push({
        pngBytes,
        dumpBytes: Buffer.from(`dump-${route}-${sample}`, "utf8"),
        focusBytes: Buffer.from(`focus-${route}-${sample}`, "utf8"),
        pageClass: route,
        evaluationRole: ROLE_BY_ROUTE[route],
        dumpDecision: {
          verdict: dumpVerdict,
          reasons: [`fixture-${dumpVerdict.toLowerCase()}`],
          regions: [{ kind: "fixture-parser-region", bounds: [100, 200, 800, 1800] }],
        },
        alias,
        laneRole,
        phase,
        sessionId: `${phase.toLowerCase()}-${alias}-session`,
        leaseId: `${phase.toLowerCase()}-${alias}-lease`,
        authorityId: `${phase.toLowerCase()}-exact-pair-authority`,
        waveId: `${phase.toLowerCase()}-exact-pair-wave`,
        surfaceClaim: route === sameSurfaceRoute
          ? `${route.toLowerCase()}-same-surface`
          : `${route.toLowerCase()}-surface-${sample % 2}`,
        ...RUNTIME,
        providerBundleDigest: ordinal - 1 === runtimeMutationAt
          ? "c".repeat(64)
          : RUNTIME.providerBundleDigest,
      });
    }
  }
  return captures;
}

function buildReceipts(captures = buildCaptures()) {
  return captures.map((capture) => buildCpBoundCaptureReceipt(capture, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  }));
}

function annotationsFor(receipts) {
  return receipts.map((receipt) => {
    const verification = verifyCaptureReceipt(receipt, { signingKey: KEY, expectedDigestKeyId: KEY_ID });
    const verdict = receipt.classification.dumpVerdict;
    const expectedOutcome = verdict === "COMPLETE_SAFE_UNIQUE"
      ? "NO_FALLBACK_EXPECTED"
      : verdict === "FORBIDDEN_OR_RISKY" ? "REJECT" : "SAFE_UNIQUE";
    return {
      captureReceiptHash: verification.receiptHash,
      expectedOutcome,
      positiveRegions: expectedOutcome === "SAFE_UNIQUE"
        ? [{ role: receipt.classification.evaluationRole, bounds: [200, 400, 400, 600] }]
        : [],
      protectedRegions: [{ kind: "SOCIAL_ACTIONS", bounds: [900, 100, 1080, 2000] }],
    };
  });
}

function labelsFor(receipts, overrides = {}) {
  return sealBlindLabels({
    receipts,
    annotations: annotationsFor(receipts),
    reviewerId: "independent-reviewer-01",
    providerImplementerId: "provider-implementer-02",
    annotationsSealedAt: "2026-08-30T01:00:00.000Z",
    providerOutputDisclosedAt: "2026-08-30T02:00:00.000Z",
    accessAttestationHash: "e".repeat(64),
    signingKey: KEY,
    digestKeyId: KEY_ID,
    ...overrides,
  });
}

function sealReceipts(receipts, labelOverrides = {}) {
  const labels = labelsFor(receipts, labelOverrides);
  return sealCorpusBundle({
    receipts,
    annotationManifest: labels.annotationManifest,
    labelSession: labels.labelSession,
    signingKey: KEY,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
  });
}

function clone(value) {
  return structuredClone(value);
}

test("operator JSON schemas are tracked and identify the canonical receipt/bundle contracts", () => {
  const receiptSchema = JSON.parse(readFileSync(
    new URL("../contracts/xhs-exploration-capture-receipt.v1.schema.json", import.meta.url),
    "utf8",
  ));
  const bundleSchema = JSON.parse(readFileSync(
    new URL("../contracts/xhs-exploration-sealed-corpus.v1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(receiptSchema.$id, "xw.xhs.exploration-capture-receipt.v1");
  assert.equal(receiptSchema.additionalProperties, false);
  assert.equal(bundleSchema.$id, "xw.xhs.exploration-corpus-sealed-bundle.v1");
  assert.equal(bundleSchema.properties.publicManifest.$ref, "#/$defs/publicManifest");
});

test("capture receipt canonically binds exact bytes, actual DUMP fields, lane/runtime identities, and HMAC", async (t) => {
  const capture = buildCaptures()[0];
  const receipt = buildCpBoundCaptureReceipt(capture, { signingKey: KEY, digestKeyId: KEY_ID });
  const verified = verifyCaptureReceipt(receipt, {
    signingKey: KEY,
    expectedDigestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
  });
  assert.equal(verified.valid, true);
  assert.equal(receipt.classification.pageClass, "HOME_FEED");
  assert.equal(receipt.classification.evaluationRole, "OPEN_CONTENT_CARD");
  assert.equal(receipt.classification.dumpVerdict, "COMPLETE_SAFE_UNIQUE");
  assert.equal(receipt.captureMode, "CP_BOUND_R1_R2");
  assert.deepEqual(receipt.safety, {
    socialTransport: 0,
    effectTransport: 0,
    visualIssued: 0,
    visualConsumed: 0,
    visualPhysical: 0,
  });
  const serialized = canonicalJson(receipt);
  assert.doesNotMatch(serialized, /r1-03-(?:session|lease)/);
  assert.doesNotMatch(serialized, /exact-pair-authority/);
  assert.doesNotMatch(serialized, /fixture-parser-region/);

  const mutations = [
    ["png hash", (doc) => { doc.evidence.pngHash = "f".repeat(64); }],
    ["dump hash", (doc) => { doc.evidence.dumpHash = "f".repeat(64); }],
    ["focus hash", (doc) => { doc.evidence.focusHash = "f".repeat(64); }],
    ["page", (doc) => { doc.classification.pageClass = "SEARCH_RESULTS"; }],
    ["role", (doc) => { doc.classification.evaluationRole = "BACK"; }],
    ["actual verdict", (doc) => { doc.classification.dumpVerdict = "AMBIGUOUS_SAFE"; }],
    ["alias", (doc) => { doc.placement.alias = "04"; }],
    ["session", (doc) => { doc.provenance.sessionDigest = "f".repeat(64); }],
    ["lease", (doc) => { doc.provenance.leaseDigest = "f".repeat(64); }],
    ["authority", (doc) => { doc.provenance.authorityDigest = "f".repeat(64); }],
    ["wave", (doc) => { doc.provenance.waveDigest = "f".repeat(64); }],
    ["release", (doc) => { doc.runtime.releaseId = "another-release"; }],
    ["provider", (doc) => { doc.runtime.providerBundleDigest = "f".repeat(64); }],
    ["key", (doc) => { doc.runtime.digestKeyId = "another-key"; }],
    ["zero safety", (doc) => { doc.safety.visualIssued = 1; }],
    ["extra field", (doc) => { doc.callerAuthority = true; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const changed = clone(receipt);
      mutate(changed);
      const result = verifyCaptureReceipt(changed, { signingKey: KEY, expectedDigestKeyId: KEY_ID });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.code === "CAPTURE_RECEIPT_AUTH_INVALID"));
    });
  }
});

test("capture input rejects lane/role/alias drift before a receipt exists", () => {
  const base = buildCaptures()[0];
  assert.throws(
    () => buildCpBoundCaptureReceipt({ ...base, alias: "04", laneRole: "SEARCH" }, { signingKey: KEY, digestKeyId: KEY_ID }),
    /HOME_FEED evidence must come from alias 03/,
  );
  assert.throws(
    () => buildCpBoundCaptureReceipt({ ...base, alias: "02" }, { signingKey: KEY, digestKeyId: KEY_ID }),
    /exact \[03,04\] pair/,
  );
  assert.throws(
    () => buildCpBoundCaptureReceipt({ ...base, evaluationRole: "BACK" }, { signingKey: KEY, digestKeyId: KEY_ID }),
    /closed route matrix/,
  );
});

test("blind labels cannot rewrite CP page/role/verdict/binding and must remain independent and ordered", async (t) => {
  const receipts = buildReceipts();
  const annotations = annotationsFor(receipts);
  await t.test("immutable capture field", () => {
    const mutated = clone(annotations);
    mutated[0].dumpVerdict = "AMBIGUOUS_SAFE";
    assert.throws(() => labelsFor(receipts, { annotations: mutated }), /cannot author capture field/);
  });
  await t.test("geometry role drift", () => {
    const mutated = clone(annotations);
    const fallback = mutated.find((row) => row.expectedOutcome === "SAFE_UNIQUE");
    fallback.positiveRegions[0].role = "BACK";
    assert.throws(() => labelsFor(receipts, { annotations: mutated }), /geometry role differs/);
  });
  await t.test("COMPLETE relabelled fallback-positive", () => {
    const mutated = clone(annotations);
    mutated[0].expectedOutcome = "SAFE_UNIQUE";
    mutated[0].positiveRegions = [{ role: receipts[0].classification.evaluationRole, bounds: [1, 1, 2, 2] }];
    assert.throws(() => labelsFor(receipts, { annotations: mutated }), /COMPLETE DUMP must remain/);
  });
  await t.test("reviewer equals provider implementer", () => {
    assert.throws(() => labelsFor(receipts, {
      reviewerId: "same-person",
      providerImplementerId: "same-person",
    }), /independent/);
  });
  await t.test("provider output disclosed before seal", () => {
    assert.throws(() => labelsFor(receipts, {
      providerOutputDisclosedAt: "2026-08-30T00:59:59.000Z",
    }), /only after annotation sealing/);
  });
  await t.test("sealed label-session drift", () => {
    const labels = labelsFor(receipts);
    const labelSession = clone(labels.labelSession);
    labelSession.isolation.providerOutputAccess = "ALLOWED";
    const result = sealCorpusBundle({
      receipts,
      annotationManifest: labels.annotationManifest,
      labelSession,
      signingKey: KEY,
      digestKeyId: KEY_ID,
      expectedRuntime: RUNTIME,
    });
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.code === "LABEL_SESSION_BINDING_INVALID"));
    assert.ok(result.errors.some((error) => error.code === "LABEL_SESSION_AUTH_INVALID"));
  });
});

test("R1/R2 provenance and diversity close all five routes while calibration-only rows never count", () => {
  const live = sealReceipts(buildReceipts());
  assert.equal(live.passed, true, live.errors.map((error) => error.code).join(","));
  assert.deepEqual(live.coverage.distinctFramesByRoute, {
    HOME_FEED: 3,
    SEARCH_RESULTS: 3,
    IMAGE_NOTE: 3,
    VIDEO_NOTE: 3,
    COMMENT_PANEL: 3,
  });
  assert.equal(live.coverage.countingRows, 15);
  assert.equal(live.coverage.calibrationRows, 0);
  assert.equal(validatePublicCorpusPrivacy(live.bundle.publicManifest).valid, true);
  assert.equal(JSON.stringify(live.bundle.publicManifest).includes("session"), false);
  assert.equal(JSON.stringify(live.bundle.publicManifest).includes("lease"), false);

  const calibrationReceipts = buildCaptures({
    phases: ["CALIBRATION_ONLY", "CALIBRATION_ONLY", "CALIBRATION_ONLY"],
  }).map((capture) => buildOfflineFixtureCaptureReceipt(capture, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  }));
  const calibration = sealReceipts(calibrationReceipts);
  assert.equal(calibration.passed, false);
  assert.equal(calibration.coverage.countingRows, 0);
  assert.equal(calibration.coverage.calibrationRows, 15);
  assert.ok(calibration.errors.some((error) => error.code === "CORPUS_DIVERSITY_ROUTE_INCOMPLETE"));
});

test("offline fixtures cannot claim R1/R2 or become counting E-Corpus rows", () => {
  assert.throws(
    () => buildOfflineFixtureCaptureReceipt(buildCaptures()[0], {
      signingKey: KEY,
      digestKeyId: KEY_ID,
    }),
    /can never claim R1\/R2/,
  );
  const calibrationCaptures = buildCaptures({
    phases: ["CALIBRATION_ONLY", "CALIBRATION_ONLY", "CALIBRATION_ONLY"],
  });
  const receipts = calibrationCaptures.map((capture) => buildOfflineFixtureCaptureReceipt(capture, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  }));
  const sealed = sealReceipts(receipts);
  assert.equal(sealed.passed, false);
  assert.equal(sealed.coverage.countingRows, 0);
  assert.ok(sealed.bundle.publicManifest.rows.every((row) => (
    row.provenance.captureMode === "OFFLINE_FIXTURE_ONLY"
      && row.provenance.phase === "CALIBRATION_ONLY"
      && row.provenance.countingEligible === false
  )));
});

test("task-owned E sealer reproduces the real bundle and accepts no caller binding or corpus", async () => {
  const live = sealReceipts(buildReceipts());
  assert.equal(live.passed, true);
  const taskBinding = Object.freeze({
    taskName: "XW Platform Control Plane",
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
  });
  const expectedRuntime = Object.freeze({ ...RUNTIME, digestKeyId: KEY_ID });
  let sealRequest = null;
  let evaluatorCalls = 0;
  const store = {
    seal(request) {
      sealRequest = structuredClone(request);
      return { artifact: { binding: request.binding }, ref: { artifactHash: "4".repeat(64) } };
    },
  };
  const sealer = createVerifiedECorpusSealer({
    store,
    taskBinding,
    expectedRuntime,
    gateEpoch: "5".repeat(64),
    corpusSigningKey: KEY,
    loadSealedCorpus: async () => live.bundle,
    evaluatorSourceBytes: Buffer.from("release-owned-evaluator-v1", "utf8"),
    evaluateCorpus: async (input) => {
      evaluatorCalls += 1;
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.bundle.publicManifest.rows[0]), true);
      assert.equal(input.runtime.providerBundleDigest, RUNTIME.providerBundleDigest);
      return {
        providerOracleCases: [{ id: "real-provider-oracle", passed: true }],
        adverseMutationCases: [{ id: "forgery-replay-privacy", passed: true }],
        safety: {
          socialTransport: 0,
          effectTransport: 0,
          visualIssued: 0,
          visualConsumed: 0,
          visualPhysical: 0,
        },
      };
    },
  });
  await assert.rejects(
    sealer.sealPass({ expiresAtMs: 20_000, binding: { caller: true } }),
    (error) => error.code === "ECORPUS_CALLER_FIELDS_FORBIDDEN",
  );
  assert.equal(evaluatorCalls, 0);
  const sealed = await sealer.sealPass({ expiresAtMs: 20_000 });
  assert.equal(evaluatorCalls, 1);
  assert.deepEqual(sealRequest.caller, taskBinding);
  assert.equal(sealRequest.binding.corpusManifestHash, live.bundle.privateIndex.publicManifestHash);
  assert.equal(sealRequest.binding.releaseId, RUNTIME.releaseId);
  assert.equal(sealRequest.binding.providerBundleDigest, RUNTIME.providerBundleDigest);
  assert.equal(sealRequest.binding.digestKeyId, KEY_ID);
  assert.equal(sealRequest.binding.gateEpoch, "5".repeat(64));
  assert.equal(sealRequest.binding.testReportHash, sealed.evaluation.testReportHash);
  assert.equal(sealed.evaluation.testReport.status, "PASS");
  assert.throws(
    () => sealer.createInterlock({ expectedBinding: sealRequest.binding }),
    (error) => error.code === "ECORPUS_CALLER_FIELDS_FORBIDDEN",
  );

  const offlineCaptures = buildCaptures({
    phases: ["CALIBRATION_ONLY", "CALIBRATION_ONLY", "CALIBRATION_ONLY"],
  });
  const offlineReceipts = offlineCaptures.map((capture) => buildOfflineFixtureCaptureReceipt(capture, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
  }));
  const offline = sealReceipts(offlineReceipts);
  let offlineEvaluated = false;
  const offlineSealer = createVerifiedECorpusSealer({
    store,
    taskBinding,
    expectedRuntime,
    gateEpoch: "5".repeat(64),
    corpusSigningKey: KEY,
    loadSealedCorpus: async () => offline.bundle,
    evaluatorSourceBytes: Buffer.from("release-owned-evaluator-v1", "utf8"),
    evaluateCorpus: async () => {
      offlineEvaluated = true;
      throw new Error("must not run");
    },
  });
  await assert.rejects(
    offlineSealer.sealPass({ expiresAtMs: 20_000 }),
    (error) => error.code === "ECORPUS_CORPUS_INVALID",
  );
  assert.equal(offlineEvaluated, false);
});

test("duplicate PNG, same-surface jitter, one-wave provenance, and mixed runtime fail closed", async (t) => {
  const cases = [
    {
      name: "duplicate PNG",
      captures: buildCaptures({ duplicatePngRoute: "IMAGE_NOTE" }),
      code: "CORPUS_DIVERSITY_FRAME_REPLAY",
    },
    {
      name: "same-surface jitter",
      captures: buildCaptures({ sameSurfaceRoute: "VIDEO_NOTE" }),
      code: "CORPUS_DIVERSITY_SURFACE_INCOMPLETE",
    },
    {
      name: "one wave only",
      captures: buildCaptures({ phases: ["R1", "R1", "R1"] }),
      code: "CORPUS_DIVERSITY_PHASE_INCOMPLETE",
    },
    {
      name: "mixed provider runtime",
      captures: buildCaptures({ runtimeMutationAt: 7 }),
      code: "CAPTURE_RECEIPT_RUNTIME_DRIFT",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const result = sealReceipts(buildReceipts(fixture.captures));
      assert.equal(result.passed, false);
      assert.ok(result.errors.some((error) => error.code === fixture.code),
        `${fixture.code}: ${result.errors.map((error) => error.code).join(",")}`);
    });
  }
});

test("public privacy rejects raw path/session-shaped additions", () => {
  const sealed = sealReceipts(buildReceipts());
  assert.equal(sealed.passed, true);
  const pathLeak = clone(sealed.bundle.publicManifest);
  pathLeak.rows[0].privatePath = "C:\\private\\frame.png";
  const pathResult = validatePublicCorpusPrivacy(pathLeak);
  assert.equal(pathResult.valid, false);
  assert.ok(pathResult.errors.some((error) => error.code === "CORPUS_PUBLIC_KEY_FORBIDDEN"));
  assert.ok(pathResult.errors.some((error) => error.code === "CORPUS_PUBLIC_VALUE_FORBIDDEN"));

  const idLeak = clone(sealed.bundle.publicManifest);
  idLeak.rows[0].sourceRef = "session_deadbeef-dead-beef-dead-beefdeadbeef";
  assert.equal(validatePublicCorpusPrivacy(idLeak).valid, false);
});

test("preflight|capture|seal|evaluate all independently prove jobs/sessions/leases/deviceIo=0", async () => {
  const captures = buildCaptures({
    phases: ["CALIBRATION_ONLY", "CALIBRATION_ONLY", "CALIBRATION_ONLY"],
  });
  const adapter = createFixtureCorpusAdapter({ captures });
  const operator = createOfflineCorpusOperator({
    adapter,
    signingKey: KEY,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
  });
  const preflight = await operator.preflight();
  assert.deepEqual(preflight.resources, XHS_CORPUS_ZERO_RESOURCES);
  assert.equal(preflight.productionWiring, false);
  const captured = await operator.capture();
  assert.deepEqual(captured.resources, XHS_CORPUS_ZERO_RESOURCES);
  assert.equal(captured.receipts.length, 15);
  const labels = labelsFor(captured.receipts);
  const sealed = await operator.seal({
    receipts: captured.receipts,
    annotationManifest: labels.annotationManifest,
    labelSession: labels.labelSession,
  });
  assert.equal(sealed.passed, false);
  assert.equal(sealed.coverage.countingRows, 0);
  assert.deepEqual(sealed.resources, XHS_CORPUS_ZERO_RESOURCES);
  const evaluated = await operator.evaluate({ bundle: sealed.bundle });
  assert.equal(evaluated.passed, false);
  assert.deepEqual(evaluated.resources, XHS_CORPUS_ZERO_RESOURCES);
});

test("offline boundary rejects production-shaped adapters and catches injected I/O on failure", async () => {
  let transportCalls = 0;
  assert.throws(() => createOfflineCorpusOperator({
    adapter: {
      kind: "fixture",
      capability: "OFFLINE_FIXTURE_ONLY",
      endpoint: "http://127.0.0.1:17920",
      snapshotResources: () => ({ ...XHS_CORPUS_ZERO_RESOURCES }),
      readFixtureCaptures: async () => [],
      connect: () => { transportCalls += 1; },
    },
    signingKey: KEY,
    digestKeyId: KEY_ID,
  }), /PRODUCTION_SURFACE_FORBIDDEN/);
  assert.equal(transportCalls, 0);

  let dirtied = false;
  const adapter = {
    kind: "fixture",
    capability: "OFFLINE_FIXTURE_ONLY",
    snapshotResources: () => ({
      jobs: 0,
      sessions: 0,
      leases: 0,
      deviceIo: dirtied ? 1 : 0,
    }),
    async readFixtureCaptures() {
      dirtied = true;
      throw new Error("injected fixture failure");
    },
  };
  const operator = createOfflineCorpusOperator({ adapter, signingKey: KEY, digestKeyId: KEY_ID });
  await assert.rejects(operator.capture(), /PHASE_BOUNDARY_VIOLATION/);
  assert.equal(adapter.snapshotResources().deviceIo, 1);
});

test("sealed bundle reproduces and any public/private replay drift is rejected", () => {
  const sealed = sealReceipts(buildReceipts());
  assert.equal(sealed.passed, true);
  const reproduced = validateSealedCorpusBundle(sealed.bundle, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
  });
  assert.equal(reproduced.passed, true);
  const drifted = clone(sealed.bundle);
  drifted.publicManifest.rows[0].sourceRef = `src:${"f".repeat(64)}`;
  const rejected = validateSealedCorpusBundle(drifted, {
    signingKey: KEY,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
  });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.errors.some((error) => error.code === "CORPUS_PUBLIC_MANIFEST_DRIFT"));
});

test("tracked CLI exposes only local fixture inputs and executes all five P4A commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xhs-corpus-operator-"));
  const captures = buildCaptures({
    phases: ["CALIBRATION_ONLY", "CALIBRATION_ONLY", "CALIBRATION_ONLY"],
  });
  const captureInput = {
    fixtureSigningKeyHex: KEY_HEX,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
    captures: captures.map(({ pngBytes, dumpBytes, focusBytes, ...metadata }) => ({
      ...metadata,
      pngBase64: pngBytes.toString("base64"),
      dumpBase64: dumpBytes.toString("base64"),
      focusBase64: focusBytes.toString("base64"),
    })),
  };
  const capturePath = join(dir, "capture.json");
  writeFileSync(capturePath, JSON.stringify(captureInput));
  const preflight = await runCli(["preflight"]);
  assert.deepEqual(preflight.resources, XHS_CORPUS_ZERO_RESOURCES);
  const traversed = await runCli(["traverse"]);
  assert.equal(traversed.passed, true);
  assert.deepEqual(traversed.coverage.reachedRoutes, XHS_CORPUS_REQUIRED_ROUTES);
  assert.deepEqual(traversed.resources, XHS_CORPUS_ZERO_RESOURCES);
  const captured = await runCli(["capture", "--input", capturePath]);
  assert.equal(captured.receipts.length, 15);
  assert.deepEqual(captured.resources, XHS_CORPUS_ZERO_RESOURCES);

  const sealPath = join(dir, "seal.json");
  writeFileSync(sealPath, JSON.stringify({
    fixtureSigningKeyHex: KEY_HEX,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
    receipts: captured.receipts,
    annotations: annotationsFor(captured.receipts),
    reviewerId: "independent-reviewer-01",
    providerImplementerId: "provider-implementer-02",
    annotationsSealedAt: "2026-08-30T01:00:00.000Z",
    providerOutputDisclosedAt: "2026-08-30T02:00:00.000Z",
    accessAttestationHash: "e".repeat(64)
  }));
  const sealed = await runCli(["seal", "--input", sealPath]);
  assert.equal(sealed.passed, false);
  assert.equal(sealed.coverage.countingRows, 0);
  assert.deepEqual(sealed.resources, XHS_CORPUS_ZERO_RESOURCES);

  const evaluatePath = join(dir, "evaluate.json");
  writeFileSync(evaluatePath, JSON.stringify({
    fixtureSigningKeyHex: KEY_HEX,
    digestKeyId: KEY_ID,
    expectedRuntime: RUNTIME,
    bundle: sealed.bundle,
  }));
  const evaluated = await runCli(["evaluate", "--input", evaluatePath]);
  assert.equal(evaluated.passed, false);
  assert.deepEqual(evaluated.resources, XHS_CORPUS_ZERO_RESOURCES);

  const rejectedPath = join(dir, "rejected.json");
  writeFileSync(rejectedPath, JSON.stringify({ endpoint: "http://127.0.0.1:17920", captures: [] }));
  await assert.rejects(
    runCli(["capture", "--input", rejectedPath]),
    /production\/dynamic transport fields are forbidden/,
  );
  await assert.rejects(runCli(["capture", "--endpoint", "http://127.0.0.1:17920"]), /unsupported argument/);
});
