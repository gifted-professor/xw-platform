// Hard-redline evaluation for M6: payment and delete are system-level hard deny.
// Fail-closed by construction: the policy document is mandatory, must pass its own
// schema plus the built-in minimum redline set, and its canonical sha256 must match
// the caller-pinned expectedPolicySha256. Any policy problem resolves to HARD_STOP
// with an explicit error code — a missing, weakened or swapped policy can never
// silently PASS. The built-in MINIMUM_REDLINE terms are always enforced; a policy
// document can only extend them, never shrink them.
// Pure function only: no device IO, no network, deterministic.
import {
  HARD_REDLINE_RISK_PAGES,
  computeRedlinePolicySha256,
  validateHardRedlinePolicy,
} from "./m6-contracts.mjs";

export const HARD_REDLINE_VERDICTS = Object.freeze(["HARD_STOP", "REPLAN", "PASS"]);

// Built-in floor for the payment/delete firewall. Categories mirror
// xw.hard-redline-policy.v1; synonyms are the core terms that must hold even if a
// policy document is weakened.
export const MINIMUM_REDLINE = Object.freeze({
  payment: Object.freeze(["payment", "支付", "付款", "pay", "确认支付"]),
  purchase: Object.freeze(["purchase", "购买", "buy", "下单", "立即抢购"]),
  transfer: Object.freeze(["transfer", "转账", "汇款"]),
  tip: Object.freeze(["tip", "打赏", "赞赏"]),
  subscription: Object.freeze(["subscription", "订阅", "续费", "会员开通", "subscribe"]),
  "credential-submit": Object.freeze(["credential", "credential-submit", "输入密码", "支付密码", "银行卡号", "cvv"]),
  delete: Object.freeze(["delete", "删除", "移除", "清空聊天记录"]),
  uninstall: Object.freeze(["uninstall", "卸载"]),
  "clear-data": Object.freeze(["clear-data", "clear data", "清除数据", "清空缓存", "注销账号"]),
});

function normalize(text) {
  return String(text || "").normalize("NFKC").toLowerCase();
}

function minimumTerms() {
  const terms = [];
  for (const synonyms of Object.values(MINIMUM_REDLINE)) {
    for (const synonym of synonyms) terms.push(normalize(synonym));
  }
  return terms;
}

function policyTerms(policy) {
  const terms = minimumTerms();
  for (const category of policy?.categories || []) {
    terms.push(normalize(category.name));
    for (const synonym of category.synonyms || []) terms.push(normalize(synonym));
    for (const iconLabel of category.iconLabels || []) terms.push(normalize(iconLabel));
  }
  return [...new Set(terms)];
}

// The policy must be schema-valid and cover every minimum category; it can only
// widen the built-in floor, never narrow it.
function validateRedlinePolicyStrength(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [{ code: "M6_REDLINE_POLICY_MISSING", message: "hard-redline policy is required" }];
  }
  const shape = validateHardRedlinePolicy(policy);
  if (!shape.ok) {
    return shape.errors.map((error) => ({ code: "M6_REDLINE_POLICY_INVALID", message: error.message }));
  }
  const names = new Set(policy.categories.map((category) => category.name));
  for (const category of Object.keys(MINIMUM_REDLINE)) {
    if (!names.has(category)) {
      errors.push({ code: "M6_REDLINE_POLICY_WEAKENED", message: `policy is missing minimum category: ${category}` });
    }
  }
  return errors;
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

function policyFailure(errors) {
  return { verdict: "HARD_STOP", ok: false, errors };
}

// evaluateHardRedline({ intent, blockSignals, pageFingerprint, policy, expectedPolicySha256 })
//   → { verdict: HARD_STOP | REPLAN | PASS, ok, errors }
// policy and expectedPolicySha256 are both mandatory; any policy failure is HARD_STOP.
// blockSignals: { ocrText?, semanticLabel?, resourceId?, a11yLabel?, iconLabel?, category?, uncertain?, emptyDump? }
// pageFingerprint: { riskClass?, appId?, pageHash? }
export function evaluateHardRedline({ intent, blockSignals = {}, pageFingerprint = {}, policy, expectedPolicySha256 } = {}) {
  const policyErrors = validateRedlinePolicyStrength(policy);
  if (policyErrors.length > 0) return policyFailure(policyErrors);
  if (typeof expectedPolicySha256 !== "string" || expectedPolicySha256.length === 0) {
    return policyFailure([{ code: "M6_REDLINE_POLICY_UNPINNED", message: "expectedPolicySha256 is required" }]);
  }
  if (computeRedlinePolicySha256(policy) !== expectedPolicySha256) {
    return policyFailure([{ code: "M6_REDLINE_POLICY_HASH_MISMATCH", message: "policy canonical sha256 does not match the pinned expectedPolicySha256" }]);
  }

  const terms = policyTerms(policy);
  const categoryNames = new Set([...Object.keys(MINIMUM_REDLINE), ...(policy.categories || []).map((category) => category.name)]);
  const errors = [];

  // Signal 1: the action intent itself names a hard-deny category.
  if (intent && (categoryNames.has(intent) || terms.includes(normalize(intent)))) {
    return { verdict: "HARD_STOP", ok: true, errors };
  }

  // Signals 2-6: any text/icon signal on the target block hits a payment/delete term
  // (covers synonyms, icon-button labels and forged-intent bypass attempts).
  for (const signal of textSignals(blockSignals)) {
    const haystack = normalize(signal);
    for (const term of terms) {
      if (term && haystack.includes(term)) return { verdict: "HARD_STOP", ok: true, errors };
    }
  }
  if (blockSignals.category && (categoryNames.has(blockSignals.category)
    || blockSignals.category === "payment" || blockSignals.category === "delete")) {
    return { verdict: "HARD_STOP", ok: true, errors };
  }

  // Signal 7: risky page/application fingerprint + uncertain semantics → REPLAN.
  // Empty dumps and explicit uncertainty are conservative: never PASS on a risky page.
  const riskClass = pageFingerprint.riskClass;
  if (riskClass && HARD_REDLINE_RISK_PAGES.includes(riskClass)) {
    const uncertain = blockSignals.uncertain === true
      || blockSignals.emptyDump === true
      || textSignals(blockSignals).length === 0;
    if (uncertain) return { verdict: "REPLAN", ok: true, errors };
  }
  return { verdict: "PASS", ok: true, errors };
}
