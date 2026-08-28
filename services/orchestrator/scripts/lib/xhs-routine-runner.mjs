/**
 * XW-owned XHS routine runner.
 *
 * This is the deterministic read-only orchestration boundary. It owns one
 * formal Control Plane Explorer session/lease for the whole run while staying
 * outside the frozen M6 Control Plane TCB. Social effects remain fail-closed
 * until the effect bridge is backed by the same persisted owner tuple.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  acceptSealedRoutinePlan,
  bindRoutineExecution,
  bindRoutineExecutionBatch,
  planRoutine,
} from "./xhs-routine-plan.mjs";
import { createRoutineRun } from "./xhs-feed-routine-machine.mjs";
import {
  createRoutineAuthorityRuntime,
  createRoutineEffectsSurface,
} from "./xhs-routine-authority.mjs";
import { ROUTINE_VISION_MODES } from "./xhs-routine-vision-navigator.mjs";
import {
  bindTargetFingerprint,
  classifyPage,
  PAGE_CLASS,
} from "./xhs-feed-surface.mjs";

const EXPLORER_CAPABILITY_ID = "xiaowei.explorer.primitive";

const XHS_PACKAGE = "com.xingin.xhs";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"]);

function fail(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function canonical(value) {
  return JSON.stringify(value, (_, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]));
    }
    return nested;
  });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function publicPlan(plan) {
  const { templateSpec: _templateSpec, ...sealed } = plan;
  return sealed;
}

function publicRun(run) {
  if (!run) return null;
  const { sessionToken: _sessionToken, ...safe } = run;
  return structuredClone(safe);
}

function outputOf(result) {
  if (!result || typeof result !== "object") return {};
  if (result.result?.output && typeof result.result.output === "object") return result.result.output;
  if (result.output && typeof result.output === "object") return result.output;
  if (result.result?.result?.output && typeof result.result.result.output === "object") return result.result.result.output;
  return result.result && typeof result.result === "object" ? result.result : result;
}

function statusOk(result) {
  const status = String(result?.status ?? result?.result?.status ?? "").toLowerCase();
  const output = outputOf(result);
  return status === "succeeded" && output?.ok === true;
}

function focusParts(output) {
  const focus = output?.focus && typeof output.focus === "object" ? output.focus : output;
  return {
    package: focus?.package ?? focus?.pkg ?? null,
    activity: focus?.activity ?? null,
    text: typeof focus === "string"
      ? focus
      : [focus?.package ?? focus?.pkg, focus?.activity].filter(Boolean).join("/"),
  };
}

function dumpXmlOf(output) {
  for (const value of [output?.xml, output?.dumpXml, output?.hierarchy, output?.uiXml, output?.text]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function normalizeDisplaySize(profile) {
  const metadata = profile?.metadata && typeof profile.metadata === "object" ? profile.metadata : profile;
  const display = metadata?.display && typeof metadata.display === "object" ? metadata.display : metadata;
  const width = Number(display?.width ?? display?.displayWidth ?? display?.screenWidth);
  const height = Number(display?.height ?? display?.displayHeight ?? display?.screenHeight);
  if (Number.isInteger(width) && Number.isInteger(height) && width >= 320 && height >= 640) {
    return { width, height, source: "device-profile" };
  }
  return null;
}

function displayBounds(xml, profile = null) {
  const fromProfile = normalizeDisplaySize(profile);
  if (fromProfile) return fromProfile;
  let rootWidth = 0;
  let rootHeight = 0;
  const pattern = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  for (const match of String(xml || "").matchAll(pattern)) {
    if (Number(match[1]) !== 0 || Number(match[2]) !== 0) continue;
    rootWidth = Math.max(rootWidth, Number(match[3]));
    rootHeight = Math.max(rootHeight, Number(match[4]));
  }
  if (rootWidth < 320 || rootHeight < 640) return null;
  return { width: rootWidth, height: rootHeight, source: "root-bounds" };
}

/**
 * Build the production driver used by XhsRoutineRunner. Every primitive is
 * sent through the already acquired formal CP Explorer session.
 */
export function createControlPlaneRoutineDriver({
  execution,
  session,
  executeSessionAction,
  heartbeatSession = null,
  releaseSession,
  listLeases,
  readDumpArtifact,
  readScreenArtifact = null,
  deviceProfile = null,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (!execution?.executionRunId || !execution?.routineRunId) {
    throw new TypeError("createControlPlaneRoutineDriver requires a bound routine execution");
  }
  if (!session?.sessionId || !session?.leaseId || !session?.token || !session?.deviceId) {
    throw new TypeError("createControlPlaneRoutineDriver requires a formal session/lease/token/device binding");
  }
  if (typeof executeSessionAction !== "function" || typeof releaseSession !== "function"
    || typeof listLeases !== "function" || typeof readDumpArtifact !== "function") {
    throw new TypeError("createControlPlaneRoutineDriver requires CP action/release/lease/artifact authority functions");
  }

  let sequence = 0;
  let released = false;
  let restored = false;
  let releaseResult = null;
  let lastObservation = null;
  let framesCaptured = 0;
  // the canary visual tap cap (§8.2): at most ONE vision-authorized tap per run
  let visualTaps = 0;
  // Aggregate-trace authority: every primitive keeps its CP-level
  // jobId/status/output.ok/evidenceRef alongside the unwrapped business value
  // (plan V2 §5.2) — the acceptance tool reads this, not the unwrapped output.
  const primitiveTrace = [];

  async function primitive(params) {
    if (released) throw fail("ROUTINE_SESSION_RELEASED", "routine session is already released", 409);
    if (typeof heartbeatSession === "function") {
      await heartbeatSession(session.sessionId, session.token);
    }
    sequence += 1;
    const seq = sequence;
    let result = null;
    try {
      result = await executeSessionAction(session.sessionId, session.token, {
        capabilityId: EXPLORER_CAPABILITY_ID,
        idempotencyKey: `xhs-routine:${execution.routineRunId}:${seq}`,
        params,
      });
    } catch (error) {
      primitiveTrace.push({
        seq,
        primitive: params.primitive,
        jobId: null,
        status: String(error?.code || error?.name || "PRIMITIVE_TRANSPORT_FAILED"),
        outputOk: false,
        evidenceRef: null,
      });
      throw error;
    }
    if (!statusOk(result)) {
      primitiveTrace.push({
        seq,
        primitive: params.primitive,
        jobId: result?.jobId ?? result?.result?.jobId ?? null,
        status: result?.status ?? result?.result?.status ?? null,
        outputOk: false,
        evidenceRef: result?.evidenceRef ?? result?.result?.evidenceRef
          ?? result?.runId ?? result?.result?.runId ?? null,
      });
      throw fail("ROUTINE_PRIMITIVE_FAILED", `Explorer primitive ${params.primitive} did not succeed`, 409, {
        primitive: params.primitive,
        status: result?.status ?? null,
      });
    }
    let output = outputOf(result);
    if (params.primitive === "dump_ui" && !dumpXmlOf(output) && typeof output?.path === "string") {
      const xml = await readDumpArtifact({
        path: output.path,
        runId: result?.runId ?? result?.result?.runId ?? null,
        jobId: result?.jobId ?? result?.result?.jobId ?? null,
        storage: result?.storage ?? result?.result?.storage ?? null,
      });
      output = { ...output, xml };
    }
    if (params.primitive === "screen" && typeof output?.path === "string" && typeof readScreenArtifact === "function") {
      // the PNG is re-read through the strict bound-artifact reader — the CP
      // evidence copy is the only accepted byte source (never output.bytes)
      const png = await readScreenArtifact({
        path: output.path,
        runId: result?.runId ?? result?.result?.runId ?? null,
        storage: result?.storage ?? result?.result?.storage ?? null,
      });
      output = { ...output, bytes: png };
    }
    primitiveTrace.push({
      seq,
      primitive: params.primitive,
      jobId: result?.jobId ?? result?.result?.jobId ?? null,
      status: result?.status ?? result?.result?.status ?? null,
      outputOk: output?.ok === true,
      evidenceRef: result?.evidenceRef ?? result?.result?.evidenceRef
        ?? result?.runId ?? result?.result?.runId ?? null,
    });
    return output;
  }

  // Video detail surfaces (DetailFeedActivity) play video while uiautomator
  // waits for UI idle, so dump can transiently fail with EXPLORER_DUMP_* /
  // EXPLORER_SCREEN_* (live R1 finding, 2026-08-28). Observations retry with
  // patience instead of aborting the run; all other primitive failures stay
  // fatal (fail-closed, zero transport).
  const DUMP_RETRYABLE_CODES = /^EXPLORER_(DUMP|SCREEN)_[A-Z_]+$/;
  const DUMP_RETRY_ATTEMPTS = 3;
  const DUMP_RETRY_SPACING_MS = 2000;

  async function observe(label = "observe") {
    const focusOutput = await primitive({ primitive: "focus" });
    let dumpOutput = null;
    let dumpError = null;
    for (let attempt = 0; attempt < DUMP_RETRY_ATTEMPTS; attempt += 1) {
      try {
        dumpOutput = await primitive({ primitive: "dump_ui" });
        dumpError = null;
        break;
      } catch (error) {
        dumpError = error;
        if (!DUMP_RETRYABLE_CODES.test(String(error?.code || ""))) throw error;
        if (attempt + 1 < DUMP_RETRY_ATTEMPTS) await sleepFn(DUMP_RETRY_SPACING_MS);
      }
    }
    if (dumpError) throw dumpError;
    const focus = focusParts(focusOutput);
    const xml = dumpXmlOf(dumpOutput);
    const observation = {
      label,
      xml,
      focus: focus.text,
      pkg: focus.package,
      activity: focus.activity,
      hash: sha256(canonical({ xml, package: focus.package, activity: focus.activity })),
    };
    lastObservation = observation;
    return observation;
  }

  function pageOf(observation, sourceCardKind = null) {
    return classifyPage({
      xml: observation?.xml || "",
      focus: observation?.focus || "",
      pkg: observation?.pkg,
      sourceCardKind,
    });
  }

  async function restoreFeed() {
    try {
      let observation = null;
      try {
        observation = await observe("cleanup-before-release");
      } catch (error) {
        // a dump-starved surface (playing video resumed by the app) cannot be
        // classified; one back press is read-only navigation that typically
        // restores a dumpable surface (live R1 finding, 2026-08-28)
        if (!DUMP_RETRYABLE_CODES.test(String(error?.code || ""))) return false;
        await primitive({ primitive: "back", times: 1 });
        await sleepFn(800);
        observation = await observe("cleanup-before-release-after-back");
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (pageOf(observation).page === PAGE_CLASS.HOME_FEED) return true;
        await primitive({ primitive: "back", times: 1 });
        await sleepFn(250);
        observation = await observe(`cleanup-back-${attempt + 1}`);
      }
      return pageOf(observation).page === PAGE_CLASS.HOME_FEED;
    } catch {
      return false;
    }
  }

  return {
    getPrimitiveTrace() {
      return primitiveTrace.slice();
    },

    async getExecutionBinding() {
      return {
        alias: execution.alias,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      };
    },

    async ensureFeed() {
      let observation = null;
      try {
        observation = await observe("ensure-feed");
      } catch (error) {
        // parked on a dump-starved surface (a playing video the app resumed):
        // one back press is read-only navigation that typically restores a
        // dumpable surface (live R1 finding, 2026-08-28)
        if (!DUMP_RETRYABLE_CODES.test(String(error?.code || ""))) throw error;
        await primitive({ primitive: "back", times: 1 });
        await sleepFn(800);
        observation = await observe("ensure-feed-after-back");
      }
      if (pageOf(observation).page === PAGE_CLASS.HOME_FEED) return { ok: true, observation };
      await primitive({ primitive: "launch_app", package: XHS_PACKAGE });
      await sleepFn(800);
      observation = await observe("ensure-feed-after-launch");
      return { ok: pageOf(observation).page === PAGE_CLASS.HOME_FEED, observation };
    },

    async refresh() {
      const observation = await observe("refresh-preflight");
      if (pageOf(observation).page !== PAGE_CLASS.HOME_FEED) {
        return { ok: false, reason: "REFRESH_NOT_ON_FEED" };
      }
      const bounds = displayBounds(observation.xml, deviceProfile);
      if (!bounds) return { ok: false, reason: "DISPLAY_BOUNDS_UNAVAILABLE" };
      const x = Math.round(bounds.width * 0.5);
      await primitive({
        primitive: "swipe",
        x1: x,
        y1: Math.round(bounds.height * 0.28),
        x2: x,
        y2: Math.round(bounds.height * 0.72),
        durationMs: 500,
      });
      await sleepFn(800);
      const after = await observe("refresh-post");
      return { ok: pageOf(after).page === PAGE_CLASS.HOME_FEED, observation: after };
    },

    dump({ label } = {}) {
      return observe(label || "dump");
    },

    /**
     * Session-bound frame capture for the vision navigator (§8.2): the screen
     * primitive's evidence copy is re-read through the strict bound-artifact
     * reader, so the navigator only ever segments CP-owned bytes.
     */
    async screenshot() {
      const output = await primitive({ primitive: "screen" });
      if (!Buffer.isBuffer(output?.bytes) || output.bytes.length === 0 || typeof output?.path !== "string") {
        throw fail("ROUTINE_SCREENSHOT_UNAVAILABLE", "screen primitive returned no bound PNG bytes", 409);
      }
      framesCaptured += 1;
      return {
        pngPath: output.path,
        bytes: output.bytes,
        frameId: `screen:${execution.routineRunId}:${framesCaptured}`,
        capturedAt: now(),
      };
    },

    getVisualTapCount() {
      return visualTaps;
    },

    async pauseVideoAndDump({ label } = {}) {
      // Playing videos starve uiautomator idle indefinitely (live R1 finding,
      // 2026-08-28): dump retries alone never recover. One center-surface tap
      // pauses playback so the follow-up dump observes a static surface. This
      // is a navigation tap (pause), not a social effect; callers bound it to
      // at most one per opened item.
      let bounds = null;
      try {
        bounds = displayBounds(lastObservation?.xml || "", deviceProfile);
      } catch {
        bounds = null;
      }
      const width = Number(bounds?.width) || 1080;
      const height = Number(bounds?.height) || 2340;
      await primitive({
        primitive: "tap",
        x: Math.round(width / 2),
        y: Math.round(height / 2),
      });
      await sleepFn(800);
      return observe(label || "detail-after-pause");
    },

    async tapAt({ x, y, source, targetFingerprint, cardKind, visionPermit }) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, noAction: true, reason: "TAP_POINT_INVALID" };
      if (source === "vision-r0") {
        // Transport-bound re-validation of the machine-validated permit, then
        // the ONE physical tap the canary permit may ever carry (§8.2). No dump
        // recheck happens here — vision is used precisely when the dump is
        // sparse, and the permit is already frame-bound + replay-fenced.
        if (!visionPermit
          || visionPermit.actionClass !== "R0_NAVIGATION"
          || visionPermit.oneShot !== true
          || visionPermit.consumed === true
          || visionPermit.effectControl === true) {
          return { ok: false, noAction: true, reason: "VISION_PERMIT_REJECTED" };
        }
        if (!Number.isFinite(Number(visionPermit.expiresAtMs)) || Number(visionPermit.expiresAtMs) <= now()) {
          return { ok: false, noAction: true, reason: "VISION_PERMIT_EXPIRED" };
        }
        if (visualTaps >= 1) {
          return { ok: false, noAction: true, reason: "VISION_TAP_CAP_REACHED" };
        }
        visualTaps += 1;
        await primitive({ primitive: "tap", x: Math.round(x), y: Math.round(y) });
        await sleepFn(350);
        let after = null;
        try {
          after = await observe("vision-tap-detail-verify");
        } catch (error) {
          // same rescue ladder as dump-sourced opens: a video card starves the
          // dump; one pause tap recovers the verify observation
          if (cardKind !== "video" || !DUMP_RETRYABLE_CODES.test(String(error?.code || ""))) throw error;
          after = await this.pauseVideoAndDump({ label: "vision-tap-detail-verify-after-pause" });
        }
        const detail = pageOf(after, cardKind || null);
        const opened = detail.page === PAGE_CLASS.IMAGE_NOTE || detail.page === PAGE_CLASS.VIDEO_NOTE;
        return { ok: opened, x: Math.round(x), y: Math.round(y), detailPage: detail.page, source: "vision-r0" };
      }
      if (source !== "dump") {
        return { ok: false, noAction: true, reason: "VISION_PROVIDER_NOT_WIRED" };
      }
      const before = await observe("tap-target-recheck");
      const feed = pageOf(before);
      if (feed.page !== PAGE_CLASS.HOME_FEED || !targetFingerprint) {
        return { ok: false, noAction: true, reason: "TAP_TARGET_RECHECK_FAILED" };
      }
      const exact = feed.cards.filter((card) => bindTargetFingerprint({
        cardTitle: card.title,
        cardAuthor: card.author,
        cardCenter: { x: card.cx, y: card.cy },
        pageEvidence: feed.page,
      }) === targetFingerprint);
      if (exact.length !== 1 || exact[0].cx !== Math.round(x) || exact[0].cy !== Math.round(y)) {
        return { ok: false, noAction: true, reason: "TAP_TARGET_DRIFT" };
      }
      await primitive({ primitive: "tap", x: Math.round(x), y: Math.round(y) });
      await sleepFn(350);
      let after = null;
      try {
        after = await observe("tap-detail-verify");
      } catch (error) {
        // the opened card may be a playing video whose surface starves the
        // dump (live R1 finding): for video cards one pause tap rescues the
        // verify observation; anything else stays fatal
        if (cardKind !== "video" || !DUMP_RETRYABLE_CODES.test(String(error?.code || ""))) throw error;
        after = await this.pauseVideoAndDump({ label: "tap-detail-verify-after-pause" });
      }
      const detail = pageOf(after, cardKind || null);
      const opened = detail.page === PAGE_CLASS.IMAGE_NOTE || detail.page === PAGE_CLASS.VIDEO_NOTE;
      return { ok: opened, x: Math.round(x), y: Math.round(y), detailPage: detail.page };
    },

    async back() {
      await primitive({ primitive: "back", times: 1 });
      await sleepFn(250);
      const observation = await observe("back-verify");
      const focusVerified = pageOf(observation).page === PAGE_CLASS.HOME_FEED;
      if (focusVerified) restored = true;
      return { ok: true, focusVerified, observation };
    },

    async swipeComments({ screens }) {
      const count = Number(screens);
      if (!Number.isInteger(count) || count < 0 || count > 3) {
        return { ok: false, reason: "COMMENT_SCREEN_BOUND_INVALID" };
      }
      let observation = lastObservation || await observe("comments-preflight");
      const bounds = displayBounds(observation.xml, deviceProfile);
      if (!bounds) return { ok: false, reason: "DISPLAY_BOUNDS_UNAVAILABLE" };
      for (let i = 0; i < count; i += 1) {
        await primitive({
          primitive: "swipe",
          x1: Math.round(bounds.width * 0.5),
          y1: Math.round(bounds.height * 0.78),
          x2: Math.round(bounds.width * 0.5),
          y2: Math.round(bounds.height * 0.42),
          durationMs: 450,
        });
        await sleepFn(350);
        observation = await observe(`comments-${i + 1}`);
      }
      return { ok: true, screens: count, observation };
    },

    async waitFor(ms) {
      const bounded = Math.max(0, Math.min(Number(ms) || 0, 60_000));
      await sleepFn(bounded);
      return { ok: true, ms: bounded };
    },

    async release() {
      if (released) return { ok: releaseResult?.ok === true, reused: true };
      restored = await restoreFeed();
      for (let attempt = 1; attempt <= 2 && !released; attempt += 1) {
        try {
          const result = await releaseSession(session.sessionId, session.token);
          releaseResult = { ok: result?.released !== false, result, attempts: attempt };
          released = releaseResult.ok;
        } catch (error) {
          releaseResult = {
            ok: false,
            error: String(error?.code || error?.message || error),
            attempts: attempt,
          };
        }
      }
      return releaseResult;
    },

    async getCleanupStatus() {
      if (!released) {
        return {
          activeLeases: null,
          restored,
          authorityRef: "control-plane:listLeases:pre-release",
          observedAtMs: now(),
        };
      }
      const leases = await listLeases();
      const rows = Array.isArray(leases) ? leases : [];
      const owned = rows.filter((lease) => lease?.leaseId === session.leaseId || lease?.sessionId === session.sessionId);
      return {
        activeLeases: owned.length,
        globalActiveLeases: rows.length,
        restored,
        authorityRef: "control-plane:StateStore.listLeases",
        observedAtMs: now(),
      };
    },
  };
}

export class XhsRoutineRunner {
  constructor({
    createSession,
    executeSessionAction,
    heartbeatSession = null,
    releaseSession,
    listLeases,
    readDumpArtifact,
    getDevice,
    // production social-effect authority (plan V2 §8.1.3): required ONLY when a
    // social plan runs; read-only waves stay zero-dependency
    registerRoutineAuthority = null,
    commitRoutineAuthorityEffect = null,
    reconcileRoutineAuthorityComments = null,
    closeRoutineAuthority = null,
    // production vision seam (plan V2 §8.2): a factory that builds the pinned
    // real-provider navigator for one run; absent + non-fallback mode fails closed
    createVisionNavigator = null,
    readScreenArtifact = null,
    sleepFn = null,
    now = () => Date.now(),
  } = {}) {
    for (const [name, fn] of Object.entries({
      createSession,
      executeSessionAction,
      releaseSession,
      listLeases,
      readDumpArtifact,
      getDevice,
    })) {
      if (typeof fn !== "function") throw new TypeError(`XhsRoutineRunner requires ${name}`);
    }
    this.createSession = createSession;
    this.executeSessionAction = executeSessionAction;
    this.heartbeatSession = typeof heartbeatSession === "function" ? heartbeatSession : null;
    this.releaseSession = releaseSession;
    this.listLeases = listLeases;
    this.readDumpArtifact = readDumpArtifact;
    this.getDevice = getDevice;
    this.authorityRuntime = (registerRoutineAuthority && commitRoutineAuthorityEffect
      && reconcileRoutineAuthorityComments && closeRoutineAuthority)
      ? createRoutineAuthorityRuntime({
          register: registerRoutineAuthority,
          commitEffect: commitRoutineAuthorityEffect,
          reconcileComments: reconcileRoutineAuthorityComments,
          closeAuthority: closeRoutineAuthority,
        })
      : null;
    this.createVisionNavigator = typeof createVisionNavigator === "function" ? createVisionNavigator : null;
    this.readScreenArtifact = typeof readScreenArtifact === "function" ? readScreenArtifact : null;
    this.sleepFn = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now;
    this.runs = new Map();
    this.activeAliases = new Map();
  }

  plan(input = {}) {
    const plan = planRoutine({
      templateId: input.templateId || input.template,
      params: input.params || {},
      alias: input.alias,
      parallel: input.parallel ?? 1,
      actor: input.actorId || input.actor || null,
      goalSignature: input.goalSignature || null,
    });
    return publicPlan(plan);
  }

  listRuns() {
    return [...this.runs.values()].map(publicRun);
  }

  getRun(runId) {
    return publicRun(this.runs.get(String(runId || "")) || null);
  }

  async start(input = {}) {
    const semanticPlan = input.plan
      ? acceptSealedRoutinePlan(input.plan)
      : planRoutine({
          templateId: input.templateId || input.template,
          params: input.params || {},
          alias: input.alias,
          parallel: input.parallel ?? 1,
          actor: input.actorId || input.actor || null,
          goalSignature: input.goalSignature || null,
        });
    const expectedAliases = semanticPlan.placement?.aliases || [semanticPlan.alias];
    const requestedAliases = input.executionRequest?.aliases;
    const expectedMode = semanticPlan.parallel === 2 ? "parallel" : "single";
    const requestedMode = input.executionRequest?.mode;
    if (requestedMode && requestedMode !== expectedMode) {
      throw fail("ROUTINE_EXECUTION_REQUEST_TAMPERED", "executionRequest.mode does not match the sealed placement", 409, {
        expectedMode,
      });
    }
    if (requestedAliases && canonical(requestedAliases) !== canonical(expectedAliases)) {
      throw fail("ROUTINE_EXECUTION_REQUEST_TAMPERED", "executionRequest.aliases does not match the sealed placement", 409, {
        expectedAliases,
      });
    }
    if (semanticPlan.effectClass !== "none" && !this.authorityRuntime) {
      throw fail(
        "ROUTINE_SOCIAL_AUTHORITY_UNAVAILABLE",
        "social routines require the production routine-authority runtime (register/commit/reconcile/close)",
        409,
      );
    }

    // sealed vision mode (§8.2): fallback (default) | shadow | canary. Unknown
    // modes are a tamper signal, never a degradation to fallback.
    const visionMode = input.visionMode == null ? "fallback" : String(input.visionMode);
    if (!ROUTINE_VISION_MODES.includes(visionMode)) {
      throw fail("ROUTINE_VISION_MODE_INVALID", `vision mode must be one of ${ROUTINE_VISION_MODES.join("|")}`, 400, {
        visionMode,
      });
    }
    if (visionMode !== "fallback" && (!this.createVisionNavigator || !this.readScreenArtifact)) {
      throw fail(
        "ROUTINE_VISION_TRANSPORT_UNAVAILABLE",
        "non-fallback vision requires the production navigator factory and the bound screen-artifact reader",
        409,
      );
    }

    // explicit [03,04] read-only batch (§8.3): sealed coordinator, never a
    // downgrade to a single device and never a fallback alias swap
    if (semanticPlan.parallel === 2) {
      return this._startParallelBatch(semanticPlan, input, visionMode);
    }

    const execution = bindRoutineExecution(semanticPlan, { alias: "03" });
    if (this.activeAliases.has(execution.alias)) {
      throw fail("ROUTINE_ALIAS_BUSY", `alias ${execution.alias} already has an active routine`, 423, {
        activeRunId: this.activeAliases.get(execution.alias),
      });
    }

    const createdAt = new Date(this.now()).toISOString();
    const run = {
      schemaId: "xw.xhs.routine-run.v1",
      executionRunId: execution.executionRunId,
      routineRunId: execution.routineRunId,
      planHash: execution.planHash,
      template: execution.template,
      alias: execution.alias,
      effectClass: execution.effectClass,
      status: "ACQUIRING",
      serverVerified: false,
      ok: false,
      sessionId: null,
      leaseId: null,
      deviceId: null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      receipt: null,
      error: null,
      cleanupRecovery: null,
    };
    this.runs.set(run.executionRunId, run);
    this.activeAliases.set(run.alias, run.executionRunId);

    // declared outside the try so failure/cleanup paths can keep the
    // authoritative per-primitive trace (a const inside try is invisible in
    // catch and would raise ReferenceError over the original error)
    let session = null;
    let driver = null;
    let authority = null;
    let effects = null;
    try {
      session = await this.createSession({
        actorId: input.actorId || execution.actor || "agent:xhs-routine",
        capabilityId: EXPLORER_CAPABILITY_ID,
        canary: true,
        placement: { alias: execution.alias },
      });
      run.sessionId = session.sessionId;
      run.leaseId = session.leaseId;
      run.deviceId = session.deviceId;
      run.sessionToken = session.token;
      run.visionMode = visionMode;

      // social lane (§8.1.3): register the CP-owned authority bound to THIS
      // formal session before any machine step runs. --canary-authorized is a
      // REQUEST only — the server seals the grant into canaryPolicy.
      if (execution.effectClass === "social") {
        authority = await this.authorityRuntime.register({
          sessionId: session.sessionId,
          token: session.token,
          executionRunId: execution.executionRunId,
          routineRunId: execution.routineRunId,
          planHash: execution.planHash,
          alias: execution.alias,
          effectCaps: {
            like: Number(semanticPlan.params?.likeMax ?? 0) || 0,
            comment: Number(semanticPlan.params?.commentMax ?? 0) || 0,
          },
          canaryAuthorized: input.canaryAuthorized === true,
          accountFingerprint: input.accountFingerprint ?? null,
        });
        run.authorityId = authority.authorityId;
        effects = createRoutineEffectsSurface({
          authority,
          runtime: this.authorityRuntime,
          sessionId: session.sessionId,
          token: session.token,
        });
      }
      run.status = "RUNNING";
      run.updatedAt = new Date(this.now()).toISOString();
      const deviceProfile = await this.getDevice(session.deviceId);

      driver = createControlPlaneRoutineDriver({
        execution,
        session,
        executeSessionAction: this.executeSessionAction,
        heartbeatSession: this.heartbeatSession,
        releaseSession: this.releaseSession,
        listLeases: this.listLeases,
        readDumpArtifact: this.readDumpArtifact,
        readScreenArtifact: this.readScreenArtifact,
        deviceProfile,
        sleepFn: this.sleepFn,
        now: this.now,
      });
      // vision navigator is built per-run against THIS driver's session-bound
      // capture (§8.2); a factory failure is a failed run, never a fallback
      let visionNavigator = null;
      if (visionMode !== "fallback") {
        visionNavigator = await this.createVisionNavigator({
          mode: visionMode,
          execution,
          session,
          driver,
        });
      }
      const receipt = await createRoutineRun({ execution, plan: execution, driver, effects, visionNavigator }).execute();
      run.receipt = receipt;
      // aggregate trace keeps the per-primitive CP metadata (jobId/status/
      // output.ok/evidenceRef) as an independent authority alongside the
      // unwrapped machine receipt (plan V2 §5.2)
      run.primitiveTrace = driver.getPrimitiveTrace();
      run.visualTaps = driver.getVisualTapCount();
      run.status = TERMINAL.has(receipt.status) ? receipt.status : "FAILED";
      const verifiedOpenedItems = Array.isArray(receipt.items)
        ? receipt.items.filter((item) => item?.opened === true).length
        : 0;
      run.ok = run.status === "SUCCEEDED"
        && receipt.cleanup?.verified === true
        && verifiedOpenedItems > 0;
      if (run.status === "SUCCEEDED" && verifiedOpenedItems === 0) {
        run.status = "BLOCKED";
      }
      run.serverVerified = run.ok;
      if (!run.ok) {
        run.error = {
          code: verifiedOpenedItems === 0 ? "ROUTINE_NO_VERIFIED_ITEM" : (receipt.stopReason || "ROUTINE_NOT_SUCCEEDED"),
          message: `routine terminal status ${run.status}`,
        };
      }
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
    } catch (error) {
      run.status = "FAILED";
      run.ok = false;
      run.serverVerified = false;
      run.error = {
        code: error?.code || "ROUTINE_RUN_FAILED",
        message: String(error?.message || error),
      };
      if (typeof driver?.getPrimitiveTrace === "function") {
        // failed runs keep their primitive metadata too — acceptance needs the
        // authoritative per-primitive record even for BLOCKED/FAILED closes
        run.primitiveTrace = driver.getPrimitiveTrace();
        run.visualTaps = driver.getVisualTapCount();
      }
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
    } finally {
      // §8.1: the authority dies with the run — close it explicitly with the
      // outcome reason BEFORE the session release (which would otherwise close
      // it as "session-released"). Double-close is idempotent CP-side.
      if (authority?.authorityId && session?.sessionId) {
        try {
          const reason = run.status === "SUCCEEDED" ? "run-succeeded" : `run-${String(run.status || "failed").toLowerCase()}`;
          const closed = await this.authorityRuntime.closeAuthority({
            sessionId: session.sessionId,
            token: session.token,
            authorityId: authority.authorityId,
            reason,
          });
          run.authorityClosed = closed?.status === "closed";
        } catch (error) {
          run.authorityClosed = false;
          run.authorityCloseError = String(error?.code || error?.message || error);
        }
      }
      let ownedLeases = null;
      let fallbackRelease = null;
      if (session?.sessionId && session?.leaseId) {
        try {
          const current = await this.listLeases();
          ownedLeases = (Array.isArray(current) ? current : []).filter(
            (lease) => lease?.leaseId === session.leaseId || lease?.sessionId === session.sessionId,
          );
          if (ownedLeases.length > 0) {
            try {
              const released = await this.releaseSession(session.sessionId, session.token);
              fallbackRelease = { ok: released?.released !== false };
            } catch (error) {
              fallbackRelease = { ok: false, error: String(error?.code || error?.message || error) };
            }
            const after = await this.listLeases();
            ownedLeases = (Array.isArray(after) ? after : []).filter(
              (lease) => lease?.leaseId === session.leaseId || lease?.sessionId === session.sessionId,
            );
          }
        } catch (error) {
          ownedLeases = null;
          fallbackRelease = { ok: false, error: String(error?.code || error?.message || error) };
        }
        run.cleanupRecovery = {
          attempted: Boolean(fallbackRelease),
          release: fallbackRelease,
          activeOwnedLeases: Array.isArray(ownedLeases) ? ownedLeases.length : null,
          observedAt: new Date(this.now()).toISOString(),
        };
      }
      if (Array.isArray(ownedLeases) && ownedLeases.length === 0) {
        this.activeAliases.delete(run.alias);
      } else if (!session) {
        this.activeAliases.delete(run.alias);
      } else {
        run.status = "BLOCKED";
        run.ok = false;
        run.serverVerified = false;
        run.error = {
          code: "ROUTINE_LEASE_CLEANUP_UNRESOLVED",
          message: "routine lease cleanup could not be authoritatively confirmed",
        };
      }
      delete run.sessionToken;
    }
    return publicRun(run);
  }

  /**
   * Explicit [03,04] read-only batch coordinator (§8.3): acquire order is
   * fixed 03→04; if 04 cannot be acquired, 03 is released BEFORE any device
   * action and the aggregate never downgrades to a single device. Children
   * share the executionRunId but own their routineRunId/session/lease/trace;
   * closeout is all-settled, and any unresolved child cleanup BLOCKs the
   * aggregate. 04 never receives a social bridge (effectClass is sealed none).
   */
  async _startParallelBatch(semanticPlan, input, visionMode) {
    if (semanticPlan.effectClass !== "none") {
      throw fail("ROUTINE_SECONDARY_EFFECT_CLASS_FORBIDDEN", "parallel [03,04] batch must be effectClass none", 409);
    }
    const batch = bindRoutineExecutionBatch(semanticPlan);
    const [child03, child04] = batch.children;
    for (const child of [child03, child04]) {
      if (this.activeAliases.has(child.alias)) {
        throw fail("ROUTINE_ALIAS_BUSY", `alias ${child.alias} already has an active routine`, 423, {
          activeRunId: this.activeAliases.get(child.alias),
        });
      }
    }

    const createdAt = new Date(this.now()).toISOString();
    const run = {
      schemaId: "xw.xhs.routine-run.v1",
      mode: "parallel-batch",
      executionRunId: batch.executionRunId,
      routineRunId: batch.executionRunId,
      planHash: batch.planHash,
      template: batch.template ?? semanticPlan.template,
      alias: "03+04",
      aliases: [...batch.aliases],
      effectClass: "none",
      visionMode,
      status: "ACQUIRING",
      serverVerified: false,
      ok: false,
      sessionId: null,
      leaseId: null,
      deviceId: null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      children: [],
      receipt: null,
      error: null,
    };
    this.runs.set(run.executionRunId, run);

    const acquire = (child) => this.createSession({
      actorId: input.actorId || child.actor || "agent:xhs-routine",
      capabilityId: EXPLORER_CAPABILITY_ID,
      canary: true,
      placement: { alias: child.alias },
    });

    // acquire 03 first — its failure means nothing started anywhere
    let session03 = null;
    try {
      session03 = await acquire(child03);
    } catch (error) {
      run.status = "BLOCKED";
      run.error = {
        code: "ROUTINE_PARALLEL_ACQUIRE_FAILED",
        message: `primary 03 acquire failed: ${String(error?.code || error?.message || error)}; batch never started, no device action`,
      };
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
      return publicRun(run);
    }
    let session04 = null;
    try {
      session04 = await acquire(child04);
    } catch (error) {
      // §8.3: release 03 BEFORE any device action; no single-device downgrade
      let secondaryRelease = null;
      try {
        const released = await this.releaseSession(session03.sessionId, session03.token);
        secondaryRelease = { ok: released?.released !== false };
      } catch (releaseError) {
        secondaryRelease = { ok: false, error: String(releaseError?.code || releaseError?.message || releaseError) };
      }
      run.status = "BLOCKED";
      run.error = {
        code: "ROUTINE_PARALLEL_ACQUIRE_FAILED",
        message: `secondary 04 acquire failed: ${String(error?.code || error?.message || error)}; primary 03 released before any device action`,
        secondaryRelease,
      };
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
      return publicRun(run);
    }

    this.activeAliases.set(child03.alias, run.executionRunId);
    this.activeAliases.set(child04.alias, run.executionRunId);
    run.status = "RUNNING";
    run.sessionId = session03.sessionId;
    run.deviceId = session03.deviceId;

    const settled = await Promise.allSettled([
      this._runParallelLane(child03, session03, input, visionMode),
      this._runParallelLane(child04, session04, input, visionMode),
    ]);
    run.children = settled.map((lane) => (lane.status === "fulfilled"
      ? lane.value
      : {
          status: "FAILED",
          ok: false,
          serverVerified: false,
          executionRunId: null,
          routineRunId: null,
          alias: null,
          error: { code: "ROUTINE_LANE_FAILED", message: String(lane.reason?.code || lane.reason?.message || lane.reason) },
        }));

    const allVerified = run.children.every(
      (child) => child.status === "SUCCEEDED" && child.ok === true
        && child.cleanupRecovery?.activeOwnedLeases === 0,
    );
    run.status = allVerified ? "SUCCEEDED" : "BLOCKED";
    run.ok = allVerified;
    run.serverVerified = allVerified;
    run.receipt = {
      schemaId: "xw.xhs.routine-parallel-receipt.v1",
      cleanup: { verified: allVerified },
      children: run.children.map((child) => ({
        alias: child.alias,
        routineRunId: child.routineRunId,
        status: child.status,
        opened: Array.isArray(child.receipt?.items)
          ? child.receipt.items.filter((item) => item?.opened === true).length
          : 0,
      })),
    };
    if (!allVerified) {
      run.error = {
        code: "ROUTINE_PARALLEL_NOT_VERIFIED",
        message: "aggregate SUCCEEDED requires both [03,04] children SUCCEEDED with verified cleanup",
      };
    }
    run.finishedAt = new Date(this.now()).toISOString();
    run.updatedAt = run.finishedAt;
    this.activeAliases.delete(child03.alias);
    this.activeAliases.delete(child04.alias);
    return publicRun(run);
  }

  /** One read-only lane of the parallel batch: its own session/driver/receipt. */
  async _runParallelLane(child, session, input, visionMode) {
    const run = {
      schemaId: "xw.xhs.routine-run.v1",
      mode: "parallel-child",
      executionRunId: child.executionRunId,
      routineRunId: child.routineRunId,
      planHash: child.planHash,
      template: child.template,
      alias: child.alias,
      effectClass: child.effectClass,
      visionMode,
      status: "RUNNING",
      serverVerified: false,
      ok: false,
      sessionId: session.sessionId,
      leaseId: session.leaseId,
      deviceId: session.deviceId,
      sessionToken: session.token,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: null,
      finishedAt: null,
      receipt: null,
      error: null,
      cleanupRecovery: null,
    };
    this.runs.set(child.routineRunId, run);
    let driver = null;
    try {
      const deviceProfile = await this.getDevice(session.deviceId);
      driver = createControlPlaneRoutineDriver({
        execution: child,
        session,
        executeSessionAction: this.executeSessionAction,
        heartbeatSession: this.heartbeatSession,
        releaseSession: this.releaseSession,
        listLeases: this.listLeases,
        readDumpArtifact: this.readDumpArtifact,
        readScreenArtifact: this.readScreenArtifact,
        deviceProfile,
        sleepFn: this.sleepFn,
        now: this.now,
      });
      let visionNavigator = null;
      if (visionMode !== "fallback") {
        visionNavigator = await this.createVisionNavigator({
          mode: visionMode,
          execution: child,
          session,
          driver,
        });
      }
      // read-only lane: no effects surface exists for a parallel child — 04
      // never gets a social bridge, and 03's parallel twin doesn't either
      const receipt = await createRoutineRun({ execution: child, plan: child, driver, effects: null, visionNavigator }).execute();
      run.receipt = receipt;
      run.primitiveTrace = driver.getPrimitiveTrace();
      run.visualTaps = driver.getVisualTapCount();
      run.status = TERMINAL.has(receipt.status) ? receipt.status : "FAILED";
      const verifiedOpenedItems = Array.isArray(receipt.items)
        ? receipt.items.filter((item) => item?.opened === true).length
        : 0;
      run.ok = run.status === "SUCCEEDED"
        && receipt.cleanup?.verified === true
        && verifiedOpenedItems > 0;
      if (run.status === "SUCCEEDED" && verifiedOpenedItems === 0) {
        run.status = "BLOCKED";
      }
      run.serverVerified = run.ok;
      if (!run.ok) {
        run.error = {
          code: verifiedOpenedItems === 0 ? "ROUTINE_NO_VERIFIED_ITEM" : (receipt.stopReason || "ROUTINE_NOT_SUCCEEDED"),
          message: `parallel child terminal status ${run.status}`,
        };
      }
    } catch (error) {
      run.status = "FAILED";
      run.ok = false;
      run.serverVerified = false;
      run.error = {
        code: error?.code || "ROUTINE_RUN_FAILED",
        message: String(error?.message || error),
      };
      if (typeof driver?.getPrimitiveTrace === "function") {
        run.primitiveTrace = driver.getPrimitiveTrace();
        run.visualTaps = driver.getVisualTapCount();
      }
    } finally {
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
      // per-lane lease cleanup: identical standard to the single-device path —
      // an unresolved owned lease BLOCKs this lane and therefore the aggregate
      let ownedLeases = null;
      let fallbackRelease = null;
      try {
        const current = await this.listLeases();
        ownedLeases = (Array.isArray(current) ? current : []).filter(
          (lease) => lease?.leaseId === session.leaseId || lease?.sessionId === session.sessionId,
        );
        if (ownedLeases.length > 0) {
          try {
            const released = await this.releaseSession(session.sessionId, session.token);
            fallbackRelease = { ok: released?.released !== false };
          } catch (error) {
            fallbackRelease = { ok: false, error: String(error?.code || error?.message || error) };
          }
          const after = await this.listLeases();
          ownedLeases = (Array.isArray(after) ? after : []).filter(
            (lease) => lease?.leaseId === session.leaseId || lease?.sessionId === session.sessionId,
          );
        }
      } catch (error) {
        ownedLeases = null;
        fallbackRelease = { ok: false, error: String(error?.code || error?.message || error) };
      }
      run.cleanupRecovery = {
        attempted: Boolean(fallbackRelease),
        release: fallbackRelease,
        activeOwnedLeases: Array.isArray(ownedLeases) ? ownedLeases.length : null,
        observedAt: new Date(this.now()).toISOString(),
      };
      if (!(Array.isArray(ownedLeases) && ownedLeases.length === 0)) {
        run.status = "BLOCKED";
        run.ok = false;
        run.serverVerified = false;
        run.error = {
          code: "ROUTINE_LEASE_CLEANUP_UNRESOLVED",
          message: "parallel child lease cleanup could not be authoritatively confirmed",
        };
      }
      this.activeAliases.delete(child.alias);
      delete run.sessionToken;
    }
    return publicRun(run);
  }
}

export { EXPLORER_CAPABILITY_ID };
