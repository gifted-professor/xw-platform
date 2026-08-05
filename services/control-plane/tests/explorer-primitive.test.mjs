import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";
import { validateExplorerPrimitiveParams } from "../apps/xiaowei/explorer-primitive.mjs";
import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

const privateDevice = {
  runtimeId: "private-runtime-id",
  alias: "01",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture({ transport: transportOverride = null } = {}) {
  const calls = [];
  let activeIme = "com.samsung/.ime";
  const transport = transportOverride || {
    async invoke(input, options = {}) {
      calls.push({ input, options });
      const { action } = input;
      if (action === "Screen") return { code: 10000 };
      if (action === "adb_shell") {
        const cmd = String(input.data?.command || "");
        if (cmd.includes("uiautomator dump")) return { code: 10000, data: "" };
        if (cmd.includes("base64")) return { code: 10000, data: Buffer.from("<hierarchy/>").toString("base64") };
        if (cmd.includes("settings get secure default_input_method")) return { code: 10000, data: activeIme };
        if (cmd.includes("input tap")) return { code: 10000, data: "" };
        if (cmd.includes("input swipe")) return { code: 10000, data: "" };
        if (cmd.includes("input keyevent")) return { code: 10000, data: "" };
        if (cmd.includes("dumpsys window")) return { code: 10000, data: "mCurrentFocus=com.test/.Main" };
        if (cmd.includes("am start") || cmd.includes("monkey")) return { code: 10000, data: "ok" };
        return { code: 10000, data: "" };
      }
      if (action === "selectIme") {
        activeIme = String(input.data?.ime || activeIme);
        return { code: 10000 };
      }
      if (action === "inputText") return { code: 10000 };
      return { code: 10000, data: {} };
    },
  };
  const root = mkdtempSync(join(tempBase, "explorer-primitive-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const device = state.upsertDevice({
    alias: privateDevice.alias,
    physicalLabel: "rack-01",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: privateDevice.runtimeId,
    routingProfile: { enabled: true, tags: ["slot:01"], capabilityIds: [capability.id, "xiaowei.lab.raw"] },
  });
  const adapter = createXiaoweiAdapter({ transport });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([adapter]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  return {
    root,
    state,
    evidence,
    control,
    adapter,
    transport,
    calls,
    device,
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("registry loads bounded Explorer primitive capability", () => {
  assert.equal(capability.id, "xiaowei.explorer.primitive");
  assert.equal(capability.implementation.action, "explorer_primitive");
  assert.deepEqual(capability.inputSchema.required, ["primitive"]);
});

test("validateExplorerPrimitiveParams rejects out-of-range tap coordinates", () => {
  assert.throws(
    () => validateExplorerPrimitiveParams({ primitive: "tap", x: 5000, y: 10 }),
    { code: "PARAMS_SCHEMA_INVALID" },
  );
});

test("adapter rejects non-canary and lease/device mismatch with zero transport calls", async () => {
  const f = fixture();
  const evidenceDirectory = mkdtempSync(join(tempBase, "evidence-one-"));
  await assert.rejects(
    f.adapter.execute({
      capability,
      device: deviceView(f),
      params: { primitive: "focus" },
      evidenceDirectory,
      leaseAuthorization: leaseFor(f),
      job: { canary: false },
    }),
    { code: "CANARY_REQUIRED" },
  );
  await assert.rejects(
    f.adapter.execute({
      capability,
      device: deviceView(f),
      params: { primitive: "focus" },
      evidenceDirectory,
      leaseAuthorization: { leaseId: "L1", token: "T1", deviceId: "other-device" },
      job: { canary: true },
    }),
    { code: "LEASE_DEVICE_MISMATCH" },
  );
  assert.equal(f.calls.length, 0);
  rmSync(evidenceDirectory, { recursive: true, force: true });
  await f.close();
});

function deviceView(f) {
  return {
    deviceId: f.device.deviceId,
    runtimeId: f.device.runtimeId,
    alias: f.device.alias,
  };
}

function leaseFor(f) {
  return { leaseId: "L1", token: "T1", deviceId: f.device.deviceId };
}

test("focus primitive executes through adapter transport", async () => {
  const f = fixture();
  const evidenceDirectory = mkdtempSync(join(tempBase, "evidence-two-"));
  const execution = await f.adapter.execute({
    capability,
    device: deviceView(f),
    params: { primitive: "focus" },
    evidenceDirectory,
    leaseAuthorization: leaseFor(f),
    job: { canary: true },
  });
  assert.equal(execution.output.ok, true);
  assert.equal(execution.output.primitive, "focus");
  assert.match(execution.output.raw, /com\.test/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.action, "adb_shell");
  rmSync(evidenceDirectory, { recursive: true, force: true });
  await f.close();
});

test("input_text evidence omits full text body", async () => {
  const f = fixture();
  const evidenceDirectory = mkdtempSync(join(tempBase, "evidence-three-"));
  const secret = "secret phrase should not leak and must be truncated from evidence payload";
  const execution = await f.adapter.execute({
    capability,
    device: deviceView(f),
    params: { primitive: "input_text", text: secret },
    evidenceDirectory,
    leaseAuthorization: leaseFor(f),
    job: { canary: true },
  });
  assert.equal(execution.output.textPreview, secret.slice(0, 40));
  assert.equal(Object.hasOwn(execution.output, "text"), false);
  assert.match(JSON.stringify(execution.output), /textPreview/);
  assert.doesNotMatch(JSON.stringify(execution.output), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  rmSync(evidenceDirectory, { recursive: true, force: true });
  await f.close();
});

test("session action blocks release while Explorer primitive is running", async () => {
  const gate = deferred();
  let executions = 0;
  const f = fixture({
    transport: {
      async invoke(input) {
        executions += 1;
        if (input.action === "adb_shell" && String(input.data?.command || "").includes("dumpsys window")) {
          await gate.promise;
        }
        return { code: 10000, data: "mCurrentFocus=com.test/.Main" };
      },
    },
  });
  let session;
  try {
    session = f.control.createSession({
      actorId: "explorer-a",
      deviceId: f.device.deviceId,
      capability,
      canary: true,
    });
    const running = f.control.executeSessionAction(session.sessionId, session.token, {
      idempotencyKey: "explorer-focus-running",
      capabilityId: capability.id,
      params: { primitive: "focus" },
    });
    await until(() => executions === 1);
    assert.throws(
      () => f.control.releaseSession(session.sessionId, session.token),
      { code: "SESSION_ACTION_RUNNING", status: 423 },
    );
    gate.resolve();
    const job = await running;
    assert.equal(job.status, "succeeded");
    assert.equal(f.control.releaseSession(session.sessionId, session.token).released, true);
    session = null;
  } finally {
    gate.resolve();
    if (session) {
      try { f.control.releaseSession(session.sessionId, session.token); } catch {}
    }
    await f.close();
  }
});

test("wrong session token rejects before adapter executes", async () => {
  const f = fixture();
  try {
    const session = f.control.createSession({
      actorId: "explorer-a",
      deviceId: f.device.deviceId,
      capability,
      canary: true,
    });
    await assert.rejects(
      f.control.executeSessionAction(session.sessionId, "wrong-token", {
        idempotencyKey: "bad-token",
        capabilityId: capability.id,
        params: { primitive: "focus" },
      }),
      { code: "SESSION_TOKEN_INVALID" },
    );
    f.control.releaseSession(session.sessionId, session.token);
  } finally {
    await f.close();
  }
});

test("dump_ui writes hierarchy xml into evidence directory", async () => {
  const f = fixture();
  const evidenceDirectory = mkdtempSync(join(tempBase, "evidence-four-"));
  const execution = await f.adapter.execute({
    capability,
    device: deviceView(f),
    params: { primitive: "dump_ui" },
    evidenceDirectory,
    leaseAuthorization: leaseFor(f),
    job: { canary: true },
  });
  assert.equal(execution.output.ok, true);
  assert.match(execution.output.path, /dump-ui\.xml$/);
  rmSync(evidenceDirectory, { recursive: true, force: true });
  await f.close();
});

test("screen primitive records png artifact path", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const f = fixture({
    transport: {
      async invoke(input) {
        if (input.action !== "Screen") return { code: 10000, data: {} };
        const savePath = input.data.savePath;
        mkdirSync(savePath, { recursive: true });
        writeFileSync(join(savePath, "shot.png"), png);
        return { code: 10000 };
      },
    },
  });
  const evidenceDirectory = mkdtempSync(join(tempBase, "evidence-five-"));
  const execution = await f.adapter.execute({
    capability,
    device: deviceView(f),
    params: { primitive: "screen" },
    evidenceDirectory,
    leaseAuthorization: leaseFor(f),
    job: { canary: true },
  });
  assert.equal(execution.output.ok, true);
  assert.match(execution.output.path, /screen\.png$/);
  rmSync(evidenceDirectory, { recursive: true, force: true });
  await f.close();
});
