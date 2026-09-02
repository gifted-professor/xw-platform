// Real vision provider adapter (plan V2 §6 / executable-plan W3, contract VISION).
//
// The offline grounding runtime (m6-grounding-runtime.mjs) pins a vision provider
// at construction time via { id, version, modelSha256, segment(frame, evidence)
// -> rawBlocks[] }. The hermetic fixture provider is CI-only — it turns a frame
// into synthetic blocks keyed on the screenshot hash. The LIVE path must never
// use it: a real device's navigation surface has to come from real pixel/UI
// annotation, not a fixture scenario table.
//
// This module wraps analyze.py (or any equivalent real-pixel annotation source)
// into the provider-pin shape. The annotation loader is injected so the module
// stays pure + offline-testable: live wiring points the loader at the
// `.elements.json` produced by ops/screenshot-and-analyze.mjs; tests inject a
// fixture annotation list. The modelSha256 pins the analyze.py model identity
// so a model swap is visible in every block set's `segmentation` field.
//
// Safety is NOT re-implemented here. The runtime's decide() already enforces:
//   * sensitive-label  — block category payment|delete -> FAIL -> HARD_STOP
//   * ambiguity        — duplicate peer labels -> REPLAN ("唯一才进，不唯一 stop")
//   * REDLINE_EFFECT_CLASSES — effectClass payment|delete -> HARD_STOP
//   * the hard-redline firewall — independent scan of block signals (ocrText/
//     semanticLabel) for payment/delete terms, so a mislabeled effect block is
//     still caught even if this provider's classifier is wrong.
// We classify categories accurately so the decision surface reflects reality;
// the firewall is the backstop, not the primary classifier.
import { sha256Hex, stableStringify, deriveBlockId } from "./m6-contracts.mjs";
import { HERMETIC_FIXTURE_PROVIDER } from "./m6-grounding-runtime.mjs";

export const REAL_VISION_PROVIDER_ID = "xhs-real-vision-v1";
export const REAL_VISION_PROVIDER_VERSION = "1.0.0";

// A 64-hex fixture model pin for offline tests. Live wiring MUST override this
// with the real analyze.py model sha256; assertLiveGroundingProvider still
// accepts it (it only rejects the hermetic fixture id), but the deployment
// recipe pins the real value so a model swap shows up in segmentation metadata.
export const FIXTURE_MODEL_SHA256 = "a".repeat(64);

// Category classifier. Effect terms (payment/delete) MUST be classified
// accurately — decide()'s sensitive-label check fails closed on category
// payment|delete. Navigation terms map to system-navigation (R0 navigation is
// the only effect class the decision surface allows through to ALLOW_ONCE for
// read-only flows). Everything else is content. The hard-redline firewall
// independently scans block signals, so a classifier miss on payment/delete is
// still caught — defense in depth, not single-source.
const PAYMENT_RE = /支付|付款|买单|结账|充值|确认支付|立即抢购|立即支付|pay(?:ment|pal)?|purchase|checkout|wallet/i;
const DELETE_RE = /删除|移除|清空|卸载|delete|remove|clear(?:[- ]?data)?|uninstall/i;
const NAV_RE = /返回|回退|首页|搜索|发现|消息|通知|我|关注|收藏|点赞|评论|发布|back|home|discover|message|notification|profile|follow|like|comment|publish|search/i;

export function classifyCategory(label, explicit) {
  if (explicit) return explicit;
  if (!label) return "content";
  const s = String(label);
  if (PAYMENT_RE.test(s)) return "payment";
  if (DELETE_RE.test(s)) return "delete";
  if (NAV_RE.test(s)) return "system-navigation";
  return "content";
}

/**
 * Normalize an annotation's bounds into {x,y,w,h}. analyze.py emits bounds in
 * a few shapes ([x,y,w,h] array, {x,y,w,h}, or {x,y,width,height}); accept all.
 */
export function normalizeBounds(bounds) {
  if (bounds == null) return null;
  if (Array.isArray(bounds)) {
    const [x, y, w, h] = bounds;
    if ([x, y, w, h].some((n) => !Number.isFinite(Number(n)))) return null;
    return { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
  }
  if (typeof bounds === "object") {
    const x = Number(bounds.x ?? bounds.left);
    const y = Number(bounds.y ?? bounds.top);
    const w = Number(bounds.w ?? bounds.width);
    const h = Number(bounds.h ?? bounds.height);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) return null;
    return { x, y, w, h };
  }
  return null;
}

/**
 * Build a real-vision provider pinned to an annotation loader.
 *
 * @param {object} opts
 * @param {(frame: object, evidence: object) => (object[]|null)} opts.loader
 *   Returns the analyze.py element list for the frame's screenshot, or null/[]
 *   when annotation is unavailable. The provider NEVER fabricates blocks when
 *   the loader returns nothing — empty annotation => zero blocks => no
 *   navigation target => the caller must REPLAN/STOP, never a blind tap.
 * @param {string} opts.modelSha256 64-hex pin of the analyze.py model identity.
 * @param {string} [opts.version]
 */
export function createRealVisionProvider({ loader, modelSha256, version = REAL_VISION_PROVIDER_VERSION }) {
  if (typeof loader !== "function") {
    throw new Error("REAL_VISION_PROVIDER_LOADER_REQUIRED: loader(frame, evidence) function is required");
  }
  if (!/^[0-9a-f]{64}$/.test(modelSha256 || "")) {
    throw new Error("REAL_VISION_PROVIDER_MODEL_SHA256_REQUIRED: modelSha256 must be 64-hex");
  }
  const provider = {
    id: REAL_VISION_PROVIDER_ID,
    version,
    modelSha256,
    /**
     * @param {object} frame frozen xw.screen-frame.v1 (issued by the runtime)
     * @param {object} evidence the runtime's evidence store
     * @returns {object[]} raw blocks for the runtime to derive blockIds from
     */
    segment(frame, evidence) {
      let annotations;
      try {
        annotations = loader(frame, evidence);
      } catch {
        // A crashing loader is treated as "no annotation" — never fail open.
        return [];
      }
      if (!Array.isArray(annotations)) return [];
      const blocks = [];
      for (let i = 0; i < annotations.length; i += 1) {
        const ann = annotations[i];
        if (!ann || ann.label == null) continue;
        const label = String(ann.label);
        const category = classifyCategory(label, ann.category);
        const geometry = normalizeBounds(ann.bounds);
        const confidence = typeof ann.conf === "number"
          ? ann.conf
          : typeof ann.confidence === "number" ? ann.confidence : 0.9;
        const source = ann.source || "vision";
        const regionHash = sha256Hex(`xw.region.rv:${stableStringify({
          frameId: frame.frameId, stableIndex: i, label, category, bounds: geometry,
        })}`);
        const blockId = deriveBlockId({
          frameId: frame.frameId, stableIndex: i, regionHash, label, category,
        });
        const signals = { ocrText: label, semanticLabel: label, ...(ann.signals || {}) };
        // Store geometry + signals INSIDE the bounds blob (opaque ref). A
        // relabel changes blockId but the original signals still resolve, so
        // the redline firewall catches a payment button relabeled "content".
        const boundsRef = evidence.bounds(
          blockId, regionHash,
          geometry || { x: 0, y: 0, w: 0, h: 0 },
          signals,
        );
        blocks.push({ stableIndex: i, regionHash, boundsRef, label, category, confidence, source });
      }
      return blocks;
    },
  };
  return Object.freeze(provider);
}

/**
 * Explicit live-mode guard (plan V2 W3). Today the offline/live split is
 * structural (the version-boundary test pins the facade to the live kernel),
 * but the plan requires a runtime guard so a misconfigured live construction
 * fails closed instead of silently running fixture segmentation against a
 * real device. Throws on violation; returns true on accept.
 */
export function assertLiveGroundingProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("LIVE_GROUNDING_PROVIDER_REQUIRED: a provider is required");
  }
  if (provider.id === HERMETIC_FIXTURE_PROVIDER.id) {
    throw new Error("LIVE_GROUNDING_REJECTS_HERMETIC: the live path must not use the fixture provider");
  }
  if (!/^[0-9a-f]{64}$/.test(provider.modelSha256 || "")) {
    throw new Error("LIVE_GROUNDING_REQUIRES_PINNED_MODEL: provider modelSha256 must be 64-hex");
  }
  if (typeof provider.segment !== "function") {
    throw new Error("LIVE_GROUNDING_REQUIRES_SEGMENT: provider must implement segment(frame, evidence)");
  }
  return true;
}