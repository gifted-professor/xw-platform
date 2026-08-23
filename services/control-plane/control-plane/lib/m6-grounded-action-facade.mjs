import { performance } from "node:perf_hooks";

import { ControlPlaneError } from "./errors.mjs";
import { decideLiveGrounding, deriveLiveVisualBlockSet } from "../../../../packages/kernel/lib/m6-live-grounding.mjs";
import { assertM6ActionSlotDispatch, deriveM6LogicalActionIdentity } from "../../../../packages/kernel/lib/m6-action-slot.mjs";
import { validateM6TypedInvocation } from "./m6-typed-transport.mjs";

function actionError(code, message, cause = null) {
  return new ControlPlaneError(code, message, { status: 409, cause });
}

export function createM6GroundedActionFacade({
  state,
  typedTransport,
  captureWithinRun,
  readCurrentState,
  materializePrivate,
  verifyAfter,
  monoNow = () => performance.now(),
} = {}) {
  for (const [name, value] of Object.entries({ state, typedTransport, captureWithinRun, readCurrentState, materializePrivate, verifyAfter })) {
    if (!value || (["captureWithinRun", "readCurrentState", "materializePrivate", "verifyAfter"].includes(name) && typeof value !== "function")) {
      throw new TypeError(`${name} is required`);
    }
  }
  return Object.freeze({
    async execute({ session, environmentAttestation, intent, candidateBlockId = null, bindings, slot, actionSlotSpec, planHash, timing, fence, manifestStep, typedAuthorization }) {
      const frozenSlot = assertM6ActionSlotDispatch({ actionSlotSpec, intent, manifestStep });
      const identity = deriveM6LogicalActionIdentity({ planHash, actionSlotSpec: frozenSlot });
      if (intent.operationKey !== identity.operationKey || slot.slotSpecHash !== frozenSlot.actionSlotSpecHash) {
        throw actionError("M6_ACTION_SLOT_BINDING_MISMATCH", "operation key or permit slot does not match frozen authority");
      }
      const typedInvocation = validateM6TypedInvocation({ primitive: manifestStep.primitive, target: { kind: intent.targetKind }, trustedParams: manifestStep.trustedParams, operationKey: intent.operationKey });
      if (!typedInvocation.writePrimitive) {
        throw actionError("M6_ACTION_PRIMITIVE_NOT_WRITE", "grounded action facade accepts only bounded write primitives");
      }
      const active = state.validateSession(session.sessionId, session.token);
      if (active.leaseId !== session.leaseId || active.sessionId !== bindings.sessionId || active.leaseId !== bindings.leaseId) {
        throw actionError("M6_ACTION_BINDING_MISMATCH", "composite run session/lease binding changed");
      }
      const before = await captureWithinRun({ session, phase: "before" });
      const provider = deriveLiveVisualBlockSet({
        frame: before.frame,
        dumpXml: before.dumpXml,
        environmentAttestation,
      });
      if (!provider.blockSet) {
        return { disposition: "REPLAN", externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT", reason: provider.reason };
      }
      const decision = decideLiveGrounding({
        frame: before.frame,
        blockSet: provider.blockSet,
        intent,
        candidateBlockId,
        bindings,
      });
      if (decision.disposition !== "ALLOW_ONCE") {
        return { disposition: decision.disposition, decisionRef: decision.decisionRef, externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT" };
      }
      let actionId = null;
      try {
        const prepared = state.prepareM6GroundedAction({ decision, slot, timing, fence });
        actionId = prepared.ledger.actionId;
        state.authorizeM6GroundedActionSend({
          actionId,
          fence,
          expectedPermit: { operationKey: decision.operationKey, target: decision.target, bindings: decision.bindings, slot },
          nowMonoMs: monoNow(),
          typedAuthorization,
        });
        const guardStartedMonoMs = monoNow();
        const currentState = await readCurrentState({ session, actionId });
        const privateMaterial = await materializePrivate({
          decision,
          blockSet: provider.blockSet,
          privateGeometry: provider.privateGeometry,
          manifestStep,
        });
        const writeReadyMonoMs = monoNow();
        state.markM6ActionTransportStart({ actionId, currentState, guardStartedMonoMs, writeReadyMonoMs });
        let transportResult;
        try {
          transportResult = await typedTransport.dispatch({
            primitive: manifestStep.primitive,
            target: decision.target,
            trustedParams: manifestStep.trustedParams,
            operationKey: decision.operationKey,
          }, privateMaterial);
        } catch (error) {
          state.recordM6ActionTransportOutcome({ actionId, ok: false, result: {}, errorCode: error.code || "M6_TRANSPORT_UNKNOWN" });
          throw actionError("M6_ACTION_AMBIGUOUS", "transport failed after counter linearization", error);
        }
        state.recordM6ActionTransportOutcome({ actionId, ok: true, result: transportResult });
        const after = await captureWithinRun({ session, phase: "after" });
        const verification = await verifyAfter({ before, after, decision, manifestStep, transportResult });
        const completed = state.completeM6GroundedAction({
          actionId,
          afterObservation: after.observation,
          verification,
          receipt: { actionId, operationKey: decision.operationKey, decisionRef: decision.decisionRef },
        });
        const finalSession = state.validateSession(session.sessionId, session.token);
        if (finalSession.leaseId !== session.leaseId) throw actionError("M6_ACTION_BINDING_MISMATCH", "lease changed before action completion");
        return {
          disposition: "ALLOW_ONCE",
          actionId,
          decisionRef: decision.decisionRef,
          externalEffect: true,
          actionCount: completed.transportCounter,
          effectStatus: "VERIFIED",
          verification,
        };
      } catch (error) {
        if (actionId) {
          const ledger = state.getM6ActionLedger(actionId);
          if (ledger && ledger.transportCounter === 0 && ["ASSESSED", "EXECUTING"].includes(ledger.status)) {
            state.abortM6GroundedActionNotSent({ actionId, errorCode: error.code || "M6_ACTION_ABORTED" });
          }
        }
        throw error;
      }
    },
  });
}
