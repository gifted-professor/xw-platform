/** Pure planning and final-state classification for `/xw start`. */

export const XW_START_ALIASES = Object.freeze(["01", "02", "03", "04"]);
export const XW_START_READINESS_CAPABILITY = "xiaowei.device.list";
export const XW_START_ADB_PORT = "5038";

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

/**
 * Build an ADB health snapshot from a parsed `adb devices` map.
 * Report-only: never mutates phones or counts as a plan mutation.
 *
 * @param {{
 *   aliases?: string[],
 *   serialByAlias?: Record<string, string|null|undefined>,
 *   adbDevices?: Record<string, string>,
 *   port?: string|number,
 *   adbPath?: string|null,
 *   error?: string|null,
 * }} input
 */
export function buildAdbSnapshot({
  aliases = XW_START_ALIASES,
  serialByAlias = {},
  adbDevices = {},
  port = XW_START_ADB_PORT,
  adbPath = null,
  error = null,
} = {}) {
  const selected = normalizeStartAliases(aliases);
  const devices = Object.fromEntries(selected.map((alias) => {
    const serial = String(serialByAlias?.[alias] || "").trim() || null;
    if (!serial) {
      return [alias, { alias, serial: null, state: "serial_unknown", ok: false, reason: "serial_unknown" }];
    }
    const state = String(adbDevices?.[serial] || "absent").trim() || "absent";
    const ok = state === "device";
    return [alias, {
      alias,
      serial,
      state,
      ok,
      reason: ok ? "device" : (state === "absent" ? "adb_miss" : `adb_${state}`),
    }];
  }));
  const missing = selected.filter((alias) => devices[alias]?.ok !== true);
  const enumerated = Object.keys(adbDevices || {}).length;
  return {
    schemaId: "xhs.xw-start-adb.v1",
    schemaVersion: 1,
    port: String(port || XW_START_ADB_PORT),
    adbPath: adbPath || null,
    ok: error == null && missing.length === 0,
    error: error || null,
    enumerated,
    missing,
    devices,
    // inspect-only: start never auto-fixes USB/ADB attachment
    action: "report_only",
    reason: error
      ? "adb_unavailable"
      : (missing.length === 0 ? "healthy" : (missing.length === selected.length ? "none_present" : "partial")),
  };
}

/** Parse `adb devices [-l]` stdout into { serial: state }. */
export function parseAdbDevicesOutput(stdout) {
  const map = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^List of devices/i.test(trimmed)) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)/);
    if (!match) continue;
    map[match[1]] = match[2];
  }
  return map;
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
    if (busy) return { action: "blocked", reason: "active_work" };
    if (!releaseGateOk) return { action: "blocked", reason: "release_gate_failed" };
    return { action: "rebind_restart", reason: "stale_running_serve" };
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
  if (device?.quarantined === true) {
    return device?.unresolvedJobId
      ? { action: "audited_recovery", reason: "quarantined", jobId: device.unresolvedJobId }
      : { action: "blocked", reason: "recovery_job_missing" };
  }
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
  const adb = snapshot?.adb && typeof snapshot.adb === "object"
    ? snapshot.adb
    : buildAdbSnapshot({ aliases: selected, error: "adb_not_inspected" });
  const adbRepairCandidates = Array.isArray(adb.repairCandidates) ? adb.repairCandidates : [];
  const targetDevicesReady = selected.every((alias) => {
    const device = snapshot?.devices?.[alias];
    return snapshot?.serves?.[alias]?.listening === true
      && device?.stateKnown === true
      && device?.online === true
      && device?.ready === true
      && device?.leaseFree === true
      && device?.quarantined !== true
      && device?.hasUnresolvedFailure !== true;
  });
  let adbAction = "none";
  let adbActionReason = "healthy";
  if (adb.ok !== true) {
    if (busy) {
      adbAction = "blocked";
      adbActionReason = "active_work";
    } else if (!releaseGateOk) {
      adbAction = "blocked";
      adbActionReason = "release_gate_failed";
    } else if (Array.isArray(adb.wrongPortAliases) && adb.wrongPortAliases.length > 0) {
      // Devices on the orphan 5037 daemon: /xw start kills that daemon so they
      // return to Xiaowei's authoritative 5038. Only ever touches 5037.
      adbAction = "repair";
      adbActionReason = "adb_wrong_port";
    } else if (!targetDevicesReady) {
      adbAction = "blocked";
      adbActionReason = "gateway_not_ready";
    } else {
      adbAction = "human_required";
      adbActionReason = adbRepairCandidates.length > 0
        ? "xiaowei_restart_adb_required"
        : "physical_or_authorization_issue";
    }
  }
  return {
    schemaId: "xhs.xw-start-plan.v1",
    schemaVersion: 2,
    aliases: selected,
    busy,
    activeLeases,
    runningJobs,
    releaseGateOk,
    releaseGateReason: snapshot?.releaseGate?.reason || null,
    stateKnown: snapshot?.stateKnown === true,
    services: { registry, controlPlane, serves },
    devices,
    adb: {
      action: adbAction,
      ok: adb.ok === true,
      reason: adbActionReason,
      port: adb.port || XW_START_ADB_PORT,
      missing: Array.isArray(adb.missing) ? adb.missing : [],
      repairCandidates: adbRepairCandidates,
      wrongPortAliases: Array.isArray(adb.wrongPortAliases) ? adb.wrongPortAliases : [],
    },
    mutationCount: actions.filter((item) => [
      "start", "rebind_start", "rebind_restart", "audited_recovery", "readiness_job",
    ].includes(item.action)).length + (adbAction === "repair" ? 1 : 0),
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

  const readyAliases = [];
  const humanRequiredAliases = [];
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
    const aliasReady = serve?.listening === true
      && device?.stateKnown === true
      && device?.online === true
      && device?.quarantined !== true
      && device?.leaseFree === true
      && device?.ready === true
      && device?.hasUnresolvedFailure !== true;
    (aliasReady ? readyAliases : humanRequiredAliases).push(alias);
  }

  const adb = snapshot?.adb && typeof snapshot.adb === "object"
    ? snapshot.adb
    : buildAdbSnapshot({ aliases: selected, error: "adb_not_inspected" });
  const adbOk = adb.ok === true;
  const adbLimits = [];
  if (!adbOk) {
    if (adb.error) adbLimits.push(`adb_unavailable:${adb.error}`);
    for (const alias of (adb.missing || selected)) {
      const row = adb.devices?.[alias];
      adbLimits.push(row?.reason ? `adb_${alias}_${row.reason}` : `adb_${alias}_miss`);
    }
  }

  const infrastructureBlocked = reasons.some((reason) => /^(registry|control_plane)/.test(reason));
  const gatewayOk = reasons.length === 0;
  const canExecuteAny = snapshot?.registry?.healthy === true
    && snapshot?.controlPlane?.healthy === true
    && integer(snapshot?.activeLeases) === 0
    && integer(snapshot?.runningJobs) === 0
    && readyAliases.length > 0;
  const capabilityLimits = Array.isArray(snapshot?.capabilityLimits) ? snapshot.capabilityLimits : [];
  const hasCapabilityLimits = capabilityLimits.length > 0 || integer(snapshot?.activeBlockers) > 0;
  let status;
  if (!gatewayOk) {
    if (infrastructureBlocked) status = "BLOCKED";
    else if (integer(snapshot?.activeLeases) > 0 || integer(snapshot?.runningJobs) > 0) status = "WAITING";
    else status = "HUMAN_REQUIRED";
  }
  else if (!adbOk || hasCapabilityLimits) status = "READY_WITH_LIMITS";
  else status = "READY";

  const imagePushByAlias = Object.fromEntries(selected.map((alias) => [
    alias,
    readyAliases.includes(alias) && adb?.devices?.[alias]?.ok === true,
  ]));

  return {
    schemaId: "xhs.xw-start-result.v1",
    schemaVersion: 3,
    ok: gatewayOk,
    status,
    // `canExecute` remains strict for every requested alias. Callers that can
    // place on a healthy subset may use canExecuteAny + readyAliases.
    canExecute: gatewayOk,
    canExecuteAny,
    canExecuteAllTargets: gatewayOk,
    canPushImages: gatewayOk && adbOk,
    canPushImagesAny: Object.values(imagePushByAlias).some(Boolean),
    imagePushByAlias,
    adbOk,
    allHealthy: gatewayOk && adbOk && !hasCapabilityLimits,
    aliases: selected,
    readyAliases,
    humanRequiredAliases,
    reasons,
    adbLimits,
    activeBlockers: integer(snapshot?.activeBlockers),
    capabilityLimits,
  };
}

/** Recovery may perform one reversible action, but only fresh main-safe clears quarantine. */
export function classifyRecoveryPass(pageClassification, attempt = 1) {
  const mainSafe = pageClassification?.pageType === "main-safe"
    && pageClassification?.safeStateVerified === true;
  if (mainSafe) return "clear_quarantine";
  return attempt === 1 ? "apply_recovery_action" : "human_required";
}

/** Build health from consecutive ADB samples plus independent PnP presence. */
export function buildStableAdbSnapshot({
  aliases = XW_START_ALIASES,
  serialByAlias = {},
  samples = [],
  pnpPresentByAlias = {},
  port = XW_START_ADB_PORT,
  adbPath = null,
  error = null,
} = {}) {
  const selected = normalizeStartAliases(aliases);
  const normalizedSamples = samples.length ? samples : [{}];
  const devices = Object.fromEntries(selected.map((alias) => {
    const serial = String(serialByAlias?.[alias] || "").trim() || null;
    const pnpPresent = pnpPresentByAlias?.[alias] === true;
    if (!serial) {
      return [alias, { alias, serial: null, state: "serial_unknown", ok: false, stable: false, pnpPresent, reason: "serial_unknown" }];
    }
    const states = normalizedSamples.map((sample) => String(sample?.[serial] || "absent").trim() || "absent");
    const deviceCount = states.filter((state) => state === "device").length;
    const stable = deviceCount === states.length;
    let state = states.at(-1) || "absent";
    let reason;
    if (stable) reason = "device";
    else if (deviceCount > 0) {
      state = "flapping";
      reason = "adb_flapping";
    } else if (states.some((value) => value === "unauthorized")) reason = "adb_unauthorized";
    else if (states.some((value) => value === "offline")) reason = "adb_offline";
    else if (pnpPresent) reason = "pnp_present_adb_missing";
    else reason = "physical_absent";
    return [alias, { alias, serial, state, states, ok: stable, stable, pnpPresent, reason }];
  }));
  const missing = selected.filter((alias) => devices[alias]?.ok !== true);
  const repairCandidates = missing.filter((alias) => devices[alias]?.pnpPresent === true
    && !["serial_unknown", "adb_unauthorized"].includes(devices[alias]?.reason));
  return {
    schemaId: "xhs.xw-start-adb.v2",
    schemaVersion: 2,
    port: String(port || XW_START_ADB_PORT),
    adbPath: adbPath || null,
    ok: error == null && missing.length === 0,
    error: error || null,
    sampleCount: normalizedSamples.length,
    missing,
    repairCandidates,
    devices,
    action: "report_only",
    reason: error ? "adb_unavailable" : (missing.length ? "unstable_or_missing" : "healthy"),
  };
}

/** Keep 5038 authoritative; other ports are diagnostics, never execution health. */
export function annotatePrimaryAdbSnapshot(primary, diagnostics = []) {
  const diagnosticSnapshots = Array.isArray(diagnostics) ? diagnostics : [];
  const devices = Object.fromEntries(Object.entries(primary?.devices || {}).map(([alias, row]) => {
    if (row?.ok === true) {
      return [alias, { ...row, wrongPort: false, observedPorts: [String(primary.port)] }];
    }
    const observedPorts = diagnosticSnapshots
      .filter((snapshot) => snapshot?.devices?.[alias]?.ok === true)
      .map((snapshot) => String(snapshot.port));
    if (!observedPorts.length) {
      return [alias, { ...row, wrongPort: false, observedPorts: [] }];
    }
    return [alias, {
      ...row,
      state: "device_wrong_port",
      ok: false,
      stable: false,
      wrongPort: true,
      observedPorts,
      reason: "wrong_port",
    }];
  }));
  const wrongPortAliases = Object.keys(devices).filter((alias) => devices[alias]?.wrongPort === true);
  return {
    ...primary,
    devices,
    wrongPortAliases,
    diagnosticPorts: diagnosticSnapshots.map((snapshot) => ({
      port: String(snapshot.port),
      ok: snapshot.ok === true,
      missing: snapshot.missing || [],
    })),
  };
}

/** Convert active knowledge blockers into capability-scoped limits. */
export function summarizeCapabilityLimits(blockers = []) {
  return (Array.isArray(blockers) ? blockers : []).map((blocker) => {
    const appliesTo = Array.isArray(blocker?.appliesTo) ? blocker.appliesTo.map(String) : [];
    const capabilityIds = appliesTo.filter((value) => (
      /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){2,}$/.test(value)
      && !value.includes("scripts")
    ));
    const deviceAliases = [...new Set([
      String(blocker?.scope || ""),
      ...appliesTo,
    ].map((value) => value.match(/^device:(0[1-4])$/)?.[1]).filter(Boolean))];
    return {
      blockerId: String(blocker?.id || "unknown"),
      appId: String(blocker?.app || "unknown") || "unknown",
      title: String(blocker?.title || blocker?.summary || "active capability blocker"),
      capabilityIds: [...new Set(capabilityIds)],
      deviceAliases,
      scope: deviceAliases.length
        ? (capabilityIds.length ? "device_capability" : "device")
        : (capabilityIds.length ? "capability" : "app"),
    };
  });
}

/** Build the control-plane visual recovery envelope from trusted OCR blocks. */
export function buildRecoveryAnalysisEnvelope({ screenshot, blocksDocument } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(screenshot?.sha256 || ""))) {
    throw new Error("recovery screenshot sha256 is invalid");
  }
  const resolution = blocksDocument?.input?.sourceResolution;
  if (!Array.isArray(resolution) || resolution.length !== 2) {
    throw new Error("visual blocks source resolution is missing");
  }
  const elements = [];
  const seen = new Set();
  for (const block of (blocksDocument?.blocks || [])) {
    const label = String(block?.text || "").replace(/\s+/g, " ").trim();
    const box = block?.sourceBBox;
    if (!label || !Array.isArray(box) || box.length !== 4) continue;
    const [x, y, width, height] = box.map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const bounds = [x, y, x + width, y + height].map((value) => Math.round(value));
    const key = `${label}\u0000${bounds.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({
      id: String(block.blockId || `ocr-${elements.length + 1}`),
      label,
      bounds,
      conf: Number.isFinite(Number(block.ocrConfidence)) ? Number(block.ocrConfidence) : null,
      source: "visual-tap-resolver-ocr",
    });
  }
  return {
    schemaVersion: "xhs.visual-elements.v1",
    image: {
      sha256: screenshot.sha256,
      bytes: Number(screenshot.bytes) || undefined,
      resolution: resolution.map(Number),
    },
    analyzer: {
      name: "visual-tap-resolver-paddleocr",
      version: "xw-start-recovery.v1",
      timings: blocksDocument?.timingMs || {},
    },
    elements,
  };
}
