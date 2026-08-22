// M6-2 W5 — the ONLY M6 live gate: an immutable, content-addressed epoch chain.
//
// `mode` accepts ONLY "CLOSED" and "OBSERVE_ONLY". There is no activation path
// in M6-2: epochs are operator-supplied immutable records and this module only
// *evaluates* them deterministically. Any missing/unknown/forged/expired/
// chain-broken/release-mismatched/lock-mismatched state fails closed to CLOSED.
// No ambient clock — the caller injects nowMs. Nothing here reads a device, a
// session, a lease, or the filesystem.
import { canonicalJson, sha256 } from "./canonical.mjs";
import { deriveM6AggregateSealHash } from "../../../../packages/kernel/lib/m6-aggregate-closeout.mjs";

export const M6_GATE_MODES = Object.freeze(["CLOSED", "OBSERVE_ONLY"]);
export const M6_GATE_MODE_FAIL_CLOSED = "CLOSED";
export const M6_GATE_MAX_EPOCHS = 64;
export const M6_GATE_LOCK_KINDS = Object.freeze(["runtimeProfile", "hardRedlinePolicy", "groundingRuntime"]);

// Canonical self-hash of one epoch record. Mirrors the frozen contract
// `deriveM6LiveGateEpochHash` exactly — including the hash prefix. The runtime
// previously prefixed `xw.m6-live-gate.v1:epoch:` while the contract used
// `xw.m6-live-gate.v1:`; the two derivations agreed on the strip (only the
// self-referential `epochHash` is removed, every other field — INCLUDING
// `closeoutRef` — is hashed, so the chain binding is total) and on
// canonicalization (`canonicalJson` ≡ the contract's `stableStringify`), but
// disagreed on the prefix, so a contract-minted epoch was rejected by the
// runtime as M6_GATE_EPOCH_FORGED and vice versa. The contract is canonical;
// the runtime now uses the SAME prefix `xw.m6-live-gate.v1:` so a
// schema-valid epoch derives the identical hash on both sides.
export function deriveM6EpochHash(epoch) {
  if (!epoch || typeof epoch !== "object") return null;
  const { epochHash: _ignored, ...payload } = epoch;
  return sha256(`xw.m6-live-gate.v1:${canonicalJson(payload)}`);
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
  const referencedSha = closeoutRef && typeof closeoutRef === "object" && !("closeoutHash" in closeoutRef)
    ? closeoutRef.sha256
    : null;
  if (!stored || stored !== derived || (referencedSha != null && referencedSha !== derived)) {
    return { ok: false, reason: "M6_GATE_CLOSEOUT_FORGED" };
  }
  return { ok: true, closeout: record };
}

export function resolveM6AggregateSeal(aggregateSealRef, aggregates = {}) {
  const id = typeof aggregateSealRef === "string" ? aggregateSealRef : aggregateSealRef?.id;
  const record = (aggregates && typeof aggregates === "object" && aggregates[id]) || null;
  if (!record || typeof record !== "object") return { ok: false, reason: "M6_GATE_AGGREGATE_MISSING" };
  const derived = deriveM6AggregateSealHash(record.sealPayload);
  if (!/^[0-9a-f]{64}$/.test(record.sealHash ?? "")) return { ok: false, reason: "M6_GATE_AGGREGATE_FORGED" };
  if (record.sealHash !== derived || aggregateSealRef?.sha256 !== derived) return { ok: false, reason: "M6_GATE_AGGREGATE_FORGED" };
  return { ok: true, aggregate: record };
}

// Deterministic, fail-closed evaluation of the epoch chain. The tail epoch is the
// active one; any invalid record anywhere in the chain fails the whole gate.
export function evaluateM6Gate({
  chain = [],
  closeouts = {},
  aggregates = {},
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
    // Status is coupled to mode, matching the frozen contract: a CLOSED epoch is
    // sealed (status=closed), an OBSERVE_ONLY epoch is active. Any other status
    // for a known mode fails closed — the runtime no longer requires every epoch
    // to be active, so a sealed CLOSED epoch may legitimately appear in a chain.
    if (epoch.mode === "CLOSED" && epoch.status !== "closed") {
      return reject("M6_GATE_EPOCH_NOT_CLOSED", `epoch ${i} CLOSED mode requires status=closed (got '${epoch.status}')`);
    }
    if (epoch.mode === "OBSERVE_ONLY" && epoch.status !== "active") {
      return reject("M6_GATE_EPOCH_NOT_ACTIVE", `epoch ${i} OBSERVE_ONLY mode requires status=active (got '${epoch.status}')`);
    }
    // A CLOSED epoch is sealed and must reference its closeout receipt (the seal
    // is resolved separately at the tail). An OBSERVE_ONLY epoch carries
    // closeoutRef=null while active; a seal on it closes the gate at the tail.
    if (epoch.mode === "CLOSED" && !epoch.closeoutRef) {
      return reject("M6_GATE_CLOSEOUT_FORGED", `epoch ${i} CLOSED mode must reference a closeout receipt`);
    }
    if (epoch.mode === "CLOSED" && !epoch.aggregateSealRef) {
      return reject("M6_GATE_AGGREGATE_FORGED", `epoch ${i} CLOSED mode must reference an aggregate seal`);
    }
    if (epoch.mode === "OBSERVE_ONLY" && (epoch.closeoutRef || epoch.aggregateSealRef || epoch.rollbackTargetEpochHash)) {
      return reject("M6_GATE_EPOCH_FORGED", `epoch ${i} OBSERVE_ONLY mode carries CLOSED-only bindings`);
    }
    if (epoch.mode === "CLOSED") {
      const closeout = resolveM6Closeout(epoch.closeoutRef, closeouts);
      const aggregate = resolveM6AggregateSeal(epoch.aggregateSealRef, aggregates);
      if (!closeout.ok) return reject("M6_GATE_CLOSEOUT_FORGED", `epoch ${i} closeout is missing or forged`);
      if (!aggregate.ok || aggregate.aggregate.epochHash !== closeout.closeout.epochHash) {
        return reject("M6_GATE_AGGREGATE_FORGED", `epoch ${i} aggregate seal is missing, forged, or bound to another observe epoch`);
      }
    }
    // Expiry is a required security-relevant field: a missing/invalid/expired
    // expiresAt fails closed. Absent expiry is NOT treated as "never expires".
    if (typeof epoch.expiresAt !== "string" || epoch.expiresAt === "") {
      return reject("M6_GATE_EXPIRED", `epoch ${i} expiresAt is missing`);
    }
    const exp = Date.parse(epoch.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs) {
      return reject("M6_GATE_EXPIRED", `epoch ${i} expired at ${epoch.expiresAt}`);
    }
    // Release binding is fail-closed: when the runtime pins a release, the epoch
    // MUST carry matching releaseId + sourceCommit. An absent field is drift,
    // not a pass — a required field cannot be skipped by omitting it.
    if (expectedRelease && typeof expectedRelease === "object") {
      if (epoch.releaseId !== expectedRelease.releaseId) {
        return reject("M6_GATE_RELEASE_MISMATCH", `epoch ${i} releaseId does not match the runtime release`);
      }
      if (epoch.sourceCommit !== expectedRelease.sourceCommit) {
        return reject("M6_GATE_RELEASE_MISMATCH", `epoch ${i} sourceCommit does not match the runtime release`);
      }
    }
    // Lock binding is fail-closed: when the runtime supplies lock hashes, the
    // epoch MUST carry lockHashes and every pinned kind MUST match exactly. A
    // null/absent epoch lock for a pinned runtime kind is drift, not a pass.
    if (lockHashes && typeof lockHashes === "object") {
      if (!epoch.lockHashes || typeof epoch.lockHashes !== "object") {
        return reject("M6_GATE_LOCK_MISMATCH", `epoch ${i} is missing lockHashes`);
      }
      for (const kind of M6_GATE_LOCK_KINDS) {
        if (lockHashes[kind] !== epoch.lockHashes[kind]) {
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
  // A CLOSED tail is already fully resolved above and therefore remains closed.
  if (activeEpoch.closeoutRef) {
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
