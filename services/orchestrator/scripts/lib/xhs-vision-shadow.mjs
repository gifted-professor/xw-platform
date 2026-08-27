// xhs-vision-shadow.mjs — vision shadow + R0 one-shot navigation permit
// (direct-routine plan V2 §5/§10.9), pure and offline-testable.
//
// Two-step rollout (plan §5): vision never unlocks effects. First it runs as a
// SHADOW — the dump/vision classifications are compared and recorded, and
// `tapAuthorized` is false no matter how well they agree. Only after a real
// PNG corpus holds up may the unique R0 navigation block carry a one-shot
// permit. Effect controls (like/comment-send/collect/follow) are red-lined in
// BOTH modes: effects only ever flow through the typed capability bridge.
//
// Decision ladder (§5): verified helper / fixed locator -> fresh unique
// targetRef -> same-session strict screenshot + real vision shadow -> one-shot
// permit for the unique R0 navigation block -> STOP. Fixture results must
// never authorize anything in a live runtime — the provider seam fails closed.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  readPngDims,
  isRedlineLabel,
  selectBlock,
} from "../../ops/xw-adaptive-visual-tap.mjs";

export const VISION_PROVIDERS = Object.freeze({ FIXTURE: "fixture", REAL: "real" });

/** Effect-control labels: vision may observe them, never tap them (§5). */
export const EFFECT_CONTROL_LABELS = Object.freeze([
  "点赞", "评论", "收藏", "关注", "私信", "评论发送", "发送评论", "发送",
]);

export function isEffectControlLabel(label) {
  const s = String(label || "").toLowerCase();
  return EFFECT_CONTROL_LABELS.some((r) => s.includes(r.toLowerCase()));
}

/**
 * Screenshot evidence seam: keeps model/provider/frame hash together so the
 * shadow verdict is auditable. The fixture provider fails closed in live.
 * @returns {{ frameHash, provider, modelId, capturedAt, dims }}
 */
export function screenshotEvidence({ pngPath, provider = VISION_PROVIDERS.FIXTURE, modelId = null, capturedAt, live = false }) {
  if (provider === VISION_PROVIDERS.FIXTURE && live) {
    // plan §10.9: fixture 结果不得用于 live —— fail closed before anything else
    throw Object.assign(
      new Error("VISION_FIXTURE_LIVE_FORBIDDEN: fixture screenshot provider may not authorize live evidence"),
      { code: 3, reasonCode: "VISION_PROVIDER_REJECTED" },
    );
  }
  if (!pngPath || !existsSync(pngPath)) {
    throw Object.assign(new Error("VISION_SCREENSHOT_UNAVAILABLE"), { code: 3, reasonCode: "DUMP_SPARSE" });
  }
  const bytes = readFileSync(pngPath);
  const dims = readPngDims(bytes);
  if (!dims) {
    throw Object.assign(new Error("VISION_PNG_INVALID"), { code: 3, reasonCode: "AMBIGUOUS" });
  }
  return {
    frameHash: createHash("sha256").update(bytes).digest("hex"),
    provider: String(provider),
    modelId: modelId ?? null,
    capturedAt: Number(capturedAt ?? 0),
    dims,
  };
}

/** Vision label prefix -> media kind (XHS card descs start with 视频/笔记). */
function visionMediaKind(label) {
  const s = String(label || "").trim();
  if (s.startsWith("视频")) return "video";
  if (s.startsWith("笔记")) return "note";
  return "unknown";
}

/**
 * Shadow comparison (§5): dump classification vs vision classification.
 * ALWAYS returns tapAuthorized=false — shadow only records agreement; the
 * verdict feeds the corpus metric, never a tap.
 * @returns {{ tapAuthorized:false, pageAgree, mediaAgree, mismatches[], summary }}
 */
export function visionShadowCompare({ dump, vision }) {
  const mismatches = [];
  const dumpPage = String(dump?.page ?? "UNKNOWN");
  const visionPage = String(vision?.page ?? "UNKNOWN");
  const pageAgree = dumpPage === visionPage;
  if (!pageAgree) mismatches.push({ field: "page", dump: dumpPage, vision: visionPage });

  // dump cards: [{cardKind: "video"|"note"|...}]; vision blocks: label prefixes
  const dumpKinds = (dump?.cards ?? []).map((c) => String(c.cardKind || "unknown")).sort();
  const visionKinds = (vision?.blocks ?? [])
    .map((b) => visionMediaKind(b.label))
    .filter((k) => k !== "unknown")
    .sort();
  const mediaAgree = dumpKinds.length === visionKinds.length
    && dumpKinds.every((k, i) => k === visionKinds[i]);
  if (!mediaAgree) mismatches.push({ field: "media", dump: dumpKinds, vision: visionKinds });

  return {
    tapAuthorized: false,
    pageAgree,
    mediaAgree,
    mismatches,
    summary: {
      page: pageAgree ? dumpPage : "MISMATCH",
      dumpCardCount: dumpKinds.length,
      visionNoteBlockCount: visionKinds.length,
    },
  };
}

/**
 * R0 one-shot navigation permit (§5 tail): the ONLY tap vision may authorize.
 * Fail-closed order: block selection (ambiguity/redline/confidence/bounds/
 * system area) -> replay (same frame+block already consumed) -> expiry.
 * A consumed/expired/replayed permit is tap=0; the actionRef is single-use and
 * never exposes reusable coordinates as authorization.
 */
export function r0NavigationTap({
  blocks,
  target,
  dims,
  frameHash,
  confidenceThreshold = 0.6,
  ttlMs = 30_000,
  ledgerPath,
  clock = { nowMs: () => Date.now() },
}) {
  if (!frameHash || typeof frameHash !== "string") {
    throw Object.assign(new Error("VISION_FRAME_UNBOUND: frame hash required"), { code: 4, reasonCode: "AMBIGUOUS" });
  }
  if (!target || !String(target).trim()) {
    throw Object.assign(new Error("VISION_NO_TARGET"), { code: 4 });
  }
  // 1. block selection — strict fail closed (reuse Fast-1 selector: ambiguity,
  //    redline, out-of-bounds, system area, low confidence)
  const selected = selectBlock(blocks, target, { dims, confidenceThreshold });
  // effect controls additionally rejected even if a corpus relabels them
  if (isEffectControlLabel(selected.block.label)) {
    throw Object.assign(
      new Error(`VISION_EFFECT_CONTROL: 块"${selected.block.label}"是效果控件，视觉永不单击`),
      { code: 3, reasonCode: "REDLINE" },
    );
  }
  // 2. replay fence — (frameHash, blockId) is one-shot
  const key = `${frameHash}|${selected.blockId}`;
  if (ledgerPath) {
    let existing = "";
    try { existing = readFileSync(ledgerPath, "utf8"); } catch { /* new */ }
    if (existing.includes(key)) {
      throw Object.assign(
        new Error("VISION_PERMIT_CONSUMED: 该截图上的导航块已消费（重放拒绝）"),
        { code: 3, reasonCode: "AMBIGUOUS" },
      );
    }
  }
  // 3. expiry — the permit is bound to the frame's capture moment
  const now = clock.nowMs();
  if (selected.block.capturedAt != null && now - Number(selected.block.capturedAt) > ttlMs) {
    throw Object.assign(
      new Error("VISION_PERMIT_EXPIRED: 截图超时，必须重新截图后重走决策梯"),
      { code: 3, reasonCode: "AMBIGUOUS" },
    );
  }
  const actionRef = "act_" + createHash("sha256")
    .update(`${key}|${randomUUID()}`)
    .digest("hex").slice(0, 24);
  if (ledgerPath) {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ key, actionRef, ts: now }) + "\n", "utf8");
  }
  return {
    ok: true,
    blockId: selected.blockId,
    center: selected.center,
    actionRef,
    reason: "VISION_R0_OK",
  };
}