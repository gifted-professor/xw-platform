// M6-2 W5 — the ONLY M6 live gate: an immutable, content-addressed epoch chain.
//
// `mode` accepts ONLY "CLOSED" and "OBSERVE_ONLY". There is no activation path
// in M6-2: epochs are operator-supplied immutable records and this module only
// *evaluates* them deterministically. Any missing/unknown/forged/expired/
// chain-broken/release-mismatched/lock-mismatched state fails closed to CLOSED.
// No ambient clock — the caller injects nowMs. Nothing here reads a device, a
// session, a lease, or the filesystem.
import { canonicalJson, sha256 } from "./canonical.mjs";

export const M6_GATE_MODES = Object.freeze(["CLOSED", "OBSERVE_ONLY"]);
export const M6_GATE_MODE_FAIL_CLOSED = "CLOSED";
export const M6_GATE_MAX_EPOCHS = 64;
export const M6_GATE_LOCK_KINDS = Object.freeze(["runtimeProfile", "hardRedlinePolicy", "groundingRuntime"]);

// Canonical self-hash of one epoch record. `epochHash` and `closeoutRef` are NOT
// derivation inputs: epochHash is the stored value we verify against the derived
// hash (a forged epoch fails), and closeoutRef is a seal verified separately.
export function deriveM6EpochHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const payload = {
    schemaId: epoch.schemaId ?? null,
    gateId: epoch.gateId ?? null,
    mode: epoch.mode ?? null,
    status: epoch.status ?? null,
    releaseId: epoch.releaseId ?? null,
    sourceCommit: epoch.sourceCommit ?? null,
    actor: epoch.actor ?? null,
    lockHashes: epoch.lockHashes ?? null,
    allowlist: epoch.allowlist ?? null,
    issuedAt: epoch.issuedAt ?? null,
    expiresAt: epoch.expiresAt ?? null,
    parentEpochHash: epoch.parentEpochHash ?? null,
  };
  return sha256(`xw.m6-live-gate.v1:epoch:${canonicalJson(payload)}`);
}

// Canonical self-hash of one closeout record. A closeout seals exactly one epoch;
// a forged closeout (bad self-hash, missing epoch binding) fails the chain.
export function deriveM6CloseoutHash(closeout) {
  if (!closeout || typeof closeout !== "object") return null;
  const payload = {
    closeoutId: closeout.closeoutId ?? null,
    epochHash: closeout.epochHash ?? null,
    actor: closeout.actor ?? null,
    reason: closeout.reason ?? null,
    committedAt: closeout.committedAt ?? null,
  };
  return sha256(`xw.m6-live-gate.v1:closeout:${canonicalJson(payload)}`);
}

function gateResult({ mode = M6_GATE_MODE_FAIL_CLOSED, activeEpochHash = null, activeEpoch = null, errors = [] }) {
  return { mode, activeEpochHash, activeEpoch, errors };
}

function reject(code, message) {
  return gateResult({ errors: [{ code, message }] });
}

// Resolve a closeoutRef against the closeouts registry. The ref is either a bare
// record or { id, sha256 }; the record must self-hash and bind to the epoch.
export function resolveM6Closeout(closeoutRef, closeouts = {}) {
  const id = typeof closeoutRef === "string" ? closeoutRef : closeoutRef?.id;
  const record = (closeouts && typeof closeouts === "object" && closeouts[id]) || closeoutRef || null;
  if (!record || typeof record !== "object") return { ok: false, reason: "M6_GATE_CLOSEOUT_MISSING" };
  const stored = typeof record.closeoutHash === "string" ? record.closeoutHash : record.sha256 || null;
  const derived = deriveM6CloseoutHash(record);
  if (!stored || stored !== derived) return { ok: false, reason: "M6_GATE_CLOSEOUT_FORGED" };
  return { ok: true, closeout: record };
}

// Deterministic, fail-closed evaluation of the epoch chain. The tail epoch is the
// active one; any invalid record anywhere in the chain fails the whole gate.
export function evaluateM6Gate({
  chain = [],
  closeouts = {},
  nowMs,
  expectedRelease = null, // { releaseId, sourceCommit } — drift fails closed
  lockHashes = null,      // { runtimeProfile, hardRedlinePolicy, groundingRuntime }
} = {}) {
  if (!Number.isFinite(nowMs)) return reject("M6_GATE_CLOCK_INVALID", "gate evaluation requires an injected nowMs");
  if (!Array.isArray(chain) || chain.length === 0) {
    return reject("M6_GATE_EMPTY", "no gate epoch records — gate fails closed");
  }
  if (chain.length > M6_GATE_MAX_EPOCHS) {
    return reject("M6_GATE_CHAIN_TOO_LONG", `epoch chain exceeds ${M6_GATE_MAX_EPOCHS} records`);
  }
  const seen = new Set();
  let previousHash = null;
  for (let i = 0; i < chain.length; i += 1) {
    const epoch = chain[i];
    if (!epoch || typeof epoch !== "object") return reject("M6_GATE_EPOCH_INVALID", `epoch ${i} is not a record`);
    const derived = deriveM6EpochHash(epoch);
    if (typeof epoch.epochHash !== "string" || epoch.epochHash !== derived) {
      return reject("M6_GATE_EPOCH_FORGED", `epoch ${i} self-hash does not match its payload`);
    }
    if (seen.has(epoch.epochHash)) return reject("M6_GATE_EPOCH_DUPLICATE", `epoch ${i} repeats a prior hash`);
    seen.add(epoch.epochHash);
    if (i === 0) {
      if (epoch.parentEpochHash !== null && epoch.parentEpochHash !== undefined && epoch.parentEpochHash !== "") {
        return reject("M6_GATE_ROOT_PARENT_MISMATCH", "the root epoch must have no parent");
      }
    } else if (epoch.parentEpochHash !== previousHash) {
      return reject("M6_GATE_PARENT_MISMATCH", `epoch ${i} does not bind to its predecessor`);
    }
    if (!M6_GATE_MODES.includes(epoch.mode)) {
      return reject("M6_GATE_MODE_INVALID", `epoch ${i} mode '${epoch.mode}' is not a known mode`);
    }
    if (epoch.status !== "active") {
      return reject("M6_GATE_EPOCH_NOT_ACTIVE", `epoch ${i} status '${epoch.status}' is not active`);
    }
    if (typeof epoch.expiresAt === "string" && epoch.expiresAt !== "") {
      const exp = Date.parse(epoch.expiresAt);
      if (!Number.isFinite(exp) || exp <= nowMs) {
        return reject("M6_GATE_EXPIRED", `epoch ${i} expired at ${epoch.expiresAt}`);
      }
    }
    if (expectedRelease && typeof expectedRelease === "object") {
      if (epoch.releaseId && expectedRelease.releaseId && epoch.releaseId !== expectedRelease.releaseId) {
        return reject("M6_GATE_RELEASE_MISMATCH", `epoch ${i} releaseId does not match the runtime release`);
      }
      if (epoch.sourceCommit && expectedRelease.sourceCommit && epoch.sourceCommit !== expectedRelease.sourceCommit) {
        return reject("M6_GATE_RELEASE_MISMATCH", `epoch ${i} sourceCommit does not match the runtime release`);
      }
    }
    if (lockHashes && typeof lockHashes === "object" && epoch.lockHashes && typeof epoch.lockHashes === "object") {
      for (const kind of M6_GATE_LOCK_KINDS) {
        const expected = lockHashes[kind];
        const stored = epoch.lockHashes[kind];
        if (expected && stored && expected !== stored) {
          return reject("M6_GATE_LOCK_MISMATCH", `epoch ${i} ${kind} lock hash does not match the runtime`);
        }
      }
    }
    if (!Array.isArray(epoch.allowlist) || epoch.allowlist.length === 0
      || epoch.allowlist.some((entry) => typeof entry !== "string" || entry === "")) {
      return reject("M6_GATE_ALLOWLIST_INVALID", `epoch ${i} allowlist is missing or invalid`);
    }
    if (typeof epoch.issuedAt === "string" && epoch.issuedAt !== "" && !Number.isFinite(Date.parse(epoch.issuedAt))) {
      return reject("M6_GATE_ISSUED_AT_INVALID", `epoch ${i} issuedAt is not a valid date-time`);
    }
    previousHash = epoch.epochHash;
  }
  const activeEpoch = chain[chain.length - 1];
  // A sealed epoch (valid closeout) is closed regardless of its declared mode.
  if (activeEpoch.closeoutRef) {
    const seal = resolveM6Closeout(activeEpoch.closeoutRef, closeouts);
    if (!seal.ok) {
      return gateResult({
        activeEpochHash: activeEpoch.epochHash,
        activeEpoch,
        errors: [{ code: "M6_GATE_CLOSEOUT_FORGED", message: "active epoch closeout is missing or forged" }],
      });
    }
    return gateResult({ activeEpochHash: activeEpoch.epochHash, activeEpoch });
  }
  const mode = activeEpoch.mode === "OBSERVE_ONLY" ? "OBSERVE_ONLY" : M6_GATE_MODE_FAIL_CLOSED;
  return gateResult({ mode, activeEpochHash: activeEpoch.epochHash, activeEpoch });
}

// Allowlist membership test. The alias is a server-resolved handle only — it is
// never a device id, session id, token, or coordinate.
export function m6AliasAllowed(alias, epoch) {
  if (typeof alias !== "string" || alias === "") return false;
  return Array.isArray(epoch?.allowlist) && epoch.allowlist.includes(alias);
}
