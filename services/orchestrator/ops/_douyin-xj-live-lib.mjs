/**
 * Xinjiang high-density Live / slides — shared scoring & query priors.
 * From explore 2026-08-02 (live-bulk-slides).
 */
export const XJ_LIVE_TITLE_RES = [
  /用\s*\d+\s*张\s*live\s*图/i,
  /用\s*\d+\s*张\s*live\s*记录/i,
  /\d+\s*张\s*live\s*(图|记录)/i,
  /一百张\s*live/i,
  /live\s*图.{0,12}新疆/i,
  /新疆.{0,12}live\s*图/i,
];

export const XJ_PLACE_RE =
  /新疆|伊犁|赛里木|阿勒泰|乌鲁木齐|喀纳斯|禾木|那拉提|独库|巴音布鲁克/;

export const XJ_LIVE_SEARCH_QUERIES = [
  "新疆live图",
  "用张live图 新疆",
  "live图 新疆旅行",
  "live记录 新疆",
  "张live图 伊犁",
  "张live图 赛里木湖",
  "新疆旅行 live图",
  "一百张live图 新疆",
];

export const XJ_LIVE_TAGS = ["新疆", "新疆旅行", "伊犁", "赛里木湖", "阿勒泰", "旅行碎片", "旅行vlog"];

/**
 * Score a Douyin card title / caption for bulk Live slides harvest.
 * Prefer ≥4 before opening; ≥3 with 动图 badge / imgs≥30 still ok in detail.
 */
export function scoreXjLiveTitle(text) {
  const s = String(text || "");
  const lower = s.toLowerCase();
  let score = 0;
  const reasons = [];

  if (/用\s*\d+\s*张\s*live/.test(lower) || /\d+\s*张\s*live\s*(图|记录)/.test(lower) || /一百张\s*live/.test(lower)) {
    score += 3;
    reasons.push("用N张live");
  }
  if (/live\s*图|live\s*记录/.test(lower)) {
    score += 2;
    reasons.push("live图/记录");
  }
  if (XJ_PLACE_RE.test(s)) {
    score += 2;
    reasons.push("新疆地名");
  }
  if (/动图|实况/.test(s)) {
    score += 2;
    reasons.push("角标动图/实况");
  }
  const imgs = s.match(/(\d+)\s*张/);
  if (imgs && Number(imgs[1]) >= 30) {
    score += 1;
    reasons.push("图数≥30");
  }
  if (/照片/.test(s) && !/live/i.test(s)) {
    score -= 3;
    reasons.push("仅照片无live");
  }
  return { score, reasons };
}

/** Prior type from STRATEGY-XJ-LIVE-TITLE-PRIOR: A author / B solicit / C weak */
export function classifyXjLivePrior(text) {
  const s = String(text || "");
  let S = 0;
  let X = 0;
  let C = 0;
  if (/实况|Live图|live图|动图|苹果实况/i.test(s)) S += 2;
  if (XJ_PLACE_RE.test(s)) X += 2;
  if (/交换|留下|评论区|一人来|求实况|想要一个全是/.test(s)) C += 2;
  let kind = "C";
  let action = "skip_or_one_screen";
  if (S >= 2 && X >= 2 && C < 2) {
    kind = "A";
    action = "detail_shikuang_swipe";
  } else if (S >= 2 && X >= 2 && C >= 2) {
    kind = "B";
    action = "comments_dongtu_mine";
  } else if (S >= 2 && X < 2 && C >= 2) {
    kind = "B_generic";
    action = "comments_low_xj_ratio";
  } else if (X >= 2 && S < 2) {
    kind = "X_only";
    action = "check_badge_then_decide";
  }
  return { kind, action, S, X, C };
}

export function extractDouyinShareUrls(text) {
  return [...String(text || "").matchAll(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/g)].map((m) => m[0]);
}
