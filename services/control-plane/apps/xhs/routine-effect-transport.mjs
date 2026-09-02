// routine-effect-transport.mjs — the PRODUCTION typed transport for the
// routine effect bridge (plan V2 §8.1.3-8.1.4).
//
// The bridge (routine-effect-bridge.mjs) owns WHEN an effect may transport.
// This module owns HOW the CP observes and commits through the OWNING formal
// Explorer session: same session, same lease, no nested job, no raw caller
// coordinates. Every control (like button, comment box, send button) is located
// by the CP from its OWN fresh same-session dump — the caller can never supply
// a tap point, and the bridge interface has no coordinate parameter at all.
//
// Target binding (§8.1.4): the machine picks a feed card and claims an opaque
// targetFingerprint. The CP binds that claim to the open detail page's stable
// evidence (page class + like/collect control geometry + comment box geometry
// + title excerpt when extractable) exactly once, append-only; every later
// observation under the same claim must match the same evidence, else the
// binding fails closed. This keeps the bridge's "the CP-owned observation must
// bind to the same target the machine picked" contract without pretending the
// feed-card center is visible on the detail page.
import { createHash } from "node:crypto";

import {
  bindTargetFingerprint,
  classifyPage,
  PAGE_CLASS,
} from "../../../orchestrator/scripts/lib/xhs-feed-surface.mjs";
import {
  parseBottomBar,
  parseComments,
  findCommentBox,
  findSendBtn,
} from "../../../orchestrator/ops/_xhs-parse.mjs";

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

/** 系统文案/控件 label — never a note title. */
const TITLE_CHROME = /说点什么|评论|发送|发布|关注|已关注|分享|返回|首页|消息|我|展开|收起|到底了|让大家听到|弹幕|全屏/;

/**
 * Stable detail-page identity from CP-owned evidence. Like/collect descs CHANGE
 * when the state flips (已点赞/已收藏), so only geometry + page class + the
 * comment box anchor are used — the binding must hold across the pre/post
 * observations of the same open note.
 */
export function detailEvidenceFingerprint({ page, xml }) {
  const bar = parseBottomBar(xml);
  const box = findCommentBox(xml);
  const anchor = (btn) => (btn ? `${btn.L},${btn.T},${btn.R},${btn.B}` : "");
  return bindTargetFingerprint({
    cardTitle: detailTitleExcerpt(xml) ?? "",
    cardAuthor: "",
    cardCenter: null,
    pageEvidence: [page, anchor(bar.like), anchor(bar.collect), anchor(box)].join("|"),
  });
}

/** Best-effort deterministic title excerpt from a detail dump (never a URL). */
export function detailTitleExcerpt(xml) {
  const nodes = [...String(xml || "").matchAll(/text="([^"]{8,120})"/g)]
    .map((m) => m[1])
    .filter((t) => !TITLE_CHROME.test(t));
  if (!nodes.length) return null;
  return nodes.sort((a, b) => b.length - a.length)[0].slice(0, 120);
}

/**
 * Create the production transport bound to ONE owning routine authority (one
 * session, one run). Reuse across runs would leak like-control bindings.
 * @param {object} input
 * @param {Function} input.executeAction - async (params) => primitive output for
 *   the OWNING session (CP-internal; the routine runner's formal session/token).
 *   Must reject once the session is released; never accepts caller coordinates.
 * @param {Function} input.bindTarget - (claimedFingerprint, detailFingerprint)
 *   => void; first call records the claim, later calls verify (append-only,
 *   CP-owned). Throws TARGET_BINDING_MISMATCH on a conflicting rebind.
 * @param {Function} [input.draftTextOf] - async (draftId) => { text } | null.
 *   Resolves a SERVER-sealed draft; the caller never supplies comment text.
 * @param {Function} [input.now] - ms clock.
 */
export function createRoutineEffectTransport({ executeAction, bindTarget, draftTextOf = null, now = () => Date.now() } = {}) {
  if (typeof executeAction !== "function") {
    throw new TypeError("createRoutineEffectTransport: executeAction required");
  }
  if (typeof bindTarget !== "function") {
    throw new TypeError("createRoutineEffectTransport: bindTarget required");
  }

  // last CP-owned observation per claimed fingerprint — commitLike taps THIS
  // control, never a caller coordinate
  const lastObservations = new Map();

  async function observeDump(label) {
    const focusOut = await executeAction({ primitive: "focus" });
    const dumpOut = await executeAction({ primitive: "dump_ui" });
    const xml = typeof dumpOut?.xml === "string" && dumpOut.xml
      ? dumpOut.xml
      : typeof dumpOut?.dumpXml === "string" ? dumpOut.dumpXml : "";
    if (!xml) return null;
    const pkg = focusOut?.package ?? focusOut?.pkg ?? null;
    const focus = (typeof focusOut?.focus === "string" && focusOut.focus)
      || [focusOut?.package ?? focusOut?.pkg, focusOut?.activity].filter(Boolean).join("/");
    const page = classifyPage({ xml, focus, pkg, sourceCardKind: null });
    return {
      label,
      xml,
      page,
      hash: sha256(canonical({ xml, page: page.page })),
      observedAt: now(),
      focus,
    };
  }

  function isDetailPage(page) {
    return page === PAGE_CLASS.IMAGE_NOTE || page === PAGE_CLASS.VIDEO_NOTE;
  }

  function bindClaimed(targetFingerprint, detailFingerprint) {
    if (!targetFingerprint) return null;
    bindTarget(targetFingerprint, detailFingerprint);
    return targetFingerprint;
  }

  return {
    /**
     * §8.1.4 like oracle: fresh same-session exact control observation.
     * A non-detail surface returns likeLabel="" (missing) — the bridge's
     * ladder re-observes once and then stops with zero transport.
     * @returns {{ hash, targetFingerprint, likeLabel, observedAt }}
     */
    async observe({ reason, targetFingerprint } = {}) {
      const dump = await observeDump(String(reason || "observe"));
      const observation = {
        hash: dump?.hash ?? sha256(canonical({ label: String(reason || "observe"), empty: true })),
        targetFingerprint: null,
        likeLabel: "",
        observedAt: now(),
        pageClass: dump?.page?.page ?? null,
      };
      if (dump && isDetailPage(dump.page.page)) {
        const bar = parseBottomBar(dump.xml);
        observation.targetFingerprint = bindClaimed(
          targetFingerprint,
          detailEvidenceFingerprint({ page: dump.page.page, xml: dump.xml }),
        );
        observation.likeLabel = bar.like ? String(bar.like.desc || "") : "";
        observation.likeControl = bar.like ? { x: bar.like.x, y: bar.like.y } : null;
      }
      if (targetFingerprint) lastObservations.set(targetFingerprint, observation);
      return observation;
    },

    /**
     * Single typed like transport: taps the like control located by the LAST
     * CP-owned observation of this target. No coordinate parameter exists.
     */
    async commitLike({ operationKey, reservationToken, targetFingerprint } = {}) {
      if (!operationKey || !reservationToken) return { ok: false, reason: "RESERVATION_BINDING_MISSING" };
      const observation = targetFingerprint
        ? lastObservations.get(targetFingerprint)
        : [...lastObservations.values()].at(-1);
      const control = observation?.likeControl ?? null;
      if (!control || !Number.isFinite(control.x) || !Number.isFinite(control.y)) {
        return { ok: false, reason: "LIKE_CONTROL_NOT_BOUND" };
      }
      await executeAction({ primitive: "tap", x: control.x, y: control.y });
      return { ok: true, operationKey };
    },

    /**
     * §8.1.5 note-context observation: server-built receipt fields from a fresh
     * same-session dump of the open detail.
     */
    async observeNoteContext({ targetFingerprint } = {}) {
      const dump = await observeDump("note_context");
      if (!dump || !isDetailPage(dump.page.page)) {
        throw new Error("ROUTINE_OBSERVATION_INVALID: not an open note detail surface");
      }
      const claimed = bindClaimed(targetFingerprint, detailEvidenceFingerprint({ page: dump.page.page, xml: dump.xml }));
      const comments = parseComments(dump.xml);
      return {
        hash: dump.hash,
        targetFingerprint: claimed,
        observedAt: now(),
        detailStateVersion: dump.hash,
        pageFingerprint: dump.page.page,
        title: detailTitleExcerpt(dump.xml),
        body: null,
        commentDigest: (comments?.items || []).slice(0, 10).map((item) => item.text).filter(Boolean),
      };
    },

    /**
     * Single typed comment transport of a SERVER-sealed draft: comment box ->
     * input_text -> send, all through the owning session. The text resolves
     * from the server's own draft store — the RPC caller never supplies it.
     */
    async commitComment({ operationKey, reservationToken, draftId, textHash } = {}) {
      if (!operationKey || !reservationToken || !draftId || !textHash) {
        return { ok: false, reason: "RESERVATION_BINDING_MISSING" };
      }
      if (typeof draftTextOf !== "function") return { ok: false, reason: "DRAFT_RESOLVER_UNAVAILABLE" };
      const draft = await draftTextOf(draftId);
      if (!draft || typeof draft.text !== "string" || !draft.text) {
        return { ok: false, reason: "DRAFT_NOT_SEALED" };
      }
      if (sha256(draft.text) !== textHash) return { ok: false, reason: "DRAFT_HASH_MISMATCH" };
      const dump = await observeDump("comment_panel_preflight");
      const box = dump ? findCommentBox(dump.xml) : null;
      if (!box) return { ok: false, reason: "COMMENT_BOX_NOT_FOUND" };
      await executeAction({ primitive: "tap", x: box.x, y: box.y });
      await executeAction({ primitive: "input_text", text: draft.text });
      // re-observe for the send button of the OPEN editor — never reuse the
      // pre-panel dump for a send control
      const sendDump = await observeDump("comment_send_preflight");
      const send = sendDump ? findSendBtn(sendDump.xml) : null;
      if (!send) return { ok: false, reason: "SEND_BUTTON_NOT_FOUND" };
      await executeAction({ primitive: "tap", x: send.x, y: send.y });
      return { ok: true, operationKey };
    },

    /** Strict comment-panel verifier: exact text must appear as a comment row. */
    async observeCommentPanel() {
      const dump = await observeDump("comment_panel_verify");
      if (!dump) return { texts: [] };
      const comments = parseComments(dump.xml);
      return { texts: (comments?.items || []).map((item) => item.text).filter(Boolean) };
    },
  };
}