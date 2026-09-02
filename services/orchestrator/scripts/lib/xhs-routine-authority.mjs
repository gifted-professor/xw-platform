// xhs-routine-authority.mjs — production social-effect wiring (plan V2 §8.1.3).
//
// The orchestrator holds only its formal Explorer session/token. Social
// effects commit through the CP's typed routine-authority RPC: this module is
// the thin, dependency-injected client plus the machine-seam adapter the S1
// state machine consumes. It owns NO device access and NO coordinates — every
// tap point is located by the CP transport from its own fresh dump.
//
// Fail-closed identity binding: the machine's plan/run identity is checked
// against the registered authority BEFORE any RPC leaves the process — a
// tampered planHash or routineRunId is a tamper signal, never a request.

const EFFECT_ACTIONS = new Set(["like", "comment"]);

function fail(code, message, status = 409, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}

/**
 * @param {object} input
 * @param {Function} input.register - async (fields) => authority (runtime RPC)
 * @param {Function} input.commitEffect - async ({ sessionId, token, authorityId, intent }) => effect
 * @param {Function} input.reconcileComments - async ({ sessionId, token, authorityId, targetFingerprint }) => reconciles
 * @param {Function} input.closeAuthority - async ({ sessionId, token, authorityId, reason }) => authority
 */
export function createRoutineAuthorityRuntime({ register, commitEffect, reconcileComments, closeAuthority } = {}) {
  for (const [name, fn] of Object.entries({ register, commitEffect, reconcileComments, closeAuthority })) {
    if (typeof fn !== "function") throw new TypeError(`createRoutineAuthorityRuntime requires ${name}`);
  }
  return { register, commitEffect, reconcileComments, closeAuthority };
}

/**
 * Build the machine effects surface for ONE registered authority.
 * @param {object} input
 * @param {object} input.authority - the CP-registered authority (immutable tuple)
 * @param {object} input.runtime - createRoutineAuthorityRuntime result
 * @param {string} input.sessionId - the owning formal Explorer session
 * @param {string} input.token - the owning session token (stays in-process)
 */
export function createRoutineEffectsSurface({ authority, runtime, sessionId, token } = {}) {
  if (!authority?.authorityId || !authority?.routineRunId || !authority?.planHash) {
    throw new TypeError("createRoutineEffectsSurface requires a registered authority tuple");
  }
  if (!runtime || typeof runtime.commitEffect !== "function") {
    throw new TypeError("createRoutineEffectsSurface requires the authority runtime");
  }
  if (!sessionId || !token) {
    throw new TypeError("createRoutineEffectsSurface requires the owning session/token");
  }

  function assertMachineIdentity(plan, run) {
    if (plan?.planHash !== authority.planHash) {
      throw fail("ROUTINE_EFFECT_IDENTITY_MISMATCH", "machine planHash does not match the registered authority");
    }
    if ((run?.routineRunId ?? null) !== authority.routineRunId) {
      throw fail("ROUTINE_EFFECT_IDENTITY_MISMATCH", "machine routineRunId does not match the registered authority");
    }
  }

  return Object.freeze({
    authorityId: authority.authorityId,
    canaryPolicy: authority.canaryPolicy ?? null,

    async commitRoutineEffect({ plan, run, intent } = {}) {
      assertMachineIdentity(plan, run);
      const action = String(intent?.action || "");
      if (!EFFECT_ACTIONS.has(action)) {
        // unwired actions have no CP path at all — never forward them
        return { outcome: "rejected:action_not_wired", transported: false };
      }
      if (intent?.x != null || intent?.y != null || intent?.control || intent?.bounds) {
        return { outcome: "rejected:coordinate_surface", transported: false };
      }
      const payload = await runtime.commitEffect({
        sessionId,
        token,
        authorityId: authority.authorityId,
        intent: {
          action,
          targetFingerprint: intent.targetFingerprint ?? null,
          observationHash: intent.observationHash ?? null,
          payloadHash: intent.payloadHash ?? null,
        },
      });
      // runtime.commitEffect already unwraps the HTTP envelope to the effect
      // object (outcome validated as a string). Re-extracting `.effect` here
      // silently discarded every real outcome (live S2 wave 2, 2026-08-28: a
      // transported "ambiguous" like surfaced as "bridge_error" with the
      // transported flag lost), so return the effect object verbatim — the
      // machine keys cap/retry accounting on outcome + transported.
      return payload;
    },

    async reconcileComments(targetFingerprint = null) {
      return runtime.reconcileComments({ sessionId, token, authorityId: authority.authorityId, targetFingerprint });
    },

    /**
     * V2.1 P2-AUTHORITY-CLOSE-ORDER: explicit close the machine performs in
     * closeAndInspect BEFORE the session release (releaseSession deletes the
     * owning client context, so any later close only produces the
     * ROUTINE_SESSION_BINDING_INVALID noise). The runner's finally keeps an
     * idempotent fallback for surfaces that never reach the machine hook.
     */
    async closeAuthority(reason = "run-finished") {
      return runtime.closeAuthority({ sessionId, token, authorityId: authority.authorityId, reason });
    },
  });
}