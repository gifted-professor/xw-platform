import { createHash } from "node:crypto";

const FAMILIES = ["app-launch", "app-switch", "search", "text-input", "scroll", "tab-back", "form-edit", "settings-nav"];
const FORBIDDEN = ["public", "social", "account", "security", "financial", "destructive", "settings-write", "draft", "unknown"];
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function deriveM64EffectBoundary(input) {
  const raw = { schemaId: "xw.m6-effect-boundary.v1", a03Mode: input?.a03Mode, testIdentityHash: input?.testIdentityHash, families: input?.families };
  return Object.freeze({ ...raw, boundaryHash: sha(`xw.m6-effect-boundary.v1:${canonical(raw)}`) });
}

export function validateM64EffectBoundary(boundary) {
  const errors = [];
  if (boundary?.schemaId !== "xw.m6-effect-boundary.v1" || boundary?.a03Mode !== "BOUNDED_READ_TRACE" || !/^[0-9a-f]{64}$/u.test(boundary?.testIdentityHash || "")) errors.push("M64_EFFECT_BOUNDARY_SCHEMA_INVALID");
  if (!Array.isArray(boundary?.families) || boundary.families.length !== 8 || new Set(boundary.families.map((entry) => entry.primaryFamily)).size !== 8
    || FAMILIES.some((family) => !boundary.families.some((entry) => entry.primaryFamily === family))) errors.push("M64_EFFECT_BOUNDARY_FAMILIES_INVALID");
  if (boundary?.families?.some((entry) => !/^[0-9a-f]{64}$/u.test(entry.oracleHash || "") || FORBIDDEN.some((effect) => !entry.forbiddenEffectClasses?.includes(effect))
    || !Array.isArray(entry.allowedBoundedReadTraces) || !Array.isArray(entry.resetObligations))) errors.push("M64_EFFECT_BOUNDARY_RULE_INVALID");
  if (deriveM64EffectBoundary(boundary).boundaryHash !== boundary?.boundaryHash) errors.push("M64_EFFECT_BOUNDARY_HASH_INVALID");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function verifyM64EffectObservation({ boundary, family, oracle, observedEffects, resetResults }) {
  const errors = [...validateM64EffectBoundary(boundary).errors];
  const rule = boundary?.families?.find((entry) => entry.primaryFamily === family);
  if (!rule || oracle?.selfDerived !== false || oracle?.oracleHash !== rule?.oracleHash || oracle?.stale === true) errors.push("M64_EFFECT_ORACLE_INVALID");
  for (const effect of observedEffects || []) {
    if (rule?.forbiddenEffectClasses.includes(effect.effectClass) || !rule?.allowedBoundedReadTraces.includes(effect.effectClass)) errors.push("M64_EFFECT_FORBIDDEN");
  }
  for (const obligation of rule?.resetObligations || []) if (resetResults?.[obligation] !== true) errors.push("M64_EFFECT_RESET_INCOMPLETE");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export const M6_4_EFFECT_FAMILIES = Object.freeze([...FAMILIES]);
export const M6_4_FORBIDDEN_EFFECT_CLASSES = Object.freeze([...FORBIDDEN]);
