import { evaluateMissionEffect, targetFingerprint } from "./mission-policy.mjs";

export const SNAPSHOT_MAX_AGE_MS = 5000;

// Observed-surface categories. The classifier must emit at least these. Risk is decided by
// the observed surface (authoritative, from the fresh snapshot/parser), NOT by the primitive
// type or the agent-declared intent. declaredIntent is an untrusted hint only.
const SURFACE_INFO = {
  navigation: { risk: "R0", kind: "reversible" },
  observation: { risk: "R0", kind: "reversible" },
  // REX Phase 5 B3 refinement: the four financial surfaces from the page classifier (plan §2.1).
  // observe/prepare never move money → reversible. commit_candidate pauses only the gesture.
  // financial_commit is the sole PHC — identical to the legacy coarse payment surface.
  financial_observe: { risk: "R0", kind: "reversible" },
  financial_prepare: { risk: "R1", kind: "reversible" },
  financial_commit_candidate: { risk: "R2", kind: "payment-candidate" },
  financial_commit: { risk: "R3", kind: "payment" },
  "social-effect": { risk: "R2", kind: "social" },
  publish: { risk: "R3", kind: "protected" },
  delete: { risk: "R3", kind: "protected" },
  payment: { risk: "R3", kind: "payment" },
  "risk-control": { risk: "R3", kind: "stop" },
  login: { risk: "R3", kind: "stop" },
  captcha: { risk: "R3", kind: "stop" },
  unknown: { risk: "R3", kind: "unknown" },
};

const REVERSIBLE_SURFACES = new Set(["navigation", "observation"]);
const REVERSIBLE_INTENTS = new Set(["screenshot", "dump", "launch", "back", "home", "navigate", "navigation", "observation"]);
const STOP_SURFACES = new Set(["risk-control", "login", "captcha"]);

// REX Phase 5 (P5a): financial signals used to decide whether an "unknown" surface sits
// adjacent to a payment control. If so, unknown must stay fail-closed even under nonpayment_v1 —
// never let "unknown" become a bypass around the payment gate.
const FINANCIAL_SURFACE_RE = /pay|payment|wallet|checkout|recharge|transfer|deposit|redpacket|topup|付|支付|钱包|收款|转账|充值|红包|下单|购买/i;

function paymentAdjacentToUnknown(snapshot, input) {
  if (snapshot?.paymentContext === true || snapshot?.financialSignal === true) return true;
  const text = [snapshot?.text, snapshot?.label, snapshot?.contentDesc, snapshot?.surface,
    input?.declaredTarget, input?.observedTargetFingerprint, input?.target]
    .filter((x) => typeof x === "string")
    .join(" ");
  return FINANCIAL_SURFACE_RE.test(text);
}

const DECLARED_INTENT_RISK = {
  screenshot: "R0", dump: "R0", launch: "R0", back: "R0", home: "R0",
  navigate: "R0", navigation: "R0", observation: "R0",
  follow: "R2", like: "R2", collect: "R2", comment: "R2", dm: "R2",
  publish: "R3", delete: "R3", payment: "R3",
};

const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };

function maxRisk(a, b) {
  const ra = RISK_RANK[a] ?? 0;
  const rb = RISK_RANK[b] ?? 0;
  for (const [key, rank] of Object.entries(RISK_RANK)) {
    if (rank === Math.max(ra, rb)) return key;
  }
  return a;
}

function effectActionFor(surface, input) {
  if (surface === "social-effect") return input.snapshot?.effectAction || input.declaredIntent || null;
  if (surface === "payment" || surface === "financial_commit") return "payment";
  if (surface === "publish") return "publish";
  if (surface === "delete") return "delete";
  return null;
}

// The Effect Firewall resolves an effect-intent envelope against an immutable Mission and a
// fresh observed surface. It returns { code, decision, surface, reason, risk, effectAction? }.
// decision ∈ { auto, ecp, phc, blocked }. A raw tap landing on publish/payment is forced through
// ECP/PHC; raw tap cannot bypass payment or the Protected Human Commit.
export class EffectFirewall {
  constructor({ maxAgeMs = SNAPSHOT_MAX_AGE_MS, now = Date.now } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  classify(input, mission, { profile = "production", now = this.now, maxAgeMs = this.maxAgeMs, policyMode = null } = {}) {
    // REX Phase 5 (P5a): nonpayment_v1 (policyMode.active) relaxes unknown / stale / intent-
    // mismatch from hard block to automatic re-observe (debt). Default null = legacy, behavior
    // byte-for-byte unchanged. payment / stop / publish / delete never relax.
    const nonpayment = policyMode && policyMode.active === true;
    const declaredTarget = input?.declaredTarget ?? null;
    const observedTarget = input?.observedTargetFingerprint ?? null;

    // 1. Target binding: the parser-observed fingerprint is the bound target. The agent-declared
    //    target must agree or be absent; it is never trusted as the bound target by itself.
    if (declaredTarget !== null && observedTarget !== null && declaredTarget !== observedTarget) {
      return { code: "TARGET_MISMATCH", decision: "blocked", surface: null, reason: "DECLARED_TARGET_NOT_OBSERVED" };
    }

    const snapshot = input?.snapshot;
    const surface = snapshot?.surface ?? null;

    // 2. Snapshot freshness: both createdAt and observedAt must be present and within maxAgeMs.
    if (!snapshot || snapshot.createdAt === undefined || snapshot.observedAt === undefined) {
      // Missing timestamp is a data-contract violation; it is NOT relaxed to debt under any mode.
      return { code: "SNAPSHOT_STALE", decision: "blocked", surface, reason: "SNAPSHOT_MISSING_TIMESTAMP" };
    }
    const createdMs = Date.parse(snapshot.createdAt);
    const observedMs = Date.parse(snapshot.observedAt);
    const createdAge = now() - createdMs;
    const observedAge = now() - observedMs;
    if (!Number.isFinite(createdMs) || !Number.isFinite(observedMs)
      || createdAge > maxAgeMs || observedAge > maxAgeMs) {
      const reason = (!Number.isFinite(createdMs) || createdAge > maxAgeMs) ? "CREATED_STALE" : "OBSERVED_STALE";
      // Only relax "has valid timestamps but stale". Malformed timestamps (NaN) stay fail-closed.
      if (nonpayment && Number.isFinite(createdMs) && Number.isFinite(observedMs)) {
        return { code: "SNAPSHOT_STALE", decision: "reobserve", surface, reason, risk: "R3", debt: true };
      }
      return { code: "SNAPSHOT_STALE", decision: "blocked", surface, reason };
    }

    // 3. Surface classification: unknown/unlisted surfaces fail closed in production.
    const info = SURFACE_INFO[surface];
    if (!info || surface === "unknown") {
      // nonpayment_v1 re-observes an unknown surface UNLESS it sits adjacent to a payment control.
      if (nonpayment && !paymentAdjacentToUnknown(snapshot, input)) {
        return { code: "SURFACE_UNKNOWN", decision: "reobserve", surface, reason: "UNCLASSIFIED_SURFACE_REOBSERVE", risk: "R3", debt: true };
      }
      return { code: "SURFACE_UNKNOWN", decision: "blocked", surface, reason: "UNCLASSIFIED_SURFACE" };
    }

    const declaredIntent = input?.declaredIntent ?? null;

    // 4. Intent/surface consistency: a declared reversible intent on a non-reversible surface
    //    is an intent mismatch (e.g. "navigate" while the surface is publish). nonpayment_v1
    //    re-observes instead of blocking; the re-look itself still fail-closes on payment.
    if (declaredIntent && REVERSIBLE_INTENTS.has(declaredIntent) && !REVERSIBLE_SURFACES.has(surface)) {
      if (nonpayment) {
        return { code: "INTENT_MISMATCH", decision: "reobserve", surface, reason: "REVERSIBLE_INTENT_ON_EFFECT_SURFACE", risk: "R3", debt: true };
      }
      return { code: "INTENT_MISMATCH", decision: "blocked", surface, reason: "REVERSIBLE_INTENT_ON_EFFECT_SURFACE" };
    }

    const boundTarget = observedTarget ?? targetFingerprint(input?.target);
    const risk = maxRisk(DECLARED_INTENT_RISK[declaredIntent], info.risk);

    // 5. REX Phase 5 B3 refinement: financial observe/prepare never move money → reversible
    //    auto in EVERY mode (they are observation/preparation, not commit). commit_candidate
    //    pauses only that candidate gesture and re-observes — it is NOT the PHC gate.
    if (surface === "financial_observe" || surface === "financial_prepare") {
      return { code: "FINANCIAL_RECON_REVERSIBLE", decision: "auto", surface, reason: "FINANCIAL_OBSERVE_OR_PREPARE", risk };
    }
    if (surface === "financial_commit_candidate") {
      return { code: "FINANCIAL_CANDIDATE_REOBSERVE", decision: "reobserve", surface, reason: "FINANCIAL_COMMIT_CANDIDATE_NEEDS_OBSERVATION", risk, debt: true };
    }

    // 6. Reversible navigation/observation runs automatically.
    if (REVERSIBLE_SURFACES.has(surface)) {
      return { code: "REVERSIBLE_AUTO", decision: "auto", surface, reason: "REVERSIBLE_NAVIGATION", risk };
    }

    // 7. Stop conditions (risk-control / login / captcha) block, never approve.
    if (STOP_SURFACES.has(surface)) {
      return { code: "STOP_CONDITION", decision: "blocked", surface, reason: "STOP_CONDITION", risk };
    }

    // 8. Effect surfaces (social / publish / delete / payment / financial_commit): the Mission
    //    scope + policy decide ecp / phc / scope_violation / blocked via the shared evaluator.
    const action = effectActionFor(surface, input);
    // REX Phase 5 §8.4 (P5b): thread policyMode so nonpayment_v1 can downgrade an out-of-scope
    // non-payment action/target from scope_violation to soft ecp + debt; legacy (null) unchanged.
    const effect = evaluateMissionEffect(mission, { action, target: boundTarget }, { now, policyMode });
    const code = mapEffectCode(surface, effect.decision);
    return {
      code, decision: effect.decision, surface, reason: effect.reason, risk,
      ...(action ? { effectAction: action } : {}),
      ...(effect.debt ? { debt: true } : {}),
    };
  }

  // Pre-Mission Discovery is a no-effect R0 producer. It never inherits Mission ECP/PHC
  // decisions: only a fresh observed navigation/observation surface may reach the adapter.
  classifyDiscovery(input) {
    const surface = input?.snapshot?.surface;
    if (!REVERSIBLE_SURFACES.has(surface)) {
      return { code: "DISCOVERY_SURFACE_BLOCKED", decision: "blocked", surface, reason: "DISCOVERY_R0_ONLY" };
    }
    const verdict = this.classify(input, { scope: {}, policy: {}, validity: {}, status: "active" });
    return verdict.decision === "auto"
      ? verdict
      : { ...verdict, code: "DISCOVERY_SURFACE_BLOCKED", decision: "blocked" };
  }
}

function mapEffectCode(surface, decision) {
  if (decision === "ecp") return (surface === "payment" || surface === "financial_commit") ? "PHC_PAYMENT" : "ECP_AUTO";
  if (decision === "phc") return (surface === "payment" || surface === "financial_commit") ? "PHC_PAYMENT" : "PHC_PROTECTED";
  if (decision === "scope_violation") return "SCOPE_VIOLATION";
  return "MISSION_BLOCKED";
}

export function classifyEffectIntent(input, mission, options) {
  return new EffectFirewall().classify(input, mission, options);
}
