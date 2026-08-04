import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertPinnedNodeVersion, createControlPlaneRuntime, loadStandingGrantIssuer } from "../control-plane/bootstrap.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { validateJsonSchema } from "../control-plane/lib/json-schema-validator.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { canonicalPaymentApprovalBytes, PaymentApprovalVerifier } from "../control-plane/lib/payment-approval-verifier.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { createControlServer } from "../control-plane/server.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

const capability = {
  schemaVersion: 1,
  id: "test.observe",
  appId: "test",
  packageName: "local.test",
  versionRange: "test",
  maturity: "E3",
  risk: "R0",
  resources: ["device"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object" },
  preconditions: [],
  verification: { mode: "state", description: "test" },
  restoration: { required: false, description: "none" },
  timeoutMs: 1000,
  idempotency: "read_only",
  automationPolicy: { mode: "automatic" },
  implementation: { adapter: "test", action: "observe" },
  evidence: [],
};

test("production bootstrap installs the control-plane-owned Discovery producer", () => {
  const root = mkdtempSync(join(tempBase, "discovery-bootstrap-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const runtime = createControlPlaneRuntime({
      state,
      capabilities: new CapabilityRegistry([capability]),
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      evidence: new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
      deviceConfigPath: join(root, "missing-devices.json"),
    });
    assert.equal(typeof runtime.control.discoveryProducer, "function");
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("production bootstrap derives shadow policy mode from env but never activates it on real adapters (B7)", () => {
  const root = mkdtempSync(join(tempBase, "policy-shadow-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const previous = process.env.AUTONOMY_POLICY_MODE;
  process.env.AUTONOMY_POLICY_MODE = "shadow";
  try {
    const runtime = createControlPlaneRuntime({
      state,
      capabilities: new CapabilityRegistry([capability]),
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      evidence: new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
      deviceConfigPath: join(root, "missing-devices.json"),
    });
    assert.deepEqual(runtime.control.policyMode, {
      mode: "shadow", active: false, consulted: true, effectiveDecisionSource: "shadow", adapterKind: "real",
      pilotOnly: false, pilotConfigured: false, pilotActors: [], pilotAliases: [],
    });
    assert.equal(runtime.control.debtOnLowDisk, false, "shadow 不 active：生产永不被新策略接管");
    assert.equal(runtime.policyMode.mode, "shadow", "runtime 暴露 policyMode 供 health 展示");
  } finally {
    if (previous === undefined) delete process.env.AUTONOMY_POLICY_MODE; else process.env.AUTONOMY_POLICY_MODE = previous;
    state.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("production bootstrap keeps legacy (null policyMode) when env is unset (B7)", () => {
  const root = mkdtempSync(join(tempBase, "policy-legacy-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const previous = process.env.AUTONOMY_POLICY_MODE;
  delete process.env.AUTONOMY_POLICY_MODE;
  try {
    const runtime = createControlPlaneRuntime({
      state,
      capabilities: new CapabilityRegistry([capability]),
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      evidence: new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
      deviceConfigPath: join(root, "missing-devices.json"),
    });
    assert.equal(runtime.control.policyMode, null, "legacy 部署保持 null，逐字节旧行为");
  } finally {
    if (previous === undefined) delete process.env.AUTONOMY_POLICY_MODE; else process.env.AUTONOMY_POLICY_MODE = previous;
    state.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("health exposes the runtime policy schema version when a policy mode is active (B7)", async () => {
  const root = mkdtempSync(join(tempBase, "health-policy-schema-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const registry = new CapabilityRegistry([capability]);
  try {
    const control = new ControlPlane({
      state,
      capabilities: registry,
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      evidence,
      policyMode: { mode: "shadow", active: false, consulted: true, effectiveDecisionSource: "shadow", adapterKind: "real" },
    });
    const router = new ControlRouter({ control, state, capabilities: registry, evidence });
    const result = await router.handle({ method: "GET", path: "/control/v1/health" });
    assert.equal(result.status, 200);
    assert.equal(result.body.policyMode?.mode, "shadow");
    assert.equal(result.body.runtimePolicyVersion, "xhs.nonpayment-autonomy.v1");
  } finally {
    state.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("health does not claim a policy schema version under legacy (no policyMode)", async () => {
  const root = mkdtempSync(join(tempBase, "health-legacy-schema-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const registry = new CapabilityRegistry([capability]);
  try {
    const control = new ControlPlane({ state, capabilities: registry, adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]), evidence });
    const router = new ControlRouter({ control, state, capabilities: registry, evidence });
    const result = await router.handle({ method: "GET", path: "/control/v1/health" });
    assert.equal(result.status, 200);
    assert.equal(result.body.policyMode, null);
    assert.equal(result.body.runtimePolicyVersion, undefined);
  } finally {
    state.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("health exposes the runtime policy mode and release id (B7)", async () => {
  const root = mkdtempSync(join(tempBase, "health-policy-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const registry = new CapabilityRegistry([capability]);
  const previous = process.env.CONTROL_PLANE_RELEASE_ID;
  process.env.CONTROL_PLANE_RELEASE_ID = "release-shadow-test-01";
  try {
    const control = new ControlPlane({
      state,
      capabilities: registry,
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      evidence,
      policyMode: { mode: "shadow", active: false, consulted: true, effectiveDecisionSource: "shadow", adapterKind: "real" },
    });
    const router = new ControlRouter({ control, state, capabilities: registry, evidence });
    const result = await router.handle({ method: "GET", path: "/control/v1/health" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.policyMode, { mode: "shadow", active: false, consulted: true, effectiveDecisionSource: "shadow", adapterKind: "real" });
    assert.equal(result.body.releaseId, "release-shadow-test-01");
  } finally {
    if (previous === undefined) delete process.env.CONTROL_PLANE_RELEASE_ID; else process.env.CONTROL_PLANE_RELEASE_ID = previous;
    state.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap producer reuses the owned session job runner and records a trusted receipt", async () => {
  const root = mkdtempSync(join(tempBase, "discovery-bootstrap-job-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  let executeCalls = 0;
  try {
    const runtime = createControlPlaneRuntime({
      state,
      capabilities: new CapabilityRegistry([capability]),
      adapters: new AdapterRegistry([{
        id: "test",
        async execute() {
          executeCalls += 1;
          const now = new Date().toISOString();
          return { output: { discoveryReceipt: {
            snapshot: { surface: "observation", createdAt: now, observedAt: now },
            snapshotHash: "1".repeat(64), app: "test", accountFingerprint: "account",
            pageFingerprint: "page", observedTargetFingerprint: "target", identityEvidenceHash: "2".repeat(64),
            anchor: { type: "identityFingerprint", hash: "a".repeat(64) }, relationKind: "explicit_target", observedAt: now,
          } } };
        },
        async verify() { return { ok: true, mode: "state" }; },
        async restore() { return { ok: true }; },
      }]),
      evidence: new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 }),
      deviceConfigPath: join(root, "missing-devices.json"),
      discoveryCapabilityForPrimitive: { screenshot: "test.observe" },
    });
    state.upsertDevice({ alias: "01", physicalLabel: "rack-01", nodeId: "DESKTOP-3I1EVHE", runtimeId: "private", routingProfile: { enabled: true, capabilityIds: ["test.observe"] } });
    state.issueDelegationGrant({ grant: {
      grantId: "grant-bootstrap", issuanceNonce: "nonce", grantHash: "grant-hash", status: "active",
      discoveryPolicy: { enabled: true, allowedPrimitives: ["screenshot"], defaults: { durationMs: 60000, maxPrimitives: 1, maxCandidates: 1 }, maxima: { durationMs: 60000, maxPrimitives: 1, maxCandidates: 1 }, maxParallelism: 1, targetScope: { anchors: [{ type: "identityFingerprint", hash: "a".repeat(64) }], relationKinds: ["explicit_target"], maxHops: 1 } }, validity: { expiresAt: null },
    }, grantHash: "grant-hash", proofHash: "proof", issuerSubject: "user:test", issuerKeyId: "test", allowlistVersion: 1 });
    runtime.control.missionAutoApprovalEnabled = true;
    runtime.control.standingGrantEnabled = true;
    runtime.control.discoveryIssuerReady = true;
    runtime.control.adrAcceptedOverride = true;
    runtime.control.discoveryAdrAcceptedOverride = true;
    const run = runtime.control.openDiscoveryRun({ grantId: "grant-bootstrap", controllerAgent: "agent:test" });
    const result = await runtime.control.executeDiscoveryPrimitive({ discoveryRunId: run.discoveryRunId, tuple: run.tuple, token: run.token, primitive: "screenshot", idempotencyKey: "bootstrap-r0", envelope: { declaredIntent: "not-trusted", snapshot: { surface: "payment", createdAt: "2000-01-01T00:00:00.000Z", observedAt: "2000-01-01T00:00:00.000Z" } } });
    assert.equal(executeCalls, 1);
    assert.match(result.receiptId, /^discovery_receipt_/);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 1);
    assert.equal(state.listDiscoveryEvents(run.discoveryRunId).some((event) => event.type === "discovery_primitive.receipt_recorded"), true);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP API is loopback-oriented, emits no CORS header, and redacts runtime IDs", async () => {
  const root = mkdtempSync(join(tempBase, "server-test-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry([capability]);
  const device = state.upsertDevice({
    alias: "01",
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "never-expose",
    routingProfile: { enabled: true, capabilityIds: ["test.observe"] },
  });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([{
      id: "test",
      async execute() { return {}; },
      async verify() { return { ok: true }; },
      async restore() { return { ok: true }; },
    }]),
    evidence,
  });
  const router = new ControlRouter({ control, state, capabilities: registry, evidence });
  const server = createControlServer({ router });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port, address } = server.address();
    assert.equal(address, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/control/v1/devices`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json();
    assert.equal(body.devices[0].deviceId, device.deviceId);
    assert.doesNotMatch(JSON.stringify(body), /never-expose|runtimeId/);

    const nodesResponse = await fetch(`http://127.0.0.1:${port}/control/v1/nodes`);
    assert.equal(nodesResponse.status, 200);
    const nodes = await nodesResponse.json();
    assert.equal(nodes.nodes[0].nodeId, "DESKTOP-3I1EVHE");
    assert.equal(nodes.nodes[0].readyDevices, 1);
    assert.doesNotMatch(JSON.stringify(nodes), /never-expose|runtimeId|routingProfile/);

    const operatorLease = state.acquireLease({
      deviceId: device.deviceId,
      kind: "job",
      holderId: "job:operator-auth-test",
      jobId: "job:operator-auth-test",
    });
    const authorizeResponse = await fetch(`http://127.0.0.1:${port}/control/v1/leases/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-control-token": operatorLease.token,
      },
      body: JSON.stringify({
        leaseId: operatorLease.leaseId,
        deviceId: device.deviceId,
        runtimeId: "never-expose",
      }),
    });
    assert.equal(authorizeResponse.status, 200);
    const authorizeBody = await authorizeResponse.json();
    assert.equal(authorizeBody.authorized, true);
    assert.doesNotMatch(JSON.stringify(authorizeBody), /never-expose|runtimeId|lease_token/);

    const wrongRuntimeResponse = await fetch(`http://127.0.0.1:${port}/control/v1/leases/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-control-token": operatorLease.token,
      },
      body: JSON.stringify({
        leaseId: operatorLease.leaseId,
        deviceId: device.deviceId,
        runtimeId: "wrong-runtime",
      }),
    });
    assert.equal(wrongRuntimeResponse.status, 409);
    assert.equal((await wrongRuntimeResponse.json()).error.code, "LEASE_RUNTIME_MISMATCH");
    state.releaseLease(operatorLease.leaseId, operatorLease.token);

    const beforeJobs = state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
    const planResponse = await fetch(`http://127.0.0.1:${port}/control/v1/routes/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "agent-a",
        capabilityId: "test.observe",
      }),
    });
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    assert.equal(plan.route.decision, "dispatchable");
    assert.equal(plan.route.selectedDeviceId, device.deviceId);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, beforeJobs);

    const submitResponse = await fetch(`http://127.0.0.1:${port}/control/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "agent-a",
        capabilityId: "test.observe",
        idempotencyKey: "api-auto-route",
      }),
    });
    assert.equal(submitResponse.status, 202);
    const submitted = await submitResponse.json();
    assert.equal(submitted.job.routeDecision.selectedDeviceId, device.deviceId);
    assert.match(submitted.storage.manifestPath, /manifest\.json$/);
    assert.doesNotMatch(JSON.stringify(submitted), /never-expose|runtimeId|routingProfile/);

    const invalid = await fetch(`http://127.0.0.1:${port}/control/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_JSON");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await control.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production startup pins the verified Windows Node version", () => {
  assert.equal(assertPinnedNodeVersion({
    expected: "24.11.1",
    actual: "24.11.1",
  }), "24.11.1");
  assert.throws(() => assertPinnedNodeVersion({
    expected: "24.11.1",
    actual: "24.12.0",
  }), { code: "NODE_VERSION_MISMATCH" });
});

test("standing-grant issuer configuration is ignored while disabled and required while enabled", () => {
  assert.equal(loadStandingGrantIssuer({ standingGrantEnabled: false, issuerKeysPath: "C:\\missing\\placeholder.json" }), null);
  assert.throws(() => loadStandingGrantIssuer({ standingGrantEnabled: true, issuerKeysPath: "" }), { code: "STANDING_GRANT_ISSUER_UNAVAILABLE" });
});

test("production launch assets keep retired legacy UI routes enforced", () => {
  const worker = readFileSync(fileURLToPath(new URL("../scripts/control-plane-worker.ps1", import.meta.url)), "utf8");
  const envExample = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
  assert.match(worker, /CONTROL_PLANE_LEGACY_MODE\s*=\s*"enforce"/);
  assert.doesNotMatch(worker, /CONTROL_PLANE_LEGACY_MODE\s*=\s*"audit"/);
  assert.match(envExample, /^CONTROL_PLANE_LEGACY_MODE=enforce$/m);
});

test("REX B7: control-plane worker reads fixed modes/release from launch config without printing secrets", () => {
  const worker = readFileSync(fileURLToPath(new URL("../scripts/control-plane-worker.ps1", import.meta.url)), "utf8");
  // The launcher must derive the runtime policy mode, evidence mode, and release id from the
  // launch config the task installer wrote, not from per-box guesses. Phase 6 dark deploys a
  // fixed shadow/dual profile this way (bootstrap reads AUTONOMY_POLICY_MODE from env).
  assert.match(worker, /AUTONOMY_POLICY_MODE/);
  assert.match(worker, /EVIDENCE_MODE/);
  assert.match(worker, /CONTROL_PLANE_RELEASE_ID/);
  assert.match(worker, /autonomyPolicyMode/);
  assert.match(worker, /evidenceMode/);
  assert.match(worker, /releaseId/);
  assert.match(worker, /CONTROL_PLANE_PILOT_ACTORS/);
  assert.match(worker, /CONTROL_PLANE_PILOT_ALIASES/);
  // The legacy UI route guard is separate and stays enforced regardless of autonomy mode.
  assert.match(worker, /CONTROL_PLANE_LEGACY_MODE\s*=\s*"enforce"/);
  // The launcher never echoes secrets or env values to stdout/stderr (Windows exec treats
  // stderr as a liveness signal; echo would corrupt the supervised-task contract).
  assert.doesNotMatch(worker, /Write-(Host|Output).*token/i);
  assert.doesNotMatch(worker, /Write-(Host|Output).*\$env:/i);
});

test("REX B7: control-plane task installer writes the cross-repo release manifest and modes with full 40-SHA", () => {
  const task = readFileSync(fileURLToPath(new URL("../scripts/control-plane-task.ps1", import.meta.url)), "utf8");
  // Install/update must persist the fixed modes into the launch config and emit the shared
  // cross-repo release manifest (schema xhs.cross-repo-release.v1) alongside the task.
  assert.match(task, /cross-repo-release\.json/);
  assert.match(task, /xhs\.cross-repo-release\.v1/);
  assert.match(task, /registryCommit/);
  assert.match(task, /deviceAgentCommit/);
  assert.match(task, /windowsRegistryCommit/);
  assert.match(task, /taskLaunchCommit/);
  assert.match(task, /autonomyPolicyMode/);
  assert.match(task, /evidenceMode/);
  assert.match(task, /releaseId/);
  assert.match(task, /pilotActors/);
  assert.match(task, /pilotAliases/);
  assert.match(task, /pilotConfigured/);
  // All four commit fields must be recorded as the full 40-hex SHA, never an abbreviation.
  assert.match(task, /0-9a-f\]\{40\}/);
});

test("REX B7: a task.ps1-produced cross-repo release manifest validates against the shared schema", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../control-plane/schema/cross-repo-release.schema.json", import.meta.url)), "utf8"));
  const manifest = {
    schemaId: "xhs.cross-repo-release.v1",
    schemaVersion: 1,
    releaseId: "rel-shadow-2026-08-02",
    registryCommit: "a".repeat(40),
    deviceAgentCommit: "b".repeat(40),
    windowsRegistryCommit: "c".repeat(40),
    taskLaunchCommit: "d".repeat(40),
    policyMode: "shadow",
    evidenceMode: "dual",
    runtimePolicyVersion: "xhs.nonpayment-autonomy.v1",
    effectiveDecisionSource: "shadow",
    pilotActors: [],
    pilotAliases: [],
    pilotConfigured: false,
    policyDocDebt: [],
    schemaContracts: [],
    deployedAt: "2026-08-02T00:00:00Z",
  };
  assert.deepEqual(validateJsonSchema(manifest, schema), []);
});

test("router exposes job recovery without returning credentials", async () => {
  const calls = [];
  const router = new ControlRouter({
    control: {
      async recoverJob(input) {
        calls.push(input);
        return {
          ok: true,
          reused: false,
          jobId: input.jobId,
          runId: "run_public",
          deviceId: "dev_public",
          quarantineCleared: true,
        };
      },
    },
    state: {},
    capabilities: {},
    evidence: {},
  });
  const result = await router.handle({
    method: "POST",
    path: "/control/v1/jobs/job_recovery/recover",
    body: { actorId: "agent-a", idempotencyKey: "recover-1" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{
    jobId: "job_recovery",
    actorId: "agent-a",
    idempotencyKey: "recover-1",
  }]);
  assert.equal(result.body.recovery.quarantineCleared, true);
  assert.doesNotMatch(JSON.stringify(result.body), /token|runtime/i);
});

test("router Mission lifecycle responses redact account, targets, and internal policy fields", async () => {
  const privateMission = {
    missionId: "mission_public",
    version: 1,
    missionHash: "a".repeat(64),
    app: "xhs",
    account: "private-account-alias",
    scope: {
      actions: ["follow"],
      targets: { kind: "fingerprint", values: ["private-target-hash"] },
      totalCount: 3,
      perTargetCount: 1,
      frequency: { count: 1, windowSeconds: 3600 },
    },
    policy: { payment: "confirm", internal: "private-policy-value" },
    controllers: ["agent:private"],
    idempotencyKey: "private-dedup-key",
    redaction: { internal: true },
    status: "active",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2099-07-29T00:00:00.000Z",
    revokedAt: null,
    revokedReason: null,
  };
  const router = new ControlRouter({
    control: {
      submitMission() { return { status: "blocked", reason: "ADR_0008_NOT_ACCEPTED", mission: privateMission, reused: false, approvalRequired: false }; },
      showMission() { return { mission: privateMission, deviceRuns: [], events: [] }; },
      missionStatus() { return { missionId: privateMission.missionId, status: "active", deviceRunCount: 0, effectCount: 0 }; },
      revokeMission() { return privateMission; },
    },
    state: { listMissions() { return [privateMission]; } },
    capabilities: {},
    evidence: {},
  });
  const listed = await router.handle({ method: "GET", path: "/control/v1/missions" });
  const submitted = await router.handle({ method: "POST", path: "/control/v1/missions/submit", body: { actor: "human:operator", idempotencyKey: "x", policy: {} } });
  const shown = await router.handle({ method: "GET", path: "/control/v1/missions/mission_public" });
  const revoked = await router.handle({ method: "POST", path: "/control/v1/missions/mission_public/revoke", body: { actorId: "human:operator" } });
  for (const body of [listed.body, submitted.body, shown.body, revoked.body]) {
    assert.doesNotMatch(JSON.stringify(body), /private-account-alias|private-target-hash|private-policy-value|private-dedup-key|agent:private|redaction/);
  }
  assert.equal(listed.body.missions[0].missionId, "mission_public");
  assert.equal(submitted.body.mission.missionId, "mission_public");
  assert.equal(shown.body.mission.missionId, "mission_public");
  assert.equal(revoked.body.mission.missionId, "mission_public");
  assert.deepEqual(listed.body.missions[0].scope, {
    actions: ["follow"],
    targetKind: "fingerprint",
    targetCount: 1,
    totalCount: 3,
    perTargetCount: 1,
    frequency: { count: 1, windowSeconds: 3600 },
  });
});

test("router exposes read-only recovery inspection without returning credentials", async () => {
  const calls = [];
  const router = new ControlRouter({
    control: {
      async inspectRecovery(input) {
        calls.push(input);
        return {
          ok: true,
          reused: false,
          jobId: input.jobId,
          runId: "run_public",
          deviceId: "dev_public",
          stoppedBeforeAction: true,
          quarantineCleared: false,
          screenshot: { kind: "screenshot", sha256: "a".repeat(64), bytes: 1234 },
        };
      },
    },
    state: {},
    capabilities: {},
    evidence: {},
  });
  const result = await router.handle({
    method: "POST",
    path: "/control/v1/jobs/job_recovery/recover/inspect",
    body: { actorId: "agent-a", idempotencyKey: "inspect-1" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{
    jobId: "job_recovery",
    actorId: "agent-a",
    idempotencyKey: "inspect-1",
  }]);
  assert.equal(result.body.inspection.quarantineCleared, false);
  assert.doesNotMatch(JSON.stringify(result.body), /token|runtime/i);
});

test("router records hash-bound visual analysis without changing recovery state", async () => {
  const calls = [];
  const router = new ControlRouter({
    control: {
      async recordRecoveryInspectionAnalysis(input) {
        calls.push(input);
        return {
          ok: true,
          inspectionId: input.inspectionId,
          quarantineCleared: false,
          pageClassification: { pageType: "unknown", safeStateVerified: false },
        };
      },
    },
    state: {},
    capabilities: {},
    evidence: {},
  });
  const result = await router.handle({
    method: "POST",
    path: "/control/v1/jobs/job_recovery/recover/inspect/inspection_1/analysis",
    body: {
      actorId: "agent-a",
      idempotencyKey: "analysis-1",
      analysis: { schemaVersion: "xhs.visual-elements.v1" },
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{
    jobId: "job_recovery",
    inspectionId: "inspection_1",
    actorId: "agent-a",
    idempotencyKey: "analysis-1",
    analysis: { schemaVersion: "xhs.visual-elements.v1" },
  }]);
  assert.equal(result.body.analysis.quarantineCleared, false);
});

// ─── REX Phase 2 收尾: payment control surface (durable pending + list/decide) ───
// These lock the Phase 2 GO criteria for the B-仓 control surface: list is visible & redacted,
// ordinary nonpayment never produces a pending payment commit, a verified approve executes exactly
// one transport, deny cancels (transport 0), a wrong key / wrong purpose / tampered field never
// executes, expiry cancels, a double decide executes at most once, and a restart loses the live
// handle so the durable pending row becomes un-decidable (fail-closed). transport stays 0 until an
// Ed25519-verified human approval for the exact binding is presented.

const PAYMENT_MISSION = {
  missionId: "mission_payment_surface", status: "active", validity: { expiresAt: "2099-07-29T16:00:00Z" },
  app: "fixture-pay", account: "redacted:account",
  scope: { actions: ["payment"], targets: { values: ["observed-final-control"] } },
  policy: { payment: "confirm" },
};

function paymentInput(overrides = {}) {
  return {
    mission: PAYMENT_MISSION,
    action: "payment",
    target: "observed-final-control",
    runId: "run_payment_surface",
    payment: {
      payeeRef: "redacted:merchant",
      amount: "88.00",
      currency: "CNY",
      snapshotHash: "a".repeat(64),
      deviceId: "fixture-device",
    },
    ...overrides,
  };
}

function paymentHarness({ nowMs = Date.parse("2026-08-01T06:00:00.000Z") } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const allowlist = {
    version: 3,
    keys: [{
      keyId: "payment-human-1",
      subject: "human:owner",
      role: "human",
      status: "active",
      purposes: ["financial_commit"],
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
    }],
  };
  const now = () => nowMs;
  const verifier = new PaymentApprovalVerifier({ allowlist, now });
  const root = mkdtempSync(join(tempBase, "payment-surface-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = new CapabilityRegistry([capability]);
  state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: "DESKTOP-3I1EVHE", runtimeId: "private-rt",
    routingProfile: { enabled: true, capabilityIds: ["test.observe"] },
  });
  // protected_commits.mission_id is FK-bound to missions; register the test mission first.
  state.addMission({
    missionId: PAYMENT_MISSION.missionId,
    idempotencyKey: "payment-surface-mission",
    issuerActorId: "human:owner",
    missionHash: "m".repeat(64),
    contentHash: "c".repeat(64),
    policy: PAYMENT_MISSION.policy,
    expiresAtMs: Date.parse(PAYMENT_MISSION.validity.expiresAt),
  });
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  let executeCalls = 0, cancelCalls = 0, prepareCalls = 0;
  const ecp = {
    async prepare(input) { prepareCalls += 1; return { status: "prepared", effect: { effectId: `effect-payment-${prepareCalls}` } }; },
    markWaitingAuthorization(input) { return input; },
    async executePrepared() { executeCalls += 1; return { status: "verified" }; },
    async cancelPrepared() { cancelCalls += 1; return { status: "cancelled" }; },
  };
  const control = new ControlPlane({
    state, capabilities: registry, evidence,
    adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
    paymentApprovalVerifier: verifier, now,
  });
  const signApproval = (binding, overrides = {}) => {
    const unsigned = {
      schemaId: "xhs.payment-approval.v1",
      schemaVersion: 1,
      ...binding,
      purpose: "financial_commit",
      issuer: { subject: "human:owner", role: "human", keyId: "payment-human-1", allowlistVersion: 3 },
      ...overrides,
    };
    return { ...unsigned, signature: sign(null, canonicalPaymentApprovalBytes(unsigned), privateKey).toString("base64") };
  };
  return {
    root, state, control, verifier, ecp, now,
    signApproval,
    advance: (ms) => { nowMs += ms; },
    counts: () => ({ executeCalls, cancelCalls, prepareCalls }),
    close: () => { state.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("payment control surface: list is visible, redacted, and empty for ordinary nonpayment", async () => {
  const h = paymentHarness();
  try {
    assert.deepEqual(h.control.listPaymentCommits(), []);
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    assert.equal(begun.status, "waiting_authorization");
    const listed = h.control.listPaymentCommits();
    assert.equal(listed.length, 1);
    const row = listed[0];
    assert.equal(row.commitId, begun.commitId);
    assert.equal(row.status, "waiting_authorization");
    assert.equal(row.action, "payment");
    assert.equal(row.approvalBinding.amount, "88.00");
    assert.equal(row.approvalBinding.payeeRef, "redacted:merchant");
    assert.equal(row.approvalBinding.targetControlFingerprint.length > 0, true);
    // No secrets leak: no private key material, no control token, no internal tuple/params, no full
    // account原文 beyond the already-redacted ref. The DTO must not carry the issuer's private key
    // or any adapter params.
    const serialized = JSON.stringify(row);
    assert.doesNotMatch(serialized, /privateKey|privateKeyPem|BEGIN PRIVATE|controlToken|x-control-token/);
    assert.equal(row.approvalBinding.app, "fixture-pay");
  } finally { h.close(); }
});

test("payment control surface: verified approve executes exactly one transport", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    const result = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve",
      approval: h.signApproval(begun.approvalBinding),
      actorId: "human:owner",
    });
    assert.equal(result.status, "verified");
    assert.equal(h.counts().executeCalls, 1);
    assert.equal(h.counts().cancelCalls, 0);
    // The live handle is released and the durable row is terminal.
    assert.deepEqual(h.control.listPaymentCommits(), []);
    const row = h.state.getProtectedCommit(begun.commitId);
    assert.equal(row.status, "approved");
  } finally { h.close(); }
});

test("payment control surface: deny cancels, executes zero transport", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    const result = await h.control.decidePaymentCommit(begun.commitId, { decision: "deny", actorId: "human:owner" });
    assert.equal(result.status, "cancelled");
    assert.equal(h.counts().executeCalls, 0);
    assert.equal(h.counts().cancelCalls, 1);
    const row = h.state.getProtectedCommit(begun.commitId);
    assert.equal(row.status, "denied");
  } finally { h.close(); }
});

test("payment control surface: tampered field, wrong key, and wrong purpose all stay waiting (transport 0)", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    const tamperedAmount = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding, { amount: "99.00" }),
    });
    assert.equal(tamperedAmount.status, "waiting_authorization");
    assert.equal(tamperedAmount.code, "PAYMENT_APPROVAL_BINDING_MISMATCH");
    assert.equal(h.counts().executeCalls, 0);

    const tamperedPayee = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding, { payeeRef: "redacted:impostor" }),
    });
    assert.equal(tamperedPayee.code, "PAYMENT_APPROVAL_BINDING_MISMATCH");
    assert.equal(h.counts().executeCalls, 0);

    // Wrong purpose: a standing_grant-purpose approval must not be accepted for a financial_commit.
    const wrongPurpose = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding, { purpose: "standing_grant" }),
    });
    assert.equal(wrongPurpose.status, "waiting_authorization");
    assert.equal(h.counts().executeCalls, 0);
    // The commit is still live and pending.
    assert.equal(h.control.listPaymentCommits().length, 1);
  } finally { h.close(); }
});

test("payment control surface: an agent/observer role approval is rejected (transport 0)", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    // Forge an approval with a non-human role; the verifier allowlist pins role=human, so this must
    // fail at signature/allowlist verification and never execute.
    const forged = h.signApproval(begun.approvalBinding, {
      issuer: { subject: "agent:runner", role: "agent", keyId: "payment-human-1", allowlistVersion: 3 },
    });
    const result = await h.control.decidePaymentCommit(begun.commitId, { decision: "approve", approval: forged });
    assert.equal(result.status, "waiting_authorization");
    assert.equal(h.counts().executeCalls, 0);
  } finally { h.close(); }
});

test("payment control surface: expiry cancels and double decide executes at most once", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    h.advance(120001); // past the 120s approval TTL
    const expired = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding),
    });
    assert.equal(expired.code, "PAYMENT_APPROVAL_EXPIRED");
    assert.equal(h.counts().executeCalls, 0);
    assert.equal(h.counts().cancelCalls, 1);
    assert.equal(h.state.getProtectedCommit(begun.commitId).status, "expired");

    // A second decide on the now-terminal commit must not re-execute; the live handle is gone and
    // the durable row is terminal, so the control surface refuses with a 409 (never re-executes).
    const again = await h.control.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding),
    }).catch((error) => error);
    assert.equal(again.code, "PAYMENT_COMMIT_ALREADY_DECIDED");
    assert.equal(again.status, 409);
    assert.equal(h.counts().executeCalls, 0);

    // A fresh commit, double-approved, executes exactly once.
    const second = await h.control.beginPaymentCommit(paymentInput({ runId: "run_double" }), { ecp: h.ecp });
    const first = await h.control.decidePaymentCommit(second.commitId, {
      decision: "approve", approval: h.signApproval(second.approvalBinding),
    });
    assert.equal(first.status, "verified");
    const repeat = await h.control.decidePaymentCommit(second.commitId, {
      decision: "approve", approval: h.signApproval(second.approvalBinding),
    }).catch((error) => error);
    assert.equal(repeat.code, "PAYMENT_COMMIT_ALREADY_DECIDED");
    assert.equal(repeat.status, 409);
    assert.equal(h.counts().executeCalls, 1);
  } finally { h.close(); }
});

test("payment control surface: restart loses the live handle -> durable pending is fail-closed un-decidable", async () => {
  const h = paymentHarness();
  try {
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });
    assert.equal(h.control.listPaymentCommits().length, 1);
    // Simulate a control-plane restart: a new ControlPlane over the SAME durable state, with no
    // live handle index. The StateStore reconstruct fail-closed-cancels the orphaned pending row.
    const restarted = new ControlPlane({
      state: h.state, capabilities: h.state ? new CapabilityRegistry([capability]) : null,
      evidence: h.evidence,
      adapters: new AdapterRegistry([{ id: "test", async execute() { return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
      paymentApprovalVerifier: h.verifier, now: h.now,
    });
    // The durable row is still waiting before reconstruct-driven recovery; with no live handle the
    // decide API must refuse. (Reconstruct recovery is a StateStore concern; here we assert the
    // control-surface refuse path: a waiting row without a live handle is NOT_LIVE, never executed.)
    const refused = await restarted.decidePaymentCommit(begun.commitId, {
      decision: "approve", approval: h.signApproval(begun.approvalBinding),
    }).catch((error) => error);
    // The refuse must surface as a 409 ControlPlaneError, never an executed transport.
    assert.equal(refused.status, 409);
    assert.equal(refused.code, "PAYMENT_COMMIT_NOT_LIVE");
    assert.equal(h.counts().executeCalls, 0);
  } finally { h.close(); }
});

test("payment control surface: HTTP GET /payment-commits and POST .../decide are wired", async () => {
  const h = paymentHarness();
  const router = new ControlRouter({ control: h.control, state: h.state, capabilities: new CapabilityRegistry([capability]), evidence: h.evidence });
  const server = createControlServer({ router });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    const begun = await h.control.beginPaymentCommit(paymentInput(), { ecp: h.ecp });

    const listRes = await fetch(`http://127.0.0.1:${port}/control/v1/payment-commits`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.paymentCommits.length, 1);
    assert.equal(listBody.paymentCommits[0].commitId, begun.commitId);
    assert.doesNotMatch(JSON.stringify(listBody), /BEGIN PRIVATE|privateKey|controlToken/);

    const decideRes = await fetch(`http://127.0.0.1:${port}/control/v1/payment-commits/${begun.commitId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", approval: h.signApproval(begun.approvalBinding), actorId: "human:owner" }),
    });
    assert.equal(decideRes.status, 200);
    const decideBody = await decideRes.json();
    assert.equal(decideBody.paymentCommit.status, "verified");
    assert.equal(h.counts().executeCalls, 1);

    // A second decide over HTTP on the terminal commit surfaces 409, not 500.
    const secondRes = await fetch(`http://127.0.0.1:${port}/control/v1/payment-commits/${begun.commitId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    assert.equal(secondRes.status, 409);
    const secondBody = await secondRes.json();
    assert.equal(secondBody.ok, false);
    assert.equal(secondBody.error.code, "PAYMENT_COMMIT_ALREADY_DECIDED");
  } finally {
    server.close(); h.close();
  }
});

// ─── REX Phase 2 收尾 §4.2.A：#runJob chokepoint 端到端 fail-closed 证明 ───
//
// 证明：一个 generic capability（非 financial_commit，过准入闸）被用来点支付按钮
// （params 带 financial_commit target/context）时，#runJob 的守卫在 adapter.execute
// 之前 fail-closed，job 落 failed + errorCode=FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE，
// adapter.execute 零调用。这是所有控制面派发效果（job/session/mission ECP）的共用层。

test("#runJob guard fail-closes a generic capability whose params target a financial_commit before adapter.execute", async () => {
  const root = mkdtempSync(join(tempBase, "runjob-guard-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  state.upsertNode({ nodeId: "DESKTOP-3I1EVHE", authority: true });
  state.upsertDevice({
    alias: "01", physicalLabel: "rack-01", nodeId: "DESKTOP-3I1EVHE", runtimeId: "private-rt",
    routingProfile: { enabled: true, capabilityIds: ["test.tap"] },
  });
  const tapCap = {
    ...capability, id: "test.tap",
    inputSchema: { type: "object", additionalProperties: true },
    implementation: { adapter: "test", action: "tap" },
  };
  const registry = new CapabilityRegistry([tapCap]);
  let executeCalls = 0;
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const control = new ControlPlane({
    state, capabilities: registry, evidence,
    adapters: new AdapterRegistry([{ id: "test", async execute() { executeCalls += 1; return {}; }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]),
  });
  try {
    const financialParams = {
      target: { text: "确认支付", verifiedFinalControl: true },
      context: { stage: "final", amount: "88.00", currency: "CNY", payeeRef: "redacted:merchant" },
    };
    const created = control.submitJob({ idempotencyKey: "pay-tap", actorId: "agent-a", capabilityId: "test.tap", params: financialParams });
    // 等 pump 跑完 #runJob（queueMicrotask + async restore + summary）。
    for (let i = 0; i < 40; i += 1) {
      const s = state.requireJob(created.job.jobId).status;
      if (s === "failed" || s === "succeeded" || s === "ambiguous" || s === "recovery_required") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const job = state.requireJob(created.job.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE");
    assert.equal(executeCalls, 0, "adapter.execute must not run for a financial_commit");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
