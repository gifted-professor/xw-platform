// M6-2 W8 #5 — four-alias aggregate closeout verifier (pure, shared).
//
// A frame-capture epoch opens an OBSERVE window over an allowlist of device
// aliases. Each accepted capture is sealed per-attempt by the facade's
// `closeout()` (audit-root `<attemptId>.closeout.json`, domain
// `xw.m6-frame-capture.v1:closeout`). This module is the AGGREGATE layer: given
// the active epoch + the set of per-attempt audit records, it proves the whole
// window sealed cleanly and mints a deterministic aggregate seal.
//
// Pure — no device/DB/network/fs. The CLI (packages/cli) loads the epoch +
// audit records and calls this; control-plane may also call it directly. The
// closeout hash is RE-DERIVED here (never accepted from the record), using the
// SAME canonicalization the facade used to mint it (stableStringify sorts keys
// recursively, byte-identical to control-plane's canonicalJson), so a facade-
// minted closeout re-hashes identically and a tampered one fails.
//
// Rules:
//  (1) every alias in epoch.allowlist has exactly one ACCEPTED capture for this
//      epoch (status==="accepted", alias matches, epochHash binds);
//  (2) every accepted attempt has exactly one matching closeout
//      (closeout.attemptId===receipt.attemptId, closeout.epochHash binds);
//  (3) every closeout's closeoutHash re-derives (no tamper);
//  (4) attemptId / runId / jobId are distinct across the accepted set
//      (no replayed attribution);
//  (5) no attempt for this epoch remains unsealed — a rejected attempt without
//      a closeout is a leak (accepted captures must also be sealed);
//  (6) a closeout with no matching receipt for this epoch is an orphan (drift).
// On success, the aggregate seal is sha256 over the sorted accepted-closeout
// set (domain xw.m6-aggregate-closeout.v1:).
import { sha256Hex } from "./m6-screen-frame.mjs";
import { stableStringify } from "./skill-runtime.mjs";

const CLOSEOUT_DOMAIN = "xw.m6-frame-capture.v1:closeout:";
const AGGREGATE_DOMAIN = "xw.m6-aggregate-closeout.v1:";

// Re-derive a frame-capture closeout hash. The hashed payload is the closeout
// MINUS closeoutHash, in the same field set + canonical form the facade used.
// stableStringify (sorted keys) is byte-identical to the facade's canonicalJson.
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

function pushError(errors, code, message) {
  errors.push({ code, message });
}

// attempts: [{ receipt, closeout }] where receipt may be null (orphan closeout)
// and closeout may be null (unsealed attempt). Both are optional independently.
// epoch: the active OBSERVE_ONLY epoch record (must carry epochHash + allowlist).
export function verifyAggregateCloseout({ epoch, attempts }) {
  const errors = [];
  if (!epoch || typeof epoch !== "object" || typeof epoch.epochHash !== "string") {
    return { ok: false, sealHash: null, aliases: [], errors: [{ code: "M6_AGGREGATE_EPOCH_INVALID", message: "epoch with a 64-hex epochHash is required" }] };
  }
  const epochHash = epoch.epochHash;
  const allowlist = Array.isArray(epoch.allowlist) ? epoch.allowlist : [];
  if (allowlist.length === 0) pushError(errors, "M6_AGGREGATE_ALLOWLIST_INVALID", "epoch allowlist is empty");

  // Index attempts by attemptId; detect duplicates + missing ids.
  const byAttempt = new Map();
  const list = Array.isArray(attempts) ? attempts : [];
  for (const att of list) {
    if (!att || typeof att !== "object") continue;
    const receipt = att.receipt || null;
    const closeout = att.closeout || null;
    const attemptId = (receipt && receipt.attemptId) || (closeout && closeout.attemptId) || null;
    if (!attemptId) {
      pushError(errors, "M6_AGGREGATE_ATTEMPT_INVALID", "an attempt record has no attemptId");
      continue;
    }
    if (byAttempt.has(attemptId)) {
      pushError(errors, "M6_AGGREGATE_ATTEMPT_DUPLICATE", `attemptId '${attemptId}' appears more than once`);
      continue;
    }
    byAttempt.set(attemptId, { receipt, closeout });
  }

  // Does an attempt belong to THIS epoch? Bind by receipt.epochHash first, then
  // closeout.epochHash. An attempt with neither binding to this epoch is from a
  // different (or null-epoch) window and is ignored for this aggregate.
  function belongsToEpoch({ receipt, closeout }) {
    if (receipt && typeof receipt.epochHash === "string") return receipt.epochHash === epochHash;
    if (closeout && typeof closeout.epochHash === "string") return closeout.epochHash === epochHash;
    return false;
  }

  const accepted = []; // { attemptId, alias, closeout }
  const seenRun = new Set();
  const seenJob = new Set();
  const acceptedByAlias = new Map();

  for (const [attemptId, { receipt, closeout }] of byAttempt) {
    const inEpoch = belongsToEpoch({ receipt, closeout });
    if (!inEpoch) {
      // A closeout binding to this epoch with no matching receipt is an orphan.
      if (closeout && closeout.epochHash === epochHash && (!receipt || receipt.epochHash !== epochHash)) {
        pushError(errors, "M6_AGGREGATE_CLOSEOUT_ORPHAN", `closeout '${closeout.closeoutId}' binds to this epoch but has no matching receipt (attempt ${attemptId})`);
      }
      continue;
    }

    const status = receipt ? receipt.status : null;

    // Rule (5): every attempt for this epoch must be sealed (accepted or rejected).
    if (!closeout) {
      pushError(errors, "M6_AGGREGATE_UNSEALED", `attempt '${attemptId}' for this epoch has no closeout (unsealed)`);
    } else {
      if (closeout.attemptId !== attemptId) {
        pushError(errors, "M6_AGGREGATE_CLOSEOUT_MISMATCH", `closeout for attempt '${attemptId}' is bound to '${closeout.attemptId}'`);
      }
      if (closeout.epochHash != null && closeout.epochHash !== epochHash) {
        pushError(errors, "M6_AGGREGATE_CLOSEOUT_EPOCH_MISMATCH", `closeout '${closeout.closeoutId}' binds to a different epoch`);
      }
      // Rule (3): closeoutHash must re-derive.
      const derived = deriveM6FrameCloseoutHash(closeout);
      if (closeout.closeoutHash !== derived) {
        pushError(errors, "M6_AGGREGATE_CLOSEOUT_FORGED", `closeout '${closeout.closeoutId}' closeoutHash does not re-derive (tampered)`);
      }
    }

    if (status === "accepted") {
      const alias = receipt ? receipt.alias : null;
      if (!alias) {
        pushError(errors, "M6_AGGREGATE_RECEIPT_INVALID", `accepted attempt '${attemptId}' has no alias`);
        continue;
      }
      if (acceptedByAlias.has(alias)) {
        pushError(errors, "M6_AGGREGATE_ALIAS_DUPLICATE", `alias '${alias}' has more than one accepted capture`);
        continue;
      }
      acceptedByAlias.set(alias, attemptId);
      // Rule (4): runId/jobId distinct across the accepted set (non-null only).
      const runId = receipt ? receipt.runId ?? null : null;
      const jobId = receipt ? receipt.jobId ?? null : null;
      if (runId != null) {
        if (seenRun.has(runId)) pushError(errors, "M6_AGGREGATE_RUN_DUPLICATE", `runId '${runId}' shared across accepted attempts`);
        seenRun.add(runId);
      }
      if (jobId != null) {
        if (seenJob.has(jobId)) pushError(errors, "M6_AGGREGATE_JOB_DUPLICATE", `jobId '${jobId}' shared across accepted attempts`);
        seenJob.add(jobId);
      }
      accepted.push({ attemptId, alias, closeout });
    } else if (status === "rejected") {
      // Rule (5): a rejected attempt is sealed by its closeout (recorded above if
      // missing). Rejected attempts do NOT count toward alias coverage.
    } else if (status != null) {
      pushError(errors, "M6_AGGREGATE_RECEIPT_INVALID", `attempt '${attemptId}' has unknown status '${status}'`);
    } else {
      pushError(errors, "M6_AGGREGATE_RECEIPT_INVALID", `attempt '${attemptId}' is in-epoch but has no receipt`);
    }
  }

  // Rule (1): every allowlist alias has exactly one accepted capture.
  const acceptedAliases = new Set(acceptedByAlias.keys());
  for (const alias of allowlist) {
    if (!acceptedAliases.has(alias)) {
      pushError(errors, "M6_AGGREGATE_ALIAS_MISSING", `alias '${alias}' has no accepted capture for this epoch`);
    }
  }
  // Extra accepted aliases not in the allowlist are a drift signal.
  for (const alias of acceptedAliases) {
    if (!allowlist.includes(alias)) {
      pushError(errors, "M6_AGGREGATE_ALIAS_NOT_ALLOWED", `accepted alias '${alias}' is not in the epoch allowlist`);
    }
  }

  // Rule (6) aggregate seal: deterministic hash over the sorted accepted set.
  const sortedAccepted = accepted.slice().sort((x, y) => (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0));
  const sealPayload = {
    epochHash,
    allowlist: allowlist.slice().sort(),
    closeouts: sortedAccepted.map((a) => ({
      alias: a.alias,
      attemptId: a.attemptId,
      closeoutId: a.closeout ? a.closeout.closeoutId : null,
      closeoutHash: a.closeout ? a.closeout.closeoutHash : null,
    })),
  };
  const sealHash = errors.length === 0 ? sha256Hex(`${AGGREGATE_DOMAIN}${stableStringify(sealPayload)}`) : null;

  return {
    ok: errors.length === 0,
    sealHash,
    aliases: sortedAccepted.map((a) => a.alias),
    errors,
  };
}

export { AGGREGATE_DOMAIN, CLOSEOUT_DOMAIN };