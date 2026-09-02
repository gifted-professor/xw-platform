// publish-commit.mjs — XHS publish protected-commit binding (executable-plan W6, PUBLISH).
//
// Reuses the ProtectedHumanCommit (PHC) kernel for the publish action's
// prepare→wait→decide lifecycle. PHC is payment-SPECIALIZED (the cryptographic
// approvalVerifier + frozen approvalBinding are payment-only) but NOT
// payment-only: the route/begin/decide skeleton is action-agnostic. Publish is
// a non-payment protected commit — the human gate is the explicit
// `decidePublish(commitId, "approve")` call (plan V2 §10.5, the ONLY retained
// human point), NOT a signed payment approval.
//
// This handler layers the publish-specific fail-closed guarantees ON TOP of PHC:
//
//   * drift fail-closed — at approve time, re-derive the envelope from the
//     CURRENT observed state and compare to the frozen envelope hash. Any drift
//     (content edited / screenshot replaced / device-account-target swapped /
//     plan changed) => PUBLISH_ENVELOPE_DRIFT, no execute. The plan's "漂移
//     fail-closed".
//   * restart-lost-handle fail-closed — the prepared handle lives in-process
//     (PHC's `pending` Map + this handler's mirror). A control-plane restart
//     loses it; a decide on a lost handle => PUBLISH_HANDLE_LOST, no execute
//     (PHC itself returns PROTECTED_COMMIT_NOT_FOUND, but publish surfaces a
//     publish-specific code so the operator knows the handle was lost, not
//     merely unknown). The plan's "重启丢 handle fail-closed".
//   * expiry fail-closed — PHC already enforces expiresAt; if the approval
//     window elapsed, decide cancels (PAYMENT_APPROVAL_EXPIRED in PHC, surfaced
//     here as the PHC result). No execute past expiry.
//   * approve => exactly one execute (the one-tap publish); deny => cancel.
//     prepare is transport=0 (the envelope is the proof, not a send) — the
//     actual send happens only on decide("approve").
//
// Pure-ish: depends only on the PHC instance + the pure envelope module. No fs.
import {
  buildPublishEnvelope,
  contentHashOf,
  detectEnvelopeDrift,
  screenshotHashOf,
  verifyEnvelopeIntegrity,
} from "./publish-envelope.mjs";

export class PublishCommitHandler {
  /**
   * @param {object} opts
   * @param {object} opts.phc     - a ProtectedHumanCommit instance (the kernel).
   * @param {function} [opts.now] - clock for expiresAt computation.
   * @param {number} [opts.approvalTtlMs=300000] - publish approval window (5min).
   */
  constructor({ phc, now = Date.now, approvalTtlMs = 300000 } = {}) {
    if (!phc) throw new TypeError("PublishCommitHandler requires a PHC instance");
    this.phc = phc;
    this.now = now;
    this.approvalTtlMs = approvalTtlMs;
    // in-process mirror of the frozen envelope per commitId (the drift reference).
    // Lost on restart — that is the restart-lost-handle fail-closed path.
    this.envelopes = new Map();
  }

  /**
   * Begin a publish protected commit. Builds the envelope (freezing the publish
   * context), then delegates to PHC.begin (action="publish") which prepares the
   * effect and enters waiting_authorization. prepare is transport=0 — no actual
   * publish happens here, only the envelope proof.
   *
   * @param {object} input
   * @param {object} input.mission            - the mission (scope.actions includes "publish").
   * @param {string} input.target              - the publish target fingerprint.
   * @param {string} input.prepareRunId       - the prepare run id (from publish prepare / edit_dry_run).
   * @param {string} input.planHash             - the dispatcher planHash.
   * @param {string} input.content             - the note body content (raw).
   * @param {string} input.screenshot          - the screenshot bytes / proof.
   * @param {string} input.deviceFingerprint   - device fingerprint.
   * @param {string} input.accountFingerprint  - account fingerprint.
   * @param {string} input.targetFingerprint   - target fingerprint.
   * @param {object} [input.tuple]             - control tuple (real ECP.prepare
   *   asserts it: deviceRunId/leaseId/sessionId/controllerEpoch). Optional for
   *   stub-ECP offline tests, required on the live wiring.
   * @param {string} [input.idempotencyKey]    - effect idempotency key (real
   *   state.beginMissionEffect requires it; stub-ECP offline tests omit it).
   * @param {object} [input.intent]            - free-form effect intent (live
   *   wiring passes the editor surface proof).
   * @returns {Promise<{commitId, status, envelope, envelopeHash}>}
   */
  async beginPublish({ mission, target, prepareRunId, planHash, content, screenshot, deviceFingerprint, accountFingerprint, targetFingerprint, tuple = undefined, idempotencyKey = undefined, intent = undefined }) {
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + this.approvalTtlMs).toISOString();
    const envelope = buildPublishEnvelope({
      prepareRunId, planHash,
      contentHash: contentHashOf(content),
      screenshotHash: screenshotHashOf(screenshot),
      deviceFingerprint, accountFingerprint, targetFingerprint,
      expiresAt,
    });
    // verify the freshly-built envelope is self-consistent (tamper-evident boot).
    if (!verifyEnvelopeIntegrity(envelope)) {
      return { status: "blocked", code: "PUBLISH_ENVELOPE_INTEGRITY_FAILED" };
    }
    const begun = await this.phc.begin({
      mission, action: "publish", target, envelope,
      ...(tuple !== undefined ? { tuple } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(intent !== undefined ? { intent } : {}),
    });
    if (begun.status !== "waiting_authorization") {
      return begun; // PHC blocked (scope / readiness / etc.) — surface as-is.
    }
    this.envelopes.set(begun.commitId, envelope);
    return { commitId: begun.commitId, status: "waiting_authorization", envelope, envelopeHash: envelope.envelopeHash, effectId: begun.effectId };
  }

  /**
   * Decide a publish commit. The drift check runs BEFORE releasing to PHC.decide:
   * the observed current state is re-hashed and compared to the frozen envelope.
   * Only a drift-free, in-window, still-held approve reaches PHC.executePrepared
   * (the one-tap publish). Restart-lost-handle, drift, and expiry all fail-closed
   * with no execute.
   *
   * @param {string} commitId
   * @param {object} opts
   * @param {"approve"|"deny"} opts.decision
   * @param {string} opts.actorId
   * @param {object} [opts.observed] - current state for the drift check:
   *   { content, screenshot, deviceFingerprint, accountFingerprint, targetFingerprint, planHash }.
   *   Required on "approve"; on "deny" the drift check is skipped (a deny cancels
   *   regardless of drift).
   * @returns {Promise<object>} the PHC decide result, or a publish-specific block.
   */
  async decidePublish(commitId, { decision, actorId, observed = null } = {}) {
    const frozen = this.envelopes.get(commitId);

    // restart-lost-handle fail-closed: the in-process envelope (and PHC's pending)
    // are gone after a restart. PHC would return PROTECTED_COMMIT_NOT_FOUND; we
    // surface the publish-specific code so the operator knows the handle was
    // lost to a restart, not merely an unknown id.
    if (!frozen) {
      return { status: "blocked", code: "PUBLISH_HANDLE_LOST", commitId };
    }

    // deny cancels regardless of drift — no need to re-observe.
    if (decision === "deny") {
      const result = await this.phc.decide(commitId, { decision: "deny", actorId });
      this.envelopes.delete(commitId);
      return result;
    }

    if (decision !== "approve") {
      return { status: "blocked", code: "PUBLISH_DECISION_INVALID", commitId };
    }

    // drift fail-closed: re-derive the current state and compare to the frozen
    // envelope. Any drifted field => block, no execute, handle retained for audit.
    if (!observed) {
      return { status: "blocked", code: "PUBLISH_OBSERVED_STATE_REQUIRED", commitId };
    }
    const drifted = detectEnvelopeDrift(frozen, observed);
    if (drifted) {
      return { status: "blocked", code: "PUBLISH_ENVELOPE_DRIFT", field: drifted, commitId };
    }
    // double-check the frozen envelope itself was not tampered with in-process.
    if (!verifyEnvelopeIntegrity(frozen)) {
      return { status: "blocked", code: "PUBLISH_ENVELOPE_TAMPERED", commitId };
    }

    // all gates pass -> PHC.decide("approve") -> executePrepared (the one-tap
    // publish). PHC also enforces expiresAt here (expiry => cancelled, no execute).
    const result = await this.phc.decide(commitId, { decision: "approve", actorId });
    this.envelopes.delete(commitId);
    return result;
  }
}