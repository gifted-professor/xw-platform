// Open Action payment firewall — M3-C fixture/replay classifier.
//
// Maps observation.paymentSignals onto the frozen EFFECT_POLICY table.
// Does not copy the policy. Does not emit live events. Does not execute primitives.
//
// Priority (high → low): payment_final_commit > payment_credential > payment_context_uncertain > nonpayment.
// final_commit beats credential because the irreversible submit is the gated effect.
// decision is always EFFECT_POLICY[category], so payment categories cannot ALLOW_WITH_TRACE.

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

export function classifyPaymentFirewall(observation, { agentClaimedCategory = null } = {}) {
  const signals = Array.isArray(observation?.paymentSignals) ? observation.paymentSignals : [];
  const matched = { credential: [], finalCommit: [], uncertain: [] };
  for (const signal of signals) {
    if (CREDENTIAL_SIGNALS.has(signal)) matched.credential.push(signal);
    else if (FINAL_COMMIT_SIGNALS.has(signal)) matched.finalCommit.push(signal);
    else if (UNCERTAIN_SIGNALS.has(signal)) matched.uncertain.push(signal);
  }

  let category;
  let reasons;
  if (matched.finalCommit.length) {
    category = "payment_final_commit";
    reasons = matched.finalCommit;
  } else if (matched.credential.length) {
    category = "payment_credential";
    reasons = matched.credential;
  } else if (matched.uncertain.length) {
    category = "payment_context_uncertain";
    reasons = matched.uncertain;
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
