// XHS dump parsers — feed cards + note-detail bottom bar
// Used by ops/xhs-*.mjs. No device I/O here.

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

function pushCard(cards, desc, L, T, R, B, opts = {}) {
  const w = R - L;
  const h = B - T;
  if (w < (opts.minW ?? 200) || h < (opts.minH ?? 200)) return;
  const cx = Math.round((L + R) / 2);
  const cy = Math.round((T + B) / 2);
  const yMin = opts.yMin ?? 180;
  const yMax = opts.yMax ?? 2100;
  if (cy < yMin || cy > yMax) return;
  const d = decodeEntities(desc);
  const kind = /^视频/.test(d) ? "video" : "note";
  let title = d;
  let author = "";
  let likes = null;
  let likesText = "";
  // 笔记  title 来自author N赞 | 6.3万赞
  let m = d.match(/^(?:笔记|视频)\s+(.*?)\s+来自(.+?)\s+([\d.]+万?\+?)赞/);
  if (m) {
    title = m[1].trim();
    author = m[2].trim();
    likesText = m[3];
    if (/万/.test(m[3])) {
      const n = parseFloat(m[3]);
      likes = Number.isFinite(n) ? Math.round(n * 10000) : null;
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
  cards.push({ kind, title, author, likes, likesText, desc: d.slice(0, 160), cx, cy, w, h, L, T, R, B });
}

/** Parse feed note/video cards from uiautomator XML. */
export function parseFeedCards(xml, opts = {}) {
  const cards = [];
  const re =
    /content-desc="((?:笔记|视频)[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const re2 =
    /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*content-desc="((?:笔记|视频)[^"]*)"/g;
  let m;
  while ((m = re.exec(xml))) pushCard(cards, m[1], +m[2], +m[3], +m[4], +m[5], opts);
  while ((m = re2.exec(xml))) pushCard(cards, m[5], +m[1], +m[2], +m[3], +m[4], opts);
  const seen = new Set();
  const uniq = [];
  for (const c of cards.sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    const k = `${Math.round(c.cx / 30)}_${Math.round(c.cy / 30)}_${c.title.slice(0, 24)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  return uniq;
}

/**
 * Find button by content-desc pattern.
 * kind: 'like' | 'collect' | 'comment' | RegExp-source string
 */
export function findBtn(xml, kind) {
  const map = {
    like: String.raw`(?:点赞|已点赞)`,
    collect: String.raw`(?:收藏|已收藏)`,
    comment: String.raw`评论(?!框)`,
    commentBox: String.raw`(?:评论框|说点什么)`,
  };
  const pat = map[kind] || kind;
  const res = [
    new RegExp(
      `content-desc="(${pat}[^"]*)"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    ),
    new RegExp(
      `bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*content-desc="(${pat}[^"]*)"`,
    ),
  ];
  for (let i = 0; i < res.length; i++) {
    const m = xml.match(res[i]);
    if (!m) continue;
    if (i === 0) {
      return {
        desc: decodeEntities(m[1]),
        x: Math.round((+m[2] + +m[4]) / 2),
        y: Math.round((+m[3] + +m[5]) / 2),
        L: +m[2],
        T: +m[3],
        R: +m[4],
        B: +m[5],
      };
    }
    return {
      desc: decodeEntities(m[5]),
      x: Math.round((+m[1] + +m[3]) / 2),
      y: Math.round((+m[2] + +m[4]) / 2),
      L: +m[1],
      T: +m[2],
      R: +m[3],
      B: +m[4],
    };
  }
  return null;
}

export function parseBottomBar(xml) {
  return {
    like: findBtn(xml, "like"),
    collect: findBtn(xml, "collect"),
    comment: findBtn(xml, "comment"),
    commentBox: findBtn(xml, "commentBox"),
  };
}

export function likeState(descOrBtn) {
  const desc = typeof descOrBtn === "string" ? descOrBtn : descOrBtn?.desc;
  if (!desc) return "missing";
  if (/已点赞/.test(desc)) return "liked";
  if (/点赞/.test(desc)) return "unliked";
  return "unknown";
}

export function isXhsFocus(focus) {
  return /com\.xingin\.xhs/.test(focus || "");
}

export function isHomeFocus(focus) {
  return /IndexActivityV2|index\.v2/i.test(focus || "");
}

export function isDetailFocus(focus) {
  return /NoteDetail|DetailFeed|notedetail|DetailActivity/i.test(focus || "");
}

/** Pick a tappable feed card; prefer non-viral notes in mid band. */
export function pickFeedCard(cards, { prefer = "note", avoidWan = true } = {}) {
  const mid = (c) => c.cy >= 400 && c.cy <= 1500;
  const list = cards.filter(mid);
  const pool = list.length ? list : cards;
  if (prefer === "note") {
    const notes = pool.filter((c) => c.kind === "note");
    if (avoidWan) {
      const small = notes.find((c) => !/万赞|万\+?赞/.test(c.desc) && (c.likes == null || c.likes < 50000));
      if (small) return small;
    }
    if (notes[0]) return notes[0];
  }
  return pool[0] || null;
}

function allNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const L = +b[1];
    const T = +b[2];
    const R = +b[3];
    const B = +b[4];
    out.push({
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
      focused: /focused="true"/.test(tag),
      cls: ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop(),
    });
  }
  return out;
}

/**
 * Search result page parser (GlobalSearchActivity).
 * Unlike feed, cards often have empty content-desc; titles live in text= TextViews.
 * Strategy: large clickable tiles + nearest long text as title.
 */
export function parseSearchResults(xml, opts = {}) {
  const yMin = opts.yMin ?? 280;
  const yMax = opts.yMax ?? 2200;
  const nodes = allNodes(xml);
  const tabs = nodes
    .filter((n) => n.text && /^(综合|最新|用户|商品|图片|视频|全部|可购买)$/.test(n.text))
    .map((n) => ({ text: n.text, x: n.cx, y: n.cy }));
  const tiles = nodes.filter(
    (n) => n.clickable && n.w >= 400 && n.h >= 280 && n.cy >= yMin && n.cy <= yMax && !n.text,
  );
  const texts = nodes.filter(
    (n) => n.text && n.text.length >= 6 && n.cy >= yMin && n.cy <= yMax && !/^(综合|最新|用户|商品|图片|视频|全部|搜索|可购买)$/.test(n.text),
  );

  const cards = [];
  for (const tile of tiles.sort((a, b) => a.cy - b.cy || a.cx - b.cx)) {
    // title: longest text whose center is inside tile (or slightly below cover)
    const inside = texts.filter(
      (t) => t.cx >= tile.L - 10 && t.cx <= tile.R + 10 && t.cy >= tile.T && t.cy <= tile.B + 40,
    );
    inside.sort((a, b) => b.text.length - a.text.length);
    const titleNode = inside[0] || null;
    // author-ish: short text near bottom of tile
    const bottomTexts = texts.filter(
      (t) =>
        t.cx >= tile.L &&
        t.cx <= tile.R &&
        t.cy >= tile.T + tile.h * 0.55 &&
        t.cy <= tile.B + 20 &&
        t.text.length <= 20 &&
        !/^\d+$/.test(t.text) &&
        t !== titleNode,
    );
    const author = bottomTexts.sort((a, b) => a.cy - b.cy)[0]?.text || "";
    // likes: pure number near bottom-right
    const nums = texts.filter(
      (t) =>
        t.cx >= tile.L &&
        t.cx <= tile.R &&
        t.cy >= tile.T + tile.h * 0.55 &&
        t.cy <= tile.B + 20 &&
        /^\d+(\.\d+)?万?$/.test(t.text),
    );
    let likes = null;
    let likesText = "";
    if (nums[0]) {
      likesText = nums[0].text;
      if (/万/.test(likesText)) {
        const n = parseFloat(likesText);
        likes = Number.isFinite(n) ? Math.round(n * 10000) : null;
      } else {
        likes = Number(likesText);
      }
    }
    cards.push({
      kind: "search",
      title: (titleNode?.text || "").slice(0, 120),
      author,
      likes,
      likesText,
      cx: tile.cx,
      cy: tile.cy,
      w: tile.w,
      h: tile.h,
      L: tile.L,
      T: tile.T,
      R: tile.R,
      B: tile.B,
    });
  }

  // dedupe overlapping tiles
  const uniq = [];
  const seen = new Set();
  for (const c of cards) {
    const k = `${Math.round(c.cx / 40)}_${Math.round(c.cy / 40)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  return { tabs, cards: uniq };
}

/** Find 发送 button on comment composer. */
export function findSendBtn(xml) {
  const nodes = allNodes(xml);
  // Prefer enabled+clickable 发送; fall back to any 发送 (may be enabled=false before text lands)
  const cands = nodes.filter((n) => n.text === "发送" || n.desc === "发送" || /^发送/.test(n.text || n.desc || ""));
  if (!cands.length) {
    // attribute-order fallback on raw xml
    const m =
      xml.match(/text="发送"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
      xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="发送"/);
    if (!m) return null;
    return {
      desc: "发送",
      x: Math.round((+m[1] + +m[3]) / 2),
      y: Math.round((+m[2] + +m[4]) / 2),
      enabled: !/text="发送"[^>]*enabled="false"/.test(xml),
    };
  }
  const hit =
    cands.find((n) => n.clickable && n.enabled !== false) ||
    cands.find((n) => n.clickable) ||
    cands[0];
  return {
    desc: hit.desc || hit.text || "发送",
    x: hit.cx,
    y: hit.cy,
    L: hit.L,
    T: hit.T,
    R: hit.R,
    B: hit.B,
    enabled: hit.enabled !== false,
  };
}

/** Focused or largest EditText — comment composer input. */
export function findEditText(xml) {
  const nodes = allNodes(xml).filter((n) => /EditText/i.test(n.cls || ""));
  if (!nodes.length) {
    const m =
      xml.match(
        /class="[^"]*EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="([^"]*)"/,
      ) ||
      xml.match(
        /class="[^"]*EditText"[^>]*text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
      );
    // looser
    const m2 = xml.match(/class="[^"]*EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m2) {
      return {
        x: Math.round((+m2[1] + +m2[3]) / 2),
        y: Math.round((+m2[2] + +m2[4]) / 2),
        text: "",
        focused: false,
      };
    }
    return null;
  }
  // parse focused from raw — allNodes doesn't carry focused yet; re-scan
  const focused = [];
  const re = /<node\b[^>]*class="[^"]*EditText"[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const b = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    focused.push({
      x: Math.round((+b[1] + +b[3]) / 2),
      y: Math.round((+b[2] + +b[4]) / 2),
      text: decodeEntities((tag.match(/text="([^"]*)"/) || [])[1] || ""),
      focused: /focused="true"/.test(tag),
      L: +b[1],
      T: +b[2],
      R: +b[3],
      B: +b[4],
    });
  }
  return focused.find((e) => e.focused) || focused[0] || nodes[0];
}

/** 关注按钮：detail 页 text/desc 精确等于四态之一（关注/已关注/回关/相互关注，坐标会漂，必须按节点定位，禁硬编码）。
 *  exact-set 等值（非 includes），避免「关注的话题」类假阳；text 和 desc 分开检查。 */
const FOLLOW_LABELS = new Set(["关注", "已关注", "回关", "相互关注"]);
export function findFollowBtn(xml) {
  const hit = allNodes(xml).find(
    (n) =>
      (n.text && FOLLOW_LABELS.has(String(n.text).trim())) ||
      (n.desc && FOLLOW_LABELS.has(String(n.desc).trim())),
  );
  if (!hit) return null;
  return {
    x: hit.cx,
    y: hit.cy,
    desc: hit.desc || hit.text,
    matched: hit.text || hit.desc,
    L: hit.L,
    T: hit.T,
    R: hit.R,
    B: hit.B,
  };
}

/** 主页浮层关注 CTA 选择器（xhs.follow.ensure overlay 模式）。
 *  同屏可能有多个精确「关注」label（背景/普通 detail 控件 y≈161、统计 tab y≈567、浮层主 CTA y≈999），
 *  通用 findFollowBtn 取 first-match 会命中背景节点。本函数仅在 tier-1 头像指纹存在时定位浮层主 CTA：
 *  1) 必须有 tier-1 头像（ImageView clickable cy<600 content-desc ^头像[,，]），否则非浮层 → null；
 *  2) 候选 label（text/desc 精确属于四态）必须在头像下方（cy > 头像 cy）；text/desc 冲突时 matched 取真正属于四态的字段；
 *  3) 解析包含 label 的最小面积 enabled clickable 容器（几何包含）；同面积并列容器全收、不靠输入序取首个；
 *  4) 屏宽取自「可信 root」——在包含头像的节点里面积最大者（全屏窗口，远大于头部卡片/统计 tab），非全局 max R 也非首个解析节点；
 *     allNodes() 只解析 <node>、不以首节点为根；稀疏/截断 dump 无此节点 → 无法确立屏宽 → fail-closed；
 *  5) 排除全屏/近全屏（宽 ≥ 屏宽 90%）clickable wrapper（点击消散层），非 CTA；不硬编码屏幕坐标，用比例；
 *  6) 剩余容器宽 ≥ 屏宽 30%，过滤窄统计 tab；
 *  7) 唯一可点候选才返回其容器中心；零或多个 → null（fail-closed，绝不猜坐标）；同 bounds 去重，不同容器即便同中心也算多候选。
 *  返回形状与 findFollowBtn 一致：{x,y,desc,matched,L,T,R,B}，便于调用方在浮层场景直接替换。 */
export function findProfileFollowBtn(xml) {
  const nodes = allNodes(xml);
  const av = nodes.find(
    (n) =>
      n.cls === "ImageView" &&
      n.clickable &&
      n.cy < 600 &&
      /^头像[,，]/.test(String(n.desc || "")),
  );
  if (!av) return null; // 无 tier-1 头像指纹 → 非主页浮层，交给通用 findFollowBtn
  const contains = (a, b) => a.L <= b.L && a.T <= b.T && a.R >= b.R && a.B >= b.B;
  const area = (n) => (n.R - n.L) * (n.B - n.T);

  // 可信 root：在「包含 tier-1 头像」的节点里取面积最大者（全屏窗口，远大于头部卡片/统计 tab 等子容器）。
  // 头像自身被排除；统计 tab/头部卡片不包含头像 → 不会当选。稀疏/截断 dump（仅头像+窄统计 tab，无全屏根）
  // → 无任何节点包含头像 → 无可信 root → 无法确立屏宽 → fail-closed。
  const root = nodes
    .filter((n) => n !== av && contains(n, av))
    .sort((a, b) => area(b) - area(a))[0];
  if (!root) return null;
  const screenW = root.R - root.L;
  if (screenW < 100) return null;
  const minCtaW = screenW * 0.3;

  const seen = new Set();
  const cands = [];
  for (const l of nodes) {
    const t = String(l.text || "").trim();
    const d = String(l.desc || "").trim();
    if (!FOLLOW_LABELS.has(t) && !FOLLOW_LABELS.has(d)) continue;
    if (l.cy <= av.cy) continue; // 头像上方（含同高）→ 背景/普通 detail 控件，拒
    const matched = FOLLOW_LABELS.has(t) ? t : d; // text/desc 冲突时取真正属于四态的字段，非 text||desc
    // 包含 label 的全部 enabled clickable 容器，按面积升序排
    const anc = nodes
      .filter((n) => n !== l && n.clickable && n.enabled !== false && contains(n, l))
      .sort((a, b) => area(a) - area(b));
    if (!anc.length) continue; // 无可点容器 → 非可操作
    // 最小面积容器集合：同面积并列则全收（不靠输入序取 anc[0]），交下游唯一性判断
    const minA = area(anc[0]);
    const minimal = anc.filter((a) => area(a) === minA);
    for (const c of minimal) {
      if (c.R - c.L >= screenW * 0.9) continue; // 全屏/近全屏 wrapper（点击消散层）→ 非 CTA，排除
      if (c.R - c.L < minCtaW) continue; // 窄容器 → 统计 tab，拒
      const key = `${c.L},${c.T},${c.R},${c.B}`;
      if (seen.has(key)) continue; // 同 bounds 容器去重；不同容器即便同中心也算多候选
      seen.add(key);
      cands.push({ c, matched });
    }
  }
  if (cands.length !== 1) return null; // 零或多个 → fail-closed，绝不猜坐标
  const { c, matched } = cands[0];
  return { x: c.cx, y: c.cy, desc: matched, matched, L: c.L, T: c.T, R: c.R, B: c.B };
}

/** 主页浮层作者名提取（供 xhs.follow.ensure 的 targetUser 核对）。
 *  tier-1：clickable 头像 ImageView 的 content-desc「头像,<name>」取逗号后；tier-2（仅诊断，不采信）：
 *  浮层顶部 y<600 内、非数字非 meta、长 2-24 的 TextView。返回 { name, fallback }。
 *  `头像,<name>` 格式来自 fast-operator 注释、未真实 dump 实证——tier-1 miss 即 name:null，调用方 fail-closed。 */
export function findProfileAuthor(xml) {
  const nodes = allNodes(xml);
  const av = nodes.find(
    (n) =>
      n.cls === "ImageView" &&
      n.clickable &&
      n.cy < 600 &&
      /^头像[,，]/.test(String(n.desc || "")),
  );
  if (av) {
    const name = String(av.desc).split(/[,，]/).slice(1).join(",").trim();
    if (name) return { name, fallback: null };
  }
  const meta = /^(粉丝|获赞|关注|主页|笔记|互关|相互关注|已关注|关注他|关注她|私信)$/;
  const cand = nodes
    .filter(
      (n) =>
        n.cls === "TextView" &&
        n.cy < 600 &&
        (n.text || "").length >= 2 &&
        (n.text || "").length <= 24 &&
        !/^\d/.test(n.text) &&
        !meta.test(n.text),
    )
    .sort((a, b) => a.cy - b.cy);
  return { name: null, fallback: cand[0]?.text?.trim() || null };
}

/** 已关注/相互关注 = followed；关注/回关 = unfollowed。
 *  回关=对方关注你、你未关注（tap 即回关）→ unfollowed。先判已关注/相互关注避免「关注」子串误中。 */
export function followState(desc) {
  const s = String(desc || "");
  if (!s) return "missing";
  if (/已关注|相互关注/.test(s)) return "followed";
  if (/关注|回关/.test(s)) return "unfollowed";
  return "unknown";
}

/** 评论框入口（点开会弹评论编辑器）。复用 findBtn 的 (评论框|说点什么) 模式。 */
export function findCommentBox(xml) {
  return findBtn(xml, "commentBox");
}

/**
 * 解析 detail 页评论区。纯启发式，不强求完美。
 * count 来自 content-desc「评论 N」；box 是评论框坐标；
 * items 每条尽量配 user（短 text）+ text（正文 ≥4）+ likes（纯数字）+ y。
 */
export function parseComments(xml) {
  if (!xml) return { count: null, box: null, items: [] };
  const nodes = allNodes(xml);
  let count = null;
  for (const n of nodes) {
    const m =
      String(n.desc || "").match(/^评论\s*(\d+)$/) ||
      String(n.text || "").match(/^评论\s*(\d+)$/);
    if (m) {
      count = Number(m[1]);
      break;
    }
  }
  const boxRaw = findCommentBox(xml);
  const box = boxRaw ? { x: boxRaw.x, y: boxRaw.y } : null;

  const uiLabel =
    /^(关注|已关注|回关|相互关注|点赞|已点赞|收藏|已收藏|评论|分享|说点什么|评论框|发送|发布|下一步|返回|首页|消息|我|展开|收起|查看更多评论|作者|置顶|回复)$/;
  const shortTexts = nodes.filter(
    (n) => n.text && n.text.length >= 1 && n.text.length <= 20 && !uiLabel.test(n.text) && !/^\d+$/.test(n.text),
  );
  const likeNodes = nodes.filter((n) => n.text && /^\d+$/.test(n.text));

  const bodyCands = nodes
    .filter((n) => n.text && n.text.length >= 4 && !uiLabel.test(n.text) && !/^\d+$/.test(n.text))
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const seen = new Set();
  const items = [];
  for (const n of bodyCands) {
    const key = `${n.cy}_${n.text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 用户名：同 y 带附近、更靠左的短 text
    const userCand = shortTexts
      .filter((s) => Math.abs(s.cy - n.cy) <= 80 && s.cx < n.cx + 40 && s.text !== n.text)
      .sort((a, b) => Math.abs(a.cy - n.cy) - Math.abs(b.cy - n.cy) || a.cx - b.cx)[0];

    // 点赞数：同 y 带附近、更靠右的纯数字
    const likesCand = likeNodes
      .filter((s) => Math.abs(s.cy - n.cy) <= 60 && s.cx >= n.cx - 20)
      .sort((a, b) => Math.abs(a.cy - n.cy) - Math.abs(b.cy - n.cy) || b.cx - a.cx)[0];

    items.push({
      user: userCand?.text || "",
      text: n.text.slice(0, 200),
      likes: likesCand ? Number(likesCand.text) : null,
      y: n.cy,
    });
  }
  return { count, box, items };
}
