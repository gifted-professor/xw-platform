import assert from "node:assert/strict";
import test from "node:test";

import { ControlRouter } from "../control-plane/router.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { createXhsV3TaskBootstrap } from
  "../../orchestrator/scripts/lib/xhs-v3-task-bootstrap.mjs";

const TOKEN = "gate-f-operations-token-that-is-long-enough";
const SECRET = "private-task-goal-never-returned";

function gateOperations() {
  return {
    assertAuthorized(headers = {}) {
      if (headers["x-m6-gate-f-operations-token"] !== TOKEN) {
        throw new ControlPlaneError("M6_GATE_F_OPERATIONS_UNAUTHORIZED", "invalid token", { status: 403 });
      }
    },
  };
}

function fixture() {
  const calls = { loads: 0, runs: 0, sealers: 0, seals: 0 };
  const ref = {
    schemaId: "xw.xhs.e-corpus-pass-ref.v1",
    artifactHash: "1".repeat(64),
    bindingHash: "2".repeat(64),
    gateEpoch: "3".repeat(64),
    expiresAtMs: 3_610_000,
  };
  const bootstrap = createXhsV3TaskBootstrap({
    buildTaskInvocation: async () => ({
      schemaId: "xw.xhs.v3-task-invocation.v1",
      plan: { mission: { vision: { rolloutPhase: "R0", eCorpusPassRef: null } } },
      privatePayload: { goal: SECRET, queries: [SECRET] },
    }),
    persistTaskInvocation: async ({ phase, invocationId }) => ({
      phase, invocationId, invocationHash: "5".repeat(64),
    }),
    corpusAssembler: {
      prepareReview: async ({ corpusSetId }) => ({ corpusSetId, receiptCount: 1 }),
      submitReview: async ({ corpusSetId }) => ({ corpusSetId, status: "REVIEW_RESPONSE_SEALED" }),
      assemble: async ({ corpusSetId }) => ({ corpusSetId, status: "AWAITING_TASK_EVALUATOR_OUTCOME" }),
    },
    evaluateCorpusSet: async ({ corpusSetId }) => ({ corpusSetId, status: "PASS" }),
    runRecordStore: {
      loadIfPresent: async () => null,
      loadAttemptIfPresent: async () => null,
      beginAttempt: async ({ phase, invocationId }) => ({
        phase, invocationId, attemptHash: "7".repeat(64), created: true,
      }),
      persist: async ({ phase, invocationId }) => ({
        phase, invocationId, runRecordHash: "6".repeat(64),
      }),
    },
    closeoutAcceptance: async ({ runSetId }) => ({ runSetId, status: "CLOSEOUT_PARTIAL" }),
    runner: {
      async run(input) {
        calls.runs += 1;
        assert.equal(input.privatePayload.goal, SECRET);
        return { ok: true, status: "SUCCEEDED", phase: input.phase };
      },
    },
    async loadTaskInvocation() {
      calls.loads += 1;
      return {
        schemaId: "xw.xhs.v3-task-invocation.v1",
        plan: { mission: { vision: { rolloutPhase: "R1", eCorpusPassRef: null } } },
        privatePayload: { goal: SECRET, queries: [SECRET] },
      };
    },
    async createCorpusSealer() {
      calls.sealers += 1;
      return {
        async sealPass() {
          calls.seals += 1;
          return { ref, evaluation: { testReportHash: "4".repeat(64) } };
        },
        createInterlock() { return {}; },
      };
    },
    openECorpusArtifact(artifactHash) {
      assert.equal(artifactHash, ref.artifactHash);
      return {
        ref,
        interlock: { verifyR3: () => ({ ok: true }) },
        verification: { status: "PASS", artifactHash: ref.artifactHash },
      };
    },
    assertGateFReady: async () => true,
    now: () => 10_000,
  });
  const router = new ControlRouter({
    control: {},
    state: {},
    capabilities: {},
    evidence: {},
    m6GateFOperations: gateOperations(),
    xhsV3TaskBootstrap: bootstrap,
    xhsV3FixedOperatorAuthorization: { assertAuthorized() { return true; } },
  });
  return { router, calls };
}

function request(router, path, body, headers = { "x-m6-gate-f-operations-token": TOKEN }) {
  return router.handle({ method: "POST", path, body, headers });
}

test("in-process run route is Gate-F-token-owned and returns no private invocation material", async () => {
  const f = fixture();
  await assert.rejects(
    () => request(f.router, "/control/v1/internal/xhs/exploration/run", {
      phase: "R1", invocationId: "inv-001",
    }, {}),
    (error) => error.code === "M6_GATE_F_OPERATIONS_UNAUTHORIZED",
  );
  assert.deepEqual(f.calls, { loads: 0, runs: 0, sealers: 0, seals: 0 });

  const response = await request(f.router, "/control/v1/internal/xhs/exploration/run", {
    phase: "R1",
    invocationId: "inv-001",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.run, { ok: true, status: "SUCCEEDED", phase: "R1" });
  assert.equal(JSON.stringify(response).includes(SECRET), false);
  assert.deepEqual(f.calls, { loads: 1, runs: 1, sealers: 0, seals: 0 });
});

test("run route rejects goal/query/path/endpoint/alias/provider/role/E fields before resources", async () => {
  const f = fixture();
  const mutations = [
    ["goal", "caller"],
    ["query", "caller"],
    ["path", "C:\\caller"],
    ["endpoint", "http://127.0.0.1:9"],
    ["alias", "03"],
    ["provider", {}],
    ["role", "OPEN_CONTENT_CARD"],
    ["eCorpus", {}],
  ];
  for (const [field, value] of mutations) {
    await assert.rejects(
      () => request(f.router, "/control/v1/internal/xhs/exploration/run", {
        phase: "R2",
        invocationId: "inv-001",
        [field]: value,
      }),
      (error) => error.code === "XHS_V3_TASK_REQUEST_INVALID",
    );
  }
  assert.deepEqual(f.calls, { loads: 0, runs: 0, sealers: 0, seals: 0 });
});

test("task preparation/review/evaluator routes expose only fixed opaque and blind-label fields", async () => {
  const f = fixture();
  for (const field of ["goal", "query", "path", "endpoint", "alias", "provider", "role", "eCorpus"]) {
    await assert.rejects(
      () => request(f.router, "/control/v1/internal/xhs/exploration/prepare-invocation", {
        phase: "R0", invocationId: "inv-prepare", [field]: "caller",
      }),
      (error) => error.code === "XHS_V3_TASK_PREPARE_REQUEST_INVALID",
    );
  }
  const prepared = await request(f.router, "/control/v1/internal/xhs/exploration/prepare-invocation", {
    phase: "R0", invocationId: "inv-prepare",
  });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.body.invocation.invocationId, "inv-prepare");
  assert.equal(JSON.stringify(prepared).includes(SECRET), false);
  await assert.rejects(
    () => request(f.router, "/control/v1/internal/xhs/exploration/prepare-invocation", {
      phase: "R3", invocationId: "inv-prepare-r3",
    }),
    (error) => error.code === "XHS_V3_TASK_PREPARE_REQUEST_INVALID",
  );
  const preparedR3 = await request(
    f.router,
    "/control/v1/internal/xhs/exploration/prepare-invocation",
    { phase: "R3", invocationId: "inv-prepare-r3", eCorpusArtifactHash: "1".repeat(64) },
  );
  assert.equal(preparedR3.body.invocation.phase, "R3");
  await assert.rejects(
    () => request(f.router, "/control/v1/internal/xhs/exploration/prepare-invocation", {
      phase: "R4", invocationId: "inv-prepare-r4", eCorpusArtifactHash: "1".repeat(64),
    }),
    (error) => error.code === "XHS_V3_TASK_PREPARE_REQUEST_INVALID",
  );

  for (const [path, body, code] of [
    ["prepare-corpus-review", { corpusSetId: "set-001", path: "C:\\caller" }, "XHS_V3_CORPUS_REVIEW_REQUEST_INVALID"],
    ["assemble-corpus-set", { corpusSetId: "set-001", bundle: {} }, "XHS_V3_CORPUS_ASSEMBLE_REQUEST_INVALID"],
    ["evaluate-corpus-set", { corpusSetId: "set-001", passed: true }, "XHS_V3_TASK_EVALUATOR_REQUEST_INVALID"],
  ]) {
    await assert.rejects(
      () => request(f.router, `/control/v1/internal/xhs/exploration/${path}`, body),
      (error) => error.code === code,
    );
  }
  assert.equal((await request(f.router, "/control/v1/internal/xhs/exploration/prepare-corpus-review", {
    corpusSetId: "set-001",
  })).body.review.receiptCount, 1);
  assert.equal((await request(f.router, "/control/v1/internal/xhs/exploration/assemble-corpus-set", {
    corpusSetId: "set-001",
  })).body.corpus.status, "AWAITING_TASK_EVALUATOR_OUTCOME");
  assert.equal((await request(f.router, "/control/v1/internal/xhs/exploration/evaluate-corpus-set", {
    corpusSetId: "set-001",
  })).body.evaluator.status, "PASS");
  await assert.rejects(
    () => request(f.router, "/control/v1/internal/xhs/exploration/closeout-p6", {
      runSetId: "acceptance", passed: true,
    }),
    (error) => error.code === "XHS_V3_P6_CLOSEOUT_REQUEST_INVALID",
  );
  assert.equal((await request(f.router, "/control/v1/internal/xhs/exploration/closeout-p6", {
    runSetId: "acceptance",
  })).body.closeout.status, "CLOSEOUT_PARTIAL");

  const review = {
    corpusSetId: "set-001",
    reviewRequestHash: "a".repeat(64),
    reviewerId: "reviewer",
    providerImplementerId: "implementer",
    annotationsSealedAt: "2026-08-30T01:00:00.000Z",
    providerOutputDisclosedAt: null,
    accessAttestationHash: "b".repeat(64),
    annotations: [],
  };
  await assert.rejects(
    () => request(f.router, "/control/v1/internal/xhs/exploration/submit-corpus-review", {
      ...review, evaluatorPassed: true,
    }),
    (error) => error.code === "XHS_V3_CORPUS_REVIEW_RESPONSE_INVALID",
  );
  const submitted = await request(f.router, "/control/v1/internal/xhs/exploration/submit-corpus-review", review);
  assert.equal(submitted.body.review.status, "REVIEW_RESPONSE_SEALED");
});

test("seal route accepts only opaque corpus set plus closed expiry policy", async () => {
  const f = fixture();
  for (const field of ["binding", "bundle", "path", "provider", "runtime", "gateEpoch", "receipts", "labels"]) {
    await assert.rejects(
      () => request(f.router, "/control/v1/internal/xhs/exploration/seal-e-corpus", {
        corpusSetId: "set-001",
        expiryPolicy: "GATE_F_SHORT",
        [field]: {},
      }),
      (error) => error.code === "XHS_V3_E_CORPUS_REQUEST_INVALID",
    );
  }
  assert.deepEqual(f.calls, { loads: 0, runs: 0, sealers: 0, seals: 0 });
  const response = await request(f.router, "/control/v1/internal/xhs/exploration/seal-e-corpus", {
    corpusSetId: "set-001",
    expiryPolicy: "GATE_F_SHORT",
  });
  assert.equal(response.body.eCorpus.status, "PASS");
  assert.equal("path" in response.body.eCorpus, false);
  assert.deepEqual(f.calls, { loads: 0, runs: 0, sealers: 1, seals: 1 });
});

test("route is absent unless both Gate-F owner and bootstrap are installed", async () => {
  const router = new ControlRouter({ control: {}, state: {}, capabilities: {}, evidence: {} });
  await assert.rejects(
    () => request(router, "/control/v1/internal/xhs/exploration/run", {
      phase: "R0", invocationId: "inv-001",
    }),
    (error) => error.code === "XHS_V3_TASK_BOOTSTRAP_UNAVAILABLE" && error.status === 503,
  );
});
