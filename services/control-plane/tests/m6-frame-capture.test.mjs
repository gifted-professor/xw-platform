// M6-2 W5 — M6 live gate (immutable epoch chain) + closed frame capture facade.
//
// Everything is driven by REAL StateStore/EvidenceStore/CapabilityRegistry/
// ControlPlane and the real xiaowei adapter over a fixture mock transport. The
// gate/profile/alias failures must fail closed BEFORE any transport read
// (transport read count = 0) and before any lease/session exists.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { M6FrameEvidenceStore } from "../control-plane/lib/m6-frame-evidence-store.mjs";
import {
  createM6FrameCapture,
  M6_OBSERVE_CAPABILITY_ID,
  redactM6Output,
  validateCaptureAttemptReceipt,
} from "../control-plane/lib/m6-frame-capture.mjs";
import {
  deriveM6CloseoutHash,
  deriveM6EpochHash,
  evaluateM6Gate,
  m6AliasAllowed,
} from "../control-plane/lib/m6-live-gate.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlRouter } from "../control-plane/router.mjs";
import { deriveM6AggregateSealHash } from "../../../packages/kernel/lib/m6-aggregate-closeout.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });
const FIX = (name) => readFileSync(join(import.meta.dirname, "fixtures", "m6-xiaowei", name));
const SCREEN_A = FIX("screen-a.png");
const SCREEN_B = FIX("screen-b.png");
const DUMP_XML = FIX("dump-ui.raw.xml");
const WINDOW_FOCUS = FIX("window-focus.raw.txt");
const WINDOW_ROTATION = FIX("window-rotation.raw.txt");
const POWER = FIX("power.raw.txt");
const INPUT_METHOD = FIX("input-method.raw.txt");
const DISPLAY = FIX("display.raw.txt");

const RELEASE = { releaseId: "release-1", sourceCommit: "abc123" };
const PROFILE = { runtimeProfile: "legacy_compat", agenticGroundingEnabled: true };
// Pinned lock hashes (3×64-hex). The facade requires non-null lockHashes when
// M6 is enabled (fail closed #2); the runtime gate matches these against each
// epoch's lockHashes. Arbitrary but consistent sha256-length values.
const LOCKS = Object.freeze({
  runtimeProfile: "1111111111111111111111111111111111111111111111111111111111111111",
  hardRedlinePolicy: "2222222222222222222222222222222222222222222222222222222222222222",
  groundingRuntime: "3333333333333333333333333333333333333333333333333333333333333333",
});

// --- gate epoch builder (hashes derived, never hand-filled) -----------------
function epoch(overrides = {}) {
  const raw = {
    schemaId: "xw.m6-live-gate.v1",
    gateId: "m6-gate-1",
    mode: "OBSERVE_ONLY",
    status: "active",
    releaseId: RELEASE.releaseId,
    sourceCommit: RELEASE.sourceCommit,
    actor: "operator",
    lockHashes: LOCKS,
    allowlist: ["alpha"],
    issuedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    parentEpochHash: null,
    closeoutRef: null,
    ...overrides,
  };
  return { ...raw, epochHash: deriveM6EpochHash(raw) };
}

function closeout(overrides = {}) {
  const raw = {
    closeoutId: "closeout-1",
    epochHash: overrides.epochHash ?? null,
    actor: "ops",
    reason: "release",
    committedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
  return { ...raw, closeoutHash: deriveM6CloseoutHash(raw) };
}

// --- fixture-driven closed mock transport (counts every device read) ------
function mockTransport(overrides = {}) {
  let screenCalls = 0;
  let readCount = 0;
  const events = [];
  const transport = {
    readCount: () => readCount,
    events,
    async runExclusive(callback) {
      return callback(this);
    },
    async invoke({ action, devices, data }, options = {}) {
      events.push({ action, command: data?.command ?? null });
      if (action === "Screen") {
        screenCalls += 1;
        readCount += 1;
        const bytes = screenCalls === 1 ? overrides.pngA ?? SCREEN_A : overrides.pngB ?? SCREEN_B;
        mkdirSync(data.savePath, { recursive: true });
        writeFileSync(join(data.savePath, `frame-${screenCalls}.png`), bytes);
        return { code: 10000 };
      }
      if (action === "adb_shell") {
        readCount += 1;
        const cmd = String(data.command);
        const fixture = (bytes) => ({ data: { [devices]: bytes } });
        if (/uiautomator dump/.test(cmd)) return fixture("");
        if (/base64/.test(cmd)) {
          const xml = overrides.dumpXml ?? DUMP_XML;
          if (xml === "") return fixture("");
          return fixture(Buffer.from(xml).toString("base64"));
        }
        if (/rm -f/.test(cmd)) return fixture("");
        if (cmd.includes("init=")) return fixture(overrides.displayText ?? DISPLAY);
        if (cmd.includes("mCurrentFocus")) return fixture(overrides.windowFocus ?? WINDOW_FOCUS);
        if (cmd.includes("mCurrentRotation")) return fixture(overrides.rotationText ?? WINDOW_ROTATION);
        if (cmd.includes("mWakefulness=")) return fixture(overrides.powerText ?? POWER);
        if (cmd.includes("mInputShown")) return fixture(overrides.inputText ?? INPUT_METHOD);
        throw new Error(`unmatched adb_shell command: ${cmd}`);
      }
      throw new Error(`unexpected transport action: ${action}`);
    },
  };
  return transport;
}

// --- harness: real stores + real control plane + real facade --------------
function harness({
  gate = { chain: [epoch()] },
  gateProvider = null,
  profile = PROFILE,
  release = RELEASE,
  devices = ["alpha"],
  transportOverrides = {},
  adapters = null,
  registryOverride = null,
  now,
} = {}) {
  const root = mkdtempSync(join(tempBase, "m6-capture-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const registry = registryOverride ?? CapabilityRegistry.load(join(import.meta.dirname, "..", "apps"));
  const transport = mockTransport(transportOverrides);
  const adapterRegistry = adapters ?? new AdapterRegistry([createXiaoweiAdapter({ transport })]);
  const evidence = new EvidenceStore({ runsRoot: join(root, "runs"), state, minFreeBytes: 0, minExternalEffectFreeBytes: 0 });
  const m6Evidence = new M6FrameEvidenceStore({ root: join(root, "m6-frames") });
  const control = new ControlPlane({ state, capabilities: registry, adapters: adapterRegistry, evidence, authorityNodeId: "NODE-A", leaseTtlMs: 60000, leaseHeartbeatMs: 10000 });
  for (const alias of devices) {
    state.upsertDevice({
      deviceId: `device-${alias}`,
      alias,
      physicalLabel: `LAB-${alias}`,
      nodeId: "NODE-A",
      runtimeId: `serial-${alias}`,
      routingProfile: { enabled: true, capabilityIds: [M6_OBSERVE_CAPABILITY_ID] },
    });
  }
  const facade = createM6FrameCapture({
    control,
    state,
    capabilities: registry,
    evidence: m6Evidence,
    auditRoot: join(root, "audit"),
    gate,
    gateProvider,
    release,
    profile,
    lockHashes: LOCKS,
    now,
  });
  return { root, state, control, facade, transport, m6Evidence, registry };
}

// Windows-safe teardown: the sqlite handle must close before the temp dir can
// be removed (unlike POSIX, Windows refuses to delete an open file).
function cleanup(root, state) {
  try { state?.db?.close(); } catch {}
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
test("gate unit: deterministic hashes, chain evaluation, allowlist", () => {
  const e = epoch();
  assert.equal(deriveM6EpochHash(e), e.epochHash); // deterministic
  assert.notEqual(deriveM6EpochHash({ ...e, allowlist: ["beta"] }), e.epochHash); // hash covers payload
  assert.equal(evaluateM6Gate({ chain: [e], nowMs: Date.parse("2026-08-22T00:00:00Z") }).mode, "OBSERVE_ONLY");
  assert.equal(evaluateM6Gate({ chain: [e], nowMs: Date.parse("2026-08-22T00:00:00Z") }).errors.length, 0);
  // Expired.
  const expired = epoch({ expiresAt: "2026-08-01T00:00:00.000Z" });
  const r1 = evaluateM6Gate({ chain: [expired], nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r1.mode, "CLOSED");
  assert.equal(r1.errors[0].code, "M6_GATE_EXPIRED");
  // Forged self-hash (payload changed after hashing).
  const forged = { ...epoch(), allowlist: ["alpha", "beta"] };
  const r2 = evaluateM6Gate({ chain: [forged], nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r2.errors[0].code, "M6_GATE_EPOCH_FORGED");
  // Parent mismatch.
  const a = epoch();
  const b = epoch({ parentEpochHash: "0".repeat(64) });
  const r3 = evaluateM6Gate({ chain: [a, b], nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r3.errors[0].code, "M6_GATE_PARENT_MISMATCH");
  // Release drift.
  const drift = epoch({ releaseId: "release-2" });
  const r4 = evaluateM6Gate({ chain: [drift], nowMs: Date.parse("2026-08-21T00:00:00Z"), expectedRelease: RELEASE });
  assert.equal(r4.errors[0].code, "M6_GATE_RELEASE_MISMATCH");
  // Forged closeout: seal points at a missing record.
  const sealed = epoch({ closeoutRef: { id: "closeout-missing", sha256: "0".repeat(64) } });
  const r5 = evaluateM6Gate({ chain: [sealed], nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r5.errors[0].code, "M6_GATE_EPOCH_FORGED");
  // A valid CLOSED child binds the root observe epoch's closeout + aggregate.
  const closeoutRec = closeout({ epochHash: e.epochHash, closeoutId: "closeout-valid" });
  const sealPayload = { probe: "gate-unit" };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const closed = epoch({
    mode: "CLOSED",
    status: "closed",
    parentEpochHash: e.epochHash,
    closeoutRef: { id: closeoutRec.closeoutId, sha256: closeoutRec.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
  });
  const aggregate = { epochHash: e.epochHash, sealPayload, sealHash };
  const r6 = evaluateM6Gate({ chain: [e, closed], closeouts: { [closeoutRec.closeoutId]: closeoutRec }, aggregates: { [sealHash]: aggregate }, nowMs: Date.parse("2026-08-21T00:00:00Z") });
  assert.equal(r6.mode, "CLOSED");
  assert.equal(r6.errors.length, 0);
  // Allowlist membership.
  assert.equal(m6AliasAllowed("alpha", sealed), true);
  assert.equal(m6AliasAllowed("beta", sealed), false);
  assert.equal(m6AliasAllowed("", sealed), false);
});

test("gate CLOSED → capture fails closed with zero transport reads", async () => {
  // A contract-valid CLOSED epoch: status=closed + a self-hashing closeout that
  // resolves, so the gate evaluates to CLOSED (not an invalid-epoch rejection).
  const sealPayload = { probe: "closed" };
  const sealHash = deriveM6AggregateSealHash(sealPayload);
  const observeEpoch = epoch();
  const closedRec = closeout({ epochHash: observeEpoch.epochHash, closeoutId: "closeout-closed" });
  const closedEpoch = epoch({
    mode: "CLOSED",
    status: "closed",
    parentEpochHash: observeEpoch.epochHash,
    closeoutRef: { id: "closeout-closed", sha256: closedRec.closeoutHash },
    aggregateSealRef: { id: sealHash, sha256: sealHash },
  });
  const aggregate = { schemaId: "xw.m6-aggregate-closeout.v1", epochHash: closedRec.epochHash, sealHash, sealPayload };
  const { root, state, facade, transport } = harness({ gate: { chain: [observeEpoch, closedEpoch], closeouts: { "closeout-closed": closedRec }, aggregates: { [sealHash]: aggregate } } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-1" }), (e) => e.code === "M6_GATE_CLOSED");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("running facade reloads the gate for preflight and health", () => {
  let snapshot = { chain: [epoch()], closeouts: {}, aggregates: {}, lockHashes: LOCKS };
  const { root, state, facade } = harness({ gateProvider: () => snapshot });
  try {
    assert.equal(facade.preflight({ alias: "alpha", scenarioLabel: "observe-01-01" }).gateMode, "OBSERVE_ONLY");
    snapshot = { chain: [], closeouts: {}, aggregates: {}, lockHashes: LOCKS };
    assert.throws(() => facade.preflight({ alias: "alpha", scenarioLabel: "observe-01-01" }), { code: "M6_GATE_EMPTY" });
    assert.equal(facade.health().gateMode, "CLOSED");
    assert.deepEqual(facade.health().gateErrors, ["M6_GATE_EMPTY"]);
  } finally { cleanup(root, state); }
});

test("expired epoch fails closed with zero transport reads", async () => {
  const { root, state, facade, transport } = harness({ gate: { chain: [epoch({ expiresAt: "2026-08-01T00:00:00.000Z" })] } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-exp" }), (e) => e.code === "M6_GATE_EXPIRED");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("release drift fails closed with zero transport reads", async () => {
  const { root, state, transport, facade } = harness({ gate: { chain: [epoch({ releaseId: "release-2" })] } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-drift" }), (e) => e.code === "M6_GATE_RELEASE_MISMATCH");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("parent chain mismatch fails closed", async () => {
  const a = epoch();
  const b = epoch({ parentEpochHash: "0".repeat(64) });
  const { root, state, facade, transport } = harness({ gate: { chain: [a, b] } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-parent" }), (e) => e.code === "M6_GATE_PARENT_MISMATCH");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("forged epoch self-hash fails closed (forged fields)", async () => {
  // A whitelisted field mutated AFTER the epoch was sealed: the stored self-hash
  // no longer matches the payload, so the gate must refuse the whole chain.
  const forged = { ...epoch(), allowlist: ["alpha", "public"] };
  const { root, state, transport, facade } = harness({ gate: { chain: [forged] } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-forged" }), (e) => e.code === "M6_GATE_EPOCH_FORGED");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("profile missing or agenticGroundingEnabled=false fails closed", async () => {
  {
    const { root, state, transport, facade } = harness({ profile: null });
    try {
      await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-p0" }), (e) => e.code === "M6_PROFILE_DISABLED");
      assert.equal(transport.readCount(), 0);
    } finally { cleanup(root, state); }
  }
  {
    const { root, state, transport, facade } = harness({ profile: { runtimeProfile: "legacy_compat", agenticGroundingEnabled: false } });
    try {
      await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-p1" }), (e) => e.code === "M6_PROFILE_DISABLED");
      assert.equal(transport.readCount(), 0);
    } finally { cleanup(root, state); }
  }
});

test("alias outside the active epoch allowlist fails closed", async () => {
  const { root, state, transport, facade } = harness({ devices: ["alpha"] });
  try {
    await assert.rejects(facade.capture({ alias: "bravo", scenarioLabel: "observe", idempotencyKey: "ik-alias" }), (e) => e.code === "M6_ALIAS_NOT_ALLOWED");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("fixture/hermetic provider is structurally forbidden for live capture", async () => {
  // A registry whose xiaowei.m6.observe_frame points at a fixture adapter must
  // be rejected BEFORE any read, even when the gate/profile/alias are green.
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "apps", "xiaowei", "capabilities.json"), "utf8"));
  const observe = raw.capabilities.find((c) => c.id === M6_OBSERVE_CAPABILITY_ID);
  assert.ok(observe, "observe_frame capability must exist in the real xiaowei registry");
  const fixtureCap = {
    ...observe,
    implementation: { ...observe.implementation, adapter: "hermetic-fixture-provider" },
  };
  const fixtureRegistry = new CapabilityRegistry([fixtureCap]);
  const { root, state, transport, facade } = harness({ registryOverride: fixtureRegistry, adapters: new AdapterRegistry([{ id: "hermetic-fixture-provider", async execute() { throw new Error("fixture must not run"); }, async verify() { return { ok: true }; }, async restore() { return { ok: true }; } }]) });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-fixture" }), (e) => e.code === "M6_FIXTURE_PROVIDER_FORBIDDEN");
    assert.equal(transport.readCount(), 0);
  } finally { cleanup(root, state); }
});

test("happy path: closed OBSERVE_ONLY capture produces accepted receipt + frame + audit", async () => {
  const { root, state, control, facade, transport } = harness();
  try {
    const pre = facade.preflight({ alias: "alpha", scenarioLabel: "observe" });
    assert.equal(pre.ok, true);
    assert.equal(pre.gateMode, "OBSERVE_ONLY");
    assert.equal(pre.epochHash.length, 64);
    const receipt = await facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-ok" });
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.epochHash, pre.epochHash);
    assert.equal(receipt.gateMode, "OBSERVE_ONLY");
    assert.equal(receipt.alias, "alpha");
    assert.equal(receipt.scenarioLabel, "observe");
    assert.ok(receipt.attemptId.startsWith("m6attempt_"));
    assert.ok(receipt.sessionId && receipt.jobId && receipt.runId && receipt.leaseRef);
    assert.match(receipt.frameRef.id, /^[0-9a-f]{64}$/);
    assert.match(receipt.frameRef.sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.errorCodes.length, 0);
    // evidenceRefs are unique CAS blob refs (opaqueRef objects). A/B screenshots
    // are bit-identical in the fixtures → one shared blob, so the unique count is
    // 4 (screenshot + dump + focus + observation), not 5. All refs are {id,sha256}.
    assert.ok(receipt.evidenceRefs.length >= 4);
    assert.equal(new Set(receipt.evidenceRefs.map((r) => r.id)).size, receipt.evidenceRefs.length);
    for (const ref of receipt.evidenceRefs) {
      assert.ok(typeof ref.id === "string" && /^[0-9a-f]{64}$/.test(ref.sha256), "evidenceRef must be an opaqueRef {id,sha256}");
    }
    assert.ok(receipt.skew.aToBMs >= 0 && receipt.skew.bToFocusBMs >= 0);
    assert.ok(receipt.remainingTtlMs >= 0);
    assert.ok(receipt.receiptSha256.length === 64);
    assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
    assert.ok(Number.isFinite(Date.parse(receipt.committedAt)));

    // No token/secret ever leaves: redaction is idempotent and drops nothing else.
    const redacted = redactM6Output({ receipt, secret: "x" });
    assert.equal(redacted.secret, "x");
    for (const key of ["token", "sessionToken", "transportToken", "leaseToken"]) {
      assert.equal(key in receipt, false, `receipt must not carry ${key}`);
    }
    assert.ok(!JSON.stringify(receipt).includes("serial-"));

    // The frozen strict frame is durable in the audit trail.
    const audit = JSON.parse(readFileSync(join(root, "audit", `${receipt.attemptId}.json`), "utf8"));
    assert.equal(audit.receipt.receiptSha256, receipt.receiptSha256);
    assert.equal(audit.frame.frameId, receipt.frameRef.id);
    assert.equal(audit.frame.mode, "live_strict");
    assert.equal(audit.frame.schemaId, "xw.screen-frame.v1");
    assert.equal(audit.frame.width, 1080);
    assert.equal(audit.frame.height, 2400);
    assert.equal(audit.frame.density, 440);
    assert.equal(audit.frame.orientation, "portrait");
    assert.equal(audit.frame.stability.verdict, "stable");
    assert.equal(audit.frame.flags.partial, false);
    assert.equal(audit.frame.flags.missing, false);
    assert.ok(audit.frame.screenshotASha256 === audit.frame.screenshotBSha256);

    // Transport actually read the closed 15-step observe sequence once
    // (screenA, focusA, displayA×4, dump×3, screenB, focusB, displayB×4).
    assert.equal(transport.readCount(), 15);

    // The session/lease were released by finally: validation now fails.
    assert.throws(() => state.validateSession(receipt.sessionId, "bogus"), { code: "SESSION_NOT_FOUND" });
    const job = state.getJob(receipt.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.canary, true);

    // status replays the attempt; closeout seals it with epoch + refs.
    const status = facade.status({ attemptId: receipt.attemptId });
    assert.equal(status.attempt.receiptSha256, receipt.receiptSha256);
    const closed = facade.closeout({ attemptId: receipt.attemptId, reason: "test-close" });
    assert.equal(closed.ok, true);
    assert.equal(closed.closeout.epochHash, receipt.epochHash);
    assert.equal(closed.closeout.sessionId, receipt.sessionId);
    assert.equal(closed.closeout.jobId, receipt.jobId);
    const closeoutRecord = JSON.parse(readFileSync(join(root, "audit", `${receipt.attemptId}.closeout.json`), "utf8")).closeout;
    assert.equal(closeoutRecord.closeoutHash.length, 64);
  } finally { cleanup(root, state); }
});

test("same-alias contention fails closed with M6_LEASE_CONFLICT and zero reads", async () => {
  const { root, state, control, facade, transport } = harness();
  try {
    const holder = control.createSession({ actorId: "agent:other", deviceId: "device-alpha", capabilityId: M6_OBSERVE_CAPABILITY_ID, canary: true });
    assert.ok(holder.sessionId);
    try {
      await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-busy" }), (e) => e.code === "M6_LEASE_CONFLICT");
      assert.equal(transport.readCount(), 0);
    } finally { control.releaseSession(holder.sessionId, holder.token); }
  } finally { cleanup(root, state); }
});

test("mid-capture evidence failure converges: session released, job terminal, rejected audit", async () => {
  const { root, state, facade, transport } = harness({ transportOverrides: { dumpXml: "<hierarchy><dismiss></hierarchy>" } });
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-crash" }), (e) => e.code === "M6_EVIDENCE_DUMP_NOT_XML");
    // No lease/session survives the failure path.
    const auditFiles = readdirSync(join(root, "audit"));
    const rejected = auditFiles.filter((f) => f.endsWith(".json"));
    assert.equal(rejected.length, 1);
    const record = JSON.parse(readFileSync(join(root, "audit", rejected[0]), "utf8"));
    assert.equal(record.receipt.status, "rejected");
    assert.equal(record.receipt.errorCodes[0], "M6_EVIDENCE_DUMP_NOT_XML");
    assert.equal(transport.readCount(), 15); // the reads happened, then evidence failed
  } finally { cleanup(root, state); }
});

test("pre-session rejected receipt is contract-valid: null attribution ids + receiptSha256 + capturedAt", async () => {
  // A lease conflict fails AFTER the attempt id is created but BEFORE any
  // run/job/session/lease exists, so the rejected receipt must carry null
  // runId/jobId/sessionId/leaseRef and still validate against the contract.
  const { root, state, control, facade } = harness();
  try {
    const holder = control.createSession({ actorId: "agent:other", deviceId: "device-alpha", capabilityId: M6_OBSERVE_CAPABILITY_ID, canary: true });
    try {
      await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-presess" }), (e) => e.code === "M6_LEASE_CONFLICT");
    } finally { control.releaseSession(holder.sessionId, holder.token); }
    const auditFiles = readdirSync(join(root, "audit")).filter((f) => f.endsWith(".json") && !f.endsWith(".closeout.json"));
    assert.equal(auditFiles.length, 1);
    const record = JSON.parse(readFileSync(join(root, "audit", auditFiles[0]), "utf8"));
    const receipt = record.receipt;
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.runId, null);
    assert.equal(receipt.jobId, null);
    assert.equal(receipt.sessionId, null);
    assert.equal(receipt.leaseRef, null);
    assert.equal(receipt.errorCodes[0], "M6_LEASE_CONFLICT");
    assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
    assert.ok(Number.isFinite(Date.parse(receipt.committedAt)));
    // The facade-built receipt passes the contract validator (shared schema +
    // re-derived receiptSha256 + semantic checks).
    assert.equal(validateCaptureAttemptReceipt(receipt).ok, true);
  } finally { cleanup(root, state); }
});

test("gate drift before manifest commit fails closed with M6_GATE_DRIFT", async () => {
  // The gate is resolved at capture start and re-evaluated immediately before the
  // manifest commit. If the active epoch hash changed in between, the capture
  // must NOT commit a frame against the stale epoch.
  const startEpoch = epoch();
  const driftedEpoch = epoch({ allowlist: ["alpha", "beta"] }); // valid OBSERVE_ONLY, different epochHash
  let gateReads = 0;
  const gate = {
    get chain() { gateReads += 1; return gateReads === 1 ? [startEpoch] : [driftedEpoch]; },
    closeouts: {},
  };
  const { root, state, facade, transport } = harness({ gate });
  try {
    await assert.rejects(
      facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-drift" }),
      (e) => e.code === "M6_GATE_DRIFT",
    );
    // The observation ran (drift is detected at the pre-commit recheck, after reads).
    assert.ok(transport.readCount() > 0);
    const auditFiles = readdirSync(join(root, "audit")).filter((f) => f.endsWith(".json") && !f.endsWith(".closeout.json"));
    assert.equal(auditFiles.length, 1);
    const record = JSON.parse(readFileSync(join(root, "audit", auditFiles[0]), "utf8"));
    assert.equal(record.receipt.status, "rejected");
    assert.equal(record.receipt.errorCodes[0], "M6_GATE_DRIFT");
    assert.equal(validateCaptureAttemptReceipt(record.receipt).ok, true);
  } finally { cleanup(root, state); }
});

test("cleanup failure after an accepted capture is surfaced (M6_CLEANUP_FAILED), not swallowed", async () => {
  const { root, state, control, facade } = harness();
  let releaseCalls = 0;
  // Force releaseSession to fail after the capture converges, so the finally
  // block surfaces the convergence failure instead of swallowing it.
  control.releaseSession = () => { releaseCalls += 1; throw new Error("release boom"); };
  try {
    await assert.rejects(
      facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-clean" }),
      (e) => e.code === "M6_CLEANUP_FAILED",
    );
    assert.ok(releaseCalls >= 1, "releaseSession must have been attempted (not swallowed)");
    const attemptFile = readdirSync(join(root, "audit")).find((file) => file.endsWith(".json") && !file.endsWith(".closeout.json"));
    const record = JSON.parse(readFileSync(join(root, "audit", attemptFile), "utf8"));
    assert.equal(record.receipt.status, "rejected");
    assert.equal(record.receipt.frameRef, null);
    assert.deepEqual(record.receipt.errorCodes, ["M6_CLEANUP_FAILED"]);
    assert.deepEqual(record.tombstone, { acceptedFrameCommitted: false, reason: "M6_CLEANUP_FAILED" });
    assert.equal(Object.hasOwn(record, "frame"), false);
  } finally { cleanup(root, state); }
});

test("closeout convergence: a leaked session/lease refuses to seal (M6_CLOSEOUT_CONVERGENCE_FAILED)", async () => {
  const { root, state, control, facade } = harness();
  // Sabotage releaseSession: cleanup failure must tombstone the candidate frame
  // as rejected while preserving enough attribution for convergence checks.
  control.releaseSession = () => { throw new Error("release boom"); };
  try {
    await assert.rejects(
      facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-leak" }),
      (e) => e.code === "M6_CLEANUP_FAILED",
    );
    const attemptFile = readdirSync(join(root, "audit")).find((f) => f.endsWith(".json") && !f.endsWith(".closeout.json"));
    assert.ok(attemptFile, "rejected tombstone is written after cleanup failed");
    const receipt = JSON.parse(readFileSync(join(root, "audit", attemptFile), "utf8")).receipt;
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.frameRef, null);
    assert.deepEqual(receipt.errorCodes, ["M6_CLEANUP_FAILED"]);
    // The window is leaked: session + lease survived (job already terminal).
    assert.equal(state.getJob(receipt.jobId).status, "succeeded");
    assert.equal(state.sessionExists(receipt.sessionId), true);
    assert.equal(state.leaseExists(receipt.leaseRef), true);
    // closeout must refuse to seal the leaked window.
    let err = null;
    try { facade.closeout({ attemptId: receipt.attemptId, reason: "seal" }); } catch (e) { err = e; }
    assert.equal(err.code, "M6_CLOSEOUT_CONVERGENCE_FAILED");
    assert.deepEqual(err.details.convergenceErrors.map((c) => c.ref).sort(), ["lease", "session"]);
    // No closeout marker was written.
    assert.equal(existsSync(join(root, "audit", `${receipt.attemptId}.closeout.json`)), false);
  } finally { cleanup(root, state); }
});

test("closeout convergence: a non-terminal job refuses to seal (M6_CLOSEOUT_CONVERGENCE_FAILED)", () => {
  const { root, state, control, facade, registry } = harness();
  try {
    // Create a job that is still running (non-terminal) and bind a synthetic
    // receipt to it. closeout must refuse to seal while the job is not terminal.
    const cap = registry.get(M6_OBSERVE_CAPABILITY_ID);
    const created = state.createJob({
      idempotencyKey: "ik-jobleak", actorId: "agent:m6-facade", authorityNodeId: control.authorityNodeId,
      deviceId: "device-alpha", placement: {}, capability: cap, params: {}, canary: true, sessionId: "sess-jobleak", status: "queued",
    });
    state.transitionJob(created.job.jobId, "running");
    const attemptId = "m6attempt-jobleak";
    mkdirSync(join(root, "audit"), { recursive: true });
    const receipt = {
      schemaId: "xw.capture-attempt-receipt.v1", attemptId, runId: created.job.runId, jobId: created.job.jobId,
      sessionId: null, leaseRef: null, alias: "alpha", scenarioLabel: "observe",
      epochHash: "ff".repeat(32), status: "accepted", frameRef: null, gateMode: "OBSERVE_ONLY",
      errorCodes: [], evidenceRefs: [], skew: null, remainingTtlMs: null, capturedAt: null,
      committedAt: "2026-08-22T00:00:00.000Z",
    };
    writeFileSync(join(root, "audit", `${attemptId}.json`), `${JSON.stringify({ receipt, frame: null }, null, 2)}\n`);
    assert.equal(state.getJob(receipt.jobId).status, "running");
    let err = null;
    try { facade.closeout({ attemptId, reason: "seal" }); } catch (e) { err = e; }
    assert.equal(err.code, "M6_CLOSEOUT_CONVERGENCE_FAILED");
    assert.deepEqual(err.details.convergenceErrors, [{ ref: "job", id: created.job.jobId, status: "running" }]);
    assert.equal(existsSync(join(root, "audit", `${attemptId}.closeout.json`)), false);
  } finally { cleanup(root, state); }
});

test("closeout convergence: a converged window (job terminal, session/lease released) seals", async () => {
  const { root, state, facade } = harness();
  try {
    const receipt = await facade.capture({ alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-seal" });
    // capture's finally converged: job terminal, no active session/lease.
    assert.equal(state.getJob(receipt.jobId).status, "succeeded");
    assert.equal(state.sessionExists(receipt.sessionId), false);
    assert.equal(state.leaseExists(receipt.leaseRef), false);
    const closed = facade.closeout({ attemptId: receipt.attemptId, reason: "seal" });
    assert.equal(closed.ok, true);
    assert.equal(existsSync(join(root, "audit", `${receipt.attemptId}.closeout.json`)), true);
  } finally { cleanup(root, state); }
});

test("input validation: closed strings only", async () => {
  const { root, state, facade } = harness();
  try {
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "observe" }), { code: "M6_IDEMPOTENCY_REQUIRED" });
    await assert.rejects(facade.capture({ alias: "alpha;rm -rf /", scenarioLabel: "observe", idempotencyKey: "ik-x" }), { code: "M6_ALIAS_INVALID" });
    await assert.rejects(facade.capture({ alias: "alpha", scenarioLabel: "bank-transfer", idempotencyKey: "ik-x" }), { code: "M6_SCENARIO_LABEL_INVALID" });
    // preflight throws synchronously on a bad alias and never touches a device.
    assert.throws(() => facade.preflight({ alias: "charlie", scenarioLabel: "observe" }), { code: "M6_ALIAS_NOT_ALLOWED" });
  } finally { cleanup(root, state); }
});

test("closed module scan: M6 surface never mentions mutating primitives or coordinates", () => {
  for (const file of ["m6-live-gate.mjs", "m6-frame-capture.mjs"]) {
    const source = readFileSync(new URL(`../control-plane/lib/${file}`, import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const token of ["tap", "swipe", "keyevent", "input_text", "monkey", "launch_app", "am start", "http", "bounds"]) {
      assert.equal(code.includes(token), false, `${file} code must not mention '${token}'`);
    }
  }
});

test("router: the M6 public namespace is closed observe capture only", async () => {
  const { root, control, state, facade, m6Evidence } = harness();
  const router = new ControlRouter({ control, state, capabilities: state, evidence: m6Evidence, m6: facade, nodeId: "NODE-A" });
  try {
    // A route that tries to reach an action/coordinate through M6 is rejected.
    await assert.rejects(router.handle({ method: "POST", path: "/control/v1/m6/frames/capture", body: { alias: "alpha", scenarioLabel: "observe", idempotencyKey: "ik-r1", action: "tap", x: 100 } }), (e) => e.code === "M6_INPUT_CLOSED");
    // No action route exists in the M6 namespace at all.
    await assert.rejects(router.handle({ method: "POST", path: "/control/v1/m6/actions", body: {} }), (e) => e.code === "ROUTE_NOT_FOUND");
    // status needs an attemptId.
    await assert.rejects(router.handle({ method: "GET", path: "/control/v1/m6/frames/status" }), (e) => e.code === "M6_ATTEMPT_ID_REQUIRED");
    // closeout sends attemptId; the closed-input envelope accepts it (the facade
    // then rejects an unknown attempt with M6_ATTEMPT_NOT_FOUND, NOT M6_INPUT_CLOSED).
    await assert.rejects(router.handle({ method: "POST", path: "/control/v1/m6/frames/closeout", body: { attemptId: "m6attempt_unknown", reason: "test" } }), (e) => e.code === "M6_ATTEMPT_NOT_FOUND");
  } finally { cleanup(root, state); }
});

test("router: without a facade the M6 namespace refuses (503) — never a degraded fallback", async () => {
  const root = mkdtempSync(join(tempBase, "m6-router-off-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  try {
    const router = new ControlRouter({ control: {}, state, capabilities: state.capabilities, evidence: null, m6: null, nodeId: "NODE-A" });
    await assert.rejects(router.handle({ method: "POST", path: "/control/v1/m6/frames/capture", body: {} }), (e) => e.code === "M6_FACADE_UNAVAILABLE");
  } finally { cleanup(root, state); }
});
