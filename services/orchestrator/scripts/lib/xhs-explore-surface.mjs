/**
 * xhs-explore-surface.mjs — V3 free-exploration DUMP-only surface parser
 * (plan V2 §5.3, invariants V3-I03/I05/I07).
 *
 * Pure: (fresh dump XML + focus string + lane role) in → classification out.
 * Wraps the V2.1 feed/detail classifier (xhs-feed-surface.mjs) and the search
 * result parser (ops/_xhs-parse.mjs::parseSearchResults) into the closed
 * exploration vocabulary:
 *
 *   HOME_FEED | HOME_FEED_EMPTY | SEARCH_HOME | SEARCH_RESULTS | IMAGE_NOTE |
 *   VIDEO_NOTE | COMMENT_PANEL | SYSTEM_OVERLAY | EXIT_* | UNKNOWN
 *
 * plus THREE pure decisions the lane machines consume:
 *   - exploreCardIdentity(): the V3-I05 claim key for a candidate. STABLE only
 *     from durable id evidence in the dump; otherwise a fallback fingerprint
 *     (title|author normalized) — never a coordinate.
 *   - selectExploreCandidates(): deterministic seeded permutation over
 *     CURRENTLY OBSERVED candidate ids only. Never invents an id, never
 *     carries one across screens.
 *
 * No device I/O; tests feed fixture dumps.
 */
import { createHash } from "node:crypto";
import {
  parseFeedCards,
  parseSearchResults,
  parseBottomBar,
  parseComments,
} from "../../ops/_xhs-parse.mjs";
import { classifyPage, PAGE_CLASS, XHS_PACKAGE } from "./xhs-feed-surface.mjs";
import { canonicalJson } from "./xhs-exploration-mission.mjs";

export const EXPLORE_PAGE = Object.freeze({
  HOME_FEED: "HOME_FEED",
  HOME_FEED_EMPTY: "HOME_FEED_EMPTY",
  SEARCH_HOME: "SEARCH_HOME",
  SEARCH_RESULTS: "SEARCH_RESULTS",
  IMAGE_NOTE: "IMAGE_NOTE",
  VIDEO_NOTE: "VIDEO_NOTE",
  COMMENT_PANEL: "COMMENT_PANEL",
  SYSTEM_OVERLAY: "SYSTEM_OVERLAY",
  EXIT_PUBLISH: "EXIT_PUBLISH",
  EXIT_PRODUCT: "EXIT_PRODUCT",
  EXIT_AUTH_RISK: "EXIT_AUTH_RISK",
  EXIT_COMMENT_ACTIVITY: "EXIT_COMMENT_ACTIVITY",
  UNKNOWN: "UNKNOWN",
});

/** Exit classes are explicit machine stops — never "try something else".
 *  EXIT_COMMENT_ACTIVITY is retained in the vocabulary but unreachable: the
 *  note comment panel classifies as COMMENT_PANEL (read-only, V3). */
export const EXPLORE_EXIT_PAGES = Object.freeze(new Set([
  EXPLORE_PAGE.EXIT_PUBLISH,
  EXPLORE_PAGE.EXIT_PRODUCT,
  EXPLORE_PAGE.EXIT_AUTH_RISK,
]));

/** Detail pages that satisfy one novel open when reached from a candidate. */
export const EXPLORE_DETAIL_PAGES = Object.freeze(new Set([
  EXPLORE_PAGE.IMAGE_NOTE,
  EXPLORE_PAGE.VIDEO_NOTE,
]));

/** Closed DUMP verdict vocabulary for navigation-role preconditions. */
export const EXPLORE_DUMP_VERDICT = Object.freeze({
  COMPLETE_SAFE_UNIQUE: "COMPLETE_SAFE_UNIQUE",
  AMBIGUOUS_SAFE: "AMBIGUOUS_SAFE",
  ABSENT_OR_INVALID: "ABSENT_OR_INVALID",
  FORBIDDEN_OR_RISKY: "FORBIDDEN_OR_RISKY",
});

export const EXPLORE_DUMP_VERDICTS = Object.freeze(Object.values(EXPLORE_DUMP_VERDICT));

const PAUSE_VIDEO_ROLE = "PAUSE_VIDEO_SAFE_ZONE";
const DUMP_FORBIDDEN_PAGES = new Set([
  EXPLORE_PAGE.SYSTEM_OVERLAY,
  EXPLORE_PAGE.EXIT_PUBLISH,
  EXPLORE_PAGE.EXIT_PRODUCT,
  EXPLORE_PAGE.EXIT_AUTH_RISK,
  EXPLORE_PAGE.UNKNOWN,
]);

function parseBounds(value) {
  const match = String(value || "").match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function dumpNodes(xml) {
  const nodes = [];
  for (const raw of String(xml || "").match(/<node\b[^>]*>/g) ?? []) {
    const attrs = {};
    for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
    nodes.push({
      attrs,
      bounds: parseBounds(attrs.bounds),
      searchable: [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class]
        .filter(Boolean)
        .join(" "),
    });
  }
  return nodes;
}

function area(bounds) {
  return bounds ? (bounds.x2 - bounds.x1) * (bounds.y2 - bounds.y1) : 0;
}

function toRect(bounds) {
  return bounds ? {
    x: bounds.x1,
    y: bounds.y1,
    w: bounds.x2 - bounds.x1,
    h: bounds.y2 - bounds.y1,
  } : null;
}

function intersectBounds(a, b) {
  if (!a || !b) return null;
  const out = {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
  return out.x2 > out.x1 && out.y2 > out.y1 ? out : null;
}

function centerIn(bounds, region) {
  if (!bounds || !region) return false;
  const x = (bounds.x1 + bounds.x2) / 2;
  const y = (bounds.y1 + bounds.y2) / 2;
  return x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2;
}

function overlaps(a, b) {
  return Boolean(a && b && a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1);
}

function verdict(verdictValue, {
  page = null,
  navigationRole = null,
  reasons = [],
  candidateCount = 0,
  displayBounds = null,
  positiveRegion = null,
  protectedZones = [],
  requiredLandmarks = [],
  positiveRoles = [],
  visionEligible = false,
  dumpNavigationEligible = false,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    verdict: verdictValue,
    page,
    navigationRole,
    reasons: Object.freeze([...reasons]),
    candidateCount,
    displayBounds: displayBounds ? Object.freeze({ ...displayBounds }) : null,
    positiveRegion: positiveRegion ? Object.freeze({ ...positiveRegion }) : null,
    protectedZones: Object.freeze(protectedZones.map((zone) => Object.freeze({ ...zone }))),
    requiredLandmarks: Object.freeze([...requiredLandmarks]),
    positiveRoles: Object.freeze([...positiveRoles]),
    visionEligible,
    dumpNavigationEligible,
  });
}

/**
 * DUMP-only precondition for the vision role. Coordinates remain private to
 * this parsed observation; the lane machine receives only the typed verdict.
 */
function pauseVideoDumpDecision(xml) {
  const nodes = dumpNodes(xml);
  const baseMeta = {
    page: EXPLORE_PAGE.VIDEO_NOTE,
    navigationRole: PAUSE_VIDEO_ROLE,
    requiredLandmarks: ["xhs_package", "video_note", "display_bounds", "video_surface", "protected_zones"],
    positiveRoles: [PAUSE_VIDEO_ROLE],
  };
  const display = nodes
    .filter((node) => node.bounds?.x1 === 0 && node.bounds?.y1 === 0)
    .sort((a, b) => area(b.bounds) - area(a.bounds))[0]?.bounds ?? null;
  if (!display || display.x2 - display.x1 < 320 || display.y2 - display.y1 < 640) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, {
      ...baseMeta,
      reasons: ["display_bounds_absent_or_invalid"],
      visionEligible: false,
    });
  }

  const height = display.y2 - display.y1;
  const statusDefault = display.y1 + Math.max(96, Math.round(height * 0.05));
  // VIDEO_NOTE reserves the entire bottom interaction shelf (caption/actions
  // plus system navigation), not merely the OS navigation-bar inset.
  const bottomDefault = display.y2 - Math.max(520, Math.round(height * 13 / 60));
  const statusBottom = nodes
    .filter((node) => /status.?bar/i.test(node.searchable) && node.bounds && node.bounds.y2 <= display.y1 + height * 0.2)
    .reduce((max, node) => Math.max(max, node.bounds.y2), statusDefault);
  const bottomTop = nodes
    .filter((node) => /navigation.?bar|bottom.?bar/i.test(node.searchable) && node.bounds && node.bounds.y1 >= display.y1 + height * 0.7)
    .reduce((min, node) => Math.min(min, node.bounds.y1), bottomDefault);
  const displayBounds = toRect(display);
  const protectedZones = [
    { kind: "status_bar", x: display.x1, y: display.y1, w: display.x2 - display.x1, h: statusBottom - display.y1 },
    { kind: "bottom", x: display.x1, y: bottomTop, w: display.x2 - display.x1, h: display.y2 - bottomTop },
  ];
  const spatialMeta = { ...baseMeta, displayBounds, protectedZones };
  const protectedSafeBand = { x1: display.x1, y1: statusBottom, x2: display.x2, y2: bottomTop };
  if (protectedSafeBand.y2 <= protectedSafeBand.y1) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, {
      ...spatialMeta,
      reasons: ["protected_zones_cover_display"],
      visionEligible: false,
    });
  }

  const videoSurface = nodes
    .filter((node) => /(?:VideoView|TextureView|SurfaceView)|视频(?:画面|区域)/i.test(node.searchable) && node.bounds)
    .sort((a, b) => area(b.bounds) - area(a.bounds))[0]?.bounds ?? null;
  const positiveRegion = intersectBounds(videoSurface, protectedSafeBand);
  if (!positiveRegion || area(positiveRegion) < area(display) * 0.1) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, {
      ...spatialMeta,
      reasons: ["positive_video_region_absent_or_invalid"],
      positiveRegion: toRect(positiveRegion),
      visionEligible: false,
    });
  }
  const roleMeta = { ...spatialMeta, positiveRegion: toRect(positiveRegion) };

  const candidateNodes = nodes.filter((node) => /(?:^|\s)(?:播放|暂停|play|pause)(?:\s|$)/i.test(node.searchable));
  const invalidCandidates = candidateNodes.filter((node) => !node.bounds);
  const protectedCandidates = candidateNodes.filter((node) => node.bounds && !centerIn(node.bounds, positiveRegion));
  if (protectedCandidates.length > 0) {
    return verdict(EXPLORE_DUMP_VERDICT.FORBIDDEN_OR_RISKY, {
      ...roleMeta,
      reasons: ["playback_candidate_in_protected_or_non_video_region"],
      candidateCount: candidateNodes.length,
      visionEligible: false,
    });
  }
  if (invalidCandidates.length > 0) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, {
      ...roleMeta,
      reasons: ["playback_candidate_bounds_invalid"],
      candidateCount: candidateNodes.length,
      visionEligible: true,
    });
  }

  const safeCandidates = candidateNodes.filter((node) => centerIn(node.bounds, positiveRegion));
  const riskyNodes = nodes.filter((node) => (
    /点赞|评论|收藏|关注|私信|发送|回复|分享|发布|支付|付款|购买|登录|验证码|认证|授权/i.test(node.searchable)
  ));
  for (const candidate of safeCandidates) {
    const x = (candidate.bounds.x1 + candidate.bounds.x2) / 2;
    const y = (candidate.bounds.y1 + candidate.bounds.y2) / 2;
    const radius = Math.max(48, Math.min(96, Math.round((positiveRegion.x2 - positiveRegion.x1) * 0.08)));
    const candidateRegion = { x1: x - radius, y1: y - radius, x2: x + radius, y2: y + radius };
    if (riskyNodes.some((node) => node !== candidate && overlaps(node.bounds, candidateRegion))) {
      return verdict(EXPLORE_DUMP_VERDICT.FORBIDDEN_OR_RISKY, {
        ...roleMeta,
        reasons: ["risky_control_in_candidate_region"],
        candidateCount: safeCandidates.length,
        visionEligible: false,
      });
    }
  }

  if (safeCandidates.length === 0) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, {
      ...roleMeta,
      reasons: ["playback_candidate_absent"],
      visionEligible: true,
    });
  }
  if (safeCandidates.length > 1) {
    return verdict(EXPLORE_DUMP_VERDICT.AMBIGUOUS_SAFE, {
      ...roleMeta,
      reasons: ["multiple_safe_playback_candidates"],
      candidateCount: safeCandidates.length,
      visionEligible: true,
    });
  }
  return verdict(EXPLORE_DUMP_VERDICT.COMPLETE_SAFE_UNIQUE, {
    ...roleMeta,
    reasons: ["unique_playback_candidate_in_positive_video_region"],
    candidateCount: 1,
    visionEligible: false,
    dumpNavigationEligible: true,
  });
}

function dumpDecisionForSurface(surface, xml) {
  if (DUMP_FORBIDDEN_PAGES.has(surface.page)) {
    return verdict(EXPLORE_DUMP_VERDICT.FORBIDDEN_OR_RISKY, {
      page: surface.page,
      reasons: [`surface_forbidden:${surface.page}`],
    });
  }
  if (surface.page === EXPLORE_PAGE.VIDEO_NOTE) return pauseVideoDumpDecision(xml);
  const candidates = surface.candidates?.length ?? 0;
  if (surface.page === EXPLORE_PAGE.HOME_FEED || surface.page === EXPLORE_PAGE.SEARCH_RESULTS) {
    if (candidates > 1) return verdict(EXPLORE_DUMP_VERDICT.AMBIGUOUS_SAFE, { page: surface.page, candidateCount: candidates, reasons: ["multiple_allowlisted_candidates"] });
    if (candidates === 1) return verdict(EXPLORE_DUMP_VERDICT.COMPLETE_SAFE_UNIQUE, { page: surface.page, candidateCount: 1, reasons: ["unique_allowlisted_candidate"], dumpNavigationEligible: true });
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, { page: surface.page, reasons: ["allowlisted_candidate_absent"] });
  }
  if (surface.page === EXPLORE_PAGE.HOME_FEED_EMPTY) {
    return verdict(EXPLORE_DUMP_VERDICT.ABSENT_OR_INVALID, { page: surface.page, reasons: ["explicit_empty_surface"] });
  }
  return verdict(EXPLORE_DUMP_VERDICT.COMPLETE_SAFE_UNIQUE, { page: surface.page, reasons: ["allowlisted_surface"], dumpNavigationEligible: true });
}

function withDumpDecision(surface, xml) {
  return Object.freeze({ ...surface, dumpDecision: dumpDecisionForSurface(surface, xml) });
}

function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isSearchActivityFocus(focus) {
  return /GlobalSearchActivity|SearchActivity|search/i.test(focus || "");
}

function declaredPackageDrift({ focus, pkg }) {
  const focusPackage = String(focus || "").match(/(?:^|\s)([\w.]+)\/[\w.$]+/)?.[1] ?? null;
  return [pkg, focusPackage]
    .filter((value) => value !== null && String(value).length > 0)
    .some((value) => String(value) !== XHS_PACKAGE);
}

/**
 * V3-I05 identity for one candidate card. Priority:
 *   1. durable note-id evidence in the dump XML (resource-id bound value or
 *      a note path inside a content-desc) — STABLE;
 *   2. normalized title|author fingerprint — FALLBACK (order-free, two lanes
 *      observing the same card converge onto the same key).
 */
export function exploreCardIdentity({ card, xml = "" } = {}) {
  const desc = String(card?.desc || "");
  const resourceMatch = String(xml || "").match(
    /resource-id="[^"]*(?:note[_-]?id|noteId)[^"]*"[^>]*text="([^"]+)"/,
  );
  if (resourceMatch?.[1]) {
    return { keyKind: "stable", keyValue: `note_id:${resourceMatch[1]}`, stableEvidence: "resource_id_note_id" };
  }
  const notePath = desc.match(/note[s]?\/([0-9a-f]{16,32})/i);
  if (notePath) {
    return { keyKind: "stable", keyValue: `note_id:${notePath[1].toLowerCase()}`, stableEvidence: "desc_note_path" };
  }
  const title = normalizedText(card?.title || card?.text || "");
  const author = normalizedText(card?.author || "");
  if (title || author) {
    return {
      keyKind: "fallback",
      keyValue: `fp:${createHash("sha256").update(canonicalJson({ title, author }), "utf8").digest("hex").slice(0, 32)}`,
      stableEvidence: "fallback_title_author",
    };
  }
  return { keyKind: "fallback", keyValue: null, stableEvidence: "identity_unresolvable" };
}

/** Drop already-claimed identity keys. Runs with or without a rank seed:
 *  exclusion is a correctness obligation (V3-I05), seeding is only a policy. */
function excludeKnownKeys(candidates, knownKeys) {
  return candidates.filter((c) => c?.identity?.keyValue && !knownKeys.has(c.identity.keyValue));
}

/**
 * Deterministic seeded permutation (V3-I03). Rank is a pure function of
 * (seed, identity) — a future model ranker may only permute these SAME ids
 * under a new sealed mode. `exclude` filters already-claimed keys.
 */
export function selectExploreCandidates({ candidates, seed, count = null, exclude = new Set() } = {}) {
  if (!Array.isArray(candidates)) return [];
  const ranked = candidates
    .filter((c) => c?.identity?.keyValue && !exclude.has(c.identity.keyValue))
    .map((c) => ({
      ...c,
      rank: createHash("sha256").update(`${seed}:${c.identity.keyValue}`, "utf8").digest("hex").slice(0, 16),
    }))
    .sort((a, b) => (
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.identity.keyValue.localeCompare(b.identity.keyValue)
    ));
  const capped = Number.isInteger(count) && count >= 0 ? count : ranked.length;
  return ranked.slice(0, capped);
}

/**
 * Classify the CURRENT page for one exploration lane.
 * @param {object} input
 * @param {string} input.xml - fresh uiautomator dump (CP-owned artifact)
 * @param {string} input.focus - dumpsys currentFocus
 * @param {string|null} input.pkg - package override
 * @param {string} input.laneRole - feed_lane|search_lane (context only)
 * @param {string|null} input.sourceCardKind - media kind of the card that was
 *        opened (video/note conflict guard on detail assertion)
 * @param {string|null} input.seed - candidate rank seed (null = unranked)
 * @param {Set<string>} input.knownKeys - already-claimed identity keys
 * @param {number|null} input.candidateBudget - max ranked candidates returned
 * @returns {{page, evidence, cards, candidates, comments, commentControl,
 *            editorFocused, sourceCardKind, exit}}
 */
export function parseExploreSurface({
  xml = "",
  focus = "",
  pkg = null,
  laneRole = "feed_lane",
  sourceCardKind = null,
  seed = null,
  knownKeys = new Set(),
  candidateBudget = null,
} = {}) {
  void laneRole;
  const base = classifyPage({ xml, focus, pkg, sourceCardKind });
  const evidence = [...(base.evidence ?? [])];
  if (declaredPackageDrift({ focus, pkg })) {
    return withDumpDecision({
      page: EXPLORE_PAGE.UNKNOWN,
      evidence: [...new Set([...evidence, "package_not_xhs"])],
      cards: [],
      candidates: [],
      comments: null,
      commentControl: null,
      editorFocused: false,
      sourceCardKind,
      exit: false,
    }, xml);
  }
  // V3 read-only vocabulary: the note comment panel is a PERMITTED observation
  // surface (commentScreens budget, BACK-only). It is NOT an exit — the V2.1
  // "forbidden" classification protected a like/comment-effect machine; V3 has
  // zero social authority and can only ever read here.
  if (base.page === PAGE_CLASS.NOTE_COMMENT_ACTIVITY) {
    return withDumpDecision({
      page: EXPLORE_PAGE.COMMENT_PANEL,
      evidence,
      cards: [],
      candidates: [],
      comments: parseComments(xml),
      commentControl: null,
      editorFocused: false,
      sourceCardKind,
      exit: false,
    }, xml);
  }
  const exitMap = {
    [PAGE_CLASS.PUBLISH_EDITOR]: EXPLORE_PAGE.EXIT_PUBLISH,
    [PAGE_CLASS.PRODUCT_ENTRY]: EXPLORE_PAGE.EXIT_PRODUCT,
    [PAGE_CLASS.AUTH_RISK]: EXPLORE_PAGE.EXIT_AUTH_RISK,
  };
  if (exitMap[base.page]) {
    return withDumpDecision({ page: exitMap[base.page], evidence, cards: [], candidates: [], comments: null, commentControl: null, editorFocused: false, sourceCardKind, exit: true }, xml);
  }
  if (base.page === PAGE_CLASS.SYSTEM_OVERLAY) {
    return withDumpDecision({ page: EXPLORE_PAGE.SYSTEM_OVERLAY, evidence, cards: [], candidates: [], comments: null, commentControl: null, editorFocused: false, sourceCardKind, exit: false }, xml);
  }
  if (base.page === PAGE_CLASS.HOME_FEED || base.page === PAGE_CLASS.HOME_FEED_EMPTY) {
    const cards = base.cards ?? [];
    const candidates = cards.map((card) => ({ card, identity: exploreCardIdentity({ card, xml }) }));
    return withDumpDecision({
      page: base.page === PAGE_CLASS.HOME_FEED ? EXPLORE_PAGE.HOME_FEED : EXPLORE_PAGE.HOME_FEED_EMPTY,
      evidence,
      cards,
      candidates: seed
        ? selectExploreCandidates({ candidates, seed, count: candidateBudget, exclude: knownKeys })
        : excludeKnownKeys(candidates, knownKeys),
      comments: null,
      commentControl: null,
      editorFocused: false,
      sourceCardKind,
      exit: false,
    }, xml);
  }

  // search surfaces: results (>=1 parsed tile) outrank the empty search home
  if (isSearchActivityFocus(focus)) {
    const parsed = parseSearchResults(xml, {});
    const editor = xml.match(/class="[^"]*EditText[^"]*"[^>]*focus="true"|class="[^"]*EditText[^"]*"[^>]*focused="true"/);
    if (parsed.cards.length > 0) {
      const candidates = parsed.cards.map((card) => ({ card, identity: exploreCardIdentity({ card, xml }) }));
      return withDumpDecision({
        page: EXPLORE_PAGE.SEARCH_RESULTS,
        evidence: [...evidence, `search_tabs=${parsed.tabs?.length ?? 0}`],
        cards: parsed.cards,
        candidates: seed
          ? selectExploreCandidates({ candidates, seed, count: candidateBudget, exclude: knownKeys })
          : excludeKnownKeys(candidates, knownKeys),
        tabs: parsed.tabs,
        comments: null,
        commentControl: null,
        editorFocused: false,
        sourceCardKind,
        exit: false,
      }, xml);
    }
    return withDumpDecision({
      page: EXPLORE_PAGE.SEARCH_HOME,
      evidence: [...evidence, "search_input_present"],
      cards: [],
      candidates: [],
      comments: null,
      commentControl: null,
      editorFocused: Boolean(editor),
      sourceCardKind,
      exit: false,
    }, xml);
  }

  if (base.page === PAGE_CLASS.IMAGE_NOTE || base.page === PAGE_CLASS.VIDEO_NOTE) {
    const comments = parseComments(xml);
    const bar = parseBottomBar(xml);
    return withDumpDecision({
      page: base.page,
      evidence,
      cards: [],
      candidates: [],
      comments,
      commentControl: bar?.comment || null,
      editorFocused: false,
      exit: false,
      sourceCardKind: base.page === PAGE_CLASS.VIDEO_NOTE ? "video" : (sourceCardKind ?? "note"),
    }, xml);
  }

  return withDumpDecision({
    page: EXPLORE_PAGE.UNKNOWN,
    evidence: evidence.length > 0 ? evidence : ["no_page_evidence"],
    cards: [],
    candidates: [],
    comments: null,
    commentControl: null,
    editorFocused: false,
    sourceCardKind,
    exit: false,
  }, xml);
}

export { parseFeedCards };
