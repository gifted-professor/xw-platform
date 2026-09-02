/**
 * Formal V3 goal-exploration runner wiring.
 *
 * This is the production bridge that was intentionally absent from the pure
 * P1-P3 components.  It owns no endpoint/path/module choices: a Gate-F task
 * constructs it once with the fixed Explorer runtime and a task-owned capture
 * authority.  Per-run input is limited to a sealed plan plus its separately
 * supplied private payload and the rollout phase selected by the task.
 */
import { createHash, randomUUID } from "node:crypto";

import { EXPLORER_CAPABILITY_ID } from "../../ops/_explore-lease.mjs";
import {
  acceptSealedRoutinePlan,
} from "./xhs-routine-plan.mjs";
import {
  canonicalJson,
  validateSealedMission,
  verifyPrivatePayload,
} from "./xhs-exploration-mission.mjs";
import { createExplorationCoordinator } from "./xhs-exploration-coordinator.mjs";
import { createExploreLaneState } from "./xhs-goal-explore-machine.mjs";
import {
  createExplorerTypedDriver,
  runExploreLane,
} from "./xhs-explore-driver.mjs";
import {
  EXPLORE_PAGE,
  parseExploreSurface,
} from "./xhs-explore-surface.mjs";
import {
  buildCpBoundCaptureReceipt,
  sha256Hex,
} from "./xhs-exploration-corpus-operator.mjs";
import {
  deriveSharedExplorationBudgetProof,
  sealSharedBudgetReservation,
  sharedBudgetKindForNavigationRole,
} from "./xhs-exploration-shared-budget.mjs";

export const XHS_V3_RUN_PHASES = Object.freeze(["R0", "R1", "R2"]);
export const XHS_V3_TASK_INVOCATION_SCHEMA_ID = "xw.xhs.v3-task-invocation.v1";
export const XHS_V3_R0_RESULT_SCHEMA_ID = "xw.xhs.v3-r0-fixture-result.v1";

const PHASE_POLICY = Object.freeze({
  R0: Object.freeze({ visionMode: "off", captureMode: "OFFLINE_FIXTURE_ONLY" }),
  R1: Object.freeze({ visionMode: "off", captureMode: "CP_BOUND_R1_R2" }),
  R2: Object.freeze({ visionMode: "shadow", captureMode: "CP_BOUND_R1_R2" }),
});
const ZERO_RESOURCES = Object.freeze({ jobs: 0, sessions: 0, leases: 0, deviceIo: 0 });
const REQUIRED_ROUTES = new Set([
  EXPLORE_PAGE.HOME_FEED,
  EXPLORE_PAGE.SEARCH_RESULTS,
  EXPLORE_PAGE.IMAGE_NOTE,
  EXPLORE_PAGE.VIDEO_NOTE,
  EXPLORE_PAGE.COMMENT_PANEL,
]);
const ROUTE_ROLE = Object.freeze({
  [EXPLORE_PAGE.HOME_FEED]: "OPEN_CONTENT_CARD",
  [EXPLORE_PAGE.SEARCH_RESULTS]: "OPEN_CONTENT_CARD",
  [EXPLORE_PAGE.IMAGE_NOTE]: "OPEN_COMMENT_PANEL",
  [EXPLORE_PAGE.VIDEO_NOTE]: "PAUSE_VIDEO_SAFE_ZONE",
  [EXPLORE_PAGE.COMMENT_PANEL]: "BACK",
});
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function hashObject(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function validateRuntimeBinding(binding) {
  const keys = ["releaseId", "sourceCommit", "providerBundleDigest", "digestKeyId", "accountFingerprint"];
  if (!exactObject(binding, keys)
    || !SAFE_ID.test(String(binding.releaseId ?? ""))
    || !HEX40.test(String(binding.sourceCommit ?? ""))
    || !HEX64.test(String(binding.providerBundleDigest ?? ""))
    || !SAFE_ID.test(String(binding.digestKeyId ?? ""))
    || !HEX64.test(String(binding.accountFingerprint ?? ""))) {
    fail("XHS_V3_RUNTIME_BINDING_INVALID", "task-owned release/source/provider/key/account binding is invalid");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, binding[key]])));
}

function assertPhaseMission(phase, mission, runtimeBinding) {
  const policy = PHASE_POLICY[phase];
  if (!policy) fail("XHS_V3_PHASE_INVALID", "task phase must be R0|R1|R2");
  if (mission.vision?.rolloutPhase !== phase || mission.vision?.mode !== policy.visionMode) {
    fail("XHS_V3_PHASE_MISSION_MISMATCH", `${phase} differs from the sealed rollout/vision policy`);
  }
  if (mission.vision?.effectiveVisualPermitBudget !== 0
    || mission.budgets?.visionMaxIssuedPermits !== 0
    || mission.budgets?.visionMaxPhysicalTaps !== 0
    || mission.vision?.eCorpusPassRef !== null) {
    fail("XHS_V3_VISUAL_BUDGET_NONZERO", `${phase} must mechanically seal visual issued/physical budget zero`);
  }
  if (mission.goalRef?.digestKeyId !== runtimeBinding.digestKeyId
    || mission.queries.some((query) => query.digestKeyId !== runtimeBinding.digestKeyId)) {
    fail("XHS_V3_DIGEST_KEY_DRIFT", "mission private refs differ from the active task-owned digest key");
  }
  if (phase === "R2"
    && mission.vision?.provider?.providerBundleDigest !== runtimeBinding.providerBundleDigest) {
    fail("XHS_V3_PROVIDER_DRIFT", "R2 mission differs from the Gate-F provider bundle");
  }
}

/**
 * Hide the raw HMAC key and raw evidence behind a task-owned authority.
 * `persistCapture` is fixed when the Gate-F task starts; run input cannot pick
 * a path or store.  Only an opaque receipt ref/hash is returned to the lane.
 */
export function createTaskOwnedCpCaptureAuthority({
  signingKey,
  digestKeyId,
  runtimeBinding,
  persistCapture,
} = {}) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== 32) {
    fail("XHS_V3_CAPTURE_KEY_INVALID", "task-owned capture key must be exactly 256 bits");
  }
  if (typeof persistCapture !== "function") {
    fail("XHS_V3_CAPTURE_STORE_REQUIRED", "task-owned private capture persistence is required");
  }
  const fixedRuntime = validateRuntimeBinding({ ...runtimeBinding, digestKeyId });
  const key = Buffer.from(signingKey);

  return Object.freeze({
    runtimeBinding() {
      return fixedRuntime;
    },
    verifyPrivate({ mission, privatePayload }) {
      return verifyPrivatePayload({ mission, privatePayload, digestKey: key });
    },
    async captureCpBound(input) {
      const receipt = buildCpBoundCaptureReceipt({
        ...input,
        releaseId: fixedRuntime.releaseId,
        sourceCommit: fixedRuntime.sourceCommit,
        providerBundleDigest: fixedRuntime.providerBundleDigest,
      }, { signingKey: key, digestKeyId: fixedRuntime.digestKeyId });
      const captureReceiptHash = hashObject(receipt);
      const persisted = await persistCapture(Object.freeze({
        receipt,
        captureReceiptHash,
        raw: Object.freeze({
          pngBytes: Buffer.from(input.pngBytes),
          dumpBytes: Buffer.from(input.dumpBytes),
          focusBytes: Buffer.from(input.focusBytes),
        }),
      }));
      const expectedRef = `receipt:${captureReceiptHash}`;
      if (!exactObject(persisted, ["receiptRef"])
        || persisted.receiptRef !== expectedRef) {
        fail("XHS_V3_CAPTURE_STORE_INVALID", "private capture store returned a non-canonical receipt ref");
      }
      return Object.freeze({
        captureReceiptHash,
        receiptRef: expectedRef,
        pageClass: receipt.classification.pageClass,
        evaluationRole: receipt.classification.evaluationRole,
        captureMode: receipt.captureMode,
        phase: receipt.provenance.phase,
      });
    },
  });
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

function regionsOf(decision, evaluationRole) {
  const regions = [];
  if (decision?.positiveRegion) {
    regions.push({ kind: "positive", role: evaluationRole, ...decision.positiveRegion });
  }
  for (const zone of decision?.protectedZones ?? []) {
    regions.push({ kind: `protected:${String(zone.kind ?? "zone")}`, ...zone });
  }
  return regions;
}

function captureAllowed(page, alias) {
  if (!REQUIRED_ROUTES.has(page)) return false;
  if (page === EXPLORE_PAGE.HOME_FEED) return alias === "03";
  if (page === EXPLORE_PAGE.SEARCH_RESULTS) return alias === "04";
  return ["03", "04"].includes(alias);
}

function publicLaneReceipt(receipt, captures, driverStats, visionStats, budgetReservations) {
  return Object.freeze({
    ...receipt,
    captures: Object.freeze(captures.map((entry) => Object.freeze({ ...entry }))),
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
      visualIssued: 0,
      visualConsumed: 0,
      visualPhysical: 0,
    }),
  });
}

/** Construct the exact formal runner. No run-time dependency override exists. */
export function createXhsV3ProductionRunner({
  runtime,
  captureAuthority,
  r0FixtureRunner,
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
    fail("XHS_V3_RUNTIME_INVALID", "formal Explorer runtime is incomplete");
  }
  if (!captureAuthority
    || typeof captureAuthority.runtimeBinding !== "function"
    || typeof captureAuthority.verifyPrivate !== "function"
    || typeof captureAuthority.captureCpBound !== "function") {
    fail("XHS_V3_CAPTURE_AUTHORITY_INVALID", "task-owned capture authority is incomplete");
  }
  if (typeof r0FixtureRunner !== "function") {
    fail("XHS_V3_R0_FIXTURE_REQUIRED", "task-owned R0 fixture runner is required");
  }
  const fixedRuntime = validateRuntimeBinding(captureAuthority.runtimeBinding());

  async function runR0() {
    const result = await r0FixtureRunner();
    if (!exactObject(result, ["schemaId", "phase", "captureMode", "runtime", "resources", "status"])
      || result.schemaId !== XHS_V3_R0_RESULT_SCHEMA_ID
      || result.phase !== "CALIBRATION_ONLY"
      || result.captureMode !== "OFFLINE_FIXTURE_ONLY"
      || result.status !== "PASS"
      || canonicalJson(result.runtime) !== canonicalJson(fixedRuntime)
      || canonicalJson(result.resources) !== canonicalJson(ZERO_RESOURCES)) {
      fail("XHS_V3_R0_FIXTURE_INVALID", "R0 must be task-owned, calibration-only, and create zero live resources");
    }
    return Object.freeze({
      ok: true,
      phase: "R0",
      status: "SUCCEEDED",
      captureMode: result.captureMode,
      resources: ZERO_RESOURCES,
      receiptHash: hashObject(result),
    });
  }

  async function run(input = {}) {
    if (!exactObject(input, ["phase", "plan", "privatePayload"])) {
      fail("XHS_V3_INVOCATION_FIELDS_FORBIDDEN", "run accepts only phase, sealed plan, and private payload");
    }
    const phase = String(input.phase ?? "");
    if (!XHS_V3_RUN_PHASES.includes(phase)) fail("XHS_V3_PHASE_INVALID", "phase must be R0|R1|R2");
    const plan = acceptSealedRoutinePlan(input.plan);
    if (plan.template !== "xhs.explore.goal.v1" || plan.parallel !== 2
      || canonicalJson(plan.placement?.aliases) !== canonicalJson(["03", "04"])) {
      fail("XHS_V3_PLAN_INVALID", "production V3 runner requires the exact exploration [03,04] plan");
    }
    const mission = validateSealedMission(plan.mission);
    assertPhaseMission(phase, mission, fixedRuntime);
    // This is deliberately before R0 and before either createSession call.
    const privatePayload = captureAuthority.verifyPrivate({ mission, privatePayload: input.privatePayload });
    if (phase === "R0") return runR0();

    const waveId = `wave-${phase.toLowerCase()}-${randomUUIDFn()}`;
    if (!SAFE_ID.test(waveId)) fail("XHS_V3_WAVE_ID_INVALID", "generated wave identity is invalid");
    const captureCounts = new Map();
    const actorId = "agent:xhs-v3-production";

    const coordinator = createExplorationCoordinator({
      laneTimeoutMs,
      now,
      randomUUIDFn,
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
        const corpusLaneRole = alias === "03" ? "FEED" : "SEARCH";
        const captures = [];
        let actionSequence = 0;
        let budgetSequence = 0;
        let shadowedEvidenceHash = null;
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
              "CP shared-budget reservation receipt could not be bound to the lane",
              { causeCode: String(error?.code ?? "UNKNOWN") },
            );
          }
          budgetReservations.push(sealed);
          try {
            await journal({ type: "BUDGET_RESERVED", budgetReservation: sealed });
          } catch (error) {
            fail(
              "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
              "persisted CP budget receipt could not be appended to the lane journal",
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
              "shared-budget reservation outcome is uncertain; the lane cannot continue",
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

        if (phase === "R2") {
          vision = runtime.createExplorationVisionNavigator({
            mode: "shadow",
            providerBinding: mission.vision.provider,
            authorityId: authority.authorityId,
            sessionId: session.sessionId,
            token: session.token,
            routineRunId,
            signal: batchControl.signal,
            journalAppend: journal,
          });
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
          if (!xml) fail("XHS_V3_DUMP_MISSING", "formal dump action returned no bound XML");
          const surface = parseExploreSurface({
            xml,
            focus: focus.text,
            pkg: focus.package || null,
            laneRole,
            seed: mission.seed,
          });
          const evidenceHash = createHash("sha256").update(xml, "utf8").digest("hex");

          if (captureAllowed(surface.page, alias)
            && (captureCounts.get(surface.page) ?? 0) < 2) {
            const frame = await runtime.captureExplorationFrame({
              sessionId: session.sessionId,
              token: session.token,
              routineRunId,
              signal: batchControl.signal,
            });
            const evaluationRole = ROUTE_ROLE[surface.page];
            const capture = await captureAuthority.captureCpBound({
              pngBytes: frame.bytes,
              dumpBytes: Buffer.from(xml, "utf8"),
              focusBytes: Buffer.from(canonicalJson(focus), "utf8"),
              pageClass: surface.page,
              evaluationRole,
              dumpDecision: {
                verdict: surface.dumpDecision.verdict,
                reasons: surface.dumpDecision.reasons,
                regions: regionsOf(surface.dumpDecision, evaluationRole),
              },
              alias,
              laneRole: corpusLaneRole,
              phase,
              sessionId: session.sessionId,
              leaseId: session.leaseId,
              authorityId: authority.authorityId,
              waveId,
              surfaceClaim: `surface:${hashObject({
                page: surface.page,
                alias,
                evidenceHash,
              })}`,
            });
            if (capture.captureMode !== "CP_BOUND_R1_R2" || capture.phase !== phase) {
              fail("XHS_V3_CAPTURE_MODE_INVALID", "live route capture was not sealed CP_BOUND_R1_R2");
            }
            captureCounts.set(surface.page, (captureCounts.get(surface.page) ?? 0) + 1);
            captures.push(capture);
            await journal({
              type: "CORPUS_CAPTURED",
              pageClass: capture.pageClass,
              evaluationRole: capture.evaluationRole,
              captureReceiptHash: capture.captureReceiptHash,
              receiptRef: capture.receiptRef,
              phase,
            });
          }

          // R2 invokes the real pinned provider only as shadow and only for the
          // parent-plan visual fallback role. It never enters the permit path.
          if (phase === "R2" && surface.page === EXPLORE_PAGE.VIDEO_NOTE
            && ["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(surface.dumpDecision?.verdict)
            && shadowedEvidenceHash !== evidenceHash) {
            shadowedEvidenceHash = evidenceHash;
            await vision.observeShadow({
              navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
              page: surface.page,
              evidenceHash,
              dumpDecision: surface.dumpDecision,
              signal: batchControl.signal,
            });
          }
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
          // R2 provider work is the explicit shadow hook above. The machine
          // never sees a visual navigation method in R1/R2.
          visionEnabled: false,
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
          visionEnabled: false,
        });
        // Cooperative cancellation is observed at the machine's next safe
        // decision boundary. Cleanup still receives the original typed driver,
        // so BACK/semantic restoration remains shielded from peer cancellation.
        const cancellableDriver = Object.freeze({
          ...driver,
          async executeNavigation(decision) {
            if (batchControl.signal.aborted) {
              return {
                navigated: false,
                novel: null,
                errorCode: "EXPLORATION_PEER_CANCELLED",
              };
            }
            await reserveNavigationBudget(decision);
            return driver.executeNavigation(decision);
          },
        });

        try {
          const receipt = await runExploreLane({ driver: cancellableDriver, laneState, now });
          const visionStats = vision?.stats?.() ?? {
            analysisAttempts: 0, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0,
          };
          if (visionStats.permitsIssued !== 0 || visionStats.permitsConsumed !== 0
            || visionStats.physicalTaps !== 0 || receipt.restored?.restored !== true) {
            fail("XHS_V3_LANE_CLOSEOUT_INVALID", "R1/R2 lane must restore with zero visual permit/tap counters");
          }
          const publicReceipt = publicLaneReceipt(
            receipt,
            captures,
            driver.stats(),
            visionStats,
            budgetReservations,
          );
          await journal({
            type: "LANE_FINISHED",
            outcome: publicReceipt.outcome,
            restored: true,
            captureReceiptHashes: captures.map((capture) => capture.captureReceiptHash),
            safety: publicReceipt.safety,
          });
          const committed = await runtime.commitExplorationLane({
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
          });
          if (!HEX64.test(String(committed?.receiptHash ?? ""))) {
            fail("XHS_V3_LANE_COMMIT_INVALID", "CP did not return a committed lane receipt hash");
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
    return Object.freeze({
      ...effectiveAggregate,
      phase,
      waveDigest: hashObject({ waveId, phase, planHash: plan.planHash }),
      providerBundleDigest: fixedRuntime.providerBundleDigest,
      captureReceiptHashes: Object.freeze(aggregate.children
        .flatMap((child) => child.receipt?.captures ?? [])
        .map((capture) => capture.captureReceiptHash)
        .sort()),
      sharedBudget,
      safety: Object.freeze({
        socialTransport: 0,
        effectTransport: 0,
        visualIssued: 0,
        visualConsumed: 0,
        visualPhysical: 0,
      }),
    });
  }

  return Object.freeze({ run });
}
