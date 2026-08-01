import { fingerprint } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

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

// ─── REX Phase 2 收尾 §4.2.A：直运层 fail-closed 守卫 ───
//
// 生产输入路径碎片化（#runJob→adapter、XiaoweiTransport、FastOperator、
// greenarrow raw-WS、XiaoweiHttpAdapter typed-HTTP），无单一 chokepoint。
// 本守卫在每个直运入口做一次轻量 classify：非金融原语零成本透传，命中
// financial_commit 且无有效人类签名批准 → fail-closed 抛
// FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE（transport=0）。
//
// 守卫只对「显式声明了语义 target/context 的输入」生效；纯坐标/无语义
// 输入（如 tap(x,y) 不带 semantic）extractFinancialInput 返回 null，直接放行——
// 不把每个 tap 变成完整 job/lease/preflight。资金最终提交的唯一放行路径是
// 控制面 PHC 流（beginPaymentCommit→waiting_authorization→人类签名决定），
// 由 #runJob 处带 verifyApproval 的守卫承接；直运脚本无 verifier，恒 fail-closed。

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// 从任意直运请求形状里容错提取分类器输入 {target, context, app, accountRef,
// snapshotHash, deviceId}。兼容 request.target / request.data.target /
// request.params.target / request.devices[0] 等常见位置。无 target 且无 context
// → 返回 null（无可分类语义，调用方零成本放行）。
export function extractFinancialInput(request = {}) {
  const req = pickObject(request);
  if (!req) return null;
  const data = pickObject(req.data) || {};
  const params = pickObject(req.params) || {};
  const target = req.target ?? data.target ?? params.target ?? null;
  const context = req.context ?? data.context ?? params.context ?? null;
  if (!target && !context) return null;
  const deviceId = req.deviceId ?? data.deviceId ?? params.deviceId
    ?? (Array.isArray(req.devices) && req.devices.length ? req.devices[0] : null) ?? null;
  return {
    target: target ?? null,
    context: pickObject(context) || {},
    app: req.app ?? data.app ?? params.app ?? null,
    accountRef: req.accountRef ?? data.accountRef ?? params.accountRef ?? null,
    snapshotHash: req.snapshotHash ?? data.snapshotHash ?? params.snapshotHash ?? null,
    deviceId,
  };
}

// 直运入口守卫。返回 {actionClass, reasonCode, guarded}；命中 financial_commit
// 且未携带经 verifyApproval 验证通过的人类签名批准时抛
// FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE（403）。verifyApproval 为 null（直运脚本
// 无访问 verifier）时，任何 financial_commit 恒被拒——这正是直运层 fail-closed 语义。
export async function guardFinancialCommit(request, {
  verifyApproval = null,
  classify = classifyFinancialCommit,
} = {}) {
  const input = extractFinancialInput(request);
  if (!input) return { actionClass: "unknown", reasonCode: "NO_FINANCIAL_SEMANTICS", guarded: false };
  const classification = classify(input);
  if (classification.actionClass !== "financial_commit") {
    return { ...classification, guarded: true };
  }
  if (verifyApproval && request?.approval) {
    const verified = await verifyApproval({
      approval: request.approval,
      binding: paymentBinding(input, classification),
    });
    if (verified?.ok === true) return { ...classification, guarded: true, approved: true };
  }
  throw new ControlPlaneError(
    "FINANCIAL_COMMIT_REQUIRES_HUMAN_GATE",
    "financial final commit must route through the protected human-commit flow; direct transport refused",
    {
      status: 403,
      details: {
        reasonCode: classification.reasonCode,
        targetControlFingerprint: classification.targetControlFingerprint,
      },
    },
  );
}
