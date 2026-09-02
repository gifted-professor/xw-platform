/**
 * xhs-explore-driver.mjs — V3 free-exploration typed driver (plan V2 §5.3).
 *
 * The ONLY bridge between the pure lane machine (xhs-goal-explore-machine.mjs)
 * and the device. The machine emits closed-vocabulary navigation intents; the
 * run loop dispatches them to THESE typed methods and to nothing else:
 *
 *   openBoundSearch / submitBoundQuery / scrollBoundResults / scrollBoundFeed /
 *   openBoundContent / openBoundComments / pauseBoundVideo / backBound /
 *   restoreBound
 *
 * Hard boundaries (V3-I02/I03):
 *   - every interactive action goes issue-permit → fresh re-observation →
 *     byte-exact consume → exactly one job, on the lane's own CP session;
 *   - the physical payload is resolved from the CURRENT CP-owned dump and is
 *     never a hard-coded or remembered coordinate: an unresolvable target is a
 *     failed navigation, never a fallback;
 *   - nothing in this module (or in what the machine can see) ever receives a
 *     raw primitive fn, session token, coordinate parameter, or provider path.
 *
 * Observations are read-only session actions (focus + dump_ui) — the only
 * primitives a profiled session may run on the generic path.
 */
import { createHash } from "node:crypto";

import { exploreStep } from "./xhs-goal-explore-machine.mjs";
import {
  EXPLORE_PAGE,
  EXPLORE_DETAIL_PAGES,
  parseExploreSurface,
} from "./xhs-explore-surface.mjs";

const XHS_PACKAGE = "com.xingin.xhs";

/** navigation role → the typed driver method the run loop may call. */
export const EXPLORE_ROLE_METHODS = Object.freeze({
  OPEN_SEARCH: "openBoundSearch",
  SUBMIT_SEARCH: "submitBoundQuery",
  SCROLL_FEED: "scrollBoundFeed",
  SCROLL_RESULTS: "scrollBoundResults",
  OPEN_CONTENT_CARD: "openBoundContent",
  OPEN_COMMENT_PANEL: "openBoundComments",
  SCROLL_COMMENTS: "scrollBoundComments",
  PAUSE_VIDEO_SAFE_ZONE: "pauseBoundVideo",
  BACK: "backBound",
  RESTORE: "restoreBound",
});

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

/**
 * Resolve a tappable node from the CURRENT dump by closed evidence hints.
 * Fail-closed: no hint match → null (the caller reports a navigation failure
 * instead of ever falling back to a remembered or invented coordinate).
 * @param {string} xml
 * @param {object} input
 * @param {RegExp[]} input.resourceId - resource-id must match any of these
 * @param {RegExp[]} [input.desc] - content-desc/text must match any of these
 * @param {number} [input.yMin] - usable vertical band (skips status bar)
 * @param {number} [input.yMax]
 * @returns {{x, y, evidence}|null}
 */
export function resolveTapTarget(xml, {
  resourceId = [],
  desc = [],
  yMin = 120,
  yMax = 2600,
} = {}) {
  const source = String(xml ?? "");
  if (!source) return null;
  const nodeRe = /<node[^>]*?\/>/g;
  for (const raw of source.match(nodeRe) ?? []) {
    const boundsMatch = raw.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;
    const [L, T, R, B] = boundsMatch.slice(1).map(Number);
    const w = R - L;
    const h = B - T;
    if (w < 24 || h < 24) continue;
    const cx = Math.round((L + R) / 2);
    const cy = Math.round((T + B) / 2);
    if (cy < yMin || cy > yMax) continue;
    const resourceIdValue = raw.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const descValue = raw.match(/content-desc="([^"]*)"/)?.[1] ?? "";
    const textValue = raw.match(/ text="([^"]*)"/)?.[1] ?? "";
    const idHit = resourceId.length > 0 && resourceId.some((re) => re.test(resourceIdValue));
    const descHit = desc.length > 0
      && [descValue, textValue].some((v) => v && desc.some((re) => re.test(v)));
    if (!idHit && !descHit) continue;
    return {
      x: cx,
      y: cy,
      evidence: {
        resourceId: resourceIdValue || null,
        desc: descValue || null,
        text: textValue || null,
        bounds: [L, T, R, B],
      },
    };
  }
  return null;
}

/** Root display bounds from the dump (for swipes) — never a fixed screen size. */
export function resolveDisplayBounds(xml) {
  let width = 0;
  let height = 0;
  for (const match of String(xml ?? "").matchAll(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    if (Number(match[1]) !== 0 || Number(match[2]) !== 0) continue;
    width = Math.max(width, Number(match[3]));
    height = Math.max(height, Number(match[4]));
  }
  if (width < 320 || height < 640) return null;
  return { width, height };
}

/**
 * Build the typed exploration driver for ONE lane.
 * @param {object} deps - all injected; this module performs no I/O itself.
 * @param {string} deps.authorityId
 * @param {string} deps.alias - exact device alias (03|04)
 * @param {string} deps.laneId - journal lane id (e.g. "lane-0")
 * @param {string} deps.laneRole - feed_lane|search_lane
 * @param {{sessionId: string, token: string}} deps.session - CP session binding
 * @param {string[]} deps.queries - the sealed queries (search lane)
 * @param {Function} deps.observeDevice - async () => { focus, xml } — the ONLY
 *        device read path (focus + dump_ui through the formal session)
 * @param {Function} deps.issuePermit - CP issueExplorationPermit wrapper
 * @param {Function} deps.consumePermit - CP consumeExplorationPermit wrapper
 * @param {Function} [deps.claimTarget] - CP claimExplorationTarget wrapper
 * @param {Function} [deps.confirmTarget] - CP confirmExplorationTarget wrapper
 * @param {Function} [deps.journalAppend] - CP lane-journal append(record)
 * @param {Function} [deps.onPrimitiveBudgetReservation] - production-only
 *        persisted CP reservation receipt sink; when supplied, every consumed
 *        permit must return one before the lane may continue
 * @param {boolean} [deps.visionEnabled] - P2: false (pause stays fail-closed)
 * @param {object} [deps.vision] - explorer vision navigator
 *        ({proposeCanaryTap, recordPermitConsumed, recordPhysicalTap});
 *        required when visionEnabled is true, never consulted otherwise
 */
export function createExplorerTypedDriver({
  authorityId,
  alias,
  laneId,
  laneRole,
  session,
  queries = [],
  seed = null,
  observeDevice,
  issuePermit,
  consumePermit,
  claimTarget = null,
  confirmTarget = null,
  journalAppend = null,
  onPrimitiveBudgetReservation = null,
  visionEnabled = false,
  vision = null,
  missionStartedAtMs = null,
  now = () => Date.now(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!authorityId || !alias || !laneId || !["feed_lane", "search_lane"].includes(laneRole)) {
    throw fail("EXPLORE_DRIVER_BINDING_INVALID", "driver requires authorityId/alias/laneId/laneRole");
  }
  if (!session?.sessionId || typeof session.token !== "string" || !session.token) {
    throw fail("EXPLORE_DRIVER_SESSION_INVALID", "driver requires a bound session/token");
  }
  if (typeof observeDevice !== "function" || typeof issuePermit !== "function" || typeof consumePermit !== "function") {
    throw fail("EXPLORE_DRIVER_DEPS_INVALID", "driver requires observeDevice/issuePermit/consumePermit");
  }
  if (journalAppend !== null && typeof journalAppend !== "function") {
    throw fail("EXPLORE_DRIVER_JOURNAL_INVALID", "journalAppend must be a function or null");
  }
  if (onPrimitiveBudgetReservation !== null && typeof onPrimitiveBudgetReservation !== "function") {
    throw fail(
      "EXPLORE_DRIVER_BUDGET_RECEIPT_INVALID",
      "onPrimitiveBudgetReservation must be a function or null",
    );
  }
  if (visionEnabled === true && (alias !== "03" || laneRole !== "feed_lane")) {
    throw fail("EXPLORE_VISION_LANE_FORBIDDEN", "vision is eligible only on alias 03 feed_lane");
  }
  if (visionEnabled === true && (!vision || typeof vision !== "object")) {
    throw fail("EXPLORE_VISION_NAVIGATOR_ABSENT", "enabled vision requires a bound navigator");
  }

  // The driver holds the LAST observation only; nothing earlier is retained,
  // so no stale coordinate can ever be replayed.
  const internal = {
    last: null,
    sourceCardKind: null,
    claimedKeys: new Set(),
    consumedPermits: 0,
    observationCount: 0,
  };

  async function journal(record) {
    if (typeof journalAppend === "function") {
      await journalAppend({ laneId, alias, at: now(), ...record });
    }
  }

  /** Fresh read-only observation (the only observation the next decision sees). */
  async function observe({ label = "observe" } = {}) {
    const raw = await observeDevice();
    const xml = String(raw?.xml ?? "");
    const focus = String(raw?.focus ?? "");
    const surface = parseExploreSurface({
      xml,
      focus,
      pkg: raw?.pkg ?? null,
      laneRole,
      sourceCardKind: internal.sourceCardKind,
      seed,
      knownKeys: internal.claimedKeys,
      candidateBudget: null,
    });
    const evidenceHash = sha256(xml);
    const overlaySafe = surface.exit !== true && surface.page !== EXPLORE_PAGE.SYSTEM_OVERLAY;
    internal.observationCount += 1;
    const observation = {
      seq: internal.observationCount,
      label,
      at: now(),
      xml,
      focus,
      surface,
      evidenceHash,
      fresh: { page: surface.page, overlaySafe, evidenceHash },
    };
    internal.last = observation;
    await journal({ type: "OBSERVATION", label, page: surface.page, evidenceHash, seq: observation.seq });
    return observation;
  }

  function requireFreshObservation() {
    if (!internal.last) {
      throw fail("EXPLORE_NO_FRESH_OBSERVATION", "navigation requires a current CP-owned observation");
    }
    return internal.last;
  }

  /**
   * One permitted navigation: resolve payload from the CURRENT dump → issue →
   * fresh re-observation → byte-exact consume → exactly one job. Any guard
   * failure throws BEFORE the job; the run loop turns it into a failure report.
   */
  async function performPermitted({
    navigationRole,
    page,
    resolvedPayload,
    freshOverride = null,
    visualProof = null,
    onIssued = null,
  }) {
    const observation = requireFreshObservation();
    if (observation.surface.page !== page) {
      throw fail("EXPLORE_STALE_DECISION", "decision no longer matches the observed page", {
        sealedPage: page,
        observedPage: observation.surface.page,
      });
    }
    const permit = await issuePermit({
      navigationRole,
      page,
      evidenceHash: observation.evidenceHash,
      resolvedPayload,
      ...(visualProof ? { visualProof } : {}),
    });
    if (typeof onIssued === "function") await onIssued(permit);
    // consumption re-check runs against a NEWLY taken observation (a fresh
    // CP-owned receipt, not the issuance one)
    const fresh = freshOverride ?? (await observe({ label: `pre-consume:${navigationRole}` })).fresh;
    const consumedResult = await consumePermit({
      permitId: permit.permitId,
      payload: permit.payload ?? resolvedPayload,
      freshObservation: fresh,
    });
    const { permit: consumed, job, budgetReservation = null } = consumedResult ?? {};
    if (typeof onPrimitiveBudgetReservation === "function") {
      if (!budgetReservation?.reservationId) {
        throw fail(
          "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
          "permit consumption omitted its persisted pre-I/O totalSteps reservation",
        );
      }
      try {
        await onPrimitiveBudgetReservation({
          reservation: budgetReservation,
          permitId: permit.permitId,
          navigationRole,
          page,
        });
      } catch (error) {
        throw fail(
          "EXPLORATION_BUDGET_RECEIPT_UNPROVEN",
          "permit totalSteps reservation could not be bound to the lane operation",
          { causeCode: String(error?.code ?? "UNKNOWN") },
        );
      }
    }
    internal.consumedPermits += 1;
    await journal({
      type: "PERMIT_CONSUMED",
      navigationRole,
      permitId: consumed.permitId,
      jobId: job?.jobId ?? null,
      pageFrom: page,
    });
    return { permit: consumed, job };
  }

  function assertPermittablePage(observation = internal.last) {
    const page = observation?.surface?.page ?? null;
    const permittable = new Set([
      EXPLORE_PAGE.HOME_FEED,
      EXPLORE_PAGE.SEARCH_HOME,
      EXPLORE_PAGE.SEARCH_RESULTS,
      EXPLORE_PAGE.IMAGE_NOTE,
      EXPLORE_PAGE.VIDEO_NOTE,
      EXPLORE_PAGE.COMMENT_PANEL,
    ]);
    if (!permittable.has(page)) {
      throw fail("EXPLORE_PAGE_NOT_PERMITTABLE", `no permit can be issued on page ${String(page)}`, { page });
    }
    return page;
  }

  // --- typed methods (the only surface the run loop may call) ---------------

  async function openBoundSearch() {
    const page = assertPermittablePage();
    if (page !== EXPLORE_PAGE.HOME_FEED) {
      throw fail("EXPLORE_ROLE_PAGE_MISMATCH", "OPEN_SEARCH is only valid on HOME_FEED", { page });
    }
    const target = resolveTapTarget(internal.last.xml, {
      resourceId: [/search/i],
      desc: [/搜索/],
      yMin: 120,
      yMax: 900,
    });
    if (!target) throw fail("EXPLORE_TARGET_UNRESOLVED", "no search entry in the current dump");
    await performPermitted({
      navigationRole: "OPEN_SEARCH",
      page,
      resolvedPayload: { primitive: "tap", x: target.x, y: target.y },
    });
    const post = await observe({ label: "post:OPEN_SEARCH" });
    return { navigated: post.surface.page === EXPLORE_PAGE.SEARCH_HOME, novel: null, page: post.surface.page };
  }

  async function submitBoundQuery({ queryIndex } = {}) {
    const page = assertPermittablePage();
    if (page !== EXPLORE_PAGE.SEARCH_HOME) {
      throw fail("EXPLORE_ROLE_PAGE_MISMATCH", "SUBMIT_SEARCH is only valid on SEARCH_HOME", { page });
    }
    const query = queries[Number(queryIndex)];
    if (typeof query !== "string" || !query.trim()) {
      throw fail("EXPLORE_QUERY_INDEX_INVALID", "no sealed query for the requested index", { queryIndex });
    }
    await performPermitted({
      navigationRole: "SUBMIT_SEARCH",
      page,
      resolvedPayload: { primitive: "input_text", text: query, enter: true },
    });
    const post = await observe({ label: "post:SUBMIT_SEARCH" });
    // IME restoration: a submit that leaves the editor focused (IME did not
    // commit) is an honest failure report — the machine retries the submit; no
    // keyboard is ever assumed dismissed
    const navigated = post.surface.page === EXPLORE_PAGE.SEARCH_RESULTS;
    return { navigated, novel: null, page: post.surface.page, editorFocused: post.surface.editorFocused === true };
  }

  async function scrollBoundFeed() {
    return scroll({ navigationRole: "SCROLL_FEED", expectPage: new Set([EXPLORE_PAGE.HOME_FEED, EXPLORE_PAGE.HOME_FEED_EMPTY]) });
  }

  async function scrollBoundResults() {
    return scroll({ navigationRole: "SCROLL_RESULTS", expectPage: new Set([EXPLORE_PAGE.SEARCH_RESULTS]) });
  }

  async function scrollBoundComments() {
    return scroll({ navigationRole: "SCROLL_COMMENTS", expectPage: new Set([EXPLORE_PAGE.COMMENT_PANEL]) });
  }

  async function scroll({ navigationRole, expectPage }) {
    const page = assertPermittablePage();
    if (!expectPage.has(page)) {
      throw fail("EXPLORE_ROLE_PAGE_MISMATCH", `${navigationRole} is not valid on ${page}`, { page });
    }
    const display = resolveDisplayBounds(internal.last.xml);
    if (!display) throw fail("EXPLORE_TARGET_UNRESOLVED", "no display bounds in the current dump");
    await performPermitted({
      navigationRole,
      page,
      resolvedPayload: {
        primitive: "swipe",
        x1: Math.round(display.width / 2),
        y1: Math.round(display.height * 0.72),
        x2: Math.round(display.width / 2),
        y2: Math.round(display.height * 0.3),
        durationMs: 400,
      },
    });
    const post = await observe({ label: `post:${navigationRole}` });
    return { navigated: expectPage.has(post.surface.page), novel: null, page: post.surface.page };
  }

  async function openBoundContent({ candidateKey, candidateKind } = {}) {
    const page = assertPermittablePage();
    // candidates carry the identity (V3-I05 key); tap evidence lives on card
    const entry = (internal.last.surface.candidates ?? []).find(
      (c) => c?.identity?.keyValue === candidateKey,
    );
    const card = entry?.card ?? null;
    if (!card || typeof card.cx !== "number" || typeof card.cy !== "number") {
      // the claimed card is gone from the CURRENT dump: fail closed — never
      // re-tap a stale coordinate
      throw fail("EXPLORE_TARGET_UNRESOLVED", "claimed card is not present in the current dump", {
        candidateKey: String(candidateKey ?? ""),
      });
    }
    // V3-I05 earliest claim is canonical: reserve BEFORE the open. Duplicate
    // fallback claims reconcile onto the canonical row and never re-credit
    // novelty — the claim result flows through to the confirm below.
    const claim = typeof claimTarget === "function"
      ? await claimTarget({ keyKind: candidateKind, keyValue: candidateKey })
      : null;
    if (claim) internal.claimedKeys.add(String(candidateKey));
    // detail-assertion context uses the card's MEDIA kind (video|note), while
    // the claim uses the identity keyKind (stable|fallback) — separate concerns
    internal.sourceCardKind = card.kind === "video" ? "video" : "note";
    await performPermitted({
      navigationRole: "OPEN_CONTENT_CARD",
      page,
      resolvedPayload: { primitive: "tap", x: Math.round(card.cx), y: Math.round(card.cy) },
    });
    const post = await observe({ label: "post:OPEN_CONTENT_CARD" });
    const landed = EXPLORE_DETAIL_PAGES.has(post.surface.page);
    // Novelty (V3-I05): a FRESH stable claim is credited at claim time (the CP
    // marks it confirmed with novelty 1 immediately); a fallback claim gets its
    // 0→1 credit only from the post-open confirm. A duplicate stable re-claim
    // returns novel:false from the CP and never re-credits.
    let novel = null;
    if (landed) {
      if (claim?.novel === true) {
        novel = true;
      } else if (claim?.targetId && typeof confirmTarget === "function") {
        // A fallback fingerprint is NOT stable evidence — only rekey when the
        // post-open dump itself proves a durable note id; otherwise the plain
        // confirm takes the 0→1 credit and the row stays fallback.
        const stableProof = String(post.xml ?? "").match(/note[s]?\/([0-9a-f]{16,32})/i)?.[1]?.toLowerCase();
        const confirmed = await confirmTarget({
          targetId: claim.targetId,
          stableKeyValue: stableProof ? `note_id:${stableProof}` : null,
        });
        novel = confirmed?.novel === true;
      }
    }
    await journal({
      type: "TARGET_CLAIMED",
      candidateKey: String(candidateKey ?? "").slice(0, 96),
      keyKind: candidateKind ?? null,
      novel,
    });
    return { navigated: landed, novel, page: post.surface.page };
  }

  async function openBoundComments() {
    const page = assertPermittablePage();
    if (page !== EXPLORE_PAGE.IMAGE_NOTE && page !== EXPLORE_PAGE.VIDEO_NOTE) {
      throw fail("EXPLORE_ROLE_PAGE_MISMATCH", "OPEN_COMMENT_PANEL is only valid on a note detail", { page });
    }
    const control = internal.last.surface.commentControl;
    if (!control || typeof control.x !== "number" || typeof control.y !== "number") {
      throw fail("EXPLORE_TARGET_UNRESOLVED", "no comment entry in the current dump");
    }
    await performPermitted({
      navigationRole: "OPEN_COMMENT_PANEL",
      page,
      resolvedPayload: { primitive: "tap", x: Math.round(control.x), y: Math.round(control.y) },
    });
    const post = await observe({ label: "post:OPEN_COMMENT_PANEL" });
    return { navigated: post.surface.page === EXPLORE_PAGE.COMMENT_PANEL, novel: null, page: post.surface.page };
  }

  async function pauseBoundVideo() {
    if (visionEnabled !== true) {
      throw fail("EXPLORE_VISION_DISABLED", "PAUSE_VIDEO_SAFE_ZONE requires the sealed vision canary");
    }
    if (!vision || typeof vision.proposeCanaryTap !== "function") {
      throw fail("EXPLORE_VISION_NAVIGATOR_ABSENT", "no vision navigator is bound to this lane");
    }
    const page = assertPermittablePage();
    if (page !== EXPLORE_PAGE.VIDEO_NOTE) {
      throw fail("EXPLORE_ROLE_PAGE_MISMATCH", "PAUSE_VIDEO_SAFE_ZONE is only valid on a VIDEO_NOTE", { page });
    }
    const observation = requireFreshObservation();
    const dumpDecision = observation.surface?.dumpDecision ?? null;
    if (dumpDecision?.verdict === "FORBIDDEN_OR_RISKY") {
      await journal({
        type: "VISION_TAP_REFUSED",
        navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
        page,
        reason: "EXPLORATION_VISION_DUMP_FORBIDDEN",
      });
      return { navigated: true, novel: null, page, paused: false, visionRefused: "EXPLORATION_VISION_DUMP_FORBIDDEN" };
    }
    // COMPLETE_SAFE_UNIQUE is already resolved by DUMP. PAUSE is optional in
    // V3, so the vision shadow/canary does not manufacture a second route.
    if (dumpDecision?.verdict === "COMPLETE_SAFE_UNIQUE") {
      await journal({
        type: "VISION_NOT_NEEDED",
        navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
        page,
        dumpVerdict: dumpDecision.verdict,
        tapAuthorized: false,
      });
      return { navigated: true, novel: null, page, paused: false, visionSkipped: "DUMP_COMPLETE_SAFE_UNIQUE" };
    }
    const request = {
      navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
      page,
      evidenceHash: observation.evidenceHash,
      dumpDecision,
    };
    if (vision.mode === "shadow") {
      const shadow = await vision.observeShadow(request);
      const recheck = await observe({ label: "post-analysis-shadow:PAUSE_VIDEO_SAFE_ZONE" });
      const agreement = shadow.ok === true
        && recheck.surface.page === page
        && recheck.surface.dumpDecision?.verdict !== "FORBIDDEN_OR_RISKY";
      await journal({
        type: "VISION_RECHECK",
        navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
        page,
        source: "VISION",
        agreement,
        initialEvidenceHash: observation.evidenceHash,
        recheckEvidenceHash: recheck.evidenceHash,
        tapAuthorized: false,
      });
      return {
        navigated: true,
        novel: null,
        page: recheck.surface.page,
        paused: false,
        shadow: true,
        agreement,
      };
    }
    // The provider only proposes a block. A fresh DUMP after analysis must
    // agree before CP issuance, and consumption performs a second fresh read.
    const proposed = await vision.proposeCanaryTap(request);
    if (!proposed.ok || proposed.candidateReady !== true) {
      await journal({
        type: "VISION_TAP_REFUSED",
        navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
        page,
        reason: proposed.reason ?? null,
      });
      return {
        navigated: false,
        novel: null,
        page,
        paused: false,
        visionRefused: proposed.reason ?? "EXPLORATION_VISION_CANDIDATE_FAILED",
      };
    }
    const recheck = await observe({ label: "post-analysis:PAUSE_VIDEO_SAFE_ZONE" });
    const freshDecision = recheck.surface?.dumpDecision ?? null;
    const candidateBounds = proposed.target?.bounds ?? null;
    const agreement = recheck.surface.page === page
      && ["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"].includes(freshDecision?.verdict)
      && rectContains(freshDecision?.positiveRegion, candidateBounds)
      && !(freshDecision?.protectedZones ?? []).some((zone) => rectIntersects(zone, candidateBounds));
    if (!agreement) {
      await journal({
        type: "VISION_TAP_REFUSED",
        navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
        page,
        reason: "EXPLORATION_DUMP_VISION_CONFLICT",
        initialEvidenceHash: observation.evidenceHash,
        recheckEvidenceHash: recheck.evidenceHash,
        tapAuthorized: false,
      });
      return { navigated: true, novel: null, page: recheck.surface.page, paused: false, visionRefused: "EXPLORATION_DUMP_VISION_CONFLICT" };
    }
    const center = proposed.target?.center;
    if (!Number.isInteger(center?.x) || !Number.isInteger(center?.y)) {
      throw fail("EXPLORE_VISION_TARGET_INVALID", "vision candidate has no integer center");
    }
    const performed = await performPermitted({
      navigationRole: "PAUSE_VIDEO_SAFE_ZONE",
      page,
      resolvedPayload: { primitive: "tap", x: center.x, y: center.y },
      visualProof: {
        source: "VISION",
        analysisRef: proposed.analysisRef,
        issuanceEvidenceHash: recheck.evidenceHash,
        dumpVerdict: freshDecision.verdict,
        agreement: true,
      },
      onIssued: () => vision.recordPermitIssued?.(),
    });
    if (typeof vision.recordPermitConsumed === "function") vision.recordPermitConsumed();
    if (performed?.job?.status === "succeeded"
      && performed?.job?.result?.output?.primitive === "tap"
      && typeof vision.recordPhysicalTap === "function") {
      vision.recordPhysicalTap();
    }
    const post = await observe({ label: "post:PAUSE_VIDEO_SAFE_ZONE" });
    return { navigated: true, novel: null, page: post.surface.page, paused: true };
  }

  async function backBound() {
    const page = assertPermittablePage();
    await performPermitted({
      navigationRole: "BACK",
      page,
      resolvedPayload: { primitive: "back" },
    });
    const post = await observe({ label: "post:BACK" });
    return { navigated: true, novel: null, page: post.surface.page };
  }

  async function restoreBound() {
    const page = assertPermittablePage();
    await performPermitted({
      navigationRole: "RESTORE",
      page,
      resolvedPayload: { primitive: "launch_app", package: XHS_PACKAGE },
    });
    const post = await observe({ label: "post:RESTORE" });
    return { navigated: true, novel: null, page: post.surface.page };
  }

  /**
   * Dispatch a machine decision to its typed method. The mapping is total over
   * the closed vocabulary; unknown roles and actions fail closed.
   */
  async function executeNavigation(decision) {
    if (decision?.action !== "NAVIGATE") {
      throw fail("EXPLORE_DECISION_INVALID", "executeNavigation requires a NAVIGATE decision");
    }
    const method = EXPLORE_ROLE_METHODS[decision.navigationRole];
    if (!method || typeof typed[method] !== "function") {
      throw fail("EXPLORE_ROLE_UNBOUND", `no typed method for navigation role ${String(decision.navigationRole)}`, {
        navigationRole: decision.navigationRole,
      });
    }
    return typed[method](decision);
  }

  const typed = {
    openBoundSearch,
    submitBoundQuery,
    scrollBoundFeed,
    scrollBoundResults,
    scrollBoundComments,
    openBoundContent,
    openBoundComments,
    pauseBoundVideo,
    backBound,
    restoreBound,
  };

  const api = {
    alias,
    laneId,
    laneRole,
    authorityId,
    observe,
    executeNavigation,
    ...typed,
    lastObservation: () => internal.last,
    stats: () => ({
      consumedPermits: internal.consumedPermits,
      observationCount: internal.observationCount,
      claimedKeys: [...internal.claimedKeys],
    }),
  };
  return api;
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
 * Run ONE lane to a terminal outcome (plan §5.3 runner bridge).
 * The machine sees ONLY this loop's driver handle — never a raw primitive,
 * token, coordinate, or provider path.
 * @returns lane receipt { laneId, alias, state, decisions, outcome, restored }
 */
export async function runExploreLane({
  driver,
  laneState,
  now = () => Date.now(),
  maxCycles = 96,
  restoreMaxBacks = 8,
} = {}) {
  if (!driver || !laneState) throw fail("EXPLORE_LANE_ARGS_INVALID", "runExploreLane requires driver+laneState");
  const decisions = [];
  let state = laneState;
  let report = null;
  let outcome = null;

  let observation = await driver.observe({ label: "lane-initial" });
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const phaseBefore = state.phase;
    const step = exploreStep({ state, observation: observation.surface, report, nowMs: now() });
    state = step.state;
    const decision = step.decision;
    decisions.push({ cycle, phase: phaseBefore, ...decision });
    if (decision.action === "DONE") {
      outcome = { kind: "DONE", reason: decision.reason };
      break;
    }
    if (decision.action === "STOP") {
      outcome = { kind: "STOP", reason: decision.reason };
      break;
    }
    try {
      report = await driver.executeNavigation(decision);
      // the typed method observed the post-navigation surface internally —
      // the machine must ALWAYS decide on the freshest CP-owned observation
      observation = driver.lastObservation();
    } catch (error) {
      if (error?.code === "EXPLORATION_BUDGET_EXCEEDED") {
        outcome = { kind: "STOP", reason: "BUDGET_EXHAUSTED", errorCode: error.code };
        break;
      }
      if (error?.code === "EXPLORATION_BUDGET_RECEIPT_UNPROVEN") throw error;
      report = { navigated: false, novel: null, errorCode: String(error?.code ?? "EXPLORE_NAVIGATION_ERROR") };
    }
  }
  if (!outcome) outcome = { kind: "STOP", reason: "CYCLE_FLOOR" };

  // Semantic final restoration (P2 gate): BACK to HOME while permits can still
  // be issued; an unrestorable surface is recorded honestly, never faked.
  const restored = await restoreToHome({ driver, maxBacks: restoreMaxBacks });

  return {
    laneId: driver.laneId,
    alias: driver.alias,
    laneRole: driver.laneRole,
    state,
    decisions,
    outcome,
    restored,
    finalPage: driver.lastObservation()?.surface?.page ?? null,
  };
}

async function restoreToHome({ driver, maxBacks }) {
  const trail = [];
  for (let index = 0; index < maxBacks; index += 1) {
    const page = driver.lastObservation()?.surface?.page ?? null;
    if (page === EXPLORE_PAGE.HOME_FEED || page === EXPLORE_PAGE.HOME_FEED_EMPTY) {
      return { restored: true, backs: index, trail };
    }
    try {
      const result = await driver.backBound();
      trail.push({ page, back: index, landed: result?.page ?? null });
    } catch (error) {
      trail.push({ page, back: index, error: String(error?.code ?? "RESTORE_ERROR") });
      return { restored: false, backs: index, trail };
    }
  }
  return { restored: false, backs: maxBacks, trail };
}
