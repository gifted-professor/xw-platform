// M6-2 W8 aggregate closeout oracle.
//
// A successful seal proves the pre-written 4-alias x 20-run matrix, not merely
// that one happy-path receipt exists for each alias. The verifier consumes two
// independently persisted inputs: the scenario manifest (the oracle frozen
// before capture) and a before/after control-plane resource snapshot. Every
// planned scenario must have exactly one receipt and closeout, its expected
// stable/unstable outcome must match, no action may be recorded, and resources
// must be zero before and after the window.
import { deriveFrameId, deriveFrameManifestSha256, sha256Hex } from "./m6-screen-frame.mjs";
import { stableStringify } from "./skill-runtime.mjs";

const CLOSEOUT_DOMAIN = "xw.m6-frame-capture.v1:closeout:";
const AGGREGATE_DOMAIN = "xw.m6-aggregate-closeout.v1:";
const SCENARIO_DOMAIN = "xw.m6-scenario-manifest.v1:";
const RESOURCE_DOMAIN = "xw.m6-resource-snapshot.v1:";
const HEX64 = /^[0-9a-f]{64}$/;
const RUNS_PER_ALIAS = 20;
const ALIAS_COUNT = 4;
const MATRIX_SIZE = RUNS_PER_ALIAS * ALIAS_COUNT;
const UNSTABLE_CODES = new Set([
  "M6_FRAME_A_B_MISMATCH",
  "M6_FRAME_FOCUS_PAIR_UNSTABLE",
  "M6_FRAME_FOCUS_UNSTABLE",
  "M6_OBSERVE_A_TO_B_SKEW",
  "M6_OBSERVE_B_TO_FOCUS_B_SKEW",
  "M6_FRAME_A_TO_B_SKEW",
  "M6_FRAME_B_TO_FOCUS_B_SKEW",
  "M6_FRAME_TTL_EXPIRING",
]);

function withoutHash(record, key) {
  if (!record || typeof record !== "object") return null;
  const { [key]: _ignored, ...payload } = record;
  return payload;
}

export function deriveM6ScenarioManifestSha256(manifest) {
  return sha256Hex(`${SCENARIO_DOMAIN}${stableStringify(withoutHash(manifest, "manifestSha256"))}`);
}

export function deriveM6ResourceSnapshotSha256(snapshot) {
  return sha256Hex(`${RESOURCE_DOMAIN}${stableStringify(withoutHash(snapshot, "snapshotSha256"))}`);
}

export function deriveM6AggregateSealHash(payload) {
  return sha256Hex(`${AGGREGATE_DOMAIN}${stableStringify(payload)}`);
}

export function deriveM6FrameCloseoutHash(closeout) {
  const payload = {
    closeoutId: closeout.closeoutId,
    attemptId: closeout.attemptId,
    epochHash: closeout.epochHash ?? null,
    runId: closeout.runId ?? null,
    jobId: closeout.jobId ?? null,
    sessionId: closeout.sessionId ?? null,
    leaseRef: closeout.leaseRef ?? null,
    actor: closeout.actor,
    reason: closeout.reason,
    committedAt: closeout.committedAt,
  };
  return sha256Hex(`${CLOSEOUT_DOMAIN}${stableStringify(payload)}`);
}

export function deriveM6CaptureReceiptSha256(receipt) {
  const { receiptSha256: _ignored, ...payload } = receipt || {};
  return sha256Hex(`xw.capture-attempt-receipt.v1:${stableStringify(payload)}`);
}

function pushError(errors, code, message) {
  errors.push({ code, message });
}

function isOpaqueRef(ref) {
  return ref && typeof ref.id === "string" && ref.id !== "" && HEX64.test(ref.sha256 ?? "");
}

function isCompleteStableFrame(frame) {
  if (!frame || frame.schemaId !== "xw.screen-frame.v1" || frame.mode !== "live_strict") return false;
  if (![frame.observationRef, frame.screenshotARef, frame.screenshotBRef, frame.dumpRef, frame.focusRef].every(isOpaqueRef)) return false;
  if (frame.screenshotASha256 !== frame.screenshotARef.sha256 || frame.screenshotBSha256 !== frame.screenshotBRef.sha256) return false;
  if (!Number.isInteger(frame.width) || frame.width < 1 || !Number.isInteger(frame.height) || frame.height < 1) return false;
  if (!Number.isFinite(frame.density) || frame.density <= 0 || !["portrait", "landscape"].includes(frame.orientation)) return false;
  if (!Number.isFinite(Date.parse(frame.capturedAt)) || !Number.isFinite(Date.parse(frame.expiresAt))) return false;
  if (!frame.linkage || ["sessionId", "leaseRef", "alias", "appId"].some((key) => typeof frame.linkage[key] !== "string" || frame.linkage[key] === "")) return false;
  if (frame.stability?.verdict !== "stable" || !HEX64.test(frame.stability.pageFingerprint ?? "") || !HEX64.test(frame.stability.focusFingerprint ?? "")) return false;
  return frame.flags?.partial === false && frame.flags?.missing === false;
}

function validateScenarioManifest(manifest, epoch, errors) {
  if (!manifest || typeof manifest !== "object" || manifest.schemaId !== "xw.m6-scenario-manifest.v1") {
    pushError(errors, "M6_AGGREGATE_SCENARIO_MANIFEST_REQUIRED", "a pre-written xw.m6-scenario-manifest.v1 is required");
    return [];
  }
  if (!HEX64.test(manifest.manifestSha256 ?? "") || deriveM6ScenarioManifestSha256(manifest) !== manifest.manifestSha256) {
    pushError(errors, "M6_AGGREGATE_SCENARIO_MANIFEST_FORGED", "scenario manifest hash does not re-derive");
  }
  if (manifest.epochHash !== epoch.epochHash) {
    pushError(errors, "M6_AGGREGATE_SCENARIO_EPOCH_MISMATCH", "scenario manifest does not bind to the active epoch");
  }
  if (manifest.runsPerAlias !== RUNS_PER_ALIAS) {
    pushError(errors, "M6_AGGREGATE_MATRIX_SIZE", `scenario manifest must declare ${RUNS_PER_ALIAS} runs per alias`);
  }
  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (scenarios.length !== MATRIX_SIZE) {
    pushError(errors, "M6_AGGREGATE_MATRIX_SIZE", `scenario manifest must contain exactly ${MATRIX_SIZE} scenarios`);
  }
  const allowlist = Array.isArray(epoch.allowlist) ? epoch.allowlist : [];
  if (allowlist.length !== ALIAS_COUNT) {
    pushError(errors, "M6_AGGREGATE_ALLOWLIST_INVALID", `epoch allowlist must contain exactly ${ALIAS_COUNT} aliases`);
  }
  const seenIds = new Set();
  const perAlias = new Map(allowlist.map((alias) => [alias, []]));
  for (const scenario of scenarios) {
    const id = scenario?.scenarioId;
    if (typeof id !== "string" || id === "" || seenIds.has(id)) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_DUPLICATE", `scenarioId '${id ?? ""}' is missing or duplicated`);
      continue;
    }
    seenIds.add(id);
    if (!perAlias.has(scenario.alias)) {
      pushError(errors, "M6_AGGREGATE_ALIAS_NOT_ALLOWED", `scenario '${id}' uses alias '${scenario.alias}' outside the epoch allowlist`);
      continue;
    }
    if (!Number.isInteger(scenario.ordinal) || scenario.ordinal < 1 || scenario.ordinal > RUNS_PER_ALIAS) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_INVALID", `scenario '${id}' ordinal must be 1..${RUNS_PER_ALIAS}`);
    }
    if (!["accepted", "rejected"].includes(scenario.expectedStatus)
      || !["stable", "unstable"].includes(scenario.expectedStability)) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_INVALID", `scenario '${id}' has an invalid expected outcome`);
    }
    if ((scenario.expectedStatus === "accepted") !== (scenario.expectedStability === "stable")) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_INVALID", `scenario '${id}' must map stable→accepted and unstable→rejected`);
    }
    if (scenario.zeroAction !== true) {
      pushError(errors, "M6_AGGREGATE_ACTION_NONZERO", `scenario '${id}' is not frozen as zero-action`);
    }
    perAlias.get(scenario.alias).push(scenario);
  }
  for (const [alias, entries] of perAlias) {
    if (entries.length !== RUNS_PER_ALIAS || new Set(entries.map((s) => s.ordinal)).size !== RUNS_PER_ALIAS) {
      pushError(errors, "M6_AGGREGATE_MATRIX_SIZE", `alias '${alias}' must have ordinals 1..${RUNS_PER_ALIAS}`);
    }
    if (!entries.some((s) => s.expectedStability === "stable") || !entries.some((s) => s.expectedStability === "unstable")) {
      pushError(errors, "M6_AGGREGATE_DISTRIBUTION_INVALID", `alias '${alias}' must freeze both stable and unstable scenarios`);
    }
  }
  return scenarios;
}

function validateResourceSnapshot(snapshot, epochHash, errors) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaId !== "xw.m6-resource-snapshot.v1") {
    pushError(errors, "M6_AGGREGATE_RESOURCE_SNAPSHOT_REQUIRED", "an independent xw.m6-resource-snapshot.v1 is required");
    return;
  }
  if (!HEX64.test(snapshot.snapshotSha256 ?? "") || deriveM6ResourceSnapshotSha256(snapshot) !== snapshot.snapshotSha256) {
    pushError(errors, "M6_AGGREGATE_RESOURCE_SNAPSHOT_FORGED", "resource snapshot hash does not re-derive");
  }
  if (snapshot.epochHash !== epochHash) {
    pushError(errors, "M6_AGGREGATE_RESOURCE_EPOCH_MISMATCH", "resource snapshot does not bind to the active epoch");
  }
  for (const point of ["before", "after"]) {
    const value = snapshot[point];
    for (const field of ["activeJobs", "activeSessions", "activeLeases"]) {
      if (!Number.isInteger(value?.[field]) || value[field] !== 0) {
        pushError(errors, "M6_AGGREGATE_RESOURCE_LEAK", `${point}.${field} must be exactly zero`);
      }
    }
  }
  if (!Number.isInteger(snapshot.actionCount) || snapshot.actionCount !== 0) {
    pushError(errors, "M6_AGGREGATE_ACTION_NONZERO", "independent snapshot actionCount must be exactly zero");
  }
}

export function verifyAggregateCloseout({ epoch, attempts, scenarioManifest, resourceSnapshot }) {
  const errors = [];
  if (!epoch || typeof epoch !== "object" || !HEX64.test(epoch.epochHash ?? "")) {
    return { ok: false, sealHash: null, aliases: [], attemptCount: 0, errors: [{ code: "M6_AGGREGATE_EPOCH_INVALID", message: "epoch with a 64-hex epochHash is required" }] };
  }
  const scenarios = validateScenarioManifest(scenarioManifest, epoch, errors);
  validateResourceSnapshot(resourceSnapshot, epoch.epochHash, errors);

  const byScenario = new Map();
  const seenAttempt = new Set();
  const seenRun = new Set();
  const seenJob = new Set();
  for (const att of Array.isArray(attempts) ? attempts : []) {
    const receipt = att?.receipt ?? null;
    const closeout = att?.closeout ?? null;
    if (receipt?.epochHash !== epoch.epochHash && closeout?.epochHash !== epoch.epochHash) continue;
    const attemptId = receipt?.attemptId ?? closeout?.attemptId ?? null;
    if (!attemptId || seenAttempt.has(attemptId)) {
      pushError(errors, "M6_AGGREGATE_ATTEMPT_DUPLICATE", `attemptId '${attemptId ?? ""}' is missing or duplicated`);
      continue;
    }
    seenAttempt.add(attemptId);
    const scenarioId = receipt?.scenarioLabel;
    if (typeof scenarioId !== "string" || scenarioId === "" || byScenario.has(scenarioId)) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_DUPLICATE", `scenario '${scenarioId ?? ""}' has no unique receipt`);
      continue;
    }
    byScenario.set(scenarioId, { receipt, closeout, frame: att?.frame ?? null });
    if (receipt?.epochHash !== epoch.epochHash) {
      pushError(errors, "M6_AGGREGATE_RECEIPT_EPOCH_MISMATCH", `receipt for scenario '${scenarioId}' is bound to another epoch`);
    }
    if (!HEX64.test(receipt?.receiptSha256 ?? "") || deriveM6CaptureReceiptSha256(receipt) !== receipt.receiptSha256) {
      pushError(errors, "M6_AGGREGATE_RECEIPT_FORGED", `receipt for scenario '${scenarioId}' hash does not re-derive`);
    }
    for (const [field, seen] of [["runId", seenRun], ["jobId", seenJob]]) {
      const value = receipt?.[field];
      if (typeof value !== "string" || value === "") {
        pushError(errors, "M6_AGGREGATE_ATTRIBUTION_MISSING", `${field} is required for scenario '${scenarioId}'`);
      } else if (seen.has(value)) {
        pushError(errors, `M6_AGGREGATE_${field === "runId" ? "RUN" : "JOB"}_DUPLICATE`, `${field} '${value}' is reused`);
      } else {
        seen.add(value);
      }
    }
  }

  const sealed = [];
  for (const scenario of scenarios) {
    const record = byScenario.get(scenario.scenarioId);
    if (!record) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_MISSING", `scenario '${scenario.scenarioId}' has no attempt`);
      continue;
    }
    const { receipt, closeout, frame } = record;
    if (receipt.alias !== scenario.alias) pushError(errors, "M6_AGGREGATE_SCENARIO_ALIAS_MISMATCH", `scenario '${scenario.scenarioId}' ran on '${receipt.alias}'`);
    if (receipt.status !== scenario.expectedStatus) pushError(errors, "M6_AGGREGATE_SCENARIO_OUTCOME_MISMATCH", `scenario '${scenario.scenarioId}' expected ${scenario.expectedStatus}, got ${receipt.status}`);
    if (!closeout) {
      pushError(errors, "M6_AGGREGATE_UNSEALED", `attempt '${receipt.attemptId}' has no closeout`);
      continue;
    }
    if (closeout.attemptId !== receipt.attemptId || closeout.epochHash !== epoch.epochHash
      || closeout.runId !== receipt.runId || closeout.jobId !== receipt.jobId
      || closeout.sessionId !== receipt.sessionId || closeout.leaseRef !== receipt.leaseRef) {
      pushError(errors, "M6_AGGREGATE_CLOSEOUT_MISMATCH", `closeout for '${receipt.attemptId}' has mismatched bindings`);
    }
    if (closeout.closeoutHash !== deriveM6FrameCloseoutHash(closeout)) {
      pushError(errors, "M6_AGGREGATE_CLOSEOUT_FORGED", `closeout '${closeout.closeoutId}' hash does not re-derive`);
    }
    if (scenario.expectedStability === "stable") {
      if (!isCompleteStableFrame(frame)) {
        pushError(errors, "M6_AGGREGATE_STABILITY_MISMATCH", `stable scenario '${scenario.scenarioId}' lacks a complete stable frame`);
      }
      const manifestSha256 = frame ? deriveFrameManifestSha256(frame) : null;
      if (!frame || frame.manifestSha256 !== manifestSha256 || frame.frameId !== deriveFrameId(manifestSha256)
        || receipt.frameRef?.id !== frame.frameId || receipt.frameRef?.sha256 !== frame.manifestSha256) {
        pushError(errors, "M6_AGGREGATE_FRAME_FORGED", `stable scenario '${scenario.scenarioId}' frame/receipt binding does not re-derive`);
      }
    } else if (!(Array.isArray(receipt.errorCodes) && receipt.errorCodes.some((code) => UNSTABLE_CODES.has(code)))) {
      pushError(errors, "M6_AGGREGATE_STABILITY_MISMATCH", `unstable scenario '${scenario.scenarioId}' lacks a recognized instability rejection`);
    } else if (frame !== null || receipt.frameRef !== null) {
      pushError(errors, "M6_AGGREGATE_REJECTED_FRAME_PRESENT", `unstable rejected scenario '${scenario.scenarioId}' retains a consumable frame`);
    }
    sealed.push({
      scenarioId: scenario.scenarioId,
      alias: scenario.alias,
      ordinal: scenario.ordinal,
      expectedStability: scenario.expectedStability,
      attemptId: receipt.attemptId,
      status: receipt.status,
      receiptSha256: receipt.receiptSha256 ?? null,
      closeoutId: closeout.closeoutId,
      closeoutHash: closeout.closeoutHash,
    });
  }
  for (const scenarioId of byScenario.keys()) {
    if (!scenarios.some((scenario) => scenario.scenarioId === scenarioId)) {
      pushError(errors, "M6_AGGREGATE_SCENARIO_UNPLANNED", `attempt for unplanned scenario '${scenarioId}' is present`);
    }
  }

  sealed.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  const sealPayload = {
    epochHash: epoch.epochHash,
    allowlist: [...epoch.allowlist].sort(),
    scenarioManifestSha256: scenarioManifest?.manifestSha256 ?? null,
    resourceSnapshotSha256: resourceSnapshot?.snapshotSha256 ?? null,
    attempts: sealed,
  };
  const sealHash = errors.length === 0 ? deriveM6AggregateSealHash(sealPayload) : null;
  return {
    ok: errors.length === 0,
    sealHash,
    sealPayload: errors.length === 0 ? sealPayload : null,
    aliases: [...new Set(sealed.map((item) => item.alias))].sort(),
    attemptCount: sealed.length,
    errors,
  };
}

export {
  AGGREGATE_DOMAIN,
  CLOSEOUT_DOMAIN,
  SCENARIO_DOMAIN,
  RESOURCE_DOMAIN,
  RUNS_PER_ALIAS,
  MATRIX_SIZE,
};
