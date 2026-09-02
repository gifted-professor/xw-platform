// publish-envelope.mjs — pure XHS publish commit envelope (executable-plan W6, PUBLISH).
//
// `xhs.publish.commit-envelope.v1` is the tamper-evident binding that freezes the
// publish context at prepare time. The envelope binds:
//   prepareRunId + planHash + contentHash + screenshotHash
//   + deviceFingerprint + accountFingerprint + targetFingerprint + expiresAt
// under a canonical 64-hex hash. At approve time the handler re-derives the
// envelope from the CURRENT observed state and compares hashes; any drift
// (content edited, screenshot replaced, device/account swapped, target moved,
// envelope expired) => hash mismatch => fail-closed (NO publish). This is the
// plan's "漂移 fail-closed".
//
// The canonical hash mirrors the W1 canonical-v2 scheme: sha256 of the canonical
// JSON (object keys sorted, stable string), EXCLUDING the envelope's own hash +
// status (status mutates across the lifecycle; the hash is the immutable binding).
// Pure: no fs/net/device IO. node:crypto only (zero third-party).
import { createHash } from "node:crypto";

export const ENVELOPE_SCHEMA = "xhs.publish.commit-envelope.v1";
export const ENVELOPE_SCHEMA_VERSION = 1;

/** sha256 hex of a string, namespaced. */
function sha256Hex(s) {
  return createHash("sha256").update(String(s ?? "")).digest("hex");
}

/** Canonical JSON: sorted object keys, no whitespace, deterministic. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/**
 * The fields that define the envelope's identity. The hash binds EXACTLY these.
 * `envelopeHash` (the hash itself) and `status` are excluded — they are
 * bookkeeping that mutates across the lifecycle, not part of the frozen binding.
 */
const BINDING_FIELDS = [
  "schemaId", "schemaVersion",
  "prepareRunId", "planHash",
  "contentHash", "screenshotHash",
  "deviceFingerprint", "accountFingerprint", "targetFingerprint",
  "expiresAt",
];

/** sha256 of a content/screenshot blob, namespaced. */
export function contentHashOf(content) {
  return sha256Hex(`xw.xhs.publish.content:${String(content ?? "")}`);
}
export function screenshotHashOf(screenshot) {
  return sha256Hex(`xw.xhs.publish.screenshot:${String(screenshot ?? "")}`);
}

/**
 * Canonical envelope hash = sha256(canonicalJson of the binding fields only).
 * Excludes `envelopeHash` + `status`. Stable across field-order changes.
 */
export function canonicalEnvelopeHash(envelope) {
  const binding = {};
  for (const k of BINDING_FIELDS) binding[k] = envelope?.[k];
  return sha256Hex(`xw.xhs.publish.envelope:${canonicalJson(binding)}`);
}

/**
 * Build a frozen publish commit envelope. All binding fields are required (a
 * publish with a missing contentHash / deviceFingerprint / etc. is an incomplete
 * binding and must not be created — the plan's "唯一保留人工点" sits on top of a
 * COMPLETE, tamper-evident binding, not a partial one).
 *
 * @returns {object} frozen envelope with `envelopeHash` + `status:"pending"`.
 */
export function buildPublishEnvelope({
  prepareRunId,
  planHash,
  contentHash,
  screenshotHash,
  deviceFingerprint,
  accountFingerprint,
  targetFingerprint,
  expiresAt,
}) {
  const required = {
    prepareRunId, planHash, contentHash, screenshotHash,
    deviceFingerprint, accountFingerprint, targetFingerprint, expiresAt,
  };
  for (const [k, v] of Object.entries(required)) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new TypeError(`publish envelope missing binding field: ${k}`);
    }
  }
  const envelope = {
    schemaId: ENVELOPE_SCHEMA,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    prepareRunId, planHash, contentHash, screenshotHash,
    deviceFingerprint, accountFingerprint, targetFingerprint, expiresAt,
    envelopeHash: "", // placeholder; computed below
    status: "pending",
  };
  envelope.envelopeHash = canonicalEnvelopeHash(envelope);
  return Object.freeze(envelope);
}

/**
 * Re-verify an envelope's integrity: recompute the canonical hash from the
 * binding fields and compare to the stored `envelopeHash`. Any drift (a binding
 * field was mutated) => false. This is the drift detector the approve step runs
 * against the CURRENT observed state before releasing the one-tap publish.
 */
export function verifyEnvelopeIntegrity(envelope) {
  if (!envelope || typeof envelope.envelopeHash !== "string") return false;
  return canonicalEnvelopeHash(envelope) === envelope.envelopeHash;
}

/**
 * Compare a frozen envelope against a freshly-observed state and report the
 * first drifted binding field (for diagnostics + audit). Returns null if no
 * drift. The comparison is by the canonical sub-hash of each field so a field
 * is "drifted" only if its value actually changed, not if a sibling did.
 *
 * `observed` carries the raw current state: { content, screenshot,
 * deviceFingerprint, accountFingerprint, targetFingerprint, planHash }. The
 * content/screenshot are re-hashed; the fingerprints are compared directly.
 */
export function detectEnvelopeDrift(frozen, observed) {
  if (!frozen || !observed) return "missing-input";
  if (contentHashOf(observed.content) !== frozen.contentHash) return "content";
  if (screenshotHashOf(observed.screenshot) !== frozen.screenshotHash) return "screenshot";
  if (observed.deviceFingerprint !== frozen.deviceFingerprint) return "device";
  if (observed.accountFingerprint !== frozen.accountFingerprint) return "account";
  if (observed.targetFingerprint !== frozen.targetFingerprint) return "target";
  if (observed.planHash !== frozen.planHash) return "plan";
  return null;
}