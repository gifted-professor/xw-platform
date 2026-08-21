// Hard-redline evaluation for M6: payment and delete are system-level hard deny.
// Any single signal hit (OCR text, semantic label, resourceId, a11y label, icon label,
// risky page fingerprint, or the action intent itself) resolves to HARD_STOP. On risky
// pages (confirm dialog / payment / order / assets / destructive settings), uncertain
// semantics — including empty dumps and visual misclassification risk — resolve to
// REPLAN instead of letting a generic tap through. Grants, models and live config
// cannot override this; Control Plane re-checks it at dispatch.
// Pure function only: no device IO, no network, deterministic.
import { HARD_REDLINE_RISK_PAGES } from "./m6-contracts.mjs";

export const HARD_REDLINE_VERDICTS = Object.freeze(["HARD_STOP", "REPLAN", "PASS"]);

function normalize(text) {
  return String(text || "").toLowerCase();
}

function policyTerms(policy) {
  const terms = [];
  for (const category of policy?.categories || []) {
    terms.push(normalize(category.name));
    for (const synonym of category.synonyms || []) terms.push(normalize(synonym));
    for (const iconLabel of category.iconLabels || []) terms.push(normalize(iconLabel));
  }
  return terms;
}

function textSignals(blockSignals = {}) {
  return [
    blockSignals.ocrText,
    blockSignals.semanticLabel,
    blockSignals.resourceId,
    blockSignals.a11yLabel,
    blockSignals.iconLabel,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

// evaluateHardRedline({ intent, blockSignals, pageFingerprint, policy }) → HARD_STOP | REPLAN | PASS
// blockSignals: { ocrText?, semanticLabel?, resourceId?, a11yLabel?, iconLabel?, uncertain?, emptyDump? }
// pageFingerprint: { riskClass?, appId?, pageHash? }
export function evaluateHardRedline({ intent, blockSignals = {}, pageFingerprint = {}, policy } = {}) {
  const terms = policyTerms(policy);
  const categoryNames = new Set((policy?.categories || []).map((category) => category.name));

  // Signal 1: the action intent itself names a hard-deny category.
  if (intent && (categoryNames.has(intent) || terms.includes(normalize(intent)))) {
    return "HARD_STOP";
  }

  // Signals 2-6: any text/icon signal on the target block hits a payment/delete term
  // (covers synonyms, icon-button labels and forged-intent bypass attempts).
  for (const signal of textSignals(blockSignals)) {
    const haystack = normalize(signal);
    for (const term of terms) {
      if (term && haystack.includes(term)) return "HARD_STOP";
    }
  }
  if (blockSignals.category && (categoryNames.has(blockSignals.category)
    || blockSignals.category === "payment" || blockSignals.category === "delete")) {
    return "HARD_STOP";
  }

  // Signal 7: risky page/application fingerprint + uncertain semantics → REPLAN.
  // Empty dumps and explicit uncertainty are conservative: never PASS on a risky page.
  const riskClass = pageFingerprint.riskClass;
  if (riskClass && HARD_REDLINE_RISK_PAGES.includes(riskClass)) {
    const uncertain = blockSignals.uncertain === true
      || blockSignals.emptyDump === true
      || textSignals(blockSignals).length === 0;
    if (uncertain) return "REPLAN";
  }
  return "PASS";
}
