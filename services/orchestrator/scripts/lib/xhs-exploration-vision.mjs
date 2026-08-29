// xhs-exploration-vision.mjs — V3 exploration vision seam (plan V3 §5.5,
// phase P4). Layering is fixed: the pinned local provider may emit
// navigation-role CANDIDATES only; the Control Plane remains the permit
// issuer (fresh recheck + ≤5,000 ms TTL + single-use consume) and the lane
// driver remains the only caller of performPermitted. Shadow observations
// never authorize a tap (tapAuthorized false forever); canary1 adds at most
// the one global R0 navigation tap. All provider work is asynchronous,
// cancellable, and queue-bounded so lane heartbeat/deadline timers always
// get the event loop back (no execFileSync, no busy waits).
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readFileSync } from "node:fs";

import {
  canonicalJson,
  EXPLORATION_BUDGET_CAPS,
  EXPLORATION_VISION_MODES,
} from "./xhs-exploration-mission.mjs";
import { isEffectControlLabel } from "./xhs-vision-shadow.mjs";
import {
  readPngDims,
  selectBlock,
} from "../../ops/xw-adaptive-visual-tap.mjs";

export const EXPLORATION_VISION_CONFIG_SCHEMA_ID = "xw.xhs.exploration-vision-config.v1";

/** Constant timing seams (plan §3.3 caps; never raised at runtime). */
export const EXPLORATION_VISION_DEADLINE_MS = EXPLORATION_BUDGET_CAPS.providerDecisionDeadlineMs;
export const EXPLORATION_VISION_FRAME_MAX_AGE_MS = EXPLORATION_BUDGET_CAPS.frameMaxAgeMs;
export const EXPLORATION_VISION_ISSUED_PERMIT_TTL_MS = EXPLORATION_BUDGET_CAPS.permitTtlMs;
export const EXPLORATION_VISION_MIN_CONFIDENCE = 0.9;

/** Bounded queueing: at most ONE provider analysis in flight per lane. */
export const EXPLORATION_VISION_MAX_INFLIGHT = 1;
export const EXPLORATION_VISION_QUEUE_MAX = 2;

/** Navigation roles the provider may ever propose candidates for (closed). */
export const EXPLORATION_VISION_ROLES = Object.freeze(["PAUSE_VIDEO_SAFE_ZONE"]);
export const EXPLORATION_VISION_ELIGIBLE_DUMP_VERDICTS = Object.freeze(new Set([
  "AMBIGUOUS_SAFE",
  "ABSENT_OR_INVALID",
]));

export const VISION_CORPUS_ROLES = Object.freeze([
  "HOME_FEED",
  "SEARCH_RESULTS",
  "IMAGE_NOTE",
  "VIDEO_NOTE",
  "COMMENT_PANEL",
]);

export const VISION_CORPUS_PAGE_CLASSES = Object.freeze([
  ...VISION_CORPUS_ROLES,
  "SEARCH_HOME",
  "UNKNOWN_OR_FORBIDDEN",
]);

export function visionError(code, message, { status = 409, details = {} } = {}) {
  return Object.assign(new Error(message), { code, name: "ExplorationVisionError", status, details });
}

/** Streaming sha256 (works for large model/python byte pins). */
export function hashFilePinned(path) {
  if (!existsSync(path)) {
    throw visionError("EXPLORATION_VISION_PIN_FILE_MISSING", `pinned file is absent: ${path}`);
  }
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (let n = 0; (n = readSync(fd, chunk, 0, chunk.length)) > 0; ) {
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Resolve and RE-VERIFY the pinned provider config at startup
 * (plan §5.5: pin and re-hash the actual Python executable, analysis script,
 * model bytes, and configuration). The config declares expected sha256 pins;
 * the actual bytes are re-hashed from disk on every resolve — any drift fails
 * closed (vision unusable, not degraded). The public provider identity is
 * content-addressed: model/script sha256 pins plus a sha256 over the
 * normalized config body itself.
 */
export function resolvePinnedVisionConfig(configPath, {
  hashFile = hashFilePinned,
} = {}) {
  if (!configPath) {
    throw visionError("EXPLORATION_VISION_CONFIG_MISSING", "vision pin config path is required");
  }
  if (!existsSync(configPath)) {
    throw visionError(
      "EXPLORATION_VISION_CONFIG_ABSENT",
      `exploration vision provider config is absent: ${configPath}`,
    );
  }
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", `vision pin config unreadable: ${error?.message || error}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", `vision pin config is not valid JSON: ${error?.message || error}`);
  }
  if (config?.schemaId !== EXPLORATION_VISION_CONFIG_SCHEMA_ID || config?.schemaVersion !== 1) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", `vision pin config needs schemaId ${EXPLORATION_VISION_CONFIG_SCHEMA_ID}`);
  }
  const files = config?.pin ?? null;
  if (!files || !isPinnedFile(files.python) || !isPinnedFile(files.script) || !isPinnedFile(files.model)) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config needs pin.{python,script,model} = {path, sha256}");
  }
  const rules = config?.rules ?? null;
  if (!rules) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config needs rules{mode,targetLabels}");
  }
  if (!EXPLORATION_VISION_MODES.includes(rules.mode) || rules.mode === "off") {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config rules.mode must be shadow or canary1 (off never runs a provider)");
  }
  if (!Array.isArray(rules.targets) || rules.targets.length === 0
    || rules.targets.some((t) => typeof t !== "string" || !t.trim())) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config rules.targets must be a non-empty label list");
  }
  if (!Array.isArray(rules.roles) || rules.roles.length !== EXPLORATION_VISION_ROLES.length
    || rules.roles.some((r) => !EXPLORATION_VISION_ROLES.includes(r))) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config rules.roles are outside the closed visual role set");
  }
  if (rules.allowEffectLabels !== false || rules.maxAnalysisAttemptsGlobal !== 6) {
    throw visionError(
      "EXPLORATION_VISION_CONFIG_INVALID",
      "vision pin config must set allowEffectLabels=false and maxAnalysisAttemptsGlobal=6",
    );
  }
  // re-hash every pinned byte at startup — a tampered pin never runs
  const rehash = {
    python: hashFile(files.python.path),
    script: hashFile(files.script.path),
    model: hashFile(files.model.path),
  };
  for (const kind of ["python", "script", "model"]) {
    if (rehash[kind] !== files[kind].sha256) {
      throw visionError(
        "EXPLORATION_VISION_PIN_DRIFT",
        `pinned ${kind} bytes drifted from the sealed config (expected ${files[kind].sha256}, actual ${rehash[kind]})`,
        { details: { kind } },
      );
    }
  }
  const analysis = config?.analysis ?? null;
  if (!analysis || analysis.protocol !== "xw.xhs.exploration-vision-process.v1"
    || !Number.isInteger(analysis.maxBufferBytes) || analysis.maxBufferBytes <= 0
    || !Number.isInteger(analysis.timeoutMs) || analysis.timeoutMs <= 0
    || analysis.timeoutMs > EXPLORATION_VISION_DEADLINE_MS) {
    throw visionError("EXPLORATION_VISION_CONFIG_INVALID", "vision pin config needs analysis{maxBufferBytes}");
  }
  const publicView = {
    schemaId: config.schemaId,
    mode: rules.mode,
    roles: Object.freeze([...rules.roles]),
    targets: Object.freeze([...rules.targets]),
    provider: Object.freeze({
      pythonHash: files.python.sha256,
      modelHash: files.model.sha256,
      scriptHash: files.script.sha256,
      configHash: sha256OfNormalized(bytesOf(config)),
    }),
  };
  return Object.freeze({
    ...publicView,
    pin: Object.freeze({
      python: Object.freeze({ ...files.python }),
      script: Object.freeze({ ...files.script }),
      model: Object.freeze({ ...files.model }),
    }),
    analysis: Object.freeze({
      maxBufferBytes: analysis.maxBufferBytes,
      timeoutMs: analysis.timeoutMs,
      protocol: analysis.protocol,
    }),
  });
}

function isPinnedFile(value) {
  return Boolean(value)
    && typeof value.path === "string"
    && /^[0-9a-f]{64}$/.test(String(value.sha256 || ""));
}

/** SHA256 over the canonical (sorted-key) JSON of the config body. */
function sha256OfNormalized(body) {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

/** Strips path/derivable fields until only the semantic identity remains. */
function bytesOf(config) {
  return {
    schemaId: config.schemaId,
    schemaVersion: config.schemaVersion,
    pin: {
      pythonSha256: config.pin?.python?.sha256 ?? null,
      scriptSha256: config.pin?.script?.sha256 ?? null,
      modelSha256: config.pin?.model?.sha256 ?? null,
    },
    rules: config.rules ?? null,
    analysis: config.analysis ?? null,
  };
}

/**
 * ONE bounded, cancellable provider analysis. `analyze` is the injected
 * loader (production: spawn of the pinned python; fixtures: async stubs).
 * The work races the decision deadline and honours the caller's abort signal;
 * on either, `analyze.cancel?.()` is awaited so a live child process is
 * actually killed — cancellation is never just "stop caring".
 */
export async function runBoundedVisionWork({
  analyze,
  request = {},
  deadlineMs = EXPLORATION_VISION_DEADLINE_MS,
  signal = null,
} = {}) {
  if (typeof analyze !== "function") {
    throw visionError("EXPLORATION_VISION_WORK_INVALID", "vision work requires an analyze function");
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > EXPLORATION_VISION_DEADLINE_MS) {
    throw visionError(
      "EXPLORATION_VISION_DEADLINE_INVALID",
      `deadlineMs must be within 1..${EXPLORATION_VISION_DEADLINE_MS}, got ${deadlineMs}`,
    );
  }
  if (signal?.aborted) {
    throw visionError("EXPLORATION_VISION_CANCELLED", "provider analysis was cancelled", { status: 499 });
  }
  const controller = new AbortController();
  let timer = null;
  let onParentAbort = null;
  let timeoutWon = false;
  try {
    onParentAbort = () => controller.abort(signal?.reason ?? new Error("parent-cancelled"));
    if (signal) signal.addEventListener("abort", onParentAbort, { once: true });
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timeoutWon = true;
        controller.abort(new Error("vision-deadline"));
        reject(visionError(
          "EXPLORATION_VISION_DEADLINE",
          `provider analysis exceeded the ${deadlineMs}ms decision deadline`,
          { status: 504 },
        ));
      }, deadlineMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    const work = Promise.resolve().then(() => analyze({
      ...request,
      deadlineMs,
      signal: controller.signal,
    }));
    // The losing provider promise is always observed. A process adapter owns
    // cancellation and waits for its child to exit before rejecting.
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (timeoutWon || error?.code === "EXPLORATION_VISION_DEADLINE") throw error;
      if (controller.signal.aborted || signal?.aborted) {
        throw visionError("EXPLORATION_VISION_CANCELLED", "provider analysis was cancelled", { status: 499 });
      }
      if (error?.code?.startsWith?.("EXPLORATION_VISION_")) throw error;
      throw visionError(
        "EXPLORATION_VISION_PROVIDER_FAILED",
        `provider analysis crashed: ${error?.message || error}`,
        { status: 502, details: { cause: error?.code ?? null } },
      );
    }
  } finally {
    clearTimeout(timer);
    if (signal && onParentAbort) signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Per-lane provider work queue: at most MAX_INFLIGHT analyses, a bounded
 * wait queue, and an immediate fail-closed rejection when the queue is full
 * (no unbounded buffering of stale frames).
 */
export function createLaneVisionQueue({ analyze, maxInflight = EXPLORATION_VISION_MAX_INFLIGHT, queueMax = EXPLORATION_VISION_QUEUE_MAX } = {}) {
  if (typeof analyze !== "function") {
    throw visionError("EXPLORATION_VISION_QUEUE_INVALID", "lane vision queue requires an analyze function");
  }
  let inflight = 0;
  const waiting = [];
  function pump() {
    while (inflight < maxInflight && waiting.length > 0) {
      const next = waiting.shift();
      if (next.cancelled) continue;
      inflight += 1;
      next.start();
    }
  }
  return {
    run(request) {
      if (request?.signal?.aborted) {
        return Promise.reject(visionError("EXPLORATION_VISION_CANCELLED", "queued analysis was cancelled", { status: 499 }));
      }
      if (waiting.length >= queueMax) {
        throw visionError(
          "EXPLORATION_VISION_QUEUE_FULL",
          `lane vision queue is full (${queueMax}); refusing a new stale analysis`,
          { status: 429 },
        );
      }
      return new Promise((resolve, reject) => {
        const entry = { cancelled: false, start: null, onAbort: null };
        entry.start = async () => {
          if (request?.signal && entry.onAbort) request.signal.removeEventListener("abort", entry.onAbort);
          try {
            const runs = await runBoundedVisionWork({
              analyze,
              request,
              deadlineMs: request.deadlineMs,
              signal: request.signal,
            });
            resolve(runs);
          } catch (error) {
            reject(error);
          } finally {
            inflight -= 1;
            setImmediate(pump);
          }
        };
        if (request?.signal) {
          entry.onAbort = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            entry.cancelled = true;
            reject(visionError("EXPLORATION_VISION_CANCELLED", "queued analysis was cancelled", { status: 499 }));
            setImmediate(pump);
          };
          request.signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        waiting.push(entry);
        setImmediate(pump);
      });
    },
    stats() {
      return { inflight, queued: waiting.length };
    },
  };
}

/**
 * Build the lane-facing vision seam. The provider is addressed ONLY through
 * `work.run` (bounded/cancellable); frame capture and permit RPCs are
 * injected. Shadow never produces a tap; canary1 reuses the strict
 * r0NavigationTap ladder (ambiguity → redline → replay fence → frame-age
 * expiry) so a visually proposed block becomes a permit payload candidate —
 * the CP then re-checks freshness and TTL at consume.
 *
 * @param {object} input
 * @param {"shadow"|"canary1"} input.mode - sealed mission vision mode (off
 *        never constructs a navigator)
 * @param {Function} input.captureFrame - async () => {frameId, pngPath,
 *        bytes, capturedAt}; the OWNING session's screen primitive
 * @param {{run: Function}} input.work - bounded provider work unit
 * @param {Function} [input.issuePermit] - CP permit issuance (canary only)
 * @param {Function} [input.journalAppend] - lane journal append
 * @param {number[]} [input.dims] - expected frame dimensions
 * @param {string} [input.replayLedgerPath] - append-only replay fence
 */
export function createExplorationVisionNavigator({
  mode,
  captureFrame,
  work,
  reserveAnalysisAttempt,
  settleAnalysisAttempt,
  journalAppend = null,
  providerIdentity = null,
  clock = { nowMs: () => Date.now() },
  fpsUnknownDimsOk = false,
} = {}) {
  if (!EXPLORATION_VISION_MODES.includes(mode) || mode === "off") {
    throw visionError("EXPLORATION_VISION_MODE_INVALID", "exploration vision mode must be shadow or canary1");
  }
  if (typeof captureFrame !== "function") {
    throw visionError("EXPLORATION_VISION_CAPTURE_INVALID", "vision navigator requires a session-bound frame capture");
  }
  if (!work || typeof work.run !== "function") {
    throw visionError("EXPLORATION_VISION_WORK_INVALID", "vision navigator requires a bounded work unit");
  }
  if (typeof reserveAnalysisAttempt !== "function" || typeof settleAnalysisAttempt !== "function") {
    throw visionError(
      "EXPLORATION_VISION_BUDGET_INVALID",
      "vision navigator requires CP-owned reserve/settle analysis wrappers",
    );
  }
  const identityFields = ["pythonHash", "modelHash", "scriptHash", "configHash"];
  if (!providerIdentity || identityFields.some((key) => !/^[0-9a-f]{64}$/.test(String(providerIdentity[key] ?? "")))) {
    throw visionError("EXPLORATION_VISION_PROVIDER_UNPINNED", "vision navigator requires pinned model/script/config hashes");
  }

  // The four receipt counters stay distinct (plan §6 P4 / acceptance E):
  // attempts count provider runs, issued counts sealable candidates,
  // consumed/transported are recorded by the driver after its own permit path.
  const counters = { analysisAttempts: 0, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 };

  async function journal(record) {
    if (typeof journalAppend === "function") await journalAppend(record);
  }

  async function frame() {
    const captured = await captureFrame();
    if (!Buffer.isBuffer(captured?.bytes) || !captured?.frameId) {
      throw visionError("EXPLORATION_VISION_FRAME_UNAVAILABLE", "session-bound frame capture is unusable");
    }
    const ageMs = clock.nowMs() - Number(captured.capturedAt ?? 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > EXPLORATION_VISION_FRAME_MAX_AGE_MS) {
      throw visionError(
        "EXPLORATION_VISION_FRAME_STALE",
        `frame age ${ageMs}ms exceeds the ${EXPLORATION_VISION_FRAME_MAX_AGE_MS}ms ceiling; recapture required`,
        { status: 410, details: { ageMs } },
      );
    }
    const dims = readPngDims(captured.bytes);
    if (!dims && !fpsUnknownDimsOk) {
      throw visionError("EXPLORATION_VISION_PNG_INVALID", "frame bytes are not a readable PNG");
    }
    const frameHash = createHash("sha256").update(captured.bytes).digest("hex");
    if (captured.frameHash && captured.frameHash !== frameHash) {
      throw visionError("EXPLORATION_VISION_FRAME_DRIFT", "declared frame hash differs from the captured bytes");
    }
    return {
      frameId: String(captured.frameId ?? ""),
      pngPath: captured.pngPath ? String(captured.pngPath) : null,
      bytes: captured.bytes,
      capturedAt: Number(captured.capturedAt ?? 0),
      frameHash,
      dims,
    };
  }

  function assertDecisionInput({ navigationRole, page, evidenceHash, dumpDecision }) {
    if (!EXPLORATION_VISION_ROLES.includes(navigationRole)) {
      throw visionError("EXPLORATION_VISION_ROLE_FORBIDDEN", `role ${String(navigationRole)} is not a visual role`, { status: 400 });
    }
    if (page !== "VIDEO_NOTE" || dumpDecision?.page !== page) {
      throw visionError("EXPLORATION_VISION_PAGE_FORBIDDEN", "the initial canary only permits VIDEO_NOTE pause candidates");
    }
    if (!/^[a-f0-9]{64}$/.test(String(evidenceHash ?? ""))) {
      throw visionError("EXPLORATION_VISION_EVIDENCE_INVALID", "a current DUMP evidence hash is required");
    }
    if (!EXPLORATION_VISION_ELIGIBLE_DUMP_VERDICTS.has(dumpDecision?.verdict)) {
      throw visionError(
        dumpDecision?.verdict === "FORBIDDEN_OR_RISKY"
          ? "EXPLORATION_VISION_DUMP_FORBIDDEN"
          : "EXPLORATION_VISION_DUMP_NOT_ELIGIBLE",
        `vision cannot run for DUMP verdict ${String(dumpDecision?.verdict ?? "missing")}`,
      );
    }
    if (!validRect(dumpDecision?.positiveRegion)) {
      throw visionError("EXPLORATION_VISION_POSITIVE_REGION_MISSING", "DUMP did not establish a known positive navigation region");
    }
  }

  /**
   * Vision candidates for ONE navigation transition. DUMP evidence — page and
   * evidenceHash — comes from the driver's own observation; vision can never
   * upgrade a page the DUMP parser did not establish (a DUMP-recognized
   * forbidden surface cannot be overridden by benign vision output).
   */
  async function proposeNavigationCandidate({
    navigationRole,
    page,
    evidenceHash,
    dumpDecision,
    signal = null,
    deadlineMs = EXPLORATION_VISION_DEADLINE_MS,
  } = {}) {
    assertDecisionInput({ navigationRole, page, evidenceHash, dumpDecision });
    const captured = await frame();
    let reservation = null;
    let settled = false;
    try {
      reservation = await reserveAnalysisAttempt({
        navigationRole,
        page,
        evidenceHash,
        frameId: captured.frameId,
        frameHash: captured.frameHash,
        capturedAt: captured.capturedAt,
        dims: captured.dims,
        dumpVerdict: dumpDecision.verdict,
        positiveRegion: dumpDecision.positiveRegion,
        protectedZones: dumpDecision.protectedZones ?? [],
        providerIdentity,
      });
      if (!reservation?.reservationId && !reservation?.analysisId) {
        throw visionError("EXPLORATION_VISION_BUDGET_INVALID", "CP did not return an analysis reservation identity");
      }
      counters.analysisAttempts += 1;
      const blocks = await work.run({
        frame: captured,
        providerIdentity,
        deadlineMs,
        signal,
      });
      if (!Array.isArray(blocks)) {
        throw visionError("EXPLORATION_VISION_PROVIDER_RESULT_INVALID", "provider returned a non-array block list");
      }
      const finalAgeMs = clock.nowMs() - captured.capturedAt;
      if (!Number.isFinite(finalAgeMs) || finalAgeMs < 0 || finalAgeMs > EXPLORATION_VISION_FRAME_MAX_AGE_MS) {
        throw visionError(
          "EXPLORATION_VISION_FRAME_STALE",
          `frame age after analysis is ${finalAgeMs}ms; recapture before any permit issuance`,
          { status: 410, details: { ageMs: finalAgeMs } },
        );
      }
      const selected = selectBlock(blocks, TARGET_LABELS[navigationRole], {
        dims: captured.dims,
        confidenceThreshold: EXPLORATION_VISION_MIN_CONFIDENCE,
      });
      if (isEffectControlLabel(selected.block?.label)) {
        throw visionError("EXPLORATION_VISION_EFFECT_CONTROL", "vision selected an effect control; tap refused");
      }
      if (!rectContains(dumpDecision.positiveRegion, selected.block.bounds)
        || (dumpDecision.protectedZones ?? []).some((zone) => rectIntersects(zone, selected.block.bounds))) {
        throw visionError(
          "EXPLORATION_VISION_REGION_CONFLICT",
          "provider candidate is outside the DUMP-established positive region or intersects a protected zone",
        );
      }
      await settleAnalysisAttempt({
        reservationId: reservation.reservationId ?? null,
        analysisId: reservation.analysisId ?? null,
        outcome: "consumed",
        result: {
          frame: {
            frameId: captured.frameId,
            frameHash: captured.frameHash,
            capturedAt: captured.capturedAt,
            dims: captured.dims,
          },
          providerIdentity,
          candidateCount: 1,
          candidate: {
            label: selected.block.label,
            bounds: selected.block.bounds,
            confidence: Number(selected.block.confidence ?? 1),
          },
        },
      });
      settled = true;
      return {
        captured,
        blocks,
        decision: selected,
        reservation,
        dumpDecision,
        providerIdentity: { ...providerIdentity },
      };
    } catch (error) {
      if (reservation && !settled) {
        try {
          await settleAnalysisAttempt({
            reservationId: reservation.reservationId ?? null,
            analysisId: reservation.analysisId ?? null,
            outcome: "failed",
          });
        } catch { /* the original fail-closed verdict wins */ }
      }
      throw error;
    }
  }

  const TARGET_LABELS = { PAUSE_VIDEO_SAFE_ZONE: "暂停" };

  /**
   * One shadow observation: records the DUMP/VISION agreement + hashes and
   * ALWAYS returns tapAuthorized=false. Never touches the replay ledger.
   */
  async function observeShadow(input) {
    const { navigationRole, page, evidenceHash } = input ?? {};
    try {
      const { captured, decision, reservation } = await proposeNavigationCandidate(input);
      const record = {
        type: "VISION_SHADOW",
        navigationRole,
        page,
        source: "VISION",
        frameHash: captured.frameHash,
        frameId: captured.frameId,
        evidenceHash,
        providerIdentity: { ...providerIdentity },
        analysisRef: reservation.analysisId ?? reservation.reservationId,
        dumpVerdict: input.dumpDecision?.verdict ?? null,
        agreement: true,
        tapAuthorized: false,
        candidate: { blockId: decision.blockId, reason: decision.reason },
      };
      await journal(record);
      return { ok: true, shadow: true, tapAuthorized: false, record };
    } catch (error) {
      const record = {
        type: "VISION_SHADOW",
        navigationRole,
        page,
        source: "VISION",
        providerIdentity: { ...providerIdentity },
        dumpVerdict: input?.dumpDecision?.verdict ?? null,
        agreement: false,
        tapAuthorized: false,
        error: String(error?.code || error?.message || error).slice(0, 120),
      };
      await journal(record);
      return { ok: false, shadow: true, tapAuthorized: false, record, error };
    }
  }

  /**
   * One canary candidate: returns the strictly-selected tap target for the
   * driver's performPermitted path. The caller still goes through
   * issue→fresh-recheck→consume — vision only proposes.
   */
  async function proposeCanaryTap(input = {}) {
    if (mode !== "canary1") {
      return { ok: false, reason: "VISION_SHADOW_NO_TAP" };
    }
    if (counters.permitsIssued >= 1) {
      return { ok: false, reason: "VISION_CANARY_TAP_CAP_REACHED" };
    }
    try {
      const { captured, decision, reservation, dumpDecision } = await proposeNavigationCandidate(input);
      await journal({
        type: "VISION_CANDIDATE",
        navigationRole: input.navigationRole,
        page: input.page,
        source: "VISION",
        frameHash: captured.frameHash,
        frameId: captured.frameId,
        evidenceHash: input.evidenceHash,
        blockId: decision.blockId,
        providerIdentity: { ...providerIdentity },
        analysisRef: reservation.analysisId ?? reservation.reservationId,
        dumpVerdict: dumpDecision.verdict,
        agreement: null,
        tapAuthorized: false,
      });
      return {
        ok: true,
        candidateReady: true,
        tapAuthorized: false,
        target: {
          blockId: decision.blockId,
          bounds: { ...decision.block.bounds },
          center: { ...decision.center },
          label: decision.block.label,
        },
        frame: {
          frameId: captured.frameId,
          frameHash: captured.frameHash,
          capturedAt: captured.capturedAt,
          dims: captured.dims,
        },
        analysisRef: reservation.analysisId ?? reservation.reservationId,
        providerIdentity: { ...providerIdentity },
        counters: { ...counters },
      };
    } catch (error) {
      await journal({
        type: "VISION_CANDIDATE",
        navigationRole: input.navigationRole,
        page: input?.page ?? null,
        source: "VISION",
        tapAuthorized: false,
        error: String(error?.code || error?.message || error).slice(0, 120),
      });
      return { ok: false, reason: error?.code || "EXPLORATION_VISION_CANDIDATE_FAILED", error };
    }
  }

  return Object.freeze({
    mode,
    providerIdentity: Object.freeze({ ...providerIdentity }),
    proposeNavigationCandidate,
    observeShadow,
    proposeCanaryTap,
    stats: () => ({ ...counters }),
    recordPermitIssued() {
      counters.permitsIssued += 1;
    },
    recordPermitConsumed() {
      counters.permitsConsumed += 1;
    },
    recordPhysicalTap() {
      counters.physicalTaps += 1;
    },
  });
}

function validRect(rect) {
  return rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.w > 0 && rect.h > 0;
}

function rectContains(outer, inner) {
  return validRect(outer) && validRect(inner)
    && inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

function rectIntersects(left, right) {
  if (!validRect(left) || !validRect(right)) return true;
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

/**
 * Vision corpus oracle (plan §6 P4 item 3, acceptance §E). A row states an
 * independently authored expectation (page class, provider-agnostic landmark
 * labels) about a REAL captured frame; the oracle verifies row integrity and
 * computes per-route coverage. The oracle never trusts provider output — a
 * provider that disagrees with the labels fails these lanes' canary gate.
 */
export const VISION_CORPUS_MIN_FRAMES_PER_ROUTE = 3;

export function evaluateVisionCorpusRow(row, { fileHash = null, pngBytes = null } = {}) {
  const errors = [];
  if (!row?.id || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(row.id))) {
    errors.push("id");
  }
  if (!row?.file || !/^[0-9a-f]{64}$/.test(String(row.sha256 || ""))) {
    errors.push("sha256");
  }
  if (!VISION_CORPUS_PAGE_CLASSES.includes(row.pageClass)) {
    errors.push("pageClass");
  }
  if (!Array.isArray(row.landmarks) || row.landmarks.length === 0
    || row.landmarks.some((l) => !l || typeof l.label !== "string" || !l.label.trim()
      || (l.bounds !== undefined && (!Array.isArray(l.bounds) || l.bounds.length !== 4 || l.bounds.some((n) => !Number.isInteger(n)))))) {
    errors.push("landmarks");
  }
  if (fileHash !== null && fileHash !== row.sha256) {
    errors.push("fileHashMismatch");
  }
  if (pngBytes !== null) {
    const dims = readPngDims(pngBytes);
    if (!dims || dims.width !== row.width || dims.height !== row.height) {
      errors.push("pngDims");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function visionCorpusCoverage(rows) {
  const perRole = {};
  for (const role of VISION_CORPUS_ROLES) perRole[role] = { frames: 0, uniqueHashes: new Set() };
  const seen = new Set();
  for (const row of rows ?? []) {
    if (seen.has(row?.sha256)) continue;
    seen.add(row.sha256);
    const bucket = perRole[row?.pageClass];
    if (!bucket) continue;
    bucket.frames += 1;
    bucket.uniqueHashes.add(row.sha256);
  }
  const missing = VISION_CORPUS_ROLES.filter((role) => perRole[role].frames < VISION_CORPUS_MIN_FRAMES_PER_ROUTE);
  for (const role of Object.keys(perRole)) {
    perRole[role].uniqueHashes = perRole[role].uniqueHashes.size;
  }
  return { complete: missing.length === 0, perRole, missing };
}
