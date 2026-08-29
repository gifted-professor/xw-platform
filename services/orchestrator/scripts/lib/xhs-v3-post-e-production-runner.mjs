/**
 * Formal post-E XHS V3 runner.
 *
 * This runner is deliberately separate from the R0-R2 production runner so
 * the zero-visual calibration/shadow policy cannot be widened accidentally.
 * It accepts only the task-loaded sealed invocation and a task-owned fresh
 * E-Corpus interlock. R3 grants one global visual pause opportunity to alias
 * 03; alias 04 remains DUMP-only. R4 returns to a small, vision-off wave.
 */
import { createHash, randomUUID } from "node:crypto";

import { EXPLORER_CAPABILITY_ID } from "../../ops/_explore-lease.mjs";
import { createExplorationCoordinator } from "./xhs-exploration-coordinator.mjs";
import {
  canonicalJson,
  validateSealedMission,
} from "./xhs-exploration-mission.mjs";
import {
  acceptSealedRoutinePlan,
} from "./xhs-routine-plan.mjs";
import { createExploreLaneState } from "./xhs-goal-explore-machine.mjs";
import {
  createExplorerTypedDriver,
  runExploreLane,
} from "./xhs-explore-driver.mjs";
import {
  deriveSharedExplorationBudgetProof,
  sealSharedBudgetReservation,
  sharedBudgetKindForNavigationRole,
} from "./xhs-exploration-shared-budget.mjs";

export const XHS_V3_POST_E_PHASES = Object.freeze(["R3", "R4"]);

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const ZERO_VISION = Object.freeze({
  analysisAttempts: 0,
  permitsIssued: 0,
  permitsConsumed: 0,
  physicalTaps: 0,
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function hashObject(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validateRuntimeBinding(binding) {
  const keys = ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId", "accountFingerprint"];
  if (!exactObject(binding, keys)
    || !SAFE_ID.test(String(binding.releaseId ?? ""))
    || !HEX40.test(String(binding.sourceCommit ?? ""))
    || !HEX64.test(String(binding.providerBundleDigest ?? ""))
    || !SAFE_ID.test(String(binding.digestKeyId ?? ""))
    || !HEX64.test(String(binding.accountFingerprint ?? ""))) {
    fail("XHS_V3_RUNTIME_BINDING_INVALID", "post-E task runtime binding is invalid");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, binding[key]])));
}

function outputOf(result) {
  return result?.output ?? result?.result?.output ?? {};
}

function assertActionResult(result, session, primitive) {
  if (result?.status !== "succeeded" || outputOf(result)?.ok !== true
    || result?.authorization?.sessionId !== session.sessionId
    || result?.authorization?.alias !== session.alias) {
    fail("XHS_V3_OBSERVATION_ACTION_INVALID", `${primitive} did not return same-session CP evidence`);
  }
  return outputOf(result);
}

function focusRecord(output) {
  const pkg = String(output?.package ?? output?.pkg ?? "");
  const activity = String(output?.activity ?? "");
  const text = String(output?.focus ?? (pkg && activity ? `${pkg}/${activity}` : pkg));
  return Object.freeze({ package: pkg, activity, text });
}

function assertPostEPhaseMission(phase, mission, runtimeBinding) {
  if (mission.vision?.rolloutPhase !== phase) {
    fail("XHS_V3_PHASE_MISSION_MISMATCH", "post-E phase differs from the sealed rollout phase");
  }
  if (mission.goalRef?.digestKeyId !== runtimeBinding.digestKeyId
    || mission.queries.some((query) => query.digestKeyId !== runtimeBinding.digestKeyId)) {
    fail("XHS_V3_DIGEST_KEY_DRIFT", "post-E mission differs from the active task digest key");
  }
  if (phase === "R3") {
    if (mission.vision?.mode !== "canary1"
      || mission.vision?.provider?.providerBundleDigest !== runtimeBinding.providerBundleDigest
      || mission.vision?.effectiveVisualPermitBudget !== 1
      || mission.budgets?.visionMaxIssuedPermits !== 1
      || mission.budgets?.visionMaxPhysicalTaps !== 1
      || !mission.vision?.eCorpusPassRef) {
      fail("XHS_V3_R3_POLICY_INVALID", "R3 must carry the exact one-shot provider/E-Corpus policy");
    }
    return;
  }
  if (mission.vision?.mode !== "off"
    || mission.vision?.effectiveVisualPermitBudget !== 0
    || mission.budgets?.visionMaxIssuedPermits !== 0
    || mission.budgets?.visionMaxPhysicalTaps !== 0
    || mission.vision?.eCorpusPassRef !== null) {
    fail("XHS_V3_R4_POLICY_INVALID", "R4 must mechanically restore all visual authority to zero");
  }
}

function assertVisionStats(phase, alias, stats) {
  const keys = ["analysisAttempts", "permitsIssued", "permitsConsumed", "physicalTaps"];
  if (!exactObject(stats, keys)
    || Object.values(stats).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("XHS_V3_POST_E_VISION_STATS_INVALID", "post-E vision counters are malformed");
  }
  if (phase === "R4" || alias === "04") {
    if (canonicalJson(stats) !== canonicalJson(ZERO_VISION)) {
      fail("XHS_V3_POST_E_VISUAL_AUTHORITY_DRIFT", `${phase}/${alias} must remain DUMP-only with visual hard zero`);
    }
    return;
  }
  if (stats.permitsIssued > 1 || stats.permitsConsumed > stats.permitsIssued
    || stats.physicalTaps > stats.permitsConsumed || stats.physicalTaps > 1) {
    fail("XHS_V3_R3_ONE_SHOT_EXCEEDED", "R3 alias 03 exceeded the one-shot visual authority");
  }
}

function publicLaneReceipt(receipt, driverStats, visionStats, budgetReservations) {
  return Object.freeze({
    ...receipt,
    driver: Object.freeze({
      observationCount: driverStats.observationCount,
      consumedPermits: driverStats.consumedPermits,
      claimedTargetCount: driverStats.claimedKeys.length,
    }),
    vision: Object.freeze({ ...visionStats }),
    budgetReservations: Object.freeze(budgetReservations.map((entry) => Object.freeze({ ...entry }))),
    safety: Object.freeze({
      socialTransport: 0,
      effectTransport: 0,
      visualIssued: visionStats.permitsIssued,
      visualConsumed: visionStats.permitsConsumed,
      visualPhysical: visionStats.physicalTaps,
    }),
  });
}

/** Construct the fixed R3/R4 runner. No path/provider/alias dependency is accepted at run time. */
export function createXhsV3PostECorpusProductionRunner({
  runtime,
  captureAuthority,
  now = () => Date.now(),
  randomUUIDFn = randomUUID,
  laneTimeoutMs = 10 * 60 * 1000,
} = {}) {
  const requiredRuntimeMethods = [
    "createSession", "releaseSession", "listLeases", "registerExplorationAuthority",
    "getExplorationAuthorityView", "appendExplorationLaneRecord", "closeExplorationAuthority",
    "executeSessionAction", "heartbeatSession", "readDumpArtifact", "issueExplorationPermit",
    "consumeExplorationPermit", "claimExplorationTarget", "confirmExplorationTarget",
    "commitExplorationLane", "captureExplorationFrame", "createExplorationVisionNavigator",
    "reserveExplorationBudget",
  ];
  if (!runtime || requiredRuntimeMethods.some((name) => typeof runtime[name] !== "function")) {
    fail("XHS_V3_RUNTIME_INVALID", "formal post-E Explorer runtime is incomplete");
  }
  if (!captureAuthority
    || typeof captureAuthority.runtimeBinding !== "function"
    || typeof captureAuthority.verifyPrivate !== "function") {
    fail("XHS_V3_CAPTURE_AUTHORITY_INVALID", "task-owned private-payload authority is incomplete");
  }
  const fixedRuntime = validateRuntimeBinding(captureAuthority.runtimeBinding());

  async function run(input = {}) {
    if (!exactObject(input, ["phase", "plan", "privatePayload", "eCorpusInterlock"])) {
      fail("XHS_V3_POST_E_CORPUS_INVOCATION_INVALID", "post-E run accepts only the fixed task seam");
    }
    const phase = String(input.phase ?? "");
    if (!XHS_V3_POST_E_PHASES.includes(phase)) {
      fail("XHS_V3_PHASE_INVALID", "post-E phase must be R3|R4");
    }
    if ((phase === "R3" && typeof input.eCorpusInterlock?.verifyR3 !== "function")
      || (phase === "R4" && input.eCorpusInterlock !== null)) {
      fail("XHS_V3_E_CORPUS_INTERLOCK_INVALID", "only R3 may carry the task-owned E-Corpus interlock");
    }
    const plan = acceptSealedRoutinePlan(input.plan);
    if (plan.template !== "xhs.explore.goal.v1" || plan.parallel !== 2
      || canonicalJson(plan.placement?.aliases) !== canonicalJson(["03", "04"])) {
      fail("XHS_V3_PLAN_INVALID", "post-E runner requires the exact exploration [03,04] plan");
    }
    const mission = validateSealedMission(plan.mission);
    assertPostEPhaseMission(phase, mission, fixedRuntime);
    const privatePayload = captureAuthority.verifyPrivate({
      mission,
      privatePayload: input.privatePayload,
    });
    const waveId = `wave-${phase.toLowerCase()}-${randomUUIDFn()}`;
    if (!SAFE_ID.test(waveId)) fail("XHS_V3_WAVE_ID_INVALID", "generated wave identity is invalid");
    const actorId = "agent:xhs-v3-production";

    const coordinator = createExplorationCoordinator({
      laneTimeoutMs,
      now,
      randomUUIDFn,
      verifyECorpusBeforeAcquire: phase === "R3"
        ? (request) => input.eCorpusInterlock.verifyR3(request)
        : null,
      createSession: ({ alias }) => runtime.createSession({
        actorId,
        capabilityId: EXPLORER_CAPABILITY_ID,
        canary: true,
        placement: { alias },
      }),
      releaseSession: (sessionId, token) => runtime.releaseSession(sessionId, token),
      listLeases: () => runtime.listLeases(),
      registerExplorationAuthority: (request) => runtime.registerExplorationAuthority(request),
      getExplorationAuthorityView: (request) => runtime.getExplorationAuthorityView(request),
      appendLaneRecord: (request) => runtime.appendExplorationLaneRecord(request),
      closeExplorationAuthority: (request) => runtime.closeExplorationAuthority(request),
      startLane: async ({
        child, alias, session, authority, batchControl, executionRunId, routineRunId,
      }) => {
        const laneRole = alias === "03" ? "feed_lane" : "search_lane";
        const visionEnabled = phase === "R3" && alias === "03";
        let actionSequence = 0;
        let budgetSequence = 0;
        let vision = null;
        const budgetReservations = [];

        const journal = async (record) => {
          const { type, laneId: _laneId, alias: _alias, at: _at, ...payload } = record;
          return runtime.appendExplorationLaneRecord({
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
            alias,
            type,
            payload,
          });
        };
        const recordBudgetReservation = async ({
          reservation,
          operationHash,
          navigationRole,
          expectedKind,
        }) => {
          let sealed;
          try {
            sealed = sealSharedBudgetReservation({
              reservation,
              authorityId: authority.authorityId,
              missionHash: mission.missionHash,
              alias,
              operationHash,
              navigationRole,
              expectedKind,
              expectedCap: Number(mission.budgets[expectedKind]),
            });
          } catch (error) {
            fail(
              "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
              "CP shared-budget reservation receipt could not be bound to the post-E lane",
              { causeCode: String(error?.code ?? "UNKNOWN") },
            );
          }
          budgetReservations.push(sealed);
          try {
            await journal({ type: "BUDGET_RESERVED", budgetReservation: sealed });
          } catch (error) {
            fail(
              "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
              "persisted CP budget receipt could not be appended to the post-E lane journal",
              { causeCode: String(error?.code ?? "UNKNOWN") },
            );
          }
          return sealed;
        };
        const reserveNavigationBudget = async (decision) => {
          const kind = sharedBudgetKindForNavigationRole(decision?.navigationRole);
          if (!kind) return null;
          budgetSequence += 1;
          const expectedKind = kind === "resultScreens" ? "resultScreensPerQuery" : kind;
          const operationHash = hashObject({
            schemaId: "xw.xhs.v3-budget-operation.v1",
            authorityId: authority.authorityId,
            missionHash: mission.missionHash,
            alias,
            routineRunId,
            sequence: budgetSequence,
            navigationRole: decision.navigationRole,
            kind,
          });
          let reservation;
          try {
            reservation = await runtime.reserveExplorationBudget({
              sessionId: session.sessionId,
              token: session.token,
              authorityId: authority.authorityId,
              alias,
              kind,
              amount: 1,
              detail: {
                schemaId: "xw.xhs.v3-budget-operation.v1",
                operationHash,
                navigationRole: decision.navigationRole,
                phase,
                routineRunId,
              },
            });
          } catch (error) {
            if (error?.code === "EXPLORATION_BUDGET_EXCEEDED") throw error;
            fail(
              "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
              "shared-budget reservation outcome is uncertain; the post-E lane cannot continue",
              { causeCode: String(error?.code ?? "UNKNOWN") },
            );
          }
          return recordBudgetReservation({
            reservation,
            operationHash,
            navigationRole: decision.navigationRole,
            expectedKind,
          });
        };
        await journal({
          type: "STARTED",
          executionRunId,
          routineRunId,
          missionHash: mission.missionHash,
          planHash: plan.planHash,
          laneRole,
          phase,
          waveDigest: hashObject({ waveId, phase, planHash: plan.planHash }),
        });
        if (visionEnabled) {
          vision = runtime.createExplorationVisionNavigator({
            mode: "canary1",
            providerBinding: mission.vision.provider,
            authorityId: authority.authorityId,
            sessionId: session.sessionId,
            token: session.token,
            routineRunId,
            signal: batchControl.signal,
            journalAppend: journal,
          });
          if (!vision || vision.mode !== "canary1" || typeof vision.proposeCanaryTap !== "function") {
            fail("XHS_V3_R3_VISION_NAVIGATOR_INVALID", "R3 alias 03 lacks the fixed canary navigator");
          }
        }

        const sessionAction = async (primitive) => {
          actionSequence += 1;
          await runtime.heartbeatSession(session.sessionId, session.token);
          return runtime.executeSessionAction(session.sessionId, session.token, {
            capabilityId: EXPLORER_CAPABILITY_ID,
            idempotencyKey: `xhs-v3:${routineRunId}:${actionSequence}:${primitive}`,
            params: { primitive },
          });
        };
        const observeDevice = async () => {
          const focusResult = await sessionAction("focus");
          const focus = focusRecord(assertActionResult(focusResult, session, "focus"));
          const dumpResult = await sessionAction("dump_ui");
          const dumpOutput = assertActionResult(dumpResult, session, "dump_ui");
          let xml = String(dumpOutput.xml ?? "");
          if (!xml && typeof dumpOutput.path === "string") {
            xml = String(runtime.readDumpArtifact({
              path: dumpOutput.path,
              runId: dumpResult.runId,
              jobId: dumpResult.jobId,
              storage: dumpResult.storage,
            }));
          }
          if (!xml) fail("XHS_V3_DUMP_MISSING", "formal DUMP action returned no bound XML");
          return { focus: focus.text, xml, pkg: focus.package || null };
        };

        const driver = createExplorerTypedDriver({
          authorityId: authority.authorityId,
          alias,
          laneId: child.routineRunId,
          laneRole,
          session,
          queries: privatePayload.queries,
          seed: mission.seed,
          observeDevice,
          issuePermit: (request) => runtime.issueExplorationPermit({
            ...request,
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
            ttlMs: mission.budgets.permitTtlMs,
          }),
          consumePermit: (request) => runtime.consumeExplorationPermit({
            ...request,
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
          }),
          claimTarget: (request) => runtime.claimExplorationTarget({
            ...request,
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
            alias,
          }),
          confirmTarget: (request) => runtime.confirmExplorationTarget({
            ...request,
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
          }),
          onPrimitiveBudgetReservation: ({ reservation, navigationRole }) => recordBudgetReservation({
            reservation,
            operationHash: reservation.operationHash,
            navigationRole,
            expectedKind: "reservedPrimitives",
          }),
          journalAppend: journal,
          visionEnabled,
          vision,
          missionStartedAtMs: now(),
          now,
        });
        const laneState = createExploreLaneState({
          laneRole,
          alias,
          seed: mission.seed,
          queries: privatePayload.queries,
          budgets: mission.budgets,
          startedAtMs: now(),
          visionEnabled,
        });
        const cancellableDriver = Object.freeze({
          ...driver,
          async executeNavigation(decision) {
            if (batchControl.signal.aborted) {
              return { navigated: false, novel: null, errorCode: "EXPLORATION_PEER_CANCELLED" };
            }
            await reserveNavigationBudget(decision);
            return driver.executeNavigation(decision);
          },
        });

        try {
          const receipt = await runExploreLane({ driver: cancellableDriver, laneState, now });
          const visionStats = vision?.stats?.() ?? ZERO_VISION;
          assertVisionStats(phase, alias, visionStats);
          if (receipt.restored?.restored !== true) {
            fail("XHS_V3_LANE_CLOSEOUT_INVALID", "post-E lane did not semantically restore");
          }
          const publicReceipt = publicLaneReceipt(
            receipt,
            driver.stats(),
            visionStats,
            budgetReservations,
          );
          await journal({
            type: "LANE_FINISHED",
            outcome: publicReceipt.outcome,
            restored: true,
            safety: publicReceipt.safety,
          });
          const committed = await runtime.commitExplorationLane({
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
          });
          if (!HEX64.test(String(committed?.receiptHash ?? ""))) {
            fail("XHS_V3_LANE_COMMIT_INVALID", "CP did not return a committed post-E lane receipt hash");
          }
          return { receipt: publicReceipt, receiptHash: committed.receiptHash };
        } finally {
          await vision?.close?.();
        }
      },
    });

    const aggregate = await coordinator.startExplorationRun({
      mission,
      actorId,
      planHash: plan.planHash,
      releaseId: fixedRuntime.releaseId,
      sourceCommit: fixedRuntime.sourceCommit,
      accountFingerprint: fixedRuntime.accountFingerprint,
    });
    const visual = aggregate.children.reduce((sum, child) => ({
      issued: sum.issued + Number(child.receipt?.vision?.permitsIssued ?? 0),
      consumed: sum.consumed + Number(child.receipt?.vision?.permitsConsumed ?? 0),
      physical: sum.physical + Number(child.receipt?.vision?.physicalTaps ?? 0),
    }), { issued: 0, consumed: 0, physical: 0 });
    if ((phase === "R3" && (visual.issued > 1 || visual.consumed > visual.issued
      || visual.physical > visual.consumed || visual.physical > 1))
      || (phase === "R4" && Object.values(visual).some((value) => value !== 0))) {
      fail("XHS_V3_POST_E_VISUAL_AUTHORITY_DRIFT", "aggregate post-E visual counters violate the phase cap");
    }
    let effectiveAggregate = aggregate;
    let sharedBudget = null;
    if (aggregate.ok === true) {
      try {
        sharedBudget = deriveSharedExplorationBudgetProof({
          phase,
          authorityId: aggregate.authorityId,
          missionHash: mission.missionHash,
          children: aggregate.children,
          budgetLedger: aggregate.view?.budgetLedger,
          visionCounters: aggregate.view?.visionCounters,
        });
      } catch (error) {
        effectiveAggregate = {
          ...aggregate,
          ok: false,
          status: "BLOCKED",
          error: {
            code: "XHS_V3_SHARED_BUDGET_PROOF_INVALID",
            message: String(error?.message ?? error),
          },
        };
      }
    }
    const authoritativeVisual = sharedBudget ? {
      issued: sharedBudget.used.visualPermitsIssued,
      consumed: sharedBudget.used.visualPermitsConsumed,
      physical: sharedBudget.used.visualPhysicalTaps,
    } : visual;
    return Object.freeze({
      ...effectiveAggregate,
      phase,
      waveDigest: hashObject({ waveId, phase, planHash: plan.planHash }),
      providerBundleDigest: fixedRuntime.providerBundleDigest,
      captureReceiptHashes: Object.freeze([]),
      sharedBudget,
      safety: Object.freeze({
        socialTransport: 0,
        effectTransport: 0,
        visualIssued: authoritativeVisual.issued,
        visualConsumed: authoritativeVisual.consumed,
        visualPhysical: authoritativeVisual.physical,
      }),
    });
  }

  return Object.freeze({ run });
}
