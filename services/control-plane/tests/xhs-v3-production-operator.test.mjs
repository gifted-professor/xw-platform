import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalXhsV3FixedOperatorJson, createXhsV3FixedOperatorRequestSigner } from
  "../control-plane/lib/xhs-v3-fixed-operator-auth.mjs";
import {
  XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
  XHS_V3_PROVIDER_IMPLEMENTER_ID,
  createXhsV3ProductionOperatorForTest,
  parseXhsV3ProductionOperatorCommand,
  validateXhsV3BlindReviewHumanResponse,
} from "../ops/xhs-v3-production-operator.mjs";

const BINDING = Object.freeze({
  releaseId: "xw-xhs-v3-final-test",
  sourceCommit: "a".repeat(40),
  operatorSha256: "b".repeat(64),
});
const GATE_TOKEN = "gate-f-test-token-0123456789abcdef0123456789";
const LIVE_TOKEN = "live-entry-test-token-0123456789abcdef01234567";
const PROGRAM_ID = "xrp_explore_foundation";
const TEST_FRAME = Buffer.from("fixed blind review frame bytes", "utf8");

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pretty(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCanonical(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalXhsV3FixedOperatorJson(value));
}

function gate() {
  return {
    schemaId: "xw.m6-gate-f-operations-status.v1",
    mode: "CLOSED",
    phase: "CLOSED",
    purpose: null,
    epochHash: "c".repeat(64),
    generation: 7,
    locksHash: "d".repeat(64),
    tripleConsistent: true,
    errors: [],
    activeAuthorizationCount: 0,
    actionCount: 0,
    resourceCounts: { jobs: 0, leases: 0, runs: 0, sessions: 0 },
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noOpAcl() {
  return {
    protect() { return { ok: true }; },
    verify() { return { ok: true }; },
  };
}

function noOpReviewAcl(stats = {}) {
  const receipt = (operation) => ({
    ok: true,
    schemaId: "xw.xhs.v3-blind-review-acl-receipt.v1",
    operation,
    reviewerPrincipalHash: "a".repeat(64),
    workspaceAclHash: "b".repeat(64),
    isolationAclHash: "c".repeat(64),
    networkPolicyHash: "e".repeat(64),
    entryCount: 7,
    providerOutputAccess: "DENIED_BY_ACL",
    implementationAnswerAccess: "DENIED_BY_ACL",
    networkAccess: "DENIED_BY_FIXED_OFFLINE_ACCOUNT",
    receiptHash: "d".repeat(64),
  });
  return {
    protect() { stats.protect = (stats.protect || 0) + 1; return receipt("protect-and-verify"); },
    verify() { stats.verify = (stats.verify || 0) + 1; return receipt("verify"); },
    restore() { stats.restore = (stats.restore || 0) + 1; return { restoredSourceAclHash: "f".repeat(64) }; },
    close() {
      stats.close = (stats.close || 0) + 1;
      return { restoredSourceAclHash: "f".repeat(64), closedWorkspaceAclHash: "9".repeat(64) };
    },
    admitResponse(plan, binding) {
      stats.admit = (stats.admit || 0) + 1;
      const finalPath = join(plan.inboxRoot, `${binding.responseHash}.review-response.v1.json`);
      if (!existsSync(finalPath)) {
        writeFileSync(finalPath, readFileSync(join(plan.workspaceRoot, "human-response.draft.v1.json")), {
          flag: "wx", flush: true,
        });
      }
      writeFileSync(join(plan.inboxRoot, `${binding.sessionId}.admission-receipt.v1.json`), "{}\n");
      return {
        schemaId: "xw.xhs.v3-blind-review-admission.v1", schemaVersion: 1, ...binding,
        callerPrincipalHash: "a".repeat(64), isolationProbeHash: "f".repeat(64),
        taskExecutionHash: "8".repeat(64),
      };
    },
  };
}

function requestValue(root, corpusSetId = "corpus-001", dumpVerdict = "AMBIGUOUS_SAFE") {
  return {
    schemaId: "xw.xhs.v3-corpus-review-request.v1",
    schemaVersion: 1,
    corpusSetId,
    runtime: {
      releaseId: BINDING.releaseId,
      sourceCommit: BINDING.sourceCommit,
      providerBundleDigest: "e".repeat(64),
      digestKeyId: "key-01",
    },
    receipts: [{
      captureReceiptHash: "1".repeat(64),
      captureMode: "CP_BOUND_R1_R2",
      phase: "R1",
      pageClass: "HOME_FEED",
      evaluationRole: "OPEN_CONTENT_CARD",
      dumpVerdict,
      pngHash: hash(TEST_FRAME),
      alias: "03",
      laneRole: "FEED",
    }],
  };
}

function fixture(t, { intercept = null, operatorOptions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "xhs-fixed-operator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "private", "xhs-v3", "acceptance"), { recursive: true });
  mkdirSync(join(root, "private", "xhs-v3", "corpus-sets"), { recursive: true });
  mkdirSync(join(root, "private", "xhs-v3", "captures"), { recursive: true });
  const reviewRoot = join(root, "blind-review");
  let nowMs = 1_800_000_000_000;
  let nonce = 0;
  const signer = createXhsV3FixedOperatorRequestSigner({
    liveEntryToken: LIVE_TOKEN,
    binding: BINDING,
    now: () => nowMs,
    nonceFactory: () => (++nonce).toString(16).padStart(32, "0"),
  });
  const calls = [];
  const rpaProgram = Object.freeze({
    programId: PROGRAM_ID,
    generation: 1,
    programHash: "e".repeat(64),
    taskPlanHash: "9".repeat(64),
    enabled: false,
    recurringEnabled: false,
    runtime: { releaseId: BINDING.releaseId, sourceCommit: BINDING.sourceCommit },
  });
  let rpaLedger = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body, headers: options.headers });
    if (intercept) {
      const intercepted = await intercept({ path, body, options, root, calls });
      if (intercepted !== undefined) return intercepted;
    }
    if (path.endsWith("/gate-f/status")) return response({ gate: gate() });
    if (path === "/control/v1/health") return response({
      releaseId: BINDING.releaseId,
      sourceCommit: BINDING.sourceCommit,
      m6RuntimeMode: "FINAL",
      xhsV3TaskBootstrap: { taskOwned: true, status: "READY_R0_R4" },
    });
    if (path.endsWith("/rpa/health")) return response({
      rpa: { status: "READY_DISABLED", RPA_RECURRING_ENABLED: false },
    });
    if (path.endsWith("/prepare-invocation")) return response({
      invocation: {
        ok: true,
        phase: body.phase,
        invocationId: body.invocationId,
        invocationHash: hash(Buffer.from(body.invocationId)),
      },
    }, 201);
    if (path.endsWith("/exploration/run")) return response({
      run: {
        ok: true,
        status: "SUCCEEDED",
        phase: body.phase,
        receiptHash: hash(Buffer.from(`receipt:${body.invocationId}`)),
        captureReceiptHashes: ["3".repeat(64)],
      },
    });
    if (path.endsWith("/prepare-corpus-review")) {
      const request = requestValue(root, body.corpusSetId);
      const bytes = Buffer.from(JSON.stringify(request), "utf8");
      const setRoot = join(root, "private", "xhs-v3", "corpus-sets", body.corpusSetId);
      mkdirSync(setRoot, { recursive: false });
      writeFileSync(join(setRoot, "review-request.v1.json"), bytes);
      const captureRoot = join(root, "private", "xhs-v3", "captures", request.receipts[0].captureReceiptHash);
      mkdirSync(captureRoot, { recursive: true });
      writeFileSync(join(captureRoot, "frame.png"), TEST_FRAME);
      return response({ review: {
        corpusSetId: body.corpusSetId,
        reviewRequestHash: hash(bytes),
        receiptCount: 1,
        privateMaterial: "TASK_OWNED_OFFLINE_REVIEW_REQUIRED",
      } }, 201);
    }
    if (path.endsWith("/submit-corpus-review")) {
      assert.equal(body.providerImplementerId, XHS_V3_PROVIDER_IMPLEMENTER_ID);
      assert.equal(body.providerOutputDisclosedAt, null);
      assert.match(body.accessAttestationHash, /^[0-9a-f]{64}$/u);
      return response({ review: {
        corpusSetId: body.corpusSetId,
        reviewResponseHash: "4".repeat(64),
        annotationCount: body.annotations.length,
        status: "REVIEW_RESPONSE_SEALED",
      } }, 201);
    }
    if (path.endsWith("/assemble-corpus-set")) return response({ corpus: {
      corpusSetId: body.corpusSetId,
      sealedCorpusHash: "5".repeat(64),
      countingRows: 1,
      status: "AWAITING_TASK_EVALUATOR_OUTCOME",
    } }, 201);
    if (path.endsWith("/evaluate-corpus-set")) return response({ evaluator: {
      corpusSetId: body.corpusSetId,
      status: "PASS",
      evaluatorOutcomeHash: "6".repeat(64),
      providerOracleCaseCount: 1,
      adverseMutationCaseCount: 4,
    } }, 201);
    if (path.endsWith("/seal-e-corpus")) return response({ eCorpus: {
      ok: true,
      status: "PASS",
      ref: { artifactHash: "7".repeat(64) },
      testReportHash: "8".repeat(64),
    } });
    if (path.endsWith("/closeout-p6")) {
      const artifact = {
        schemaId: "xw.xhs.v3-free-exploration-pass.v1",
        status: "PASS",
        verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
        XHS_V3_FREE_EXPLORATION_VERIFIED: true,
        runSetId: body.runSetId,
        runtime: { releaseId: BINDING.releaseId, sourceCommit: BINDING.sourceCommit },
      };
      const bytes = Buffer.from(JSON.stringify(artifact), "utf8");
      const artifactHash = hash(bytes);
      const acceptance = join(root, "private", "xhs-v3", "acceptance");
      const artifactPath = join(acceptance, "p6-artifacts", artifactHash, "xhs-v3-p6-pass.v1.json");
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, bytes);
      writeFileSync(join(acceptance, "p6-current.v1.json"), JSON.stringify({
        schemaId: "xw.xhs.v3-p6-current.v1",
        schemaVersion: 1,
        artifactHash,
        artifactSchemaId: artifact.schemaId,
        relativePath: `p6-artifacts/${artifactHash}/xhs-v3-p6-pass.v1.json`,
      }));
      return response({ closeout: {
        status: "PASS",
        verified: true,
        artifactHash,
        verificationMarker: artifact.verificationMarker,
      } }, 201);
    }
    if (path.endsWith("/rpa/plan")) return response({ plan: {
      program: rpaProgram,
      lowering: {},
      stateMutations: 0,
      ioOperations: 0,
      recurringEnabled: false,
    } });
    if (path.endsWith("/rpa/status")) return response({ rpa: {
      programId: PROGRAM_ID,
      sealStatus: "SEALED",
      blockers: [],
      sealedProgramId: PROGRAM_ID,
      sealedGeneration: 1,
      generation: rpaLedger?.generation ?? 1,
      programHash: rpaProgram.programHash,
      taskPlanHash: rpaProgram.taskPlanHash,
      releaseId: BINDING.releaseId,
      sourceCommit: BINDING.sourceCommit,
      registered: rpaLedger !== null,
      disabled: rpaLedger?.disabledAtMs != null,
      disabledAtMs: rpaLedger?.disabledAtMs ?? null,
      ledger: rpaLedger,
      activeTickCount: 0,
      recoveryRequired: false,
      recoveryComplete: true,
      recurringEnabled: false,
    } });
    if (path.endsWith("/rpa/disable")) {
      if (rpaLedger === null) return response({ error: { code: "XHS_RPA_PROGRAM_NOT_REGISTERED" } }, 409);
      if (rpaLedger.disabledAtMs === null) {
        rpaLedger = Object.freeze({ ...rpaLedger, generation: 2, disabledAtMs: nowMs });
      }
      return response({ rpa: rpaLedger });
    }
    if (path.endsWith("/rpa/manual-once")) {
      rpaLedger ??= Object.freeze({
        programId: PROGRAM_ID,
        generation: 1,
        programHash: rpaProgram.programHash,
        taskPlanHash: rpaProgram.taskPlanHash,
        releaseId: BINDING.releaseId,
        sourceCommit: BINDING.sourceCommit,
        enabled: false,
        recurringEnabled: false,
        activeTicks: 0,
        disabledAtMs: null,
      });
      return response({ rpa: {
        result: { status: "SUCCEEDED", receipt: { committed: true, receiptHash: "a".repeat(64) } },
        closeout: {
          RPA_FOUNDATION_VERIFIED: true,
          RPA_RECURRING_ENABLED: false,
          closeoutHash: "b".repeat(64),
        },
        recurringEnabled: false,
      } });
    }
    return response({ error: { code: "ROUTE_NOT_FOUND" } }, 404);
  };
  const reviewStats = {};
  const makeOperator = (overrides = {}) => createXhsV3ProductionOperatorForTest({
    runtimeRoot: root,
    binding: BINDING,
    gateToken: GATE_TOKEN,
    signer,
    fetchImpl,
    aclController: noOpAcl(),
    reviewAclController: overrides.reviewAclController ?? noOpReviewAcl(reviewStats),
    reviewWorkspaceRoot: reviewRoot,
    now: () => nowMs,
    ...operatorOptions,
    ...overrides,
  });
  const operator = makeOperator();
  return {
    root, reviewRoot, operator, calls, fetchImpl, signer, makeOperator, reviewStats,
    setNow(value) { nowMs = value; },
  };
}

function command(...argv) {
  return parseXhsV3ProductionOperatorCommand(argv);
}

function reviewWorkspace(f, corpusSetId) {
  const releaseKey = hash(Buffer.from(
    `${BINDING.releaseId}:${BINDING.sourceCommit}:${BINDING.operatorSha256}`, "utf8",
  ));
  return join(f.reviewRoot, releaseKey, corpusSetId);
}

function privateReviewSession(f, corpusSetId) {
  return JSON.parse(readFileSync(join(
    f.root, "private", "xhs-v3", "corpus-sets", corpusSetId, "review-session.v1.json",
  ), "utf8"));
}

async function progressThroughR2(f, runSetId = "run-001") {
  for (const phase of ["R0", "R1", "R2"]) {
    await f.operator.execute(command("prepare-fixed", phase, runSetId));
    await f.operator.execute(command("run-fixed", phase, runSetId));
  }
}

test("CLI grammar rejects flags, paths, endpoint/provider/role/recurring injection and derives no caller invocation id", () => {
  assert.deepEqual(command("prepare-fixed", "R3", "run-001"), {
    kind: "prepare", phase: "R3", runSetId: "run-001",
  });
  assert.deepEqual(command("verify-blind-review-runtime-fixed"), {
    kind: "verify-blind-review-runtime",
  });
  for (const argv of [
    ["prepare-fixed", "R0", "..\\escape"],
    ["run-fixed", "R1", "run-1", "provider"],
    ["run-fixed", "R1", "--endpoint"],
    ["rpa-manual-once-fixed", PROGRAM_ID, "1", "short"],
    ["rpa-enable-fixed", PROGRAM_ID, "1"],
    ["health-fixed", "http://127.0.0.1:9"],
  ]) assert.throws(() => parseXhsV3ProductionOperatorCommand(argv), { code: "XHS_V3_OPERATOR_ARGUMENT_INVALID" });
});

test("fixed runtime gate binds tracked client transport/adoption evidence and replays its private receipt", async (t) => {
  const f = fixture(t);
  const first = await f.operator.execute(command("verify-blind-review-runtime-fixed"));
  assert.equal(first.status, "PASS");
  assert.equal(first.releaseId, BINDING.releaseId);
  assert.equal(first.sourceCommit, BINDING.sourceCommit);
  assert.equal(first.operatorSha256, BINDING.operatorSha256);
  assert.equal(first.providerBundleDigest, "e".repeat(64));
  assert.equal(f.reviewStats.admit, 3, "new admission, response-orphan adoption, and receipt replay are all gated");
  assert.equal(f.reviewStats.close, 2);
  for (const key of [
    "sessionId", "reviewRequestHash", "accessAttestationHash", "responseHash",
    "callerPrincipalHash", "isolationProbeHash", "taskExecutionHash", "networkPolicyHash", "workspaceAclHash",
    "isolationAclHash", "sourceAclRestorationHash", "closedWorkspaceAclHash", "receiptHash",
  ]) assert.match(first[key], /^[0-9a-f]{64}$/u);

  const second = await f.operator.execute(command("verify-blind-review-runtime-fixed"));
  assert.deepEqual(second, first);
  assert.equal(f.reviewStats.admit, 3, "a sealed private PASS receipt does not relaunch S4U");
  assert.equal(f.reviewStats.close, 2);

  const releaseKey = hash(Buffer.from(canonicalXhsV3FixedOperatorJson({
    releaseId: BINDING.releaseId,
    sourceCommit: BINDING.sourceCommit,
    operatorSha256: BINDING.operatorSha256,
    providerBundleDigest: "e".repeat(64),
  }), "utf8"));
  const workspaceClient = join(
    f.reviewRoot, "runtime-verification", releaseKey, first.sessionId,
    "templates", "xhs-v3-blind-review-submit.mjs",
  );
  assert.deepEqual(readFileSync(workspaceClient), readFileSync(new URL("../ops/xhs-v3-blind-review-submit.mjs", import.meta.url)));
  const receiptPath = join(
    f.root, "private", "xhs-v3", "blind-review-runtime-verification", releaseKey, "receipt.v1.json",
  );
  const { ok, ...projectedReceipt } = first;
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), projectedReceipt);
});

test("runtime gate preserves its primary error and unconditionally closes a partial Protect", async (t) => {
  const f = fixture(t);
  const stats = {};
  const base = noOpReviewAcl(stats);
  const primary = Object.assign(new Error("partial native Protect"), { code: "XHS_TEST_PARTIAL_PROTECT" });
  const operator = f.makeOperator({
    reviewAclController: {
      ...base,
      protect() { throw primary; },
    },
  });
  await assert.rejects(
    () => operator.execute(command("verify-blind-review-runtime-fixed")),
    (error) => error === primary,
  );
  assert.equal(stats.close, 2, "staging close and failure close both run when Protect never returns a receipt");
  assert.equal(stats.restore || 0, 0);
});

test("fixed ledger enforces R0-R4/E/P6 order, same release/corpus, and P7-after-P6", async (t) => {
  const f = fixture(t);
  assert.equal((await f.operator.execute(command("health-fixed"))).rpaRecurringEnabled, false);
  await assert.rejects(
    () => f.operator.execute(command("run-fixed", "R0", "run-001")),
    { code: "XHS_V3_OPERATOR_PHASE_ORDER_INVALID" },
  );
  await assert.rejects(
    () => f.operator.execute(command("rpa-plan-fixed", PROGRAM_ID)),
    { code: "XHS_V3_OPERATOR_P6_PASS_REQUIRED" },
  );
  await progressThroughR2(f);
  assert.equal(f.reviewStats.admit, 3, "R1 preparation requires the fixed runtime verification receipt");
  const prepared = await f.operator.execute(command("prepare-review-fixed", "run-001", "corpus-001"));
  assert.match(prepared.reviewRequestHash, /^[0-9a-f]{64}$/u);
  assert.match(prepared.templateHash, /^[0-9a-f]{64}$/u);
  await assert.rejects(
    () => f.operator.execute(command("assemble-fixed", "run-001", "corpus-other")),
    { code: "XHS_V3_OPERATOR_CORPUS_BINDING_DRIFT" },
  );

  const requestBytes = readFileSync(join(
    f.root, "private", "xhs-v3", "corpus-sets", "corpus-001", "review-request.v1.json",
  ));
  const responseValue = {
    schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
    schemaVersion: 1,
    corpusSetId: "corpus-001",
    sessionId: prepared.sessionId,
    challenge: prepared.challenge,
    reviewRequestHash: hash(requestBytes),
    accessAttestationHash: prepared.accessAttestationHash,
    annotations: [{
      rowId: privateReviewSession(f, "corpus-001").rows[0].rowId,
      expectedOutcome: "SAFE_UNIQUE",
      positiveRegions: [{ role: "OPEN_CONTENT_CARD", bounds: [10, 20, 30, 40] }],
      protectedRegions: [{ kind: "SOCIAL_ACTIONS", bounds: [40, 50, 60, 70] }],
    }],
  };
  const responseBytes = pretty(responseValue);
  const responseHash = hash(responseBytes);
  const inbox = join(reviewWorkspace(f, "corpus-001"), "inbox");
  writeFileSync(join(inbox, `${responseHash}.review-response.v1.json`), responseBytes);
  await f.operator.execute(command("submit-review-fixed", "run-001", "corpus-001", responseHash));
  await assert.rejects(
    () => f.operator.execute(command("assemble-fixed", "run-001", "corpus-other")),
    { code: "XHS_V3_OPERATOR_CORPUS_BINDING_DRIFT" },
  );
  await f.operator.execute(command("assemble-fixed", "run-001", "corpus-001"));
  await f.operator.execute(command("evaluate-fixed", "run-001", "corpus-001"));
  await f.operator.execute(command("seal-e-fixed", "run-001", "corpus-001"));
  for (const phase of ["R3", "R4"]) {
    await f.operator.execute(command("prepare-fixed", phase, "run-001"));
    await f.operator.execute(command("run-fixed", phase, "run-001"));
  }
  const p6 = await f.operator.execute(command("closeout-p6-fixed", "run-001"));
  assert.equal(p6.status, "PASS");
  const plan = await f.operator.execute(command("rpa-plan-fixed", PROGRAM_ID));
  assert.equal(plan.p6ArtifactHash, p6.artifactHash);
  assert.equal(plan.generation, 1);
  assert.equal(plan.releaseId, BINDING.releaseId);
  assert.equal(plan.recurringEnabled, false);
  const before = await f.operator.execute(command("rpa-status-fixed", PROGRAM_ID));
  assert.equal(before.generation, 1);
  assert.equal(before.registered, false);
  assert.equal(before.recurringEnabled, false);
  const manual = await f.operator.execute(command(
    "rpa-manual-once-fixed", PROGRAM_ID, "1", "manual:opaque:12345678",
  ));
  assert.equal(manual.RPA_FOUNDATION_VERIFIED, true);
  assert.equal(manual.RPA_RECURRING_ENABLED, false);
  const active = await f.operator.execute(command("rpa-status-fixed", PROGRAM_ID));
  assert.equal(active.generation, 1);
  assert.equal(active.registered, true);
  assert.equal(active.disabled, false);
  const disabled = await f.operator.execute(command("rpa-disable-fixed", PROGRAM_ID, "1"));
  assert.equal(disabled.status, "DISABLED");
  assert.equal(disabled.requestedGeneration, 1);
  assert.equal(disabled.generation, 2);
  assert.equal(disabled.activeTickCount, 0);
  const retried = await f.operator.execute(command("rpa-disable-fixed", PROGRAM_ID, "1"));
  assert.equal(retried.generation, 2);
  assert.equal(retried.disabledAtMs, disabled.disabledAtMs);
  const finalStatus = await f.operator.execute(command("rpa-status-fixed", PROGRAM_ID));
  assert.equal(finalStatus.status, "DISABLED");
  assert.equal(finalStatus.generation, 2);
  assert.equal(finalStatus.disabled, true);
  assert.equal(finalStatus.recurringEnabled, false);

  const rpaCalls = f.calls.filter((row) => row.path.includes("/xhs/rpa/"));
  assert.ok(rpaCalls.every((row) => row.headers["x-xhs-v3-fixed-operator-authorization"]));
  assert.ok(f.calls.every((row) => JSON.stringify(row).includes(LIVE_TOKEN) === false));
});

test("run binding rejects resuming one runSet under another FINAL release", async (t) => {
  const f = fixture(t);
  await f.operator.execute(command("prepare-fixed", "R0", "run-release-bound"));
  const otherBinding = { ...BINDING, releaseId: "xw-xhs-v3-other", sourceCommit: "f".repeat(40) };
  const other = createXhsV3ProductionOperatorForTest({
    runtimeRoot: f.root,
    binding: otherBinding,
    gateToken: GATE_TOKEN,
    signer: createXhsV3FixedOperatorRequestSigner({
      liveEntryToken: LIVE_TOKEN,
      binding: otherBinding,
      now: () => 1_800_000_000_000,
      nonceFactory: () => "f".repeat(32),
    }),
    fetchImpl: async () => response({ gate: gate() }),
    aclController: noOpAcl(),
    reviewAclController: noOpReviewAcl(),
    reviewWorkspaceRoot: f.reviewRoot,
  });
  await assert.rejects(
    () => other.execute(command("prepare-fixed", "R0", "run-release-bound")),
    { code: "XHS_V3_OPERATOR_RUN_RELEASE_DRIFT" },
  );
});

test("concurrent fixed operators cannot acquire the same pre-side-effect event", async (t) => {
  let blockRun = false;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const f = fixture(t, {
    intercept: async ({ path, body }) => {
      if (!blockRun || !path.endsWith("/exploration/run")) return undefined;
      enteredResolve();
      await release;
      return response({ run: {
        ok: true,
        status: "SUCCEEDED",
        phase: body.phase,
        receiptHash: hash(Buffer.from(`receipt:${body.invocationId}`)),
        captureReceiptHashes: [],
      } });
    },
  });
  await f.operator.execute(command("prepare-fixed", "R0", "run-concurrent"));
  blockRun = true;
  const first = f.operator.execute(command("run-fixed", "R0", "run-concurrent"));
  await entered;
  const competing = f.makeOperator({
    intentOwnerId: "e".repeat(64),
    isIntentOwnerActive: () => true,
  });
  await assert.rejects(
    () => competing.execute(command("run-fixed", "R0", "run-concurrent")),
    { code: "XHS_V3_OPERATOR_OPERATION_IN_PROGRESS" },
  );
  assert.equal(f.calls.filter((row) => row.path.endsWith("/exploration/run")).length, 1);
  releaseResolve();
  assert.equal((await first).status, "SUCCEEDED");
});

test("dead run intent without a fixed final record blocks forever and never repeats device I/O", async (t) => {
  let failRun = true;
  const f = fixture(t, {
    intercept: async ({ path }) => {
      if (failRun && path.endsWith("/exploration/run")) throw new Error("lost after possible device I/O");
      return undefined;
    },
  });
  await f.operator.execute(command("prepare-fixed", "R0", "run-uncertain"));
  await assert.rejects(
    () => f.operator.execute(command("run-fixed", "R0", "run-uncertain")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  failRun = false;
  const restarted = f.makeOperator({
    intentOwnerId: "d".repeat(64),
    isIntentOwnerActive: () => false,
  });
  await assert.rejects(
    () => restarted.execute(command("run-fixed", "R0", "run-uncertain")),
    { code: "XHS_V3_OPERATOR_RUN_OUTCOME_UNCERTAIN" },
  );
  assert.equal(f.calls.filter((row) => row.path.endsWith("/exploration/run")).length, 1);
});

test("restart adopts an exact fixed run record after response loss without a second run call", async (t) => {
  let loseResponse = true;
  const f = fixture(t, {
    intercept: async ({ path, body, root }) => {
      if (!loseResponse || !path.endsWith("/exploration/run")) return undefined;
      const result = {
        ok: true,
        status: "SUCCEEDED",
        phase: body.phase,
        receiptHash: hash(Buffer.from(`receipt:${body.invocationId}`)),
        captureReceiptHashes: ["3".repeat(64)],
      };
      writeCanonical(join(root, "private", "xhs-v3", "runs", `${body.invocationId}.v1.json`), {
        schemaId: "xw.xhs.v3-task-run-record.v1",
        schemaVersion: 1,
        phase: body.phase,
        invocationId: body.invocationId,
        invocationHash: hash(Buffer.from(body.invocationId)),
        planHash: "1".repeat(64),
        missionHash: "2".repeat(64),
        eCorpusPassRef: null,
        taskBinding: {
          taskName: "XW Platform Control Plane",
          taskBindingHash: "3".repeat(64),
          launcherHash: "4".repeat(64),
          callerPathHash: "5".repeat(64),
        },
        runtimeBinding: {
          releaseId: BINDING.releaseId,
          sourceCommit: BINDING.sourceCommit,
          providerBundleDigest: "6".repeat(64),
          digestKeyId: "key-01",
          accountFingerprint: "7".repeat(64),
        },
        result,
      });
      throw new Error("response lost after fixed run record commit");
    },
  });
  await f.operator.execute(command("prepare-fixed", "R0", "run-adopt"));
  await assert.rejects(
    () => f.operator.execute(command("run-fixed", "R0", "run-adopt")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  loseResponse = false;
  const restarted = f.makeOperator({
    intentOwnerId: "c".repeat(64),
    isIntentOwnerActive: () => false,
  });
  const adopted = await restarted.execute(command("run-fixed", "R0", "run-adopt"));
  assert.equal(adopted.status, "SUCCEEDED");
  assert.equal(adopted.captureReceiptCount, 1);
  assert.equal(f.calls.filter((row) => row.path.endsWith("/exploration/run")).length, 1);
});

test("submit/assemble/evaluate crash recovery adopts exact task-owned outputs without repeating remote work", async (t) => {
  let crashStage = null;
  const f = fixture(t, {
    intercept: async ({ path, body, root }) => {
      if (crashStage === "submit" && path.endsWith("/submit-corpus-review")) {
        writeCanonical(join(root, "private", "xhs-v3", "corpus-sets", body.corpusSetId, "review-response.v1.json"), {
          schemaId: "xw.xhs.v3-corpus-review-response.v1",
          schemaVersion: 1,
          ...body,
        });
        throw new Error("lost after blind response commit");
      }
      if (crashStage === "assemble" && path.endsWith("/assemble-corpus-set")) {
        writeCanonical(join(root, "private", "xhs-v3", "corpus-sets", body.corpusSetId, "sealed-corpus.v1.json"), {
          schemaId: "xw.xhs.exploration-corpus-sealed-bundle.v1",
          publicManifest: {
            rows: [{ provenance: { countingEligible: true } }],
          },
        });
        throw new Error("lost after corpus commit");
      }
      if (crashStage === "evaluate" && path.endsWith("/evaluate-corpus-set")) {
        writeCanonical(join(root, "private", "xhs-v3", "corpus-sets", body.corpusSetId, "production-evaluator-outcome.v1.json"), {
          schemaId: "xw.xhs.v3-task-evaluator-outcome.v1",
          schemaVersion: 1,
          corpusSetId: body.corpusSetId,
          runtime: {
            releaseId: BINDING.releaseId,
            sourceCommit: BINDING.sourceCommit,
          },
          corpus: { corpusManifestHash: "1".repeat(64), privateIndexDigest: "2".repeat(64) },
          providerOracleCases: [{ id: "fixed", passed: true }],
          adverseMutationCases: [{ id: "fixed", passed: true }],
          safety: {
            socialTransport: 0,
            effectTransport: 0,
            visualIssued: 0,
            visualConsumed: 0,
            visualPhysical: 0,
          },
        });
        throw new Error("lost after evaluator outcome commit");
      }
      if (crashStage === "seal" && path.endsWith("/seal-e-corpus")) {
        const testReportHash = "8".repeat(64);
        const gateEpoch = "c".repeat(64);
        const binding = {
          releaseId: BINDING.releaseId,
          sourceCommit: BINDING.sourceCommit,
          providerBundleDigest: "1".repeat(64),
          corpusManifestHash: "2".repeat(64),
          privateIndexDigest: "3".repeat(64),
          evaluatorSourceHash: "4".repeat(64),
          testReportHash,
          digestKeyId: "key-01",
          gateEpoch,
        };
        const owner = {
          taskName: "XW Platform Control Plane",
          taskBindingHash: "5".repeat(64),
          launcherHash: "6".repeat(64),
          callerPathHash: "7".repeat(64),
        };
        const unsigned = {
          schemaId: "xw.xhs.e-corpus-pass.v1",
          schemaVersion: 1,
          status: "PASS",
          issuedAtMs: 1_799_999_000_000,
          expiresAtMs: 1_800_001_000_000,
          owner,
          binding,
        };
        const artifactHash = hash(Buffer.from(canonicalXhsV3FixedOperatorJson(unsigned), "utf8"));
        const ref = {
          schemaId: "xw.xhs.e-corpus-pass-ref.v1",
          artifactHash,
          bindingHash: hash(Buffer.from(canonicalXhsV3FixedOperatorJson(binding), "utf8")),
          gateEpoch,
          expiresAtMs: unsigned.expiresAtMs,
        };
        writeCanonical(join(
          root, "state", "orchestrator", "e-corpus-pass", artifactHash,
          "xw.xhs.e-corpus-pass.v1.json",
        ), {
          ...unsigned,
          artifactHash,
          seal: { algorithm: "HMAC-SHA-256", digestKeyId: "key-01", digest: "9".repeat(64) },
        });
        const locatorBody = {
          schemaId: "xw.xhs.e-corpus-seal-locator.v1",
          schemaVersion: 1,
          corpusSetId: body.corpusSetId,
          expiryPolicy: "GATE_F_SHORT",
          runtime: {
            releaseId: BINDING.releaseId,
            sourceCommit: BINDING.sourceCommit,
            providerBundleDigest: binding.providerBundleDigest,
            digestKeyId: "key-01",
          },
          taskOwner: owner,
          gateEpoch,
          ref,
          binding,
          testReportHash,
        };
        writeCanonical(join(
          root, "private", "xhs-v3", "corpus-sets", body.corpusSetId,
          "e-corpus-seal-locator.v1.json",
        ), {
          ...locatorBody,
          locatorHash: hash(Buffer.from(canonicalXhsV3FixedOperatorJson(locatorBody), "utf8")),
        });
        throw new Error("lost after E locator/artifact commit");
      }
      if (crashStage === "p6" && path.endsWith("/closeout-p6")) {
        const artifact = {
          schemaId: "xw.xhs.v3-free-exploration-pass.v1",
          status: "PASS",
          verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
          XHS_V3_FREE_EXPLORATION_VERIFIED: true,
          runSetId: body.runSetId,
          runtime: { releaseId: BINDING.releaseId, sourceCommit: BINDING.sourceCommit },
        };
        const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
        const artifactHash = hash(artifactBytes);
        const acceptance = join(root, "private", "xhs-v3", "acceptance");
        const artifactPath = join(
          acceptance, "p6-artifacts", artifactHash, "xhs-v3-p6-pass.v1.json",
        );
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, artifactBytes);
        writeFileSync(join(acceptance, "p6-current.v1.json"), JSON.stringify({
          schemaId: "xw.xhs.v3-p6-current.v1",
          schemaVersion: 1,
          artifactHash,
          artifactSchemaId: artifact.schemaId,
          relativePath: `p6-artifacts/${artifactHash}/xhs-v3-p6-pass.v1.json`,
        }));
        throw new Error("lost after P6 PASS commit");
      }
      return undefined;
    },
  });
  await progressThroughR2(f, "run-crash-adopt");
  const prepared = await f.operator.execute(command(
    "prepare-review-fixed", "run-crash-adopt", "corpus-crash-adopt",
  ));
  const human = {
    schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
    schemaVersion: 1,
    corpusSetId: "corpus-crash-adopt",
    sessionId: prepared.sessionId,
    challenge: prepared.challenge,
    reviewRequestHash: prepared.reviewRequestHash,
    accessAttestationHash: prepared.accessAttestationHash,
    annotations: [{
      rowId: privateReviewSession(f, "corpus-crash-adopt").rows[0].rowId,
      expectedOutcome: "SAFE_UNIQUE",
      positiveRegions: [{ role: "OPEN_CONTENT_CARD", bounds: [10, 20, 30, 40] }],
      protectedRegions: [{ kind: "SOCIAL_ACTIONS", bounds: [40, 50, 60, 70] }],
    }],
  };
  const humanBytes = pretty(human);
  const responseHash = hash(humanBytes);
  writeFileSync(
    join(reviewWorkspace(f, "corpus-crash-adopt"), "inbox", `${responseHash}.review-response.v1.json`),
    humanBytes,
  );

  crashStage = "submit";
  await assert.rejects(
    () => f.operator.execute(command(
      "submit-review-fixed", "run-crash-adopt", "corpus-crash-adopt", responseHash,
    )),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  crashStage = null;
  let restarted = f.makeOperator({ intentOwnerId: "9".repeat(64), isIntentOwnerActive: () => false });
  assert.equal((await restarted.execute(command(
    "submit-review-fixed", "run-crash-adopt", "corpus-crash-adopt", responseHash,
  ))).status, "REVIEW_RESPONSE_SEALED");
  assert.equal(f.calls.filter((row) => row.path.endsWith("/submit-corpus-review")).length, 1);

  crashStage = "assemble";
  await assert.rejects(
    () => restarted.execute(command("assemble-fixed", "run-crash-adopt", "corpus-crash-adopt")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  crashStage = null;
  restarted = f.makeOperator({ intentOwnerId: "8".repeat(64), isIntentOwnerActive: () => false });
  assert.equal((await restarted.execute(command(
    "assemble-fixed", "run-crash-adopt", "corpus-crash-adopt",
  ))).status, "AWAITING_TASK_EVALUATOR_OUTCOME");
  assert.equal(f.calls.filter((row) => row.path.endsWith("/assemble-corpus-set")).length, 1);

  crashStage = "evaluate";
  await assert.rejects(
    () => restarted.execute(command("evaluate-fixed", "run-crash-adopt", "corpus-crash-adopt")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  crashStage = null;
  restarted = f.makeOperator({ intentOwnerId: "7".repeat(64), isIntentOwnerActive: () => false });
  assert.equal((await restarted.execute(command(
    "evaluate-fixed", "run-crash-adopt", "corpus-crash-adopt",
  ))).status, "PASS");
  assert.equal(f.calls.filter((row) => row.path.endsWith("/evaluate-corpus-set")).length, 1);

  crashStage = "seal";
  await assert.rejects(
    () => restarted.execute(command("seal-e-fixed", "run-crash-adopt", "corpus-crash-adopt")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  crashStage = null;
  restarted = f.makeOperator({ intentOwnerId: "6".repeat(64), isIntentOwnerActive: () => false });
  assert.equal((await restarted.execute(command(
    "seal-e-fixed", "run-crash-adopt", "corpus-crash-adopt",
  ))).status, "PASS");
  assert.equal(f.calls.filter((row) => row.path.endsWith("/seal-e-corpus")).length, 1);

  for (const phase of ["R3", "R4"]) {
    await restarted.execute(command("prepare-fixed", phase, "run-crash-adopt"));
    await restarted.execute(command("run-fixed", phase, "run-crash-adopt"));
  }
  crashStage = "p6";
  await assert.rejects(
    () => restarted.execute(command("closeout-p6-fixed", "run-crash-adopt")),
    { code: "XHS_V3_OPERATOR_REMOTE_UNAVAILABLE" },
  );
  crashStage = null;
  restarted = f.makeOperator({ intentOwnerId: "5".repeat(64), isIntentOwnerActive: () => false });
  assert.equal((await restarted.execute(command("closeout-p6-fixed", "run-crash-adopt"))).status, "PASS");
  assert.equal(f.calls.filter((row) => row.path.endsWith("/closeout-p6")).length, 1);
});

test("blind response exact schema preserves immutable DUMP verdict semantics", () => {
  const cases = [
    ["COMPLETE_SAFE_UNIQUE", "SAFE_UNIQUE", [{ role: "OPEN_CONTENT_CARD", bounds: [1, 1, 2, 2] }]],
    ["FORBIDDEN_OR_RISKY", "SAFE_UNIQUE", [{ role: "OPEN_CONTENT_CARD", bounds: [1, 1, 2, 2] }]],
    ["AMBIGUOUS_SAFE", "NO_FALLBACK_EXPECTED", []],
    ["ABSENT_OR_INVALID", "NO_FALLBACK_EXPECTED", []],
  ];
  for (const [dumpVerdict, expectedOutcome, positiveRegions] of cases) {
    const request = requestValue("unused", "corpus-semantics", dumpVerdict);
    const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
    const session = { sessionId: "7".repeat(64), challenge: "8".repeat(64), rows: [{ rowId: "row-semantics", captureReceiptHash: request.receipts[0].captureReceiptHash }] };
    const accessAttestationHash = "9".repeat(64);
    const value = {
      schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
      schemaVersion: 1,
      corpusSetId: request.corpusSetId,
      sessionId: session.sessionId,
      challenge: session.challenge,
      reviewRequestHash: hash(requestBytes),
      accessAttestationHash,
      annotations: [{
        rowId: session.rows[0].rowId,
        expectedOutcome,
        positiveRegions,
        protectedRegions: [],
      }],
    };
    const responseBytes = pretty(value);
    assert.throws(() => validateXhsV3BlindReviewHumanResponse(value, {
      request,
      session,
      accessAttestationHash,
      responseHash: hash(responseBytes),
      rawBytes: { request: requestBytes, response: responseBytes },
    }), { code: "XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID" });
  }

  const request = requestValue("unused", "corpus-complete", "COMPLETE_SAFE_UNIQUE");
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  const session = { sessionId: "7".repeat(64), challenge: "8".repeat(64), rows: [{ rowId: "row-complete", captureReceiptHash: request.receipts[0].captureReceiptHash }] };
  const accessAttestationHash = "9".repeat(64);
  const valid = {
    schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
    schemaVersion: 1,
    corpusSetId: request.corpusSetId,
    sessionId: session.sessionId,
    challenge: session.challenge,
    reviewRequestHash: hash(requestBytes),
    accessAttestationHash,
    annotations: [{
      rowId: session.rows[0].rowId,
      expectedOutcome: "NO_FALLBACK_EXPECTED",
      positiveRegions: [],
      protectedRegions: [],
    }],
  };
  const validBytes = pretty(valid);
  assert.equal(validateXhsV3BlindReviewHumanResponse(valid, {
    request,
    session,
    accessAttestationHash,
    responseHash: hash(validBytes),
    rawBytes: { request: requestBytes, response: validBytes },
  }).sessionId, valid.sessionId);
  const extra = { ...valid, providerOutput: "forbidden" };
  const extraBytes = pretty(extra);
  assert.throws(() => validateXhsV3BlindReviewHumanResponse(extra, {
    request,
    session,
    accessAttestationHash,
    responseHash: hash(extraBytes),
    rawBytes: { request: requestBytes, response: extraBytes },
  }), { code: "XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID" });
});

test("review inbox rejects a junction/reparse path before reading human labels", async (t) => {
  const f = fixture(t);
  await progressThroughR2(f, "run-link");
  const prepared = await f.operator.execute(command("prepare-review-fixed", "run-link", "corpus-link"));
  const requestBytes = readFileSync(join(
    f.root, "private", "xhs-v3", "corpus-sets", "corpus-link", "review-request.v1.json",
  ));
  const value = {
    schemaId: XHS_V3_BLIND_REVIEW_HUMAN_RESPONSE_SCHEMA_ID,
    schemaVersion: 1,
    corpusSetId: "corpus-link",
    sessionId: prepared.sessionId,
    challenge: prepared.challenge,
    reviewRequestHash: prepared.reviewRequestHash,
    accessAttestationHash: prepared.accessAttestationHash,
    annotations: [{
      rowId: privateReviewSession(f, "corpus-link").rows[0].rowId,
      expectedOutcome: "REJECT",
      positiveRegions: [],
      protectedRegions: [],
    }],
  };
  const bytes = pretty(value);
  const responseHash = hash(bytes);
  const workflow = reviewWorkspace(f, "corpus-link");
  const inbox = join(workflow, "inbox");
  const outside = join(f.root, "outside-inbox");
  mkdirSync(outside);
  writeFileSync(join(outside, `${responseHash}.review-response.v1.json`), bytes);
  rmSync(inbox, { recursive: true });
  try {
    symlinkSync(outside, inbox, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("host does not permit a test reparse point");
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => f.operator.execute(command("submit-review-fixed", "run-link", "corpus-link", responseHash)),
    { code: "XHS_V3_OPERATOR_REVIEW_RESPONSE_INVALID" },
  );
  assert.equal(readFileSync(join(outside, `${responseHash}.review-response.v1.json`)).equals(bytes), true);
  assert.equal(requestBytes.length > 0, true);
});
