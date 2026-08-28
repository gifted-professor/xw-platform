// xhs-routine-vision-navigator.mjs — production vision seam for the routine
// runner (plan V2 §8.2). Pure orchestration: the frame comes from the OWNING
// session's screen primitive (strict artifact binding enforced by the runner),
// the provider is the pinned real vision provider, and the only tap vision may
// ever authorize is the one-shot R0 navigation block.
//
// Sealed mode enum (§8.2):
//   fallback — no vision at all (default): the machine's dump ladder only.
//   shadow   — observations recorded, tapAuthorized always false.
//   canary   — shadow observations + at most ONE R0 navigation permit per run.
// Effect controls are red-lined in BOTH modes; effects only ever flow through
// the typed capability bridge.
import { createHash } from "node:crypto";

import { readPngDims } from "../../ops/xw-adaptive-visual-tap.mjs";
import {
  r0NavigationTap,
  screenshotEvidence,
  VISION_PROVIDERS,
} from "./xhs-vision-shadow.mjs";
import { PAGE_CLASS } from "./xhs-feed-surface.mjs";

export const ROUTINE_VISION_MODES = Object.freeze(["fallback", "shadow", "canary"]);

export const ROUTINE_R0_TTL_MS = 30_000;

function fail(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, details });
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Shared frame pipeline: capture → strict evidence → dims/hash. The evidence
 * hash is recomputed from the file on disk by screenshotEvidence and compared
 * against the runner-read bytes — any drift between the bound artifact and the
 * bytes this process segmented fails closed.
 */
async function frameOf(captureFrame, { live, provider }) {
  const frame = await captureFrame();
  if (!frame?.pngPath || !frame?.frameId || !Buffer.isBuffer(frame?.bytes)) {
    throw fail("ROUTINE_VISION_FRAME_UNAVAILABLE", "session-bound screenshot frame is unusable", 409);
  }
  const evidence = screenshotEvidence({
    pngPath: frame.pngPath,
    provider: VISION_PROVIDERS.REAL,
    modelId: provider.id,
    capturedAt: frame.capturedAt,
    live,
  });
  if (evidence.frameHash !== sha256Hex(frame.bytes)) {
    throw fail("ROUTINE_VISION_FRAME_DRIFT", "frame bytes do not match the evidence hash", 409);
  }
  return {
    frameId: frame.frameId,
    pngPath: frame.pngPath,
    bytes: frame.bytes,
    dims: evidence.dims,
    frameHash: evidence.frameHash,
    capturedAt: Number(frame.capturedAt ?? evidence.capturedAt ?? 0),
  };
}

/**
 * @param {object} input
 * @param {"fallback"|"shadow"|"canary"} input.mode - sealed vision mode
 * @param {object} input.provider - pinned real provider {id, version,
 *   modelSha256, segment(frame, evidence)}; fixture providers fail closed
 * @param {Function} input.captureFrame - async () => { pngPath, bytes,
 *   frameId, capturedAt } from the OWNING session (strict artifact binding is
 *   the runner's job; the navigator never accepts a raw path from the caller)
 * @param {string} [input.target] - navigation block label to select (default
 *   the XHS feed-card label prefix)
 * @param {string} [input.ledgerPath] - append-only replay fence ledger
 * @param {boolean} [input.live] - true forbids the fixture provider (default true)
 */
export function createRoutineVisionNavigator({
  mode,
  provider,
  captureFrame,
  target = "笔记",
  ledgerPath = null,
  live = true,
  clock = { nowMs: () => Date.now() },
} = {}) {
  if (!ROUTINE_VISION_MODES.includes(mode)) {
    throw fail("ROUTINE_VISION_MODE_INVALID", `vision mode must be one of ${ROUTINE_VISION_MODES.join("|")}`);
  }
  if (mode === "fallback") {
    // fallback is the no-vision default: no provider work is ever done
    return Object.freeze({
      mode,
      permitsIssued: 0,
      authorizeR0Navigation: async () => ({ ok: false, reason: "VISION_FALLBACK_DISABLED" }),
      observePage: async () => ({ ok: false, reason: "VISION_FALLBACK_DISABLED" }),
    });
  }
  if (!provider || typeof provider.segment !== "function") {
    throw fail("ROUTINE_VISION_PROVIDER_INVALID", "vision navigator requires a segmented provider");
  }
  if (typeof captureFrame !== "function") {
    throw fail("ROUTINE_VISION_CAPTURE_INVALID", "vision navigator requires a session-bound frame capture");
  }
  if (!provider.modelSha256 || !/^[0-9a-f]{64}$/.test(String(provider.modelSha256))) {
    throw fail("ROUTINE_VISION_PROVIDER_UNPINNED", "vision navigator requires a pinned 64-hex modelSha256");
  }
  if (/(^|[-_.])fixture($|[-_.])/i.test(String(provider.id || ""))) {
    // plan §10.9: fixture 结果不得用于 live —— fail closed before anything else
    throw fail("ROUTINE_VISION_PROVIDER_REJECTED", "fixture vision providers may never enter a routine navigator");
  }

  // at most ONE R0 navigation permit per run (canary visual tap cap, §8.2)
  let permitsIssued = 0;

  function assertBinding(input) {
    for (const key of ["executionRunId", "planHash", "alias", "sessionId", "deviceId"]) {
      if (!input?.[key]) {
        throw fail("ROUTINE_VISION_BINDING_INVALID", `vision request needs ${key}`, 409);
      }
    }
    return {
      executionRunId: String(input.executionRunId),
      planHash: String(input.planHash),
      alias: String(input.alias),
      sessionId: String(input.sessionId),
      deviceId: String(input.deviceId),
    };
  }

  return Object.freeze({
    mode,
    get permitsIssued() {
      return permitsIssued;
    },

    /**
     * One-shot R0 navigation permit (canary mode only, ≤1 per run). The permit
     * carries the full binding tuple the machine re-verifies before the tap.
     */
    async authorizeR0Navigation(input = {}) {
      // §8.2: ONLY canary mode may issue the R0 permit; shadow records
      // comparisons with tapAuthorized=false, forever.
      if (mode !== "canary") {
        return { ok: false, reason: "VISION_SHADOW_NO_TAP" };
      }
      if (permitsIssued >= 1) {
        return { ok: false, reason: "VISION_CANARY_TAP_CAP_REACHED" };
      }
      const binding = assertBinding(input);
      const captured = await frameOf(captureFrame, { live, provider });
      const blocks = provider.segment(
        { frameId: captured.frameId, pngPath: captured.pngPath, dims: captured.dims, capturedAt: captured.capturedAt },
        null,
      );
      const result = r0NavigationTap({
        blocks,
        target: String(input.targetLabel || target),
        dims: captured.dims,
        frameHash: captured.frameHash,
        ledgerPath,
        clock,
      });
      permitsIssued += 1;
      return {
        ok: true,
        permit: {
          permitId: result.actionRef,
          actionClass: "R0_NAVIGATION",
          oneShot: true,
          consumed: false,
          provider: { id: provider.id, version: provider.version, modelSha256: provider.modelSha256 },
          dims: captured.dims,
          frameId: captured.frameId,
          frameHash: captured.frameHash,
          blockId: result.blockId,
          effectControl: false,
          expiresAtMs: captured.capturedAt + ROUTINE_R0_TTL_MS,
          ...binding,
          page: PAGE_CLASS.HOME_FEED,
        },
        target: {
          blockId: result.blockId,
          x: result.center.x,
          y: result.center.y,
          label: result.block.label,
          effectControl: false,
        },
      };
    },

    /**
     * Shadow observation of the open detail: classify the media kind from
     * pinned-provider blocks. tapAuthorized is ALWAYS false — this records a
     * comparison for the corpus metric, never a tap.
     */
    async observePage(input = {}) {
      const binding = assertBinding(input);
      const captured = await frameOf(captureFrame, { live, provider });
      const blocks = provider.segment(
        { frameId: captured.frameId, pngPath: captured.pngPath, dims: captured.dims, capturedAt: captured.capturedAt },
        null,
      );
      const hasVideo = blocks.some((b) => String(b.label || "").startsWith("视频"));
      const hasNote = blocks.some((b) => String(b.label || "").startsWith("笔记"));
      if (!hasVideo && !hasNote) {
        return { ok: false, reason: "VISION_DETAIL_UNSAFE_OR_UNKNOWN" };
      }
      return {
        ok: true,
        observation: {
          ...binding,
          page: hasVideo ? PAGE_CLASS.VIDEO_NOTE : PAGE_CLASS.IMAGE_NOTE,
          frameId: captured.frameId,
          provider: { id: provider.id, version: provider.version, modelSha256: provider.modelSha256 },
          tapAuthorized: false,
        },
      };
    },
  });
}