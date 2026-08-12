import assert from "node:assert/strict";
import test from "node:test";

import {
  annotatePrimaryAdbSnapshot,
  buildAdbSnapshot,
  buildStableAdbSnapshot,
  buildRecoveryAnalysisEnvelope,
  buildXwStartPlan,
  classifyXwStartFinal,
  classifyRecoveryPass,
  normalizeStartAliases,
  parseAdbDevicesOutput,
  summarizeCapabilityLimits,
} from "../scripts/lib/xw-start.mjs";
import {
  ensureAdbRepair,
  parseXwStartArgs,
  reconcileStoppedServe,
  requireRunsEvidencePath,
} from "../ops/xw-start.mjs";

const SHA = "a".repeat(40);

function healthyAdb() {
  return buildAdbSnapshot({
    serialByAlias: {
      "01": "serial-01",
      "02": "serial-02",
      "03": "serial-03",
      "04": "serial-04",
    },
    adbDevices: {
      "serial-01": "device",
      "serial-02": "device",
      "serial-03": "device",
      "serial-04": "device",
    },
  });
}

function healthySnapshot() {
  return {
    registry: { installed: true, healthy: true },
    controlPlane: { installed: true, healthy: true },
    releaseGate: { ok: true },
    desiredCommit: SHA,
    activeLeases: 0,
    runningJobs: 0,
    pendingApprovals: 0,
    activeBlockers: 0,
    serves: Object.fromEntries(["01", "02", "03", "04"].map((alias) => [alias, {
      installed: true, listening: true, launchCommit: SHA,
    }])),
    devices: Object.fromEntries(["01", "02", "03", "04"].map((alias) => [alias, {
      stateKnown: true, online: true, ready: true, leaseFree: true, quarantined: false, hasUnresolvedFailure: false,
    }])),
    adb: healthyAdb(),
    stateKnown: true,
  };
}

test("aliases are canonical, deduplicated, and validated", () => {
  assert.deepEqual(normalizeStartAliases([]), ["01", "02", "03", "04"]);
  assert.deepEqual(normalizeStartAliases(["03,01", "03"]), ["01", "03"]);
  assert.throws(() => normalizeStartAliases(["05"]), /invalid aliases/);
});

test("CLI supports one-click defaults, check mode, actor and target aliases", () => {
  assert.deepEqual(parseXwStartArgs([]), {
    help: false, check: false, json: false, actor: null, aliases: ["01", "02", "03", "04"],
  });
  assert.deepEqual(parseXwStartArgs(["03,01", "--check", "--actor", "pilot"]), {
    help: false, check: true, json: false, actor: "pilot", aliases: ["01", "03"],
  });
  assert.throws(() => parseXwStartArgs(["--actor"]), /requires a value/);
  assert.throws(() => parseXwStartArgs(["--unsafe"]), /unknown option/);
});

test("healthy infrastructure and devices produce a zero-mutation plan", () => {
  const plan = buildXwStartPlan(healthySnapshot());
  assert.equal(plan.busy, false);
  assert.equal(plan.releaseGateOk, true);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.blockerCount, 0);
  assert.equal(plan.services.registry.action, "none");
  assert.equal(plan.devices["04"].action, "none");
});

test("stopped stale serves rebind only after exact release gates", () => {
  const snapshot = healthySnapshot();
  snapshot.serves["02"] = { installed: true, listening: false, launchCommit: "b".repeat(40) };
  assert.equal(buildXwStartPlan(snapshot).services.serves["02"].action, "rebind_start");
  snapshot.releaseGate.ok = false;
  assert.deepEqual(buildXwStartPlan(snapshot).services.serves["02"], {
    action: "blocked", reason: "release_gate_failed",
  });
});

test("a stale running serve is converged through an exact-release rebind restart", () => {
  const snapshot = healthySnapshot();
  snapshot.serves["01"].launchCommit = "b".repeat(40);
  assert.deepEqual(buildXwStartPlan(snapshot).services.serves["01"], {
    action: "rebind_restart", reason: "stale_running_serve",
  });
});

test("active work prevents serve changes and readiness submissions", () => {
  const snapshot = healthySnapshot();
  snapshot.activeLeases = 1;
  snapshot.serves["01"].listening = false;
  snapshot.devices["01"].ready = false;
  const plan = buildXwStartPlan(snapshot);
  assert.equal(plan.busy, true);
  assert.deepEqual(plan.services.serves["01"], { action: "blocked", reason: "active_work" });
  assert.deepEqual(plan.devices["01"], { action: "blocked", reason: "active_work" });
});

test("only unhealthy non-quarantined devices receive the universal R0 readiness job", () => {
  const snapshot = healthySnapshot();
  snapshot.devices["01"].ready = false;
  snapshot.devices["01"].hasUnresolvedFailure = true;
  snapshot.devices["02"].quarantined = true;
  snapshot.devices["02"].ready = false;
  snapshot.devices["02"].unresolvedJobId = "job_02";
  const plan = buildXwStartPlan(snapshot);
  assert.equal(plan.devices["01"].action, "readiness_job");
  assert.equal(plan.devices["01"].capabilityId, "xiaowei.device.list");
  assert.deepEqual(plan.devices["02"], { action: "audited_recovery", reason: "quarantined", jobId: "job_02" });
  assert.equal(plan.devices["03"].action, "none");
});

test("final READY_WITH_LIMITS is honest about capability blockers", () => {
  const snapshot = healthySnapshot();
  snapshot.activeBlockers = 4;
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.status, "READY_WITH_LIMITS");
  assert.equal(result.canExecute, true);
  assert.equal(result.canPushImages, true);
  assert.equal(result.allHealthy, false);
  assert.equal(result.activeBlockers, 4);
});

test("active blockers are capability-scoped instead of disabling unrelated tasks", () => {
  const snapshot = healthySnapshot();
  snapshot.activeBlockers = 1;
  snapshot.capabilityLimits = summarizeCapabilityLimits([{
    id: "pitfall-xhs-note",
    app: "xhs",
    title: "note locator exits serve",
    appliesTo: ["xhs.observe.note_detail", "scripts/fast-operator.mjs", "device:01"],
  }]);
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.status, "READY_WITH_LIMITS");
  assert.equal(result.canExecute, true);
  assert.deepEqual(result.capabilityLimits[0].capabilityIds, ["xhs.observe.note_detail"]);
  assert.deepEqual(result.capabilityLimits[0].deviceAliases, ["01"]);
  assert.equal(result.capabilityLimits[0].scope, "device_capability");
});

test("PnP-present stable ADB misses require Xiaowei's formal restart instead of a raw daemon restart", () => {
  const snapshot = healthySnapshot();
  snapshot.adb = buildStableAdbSnapshot({
    serialByAlias: {
      "01": "serial-01",
      "02": "serial-02",
      "03": "serial-03",
      "04": "serial-04",
    },
    samples: Array.from({ length: 3 }, () => ({ "serial-02": "device", "serial-03": "device" })),
    pnpPresentByAlias: { "01": true, "02": true, "03": true, "04": true },
  });
  const plan = buildXwStartPlan(snapshot);
  assert.equal(plan.adb.action, "human_required");
  assert.equal(plan.adb.reason, "xiaowei_restart_adb_required");
  assert.equal(plan.adb.ok, false);
  assert.deepEqual(plan.adb.missing, ["01", "04"]);
  assert.deepEqual(plan.adb.repairCandidates, ["01", "04"]);
  assert.equal(plan.mutationCount, 0);
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.status, "READY_WITH_LIMITS");
  assert.equal(result.canExecute, true);
  assert.equal(result.canPushImages, false);
  assert.equal(result.adbOk, false);
  assert.equal(result.allHealthy, false);
  assert.ok(result.adbLimits.some((item) => item.includes("01")));
  assert.ok(result.adbLimits.some((item) => item.includes("04")));
});

test("physical absence and active work never trigger automatic ADB repair", () => {
  const snapshot = healthySnapshot();
  snapshot.adb = buildStableAdbSnapshot({
    serialByAlias: { "01": "serial-01", "02": "serial-02", "03": "serial-03", "04": "serial-04" },
    samples: [{}, {}, {}],
    pnpPresentByAlias: { "01": false, "02": false, "03": false, "04": false },
  });
  assert.equal(buildXwStartPlan(snapshot).adb.action, "human_required");
  snapshot.activeLeases = 1;
  assert.equal(buildXwStartPlan(snapshot).adb.action, "blocked");
});

test("ADB flapping is not accepted as healthy and is repairable when PnP remains present", () => {
  const adb = buildStableAdbSnapshot({
    aliases: ["01"],
    serialByAlias: { "01": "serial-01" },
    samples: [{ "serial-01": "device" }, {}, { "serial-01": "device" }],
    pnpPresentByAlias: { "01": true },
  });
  assert.equal(adb.ok, false);
  assert.equal(adb.devices["01"].reason, "adb_flapping");
  assert.deepEqual(adb.repairCandidates, ["01"]);
});

test("5038 remains authoritative while devices seen only on 5037 are wrong_port", () => {
  const serialByAlias = { "01": "serial-01", "02": "serial-02" };
  const primary = buildStableAdbSnapshot({
    aliases: ["01", "02"],
    serialByAlias,
    port: "5038",
    samples: Array.from({ length: 3 }, () => ({ "serial-02": "device" })),
    pnpPresentByAlias: { "01": true, "02": true },
  });
  const sideDaemon = buildStableAdbSnapshot({
    aliases: ["01", "02"],
    serialByAlias,
    port: "5037",
    samples: Array.from({ length: 3 }, () => ({ "serial-01": "device" })),
    pnpPresentByAlias: { "01": true, "02": true },
  });
  const adb = annotatePrimaryAdbSnapshot(primary, [sideDaemon]);

  assert.equal(adb.port, "5038");
  assert.equal(adb.ok, false);
  assert.equal(adb.devices["01"].ok, false);
  assert.equal(adb.devices["01"].reason, "wrong_port");
  assert.deepEqual(adb.devices["01"].observedPorts, ["5037"]);
  assert.deepEqual(adb.wrongPortAliases, ["01"]);

  const snapshot = healthySnapshot();
  snapshot.adb = adb;
  const plan = buildXwStartPlan(snapshot, { aliases: ["01", "02"] });
  assert.equal(plan.adb.action, "repair");
  assert.equal(plan.adb.reason, "adb_wrong_port");
  assert.deepEqual(plan.adb.wrongPortAliases, ["01"]);
  assert.equal(plan.mutationCount, 1);

  snapshot.devices["01"].ready = false;
  assert.equal(buildXwStartPlan(snapshot, { aliases: ["01", "02"] }).adb.reason, "adb_wrong_port");

  const result = classifyXwStartFinal(snapshot, { aliases: ["01", "02"] });
  assert.equal(result.adbOk, false);
  assert.equal(result.canPushImages, false);
  assert.deepEqual(result.imagePushByAlias, { "01": false, "02": true });
  assert.equal(result.allHealthy, false);
});

test("wrong-port ADB repair is blocked while the release gate is closed", () => {
  const serialByAlias = { "01": "serial-01", "02": "serial-02" };
  const primary = buildStableAdbSnapshot({
    aliases: ["01", "02"],
    serialByAlias,
    port: "5038",
    samples: Array.from({ length: 3 }, () => ({ "serial-02": "device" })),
    pnpPresentByAlias: { "01": true, "02": true },
  });
  const sideDaemon = buildStableAdbSnapshot({
    aliases: ["01", "02"],
    serialByAlias,
    port: "5037",
    samples: Array.from({ length: 3 }, () => ({ "serial-01": "device" })),
    pnpPresentByAlias: { "01": true, "02": true },
  });
  const snapshot = healthySnapshot();
  snapshot.adb = annotatePrimaryAdbSnapshot(primary, [sideDaemon]);
  snapshot.releaseGate.ok = false;
  const plan = buildXwStartPlan(snapshot, { aliases: ["01", "02"] });
  assert.equal(plan.adb.action, "blocked");
  assert.equal(plan.adb.reason, "release_gate_failed");
  assert.equal(plan.mutationCount, 0);
});

test("ensureAdbRepair kills only the orphan 5037 daemon when wrong-port and idle", async () => {
  const snapshot = healthySnapshot();
  snapshot.adb = { wrongPortAliases: ["01"] };
  const actions = [];
  let killed = false;
  const result = await ensureAdbRepair(snapshot, actions, { kill: async () => { killed = true; } });
  assert.equal(killed, true);
  assert.equal(result.status, "repaired");
  assert.deepEqual(result.aliases, ["01"]);
  assert.deepEqual(actions, [{ kind: "adb", action: "kill_orphan_daemon", port: "5037", aliases: ["01"] }]);
});

test("ensureAdbRepair is a no-op without wrong-port devices and blocked under active work", async () => {
  const snapshot = healthySnapshot();
  snapshot.adb = { wrongPortAliases: [] };
  let killed = false;
  assert.deepEqual(
    await ensureAdbRepair(snapshot, [], { kill: async () => { killed = true; } }),
    { status: "none", aliases: [] },
  );
  assert.equal(killed, false);

  snapshot.adb = { wrongPortAliases: ["01"] };
  snapshot.activeLeases = 1;
  assert.deepEqual(
    await ensureAdbRepair(snapshot, [], { kill: async () => { killed = true; } }),
    { status: "blocked", reason: "active_work", aliases: ["01"] },
  );
  assert.equal(killed, false);
});

test("ensureAdbRepair records a failed kill without throwing", async () => {
  const snapshot = healthySnapshot();
  snapshot.adb = { wrongPortAliases: ["01"] };
  const actions = [];
  const result = await ensureAdbRepair(snapshot, actions, {
    kill: async () => { throw new Error("adb gone"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "adb gone");
  assert.equal(actions[0].action, "kill_orphan_daemon_failed");
});

test("audited recovery permits one reversible action but requires fresh main-safe before clearing", () => {
  assert.equal(classifyRecoveryPass({ pageType: "unknown", safeStateVerified: false }, 1), "apply_recovery_action");
  assert.equal(classifyRecoveryPass({ pageType: "unknown", safeStateVerified: false }, 2), "human_required");
  assert.equal(classifyRecoveryPass({ pageType: "main-safe", safeStateVerified: true }, 2), "clear_quarantine");
});

test("parseAdbDevicesOutput keeps serial states", () => {
  const map = parseAdbDevicesOutput(`List of devices attached
9b18cccb               device product:mona
1511f78c               offline
`);
  assert.deepEqual(map, { "9b18cccb": "device", "1511f78c": "offline" });
});

test("fully healthy gateway+ADB classifies READY and allHealthy", () => {
  const result = classifyXwStartFinal(healthySnapshot());
  assert.equal(result.status, "READY");
  assert.equal(result.ok, true);
  assert.equal(result.adbOk, true);
  assert.equal(result.canPushImages, true);
  assert.equal(result.allHealthy, true);
});

test("final classification fails closed on service, device and resource debt", () => {
  const snapshot = healthySnapshot();
  snapshot.serves["04"].listening = false;
  snapshot.devices["02"].ready = false;
  snapshot.activeLeases = 1;
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.status, "WAITING");
  assert.equal(result.canExecuteAny, false);
  assert.equal(result.canExecuteAllTargets, false);
  assert.deepEqual(result.readyAliases, ["01", "03"]);
  assert.deepEqual(result.humanRequiredAliases, ["02", "04"]);
  assert.ok(result.reasons.includes("serve_04_not_listening"));
  assert.ok(result.reasons.includes("device_02_not_ready"));
  assert.ok(result.reasons.includes("active_lease_present"));
});

test("missing base infrastructure produces BLOCKED", () => {
  const snapshot = healthySnapshot();
  snapshot.registry.healthy = false;
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.includes("registry_not_healthy"));
});

test("unavailable live device state is explicit and never downgraded to offline", () => {
  const snapshot = healthySnapshot();
  snapshot.stateKnown = false;
  snapshot.devices = {};
  const plan = buildXwStartPlan(snapshot);
  assert.deepEqual(plan.devices["01"], { action: "blocked", reason: "state_unavailable" });
  const result = classifyXwStartFinal(snapshot);
  assert.ok(result.reasons.includes("device_01_state_unavailable"));
  assert.equal(result.reasons.includes("device_01_offline"), false);
});

test("visual OCR blocks are converted to the audited recovery envelope coordinate contract", () => {
  const envelope = buildRecoveryAnalysisEnvelope({
    screenshot: { sha256: "a".repeat(64), bytes: 1234 },
    blocksDocument: {
      input: { sourceResolution: [1080, 2400] },
      timingMs: { ocr: 12 },
      blocks: [
        { blockId: "b001", text: "闲鱼", sourceBBox: [100, 200, 80, 40] },
        { blockId: "b002", sourceBBox: [1, 2, 3, 4] },
      ],
    },
  });
  assert.equal(envelope.schemaVersion, "xhs.visual-elements.v1");
  assert.deepEqual(envelope.image.resolution, [1080, 2400]);
  assert.deepEqual(envelope.elements, [{
    id: "b001",
    label: "闲鱼",
    bounds: [100, 200, 180, 240],
    conf: null,
    source: "visual-tap-resolver-ocr",
  }]);
});

test("recovery evidence paths are bound to the inspected run and reject traversal", () => {
  const runsRoot = "C:\\safe-runs";
  assert.equal(
    requireRunsEvidencePath("evidence\\screen.png", "run_12345678", { runsRoot }),
    "C:\\safe-runs\\run_12345678\\evidence\\screen.png",
  );
  assert.throws(
    () => requireRunsEvidencePath("..\\..\\outside.png", "run_12345678", { runsRoot }),
    /outside the configured runs root/,
  );
});

test("partial task rebind continues in one call only after exact config and task binding are reverified", async () => {
  const calls = [];
  const result = await reconcileStoppedServe({
    alias: "01",
    launchCommit: "b".repeat(40),
    desiredCommit: SHA,
    install: async () => {
      calls.push("install");
      throw new Error("Register-ScheduledTask access denied");
    },
    inspectPartialInstall: async () => {
      calls.push("verify");
      return { installed: true, listening: false, launchCommit: SHA, taskBindingOk: true };
    },
    start: async () => {
      calls.push("start");
      return { listening: true, port: 17895 };
    },
  });
  assert.deepEqual(calls, ["install", "verify", "start"]);
  assert.equal(result.rebindAction, "rebound_existing_task");
  assert.equal(result.started.listening, true);
});

test("partial task rebind fails closed when exact binding cannot be proven", async () => {
  let started = false;
  await assert.rejects(() => reconcileStoppedServe({
    alias: "01",
    launchCommit: "b".repeat(40),
    desiredCommit: SHA,
    install: async () => { throw new Error("install failed"); },
    inspectPartialInstall: async () => ({ installed: true, listening: false, launchCommit: SHA, taskBindingOk: false }),
    start: async () => { started = true; },
  }), /install failed/);
  assert.equal(started, false);
});
