/**
 * xhs-exploration-permit.mjs — V3-I02 single-use navigation permits.
 *
 * The permit is the ONLY route from an exploration session to an interactive
 * physical action. The CP (not the caller, not the provider, not a DUMP
 * parser) resolves and stores the exact physical primitive payload at
 * issuance; the consume request must match it byte-for-byte. Consumption is
 * a fresh-observation-guarded, atomic one-shot that then authorizes exactly
 * one createJob on the bound session.
 */
import { createHash } from "node:crypto";
import { canonicalJson, newId } from "./canonical.mjs";
import { ControlPlaneError } from "./errors.mjs";

/** navigation role → the only action class allowed to carry it (V3-I03). */
export const EXPLORATION_ROLE_ACTION_MAP = Object.freeze({
  OPEN_SEARCH: "tap",
  SUBMIT_SEARCH: "input_text",
  SCROLL_FEED: "swipe",
  SCROLL_RESULTS: "swipe",
  OPEN_CONTENT_CARD: "tap",
  OPEN_COMMENT_PANEL: "tap",
  SCROLL_COMMENTS: "swipe",
  PAUSE_VIDEO_SAFE_ZONE: "tap",
  BACK: "back",
  RESTORE: "launch_app",
});

export const EXPLORATION_PAGES = Object.freeze(new Set([
  "HOME_FEED", "SEARCH_HOME", "SEARCH_RESULTS", "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL",
]));

/**
 * Initial V3 canary visual authority is deliberately narrower than the
 * general navigation vocabulary: only alias 03's feed lane may receive the
 * single visual permit (plan P6/R3).  Keep this CP-owned; callers cannot widen
 * it by changing a mission/request field.
 */
export const EXPLORATION_VISUAL_NAVIGATION_ROLES = Object.freeze(new Set([
  "PAUSE_VIDEO_SAFE_ZONE",
]));

/** Permit TTL ceiling (plan §3.3) — issuance above this is rejected. */
export const EXPLORATION_PERMIT_TTL_CAP_MS = 5000;
export const EXPLORATION_VISION_MIN_CONFIDENCE = 0.9;
const VISUAL_DUMP_VERDICTS = new Set(["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"]);
const VISUAL_EFFECT_RE = /点赞|收藏|关注|评论|发送|私信|发布|支付|购买|登录|验证码|权限|like|follow|comment|send|publish|pay/i;
const HEX_64 = /^[a-f0-9]{64}$/;
const PROVIDER_IDENTITY_FIELDS = Object.freeze(["pythonHash", "modelHash", "scriptHash", "configHash"]);
const RESERVATION_DETAIL_FIELDS = new Set([
  "navigationRole", "page", "evidenceHash", "frameId", "frameHash", "capturedAt",
  "dims", "dumpVerdict", "positiveRegion", "protectedZones", "providerIdentity",
]);
const ANALYSIS_RESULT_FIELDS = new Set(["frame", "providerIdentity", "candidate", "candidateCount"]);
const VISUAL_PROOF_FIELDS = new Set(["source", "analysisRef", "issuanceEvidenceHash", "dumpVerdict", "agreement"]);

function reject(code, message, { status = 403, details = {} } = {}) {
  throw new ControlPlaneError(code, message, { status, details });
}

function payloadHashOf(payload) {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
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

function sameProviderIdentity(actual, expected) {
  return PROVIDER_IDENTITY_FIELDS.every((key) => HEX_64.test(String(actual?.[key] ?? ""))
    && actual[key] === expected?.[key]);
}

function normalizeRect(rect) {
  if (!validRect(rect) || [rect.x, rect.y, rect.w, rect.h].some((value) => !Number.isInteger(value))) return null;
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function intersectRects(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/**
 * A CP-owned VIDEO_NOTE template keeps caller/provider geometry non-authoritative.
 * Provider blocks may only refine this central playback region; they can never
 * move the tap into the status/chrome, right-side social rail, or bottom UI.
 */
function videoNoteSafeTemplate(dims) {
  const width = Number(dims?.width);
  const height = Number(dims?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 320 || height < 480 || width > 10_000 || height > 20_000) {
    reject("EXPLORATION_VISION_FRAME_DIMS_INVALID", "vision analysis requires bounded integer frame dimensions", { status: 400 });
  }
  const left = Math.ceil(width * 0.15);
  const top = Math.ceil(height * 0.15);
  const right = Math.floor(width * 0.78);
  const bottom = Math.floor(height * 0.72);
  const positiveRegion = { x: left, y: top, w: right - left, h: bottom - top };
  return {
    frameBounds: { x: 0, y: 0, w: width, h: height },
    positiveRegion,
    protectedZones: [
      { x: 0, y: 0, w: width, h: top },
      { x: 0, y: top, w: left, h: bottom - top },
      { x: right, y: top, w: width - right, h: bottom - top },
      { x: 0, y: bottom, w: width, h: height - bottom },
    ],
  };
}

export function normalizeExplorationVisionReservation({ authority, sessionId, detail, nowMs = Date.now() } = {}) {
  const input = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
  if (Object.keys(input).some((key) => !RESERVATION_DETAIL_FIELDS.has(key))) {
    reject("EXPLORATION_VISION_ANALYSIS_FIELDS_FORBIDDEN", "vision analysis reservation contains caller-authority fields", { status: 400 });
  }
  const vision = authority?.vision ?? {};
  if (!["shadow", "canary1"].includes(vision.mode) || vision.remoteEgress !== false) {
    reject("EXPLORATION_VISION_MODE_FORBIDDEN", "vision analysis requires a sealed local-only shadow/canary policy");
  }
  if (input.navigationRole !== "PAUSE_VIDEO_SAFE_ZONE" || input.page !== "VIDEO_NOTE") {
    reject("EXPLORATION_VISION_ANALYSIS_ROLE_INVALID", "initial vision analysis is restricted to VIDEO_NOTE pause", { status: 400 });
  }
  if (!HEX_64.test(String(input.evidenceHash ?? ""))
    || !HEX_64.test(String(input.frameId ?? ""))
    || !HEX_64.test(String(input.frameHash ?? ""))) {
    reject("EXPLORATION_VISION_ANALYSIS_BINDING_INVALID", "analysis requires CP-bound evidence/frame identities", { status: 400 });
  }
  if (!VISUAL_DUMP_VERDICTS.has(input.dumpVerdict)) {
    reject("EXPLORATION_VISION_DUMP_NOT_ELIGIBLE", "analysis requires an eligible closed DUMP verdict", { status: 400 });
  }
  if (!sameProviderIdentity(input.providerIdentity, vision.provider)) {
    reject("EXPLORATION_VISION_PROVIDER_DRIFT", "analysis provider differs from the sealed authority", { status: 409 });
  }
  const capturedAt = Number(input.capturedAt);
  const frameAge = nowMs - capturedAt;
  const frameMaxAge = Math.min(Number(authority?.budgets?.frameMaxAgeMs ?? 0), 10_000);
  if (!Number.isFinite(frameAge) || frameAge < 0 || frameAge > frameMaxAge) {
    reject("EXPLORATION_VISION_FRAME_STALE", "analysis frame is absent, future-dated, or stale", { status: 410 });
  }
  const template = videoNoteSafeTemplate(input.dims);
  const dumpPositiveRegion = normalizeRect(input.positiveRegion);
  if (!dumpPositiveRegion || !rectContains(template.frameBounds, dumpPositiveRegion)) {
    reject("EXPLORATION_VISION_POSITIVE_REGION_INVALID", "DUMP positive region is absent or outside the frame", { status: 400 });
  }
  if (!Array.isArray(input.protectedZones) || input.protectedZones.length === 0) {
    reject("EXPLORATION_VISION_PROTECTED_ZONES_INVALID", "DUMP must enumerate non-empty protected zones", { status: 400 });
  }
  const dumpProtectedZones = input.protectedZones.map(normalizeRect);
  if (dumpProtectedZones.some((zone) => !zone || !rectContains(template.frameBounds, zone))) {
    reject("EXPLORATION_VISION_PROTECTED_ZONES_INVALID", "DUMP protected zones must be bounded frame rectangles", { status: 400 });
  }
  const effectivePositiveRegion = intersectRects(template.positiveRegion, dumpPositiveRegion);
  if (!effectivePositiveRegion) {
    reject("EXPLORATION_VISION_POSITIVE_REGION_INVALID", "DUMP and CP safe regions do not overlap", { status: 400 });
  }
  return {
    schemaId: "xw.xhs.exploration-vision-analysis-reservation.v1",
    sessionId,
    navigationRole: input.navigationRole,
    page: input.page,
    evidenceHash: input.evidenceHash,
    frame: {
      frameId: input.frameId,
      frameHash: input.frameHash,
      capturedAt,
      dims: { width: template.frameBounds.w, height: template.frameBounds.h },
    },
    dumpVerdict: input.dumpVerdict,
    providerIdentity: Object.fromEntries(PROVIDER_IDENTITY_FIELDS.map((key) => [key, vision.provider[key]])),
    safeTemplate: {
      positiveRegion: effectivePositiveRegion,
      protectedZones: [...template.protectedZones, ...dumpProtectedZones],
    },
  };
}

export function normalizeExplorationVisionAnalysis({ authority, reservation, result, nowMs = Date.now() } = {}) {
  const input = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  if (Object.keys(input).some((key) => !ANALYSIS_RESULT_FIELDS.has(key))) {
    reject("EXPLORATION_VISION_RESULT_FIELDS_FORBIDDEN", "vision analysis result contains caller-authority fields", { status: 400 });
  }
  const reserved = reservation?.detail ?? {};
  if (reserved.schemaId !== "xw.xhs.exploration-vision-analysis-reservation.v1"
    || reserved.sessionId !== reservation?.sessionId) {
    reject("EXPLORATION_VISION_ANALYSIS_INVALID", "analysis reservation is not CP-normalized for this session", { status: 400 });
  }
  if (!sameProviderIdentity(input.providerIdentity, reserved.providerIdentity)
    || !sameProviderIdentity(input.providerIdentity, authority?.vision?.provider)) {
    reject("EXPLORATION_VISION_PROVIDER_DRIFT", "analysis result provider differs from the CP reservation", { status: 409 });
  }
  const frame = input.frame ?? {};
  if (frame.frameId !== reserved.frame?.frameId || frame.frameHash !== reserved.frame?.frameHash
    || frame.capturedAt !== reserved.frame?.capturedAt
    || frame.dims?.width !== reserved.frame?.dims?.width || frame.dims?.height !== reserved.frame?.dims?.height) {
    reject("EXPLORATION_VISION_FRAME_DRIFT", "analysis result is not bound to the reserved exact frame", { status: 409 });
  }
  const frameAge = nowMs - Number(frame.capturedAt);
  const frameMaxAge = Math.min(Number(authority?.budgets?.frameMaxAgeMs ?? 0), 10_000);
  if (!Number.isFinite(frameAge) || frameAge < 0 || frameAge > frameMaxAge) {
    reject("EXPLORATION_VISION_FRAME_STALE", "analysis result frame is stale", { status: 410 });
  }
  const candidate = input.candidate ?? {};
  const bounds = normalizeRect(candidate.bounds);
  const confidence = Number(candidate.confidence);
  const label = String(candidate.label ?? "").trim();
  if (input.candidateCount !== 1 || !bounds
    || !label.includes("暂停") || VISUAL_EFFECT_RE.test(label)
    || !Number.isFinite(confidence) || confidence < EXPLORATION_VISION_MIN_CONFIDENCE || confidence > 1
    || !rectContains(reserved.safeTemplate?.positiveRegion, bounds)
    || reserved.safeTemplate?.protectedZones?.some((zone) => rectIntersects(zone, bounds))) {
    reject("EXPLORATION_VISION_CANDIDATE_INVALID", "analysis result is non-unique, low-confidence, risky, or outside the CP safe template", { status: 400 });
  }
  const normalizedCandidate = { label, bounds, confidence };
  const blockId = `blk_${createHash("sha256").update(canonicalJson({
    frameHash: frame.frameHash,
    candidate: normalizedCandidate,
  }), "utf8").digest("hex").slice(0, 24)}`;
  return {
    schemaId: "xw.xhs.exploration-vision-analysis-result.v1",
    frame: reserved.frame,
    providerIdentity: reserved.providerIdentity,
    candidate: { blockId, ...normalizedCandidate },
    candidateCount: 1,
    tap: {
      x: Math.round(bounds.x + bounds.w / 2),
      y: Math.round(bounds.y + bounds.h / 2),
    },
    safeTemplate: reserved.safeTemplate,
  };
}

export function createExplorationPermitPolicy({ state, now = () => Date.now(), stateStore = null } = {}) {
  const store = stateStore ?? state;
  if (!store) throw new TypeError("createExplorationPermitPolicy requires the CP state store");

  function assertAuthorityLane({ authority, alias, sessionId }) {
    const binding = authority.sessionBindings.find((b) => b.sessionId === sessionId);
    if (!binding) {
      reject("EXPLORATION_SESSION_NOT_BOUND", "session is not bound to this exploration authority", { status: 404 });
    }
    if (binding.alias !== alias) {
      reject("EXPLORATION_LANE_MISMATCH", "session alias does not match its sealed lane", { details: { alias, laneAlias: binding.alias } });
    }
    if (binding.laneRole !== (alias === "03" ? "feed_lane" : "search_lane")) {
      reject("EXPLORATION_LANE_MISMATCH", "lane role drifted from the sealed mission", { details: { laneRole: binding.laneRole } });
    }
  }

  /**
   * Issue a single-use permit. The caller supplies the CP-observed evidence
   * (page, focus, overlay state) and the REGION-free navigation intent; the
   * payload (exact primitive + coordinates/text) is resolved HERE by the CP
   * from that evidence, never passed in by the caller.
   */
  function buildPermit({
    session,           // validated session (profile = exploration)
    authority,         // active authority view
    navigationRole,
    page,
    evidenceHash,
    resolvedPayload,   // CP-resolved exact physical primitive
    ttlMs = null,
    visualProof = null,
  }) {
    if (authority.status !== "active") {
      reject("EXPLORATION_AUTHORITY_INACTIVE", "exploration authority is missing or inactive", { status: 404 });
    }
    const alias = session.routeDecision?.selectedDevice?.alias
      ?? authority.sessionBindings.find((b) => b.sessionId === session.sessionId)?.alias;
    assertAuthorityLane({ authority, alias, sessionId: session.sessionId });
    const binding = authority.sessionBindings.find((b) => b.sessionId === session.sessionId);
    if (!EXPLORATION_ROLE_ACTION_MAP[navigationRole]) {
      reject("EXPLORATION_NAVIGATION_ROLE_UNKNOWN", `navigation role ${navigationRole} is outside the closed vocabulary`, { details: { navigationRole } });
    }
    if (EXPLORATION_VISUAL_NAVIGATION_ROLES.has(navigationRole)
      && (alias !== "03" || binding?.laneRole !== "feed_lane")) {
      reject(
        "EXPLORATION_VISUAL_ALIAS_INELIGIBLE",
        "the initial visual permit is restricted to alias 03/feed_lane",
        { details: { alias, laneRole: binding?.laneRole ?? null } },
      );
    }
    if (!EXPLORATION_PAGES.has(page)) {
      reject("EXPLORATION_PAGE_FORBIDDEN", `page ${page} is outside the allowlist`, { details: { page } });
    }
    if (navigationRole === "PAUSE_VIDEO_SAFE_ZONE" && page !== "VIDEO_NOTE") {
      reject(
        "EXPLORATION_ROLE_PAGE_MISMATCH",
        "PAUSE_VIDEO_SAFE_ZONE is valid only on VIDEO_NOTE",
        { details: { navigationRole, page } },
      );
    }
    const actionClass = EXPLORATION_ROLE_ACTION_MAP[navigationRole];
    const visual = EXPLORATION_VISUAL_NAVIGATION_ROLES.has(navigationRole);
    let sealedPayload = resolvedPayload;
    let source = "DUMP";
    let analysisRef = null;
    let providerIdentity = null;
    let visualProofHash = null;
    let effectiveTtlMs = ttlMs ?? EXPLORATION_PERMIT_TTL_CAP_MS;
    if (visual) {
      const vision = authority.vision ?? {};
      if (vision.mode !== "canary1" || vision.remoteEgress !== false) {
        reject("EXPLORATION_VISION_MODE_FORBIDDEN", "visual permit requires the sealed canary1 local-only policy");
      }
      const proof = visualProof ?? {};
      if (!proof || typeof proof !== "object" || Array.isArray(proof)
        || Object.keys(proof).some((key) => !VISUAL_PROOF_FIELDS.has(key))) {
        reject(
          "EXPLORATION_VISION_PROOF_FIELDS_FORBIDDEN",
          "visual issuance accepts only an analysis reference and fresh agreement metadata; caller geometry/provider/frame fields are forbidden",
          { status: 400 },
        );
      }
      if (proof.source !== "VISION" || proof.agreement !== true
        || !VISUAL_DUMP_VERDICTS.has(proof.dumpVerdict)) {
        reject("EXPLORATION_VISION_PROOF_INVALID", "visual permit requires an agreeing eligible DUMP/VISION proof", { status: 400 });
      }
      analysisRef = String(proof.analysisRef ?? "");
      const reservation = store.getExplorationReservation?.(analysisRef);
      if (!reservation || reservation.authorityId !== authority.authorityId
        || reservation.missionHash !== authority.missionHash
        || reservation.alias !== "03" || reservation.kind !== "visionAnalysis"
        || reservation.amount !== 1 || reservation.state !== "consumed"
        || reservation.detail?.sessionId !== session.sessionId
        || reservation.detail?.navigationRole !== navigationRole
        || reservation.detail?.page !== page
        || reservation.detail?.analysis?.schemaId !== "xw.xhs.exploration-vision-analysis-result.v1") {
        reject("EXPLORATION_VISION_ANALYSIS_INVALID", "visual proof is not backed by a consumed CP analysis reservation", { status: 400 });
      }
      const analysis = reservation.detail.analysis;
      const recomputedAnalysisHash = createHash("sha256").update(canonicalJson(analysis), "utf8").digest("hex");
      if (!HEX_64.test(String(reservation.detail.analysisHash ?? ""))
        || reservation.detail.analysisHash !== recomputedAnalysisHash) {
        reject("EXPLORATION_VISION_ANALYSIS_DRIFT", "CP-recorded analysis artifact failed its durable hash binding", { status: 409 });
      }
      providerIdentity = analysis.providerIdentity;
      if (!sameProviderIdentity(providerIdentity, vision.provider)) {
        reject("EXPLORATION_VISION_PROVIDER_DRIFT", "CP-recorded analysis provider differs from the sealed authority", { status: 409 });
      }
      const frame = analysis.frame ?? {};
      const frameAge = now() - Number(frame.capturedAt);
      const frameMaxAge = Math.min(Number(authority.budgets?.frameMaxAgeMs ?? 0), 10_000);
      if (!HEX_64.test(String(frame.frameId ?? "")) || !HEX_64.test(String(frame.frameHash ?? ""))
        || !Number.isFinite(frameAge) || frameAge < 0 || frameAge > frameMaxAge) {
        reject("EXPLORATION_VISION_FRAME_STALE", "visual proof frame is absent, unbound, or stale", { status: 410 });
      }
      if (proof.issuanceEvidenceHash !== evidenceHash || !HEX_64.test(String(reservation.detail.evidenceHash ?? ""))) {
        reject("EXPLORATION_VISION_EVIDENCE_DRIFT", "visual proof is not bound to the issuance observation", { status: 409 });
      }
      const candidate = analysis.candidate ?? {};
      if (!/^blk_[a-f0-9]{24}$/.test(String(candidate.blockId ?? ""))
        || Number(candidate.confidence) < EXPLORATION_VISION_MIN_CONFIDENCE
        || !validRect(candidate.bounds)
        || !validRect(analysis.safeTemplate?.positiveRegion)
        || !Array.isArray(analysis.safeTemplate?.protectedZones)
        || !rectContains(analysis.safeTemplate?.positiveRegion, candidate.bounds)
        || analysis.safeTemplate?.protectedZones?.some((zone) => rectIntersects(zone, candidate.bounds))
        || !Number.isInteger(analysis.tap?.x) || !Number.isInteger(analysis.tap?.y)
        || analysis.tap.x !== Math.round(candidate.bounds.x + candidate.bounds.w / 2)
        || analysis.tap.y !== Math.round(candidate.bounds.y + candidate.bounds.h / 2)
        || VISUAL_EFFECT_RE.test(String(candidate.label ?? ""))) {
        reject("EXPLORATION_VISION_CANDIDATE_INVALID", "CP-recorded visual candidate is ambiguous, risky, or outside the safe template", { status: 400 });
      }
      sealedPayload = { primitive: "tap", x: analysis.tap.x, y: analysis.tap.y };
      source = "VISION";
      effectiveTtlMs = Math.min(Number(authority.budgets?.permitTtlMs ?? 0), EXPLORATION_PERMIT_TTL_CAP_MS);
      if (ttlMs !== null && ttlMs !== effectiveTtlMs) {
        reject("EXPLORATION_PERMIT_TTL_INVALID", "visual permit TTL is fixed by the sealed mission", { status: 400 });
      }
      visualProofHash = createHash("sha256").update(canonicalJson({
        ...proof,
        analysisHash: reservation.detail.analysisHash,
      }), "utf8").digest("hex");
    }
    if (!sealedPayload || sealedPayload.primitive !== actionClass) {
      reject("EXPLORATION_PAYLOAD_CLASS_MISMATCH", `payload primitive must equal the sealed action class ${actionClass}`, { status: 400 });
    }
    if (!evidenceHash || !/^[a-f0-9]{64}$/.test(evidenceHash)) {
      reject("EXPLORATION_EVIDENCE_INVALID", "a CP-owned observation evidence hash is required", { status: 400 });
    }
    if (!Number.isInteger(effectiveTtlMs) || effectiveTtlMs <= 0 || effectiveTtlMs > EXPLORATION_PERMIT_TTL_CAP_MS) {
      reject("EXPLORATION_PERMIT_TTL_INVALID", `permit TTL must be within ${EXPLORATION_PERMIT_TTL_CAP_MS}ms`, { status: 400 });
    }
    const issuedAt = now();
    const permit = {
      permitId: newId("expl-permit"),
      authorityId: authority.authorityId,
      missionHash: authority.missionHash,
      alias,
      laneRole: binding?.laneRole,
      sessionId: session.sessionId,
      navigationRole,
      actionClass,
      page,
      payload: sealedPayload,
      payloadHash: payloadHashOf(sealedPayload),
      evidenceHash,
      source,
      analysisRef,
      providerIdentity,
      visualProofHash,
      issuedAt,
      expiresAt: issuedAt + effectiveTtlMs,
    };
    return permit;
  }

  function insertPermit(permit) {
    return store.insertExplorationPermit(permit);
  }

  /**
   * Backward-compatible composition for non-visual callers.  ControlPlane's
   * visual path calls buildPermit first, reserves its global issuance budget
   * only after every field validates, and then persists with insertPermit.
   */
  function issuePermit(input) {
    return insertPermit(buildPermit(input));
  }

  /**
   * Consume a permit and authorize exactly one job. Guard order (V3-I02,
   * plan §5.2): authority/session/permit integrity, fresh re-observation
   * comparison, byte-exact payload match, TTL, then the atomic one-shot
   * UPDATE that admits exactly one createJob.
   */
  function consumePermit({
    session,
    authority,
    permitId,
    requestedPayload,       // must match the CP-resolved payload byte-for-byte
    freshObservation,       // CP-owned consume-time recheck
  }) {
    if (authority.status !== "active") {
      reject("EXPLORATION_AUTHORITY_INACTIVE", "exploration authority is missing or inactive", { status: 404 });
    }
    const permit = store.getExplorationPermit(permitId);
    if (!permit) {
      reject("EXPLORATION_PERMIT_NOT_FOUND", `unknown permit ${permitId}`, { status: 404 });
    }
    if (permit.authorityId !== authority.authorityId) {
      reject("EXPLORATION_PERMIT_CROSS_AUTHORITY", "permit belongs to a different exploration authority");
    }
    if (permit.sessionId !== session.sessionId) {
      reject("EXPLORATION_PERMIT_CROSS_SESSION", "permit is bound to another session");
    }
    const binding = authority.sessionBindings.find((b) => b.sessionId === session.sessionId);
    if (!binding || binding.alias !== permit.alias) {
      reject("EXPLORATION_PERMIT_CROSS_LANE", "permit is bound to another lane");
    }
    const nowMs = now();
    if (nowMs >= permit.expiresAtMs) {
      // expired permits never retry in the initial canary (V3-I07): the
      // consume fails closed and the budget stays conservatively consumed
      reject("EXPLORATION_PERMIT_EXPIRED", "permit TTL expired; no retry in the initial canary", { status: 410 });
    }
    if (permit.payloadHash !== payloadHashOf(requestedPayload ?? null)) {
      // the caller never widens/changes the physical payload after issuance
      reject("EXPLORATION_PERMIT_PAYLOAD_MISMATCH", "consume payload differs from the CP-resolved permit payload", { status: 400 });
    }
    const observation = freshObservation ?? {};
    if (observation?.page !== permit.page) {
      reject("EXPLORATION_PAGE_DRIFT", "fresh observation shows page drift; refuse before createJob", { details: { sealedPage: permit.page, observedPage: observation?.page ?? null } });
    }
    if (observation?.overlaySafe !== true) {
      reject("EXPLORATION_OVERLAY_REFUSED", "fresh observation did not prove overlay-safe state", { details: { overlaySafe: observation?.overlaySafe ?? null } });
    }
    if (typeof observation?.evidenceHash === "string" && observation.evidenceHash !== permit.evidenceHash) {
      reject("EXPLORATION_EVIDENCE_DRIFT", "consume-time evidence hash drifted from the issued observation", { details: {} });
    }
    const jobId = newId("expl-job");
    const consumed = store.consumeExplorationPermitRow({
      permitId,
      now: nowMs,
      jobId,
    });
    if (!consumed) {
      // exactly-once: a second consume (replay/race) never re-authorizes
      reject("EXPLORATION_PERMIT_REPLAY", "permit was already consumed; single-use replay refused", { status: 409 });
    }
    return {
      permit,
      jobId,
      actionClass: permit.actionClass,
      payload: permit.payload,
    };
  }

  return {
    buildPermit,
    insertPermit,
    issuePermit,
    consumePermit,
    payloadHashOf,
  };
}
