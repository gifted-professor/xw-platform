/**
 * 视觉/语义共用安全闸（来自 visual-grounding-poc L1 02 机实证）
 * 硬编码：宁可不点，不可误点外发。
 */

/** 绝对禁止（外发/资金/社交动作） */
export const FORBIDDEN_LABEL_RE = /发布|发送|支付|付款|删除|下单|购买|关注他|关注她|想要|聊一聊|提交|确认支付|立即购买|加入购物车|转发|分享到|卖闲置/;

/** 导航/关闭类白名单子串（非外发） */
export const SAFE_NAV_LABELS = [
  "首页", "市集", "消息", "我", "我的", "闲鱼", "深圳",
  "相册", "不保存", "关闭", "完成", "推荐", "下一步",
  "上一步", "收起", "展开", "全选", "确定",
];

/**
 * 禁止 Python 脚枪：`"" in "消息" === true`
 * needle/lab 均须非空才可匹配。
 */
export function labelMatches(needle, lab) {
  const n = String(needle || "").trim();
  const l = String(lab || "").trim();
  if (!n || !l) return false;
  if (l === n) return true;
  if (n.includes(l) || l.includes(n)) return true;
  return false;
}

export function isForbiddenLabel(label) {
  return FORBIDDEN_LABEL_RE.test(String(label || ""));
}

export function isSafeNavLabel(label) {
  const l = String(label || "").trim();
  if (!l || isForbiddenLabel(l)) return false;
  return SAFE_NAV_LABELS.some((s) => l === s || l.includes(s));
}

/**
 * region 约束（屏高比例）
 * tabbar: y >= 88%  bottom
 * topbar: y <= 12%
 */
export function inRegion(centerXY, region, resolution = [1080, 2400]) {
  if (!region) return true;
  const w = resolution[0] || 1080;
  const h = resolution[1] || 2400;
  const cx = centerXY?.[0] ?? 0;
  const cy = centerXY?.[1] ?? 0;
  if (region === "tabbar") return cy >= h * 0.88;
  if (region === "topbar") return cy <= h * 0.12;
  if (region === "dialog") return cy >= h * 0.55;
  if (region === "chips") return cy >= h * 0.08 && cy <= h * 0.2;
  if (region === "header") return cy >= h * 0.1 && cy <= h * 0.35;
  if (region === "content") return cy > h * 0.12 && cy < h * 0.88;
  return true;
}

export function elementCenter(el) {
  if (Array.isArray(el?.center) && el.center.length >= 2) return [el.center[0], el.center[1]];
  const b = el?.bounds;
  if (Array.isArray(b) && b.length >= 4) {
    return [Math.trunc((b[0] + b[2]) / 2), Math.trunc((b[1] + b[3]) / 2)];
  }
  return null;
}

/**
 * 从语义节点或视觉 elements 收集指纹 label 集
 */
export function fingerprintLabels(nodesOrElements, { maxLen = 24 } = {}) {
  const labs = new Set();
  for (const n of nodesOrElements || []) {
    const lab = String(n?.label || n?.text || "").trim();
    if (lab && lab.length <= maxLen) labs.add(lab);
  }
  return labs;
}

/**
 * 闲鱼主页底栏指纹：同时有 闲鱼 + 消息 + 我的（或 我）
 */
export function hasXianyuMainTabbarFingerprint(labels) {
  const set = labels instanceof Set ? labels : new Set(labels || []);
  const joined = [...set].join("|");
  const hasFish = [...set].some((l) => l === "闲鱼" || l.startsWith("闲鱼"));
  const hasMsg = [...set].some((l) => l.includes("消息"));
  const hasMe = [...set].some((l) => l === "我的" || l === "我" || l.startsWith("我的"));
  return hasFish && hasMsg && hasMe;
}

/**
 * 发闲置编辑页指纹
 */
export function hasXianyuPublishComposeFingerprint(labels) {
  const set = labels instanceof Set ? labels : new Set(labels || []);
  const arr = [...set];
  const hasDesc = arr.some((l) => /描述|宝贝|品牌型号/.test(l));
  const hasCommerce = arr.some((l) => /价格|分类|成色|发货|商品规格|发布/.test(l));
  return hasDesc && hasCommerce;
}

/**
 * 规格设置页指纹
 */
export function hasXianyuSkuSheetFingerprint(labels) {
  const arr = [...(labels instanceof Set ? labels : new Set(labels || []))];
  return arr.some((l) => /设置宝贝规格|添加规格类型|下一步/.test(l));
}

/** 业务 UI 允许词（非外发，可不在 SAFE_NAV 里） */
const BUSINESS_UI_RE = /下一步|确定|完成|关闭|全选|包邮|添加规格|不保存|收起|展开/;

/**
 * 从视觉/语义元素表 resolve 可点目标（纯规则）
 * - 空 label 永不入选
 * - 禁止词永不入选
 * - requireSafeNav：只允许导航白名单（底栏等）
 * @returns {{ ok, target?, reason, candidates? }}
 */
export function resolveTarget(elements, {
  label,
  region = null,
  resolution = [1080, 2400],
  requireSafeNav = false,
  allowForbidden = false,
} = {}) {
  const needle = String(label || "").trim();
  if (!needle) return { ok: false, reason: "empty_needle", target: null };

  if (!allowForbidden && isForbiddenLabel(needle)) {
    return { ok: false, reason: "forbidden_needle", target: null };
  }

  const cands = [];
  for (const e of elements || []) {
    const lab = String(e?.label || e?.text || "").trim();
    if (!lab) continue; // 空 label 永不入选
    if (!labelMatches(needle, lab)) continue;
    if (!allowForbidden && isForbiddenLabel(lab)) continue;

    if (requireSafeNav) {
      const navOk = isSafeNavLabel(lab) || isSafeNavLabel(needle) || BUSINESS_UI_RE.test(lab);
      if (!navOk) continue;
    }

    const c = elementCenter(e);
    if (!c) continue;
    if (!inRegion(c, region, resolution)) continue;

    let score = Number(e.conf) || 0;
    if (lab === needle) score += 2;
    else if (lab.includes(needle)) score += 1;
    if (region === "tabbar") score += c[1] / 10000;
    cands.push({ score, e, center: c, label: lab });
  }

  cands.sort((a, b) => b.score - a.score);
  if (!cands.length) return { ok: false, reason: "no_match", target: null };

  const best = cands[0];
  if (cands.length > 1 && !region) {
    const dScore = Math.abs(cands[0].score - cands[1].score);
    if (dScore < 0.3) {
      const dist = Math.hypot(
        best.center[0] - cands[1].center[0],
        best.center[1] - cands[1].center[1],
      );
      if (dist > 80) {
        return {
          ok: false,
          reason: "ambiguous_need_region",
          target: null,
          candidates: cands.slice(0, 3).map((c) => ({ label: c.label, center: c.center, score: c.score })),
        };
      }
    }
  }

  let tapPoint = best.center;
  const glyph = /^[X×✕x✖]$/.test(best.label);
  if (glyph && Array.isArray(best.e.detCenter)) {
    tapPoint = [best.e.detCenter[0], best.e.detCenter[1]];
  }

  return {
    ok: true,
    reason: "ok",
    target: {
      label: best.label,
      center: tapPoint,
      bounds: best.e.bounds || null,
      conf: best.e.conf ?? null,
      source: best.e.source || "semantic",
      tapPolicy: glyph ? "det_center_icon" : "label_center",
    },
    candidates: cands.slice(0, 5).map((c) => ({ label: c.label, center: c.center, score: c.score })),
  };
}

/**
 * 安全闸总检查：是否允许对 target 执行 tap
 */
export function gateTap({ label, region, fingerprintLabels: fp, app = "xianyu" } = {}) {
  if (isForbiddenLabel(label)) {
    return { allow: false, reason: "forbidden_label" };
  }
  if (app === "xianyu" && region === "tabbar") {
    if (fp && !hasXianyuMainTabbarFingerprint(fp)) {
      return { allow: false, reason: "xianyu_tabbar_fingerprint_missing" };
    }
  }
  return { allow: true, reason: "ok" };
}
