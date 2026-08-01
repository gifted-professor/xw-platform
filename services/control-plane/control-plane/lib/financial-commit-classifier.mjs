import { fingerprint } from "./canonical.mjs";

const FINANCIAL_WORDS = /支付|付款|转账|充值|红包|礼物|购买|pay|purchase|transfer|recharge/i;
const OBSERVE_WORDS = /钱包|余额|账单|交易记录|订单详情|wallet|balance|statement|transaction/i;
const PREPARE_WORDS = /去结算|收银台|支付方式|填写金额|创建订单|checkout|payment method/i;

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function observedTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return {};
  return {
    text: nonempty(target.text) ? target.text.trim() : null,
    resourceId: nonempty(target.resourceId) ? target.resourceId.trim() : null,
    className: nonempty(target.className) ? target.className.trim() : null,
    bounds: target.bounds && typeof target.bounds === "object" ? target.bounds : null,
    selector: nonempty(target.selector) ? target.selector.trim() : null,
    fingerprint: nonempty(target.fingerprint) ? target.fingerprint.trim() : null,
    verifiedFinalControl: target.verifiedFinalControl === true,
    oneClickDebit: target.oneClickDebit === true,
    osPaymentConfirmation: target.osPaymentConfirmation === true,
  };
}

export function targetControlFingerprint(target) {
  const normalized = observedTarget(target);
  return normalized.fingerprint || fingerprint(normalized);
}

function hasCompletePaymentContext(context) {
  return nonempty(context?.amount)
    && nonempty(context?.currency)
    && nonempty(context?.payeeRef);
}

export function classifyFinancialCommit({ target, context = {} } = {}) {
  const observed = observedTarget(target);
  const text = observed.text || "";
  const stage = nonempty(context.stage) ? context.stage.trim().toLowerCase() : "unknown";
  const fingerprintValue = targetControlFingerprint(observed);
  const strongFinalControl = observed.verifiedFinalControl
    || observed.oneClickDebit
    || observed.osPaymentConfirmation
    || context.sdkFinalConfirmation === true;
  const finalStage = stage === "final" || context.finalStage === true;

  if (strongFinalControl && finalStage && hasCompletePaymentContext(context)) {
    return {
      actionClass: "financial_commit",
      reasonCode: "VERIFIED_FINAL_FINANCIAL_CONTROL",
      targetControlFingerprint: fingerprintValue,
    };
  }

  if (finalStage && (strongFinalControl || FINANCIAL_WORDS.test(text))) {
    return {
      actionClass: "financial_commit_candidate",
      reasonCode: "FINAL_CONTROL_NEEDS_OBSERVATION",
      targetControlFingerprint: fingerprintValue,
    };
  }

  if (["prepare", "checkout"].includes(stage) || PREPARE_WORDS.test(text)) {
    return {
      actionClass: "financial_prepare",
      reasonCode: "FINANCIAL_PREPARATION",
      targetControlFingerprint: fingerprintValue,
    };
  }

  if (["observe", "navigation"].includes(stage) && (OBSERVE_WORDS.test(text) || context.financialSurface === true)) {
    return {
      actionClass: "financial_observe",
      reasonCode: "FINANCIAL_OBSERVATION",
      targetControlFingerprint: fingerprintValue,
    };
  }

  return {
    actionClass: "unknown",
    reasonCode: "NO_FINAL_FINANCIAL_EVIDENCE",
    targetControlFingerprint: fingerprintValue,
  };
}

function paymentBinding(input, classification) {
  return Object.freeze({
    app: input.app ?? null,
    accountRef: input.accountRef ?? null,
    payeeRef: input.context?.payeeRef ?? null,
    amount: input.context?.amount ?? null,
    currency: input.context?.currency ?? null,
    targetControlFingerprint: classification.targetControlFingerprint,
    snapshotHash: input.snapshotHash ?? null,
    deviceId: input.deviceId ?? null,
  });
}

export function createFinancialCommitTripwire({
  transport,
  observeCandidate = null,
  verifyApproval = null,
  classify = classifyFinancialCommit,
} = {}) {
  if (typeof transport !== "function") throw new TypeError("financial tripwire requires transport");
  if (observeCandidate !== null && typeof observeCandidate !== "function") {
    throw new TypeError("observeCandidate must be a function");
  }
  if (verifyApproval !== null && typeof verifyApproval !== "function") {
    throw new TypeError("verifyApproval must be a function");
  }

  return Object.freeze({
    async dispatch(input = {}) {
      let candidateInput = input;
      let classification = classify(candidateInput);
      let synchronousObservationCount = 0;

      if (classification.actionClass === "financial_commit_candidate") {
        if (!observeCandidate) {
          return {
            decision: "defer_branch_technical",
            actionClass: classification.actionClass,
            reasonCode: "FINANCIAL_CANDIDATE_OBSERVATION_UNAVAILABLE",
            transportDispatched: false,
            synchronousObservationCount,
          };
        }
        const observed = await observeCandidate({ input: candidateInput, classification });
        synchronousObservationCount += 1;
        candidateInput = { ...candidateInput, ...(observed || {}) };
        classification = classify(candidateInput);
        if (classification.actionClass === "financial_commit_candidate") {
          return {
            decision: "defer_branch_technical",
            actionClass: classification.actionClass,
            reasonCode: "FINANCIAL_CANDIDATE_UNRESOLVED",
            transportDispatched: false,
            synchronousObservationCount,
          };
        }
      }

      if (classification.actionClass === "financial_commit") {
        const binding = paymentBinding(candidateInput, classification);
        const verified = candidateInput.approval && verifyApproval
          ? await verifyApproval({ approval: candidateInput.approval, binding })
          : { ok: false, code: "PAYMENT_APPROVAL_REQUIRED" };
        if (verified?.ok !== true) {
          return {
            decision: "wait_financial_commit",
            actionClass: classification.actionClass,
            reasonCode: verified?.code || "PAYMENT_APPROVAL_REQUIRED",
            approvalBinding: binding,
            transportDispatched: false,
            synchronousObservationCount,
          };
        }
      }

      const transportResult = await transport(candidateInput);
      return {
        decision: "dispatch",
        actionClass: classification.actionClass,
        reasonCode: classification.reasonCode,
        transportDispatched: true,
        synchronousObservationCount,
        transportResult,
      };
    },
  });
}
