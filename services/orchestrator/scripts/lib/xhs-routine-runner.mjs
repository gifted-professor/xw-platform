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
  planRoutine,
} from "./xhs-routine-plan.mjs";
import { createRoutineRun } from "./xhs-feed-routine-machine.mjs";
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

    async tapAt({ x, y, source, targetFingerprint, cardKind }) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, noAction: true, reason: "TAP_POINT_INVALID" };
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
    if (semanticPlan.parallel !== 1) {
      throw fail(
        "ROUTINE_PARALLEL_EXECUTOR_UNAVAILABLE",
        "explicit [03,04] placement is sealed, but the atomic dual-session coordinator is not implemented yet",
        501,
      );
    }
    if (semanticPlan.effectClass !== "none") {
      throw fail(
        "ROUTINE_SOCIAL_AUTHORITY_UNAVAILABLE",
        "social routines remain closed until their CP owner/oracle/ECP chain is production-wired",
        409,
      );
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
        deviceProfile,
        sleepFn: this.sleepFn,
        now: this.now,
      });
      const receipt = await createRoutineRun({ execution, plan: execution, driver }).execute();
      run.receipt = receipt;
      // aggregate trace keeps the per-primitive CP metadata (jobId/status/
      // output.ok/evidenceRef) as an independent authority alongside the
      // unwrapped machine receipt (plan V2 §5.2)
      run.primitiveTrace = driver.getPrimitiveTrace();
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
      }
      run.finishedAt = new Date(this.now()).toISOString();
      run.updatedAt = run.finishedAt;
    } finally {
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
}

export { EXPLORER_CAPABILITY_ID };
