// Open Action payment firewall — M3-C fixture/replay classifier.
//
// Maps observation.paymentSignals onto the frozen EFFECT_POLICY table.
// Does not copy the policy. Does not emit live events. Does not execute primitives.
//
// Priority (high → low): payment_final_commit > payment_credential > payment_context_uncertain > nonpayment.
// final_commit beats credential because the irreversible submit is the gated effect.
// decision is always EFFECT_POLICY[category], so payment categories cannot ALLOW_WITH_TRACE.
// Unknown non-empty paymentSignals never classify as nonpayment (fail-closed).

import {
  EFFECT_POLICY,
} from "../../../../packages/kernel/lib/open-action.mjs";

export const CREDENTIAL_SIGNALS = Object.freeze(new Set([
  "credential_pin_pad",
  "credential_password",
  "credential_otp",
  "credential_card_number",
  "credential_cvv",
  "credential_bank_card",
  "credential_expiry",
]));

export const FINAL_COMMIT_SIGNALS = Object.freeze(new Set([
  "final_confirm_pay",
  "final_transfer_confirm",
  "final_one_click_pay",
  "final_subscription_confirm",
  "final_verified_control",
]));

export const UNCERTAIN_SIGNALS = Object.freeze(new Set([
  "pay_adjacent_label",
  "pay_ambiguous_button",
  "pay_keyword_no_commit",
  "pay_context_incomplete",
]));

export const PAYMENT_SIGNAL_SET_VERSION = 1;

function isKnownPaymentSignal(signal) {
  return CREDENTIAL_SIGNALS.has(signal)
    || FINAL_COMMIT_SIGNALS.has(signal)
    || UNCERTAIN_SIGNALS.has(signal);
}

export function classifyPaymentFirewall(observation, { agentClaimedCategory = null } = {}) {
  const signals = Array.isArray(observation?.paymentSignals) ? observation.paymentSignals : [];
  const classificationComplete = observation?.paymentClassificationComplete !== false;
  const matched = { credential: [], finalCommit: [], uncertain: [], unknown: [] };
  for (const signal of signals) {
    if (typeof signal !== "string" || signal.length === 0) continue;
    if (CREDENTIAL_SIGNALS.has(signal)) matched.credential.push(signal);
    else if (FINAL_COMMIT_SIGNALS.has(signal)) matched.finalCommit.push(signal);
    else if (UNCERTAIN_SIGNALS.has(signal)) matched.uncertain.push(signal);
    else if (!isKnownPaymentSignal(signal)) matched.unknown.push(`unknown_payment_signal:${signal}`);
  }

  let category;
  let reasons;
  if (matched.finalCommit.length) {
    category = "payment_final_commit";
    reasons = matched.finalCommit;
  } else if (matched.credential.length) {
    category = "payment_credential";
    reasons = matched.credential;
  } else if (matched.uncertain.length || matched.unknown.length || !classificationComplete) {
    category = "payment_context_uncertain";
    reasons = matched.uncertain.length
      ? matched.uncertain
      : matched.unknown.length
        ? matched.unknown
        : ["payment_classification_incomplete"];
  } else {
    category = "nonpayment";
    reasons = ["no_payment_signals"];
  }

  const assessment = {
    schemaId: "xw.open-action.effect-assessment.v1",
    schemaVersion: 1,
    category,
    decision: EFFECT_POLICY[category],
    authority: "control_plane",
    reasons,
  };
  if (agentClaimedCategory != null) assessment.agentClaimedCategory = agentClaimedCategory;
  return assessment;
}
