/** Pure planning and final-state classification for `/xw start`. */

export const XW_START_ALIASES = Object.freeze(["01", "02", "03", "04"]);
export const XW_START_READINESS_CAPABILITY = "xiaowei.device.list";

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function normalizeStartAliases(values = []) {
  const tokens = values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const aliases = tokens.length ? [...new Set(tokens)] : [...XW_START_ALIASES];
  const invalid = aliases.filter((alias) => !XW_START_ALIASES.includes(alias));
  if (invalid.length) throw new Error(`invalid aliases: ${invalid.join(",")}`);
  return XW_START_ALIASES.filter((alias) => aliases.includes(alias));
}

function serviceAction(service) {
  if (service?.healthy === true) return { action: "none", reason: "healthy" };
  if (service?.installed !== true) return { action: "blocked", reason: "task_missing" };
  return { action: "start", reason: "not_healthy" };
}

function serveAction(serve, desiredCommit, releaseGateOk, busy) {
  if (serve?.installed !== true) return { action: "blocked", reason: "task_missing" };
  const stale = !serve.launchCommit || serve.launchCommit !== desiredCommit;
  if (serve.listening === true && stale) {
    return { action: "blocked", reason: "stale_running_serve" };
  }
  if (serve.listening === true) return { action: "none", reason: "listening" };
  if (busy) return { action: "blocked", reason: "active_work" };
  if (!releaseGateOk) return { action: "blocked", reason: "release_gate_failed" };
  return stale
    ? { action: "rebind_start", reason: "stale_launch_config" }
    : { action: "start", reason: "not_listening" };
}

function deviceAction(device, servicesAvailable, busy) {
  if (!servicesAvailable) return { action: "blocked", reason: "infrastructure_unavailable" };
  if (device?.stateKnown !== true) return { action: "blocked", reason: "state_unavailable" };
  if (device?.online !== true) return { action: "blocked", reason: "offline" };
  if (device?.quarantined === true) return { action: "blocked", reason: "audited_recovery_required" };
  if (device?.leaseFree !== true || busy) return { action: "blocked", reason: "active_work" };
  if (device?.ready === true && device?.hasUnresolvedFailure !== true) {
    return { action: "none", reason: "ready" };
  }
  return {
    action: "readiness_job",
    reason: device?.hasUnresolvedFailure ? "unresolved_failure" : "not_ready",
    capabilityId: XW_START_READINESS_CAPABILITY,
  };
}

export function buildXwStartPlan(snapshot, { aliases = XW_START_ALIASES } = {}) {
  const selected = normalizeStartAliases(aliases);
  const activeLeases = integer(snapshot?.activeLeases);
  const runningJobs = integer(snapshot?.runningJobs);
  const busy = activeLeases > 0 || runningJobs > 0;
  const registry = serviceAction(snapshot?.registry);
  const controlPlane = serviceAction(snapshot?.controlPlane);
  const servicesAvailable = [registry, controlPlane].every((item) => item.action !== "blocked");
  const desiredCommit = String(snapshot?.desiredCommit || "");
  const releaseGateOk = snapshot?.releaseGate?.ok === true && /^[0-9a-f]{40}$/.test(desiredCommit);

  const serves = Object.fromEntries(selected.map((alias) => [
    alias,
    serveAction(snapshot?.serves?.[alias], desiredCommit, releaseGateOk, busy),
  ]));
  const devices = Object.fromEntries(selected.map((alias) => [
    alias,
    deviceAction(snapshot?.devices?.[alias], servicesAvailable, busy),
  ]));

  const actions = [registry, controlPlane, ...Object.values(serves), ...Object.values(devices)];
  return {
    schemaId: "xhs.xw-start-plan.v1",
    schemaVersion: 1,
    aliases: selected,
    busy,
    activeLeases,
    runningJobs,
    releaseGateOk,
    releaseGateReason: snapshot?.releaseGate?.reason || null,
    stateKnown: snapshot?.stateKnown === true,
    services: { registry, controlPlane, serves },
    devices,
    mutationCount: actions.filter((item) => ["start", "rebind_start", "readiness_job"].includes(item.action)).length,
    blockerCount: actions.filter((item) => item.action === "blocked").length,
  };
}

export function classifyXwStartFinal(snapshot, { aliases = XW_START_ALIASES } = {}) {
  const selected = normalizeStartAliases(aliases);
  const reasons = [];
  if (snapshot?.registry?.healthy !== true) reasons.push("registry_not_healthy");
  if (snapshot?.controlPlane?.healthy !== true) reasons.push("control_plane_not_healthy");
  if (integer(snapshot?.activeLeases) !== 0) reasons.push("active_lease_present");
  if (integer(snapshot?.runningJobs) !== 0) reasons.push("running_job_present");
  if (integer(snapshot?.pendingApprovals) !== 0) reasons.push("pending_approval_present");

  for (const alias of selected) {
    const serve = snapshot?.serves?.[alias];
    const device = snapshot?.devices?.[alias];
    if (serve?.listening !== true) reasons.push(`serve_${alias}_not_listening`);
    if (device?.stateKnown !== true) {
      reasons.push(`device_${alias}_state_unavailable`);
      continue;
    }
    if (device?.online !== true) reasons.push(`device_${alias}_offline`);
    if (device?.quarantined === true) reasons.push(`device_${alias}_quarantined`);
    if (device?.leaseFree !== true) reasons.push(`device_${alias}_lease_busy`);
    if (device?.ready !== true || device?.hasUnresolvedFailure === true) reasons.push(`device_${alias}_not_ready`);
  }

  const infrastructureBlocked = reasons.some((reason) => /^(registry|control_plane)/.test(reason));
  const status = reasons.length
    ? (infrastructureBlocked ? "BLOCKED" : "PARTIAL")
    : (integer(snapshot?.activeBlockers) > 0 ? "READY_WITH_LIMITS" : "READY");
  return {
    schemaId: "xhs.xw-start-result.v1",
    schemaVersion: 1,
    ok: reasons.length === 0,
    status,
    canExecute: reasons.length === 0,
    aliases: selected,
    reasons,
    activeBlockers: integer(snapshot?.activeBlockers),
  };
}
