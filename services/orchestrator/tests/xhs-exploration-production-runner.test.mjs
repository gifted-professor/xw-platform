import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  compileExplorationMission,
} from "../scripts/lib/xhs-exploration-mission.mjs";
import { planExplorationGoalRoutine } from "../scripts/lib/xhs-routine-plan.mjs";
import {
  createTaskOwnedCpCaptureAuthority,
  createXhsV3ProductionRunner,
  XHS_V3_R0_RESULT_SCHEMA_ID,
} from "../scripts/lib/xhs-exploration-production-runner.mjs";
import { createXhsV3PostECorpusProductionRunner } from
  "../scripts/lib/xhs-v3-post-e-production-runner.mjs";
import {
  commentPanelXml,
  homeFeedXml,
  imageNoteXml,
  searchHomeXml,
  searchResultsXml,
} from "./fixtures/xhs-explore-fixtures.mjs";
import { runXhsV3TaskCli } from "../ops/xw-xhs-exploration-run.mjs";

const KEY = Buffer.alloc(32, 0x61);
const PROVIDER = Object.freeze({
  providerBundleDigest: "b".repeat(64),
  pythonHash: "c".repeat(64),
  modelHash: "d".repeat(64),
  scriptHash: "e".repeat(64),
  configHash: "f".repeat(64),
});
const RUNTIME = Object.freeze({
  releaseId: "xw-xhs-v3-test",
  sourceCommit: "a".repeat(40),
  providerBundleDigest: PROVIDER.providerBundleDigest,
  digestKeyId: "ka-test",
  accountFingerprint: "9".repeat(64),
});

function videoNoteXml({ playback = false } = {}) {
  const play = playback
    ? '<node text="" resource-id="pause" class="android.widget.ImageButton" package="com.xingin.xhs" content-desc="暂停" clickable="true" enabled="true" bounds="[480,900][600,1020]" />'
    : "";
  return {
    focus: "com.xingin.xhs/.DetailFeedActivity",
    xml: `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="" resource-id="root" class="android.widget.FrameLayout" package="com.xingin.xhs" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]"><node text="" resource-id="video_surface" class="android.view.SurfaceView" package="com.xingin.xhs" content-desc="视频画面" clickable="false" enabled="true" bounds="[0,80][1080,2300]" />${play}</node></hierarchy>`,
  };
}

function makeMission(phase) {
  const vision = phase === "R2" ? { mode: "shadow", provider: PROVIDER } : { mode: "off" };
  const compiled = compileExplorationMission({
    goal: "有界探索早餐与旅行内容",
    queries: ["城市旅行攻略"],
    budgets: {
      novelOpens: 2,
      commentScreens: 1,
      resultScreensPerQuery: 1,
      visionAnalysisAttempts: 6,
      visionMaxIssuedPermits: 0,
      visionMaxPhysicalTaps: 0,
    },
    vision,
    rolloutPhase: phase,
    digestKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const planned = planExplorationGoalRoutine({ mission: compiled.mission });
  const { templateSpec: _templateSpec, ...plan } = planned;
  return { plan, privatePayload: compiled.privatePayload };
}

const E_REF = Object.freeze({
  schemaId: "xw.xhs.e-corpus-pass-ref.v1",
  artifactHash: "1".repeat(64),
  bindingHash: "2".repeat(64),
  gateEpoch: "3".repeat(64),
  expiresAtMs: 9_999_999_999_999,
});

function makePostEMission(phase) {
  const r3 = phase === "R3";
  const compiled = compileExplorationMission({
    goal: "有界探索早餐与旅行内容",
    queries: ["城市旅行攻略"],
    budgets: {
      novelOpens: 2,
      commentScreens: 1,
      resultScreensPerQuery: 1,
      visionAnalysisAttempts: r3 ? 6 : 0,
      visionMaxIssuedPermits: r3 ? 1 : 0,
      visionMaxPhysicalTaps: r3 ? 1 : 0,
    },
    vision: r3 ? { mode: "canary1", provider: PROVIDER } : { mode: "off" },
    rolloutPhase: phase,
    eCorpusPassRef: r3 ? E_REF : null,
    eCorpusVerifier: r3 ? ({ ref }) => ({
      ok: true,
      status: "PASS",
      artifactHash: ref.artifactHash,
      effectiveVisualPermitBudget: 1,
    }) : null,
    releaseIdRef: RUNTIME.releaseId,
    accountFingerprintRef: RUNTIME.accountFingerprint,
    digestKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
  });
  const planned = planExplorationGoalRoutine({ mission: compiled.mission });
  const { templateSpec: _templateSpec, ...plan } = planned;
  return { plan, privatePayload: compiled.privatePayload };
}

function png(index) {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  Buffer.from("IHDR", "ascii").copy(bytes, 12);
  bytes.writeUInt32BE(1080, 16);
  bytes.writeUInt32BE(2400, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function fakeRuntime({ r2 = false, r3 = false } = {}) {
  const scenes = {
    "03": r3 ? [
      homeFeedXml({ cards: [{ id: "feed-video", title: "早餐旅行视频记录", author: "作者甲", kind: "video" }] }),
      videoNoteXml({ playback: false }),
      videoNoteXml({ playback: false }),
      homeFeedXml({ cards: [{ id: "feed-video", title: "早餐旅行视频记录", author: "作者甲", kind: "video" }] }),
    ] : [
      homeFeedXml({ cards: [{ id: "feed-a", title: "早餐做法记录示例", author: "作者甲" }] }),
      imageNoteXml({}),
      commentPanelXml({}),
      imageNoteXml({}),
      homeFeedXml({ cards: [{ id: "feed-a", title: "早餐做法记录示例", author: "作者甲" }] }),
    ],
    "04": [
      homeFeedXml({ withSearchEntry: true, cards: [{ id: "home-a", title: "旅行首页推荐内容", author: "作者乙" }] }),
      searchHomeXml(),
      searchResultsXml({ tiles: [{ title: "城市周末旅行完整攻略", author: "作者丙" }] }),
      videoNoteXml({ playback: false }),
      searchResultsXml({ tiles: [{ title: "城市周末旅行完整攻略", author: "作者丙" }] }),
      searchHomeXml(),
      homeFeedXml({ withSearchEntry: true, cards: [{ id: "home-a", title: "旅行首页推荐内容", author: "作者乙" }] }),
    ],
  };
  const pointer = { "03": 0, "04": 0 };
  const sessions = new Map();
  const leases = new Map();
  const committed = { "03": false, "04": false };
  const journals = { "03": [], "04": [] };
  const calls = [];
  let screenSeq = 0;
  let permitSeq = 0;
  let visionShadowCalls = 0;
  let visionCanaryCalls = 0;
  let visionAnalysisSeq = 0;
  let visionIssued = 0;
  let visionConsumed = 0;
  let visionPhysical = 0;
  let authorityMission = null;
  const budgetRows = [];
  const kindToCap = {
    primitives: "reservedPrimitives",
    novelOpens: "novelOpens",
    resultScreens: "resultScreensPerQuery",
    commentScreens: "commentScreens",
    visionAnalysis: "visionAnalysisAttempts",
    visionPermits: "visionMaxIssuedPermits",
  };

  function reserveBudget({ alias = null, kind, detail = null }) {
    const capName = kindToCap[kind];
    const cap = Number(authorityMission?.budgets?.[capName] ?? 0);
    const used = budgetRows.filter((row) => row.kind === kind)
      .reduce((sum, row) => sum + row.amount, 0);
    if (!capName || used + 1 > cap) {
      throw Object.assign(new Error(`budget ${kind} exhausted`), { code: "EXPLORATION_BUDGET_EXCEEDED" });
    }
    const operationHash = detail?.operationHash;
    assert.match(operationHash, /^[0-9a-f]{64}$/u);
    const row = {
      reservationId: `reservation-${budgetRows.length + 1}`,
      kind,
      capName,
      alias,
      amount: 1,
      state: "reserved",
      operationHash,
    };
    budgetRows.push(row);
    return {
      reservationId: row.reservationId,
      kind: capName,
      alias,
      amount: 1,
      used: used + 1,
      cap,
      state: row.state,
      operationHash,
    };
  }

  function budgetLedger() {
    const capNames = [
      "reservedPrimitives", "novelOpens", "resultScreensPerQuery", "commentScreens",
      "visionAnalysisAttempts", "visionMaxIssuedPermits", "visionMaxPhysicalTaps",
    ];
    const caps = Object.fromEntries(capNames.map((name) => [name, Number(authorityMission?.budgets?.[name] ?? 0)]));
    const rows = budgetRows.map((row) => ({ ...row }));
    const totals = Object.fromEntries(capNames.map((name) => [
      name,
      rows.filter((row) => row.capName === name).reduce((sum, row) => sum + row.amount, 0),
    ]));
    const body = {
      schemaId: "xw.xhs.exploration-budget-ledger-view.v1",
      authorityId: "authority-r12",
      missionHash: authorityMission.missionHash,
      caps,
      rows,
      totals,
    };
    return {
      ...body,
      ledgerHash: createHash("sha256")
        .update(`${body.schemaId}:${canonicalJson(body)}`, "utf8").digest("hex"),
    };
  }

  function owned(sessionId, token) {
    const session = sessions.get(sessionId);
    assert.ok(session && session.token === token);
    return session;
  }

  const runtime = {
    async createSession(input) {
      calls.push({ method: "createSession", input });
      const alias = input.placement.alias;
      const session = {
        alias,
        sessionId: `session-${alias}`,
        leaseId: `lease-${alias}`,
        token: `token-${alias}`,
        deviceId: `device-${alias}`,
      };
      sessions.set(session.sessionId, session);
      leases.set(session.leaseId, session);
      return { ...session, routeDecision: { selectedDevice: { alias, deviceId: session.deviceId } } };
    },
    async releaseSession(sessionId, token) {
      const session = owned(sessionId, token);
      leases.delete(session.leaseId);
      return { released: true };
    },
    async listLeases() {
      return [...leases.values()].map((session) => ({ leaseId: session.leaseId, kind: "interactive" }));
    },
    async registerExplorationAuthority(input) {
      calls.push({ method: "registerExplorationAuthority", input });
      authorityMission = input.mission;
      return { authorityId: "authority-r12", status: "active" };
    },
    async getExplorationAuthorityView({ sessionId, token }) {
      owned(sessionId, token);
      return {
        authority: {
          authorityId: "authority-r12",
          status: "active",
          missionHash: authorityMission.missionHash,
          budgets: authorityMission.budgets,
        },
        lanes: {
          "03": { laneRole: "feed_lane", journalLength: journals["03"].length, committed: committed["03"] },
          "04": { laneRole: "search_lane", journalLength: journals["04"].length, committed: committed["04"] },
        },
        allSettled: committed["03"] && committed["04"],
        budgetLedger: budgetLedger(),
        visionCounters: {
          analysisAttempts: budgetRows.filter((row) => row.kind === "visionAnalysis").length,
          permitsIssued: budgetRows.filter((row) => row.kind === "visionPermits").length,
          permitsConsumed: visionConsumed,
          physicalTaps: visionPhysical,
        },
      };
    },
    async appendExplorationLaneRecord({ sessionId, token, alias, type, payload }) {
      const session = owned(sessionId, token);
      const lane = alias ?? session.alias;
      journals[lane].push({ type, payload });
      return { recordHash: createHash("sha256").update(`${lane}:${journals[lane].length}:${type}`).digest("hex") };
    },
    async closeExplorationAuthority() {
      return { authorityId: "authority-r12", status: "closed" };
    },
    async heartbeatSession(sessionId, token) {
      return owned(sessionId, token);
    },
    async executeSessionAction(sessionId, token, action) {
      const session = owned(sessionId, token);
      const scene = scenes[session.alias][pointer[session.alias]];
      calls.push({ method: "executeSessionAction", alias: session.alias, action });
      const primitive = action.params.primitive;
      const output = primitive === "focus"
        ? { ok: true, package: "com.xingin.xhs", activity: scene.focus.split("/").slice(1).join("/"), focus: scene.focus }
        : { ok: true, xml: scene.xml };
      return {
        status: "succeeded",
        jobId: `job-${session.alias}-${calls.length}`,
        runId: `run-${session.alias}-${calls.length}`,
        output,
        authorization: { alias: session.alias, sessionId },
      };
    },
    readDumpArtifact() {
      throw new Error("inline fake XML should not use a path");
    },
    async issueExplorationPermit(request) {
      permitSeq += 1;
      calls.push({ method: "issueExplorationPermit", request });
      if (request.navigationRole === "PAUSE_VIDEO_SAFE_ZONE") {
        reserveBudget({
          alias: null,
          kind: "visionPermits",
          detail: {
            operationHash: createHash("sha256")
              .update(`vision-permit:${permitSeq}`, "utf8").digest("hex"),
          },
        });
      }
      return { permitId: `permit-${permitSeq}`, payload: request.resolvedPayload };
    },
    async consumeExplorationPermit(request) {
      const session = owned(request.sessionId, request.token);
      const budgetReservation = reserveBudget({
        alias: session.alias,
        kind: "primitives",
        detail: {
          operationHash: createHash("sha256")
            .update(`primitive:${request.permitId}`, "utf8").digest("hex"),
        },
      });
      pointer[session.alias] = Math.min(pointer[session.alias] + 1, scenes[session.alias].length - 1);
      calls.push({ method: "consumeExplorationPermit", alias: session.alias, request });
      return {
        permit: { permitId: request.permitId },
        job: {
          jobId: `nav-${permitSeq}`,
          status: "succeeded",
          result: { output: { primitive: request.payload?.primitive ?? null } },
        },
        budgetReservation,
      };
    },
    async reserveExplorationBudget(request) {
      owned(request.sessionId, request.token);
      calls.push({ method: "reserveExplorationBudget", alias: request.alias, request });
      return reserveBudget({ alias: request.alias, kind: request.kind, detail: request.detail });
    },
    async claimExplorationTarget(request) {
      owned(request.sessionId, request.token);
      return { targetId: `target-${request.alias}`, novel: true };
    },
    async confirmExplorationTarget(request) {
      owned(request.sessionId, request.token);
      return { targetId: request.targetId, novel: true };
    },
    async commitExplorationLane({ sessionId, token }) {
      const session = owned(sessionId, token);
      committed[session.alias] = true;
      return { alias: session.alias, receiptHash: createHash("sha256").update(`commit:${session.alias}`).digest("hex") };
    },
    async captureExplorationFrame({ sessionId, token }) {
      const session = owned(sessionId, token);
      screenSeq += 1;
      const bytes = png(screenSeq);
      calls.push({ method: "captureExplorationFrame", alias: session.alias });
      return {
        frameId: `frame-${screenSeq}`,
        frameHash: createHash("sha256").update(bytes).digest("hex"),
        bytes,
        capturedAt: Date.now(),
      };
    },
    createExplorationVisionNavigator(input) {
      calls.push({ method: "createExplorationVisionNavigator", input });
      if (r3) {
        assert.equal(input.mode, "canary1");
        assert.equal(input.sessionId, "session-03");
        return {
          mode: "canary1",
          async proposeCanaryTap(request) {
            visionAnalysisSeq += 1;
            reserveBudget({
              alias: "03",
              kind: "visionAnalysis",
              detail: {
                operationHash: createHash("sha256")
                  .update(`vision-analysis:${visionAnalysisSeq}`, "utf8").digest("hex"),
              },
            });
            visionCanaryCalls += 1;
            assert.equal(request.navigationRole, "PAUSE_VIDEO_SAFE_ZONE");
            return {
              ok: true,
              candidateReady: true,
              analysisRef: "analysis:" + "a".repeat(64),
              target: {
                bounds: { x: 420, y: 800, w: 200, h: 200 },
                center: { x: 520, y: 900 },
              },
            };
          },
          recordPermitIssued() { visionIssued += 1; },
          recordPermitConsumed() { visionConsumed += 1; },
          recordPhysicalTap() { visionPhysical += 1; },
          stats() {
            return {
              analysisAttempts: visionCanaryCalls,
              permitsIssued: visionIssued,
              permitsConsumed: visionConsumed,
              physicalTaps: visionPhysical,
            };
          },
          async close() {},
        };
      }
      assert.equal(r2, true);
      return {
        mode: "shadow",
        async observeShadow(request) {
          visionAnalysisSeq += 1;
          reserveBudget({
            alias: input.sessionId === "session-03" ? "03" : "04",
            kind: "visionAnalysis",
            detail: {
              operationHash: createHash("sha256")
                .update(`vision-analysis:${visionAnalysisSeq}`, "utf8").digest("hex"),
            },
          });
          visionShadowCalls += 1;
          assert.equal(request.navigationRole, "PAUSE_VIDEO_SAFE_ZONE");
          return { ok: true, shadow: true, tapAuthorized: false };
        },
        stats() {
          return { analysisAttempts: visionShadowCalls, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 };
        },
        async close() {},
      };
    },
  };
  return {
    runtime,
    calls,
    journals,
    get visionShadowCalls() { return visionShadowCalls; },
    get visionCanaryCalls() { return visionCanaryCalls; },
  };
}

function fixtureRunner({ phase, r2 = false } = {}) {
  const fx = fakeRuntime({ r2 });
  const persisted = [];
  const captureAuthority = createTaskOwnedCpCaptureAuthority({
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
    runtimeBinding: RUNTIME,
    async persistCapture(input) {
      persisted.push(input);
      return { receiptRef: `receipt:${input.captureReceiptHash}` };
    },
  });
  const runner = createXhsV3ProductionRunner({
    runtime: fx.runtime,
    captureAuthority,
    randomUUIDFn: () => `00000000-0000-4000-8000-00000000000${phase === "R2" ? "2" : "1"}`,
    r0FixtureRunner: async () => ({
      schemaId: XHS_V3_R0_RESULT_SCHEMA_ID,
      phase: "CALIBRATION_ONLY",
      captureMode: "OFFLINE_FIXTURE_ONLY",
      runtime: RUNTIME,
      resources: { jobs: 0, sessions: 0, leases: 0, deviceIo: 0 },
      status: "PASS",
    }),
  });
  return { runner, fx, persisted };
}

function postEFixture({ phase }) {
  const fx = fakeRuntime({ r3: phase === "R3" });
  const captureAuthority = createTaskOwnedCpCaptureAuthority({
    signingKey: KEY,
    digestKeyId: RUNTIME.digestKeyId,
    runtimeBinding: RUNTIME,
    async persistCapture() {
      throw new Error("post-E runner must not mint corpus captures");
    },
  });
  const runner = createXhsV3PostECorpusProductionRunner({
    runtime: fx.runtime,
    captureAuthority,
    randomUUIDFn: () => `00000000-0000-4000-8000-00000000000${phase === "R3" ? "3" : "4"}`,
  });
  return { runner, fx };
}

test("R0 is calibration-only and creates no formal session/device resource", async () => {
  const { plan, privatePayload } = makeMission("R0");
  const f = fixtureRunner({ phase: "R0" });
  const result = await f.runner.run({ phase: "R0", plan, privatePayload });
  assert.equal(result.ok, true);
  assert.equal(result.captureMode, "OFFLINE_FIXTURE_ONLY");
  assert.deepEqual(result.resources, { jobs: 0, sessions: 0, leases: 0, deviceIo: 0 });
  assert.equal(f.fx.calls.length, 0);
  assert.equal(f.persisted.length, 0, "R0 cannot mint CP-bound/counting receipts");
});

test("R1 exact [03,04] formal wiring seals only CP_BOUND_R1_R2 captures for all five routes", async () => {
  const { plan, privatePayload } = makeMission("R1");
  const f = fixtureRunner({ phase: "R1" });
  const result = await f.runner.run({ phase: "R1", plan, privatePayload });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.ok, true);
  assert.equal(result.cleanup.leaseOracle.ok, true);
  assert.equal(result.cleanup.releases.length, 2);
  assert.equal(result.safety.socialTransport, 0);
  assert.equal(result.safety.visualPhysical, 0);
  assert.deepEqual(f.fx.calls.filter((call) => call.method === "createSession").map((call) => call.input.placement.alias), ["03", "04"]);
  assert.ok(f.fx.calls.filter((call) => call.method === "executeSessionAction").every(
    (call) => ["focus", "dump_ui"].includes(call.action.params.primitive),
  ), "generic formal session path is read-only; interactive work uses typed CP permits");
  assert.ok(f.fx.calls.filter((call) => call.method === "issueExplorationPermit").every(
    (call) => call.request.ttlMs === 5000,
  ));

  assert.equal(f.persisted.length, 10, "at most two captures per route in one wave");
  const routes = new Set(f.persisted.map((entry) => entry.receipt.classification.pageClass));
  assert.deepEqual(routes, new Set(["HOME_FEED", "SEARCH_RESULTS", "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL"]));
  for (const entry of f.persisted) {
    assert.equal(entry.receipt.captureMode, "CP_BOUND_R1_R2");
    assert.equal(entry.receipt.provenance.phase, "R1");
    assert.equal(entry.receipt.runtime.releaseId, RUNTIME.releaseId);
    assert.equal(entry.receipt.runtime.providerBundleDigest, RUNTIME.providerBundleDigest);
    assert.deepEqual(entry.receipt.safety, {
      socialTransport: 0, effectTransport: 0, visualIssued: 0, visualConsumed: 0, visualPhysical: 0,
    });
  }
  assert.equal(f.fx.journals["03"][0].type, "STARTED");
  assert.equal(f.fx.journals["04"][0].type, "STARTED");
  assert.equal(result.captureReceiptHashes.length, 10);
  assert.match(result.sharedBudget.proofHash, /^[0-9a-f]{64}$/u);
  assert.equal(result.sharedBudget.caps.novelOpens, 2);
  assert.ok(result.sharedBudget.used.totalSteps <= result.sharedBudget.caps.reservedPrimitives);
  assert.ok(result.sharedBudget.used.resultScreens
    <= result.sharedBudget.caps.resultScreensPerQuery);
  const novelReceipts = result.children.flatMap((child) => child.receipt.budgetReservations)
    .filter((receipt) => receipt.kind === "novelOpens")
    .map((receipt) => receipt.used).sort((left, right) => left - right);
  assert.deepEqual(novelReceipts, [1, 2], "both lanes share one authority-global novel-open sequence");
  assert.equal(result.view.budgetLedger.ledgerHash, result.sharedBudget.ledgerHash);
});

test("R2 uses the sealed real-provider shadow seam and can never issue/consume/physically tap visually", async () => {
  const { plan, privatePayload } = makeMission("R2");
  const f = fixtureRunner({ phase: "R2", r2: true });
  const result = await f.runner.run({ phase: "R2", plan, privatePayload });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.safety.visualIssued, 0);
  assert.equal(result.safety.visualConsumed, 0);
  assert.equal(result.safety.visualPhysical, 0);
  assert.equal(f.fx.calls.filter((call) => call.method === "createExplorationVisionNavigator").length, 2);
  assert.ok(f.fx.visionShadowCalls >= 1, "eligible VIDEO_NOTE is analyzed by shadow provider");
  assert.ok(result.children.every((child) => child.receipt.vision.permitsIssued === 0
    && child.receipt.vision.permitsConsumed === 0
    && child.receipt.vision.physicalTaps === 0));
  assert.ok(f.persisted.every((entry) => entry.receipt.provenance.phase === "R2"
    && entry.receipt.captureMode === "CP_BOUND_R1_R2"));
  assert.equal(result.sharedBudget.used.visionAnalysisAttempts, f.fx.visionShadowCalls);
  assert.equal(result.sharedBudget.used.visualPermitsIssued, 0);
});

test("R3 fresh E interlock gates resources and only alias 03 may consume the global visual one-shot", async () => {
  const { plan, privatePayload } = makePostEMission("R3");
  const f = postEFixture({ phase: "R3" });
  let verifies = 0;
  const interlock = {
    verifyR3(input) {
      verifies += 1;
      assert.deepEqual(input, {
        ref: E_REF,
        releaseId: RUNTIME.releaseId,
        sourceCommit: RUNTIME.sourceCommit,
        providerBundleDigest: RUNTIME.providerBundleDigest,
      });
      return {
        ok: true,
        status: "PASS",
        artifactHash: E_REF.artifactHash,
        effectiveVisualPermitBudget: 1,
      };
    },
  };
  const result = await f.runner.run({ phase: "R3", plan, privatePayload, eCorpusInterlock: interlock });
  assert.equal(verifies, 1, "fresh E verification occurs at the pre-acquire boundary");
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.cleanup.authorityClosed.ok, true);
  assert.equal(result.cleanup.leaseOracle.ok, true);
  assert.equal(result.safety.socialTransport, 0);
  assert.equal(result.safety.effectTransport, 0);
  assert.ok(result.safety.visualIssued <= 1);
  assert.ok(result.safety.visualConsumed <= result.safety.visualIssued);
  assert.ok(result.safety.visualPhysical <= result.safety.visualConsumed);
  assert.equal(f.fx.calls.filter((call) => call.method === "createExplorationVisionNavigator").length, 1);
  assert.ok(f.fx.visionCanaryCalls >= 1, "alias 03 exercised the real one-shot canary seam");
  assert.equal(result.children.find((child) => child.alias === "04").receipt.vision.permitsIssued, 0);
  assert.equal(result.children.find((child) => child.alias === "04").receipt.vision.physicalTaps, 0);
  assert.equal(result.captureReceiptHashes.length, 0);
  assert.equal(result.sharedBudget.used.visionAnalysisAttempts, f.fx.visionCanaryCalls);
  assert.ok(result.sharedBudget.used.visualPermitsIssued <= 1);
  assert.ok(result.sharedBudget.used.visualPhysicalTaps <= 1);
});

test("R3 invalid E proof fails before sessions and R4 exact pair restores visual hard zero", async () => {
  const r3Mission = makePostEMission("R3");
  const blocked = postEFixture({ phase: "R3" });
  await assert.rejects(
    () => blocked.runner.run({
      phase: "R3",
      ...r3Mission,
      eCorpusInterlock: { verifyR3: () => ({ ok: false }) },
    }),
    (error) => error.code === "ECORPUS_VERIFICATION_INVALID",
  );
  assert.equal(blocked.fx.calls.filter((call) => call.method === "createSession").length, 0);

  const r4Mission = makePostEMission("R4");
  const r4 = postEFixture({ phase: "R4" });
  const result = await r4.runner.run({ phase: "R4", ...r4Mission, eCorpusInterlock: null });
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(result.safety, {
    socialTransport: 0,
    effectTransport: 0,
    visualIssued: 0,
    visualConsumed: 0,
    visualPhysical: 0,
  });
  assert.equal(r4.fx.calls.filter((call) => call.method === "createExplorationVisionNavigator").length, 0);
  assert.equal(result.children.every((child) => child.receipt.restored.restored === true), true);
  assert.equal(result.cleanup.releases.length, 2);
  assert.equal(result.cleanup.leaseOracle.activeLeaseCount, 0);
  assert.equal(result.sharedBudget.used.visualPermitsIssued, 0);
  assert.equal(result.sharedBudget.used.visualPhysicalTaps, 0);
});

test("caller aliases/endpoints/providers/paths/modules/roles/E-data reject before any resource", async () => {
  const { plan, privatePayload } = makeMission("R1");
  const f = fixtureRunner({ phase: "R1" });
  for (const forbidden of [
    ["alias", "03"], ["endpoint", "http://127.0.0.1:9"], ["provider", {}],
    ["path", "C:\\tmp"], ["module", "fixture.mjs"], ["role", "feed_lane"], ["eCorpus", {}],
  ]) {
    await assert.rejects(
      () => f.runner.run({ phase: "R1", plan, privatePayload, [forbidden[0]]: forbidden[1] }),
      (error) => error.code === "XHS_V3_INVOCATION_FIELDS_FORBIDDEN",
    );
  }
  assert.equal(f.fx.calls.length, 0);
  const wrongPrivate = { ...privatePayload, queries: ["被篡改的查询"] };
  await assert.rejects(
    () => f.runner.run({ phase: "R1", plan, privatePayload: wrongPrivate }),
    (error) => error.code === "EXPLORATION_PAYLOAD_MISMATCH",
  );
  assert.equal(f.fx.calls.length, 0);
});

test("task CLI accepts only phase plus opaque invocation id and never a caller-selected surface", async () => {
  const { plan, privatePayload } = makeMission("R1");
  const f = fixtureRunner({ phase: "R1" });
  const emitted = [];
  let loadedId = null;
  const result = await runXhsV3TaskCli(["r1", "--invocation-id", "invocation-001"], {
    runner: f.runner,
    async loadTaskInvocation(invocationId) {
      loadedId = invocationId;
      return {
        schemaId: "xw.xhs.v3-task-invocation.v1",
        plan,
        privatePayload,
      };
    },
    emit: (value) => emitted.push(value),
  });
  assert.equal(loadedId, "invocation-001");
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(emitted.length, 1);

  for (const argv of [
    ["r1", "--alias", "03"],
    ["r2", "--provider", "caller"],
    ["r1", "--invocation-id", "C:\\caller\\path"],
    ["r1", "--invocation-id", "ok", "--endpoint", "http://127.0.0.1:9"],
  ]) {
    await assert.rejects(
      () => runXhsV3TaskCli(argv, { runner: f.runner, loadTaskInvocation: async () => null }),
      (error) => error.code === "XHS_V3_TASK_ARGUMENT_INVALID",
    );
  }
});
