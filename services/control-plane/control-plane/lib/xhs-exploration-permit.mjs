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

/** Permit TTL ceiling (plan §3.3) — issuance above this is rejected. */
export const EXPLORATION_PERMIT_TTL_CAP_MS = 5000;

function reject(code, message, { status = 403, details = {} } = {}) {
  throw new ControlPlaneError(code, message, { status, details });
}

function payloadHashOf(payload) {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
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
  function issuePermit({
    session,           // validated session (profile = exploration)
    authority,         // active authority view
    navigationRole,
    page,
    evidenceHash,
    resolvedPayload,   // CP-resolved exact physical primitive
    ttlMs = EXPLORATION_PERMIT_TTL_CAP_MS,
  }) {
    if (authority.status !== "active") {
      reject("EXPLORATION_AUTHORITY_INACTIVE", "exploration authority is missing or inactive", { status: 404 });
    }
    const alias = session.routeDecision?.selectedDevice?.alias
      ?? authority.sessionBindings.find((b) => b.sessionId === session.sessionId)?.alias;
    assertAuthorityLane({ authority, alias, sessionId: session.sessionId });
    if (!EXPLORATION_ROLE_ACTION_MAP[navigationRole]) {
      reject("EXPLORATION_NAVIGATION_ROLE_UNKNOWN", `navigation role ${navigationRole} is outside the closed vocabulary`, { details: { navigationRole } });
    }
    if (!EXPLORATION_PAGES.has(page)) {
      reject("EXPLORATION_PAGE_FORBIDDEN", `page ${page} is outside the allowlist`, { details: { page } });
    }
    const actionClass = EXPLORATION_ROLE_ACTION_MAP[navigationRole];
    if (!resolvedPayload || resolvedPayload.primitive !== actionClass) {
      reject("EXPLORATION_PAYLOAD_CLASS_MISMATCH", `payload primitive must equal the sealed action class ${actionClass}`, { status: 400 });
    }
    if (!evidenceHash || !/^[a-f0-9]{64}$/.test(evidenceHash)) {
      reject("EXPLORATION_EVIDENCE_INVALID", "a CP-owned observation evidence hash is required", { status: 400 });
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > EXPLORATION_PERMIT_TTL_CAP_MS) {
      reject("EXPLORATION_PERMIT_TTL_INVALID", `permit TTL must be within ${EXPLORATION_PERMIT_TTL_CAP_MS}ms`, { status: 400 });
    }
    const issuedAt = now();
    const permit = {
      permitId: newId("expl-permit"),
      authorityId: authority.authorityId,
      missionHash: authority.missionHash,
      alias,
      laneRole: authority.sessionBindings.find((b) => b.sessionId === session.sessionId)?.laneRole,
      sessionId: session.sessionId,
      navigationRole,
      actionClass,
      page,
      payload: resolvedPayload,
      payloadHash: payloadHashOf(resolvedPayload),
      evidenceHash,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    };
    store.insertExplorationPermit(permit);
    return permit;
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
    if (nowMs > permit.expiresAtMs) {
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
    issuePermit,
    consumePermit,
    payloadHashOf,
  };
}