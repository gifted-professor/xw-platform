/**
 * xhs-feed-card-select.mjs — dump-driven feed-card selection for the CP
 * `tapFeedCard` recipe primitive (pure functions, no I/O, no device access).
 *
 * Deliberately mirrors the parsing idioms of orchestrator `ops/_xhs-parse.mjs`
 * (parseFeedCards / allNodes): the CP hot path is deployed standalone and must
 * not import from the orchestrator tree. Keep both lists/regexes in sync.
 *
 * Selection contract (see xhs.note.read.fixed plan):
 *   - feed cards are nodes whose content-desc starts with 笔记/视频 and whose
 *     bounds are at least 200x200 (cover tiles);
 *   - the vertical band is RELATIVE to the parsed screen height (yMinFrac..
 *     yMaxFrac) so one sealed recipe serves both 1080x2400 and 1220x2712;
 *   - candidates dedupe by (cx/30, cy/30, title) and sort top-down (cy asc);
 *   - pickIndex selects into that ordered list — coordinates are resolved at
 *     handler execution time, never sealed into the recipe spec.
 */
import { createHash } from "node:crypto";

export const FEED_CARD_KINDS = Object.freeze(["note", "video"]);

/** preferKind aliases: image → note (图文), video → 视频. */
const PREFER_KIND_MAP = Object.freeze({ image: "note", video: "video" });

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function selectError(code, message, details = {}) {
  const e = new Error(message);
  e.code = code;
  e.details = details;
  return e;
}

/**
 * Parse uiautomator dump XML into flat node records + screen geometry.
 * Screen size comes from the root node bounds ([0,0][W,H]); falls back to
 * 1080x2400 when the root is missing or truncated.
 * @param {string} xml
 * @returns {{ nodes: object[], screenWidth: number, screenHeight: number }}
 */
export function parseNodes(xml) {
  const nodes = [];
  const re = /<node\b[^>]*>/g;
  let m;
  let screenWidth = 0;
  let screenHeight = 0;
  while ((m = re.exec(String(xml || "")))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const L = +b[1];
    const T = +b[2];
    const R = +b[3];
    const B = +b[4];
    if (screenWidth === 0 && L === 0 && T === 0 && R > 0 && B > 0) {
      screenWidth = R;
      screenHeight = B;
    }
    nodes.push({
      L,
      T,
      R,
      B,
      cx: Math.round((L + R) / 2),
      cy: Math.round((T + B) / 2),
      w: R - L,
      h: B - T,
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      desc: decodeEntities((tag.match(/content-desc="([^"]*)"/) || [])[1] || ""),
      clickable: /clickable="true"/.test(tag),
      enabled: !/enabled="false"/.test(tag),
      cls: ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop(),
    });
  }
  if (screenWidth === 0) {
    screenWidth = 1080;
    screenHeight = 2400;
  }
  return { nodes, screenWidth, screenHeight };
}

/**
 * Extract feed cards (笔记/视频 cover tiles) from a home-feed dump.
 * Band is relative to screenHeight so both 2400- and 2712-px devices qualify.
 * @param {string} xml
 * @param {{
 *   yMinFrac?: number, yMaxFrac?: number, minW?: number, minH?: number,
 * }} [opts]
 * @returns {object[]} cards sorted top-down, deduped
 */
export function parseFeedCards(xml, opts = {}) {
  const yMinFrac = opts.yMinFrac ?? 0.12;
  const yMaxFrac = opts.yMaxFrac ?? 0.92;
  const minW = opts.minW ?? 200;
  const minH = opts.minH ?? 200;
  const { nodes, screenWidth, screenHeight } = parseNodes(xml);
  const yMin = Math.round(yMinFrac * screenHeight);
  const yMax = Math.round(yMaxFrac * screenHeight);

  const cards = [];
  for (const n of nodes) {
    const d = n.desc;
    if (!/^(笔记|视频)\s/.test(d)) continue;
    if (n.w < minW || n.h < minH) continue;
    if (n.cy < yMin || n.cy > yMax) continue;
    const kind = /^视频/.test(d) ? "video" : "note";
    let title = d;
    let author = "";
    let likes = null;
    let likesText = "";
    let m = d.match(/^(?:笔记|视频)\s+(.*?)\s+来自(.+?)\s+([\d.]+万?\+?)赞/);
    if (m) {
      title = m[1].trim();
      author = m[2].trim();
      likesText = m[3];
      if (/万/.test(m[3])) {
        const num = parseFloat(m[3]);
        likes = Number.isFinite(num) ? Math.round(num * 10000) : null;
      } else {
        likes = Number(m[3].replace(/\+/g, ""));
        if (!Number.isFinite(likes)) likes = null;
      }
    } else {
      m = d.match(/^(?:笔记|视频)\s+(.*?)\s+来自(.+?)\s+赞$/);
      if (m) {
        title = m[1].trim();
        author = m[2].trim();
        likes = 0;
        likesText = "0";
      }
    }
    cards.push({
      kind,
      title,
      author,
      likes,
      likesText,
      desc: d.slice(0, 160),
      x: n.cx,
      y: n.cy,
      cx: n.cx,
      cy: n.cy,
      w: n.w,
      h: n.h,
      L: n.L,
      T: n.T,
      R: n.R,
      B: n.B,
      clickable: n.clickable,
    });
  }

  // Dedupe overlapping wrappers (same tile re-reported by parent containers).
  const seen = new Set();
  const uniq = [];
  for (const c of cards.sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    const k = `${Math.round(c.cx / 30)}_${Math.round(c.cy / 30)}_${c.title.slice(0, 24)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  return uniq.map((c) => ({ ...c, screenWidth, screenHeight }));
}

/** Stable content fingerprint for a selected card (16 hex). */
export function feedCardFingerprint(card) {
  return createHash("sha256")
    .update(`${card.kind}|${card.title}|${card.author}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Select one tappable feed card from a dump.
 *
 * @param {string} xml dump XML
 * @param {{
 *   pickIndex?: number,
 *   preferKind?: "image"|"video"|"any",
 *   fallbackToAny?: boolean,
 *   yMinFrac?: number,
 *   yMaxFrac?: number,
 * }} [opts]
 * @returns {object} selection { x, y, kind, title, author, ..., fingerprint, resolvedBy }
 * @throws with .code TAP_FEED_CARD_DUMP_EMPTY | TAP_FEED_CARD_NO_CARDS |
 *   TAP_FEED_CARD_KIND_MISS | TAP_FEED_CARD_PICK_INDEX_OOB
 */
export function selectFeedCard(xml, opts = {}) {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    throw selectError("TAP_FEED_CARD_DUMP_EMPTY", "feed dump XML is empty");
  }
  const pickIndex = opts.pickIndex ?? 0;
  if (!Number.isInteger(pickIndex) || pickIndex < 0) {
    throw selectError("TAP_FEED_CARD_PICK_INDEX_OOB", `pickIndex must be a non-negative integer, got ${pickIndex}`, { pickIndex });
  }
  const preferKindRaw = opts.preferKind ?? "any";
  const preferKind = PREFER_KIND_MAP[preferKindRaw] ?? (preferKindRaw === "any" ? "any" : null);
  if (preferKind == null) {
    throw selectError("TAP_FEED_CARD_PARAMS_INVALID", `preferKind must be image|video|any, got ${JSON.stringify(preferKindRaw)}`, { preferKind: preferKindRaw });
  }
  const fallbackToAny = opts.fallbackToAny !== false;

  const cards = parseFeedCards(xml, opts);
  if (cards.length === 0) {
    throw selectError("TAP_FEED_CARD_NO_CARDS", "no 笔记/视频 feed cards in the selected band", {
      screenHeight: parseNodes(xml).screenHeight,
    });
  }

  let pool = cards;
  let resolvedBy = "any";
  if (preferKind !== "any") {
    const matched = cards.filter((c) => c.kind === preferKind);
    if (matched.length > 0) {
      pool = matched;
      resolvedBy = "prefer";
    } else if (fallbackToAny) {
      pool = cards;
      resolvedBy = "fallback";
    } else {
      throw selectError("TAP_FEED_CARD_KIND_MISS", `no ${preferKind} card in band and fallbackToAny=false`, {
        preferKind: preferKindRaw,
        availableKinds: [...new Set(cards.map((c) => c.kind))],
      });
    }
  }

  if (pickIndex >= pool.length) {
    throw selectError("TAP_FEED_CARD_PICK_INDEX_OOB", `pickIndex ${pickIndex} out of range (${pool.length} cards)`, {
      pickIndex,
      poolSize: pool.length,
    });
  }

  const card = pool[pickIndex];
  return {
    x: card.cx,
    y: card.cy,
    kind: card.kind,
    title: card.title,
    author: card.author,
    likes: card.likes,
    likesText: card.likesText,
    desc: card.desc,
    bounds: { L: card.L, T: card.T, R: card.R, B: card.B },
    screenWidth: card.screenWidth,
    screenHeight: card.screenHeight,
    fingerprint: feedCardFingerprint(card),
    pickIndex,
    requestedPreferKind: preferKindRaw,
    resolvedBy,
  };
}