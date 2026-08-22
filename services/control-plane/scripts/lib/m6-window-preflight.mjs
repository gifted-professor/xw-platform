// M6-2 W9 live window preflight arbiter — pure, no device I/O.
// A real window driver (kept as an operator artifact with the device serials
// out of the repo) feeds the frozen scenario manifest + a candidate epoch tag
// into this module to decide, before any capture, whether the window is legal
// to start. It never calls ADB, HTTP, or the control plane; the live host wires
// those side effects around it.
import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Derive the idempotency-key tag for a window. It must be the active epoch's
// 8-hex prefix, never a stale/hardcoded tag (a reused idempotency key would
// silently collide with a prior window's receipts). Reading the tag from the
// epoch hash keeps the key unique per window and forces an explicit re-mint.
export function deriveWindowTag(epochHash) {
  if (!/^[0-9a-f]{64}$/.test(epochHash ?? "")) {
    throw new Error(`window tag: epochHash must be 64-hex, got '${epochHash}'`);
  }
  return epochHash.slice(0, 8);
}

// Refuse a window tag that matches a retired/tombstoned epoch. The closeout
// plan forbids reusing any tombstoned epoch's idempotency keys or receipts.
export function refuseTombstonedTag(tag, tombstonedTags) {
  if (!tombstonedTags || !Array.isArray(tombstonedTags) || !tombstonedTags.includes(tag)) return null;
  return `window tag '${tag}' matches a tombstoned epoch (${tombstonedTags.join(", ")}); refusing to reuse its idempotency keys`;
}

// Decide whether a scenario may be attempted, given what the audit dir already
// holds for this epoch. A scenario lands exactly once — a pre-existing receipt
// for the same (epoch, alias, ordinal) is a duplicate and must refuse to run,
// not silently skip it.
export function classifyScenarioAttempt({ scenarioId, alias, ordinal, existing }) {
  if (existing) {
    const { attemptId, status, errorCodes } = existing;
    return {
      decision: "duplicate",
      reason: "already-landed",
      attemptId,
      status,
      errorCodes: errorCodes || null,
    };
  }
  return { decision: "run", ordinal };
}

// Given the manifest + the set of tombstoned tags, freeze the window's runtime
// invariants the driver must assert before opening: the epoch tag, the exact
// per-alias scenario distribution, and that every scenario is expected once.
export function freezeWindowPlan(manifest, { tombstonedTags = [] } = {}) {
  const epochHash = manifest?.epochHash;
  if (!/^[0-9a-f]{64}$/.test(epochHash ?? "")) {
    throw new Error("freezeWindowPlan: manifest.epochHash must be 64-hex");
  }
  const tag = deriveWindowTag(epochHash);
  const refuse = refuseTombstonedTag(tag, tombstonedTags);
  if (refuse) throw new Error(refuse);

  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  const seen = new Set();
  for (const s of scenarios) {
    const key = `${s.alias}:${s.ordinal}`;
    if (!s.scenarioId || seen.has(key)) {
      throw new Error(`freezeWindowPlan: duplicate scenario (alias:ordinal ${key})`);
    }
    seen.add(key);
  }
  const byAlias = {};
  for (const s of scenarios) (byAlias[s.alias] ||= []).push(s);
  const counts = Object.fromEntries(Object.entries(byAlias).map(([a, list]) => [a, list.length]));

  return {
    epochHash,
    tag,
    scenarioCount: scenarios.length,
    byAlias,
    counts,
    manifestSha256: sha256Hex(stableStringify({
      epochHash,
      scenarios: scenarios.map(({ scenarioId, alias, ordinal, expectedStatus }) => ({ scenarioId, alias, ordinal, expectedStatus })),
    })),
  };
}
