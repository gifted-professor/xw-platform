import { performance } from "node:perf_hooks";

import { canonicalJson, sha256 } from "./canonical.mjs";
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
      const active = state.validateSession(session.sessionId, session.token);
      if (active.leaseId !== session.leaseId || active.sessionId !== bindings.sessionId || active.leaseId !== bindings.leaseId
        || active.scopeCapabilityId !== "xiaowei.m6.grounded_run" || active.canary !== true) {
        throw actionError("M6_ACTION_BINDING_MISMATCH", "composite run session/lease binding changed");
      }
      const before = await captureWithinRun({ session, phase: "before" });
      const provider = deriveLiveVisualBlockSet({
        frame: before.frame,
        dumpXml: before.dumpXml,
        environmentAttestation,
      });
      if (!provider.blockSet) {
        return { disposition: provider.disposition, externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT", reason: provider.reason };
      }
      const typedAuthorizationId = typedAuthorization?.authorizationId || typedAuthorization?.authorization?.authorizationId;
      const storedTypedAuthorization = state.getTransportActionAuthorization(typedAuthorizationId);
      const capabilityJob = storedTypedAuthorization?.jobId ? state.getJob(storedTypedAuthorization.jobId) : null;
      if (!storedTypedAuthorization || !capabilityJob) {
        throw actionError("M6_TYPED_AUTH_BINDING_MISMATCH", "grounded-run typed authority is unavailable");
      }
      const selectedBlock = intent.targetKind === "block"
        ? provider.blockSet.blocks.find((candidate) => candidate.blockId === candidateBlockId)
        : null;
      const boundsRef = selectedBlock?.boundsRef ?? null;
      const authorityBindings = Object.freeze({
        ...bindings,
        jobId: storedTypedAuthorization.jobId,
        deviceId: storedTypedAuthorization.deviceId,
        capabilityId: "xiaowei.m6.grounded_run",
        capabilityContractHash: storedTypedAuthorization.capabilityContractHash,
        implementationClosureHash: storedTypedAuthorization.implementationClosureHash,
        sessionScopeCapabilityId: active.scopeCapabilityId,
        canary: active.canary,
        alias: "01",
        actionSlotSpecHash: frozenSlot.actionSlotSpecHash,
        logicalStepId: frozenSlot.logicalStepId,
        actionSlotOrdinal: frozenSlot.actionSlotOrdinal,
        primitive: frozenSlot.primitive,
        targetKind: frozenSlot.targetKind,
        trustedParameterHash: frozenSlot.trustedParameterHash,
        effectBoundaryHash: frozenSlot.effectBoundaryHash,
        resetPolicyHash: frozenSlot.resetPolicyHash,
        oracleHash: frozenSlot.oracleHash,
      });
      const decision = decideLiveGrounding({
        frame: before.frame,
        blockSet: provider.blockSet,
        intent,
        candidateBlockId,
        bindings: authorityBindings,
      });
      if (decision.disposition !== "ALLOW_ONCE") {
        return { disposition: decision.disposition, decisionRef: decision.decisionRef, externalEffect: false, actionCount: 0, effectStatus: "NOT_SENT" };
      }
      const permitSlot = Object.freeze({
        ...slot,
        slotSpecHash: frozenSlot.actionSlotSpecHash,
        primitive: frozenSlot.primitive,
        targetKind: frozenSlot.targetKind,
        intentRef: frozenSlot.intentRef,
        trustedParameterHash: frozenSlot.trustedParameterHash,
        effectBoundaryHash: frozenSlot.effectBoundaryHash,
        resetPolicyHash: frozenSlot.resetPolicyHash,
        oracleHash: frozenSlot.oracleHash,
        frameId: decision.target.kind === "none" ? null : decision.target.frameId,
        blockId: decision.target.kind === "block" ? decision.target.blockId : null,
        boundsRef,
        appRef: manifestStep.trustedParams.appRef ?? null,
        textRef: manifestStep.trustedParams.textRef ?? null,
      });
      if (slot.frameId !== undefined && slot.frameId !== permitSlot.frameId
        || slot.blockId !== undefined && slot.blockId !== permitSlot.blockId) {
        throw actionError("M6_ACTION_SLOT_BINDING_MISMATCH", "live frame/block drifted from the frozen slot candidate");
      }
      const typedInvocation = validateM6TypedInvocation({
        primitive: manifestStep.primitive,
        target: decision.target,
        trustedParams: manifestStep.trustedParams,
        operationKey: intent.operationKey,
      });
      if (!typedInvocation.writePrimitive) {
        throw actionError("M6_ACTION_PRIMITIVE_NOT_WRITE", "grounded action facade accepts only bounded write primitives");
      }
      let actionId = null;
      try {
        const prepared = state.prepareM6GroundedAction({ decision, slot: permitSlot, timing, fence });
        actionId = prepared.ledger.actionId;
        state.authorizeM6GroundedActionSend({
          actionId,
          fence,
          expectedPermit: { operationKey: decision.operationKey, target: decision.target, bindings: decision.bindings, slot: permitSlot },
          nowMonoMs: monoNow(),
          typedAuthorization,
        });
        const currentState = await readCurrentState({ session, actionId });
        // A real live-strict capture may take seconds. The 250ms TCB deadline
        // begins only after that independently verified fresh state returns;
        // it still covers every subsequent private-material step up to counter
        // linearization and never starts before an awaited device observation.
        const guardStartedMonoMs = monoNow();
        const privateMaterial = await materializePrivate({
          decision,
          blockSet: provider.blockSet,
          privateGeometry: provider.privateGeometry,
          manifestStep,
        });
        const authoritativePrivateMaterial = decision.target.kind === "block"
          ? {
            ...privateMaterial,
            bounds: privateMaterial?.bounds ?? provider.privateGeometry.get(boundsRef),
            boundsRef: privateMaterial?.boundsRef ?? boundsRef,
          }
          : privateMaterial;
        const writeReadyMonoMs = monoNow();
        const privateAuthority = Object.freeze({
          schemaId: "xw.m6-private-dispatch-authority.v1",
          operationKey: decision.operationKey,
          decisionRef: decision.decisionRef,
          slotSpecHash: frozenSlot.actionSlotSpecHash,
          primitive: frozenSlot.primitive,
          target: decision.target,
          trustedParameterHash: frozenSlot.trustedParameterHash,
          currentStateHash: sha256(`xw.m6-current-state.v1:${canonicalJson(currentState)}`),
          boundsRef,
          appRef: permitSlot.appRef,
          textRef: permitSlot.textRef,
        });
        const preparedWrite = typedTransport.prepareWrite(typedInvocation, authoritativePrivateMaterial, privateAuthority);
        state.markM6ActionTransportStart({
          actionId,
          currentState,
          guardStartedMonoMs,
          writeReadyMonoMs,
          privateMaterialBinding: preparedWrite.binding,
        });
        let transportResult;
        try {
          transportResult = await typedTransport.dispatchPrepared(preparedWrite);
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
