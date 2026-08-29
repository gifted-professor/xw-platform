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
import { classifyPage, PAGE_CLASS } from "./xhs-feed-surface.mjs";
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

function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isSearchActivityFocus(focus) {
  return /GlobalSearchActivity|SearchActivity|search/i.test(focus || "");
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
  // V3 read-only vocabulary: the note comment panel is a PERMITTED observation
  // surface (commentScreens budget, BACK-only). It is NOT an exit — the V2.1
  // "forbidden" classification protected a like/comment-effect machine; V3 has
  // zero social authority and can only ever read here.
  if (base.page === PAGE_CLASS.NOTE_COMMENT_ACTIVITY) {
    return {
      page: EXPLORE_PAGE.COMMENT_PANEL,
      evidence,
      cards: [],
      candidates: [],
      comments: parseComments(xml),
      commentControl: null,
      editorFocused: false,
      sourceCardKind,
      exit: false,
    };
  }
  const exitMap = {
    [PAGE_CLASS.PUBLISH_EDITOR]: EXPLORE_PAGE.EXIT_PUBLISH,
    [PAGE_CLASS.PRODUCT_ENTRY]: EXPLORE_PAGE.EXIT_PRODUCT,
    [PAGE_CLASS.AUTH_RISK]: EXPLORE_PAGE.EXIT_AUTH_RISK,
  };
  if (exitMap[base.page]) {
    return { page: exitMap[base.page], evidence, cards: [], candidates: [], comments: null, commentControl: null, editorFocused: false, sourceCardKind, exit: true };
  }
  if (base.page === PAGE_CLASS.SYSTEM_OVERLAY) {
    return { page: EXPLORE_PAGE.SYSTEM_OVERLAY, evidence, cards: [], candidates: [], comments: null, commentControl: null, editorFocused: false, sourceCardKind, exit: false };
  }
  if (base.page === PAGE_CLASS.HOME_FEED || base.page === PAGE_CLASS.HOME_FEED_EMPTY) {
    const cards = base.cards ?? [];
    const candidates = cards.map((card) => ({ card, identity: exploreCardIdentity({ card, xml }) }));
    return {
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
    };
  }

  // search surfaces: results (>=1 parsed tile) outrank the empty search home
  if (isSearchActivityFocus(focus)) {
    const parsed = parseSearchResults(xml, {});
    const editor = xml.match(/class="[^"]*EditText[^"]*"[^>]*focus="true"|class="[^"]*EditText[^"]*"[^>]*focused="true"/);
    if (parsed.cards.length > 0) {
      const candidates = parsed.cards.map((card) => ({ card, identity: exploreCardIdentity({ card, xml }) }));
      return {
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
      };
    }
    return {
      page: EXPLORE_PAGE.SEARCH_HOME,
      evidence: [...evidence, "search_input_present"],
      cards: [],
      candidates: [],
      comments: null,
      commentControl: null,
      editorFocused: Boolean(editor),
      sourceCardKind,
      exit: false,
    };
  }

  if (base.page === PAGE_CLASS.IMAGE_NOTE || base.page === PAGE_CLASS.VIDEO_NOTE) {
    const comments = parseComments(xml);
    const bar = parseBottomBar(xml);
    return {
      page: base.page,
      evidence,
      cards: [],
      candidates: [],
      comments,
      commentControl: bar?.comment || null,
      editorFocused: false,
      exit: false,
      sourceCardKind: base.page === PAGE_CLASS.VIDEO_NOTE ? "video" : (sourceCardKind ?? "note"),
    };
  }

  return {
    page: EXPLORE_PAGE.UNKNOWN,
    evidence: evidence.length > 0 ? evidence : ["no_page_evidence"],
    cards: [],
    candidates: [],
    comments: null,
    commentControl: null,
    editorFocused: false,
    sourceCardKind,
    exit: false,
  };
}

export { parseFeedCards };