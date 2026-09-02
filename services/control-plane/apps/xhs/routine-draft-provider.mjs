// routine-draft-provider.mjs — the FIXED production CommentDraftProvider for
// the grounded comment chain (plan V2 §8.1.5).
//
// The provider sees ONLY the server-sealed receipt and contributes ONLY
// { text, modelId, promptHash }. It has no device access, no transport, no
// decision surface: it cannot choose a target, coordinates, whether to send,
// or the budget — the bridge owns all of that. This production provider is a
// deterministic grounded template: short appreciative comment derived from the
// receipt's own title/comment evidence, so grounding is reproducible and
// audit-friendly. A richer configured text model can replace `draft` behind
// this exact seam without touching the bridge or validator.
import { createHash } from "node:crypto";

export const ROUTINE_DRAFT_PROVIDER_ID = "xhs-routine-deterministic-grounded-v1";

/** Max comment texts inspected from the receipt digest. */
const DIGEST_LIMIT = 5;

export function createRoutineDraftProvider({ clock = { nowMs: () => Date.now() } } = {}) {
  return Object.freeze({
    id: ROUTINE_DRAFT_PROVIDER_ID,
    kind: "deterministic-grounded-template",
    /**
     * @param {object} receipt - server-sealed note-context receipt
     * @returns {{ text, modelId, promptHash }}
     */
    draft({ receipt } = {}) {
      const title = String(receipt?.titleExcerpt ?? "").trim();
      const digest = (Array.isArray(receipt?.commentDigest) ? receipt.commentDigest : [])
        .map((t) => String(t ?? "").trim())
        .filter(Boolean)
        .slice(0, DIGEST_LIMIT);
      // prompt is derived from the receipt only — recorded for audit
      const prompt = JSON.stringify({ title, digest, instruction: "short grounded appreciative comment" });
      const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
      // deterministic template selection: pick by stable content hash so the
      // same grounded context yields the same comment (no randomness in send)
      const variant = parseInt(createHash("sha256").update(`${receipt?.receiptHash ?? ""}${title}`, "utf8").digest("hex").slice(0, 8), 16) % TEMPLATES.length;
      const text = TEMPLATES[variant]({
        title: title.replace(/[！!。~～\s]+$/g, ""),
        topic: topicFromTitle(title),
      });
      return { text, modelId: ROUTINE_DRAFT_PROVIDER_ID, promptHash };
    },
  });
}

/** Topic keyword from the title: the longest CJK run (never a fabricated claim). */
function topicFromTitle(title) {
  const matches = String(title || "").match(/[一-鿿]{2,12}/g);
  if (!matches) return "";
  return matches.sort((a, b) => b.length - a.length)[0];
}

const TEMPLATES = Object.freeze([
  ({ topic }) => (topic ? `说得真好，${topic}这点很受用` : "写得很用心，收藏慢慢看"),
  ({ topic }) => (topic ? `谢谢分享，关于${topic}讲得挺清楚` : "谢谢分享，看完很有收获"),
  ({ topic }) => (topic ? `这个角度不错，${topic}确实值得琢磨` : "排版和内容都很好，赞一个"),
  ({ topic }) => (topic ? `mark 一下，${topic}这个思路很实用` : "内容很实在，感谢整理"),
]);