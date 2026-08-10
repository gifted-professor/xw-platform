import assert from "node:assert/strict";
import test from "node:test";

import {
  buildXwStartPlan,
  classifyXwStartFinal,
  normalizeStartAliases,
} from "../scripts/lib/xw-start.mjs";
import { parseXwStartArgs, reconcileStoppedServe } from "../ops/xw-start.mjs";

const SHA = "a".repeat(40);

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

test("a stale running serve is never restarted implicitly", () => {
  const snapshot = healthySnapshot();
  snapshot.serves["01"].launchCommit = "b".repeat(40);
  assert.deepEqual(buildXwStartPlan(snapshot).services.serves["01"], {
    action: "blocked", reason: "stale_running_serve",
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
  const plan = buildXwStartPlan(snapshot);
  assert.equal(plan.devices["01"].action, "readiness_job");
  assert.equal(plan.devices["01"].capabilityId, "xiaowei.device.list");
  assert.deepEqual(plan.devices["02"], { action: "blocked", reason: "audited_recovery_required" });
  assert.equal(plan.devices["03"].action, "none");
});

test("final READY_WITH_LIMITS is honest about capability blockers", () => {
  const snapshot = healthySnapshot();
  snapshot.activeBlockers = 4;
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.status, "READY_WITH_LIMITS");
  assert.equal(result.canExecute, true);
  assert.equal(result.activeBlockers, 4);
});

test("final classification fails closed on service, device and resource debt", () => {
  const snapshot = healthySnapshot();
  snapshot.serves["04"].listening = false;
  snapshot.devices["02"].ready = false;
  snapshot.activeLeases = 1;
  const result = classifyXwStartFinal(snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.status, "PARTIAL");
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
