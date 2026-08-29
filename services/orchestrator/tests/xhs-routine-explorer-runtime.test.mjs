import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExplorerRoutineRuntime } from "../ops/_xhs-routine-explorer-runtime.mjs";
import { createProductionExplorationVisionNavigator } from "../ops/_xhs-routine-vision-factory.mjs";
import { hashFilePinned, resolvePinnedVisionConfig } from "../scripts/lib/xhs-exploration-vision.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Explorer runtime maps one exact 03 binding onto formal CP session/action/release APIs", async (t) => {
  const contextRoot = mkdtempSync(join(tmpdir(), "xhs-routine-context-"));
  t.after(() => rmSync(contextRoot, { recursive: true, force: true }));
  const controlBase = "http://127.0.0.1:19020";
  const registryBase = "http://127.0.0.1:19030";
  const actorId = "agent:xhs-routine";
  const sessionId = "session-03";
  const leaseId = "lease-03";
  const deviceId = "device-03";
  const token = "private-session-token";
  let leases = [];
  const calls = [];

  const entry = () => ({
    devices: [{
      alias: "03",
      serial: "private-serial",
      deviceId,
      control: { deviceId },
      state: { online: true, ready: true, quarantined: false, leaseFree: leases.length === 0 },
      metadata: { width: 1080, height: 2400 },
    }],
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ origin: parsed.origin, path: parsed.pathname, method, body });
    if (parsed.origin === registryBase && parsed.pathname === "/api/agent-entry") return json(entry());
    if (parsed.origin !== controlBase) return json({ error: { code: "UNEXPECTED_ORIGIN" } }, 500);
    if (method === "POST" && parsed.pathname === "/control/v1/sessions") {
      assert.deepEqual(body, {
        actorId,
        capabilityId: "xiaowei.explorer.primitive",
        canary: true,
        placement: { alias: "03" },
      });
      leases = [{ leaseId, sessionId, deviceId, kind: "interactive", holderId: actorId }];
      return json({
        session: {
          sessionId,
          leaseId,
          token,
          deviceId,
          actorId,
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      }, 201);
    }
    if (method === "GET" && parsed.pathname === "/control/v1/leases") return json({ leases });
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/heartbeat`) {
      assert.equal(body.token, token);
      return json({
        session: {
          sessionId,
          leaseId,
          deviceId,
          actorId,
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      });
    }
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/actions`) {
      assert.equal(body.token, token);
      assert.equal(body.params.primitive, "focus");
      return json({
        job: {
          jobId: "job-focus",
          runId: "run-focus",
          status: "succeeded",
          result: { output: { ok: true, package: "com.xingin.xhs", activity: "IndexActivityV2" } },
        },
      });
    }
    if (method === "POST" && parsed.pathname === `/control/v1/sessions/${sessionId}/release`) {
      assert.equal(body.token, token);
      leases = [];
      return json({ released: true });
    }
    return json({ error: { code: "UNEXPECTED_ROUTE", message: `${method} ${parsed.pathname}` } }, 500);
  };

  const runtime = createExplorerRoutineRuntime({
    controlBase,
    registryBase,
    fetchImpl,
    contextRoot,
    allowTestEndpoints: true,
    skipAclHardening: true,
  });
  const session = await runtime.createSession({
    actorId,
    capabilityId: "xiaowei.explorer.primitive",
    canary: true,
    placement: { alias: "03" },
  });
  assert.equal(session.routeDecision.selectedDevice.alias, "03");
  assert.equal(session.token, token);
  assert.equal(readdirSync(contextRoot).length, 1, "one private session context exists while the lease is active");
  const action = await runtime.executeSessionAction(sessionId, token, {
    idempotencyKey: "xhs-routine:test:1",
    params: { primitive: "focus" },
  });
  assert.equal(action.status, "succeeded");
  assert.equal(action.authorization.sessionId, sessionId);
  assert.equal((await runtime.listLeases()).length, 1);
  assert.equal((await runtime.getDevice(deviceId)).alias, "03");
  assert.equal((await runtime.releaseSession(sessionId, token)).released, true);
  assert.equal((await runtime.listLeases()).length, 0);
  assert.equal(calls.some((call) => call.path.endsWith("/actions")), true);
  assert.equal(calls.some((call) => call.path.endsWith("/release")), true);
  assert.equal(readdirSync(contextRoot).length, 0, "the private session context is removed after release");
});

test("production runtime rejects caller-selected loopback ports", () => {
  assert.throws(
    () => createExplorerRoutineRuntime({ controlBase: "http://127.0.0.1:19020" }),
    (error) => error.code === "ROUTINE_ENDPOINT_INVALID",
  );
});

test("production runtime rejects caller-selected exploration vision config", () => {
  assert.throws(
    () => createExplorerRoutineRuntime({ explorationVisionConfigPath: "C:\\tmp\\caller-vision.json" }),
    (error) => error.code === "EXPLORATION_VISION_CONFIG_OVERRIDE_FORBIDDEN",
  );
  assert.throws(
    () => createExplorerRoutineRuntime({ explorationVisionFactory: () => ({}) }),
    (error) => error.code === "EXPLORATION_VISION_FACTORY_OVERRIDE_FORBIDDEN",
  );
});

test("V3 production factory re-hashes the sealed provider and constructs one bounded lane queue", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-exploration-factory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "analyze.py");
  const model = join(root, "model.bin");
  const configPath = join(root, "xhs-exploration-vision-provider.v1.json");
  writeFileSync(script, "# pinned analysis script\n", "utf8");
  writeFileSync(model, Buffer.from("pinned-model"));
  const config = {
    schemaId: "xw.xhs.exploration-vision-config.v1",
    schemaVersion: 1,
    pin: {
      python: { path: process.execPath, sha256: hashFilePinned(process.execPath) },
      script: { path: script, sha256: hashFilePinned(script) },
      model: { path: model, sha256: hashFilePinned(model) },
    },
    rules: {
      mode: "shadow",
      roles: ["PAUSE_VIDEO_SAFE_ZONE"],
      targets: ["暂停"],
      allowEffectLabels: false,
      maxAnalysisAttemptsGlobal: 6,
    },
    analysis: {
      protocol: "xw.xhs.exploration-vision-process.v1",
      maxBufferBytes: 4096,
      timeoutMs: 125,
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const resolved = resolvePinnedVisionConfig(configPath);
  assert.throws(
    () => createProductionExplorationVisionNavigator({
      mode: "shadow",
      alias: "03",
      providerBinding: resolved.provider,
      captureFrame: async () => ({}),
      configPath,
    }),
    (error) => error.code === "EXPLORATION_VISION_CONFIG_OVERRIDE_FORBIDDEN",
  );
  let analyzerClosed = false;
  let analyzerRequest = null;
  const pngBytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(pngBytes, 0);
  pngBytes.writeUInt32BE(1_080, 16);
  pngBytes.writeUInt32BE(2_400, 20);
  const frameHash = createHash("sha256").update(pngBytes).digest("hex");
  const navigator = createProductionExplorationVisionNavigator({
    mode: "shadow",
    alias: "03",
    providerBinding: resolved.provider,
    captureFrame: async () => ({
      frameId: "frame-1",
      pngPath: join(root, "unused-source.png"),
      bytes: pngBytes,
      frameHash,
      capturedAt: Date.now(),
    }),
    configPath,
    allowTestConfigOverride: true,
    stagingRoot: join(root, "private"),
    reserveAnalysisAttempt: async () => ({ reservationId: "reservation-test" }),
    settleAnalysisAttempt: async () => ({ reservationId: "reservation-test" }),
    analyzerFactory() {
      return {
        analyze: async (request) => {
          analyzerRequest = request;
          return [{
            label: "暂停",
            bounds: { x: 100, y: 300, w: 200, h: 160 },
            confidence: 0.91,
            capturedAt: request.frame.capturedAt,
          }];
        },
        close: async () => { analyzerClosed = true; },
      };
    },
  });
  assert.equal(navigator.mode, "shadow");
  assert.deepEqual(navigator.providerIdentity, resolved.provider);
  assert.deepEqual(navigator.queueStats(), { inflight: 0, queued: 0 });
  const observed = await navigator.observeShadow({
    navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
    page: "VIDEO_NOTE",
    evidenceHash: "e".repeat(64),
    dumpDecision: {
      page: "VIDEO_NOTE",
      verdict: "AMBIGUOUS_SAFE",
      positiveRegion: { x: 0, y: 100, w: 1_080, h: 2_000 },
      protectedZones: [],
    },
  });
  assert.equal(observed.ok, true);
  assert.equal(observed.tapAuthorized, false);
  assert.equal(analyzerRequest.deadlineMs, 125, "pinned timeout narrows the global 8s ceiling");
  assert.equal(analyzerRequest.frame.frameHash, frameHash);
  await navigator.close();
  assert.equal(analyzerClosed, true);
  assert.throws(
    () => createProductionExplorationVisionNavigator({
      mode: "shadow",
      alias: "03",
      providerBinding: { ...resolved.provider, modelHash: "f".repeat(64) },
      captureFrame: async () => ({}),
      reserveAnalysisAttempt: async () => ({ reservationId: "reservation-test" }),
      settleAnalysisAttempt: async () => ({ reservationId: "reservation-test" }),
      configPath,
      allowTestConfigOverride: true,
      analyzerFactory: () => ({ analyze: async () => [], close: async () => {} }),
    }),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_DRIFT",
  );
  assert.throws(
    () => createProductionExplorationVisionNavigator({
      mode: "canary1",
      alias: "04",
      providerBinding: resolved.provider,
      captureFrame: async () => ({}),
      configPath,
    }),
    (error) => error.code === "EXPLORATION_VISION_CANARY_ALIAS_FORBIDDEN",
  );
});

// Regression (live S2 window 1, 2026-08-28): the register client dropped
// sessionId from the POST body; the CP router fed `undefined` into
// validateSession and the SQL bind failure surfaced as CONTROL_INTERNAL_ERROR.
test("authority registration sends the sessionId in the POST body", async (t) => {
  const contextRoot = mkdtempSync(join(tmpdir(), "xhs-routine-context-reg-"));
  t.after(() => rmSync(contextRoot, { recursive: true, force: true }));
  const controlBase = "http://127.0.0.1:19020";
  const registryBase = "http://127.0.0.1:19030";
  const sessionId = "session-03";
  const leaseId = "lease-03";
  const deviceId = "device-03";
  const token = "private-session-token";
  const entry = () => ({
    devices: [{
      alias: "03",
      serial: "private-serial",
      deviceId,
      control: { deviceId },
      state: { online: true, ready: true, quarantined: false, leaseFree: true },
      metadata: { width: 1080, height: 2400 },
    }],
  });
  let registerBody = null;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (parsed.origin === registryBase && parsed.pathname === "/api/agent-entry") return json(entry());
    if (parsed.origin !== controlBase) return json({ error: { code: "UNEXPECTED_ORIGIN" } }, 500);
    if (method === "POST" && parsed.pathname === "/control/v1/sessions") {
      return json({
        session: {
          sessionId, leaseId, token, deviceId,
          actorId: "agent:xhs-routine",
          scopeCapabilityId: "xiaowei.explorer.primitive",
          canary: true,
          routeDecision: { selectedDevice: { alias: "03", deviceId } },
        },
      }, 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/routine-authority") {
      registerBody = body;
      return json({ authority: { authorityId: "routine-auth-1", status: "active" } }, 201);
    }
    if (method === "GET" && parsed.pathname === "/control/v1/leases") {
      return json({ leases: [{ leaseId, sessionId, deviceId, kind: "interactive", holderId: "agent:xhs-routine" }] });
    }
    return json({ error: { code: "UNEXPECTED_ROUTE", message: `${method} ${parsed.pathname}` } }, 500);
  };
  const runtime = createExplorerRoutineRuntime({
    controlBase,
    registryBase,
    fetchImpl,
    contextRoot,
    allowTestEndpoints: true,
    skipAclHardening: true,
  });
  await runtime.createSession({
    actorId: "agent:xhs-routine",
    capabilityId: "xiaowei.explorer.primitive",
    canary: true,
    placement: { alias: "03" },
  });
  const authority = await runtime.registerRoutineAuthority({
    sessionId,
    token,
    executionRunId: "xe-reg-1",
    routineRunId: "rr-reg-1",
    planHash: "a".repeat(64),
    effectCaps: { like: 1, comment: 0 },
    canaryAuthorized: true,
    accountFingerprint: null,
  });
  assert.equal(authority.authorityId, "routine-auth-1");
  assert.ok(registerBody, "register must POST to /control/v1/routine-authority");
  assert.equal(registerBody.sessionId, sessionId, "sessionId must travel in the body: the CP router keys registration off it");
  assert.equal(registerBody.alias, "03");
  assert.equal(registerBody.token, token);
  assert.deepEqual(registerBody.effectCaps, { like: 1, comment: 0 });
});

test("V3 runtime binds all exploration RPCs, screen bytes, and vision factory to owned sessions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-exploration-runtime-"));
  const contextRoot = join(root, "contexts");
  const runsRoot = join(root, "runs");
  mkdirSync(contextRoot, { recursive: true });
  mkdirSync(runsRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controlBase = "http://127.0.0.1:19020";
  const registryBase = "http://127.0.0.1:19030";
  const sessions = {
    "03": { sessionId: "session-v3-03", leaseId: "lease-v3-03", token: "token-v3-03", deviceId: "device-v3-03" },
    "04": { sessionId: "session-v3-04", leaseId: "lease-v3-04", token: "token-v3-04", deviceId: "device-v3-04" },
  };
  const leases = [];
  const calls = [];
  let factoryInput = null;
  const registryEntry = () => ({
    devices: ["03", "04"].map((alias) => ({
      alias,
      serial: `private-${alias}`,
      deviceId: sessions[alias].deviceId,
      control: { deviceId: sessions[alias].deviceId },
      state: {
        online: true,
        ready: true,
        quarantined: false,
        leaseFree: !leases.some((lease) => lease.deviceId === sessions[alias].deviceId),
      },
      metadata: { width: 1080, height: 2400 },
    })),
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: parsed.pathname, body });
    if (parsed.origin === registryBase && parsed.pathname === "/api/agent-entry") return json(registryEntry());
    if (parsed.origin !== controlBase) return json({ error: { code: "UNEXPECTED_ORIGIN" } }, 500);
    if (method === "GET" && parsed.pathname === "/control/v1/leases") return json({ leases });
    if (method === "POST" && parsed.pathname === "/control/v1/sessions") {
      const alias = body.placement.alias;
      const session = sessions[alias];
      leases.push({
        leaseId: session.leaseId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        kind: "interactive",
        holderId: body.actorId,
      });
      return json({ session: {
        ...session,
        actorId: body.actorId,
        scopeCapabilityId: "xiaowei.explorer.primitive",
        canary: true,
        routeDecision: { selectedDevice: { alias, deviceId: session.deviceId } },
      } }, 201);
    }
    const heartbeat = parsed.pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/heartbeat$/);
    if (method === "POST" && heartbeat) {
      const session = Object.values(sessions).find((row) => row.sessionId === heartbeat[1]);
      const alias = session === sessions["03"] ? "03" : "04";
      return json({ session: {
        ...session,
        actorId: "agent:xhs-goal-explore",
        scopeCapabilityId: "xiaowei.explorer.primitive",
        canary: true,
        routeDecision: { selectedDevice: { alias, deviceId: session.deviceId } },
      } });
    }
    const action = parsed.pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/actions$/);
    if (method === "POST" && action) {
      assert.equal(body.params.primitive, "screen");
      const runId = `run-screen-${action[1]}`;
      const runDirectory = join(runsRoot, runId);
      const evidenceDirectory = join(runDirectory, "evidence");
      mkdirSync(evidenceDirectory, { recursive: true });
      const path = join(evidenceDirectory, "screen.png");
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return json({ job: {
        jobId: `job-screen-${action[1]}`,
        runId,
        status: "succeeded",
        result: { output: { ok: true, path } },
        storage: { runDirectory, evidenceDirectory },
      } });
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority") {
      return json({ authority: { authorityId: "expl-auth-v3", status: "active" } }, 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3") {
      if (body.action === "close") return json({ authority: { authorityId: "expl-auth-v3", status: "closed" } });
      return json({
        authority: { authorityId: "expl-auth-v3", status: "active" },
        lanes: { "03": { committed: false }, "04": { committed: false } },
        allSettled: false,
      });
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/permits") {
      return json({ permit: { permitId: "expl-permit-v3", ...body } }, 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/permits/expl-permit-v3/consume") {
      return json({ permit: { permitId: "expl-permit-v3" }, job: { jobId: "expl-job-v3", status: "succeeded" } });
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/budget") {
      return json({ reservation: {
        reservationId: body.reservationId || "expl-res-v3",
        kind: body.kind || "resultScreens",
        outcome: body.outcome || null,
      } }, body.action === "settle" ? 200 : 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/vision-analysis") {
      assert.equal(Object.hasOwn(body, "alias"), false);
      assert.equal(Object.hasOwn(body, "kind"), false);
      assert.equal(Object.hasOwn(body, "amount"), false);
      return json({ reservation: {
        reservationId: body.reservationId || "expl-vision-res-v3",
        alias: "03",
        amount: 1,
        kind: "visionAnalysisAttempts",
        outcome: body.outcome || null,
      } }, body.action === "settle" ? 200 : 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/targets/claim") {
      return json({ target: { targetId: body.targetId || "expl-target-v3", action: body.action || "claim" } }, body.action ? 200 : 201);
    }
    if (method === "POST" && parsed.pathname === "/control/v1/exploration-authority/expl-auth-v3/journal") {
      if (body.action === "commit") return json({ lane: { alias: "03", receiptHash: "e".repeat(64) } });
      return json({ recordHash: "d".repeat(64) }, 201);
    }
    return json({ error: { code: "UNEXPECTED_ROUTE", message: `${method} ${parsed.pathname}` } }, 500);
  };

  const runtime = createExplorerRoutineRuntime({
    controlBase,
    registryBase,
    fetchImpl,
    contextRoot,
    allowTestEndpoints: true,
    skipAclHardening: true,
    explorationVisionConfigPath: join(root, "test-only-vision-config.json"),
    explorationVisionFactory(input) {
      factoryInput = input;
      return { mode: input.mode, close: async () => {} };
    },
    now: () => 1_800_000_000_000,
  });
  for (const alias of ["03", "04"]) {
    await runtime.createSession({
      actorId: "agent:xhs-goal-explore",
      capabilityId: "xiaowei.explorer.primitive",
      canary: true,
      placement: { alias },
    });
  }
  const authority = await runtime.registerExplorationAuthority({
    sessions: [
      { alias: "03", sessionId: sessions["03"].sessionId, token: sessions["03"].token },
      { alias: "04", sessionId: sessions["04"].sessionId, token: sessions["04"].token },
    ],
    executionRunId: "xe-v3",
    routineRunId: "rr-v3",
    mission: { missionHash: "a".repeat(64) },
    planHash: "b".repeat(64),
  });
  assert.equal(authority.authorityId, "expl-auth-v3");

  const binding = { sessionId: sessions["03"].sessionId, token: sessions["03"].token, authorityId: authority.authorityId };
  assert.equal((await runtime.getExplorationAuthorityView(binding)).authority.authorityId, authority.authorityId);
  const permit = await runtime.issueExplorationPermit({
    ...binding,
    navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
    page: "VIDEO_NOTE",
    evidenceHash: "c".repeat(64),
    resolvedPayload: { primitive: "tap", x: 540, y: 1200 },
    ttlMs: 5_000,
    visualProof: {
      frameId: "frame-proof-v3",
      frameHash: "f".repeat(64),
      capturedAt: 1_800_000_000_000,
      analysisRef: "analysis-proof-v3",
      providerIdentity: {
        pythonHash: "0".repeat(64),
        modelHash: "1".repeat(64),
        scriptHash: "2".repeat(64),
        configHash: "3".repeat(64),
      },
      target: { bounds: { x: 100, y: 300, w: 200, h: 160 } },
    },
  });
  assert.equal(permit.permitId, "expl-permit-v3");
  assert.equal(permit.visualProof.frameId, "frame-proof-v3");
  assert.equal((await runtime.consumeExplorationPermit({
    ...binding,
    permitId: permit.permitId,
    payload: { primitive: "tap", x: 540, y: 1200 },
    freshObservation: { page: "VIDEO_NOTE", overlaySafe: true, evidenceHash: "c".repeat(64) },
  })).job.jobId, "expl-job-v3");
  const reservation = await runtime.reserveExplorationBudget({ ...binding, alias: "03", kind: "resultScreens", amount: 1 });
  assert.equal(reservation.reservationId, "expl-res-v3");
  assert.equal((await runtime.settleExplorationReservation({
    ...binding, reservationId: reservation.reservationId, outcome: "provider-ok",
  })).outcome, "provider-ok");
  const visionReservation = await runtime.reserveExplorationVisionAnalysis({
    ...binding,
    detail: { source: "runtime-wrapper-test" },
  });
  assert.equal(visionReservation.reservationId, "expl-vision-res-v3");
  assert.equal((await runtime.settleExplorationVisionAnalysis({
    ...binding,
    reservationId: visionReservation.reservationId,
    outcome: "failed",
  })).outcome, "failed");
  const target = await runtime.claimExplorationTarget({ ...binding, keyKind: "stable", keyValue: "opaque-key", alias: "03" });
  assert.equal((await runtime.confirmExplorationTarget({ ...binding, targetId: target.targetId })).action, "confirm");
  assert.equal((await runtime.markExplorationTargetUnknown({ ...binding, targetId: target.targetId })).action, "unknown");
  assert.equal((await runtime.appendExplorationLaneRecord({
    ...binding, alias: "03", type: "STARTED", payload: { laneRole: "feed_lane" },
  })).recordHash, "d".repeat(64));
  assert.equal((await runtime.commitExplorationLane(binding)).receiptHash, "e".repeat(64));

  const frame = await runtime.captureExplorationFrame({
    sessionId: sessions["03"].sessionId,
    token: sessions["03"].token,
    routineRunId: "rr-v3-03",
  });
  assert.equal(Buffer.isBuffer(frame.bytes), true);
  assert.match(frame.frameHash, /^[0-9a-f]{64}$/);
  assert.equal(frame.capturedAt, 1_800_000_000_000);

  const navigator = runtime.createExplorationVisionNavigator({
    mode: "shadow",
    providerBinding: {
      pythonHash: "0".repeat(64),
      modelHash: "1".repeat(64),
      scriptHash: "2".repeat(64),
      configHash: "3".repeat(64),
    },
    ...binding,
    routineRunId: "rr-v3-03",
  });
  assert.equal(navigator.mode, "shadow");
  assert.ok(factoryInput, "runtime invoked the production exploration vision factory seam");
  assert.equal(factoryInput.alias, "03");
  assert.equal(factoryInput.configPath, join(root, "test-only-vision-config.json"));
  assert.equal(Buffer.isBuffer((await factoryInput.captureFrame()).bytes), true);
  const factoryReservation = await factoryInput.reserveAnalysisAttempt({ frameHash: frame.frameHash });
  assert.equal(factoryReservation.reservationId, "expl-vision-res-v3");
  await factoryInput.settleAnalysisAttempt({
    reservationId: factoryReservation.reservationId,
    outcome: "consumed",
    result: { providerIdentity: { modelHash: "1".repeat(64) } },
  });
  await factoryInput.journalAppend({ type: "VISION_SHADOW", tapAuthorized: false });
  assert.equal((await runtime.closeExplorationAuthority({ ...binding, reason: "test-finished" })).status, "closed");

  const registerCall = calls.find((call) => call.path === "/control/v1/exploration-authority");
  assert.deepEqual(registerCall.body.sessions.map((row) => row.alias), ["03", "04"]);
  assert.equal(registerCall.body.sessions[0].token, sessions["03"].token);
  assert.equal(calls.some((call) => call.path.endsWith("/permits/expl-permit-v3/consume")), true);
  assert.equal(calls.some((call) => call.path.endsWith("/vision-analysis") && call.body.action === "settle"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/targets/claim") && call.body.action === "unknown"), true);
});
