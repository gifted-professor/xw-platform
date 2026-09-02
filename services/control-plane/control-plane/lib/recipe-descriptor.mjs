/**
 * recipe-descriptor.mjs — single canonical source for Recipe descriptor
 * hashing (F1 canonical hash migration, plan V2 §7).
 *
 * From `xhs.search.fixed@2` onward every consumer (Catalog, overlay, CP Runner,
 * promotion bridge, receipt) MUST compute the same canonical 64-hex descriptor
 * hash over byte-identical canonical JSON. This module is that single source.
 *
 * Legacy revisions (e.g. `@1`) keep their existing `rh_`+24 projection hash;
 * `recipe-interpreter.mjs#computeDescriptorHash` retains the legacy path for
 * specs without `descriptorHashScheme: "canonical-v2"`. Legacy receipts are
 * immutable evidence and are never rewritten.
 *
 * Hash scheme:
 *   canonical-v2 = sha256(canonicalJson(spec WITHOUT descriptorHash)).hex (64 hex)
 * This binds the FULL sealed spec (recipeId/revision/status/eligibleAliases/
 * executor/failurePolicy/deviceProfile/inputSchema/...) — a client cannot
 * silently mutate any sealed field, not just the executor projection.
 *
 * Zero deps beyond node:crypto. Imported by both the Catalog
 * (services/orchestrator/scripts/lib/recipe-catalog.mjs) and the CP Runner
 * (services/control-plane/control-plane/lib/recipe-interpreter.mjs) so the two
 * sides can never drift into two hash derivations.
 */
import { createHash } from "node:crypto";

export const DESCRIPTOR_HASH_SCHEME_V2 = "canonical-v2";

/**
 * Recursively sort object keys to produce a stable canonical form. Arrays keep
 * order. Used by both canonicalJson and the hash.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize(value[k])]),
    );
  }
  return value;
}

/** Stable JSON string of a value (sorted keys, recursively). */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Canonical 64-hex descriptor hash of a recipe spec: sha256 over the canonical
 * JSON of the spec with three non-sealed fields removed:
 *
 *   - `descriptorHash` — self-referential (this hash itself).
 *   - `status` — mutates across the promotion lifecycle (candidate ->
 *     replay_verified -> promotable -> canary_only -> implemented); including it
 *     would make the overlay (canary_only) hash differ from the Registry
 *     (candidate) hash, breaking the byte-identical invariant (plan V2 §7.4).
 *   - `originRunId` — provenance bookkeeping (which run first produced this
 *     candidate). The Catalog stores it both as a separate DB column and inside
 *     the spec JSON; the original hand-authored spec does not carry it. It is
 *     not an execution coordinate, so excluding it keeps a hand-authored spec
 *     and its ingested/stored/overlay copy byte-identical.
 *
 * Every execution-relevant sealed field (recipeId/revision/
 * eligibleAliases/executor/failurePolicy/restoration/deviceProfile/inputSchema/
 * descriptorHashScheme/...) participates and is immutable per revision — a
 * client cannot silently mutate any sealed coordinate or step.
 *
 * Input handling mirrors the legacy `descriptorHashOf` byte-for-byte (non-object
 * input hashes to canonicalJson({}) == "{}") so legacy @1 hashes that did not
 * carry `status`/`originRunId` are unaffected by this rule.
 * @param {object} spec
 * @returns {string} 64 lowercase hex chars
 */
export function canonicalDescriptorHash(spec) {
  const {
    descriptorHash: _omitHash,
    status: _omitStatus,
    originRunId: _omitOrigin,
    ...rest
  } = spec && typeof spec === "object" ? spec : {};
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/**
 * Whether a spec opts into the canonical-v2 hash scheme. Specs without the
 * marker (legacy revisions) use the old rh_ projection and are left untouched.
 */
export function isCanonicalV2(spec) {
  return spec?.descriptorHashScheme === DESCRIPTOR_HASH_SCHEME_V2;
}