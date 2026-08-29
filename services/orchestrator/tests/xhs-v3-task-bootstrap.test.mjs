import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  XHS_V3_GATE_F_IDENTITY_SCHEMA_ID,
  XHS_V3_TASK_EVALUATOR_OUTCOME_SCHEMA_ID,
  XHS_V3_TASK_NAME,
  assertXhsV3GateFReadySnapshot,
  createBuiltInTaskInvocationBuilder,
  createDeployedR0FixtureRunner,
  createPostECorpusRoutineAdapter,
  createTaskOwnedCorpusAssembler,
  createTaskOwnedCorpusEvaluator,
  createTaskOwnedCapturePersistence,
  createTaskOwnedInvocationLoader,
  createTaskOwnedInvocationWriter,
  createTaskOwnedP6Closeout,
  createTaskOwnedRunRecordStore,
  createXhsV3TaskBootstrap,
  loadXhsV3GateFIdentityFromEnv,
  persistTaskOwnedECorpusLocatorPair,
} from "../scripts/lib/xhs-v3-task-bootstrap.mjs";
import {
  XHS_CORPUS_REQUIRED_ROUTES,
  buildCpBoundCaptureReceipt,
  canonicalJson,
  verifyCaptureReceipt,
} from "../scripts/lib/xhs-exploration-corpus-operator.mjs";
import { EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST } from
  "../ops/xw-xhs-vision-pin.mjs";
import { deriveSharedExplorationBudgetProof } from
  "../scripts/lib/xhs-exploration-shared-budget.mjs";

const KEY = Buffer.alloc(32, 0x61);
const RUNTIME = Object.freeze({
  releaseId: "xw-xhs-v3-bootstrap-test",
  sourceCommit: "a".repeat(40),
  providerBundleDigest: EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
  digestKeyId: "ka-test",
  accountFingerprint: "9".repeat(64),
});
const PRIVATE_SECRET = "private-goal-and-query-must-never-leave-the-loader";
const ROLE_BY_ROUTE = Object.freeze({
  HOME_FEED: "OPEN_CONTENT_CARD",
  SEARCH_RESULTS: "OPEN_CONTENT_CARD",
  IMAGE_NOTE: "OPEN_COMMENT_PANEL",
  VIDEO_NOTE: "PAUSE_VIDEO_SAFE_ZONE",
  COMMENT_PANEL: "BACK",
});
const PROVIDER = Object.freeze({
  providerBundleDigest: RUNTIME.providerBundleDigest,
  pythonHash: "1".repeat(64),
  modelHash: "2".repeat(64),
  scriptHash: "3".repeat(64),
  configHash: "4".repeat(64),
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-xhs-v3-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function invocation(plan = { mission: { vision: { rolloutPhase: "R0", eCorpusPassRef: null } } }) {
  return {
    schemaId: "xw.xhs.v3-task-invocation.v1",
    plan,
    privatePayload: { goal: PRIVATE_SECRET, queries: [PRIVATE_SECRET] },
  };
}

function identity() {
  return Object.freeze({
    schemaId: XHS_V3_GATE_F_IDENTITY_SCHEMA_ID,
    taskName: XHS_V3_TASK_NAME,
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
    releaseId: RUNTIME.releaseId,
    sourceCommit: RUNTIME.sourceCommit,
    providerBundleDigest: RUNTIME.providerBundleDigest,
    providerConfigSha256: "4".repeat(64),
    digestKeyringSha256: "5".repeat(64),
    accountFingerprint: RUNTIME.accountFingerprint,
  });
}

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

const UNUSED_PREPARATION = Object.freeze({
  buildTaskInvocation: async () => invocation(),
  persistTaskInvocation: async ({ phase, invocationId }) => ({
    phase,
    invocationId,
    invocationHash: "f".repeat(64),
  }),
  corpusAssembler: Object.freeze({
    prepareReview: async () => ({ ok: true }),
    submitReview: async () => ({ ok: true }),
    assemble: async () => ({ ok: true }),
  }),
  evaluateCorpusSet: async () => ({ ok: true }),
  runRecordStore: Object.freeze({
    loadIfPresent: async () => null,
    loadAttemptIfPresent: async () => null,
    beginAttempt: async ({ phase, invocationId }) => ({
      phase, invocationId, attemptHash: "d".repeat(64), created: true,
    }),
    persist: async ({ phase, invocationId }) => ({
      phase, invocationId, runRecordHash: "e".repeat(64),
    }),
  }),
  closeoutAcceptance: async () => ({ status: "CLOSEOUT_PARTIAL", blockers: ["fixture"] }),
});

test("Gate-F identity loader accepts only the fixed verified non-secret tuple", () => {
  const env = {
    XW_XHS_V3_TASK_BOOTSTRAP_ENABLED: "1",
    XW_XHS_V3_TASK_NAME: XHS_V3_TASK_NAME,
    XW_XHS_V3_TASK_BINDING_HASH: "1".repeat(64),
    XW_XHS_V3_LAUNCHER_HASH: "2".repeat(64),
    XW_XHS_V3_CALLER_PATH_HASH: "3".repeat(64),
    XW_XHS_V3_RELEASE_ID: RUNTIME.releaseId,
    XW_XHS_V3_SOURCE_COMMIT: RUNTIME.sourceCommit,
    XHS_EXPLORATION_VISION_PROVIDER_BUNDLE_DIGEST: RUNTIME.providerBundleDigest,
    XW_XHS_V3_PROVIDER_CONFIG_SHA256: "4".repeat(64),
    XW_XHS_V3_DIGEST_KEYRING_SHA256: "5".repeat(64),
    XW_M6_ACCOUNT_ISOLATION_BINDING_HASH: RUNTIME.accountFingerprint,
  };
  const identity = loadXhsV3GateFIdentityFromEnv({
    env,
    releaseIdentity: { releaseId: RUNTIME.releaseId, sourceCommit: RUNTIME.sourceCommit },
  });
  assert.equal(identity.schemaId, XHS_V3_GATE_F_IDENTITY_SCHEMA_ID);
  assert.equal(identity.providerBundleDigest, EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST);
  assert.equal(Object.values(identity).includes(PRIVATE_SECRET), false);

  assert.throws(
    () => loadXhsV3GateFIdentityFromEnv({ env: { ...env, XW_XHS_V3_TASK_NAME: "caller" } }),
    (error) => error.code === "XHS_V3_GATE_F_IDENTITY_INVALID",
  );
  assert.throws(
    () => loadXhsV3GateFIdentityFromEnv({
      env,
      releaseIdentity: { releaseId: "drift", sourceCommit: RUNTIME.sourceCommit },
    }),
    (error) => error.code === "XHS_V3_RELEASE_IDENTITY_DRIFT",
  );
});

test("fixed invocation loader rejects paths and loads canonical private bytes without disclosure", async (t) => {
  const root = tempRoot(t);
  const value = invocation();
  writeFileSync(join(root, "inv-001.v1.json"), canonicalJson(value), { flag: "wx" });
  const load = createTaskOwnedInvocationLoader({ root });
  const loaded = await load("inv-001");
  assert.deepEqual(loaded, value);

  for (const id of ["../escape", "..", "C:stream", "with/slash", "with\\slash", " leading"] ) {
    await assert.rejects(
      () => load(id),
      (error) => error.code === "XHS_V3_TASK_INVOCATION_ID_INVALID",
    );
  }
  writeFileSync(join(root, "noncanonical.v1.json"), JSON.stringify(value, null, 2), { flag: "wx" });
  await assert.rejects(
    () => load("noncanonical"),
    (error) => error.code === "XHS_V3_TASK_INVOCATION_INVALID",
  );
});

test("built-in invocation preparation fixes the benign profile and create-only phase binding", async (t) => {
  const root = tempRoot(t);
  const build = createBuiltInTaskInvocationBuilder({
    identity: identity(),
    providerBinding: PROVIDER,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const write = createTaskOwnedInvocationWriter({
    root,
    randomUUIDFn: () => "00000000-0000-4000-8000-000000000002",
  });
  const built = new Map();
  for (const phase of ["R0", "R1", "R2", "R4"]) {
    const value = await build(phase);
    built.set(phase, value);
    assert.equal(value.plan.mission.vision.rolloutPhase, phase);
    assert.equal(value.plan.placement.aliases.join(","), "03,04");
    assert.equal(value.plan.mission.vision.mode, phase === "R2" ? "shadow" : "off");
    assert.equal(value.plan.mission.vision.effectiveVisualPermitBudget, 0);
    assert.equal(JSON.stringify(value.plan).includes("城市旅行攻略"), false);
    assert.equal(value.privatePayload.queries.includes("城市旅行攻略"), true);
    const persisted = await write({ phase, invocationId: `inv-${phase.toLowerCase()}`, value });
    assert.equal(persisted.phase, phase);
    assert.match(persisted.invocationHash, /^[0-9a-f]{64}$/u);
  }
  const retried = await write({ phase: "R4", invocationId: "inv-r4", value: built.get("R4") });
  assert.equal(retried.invocationHash, digest(canonicalJson(built.get("R4"))), "exact retry is idempotent");
  await assert.rejects(
    () => write({ phase: "R1", invocationId: "inv-r0", value: built.get("R1") }),
    (error) => error.code === "XHS_V3_TASK_INVOCATION_EXISTS",
  );

  const eRef = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "6".repeat(64),
    bindingHash: "7".repeat(64),
    gateEpoch: "8".repeat(64),
    expiresAtMs: Date.now() + 60_000,
  };
  await assert.rejects(
    () => build("R3"),
    (error) => error.code === "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED",
  );
  const r3 = await build("R3", {
    eCorpusPassRef: eRef,
    eCorpusInterlock: {
      verifyR3: ({ ref }) => ({
        ok: true,
        status: "PASS",
        artifactHash: ref.artifactHash,
        effectiveVisualPermitBudget: 1,
      }),
    },
  });
  assert.equal(r3.plan.mission.vision.mode, "canary1");
  assert.equal(r3.plan.mission.vision.effectiveVisualPermitBudget, 1);
  assert.deepEqual(r3.plan.mission.vision.eCorpusPassRef, eRef);
});

test("capture store writes one content-addressed private tree create-only and returns only a receipt ref", async (t) => {
  const root = tempRoot(t);
  const sealed = [];
  const persist = createTaskOwnedCapturePersistence({
    root,
    randomUUIDFn: () => "00000000-0000-4000-8000-000000000001",
    sealPrivateTree(path) { sealed.push(path); },
  });
  const receipt = { schemaId: "fixture.receipt.v1", privateDigest: digest(PRIVATE_SECRET) };
  const captureReceiptHash = digest(Buffer.from(canonicalJson(receipt), "utf8"));
  const result = await persist({
    receipt,
    captureReceiptHash,
    raw: {
      pngBytes: Buffer.from(`png:${PRIVATE_SECRET}`),
      dumpBytes: Buffer.from(`<dump secret="${PRIVATE_SECRET}"/>`),
      focusBytes: Buffer.from(canonicalJson({ focus: PRIVATE_SECRET })),
    },
  });
  assert.deepEqual(result, { receiptRef: `receipt:${captureReceiptHash}` });
  assert.equal(JSON.stringify(result).includes(PRIVATE_SECRET), false);
  assert.equal(sealed.length, 1, "one recursive ACL operation seals the complete capture tree");
  const directory = join(root, captureReceiptHash);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "receipt.v1.json"), "utf8")), receipt);
  assert.equal(readFileSync(join(directory, "dump.xml"), "utf8").includes(PRIVATE_SECRET), true);
  await assert.rejects(
    () => persist({
      receipt,
      captureReceiptHash,
      raw: { pngBytes: Buffer.from("x"), dumpBytes: Buffer.from("x"), focusBytes: Buffer.from("x") },
    }),
    (error) => error.code === "XHS_V3_CAPTURE_ALREADY_PERSISTED",
  );
});

test("task evaluator keeps mixed COMPLETE coverage out of the fallback provider and creates PASS", async (t) => {
  const root = tempRoot(t);
  const captureRoot = join(root, "captures");
  const corpusRoot = join(root, "corpus-sets");
  mkdirSync(captureRoot);
  mkdirSync(corpusRoot);
  const persistCapture = createTaskOwnedCapturePersistence({ root: captureRoot });
  const runtime = Object.freeze({
    releaseId: RUNTIME.releaseId,
    sourceCommit: RUNTIME.sourceCommit,
    providerBundleDigest: RUNTIME.providerBundleDigest,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const annotations = [];
  const hashesByPhase = { R1: [], R2: [] };
  let ordinal = 0;
  for (const route of XHS_CORPUS_REQUIRED_ROUTES) {
    for (let sample = 0; sample < 3; sample += 1) {
      ordinal += 1;
      const phase = sample === 1 ? "R2" : "R1";
      const alias = route === "HOME_FEED" ? "03"
        : route === "SEARCH_RESULTS" ? "04" : sample === 2 ? "04" : "03";
      const laneRole = alias === "03" ? "FEED" : "SEARCH";
      const pngBytes = png(1080, 2400, ordinal);
      const dumpBytes = Buffer.from(`<hierarchy route="${route}" sample="${sample}"/>`, "utf8");
      const focusBytes = Buffer.from(canonicalJson({ package: "com.xingin.xhs", activity: "Main" }));
      const dumpResolved = route === "HOME_FEED" && sample === 0;
      const regions = [
        { kind: "positive", role: ROLE_BY_ROUTE[route], x: 100, y: 200, w: 300, h: 300 },
        { kind: "social_actions", x: 900, y: 100, w: 100, h: 1000 },
      ];
      const receipt = buildCpBoundCaptureReceipt({
        pngBytes,
        dumpBytes,
        focusBytes,
        pageClass: route,
        evaluationRole: ROLE_BY_ROUTE[route],
        dumpDecision: {
          verdict: dumpResolved
            ? "COMPLETE_SAFE_UNIQUE"
            : sample === 2 ? "ABSENT_OR_INVALID" : "AMBIGUOUS_SAFE",
          reasons: [`task-fixture-${route}-${sample}`],
          regions,
        },
        alias,
        laneRole,
        phase,
        sessionId: `session-${ordinal}`,
        leaseId: `lease-${ordinal}`,
        authorityId: `authority-${phase}-${ordinal}`,
        waveId: `wave-${phase}-${sample}-${ordinal}`,
        surfaceClaim: `surface-${route}-${sample}`,
        releaseId: runtime.releaseId,
        sourceCommit: runtime.sourceCommit,
        providerBundleDigest: runtime.providerBundleDigest,
      }, { signingKey: KEY, digestKeyId: runtime.digestKeyId });
      const verified = verifyCaptureReceipt(receipt, {
        signingKey: KEY,
        expectedDigestKeyId: runtime.digestKeyId,
        expectedRuntime: runtime,
      });
      assert.equal(verified.valid, true);
      hashesByPhase[phase].push(verified.receiptHash);
      await persistCapture({
        receipt,
        captureReceiptHash: verified.receiptHash,
        raw: { pngBytes, dumpBytes, focusBytes },
      });
      annotations.push({
        captureReceiptHash: verified.receiptHash,
        expectedOutcome: dumpResolved ? "NO_FALLBACK_EXPECTED" : "SAFE_UNIQUE",
        positiveRegions: [{ role: ROLE_BY_ROUTE[route], bounds: [100, 200, 400, 500] }],
        protectedRegions: [{ kind: "SOCIAL_ACTIONS", bounds: [900, 100, 1000, 1100] }],
      });
    }
  }
  const assembler = createTaskOwnedCorpusAssembler({
    captureRoot,
    corpusRoot,
    signingKey: KEY,
    digestKeyId: runtime.digestKeyId,
    expectedRuntime: runtime,
  });
  const review = await assembler.prepareReview({ corpusSetId: "set-task-evaluator" });
  assert.equal(review.receiptCount, 15);
  const accessAttestation = {
    schemaId: "xw.xhs.v3-blind-review-access-attestation.v1",
    schemaVersion: 1,
    releaseId: runtime.releaseId,
    sourceCommit: runtime.sourceCommit,
    operatorSha256: "7".repeat(64),
    corpusSetId: "set-task-evaluator",
    reviewRequestHash: review.reviewRequestHash,
    workspaceManifestHash: "8".repeat(64),
    templateHash: "9".repeat(64),
    reviewerPrincipalHash: "a".repeat(64),
    workspaceAclHash: "b".repeat(64),
    isolationAclHash: "c".repeat(64),
    networkPolicyHash: "d".repeat(64),
    sessionBindingHash: "e".repeat(64),
    providerOutputAccess: "DENIED_BY_ACL",
    implementationAnswerAccess: "DENIED_BY_ACL",
    reviewerNetworkAccess: "DENIED_BY_FIXED_OFFLINE_ACCOUNT",
  };
  const accessAttestationBytes = Buffer.from(canonicalJson(accessAttestation), "utf8");
  writeFileSync(
    join(corpusRoot, "set-task-evaluator", "review-access-attestation.v1.json"),
    accessAttestationBytes,
  );
  const response = {
    corpusSetId: "set-task-evaluator",
    reviewRequestHash: review.reviewRequestHash,
    reviewerId: "independent-reviewer",
    providerImplementerId: "provider-implementer",
    annotationsSealedAt: "2026-08-30T01:00:00.000Z",
    providerOutputDisclosedAt: null,
    accessAttestationHash: digest(accessAttestationBytes),
    annotations,
  };
  const submitted = await assembler.submitReview(response);
  assert.equal(submitted.status, "REVIEW_RESPONSE_SEALED");
  await assert.rejects(
    () => assembler.submitReview({ ...response, runtime: {} }),
    (error) => error.code === "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID",
  );
  const assembled = await assembler.assemble({ corpusSetId: "set-task-evaluator" });
  assert.equal(assembled.status, "AWAITING_TASK_EVALUATOR_OUTCOME");
  const sealedBundle = JSON.parse(readFileSync(
    join(corpusRoot, "set-task-evaluator", "sealed-corpus.v1.json"),
    "utf8",
  ));
  const completeRows = sealedBundle.publicManifest.rows
    .filter((row) => row.dumpVerdict === "COMPLETE_SAFE_UNIQUE");
  assert.equal(completeRows.length, 1);
  assert.equal(completeRows[0].provenance.countingEligible, true);
  const completeAnnotation = sealedBundle.annotationManifest.rows.find(
    (row) => `receipt:${row.captureReceiptHash}` === completeRows[0].receiptRef,
  );
  assert.equal(completeAnnotation.expectedOutcome, "NO_FALLBACK_EXPECTED");

  let analyzeCalls = 0;
  const labelByRole = {
    OPEN_CONTENT_CARD: "打开内容卡片安全区",
    OPEN_COMMENT_PANEL: "打开评论面板导航区",
    PAUSE_VIDEO_SAFE_ZONE: "暂停视频安全区",
    BACK: "返回导航区",
  };
  const evaluate = createTaskOwnedCorpusEvaluator({
    captureRoot,
    corpusRoot,
    signingKey: KEY,
    digestKeyId: runtime.digestKeyId,
    expectedRuntime: runtime,
    providerConfig: { provider: PROVIDER },
    analyzerFactory() {
      return {
        async analyze(request) {
          analyzeCalls += 1;
          return [{
            label: labelByRole[request.requestedRole],
            confidence: 0.99,
            bounds: { x: 150, y: 250, w: 50, h: 50 },
          }];
        },
        async close() {},
      };
    },
  });
  for (const field of ["passed", "provider", "runtime", "path", "outcome", "cases"]) {
    await assert.rejects(
      () => evaluate({ corpusSetId: "set-task-evaluator", [field]: true }),
      (error) => error.code === "XHS_V3_TASK_EVALUATOR_REQUEST_INVALID",
    );
  }
  assert.equal(analyzeCalls, 0);
  const evaluated = await evaluate({ corpusSetId: "set-task-evaluator" });
  assert.equal(evaluated.status, "PASS");
  assert.equal(evaluated.providerOracleCaseCount, 2);
  assert.equal(evaluated.adverseMutationCaseCount, 4);
  assert.equal(analyzeCalls, 14, "COMPLETE and adverse mutations never invoke the provider");
  const persisted = JSON.parse(readFileSync(
    join(corpusRoot, "set-task-evaluator", "production-evaluator-outcome.v1.json"),
    "utf8",
  ));
  assert.equal(persisted.providerOracleCases.every((row) => row.passed), true);
  assert.ok(persisted.providerOracleCases.some(
    (row) => row.id === "complete-no-fallback-provider-invocations-0",
  ));
  assert.equal(persisted.adverseMutationCases.every((row) => row.passed), true);
  assert.deepEqual(persisted.safety, {
    socialTransport: 0,
    effectTransport: 0,
    visualIssued: 0,
    visualConsumed: 0,
    visualPhysical: 0,
  });
  await assert.rejects(
    () => evaluate({ corpusSetId: "set-task-evaluator" }),
    (error) => error.code === "XHS_V3_EVALUATOR_OUTCOME_WRITE_FAILED",
  );

  const runRoot = join(root, "runs");
  const acceptanceRoot = join(root, "acceptance");
  mkdirSync(runRoot);
  mkdirSync(acceptanceRoot);
  const taskBinding = Object.freeze({
    taskName: XHS_V3_TASK_NAME,
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
  });
  const runStore = createTaskOwnedRunRecordStore({
    root: runRoot,
    taskBinding,
    runtimeBinding: RUNTIME,
  });
  const build = createBuiltInTaskInvocationBuilder({
    identity: identity(),
    providerBinding: PROVIDER,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const eRef = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "6".repeat(64),
    bindingHash: "7".repeat(64),
    gateEpoch: "8".repeat(64),
    expiresAtMs: 9_999_999_999_999,
  };
  const invocationByPhase = {
    R0: await build("R0"),
    R1: await build("R1"),
    R2: await build("R2"),
    R3: await build("R3", {
      eCorpusPassRef: eRef,
      eCorpusInterlock: {
        verifyR3: ({ ref }) => ({
          ok: true,
          status: "PASS",
          artifactHash: ref.artifactHash,
          effectiveVisualPermitBudget: 1,
        }),
      },
    }),
    R4: await build("R4"),
  };
  function liveResult(phase) {
    const mission = invocationByPhase[phase].plan.mission;
    const authorityId = `authority-${phase.toLowerCase()}`;
    const laneSafety = {
      socialTransport: 0,
      effectTransport: 0,
      visualIssued: 0,
      visualConsumed: 0,
      visualPhysical: 0,
    };
    const caps = Object.fromEntries([
      "reservedPrimitives",
      "novelOpens",
      "resultScreensPerQuery",
      "commentScreens",
      "visionAnalysisAttempts",
      "visionMaxIssuedPermits",
      "visionMaxPhysicalTaps",
    ].map((name) => [name, mission.budgets[name]]));
    const ledgerBody = {
      schemaId: "xw.xhs.exploration-budget-ledger-view.v1",
      authorityId,
      missionHash: mission.missionHash,
      caps,
      rows: [],
      totals: Object.fromEntries(Object.keys(caps).map((name) => [name, 0])),
    };
    const budgetLedger = {
      ...ledgerBody,
      ledgerHash: digest(`${ledgerBody.schemaId}:${canonicalJson(ledgerBody)}`),
    };
    const result = {
      ok: true,
      status: "SUCCEEDED",
      phase,
      authorityId,
      receiptHash: digest(`result:${phase}`),
      providerBundleDigest: RUNTIME.providerBundleDigest,
      children: [
        ["03", "feed_lane"],
        ["04", "search_lane"],
      ].map(([alias, laneRole]) => ({
        alias,
        laneRole,
        status: "COMPLETED",
        committed: true,
        receiptHash: digest(`lane:${phase}:${alias}`),
          receipt: {
            restored: { restored: true },
            safety: laneSafety,
            driver: { consumedPermits: 0, observationCount: 0, claimedTargetCount: 0 },
            state: { novelOpensUsed: 0, commentScreensUsed: 0 },
            budgetReservations: [],
            vision: {
              analysisAttempts: 0,
              permitsIssued: 0,
              permitsConsumed: 0,
              physicalTaps: 0,
          },
        },
      })),
      cleanup: {
        releases: [{ alias: "03", ok: true }, { alias: "04", ok: true }],
        leaseOracle: { checked: true, ok: true, activeLeaseCount: 0 },
        authorityClosed: { ok: true, status: "closed" },
      },
      captureReceiptHashes: hashesByPhase[phase] ?? [],
      safety: {
        socialTransport: 0,
        effectTransport: 0,
        visualIssued: 0,
        visualConsumed: 0,
        visualPhysical: 0,
      },
      view: {
        budgetLedger,
        visionCounters: {
          analysisAttempts: 0,
          permitsIssued: 0,
          permitsConsumed: 0,
          physicalTaps: 0,
        },
      },
    };
    result.sharedBudget = deriveSharedExplorationBudgetProof({
      phase,
      authorityId,
      missionHash: mission.missionHash,
      children: result.children,
      budgetLedger,
      visionCounters: result.view.visionCounters,
    });
    return result;
  }
  const results = {
    R0: {
      ok: true,
      phase: "R0",
      status: "SUCCEEDED",
      captureMode: "OFFLINE_FIXTURE_ONLY",
      resources: { jobs: 0, sessions: 0, leases: 0, deviceIo: 0 },
      receiptHash: digest("r0"),
    },
    R1: liveResult("R1"),
    R2: liveResult("R2"),
    R3: liveResult("R3"),
    R4: liveResult("R4"),
  };
  for (const phase of ["R0", "R1", "R2", "R3", "R4"]) {
    await runStore.persist({
      phase,
      invocationId: `acceptance-${phase.toLowerCase()}`,
      invocation: invocationByPhase[phase],
      result: results[phase],
    });
  }
  let eCorpusVerificationCalls = 0;
  const verifyECorpusPass = async (ref) => {
    eCorpusVerificationCalls += 1;
    assert.deepEqual(ref, eRef);
    return {
      ok: true,
      status: "PASS",
      artifactHash: ref.artifactHash,
      ref,
      binding: {
        releaseId: RUNTIME.releaseId,
        sourceCommit: RUNTIME.sourceCommit,
        providerBundleDigest: RUNTIME.providerBundleDigest,
        corpusManifestHash: "a".repeat(64),
        privateIndexDigest: "b".repeat(64),
        evaluatorSourceHash: "c".repeat(64),
        testReportHash: "d".repeat(64),
        digestKeyId: RUNTIME.digestKeyId,
        gateEpoch: eRef.gateEpoch,
      },
      owner: taskBinding,
      effectiveVisualPermitBudget: 1,
    };
  };
  const closeout = createTaskOwnedP6Closeout({
    runRecordStore: runStore,
    captureRoot,
    acceptanceRoot,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
    verifyECorpusPass,
    now: () => 1_000,
  });
  const partial = await closeout({ runSetId: "missing" });
  assert.equal(partial.status, "CLOSEOUT_PARTIAL");
  assert.ok(partial.blockers.some((row) => row.startsWith("R0:RUN_RECORD")));
  const forgedECorpusCloseout = createTaskOwnedP6Closeout({
    runRecordStore: runStore,
    captureRoot,
    acceptanceRoot,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
    verifyECorpusPass: async () => { throw new Error("forged E-PASS"); },
    now: () => 1_000,
  });
  const forged = await forgedECorpusCloseout({ runSetId: "acceptance" });
  assert.equal(forged.status, "CLOSEOUT_PARTIAL");
  assert.ok(forged.blockers.includes("R3:E_CORPUS_PASS_INVALID"));
  for (const phase of ["R0", "R1", "R2", "R3", "R4"]) {
    const result = structuredClone(results[phase]);
    if (phase === "R4") result.sharedBudget.used.novelOpens = result.sharedBudget.caps.novelOpens + 1;
    await runStore.persist({
      phase,
      invocationId: `forged-budget-${phase.toLowerCase()}`,
      invocation: invocationByPhase[phase],
      result,
    });
  }
  const forgedBudget = await closeout({ runSetId: "forged-budget" });
  assert.equal(forgedBudget.status, "CLOSEOUT_PARTIAL");
  assert.ok(forgedBudget.blockers.includes("R4:SHARED_BUDGET_PROOF_INVALID"));
  const pass = await closeout({ runSetId: "acceptance" });
  assert.deepEqual(pass, {
    status: "PASS",
    verified: true,
    artifactHash: pass.artifactHash,
    verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
  });
  assert.match(pass.artifactHash, /^[0-9a-f]{64}$/u);
  const locator = JSON.parse(readFileSync(join(acceptanceRoot, "p6-current.v1.json"), "utf8"));
  assert.equal(locator.artifactHash, pass.artifactHash);
  const artifact = JSON.parse(readFileSync(
    join(acceptanceRoot, locator.relativePath),
    "utf8",
  ));
  assert.equal(artifact.XHS_V3_FREE_EXPLORATION_VERIFIED, true);
  assert.equal(artifact.verificationMarker, "XHS_V3_FREE_EXPLORATION_VERIFIED=true");
  assert.equal(artifact.runtime.accountFingerprint, RUNTIME.accountFingerprint);
  assert.deepEqual(artifact.placement.aliases, ["03", "04"]);
  assert.equal(Object.values(artifact.coverage.distinctFramesByRoute).every((count) => count >= 3), true);
  assert.equal(artifact.sharedBudgets.R4.used.totalSteps, 0);
  assert.match(artifact.sharedBudgets.R4.proofHash, /^[0-9a-f]{64}$/u);
  const restartedCloseout = createTaskOwnedP6Closeout({
    runRecordStore: runStore,
    captureRoot,
    acceptanceRoot,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
    verifyECorpusPass,
    now: () => 9_999,
  });
  const reproduced = await restartedCloseout({ runSetId: "acceptance" });
  assert.equal(reproduced.artifactHash, pass.artifactHash, "restart reproduces the immutable current PASS");
  assert.equal(eCorpusVerificationCalls, 3, "every otherwise-complete closeout re-verifies the persisted E artifact");
});

test("deployed R0 fixture executes the immutable exact-pair oracle with zero live resources", async () => {
  const run = createDeployedR0FixtureRunner({
    runtimeBinding: RUNTIME,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const result = await run();
  assert.equal(result.status, "PASS");
  assert.equal(result.captureMode, "OFFLINE_FIXTURE_ONLY");
  assert.deepEqual(result.resources, { jobs: 0, sessions: 0, leases: 0, deviceIo: 0 });
});

test("listener bootstrap rejects every caller-selected surface before loader/runner/resource work", async () => {
  let loads = 0;
  let runs = 0;
  let sealers = 0;
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { async run() { runs += 1; return { ok: true, safe: true }; } },
    async loadTaskInvocation() { loads += 1; return invocation(); },
    async createCorpusSealer() { sealers += 1; throw new Error("must not be reached"); },
    assertGateFReady: async () => true,
  });

  const forbidden = [
    { phase: "R1", invocationId: "inv-1", goal: "caller" },
    { phase: "R1", invocationId: "inv-1", query: "caller" },
    { phase: "R1", invocationId: "inv-1", path: "C:\\caller" },
    { phase: "R1", invocationId: "inv-1", endpoint: "http://127.0.0.1:9" },
    { phase: "R1", invocationId: "inv-1", alias: "03" },
    { phase: "R2", invocationId: "inv-1", provider: {} },
    { phase: "R2", invocationId: "inv-1", role: "OPEN_CONTENT_CARD" },
    { phase: "R3", invocationId: "inv-1", eCorpus: {} },
  ];
  for (const body of forbidden) {
    await assert.rejects(
      () => bootstrap.runTask(body),
      (error) => error.code === "XHS_V3_TASK_REQUEST_INVALID",
    );
  }
  assert.equal(loads, 0);
  assert.equal(runs, 0);
  assert.equal(sealers, 0);

  const result = await bootstrap.runTask({ phase: "R0", invocationId: "inv-1" });
  assert.deepEqual(result, { ok: true, safe: true });
  assert.equal(loads, 1);
  assert.equal(runs, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE_SECRET), false);
});

test("completed task replay returns the exact persisted result before a second R4 resource wave", async () => {
  const sealedInvocation = invocation({ mission: { vision: { rolloutPhase: "R4", eCorpusPassRef: null } } });
  let persisted = null;
  let postERuns = 0;
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { run: async () => { throw new Error("R0-R2 runner must not execute"); } },
    loadTaskInvocation: async () => sealedInvocation,
    runRecordStore: {
      async loadIfPresent() { return persisted; },
      async loadAttemptIfPresent() { return null; },
      async beginAttempt({ phase, invocationId }) {
        return { phase, invocationId, attemptHash: "c".repeat(64), created: true };
      },
      async persist({ phase, invocationId, invocation: value, result }) {
        persisted = {
          record: {
            phase,
            invocationId,
            invocationHash: digest(canonicalJson(value)),
            result,
          },
          runRecordHash: "e".repeat(64),
        };
        return { phase, invocationId, runRecordHash: persisted.runRecordHash };
      },
    },
    createCorpusSealer: async () => { throw new Error("corpus sealer must not execute"); },
    postECorpusRunner: {
      async run() {
        postERuns += 1;
        return { ok: true, status: "SUCCEEDED", phase: "R4", receiptHash: "d".repeat(64) };
      },
    },
    assertGateFReady: async () => true,
  });
  const first = await bootstrap.runTask({ phase: "R4", invocationId: "rpa-replay-r4" });
  const replay = await bootstrap.runTask({ phase: "R4", invocationId: "rpa-replay-r4" });
  assert.deepEqual(replay, first);
  assert.equal(postERuns, 1, "persisted task result closes the post-R4/WorkReceipt replay window");
});

test("seal-e-corpus accepts no caller-minted binding/bundle/path/provider/runtime/gate epoch", async () => {
  const now = 10_000;
  let sealerCalls = 0;
  const ref = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "6".repeat(64),
    bindingHash: "7".repeat(64),
    gateEpoch: "8".repeat(64),
    expiresAtMs: now + 3_600_000,
  };
  const registry = {
    async sealPass(input) {
      sealerCalls += 1;
      assert.deepEqual(input, { expiresAtMs: now + 3_600_000 });
      return { ref, evaluation: { testReportHash: "9".repeat(64) }, path: `C:\\private\\${PRIVATE_SECRET}` };
    },
    createInterlock() { return { verifyR3: () => ({ ok: true }) }; },
  };
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { run: async () => ({ ok: true }) },
    loadTaskInvocation: async () => invocation(),
    createCorpusSealer: async (id) => {
      assert.equal(id, "set-001");
      return registry;
    },
    assertGateFReady: async () => true,
    now: () => now,
  });
  for (const field of ["binding", "bundle", "path", "provider", "runtime", "gateEpoch", "labels", "receipts"]) {
    await assert.rejects(
      () => bootstrap.sealECorpus({ corpusSetId: "set-001", expiryPolicy: "GATE_F_SHORT", [field]: {} }),
      (error) => error.code === "XHS_V3_E_CORPUS_REQUEST_INVALID",
    );
  }
  assert.equal(sealerCalls, 0);
  const sealed = await bootstrap.sealECorpus({ corpusSetId: "set-001", expiryPolicy: "GATE_F_SHORT" });
  assert.equal(sealed.status, "PASS");
  assert.equal("path" in sealed, false);
  assert.equal(JSON.stringify(sealed).includes(PRIVATE_SECRET), false);
  assert.equal(sealerCalls, 1);
});

test("locator pair retry completes exact publication after the first locator survived a crash", (t) => {
  const root = tempRoot(t);
  const artifactRoot = join(root, "artifacts");
  const corpusSetRoot = join(root, "corpus-sets");
  const artifactHash = "a".repeat(64);
  const corpusSetId = "set-locator-crash";
  mkdirSync(join(artifactRoot, artifactHash), { recursive: true });
  mkdirSync(join(corpusSetRoot, corpusSetId), { recursive: true });
  const body = {
    schemaId: "xw.xhs.e-corpus-seal-locator.v1",
    schemaVersion: 1,
    corpusSetId,
    expiryPolicy: "GATE_F_SHORT",
    runtime: { releaseId: "release-a" },
    taskOwner: { taskName: XHS_V3_TASK_NAME },
    gateEpoch: "b".repeat(64),
    ref: { artifactHash },
    binding: { gateEpoch: "b".repeat(64) },
    testReportHash: "c".repeat(64),
  };
  const locator = Object.freeze({
    ...body,
    locatorHash: digest(canonicalJson(body)),
  });
  let writes = 0;
  const failingFs = {
    existsSync,
    lstatSync,
    readFileSync,
    realpathSync,
    writeFileSync(path, bytes, options) {
      writes += 1;
      if (writes === 2) {
        throw Object.assign(new Error("simulated crash before corpus locator"), { code: "EIO" });
      }
      return writeFileSync(path, bytes, options);
    },
  };
  assert.throws(
    () => persistTaskOwnedECorpusLocatorPair({
      locator, artifactRoot, corpusSetRoot, fsImpl: failingFs,
    }),
    (error) => error.code === "XHS_V3_E_CORPUS_LOCATOR_WRITE_FAILED",
  );
  const completed = persistTaskOwnedECorpusLocatorPair({
    locator, artifactRoot, corpusSetRoot,
  });
  assert.equal(readFileSync(completed.artifactLocatorPath, "utf8"), canonicalJson(locator));
  assert.equal(readFileSync(completed.corpusLocatorPath, "utf8"), canonicalJson(locator));
});

test("R3/R4 adapter seam reopens the exact persisted E artifact instead of process-local latest", async () => {
  const ref = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "a".repeat(64),
    bindingHash: "b".repeat(64),
    gateEpoch: "c".repeat(64),
    expiresAtMs: 3_610_000,
  };
  const seen = [];
  const adapter = createPostECorpusRoutineAdapter({
    async runR3(input) { seen.push(input); return { ok: true, phase: "R3" }; },
    async runR4(input) { seen.push(input); return { ok: true, phase: "R4" }; },
  });
  let persisted = false;
  const interlock = Object.freeze({
    owner: "task",
    verifyR3: ({ ref: candidate }) => ({
      ok: true, status: "PASS", artifactHash: candidate.artifactHash,
    }),
  });
  const registry = {
    async sealPass() {
      persisted = true;
      return { ref, evaluation: { testReportHash: "d".repeat(64) } };
    },
  };
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { run: async () => ({ ok: true }) },
    loadTaskInvocation: async (id) => invocation({
      mission: { vision: {
        rolloutPhase: id === "inv-r4" ? "R4" : "R3",
        eCorpusPassRef: id === "inv-r4" ? null : ref,
      } },
    }),
    createCorpusSealer: async () => registry,
    openECorpusArtifact(artifactHash) {
      if (!persisted || artifactHash !== ref.artifactHash) {
        throw Object.assign(new Error("absent"), { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" });
      }
      return { ref, interlock, verification: {
        status: "PASS", artifactHash: ref.artifactHash,
      } };
    },
    assertGateFReady: async () => true,
    postECorpusRunner: adapter,
    now: () => 10_000,
  });
  await assert.rejects(
    () => bootstrap.runTask({ phase: "R3", invocationId: "inv-r3" }),
    (error) => error.code === "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED",
  );
  await bootstrap.sealECorpus({ corpusSetId: "set-001", expiryPolicy: "GATE_F_SHORT" });
  assert.deepEqual(await bootstrap.runTask({ phase: "R3", invocationId: "inv-r3" }), { ok: true, phase: "R3" });
  assert.equal(seen[0].eCorpusInterlock.owner, "task");
  assert.deepEqual(await bootstrap.runTask({ phase: "R4", invocationId: "inv-r4" }), { ok: true, phase: "R4" });
  assert.equal(seen[1].eCorpusInterlock, null);
});

test("missing post-E adapter fails before a durable attempt is created", async () => {
  let attemptCalls = 0;
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { run: async () => { throw new Error("runner must not execute"); } },
    loadTaskInvocation: async () => invocation({
      mission: { vision: { rolloutPhase: "R4", eCorpusPassRef: null } },
    }),
    runRecordStore: {
      ...UNUSED_PREPARATION.runRecordStore,
      async beginAttempt() {
        attemptCalls += 1;
        throw new Error("attempt must not be created");
      },
    },
    createCorpusSealer: async () => { throw new Error("sealer must not execute"); },
    assertGateFReady: async () => true,
  });
  await assert.rejects(
    () => bootstrap.runTask({ phase: "R4", invocationId: "no-post-e" }),
    (error) => error.code === "XHS_V3_POST_E_CORPUS_RUNNER_UNAVAILABLE",
  );
  assert.equal(attemptCalls, 0);
});

test("evaluator outcome schema identifier is stable and contains no dynamic execution surface", () => {
  assert.equal(XHS_V3_TASK_EVALUATOR_OUTCOME_SCHEMA_ID, "xw.xhs.v3-task-evaluator-outcome.v1");
  const source = readFileSync(new URL("../scripts/lib/xhs-v3-task-bootstrap.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createFixedXhsV3TaskBootstrap\(\{[^}]*?(?:path|endpoint|alias|provider|role)/su);
});

test("every valid run/seal rechecks exact CLOSED Gate F before invocation, sealer, or device work", async () => {
  const closed = {
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: "CLOSED",
    phase: "CLOSED",
    purpose: null,
    epochHash: "1".repeat(64),
    generation: 0,
    locksHash: "2".repeat(64),
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 0,
    actionCount: 0,
    resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
  };
  assert.deepEqual(assertXhsV3GateFReadySnapshot(closed), {
    epochHash: closed.epochHash,
    generation: 0,
    locksHash: closed.locksHash,
  });
  for (const drift of [
    { mode: "OBSERVE_ONLY", phase: "GROUNDING_ONLY" },
    { tripleConsistent: false },
    { resourceCounts: { jobs: 0, leases: 1, runs: 0, sessions: 0 } },
    { actionCount: 1 },
    { errors: [{ code: "DRIFT" }] },
  ]) {
    assert.throws(
      () => assertXhsV3GateFReadySnapshot({ ...closed, ...drift }),
      (error) => error.code === "XHS_V3_GATE_F_NOT_READY",
    );
  }

  let invocationLoads = 0;
  let deviceCalls = 0;
  let sealerCalls = 0;
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { async run() { deviceCalls += 1; return { ok: true }; } },
    async loadTaskInvocation() { invocationLoads += 1; return invocation(); },
    async createCorpusSealer() { sealerCalls += 1; return null; },
    assertGateFReady: async () => assertXhsV3GateFReadySnapshot({
      ...closed,
      mode: "OBSERVE_ONLY",
      phase: "GROUNDING_ONLY",
    }),
  });
  await assert.rejects(
    () => bootstrap.runTask({ phase: "R1", invocationId: "inv-closed" }),
    (error) => error.code === "XHS_V3_GATE_F_NOT_READY",
  );
  await assert.rejects(
    () => bootstrap.sealECorpus({ corpusSetId: "set-closed", expiryPolicy: "GATE_F_SHORT" }),
    (error) => error.code === "XHS_V3_GATE_F_NOT_READY",
  );
  assert.deepEqual({ invocationLoads, deviceCalls, sealerCalls }, {
    invocationLoads: 0,
    deviceCalls: 0,
    sealerCalls: 0,
  });
});

test("a listener restart reopens the same persisted exact E artifact without reseal", async () => {
  const ref = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "e".repeat(64),
    bindingHash: "f".repeat(64),
    gateEpoch: "1".repeat(64),
    expiresAtMs: 3_610_000,
  };
  let persisted = false;
  let openCalls = 0;
  const interlock = { verifyR3: ({ ref: candidate }) => ({
    ok: true, status: "PASS", artifactHash: candidate.artifactHash,
  }) };
  const registry = { sealPass: async () => {
    persisted = true;
    return { ref, evaluation: { testReportHash: "2".repeat(64) } };
  } };
  function freshBootstrap() {
    return createXhsV3TaskBootstrap({
      ...UNUSED_PREPARATION,
      runner: { run: async () => ({ ok: true }) },
      loadTaskInvocation: async () => invocation({
        mission: { vision: { rolloutPhase: "R3", eCorpusPassRef: ref } },
      }),
      createCorpusSealer: async () => registry,
      openECorpusArtifact(artifactHash) {
        openCalls += 1;
        if (!persisted || artifactHash !== ref.artifactHash) {
          throw Object.assign(new Error("absent"), { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" });
        }
        return { ref, interlock, verification: {
          status: "PASS", artifactHash: ref.artifactHash,
        } };
      },
      assertGateFReady: async () => true,
      postECorpusRunner: createPostECorpusRoutineAdapter({
        runR3: async () => ({ ok: true }),
        runR4: async () => ({ ok: true }),
      }),
      now: () => 10_000,
    });
  }
  const first = freshBootstrap();
  await first.sealECorpus({ corpusSetId: "set-restart", expiryPolicy: "GATE_F_SHORT" });
  assert.deepEqual(await first.runTask({ phase: "R3", invocationId: "inv-r3" }), { ok: true });
  const restarted = freshBootstrap();
  assert.deepEqual(
    await restarted.runTask({ phase: "R3", invocationId: "inv-r3-after-restart" }),
    { ok: true },
  );
  assert.equal(openCalls, 2, "each listener lifetime reopened the content-addressed artifact");
});

test("R3 prepare binds the event hash exactly across interleaved run sets", async () => {
  const refs = new Map([
    ["a".repeat(64), Object.freeze({
      schemaId: "xw.xhs.e-corpus-pass-ref.v1",
      artifactHash: "a".repeat(64),
      bindingHash: "1".repeat(64),
      gateEpoch: "2".repeat(64),
      expiresAtMs: 3_610_000,
    })],
    ["b".repeat(64), Object.freeze({
      schemaId: "xw.xhs.e-corpus-pass-ref.v1",
      artifactHash: "b".repeat(64),
      bindingHash: "3".repeat(64),
      gateEpoch: "4".repeat(64),
      expiresAtMs: 3_610_000,
    })],
  ]);
  const invocations = new Map();
  const seen = [];
  const openCounts = new Map();
  const bootstrap = createXhsV3TaskBootstrap({
    ...UNUSED_PREPARATION,
    runner: { run: async () => ({ ok: true }) },
    async buildTaskInvocation(phase, context) {
      assert.equal(phase, "R3");
      return invocation({ mission: { vision: {
        rolloutPhase: "R3",
        eCorpusPassRef: context.eCorpusPassRef,
      } } });
    },
    async persistTaskInvocation({ phase, invocationId, value }) {
      invocations.set(invocationId, value);
      return { phase, invocationId, invocationHash: digest(canonicalJson(value)) };
    },
    loadTaskInvocation: async (id) => invocations.get(id),
    createCorpusSealer: async () => { throw new Error("seal must not execute"); },
    openECorpusArtifact(artifactHash) {
      const ref = refs.get(artifactHash);
      if (!ref) throw Object.assign(new Error("absent"), { code: "XHS_V3_E_CORPUS_PASS_NOT_TASK_OWNED" });
      openCounts.set(artifactHash, (openCounts.get(artifactHash) ?? 0) + 1);
      return {
        ref,
        interlock: {
          artifactHash,
          verifyR3: ({ ref: candidate }) => ({
            ok: true, status: "PASS", artifactHash: candidate.artifactHash,
          }),
        },
        verification: { status: "PASS", artifactHash },
      };
    },
    postECorpusRunner: createPostECorpusRoutineAdapter({
      async runR3(input) {
        seen.push(input.eCorpusInterlock.artifactHash);
        return { ok: true, phase: "R3" };
      },
      async runR4() { throw new Error("R4 must not execute"); },
    }),
    assertGateFReady: async () => true,
  });
  await assert.rejects(
    () => bootstrap.prepareInvocation({ phase: "R3", invocationId: "run-a-r3" }),
    (error) => error.code === "XHS_V3_TASK_PREPARE_REQUEST_INVALID",
  );
  await assert.rejects(
    () => bootstrap.prepareInvocation({
      phase: "R4", invocationId: "run-r4", eCorpusArtifactHash: "a".repeat(64),
    }),
    (error) => error.code === "XHS_V3_TASK_PREPARE_REQUEST_INVALID",
  );
  await bootstrap.prepareInvocation({
    phase: "R3", invocationId: "run-a-r3", eCorpusArtifactHash: "a".repeat(64),
  });
  await bootstrap.prepareInvocation({
    phase: "R3", invocationId: "run-b-r3", eCorpusArtifactHash: "b".repeat(64),
  });
  await bootstrap.runTask({ phase: "R3", invocationId: "run-a-r3" });
  await bootstrap.runTask({ phase: "R3", invocationId: "run-b-r3" });
  assert.deepEqual(seen, ["a".repeat(64), "b".repeat(64)]);
  assert.equal(openCounts.get("a".repeat(64)), 2, "A is reopened at prepare and run");
  assert.equal(openCounts.get("b".repeat(64)), 2, "B is reopened at prepare and run");
});

test("durable AMBIGUOUS attempt is sealed before R3 I/O and blocks restart replay", async (t) => {
  const root = tempRoot(t);
  const runRoot = join(root, "runs");
  mkdirSync(runRoot);
  const taskBinding = Object.freeze({
    taskName: XHS_V3_TASK_NAME,
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
  });
  const runRecordStore = createTaskOwnedRunRecordStore({
    root: runRoot,
    taskBinding,
    runtimeBinding: RUNTIME,
  });
  const ref = Object.freeze({
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "c".repeat(64),
    bindingHash: "d".repeat(64),
    gateEpoch: "e".repeat(64),
    expiresAtMs: Date.now() + 60_000,
  });
  const interlock = { verifyR3: ({ ref: candidate }) => ({
    ok: true, status: "PASS", artifactHash: candidate.artifactHash,
    effectiveVisualPermitBudget: 1,
  }) };
  const build = createBuiltInTaskInvocationBuilder({
    identity: identity(),
    providerBinding: PROVIDER,
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const sealedInvocation = await build("R3", {
    eCorpusPassRef: ref,
    eCorpusInterlock: interlock,
  });
  let physicalRuns = 0;
  function freshBootstrap() {
    return createXhsV3TaskBootstrap({
      ...UNUSED_PREPARATION,
      runner: { run: async () => { throw new Error("R0-R2 must not execute"); } },
      loadTaskInvocation: async () => sealedInvocation,
      runRecordStore,
      createCorpusSealer: async () => { throw new Error("seal must not execute"); },
      openECorpusArtifact: () => ({
        ref,
        interlock,
        verification: { status: "PASS", artifactHash: ref.artifactHash },
      }),
      postECorpusRunner: createPostECorpusRoutineAdapter({
        async runR3() {
          physicalRuns += 1;
          assert.notEqual(await runRecordStore.loadAttemptIfPresent({
            phase: "R3", invocationId: "crash-r3",
          }), null, "attempt is durable before physical runner entry");
          throw new Error("simulated-listener-crash-after-io");
        },
        async runR4() { throw new Error("R4 must not execute"); },
      }),
      assertGateFReady: async () => true,
    });
  }
  await assert.rejects(
    () => freshBootstrap().runTask({ phase: "R3", invocationId: "crash-r3" }),
    /simulated-listener-crash-after-io/u,
  );
  await assert.rejects(
    () => freshBootstrap().runTask({ phase: "R3", invocationId: "crash-r3" }),
    (error) => error.code === "XHS_V3_TASK_RUN_AMBIGUOUS",
  );
  assert.equal(physicalRuns, 1, "restart cannot issue a second physical R3 wave");
});
