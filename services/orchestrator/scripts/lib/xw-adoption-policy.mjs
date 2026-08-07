/** Evidence-based Windows adoption policy for xw closeout bundles. */

const REVIEW = "review_required";
const ACCEPTED = "accepted";

function integer(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function hasUnsafePayment(closeout) {
  return (closeout.effects || []).some((effect) => {
    const payment = effect?.payment || {};
    return payment.involved === true || payment.finalCommit === true || integer(payment.transportCount) > 0;
  });
}

export function evaluateWindowsAdoption(closeout, signal = {}) {
  const requestedCount = integer(signal.requestedCount);
  const completedCount = integer(signal.completedCount);
  const completionRate = requestedCount > 0 ? completedCount / requestedCount : 0;
  const userConfirmed = signal.userConfirmed === true;
  const highConfidenceCompletion = requestedCount >= 20 && completionRate >= 0.98;
  const reasons = [];

  if (closeout?.closure?.status !== "completed") reasons.push("closure_not_completed");
  if ((closeout?.closure?.blockers || []).length) reasons.push("closure_has_blockers");
  if ((closeout?.closure?.remainingWork || []).length) reasons.push("closure_has_remaining_work");
  if (!(closeout?.candidates || []).length) reasons.push("no_adoption_candidates");
  if (!(closeout?.checks || []).length) reasons.push("no_checks");
  if ((closeout?.checks || []).some((check) => check.status !== "pass")) reasons.push("checks_not_all_passed");
  if ((closeout?.evidenceDebt || []).some((debt) => ["medium", "high"].includes(debt.severity))) {
    reasons.push("material_evidence_debt");
  }
  if (hasUnsafePayment(closeout)) reasons.push("payment_or_money_transport_present");
  if (requestedCount < 1 || completedCount > requestedCount || completionRate < 0.95) {
    reasons.push("completion_rate_below_95_percent");
  }
  if (integer(signal.activeLeaseCount) !== 0) reasons.push("active_lease_present");
  if (integer(signal.runningJobCount) !== 0) reasons.push("running_job_present");
  if (integer(signal.residualProcessCount) !== 0) reasons.push("residual_process_present");
  if (integer(signal.unresolvedFailureCount) !== 0) reasons.push("unresolved_failure_present");
  if (!userConfirmed && !highConfidenceCompletion) reasons.push("neither_user_confirmed_nor_high_confidence_completion");

  const status = reasons.length === 0 ? ACCEPTED : REVIEW;
  return {
    schemaId: "xhs.windows-adoption-decision.v1",
    schemaVersion: 1,
    status,
    macReview: status === ACCEPTED ? "not_required" : "pending",
    completion: {
      requestedCount,
      completedCount,
      rate: Number(completionRate.toFixed(6)),
      highConfidence: highConfidenceCompletion,
    },
    userConfirmed,
    resourceState: {
      activeLeaseCount: integer(signal.activeLeaseCount),
      runningJobCount: integer(signal.runningJobCount),
      residualProcessCount: integer(signal.residualProcessCount),
      unresolvedFailureCount: integer(signal.unresolvedFailureCount),
    },
    candidateIds: (closeout?.candidates || []).map((candidate) => candidate.candidateId),
    reasons,
  };
}

