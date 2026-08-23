import assert from "node:assert/strict";
import test from "node:test";

import { deriveM64EffectBoundary, M6_4_EFFECT_FAMILIES, M6_4_FORBIDDEN_EFFECT_CLASSES, validateM64EffectBoundary, verifyM64EffectObservation } from "../lib/m6-effect-boundary.mjs";
import { createHash } from "node:crypto";

const H = (value) => createHash("sha256").update(value).digest("hex");
const boundary = deriveM64EffectBoundary({ a03Mode: "BOUNDED_READ_TRACE", testIdentityHash: H("isolated-test-identity"), families: M6_4_EFFECT_FAMILIES.map((primaryFamily) => ({ primaryFamily, oracleHash: H(`oracle:${primaryFamily}`), forbiddenEffectClasses: [...M6_4_FORBIDDEN_EFFECT_CLASSES], allowedBoundedReadTraces: primaryFamily === "search" ? ["private-search-history"] : [], resetObligations: primaryFamily === "search" ? ["clear-private-search-history"] : [] })) });

test("effect boundary covers all eight families and is content addressed", () => assert.deepEqual(validateM64EffectBoundary(boundary), { ok: true, errors: [] }));

test("independent oracle, enumerated traces, forbidden effects and reset results fail closed", () => {
  const oracle = { oracleHash: H("oracle:search"), selfDerived: false, stale: false };
  assert.equal(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [{ effectClass: "private-search-history" }], resetResults: { "clear-private-search-history": true } }).ok, true);
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle: { ...oracle, selfDerived: true }, observedEffects: [], resetResults: {} }).errors.includes("M64_EFFECT_ORACLE_INVALID"));
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [{ effectClass: "social" }], resetResults: { "clear-private-search-history": true } }).errors.includes("M64_EFFECT_FORBIDDEN"));
  assert.ok(verifyM64EffectObservation({ boundary, family: "search", oracle, observedEffects: [], resetResults: {} }).errors.includes("M64_EFFECT_RESET_INCOMPLETE"));
});
