// fast-operator task-runner —— 脚本式任务编排层
//
// 读一个任务定义 JSON（一组原语 steps + loops + 拟人间隔），在进程内直接调
// FastOperator 原语自动跑。带封号风控：评论频次上限、步间/圈间拟人停顿、
// 视频/带货跳过、SIGINT 优雅退出。LLM 自主决策层留后续，叠在本层之上。
//
// 用法：
//   node task-runner.mjs --adb <adb.exe> --serial <serial> --task <tasks/养号.json>
//     [--loops N] [--comment-cap N] [--dry-run] [--log-dir <dir>] [--on-error skip|abort]
//     [--fast] [--pace-fast] [--ime-sticky] [--verify light|strict]
//     [--llm-endpoint ... --llm-key ... --llm-model ... --xw-ws ... --xw-bridge-ime ...]
//
// --fast / --llm-* / --xw-* 等透传给 applyCommentFlags（它直接读 process.argv），
// task-runner 只认本块开头列出的自有 flag。
//
// 仅 loopback / 进程内直连 op，不经网络。遵守 fast-operator.mjs 顶部安全边界。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FastOperator, Pacer, applyCommentFlags } from "./fast-operator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }

// ---- 任务定义加载 ----
function loadTask(path) {
  if (!existsSync(path)) throw new Error(`task file not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // 自主模式可省 steps（每张卡片由 LLM 即时决策）；脚本模式仍要求非空 steps
  if (!raw || !Array.isArray(raw.steps) || (!raw.steps.length && !raw.autonomous)) {
    throw new Error(`task.steps must be a non-empty array (or set autonomous:true): ${path}`);
  }
  raw.loops = Number(raw.loops ?? 1);
  raw.restBetweenLoops = raw.restBetweenLoops ?? { minMs: 8000, maxMs: 20000 };
  raw.onError = raw.onError ?? "skip";
  raw.name = raw.name ?? basename(path).replace(/\.json$/, "");
  return raw;
}

const COMMENT_ACTIONS = new Set(["commentOnOpenNote", "commentTransaction"]);

// ---- step dispatch（进程内，省 dump）----
// 返回 { ok, step?, ms, skipped?, activity?, ...原语返回字段 }。
// ok=false 且 step 属于"异构 UI / 偶发"码 → ctx 记 skip，不 abort。
const SKIP_STEPS = new Set([
  "detailfeedUnsupported", // 带货/carousel 无评论占位条
  "editorLostAfterInput", "commentBox", "sendButton", "inputText", // 评论链路偶发
  "countUnavailable", // 图文笔记 "共N条评论" header 缺失，count 无法实证 → 退出找下一篇
]);

async function dispatchStep(op, step, ctx) {
  const s0 = Date.now();
  const ms = () => Date.now() - s0;
  const rest = step.rest; // 步间停顿覆盖（最终在 main 里 pace）
  const emit = (r) => Object.assign({ action: step.action, idx: step.idx, ms: ms() }, r);

  switch (step.action) {
    case "scrollN": {
      const doc = await op.scrollN({ n: step.n ?? 1, down: step.down !== false });
      // scrollN 返回整份 doc（含 nodes 数组），不要 spread 进日志——只记摘要，避免长跑爆日志
      return emit({ ok: true, scrolls: step.n ?? 1, nodes: (doc.nodes || []).length, dumpMs: doc._dumpMs });
    }

    case "likeCard": {
      const d = await op.feedDump({ label: "like" });
      const cards = op.feedCards(d);
      const c = cards[step.idx ?? 0];
      if (!c?.likeButton) return emit({ ok: false, step: "noLikeButton", skipped: true, cards: cards.length });
      return emit({ ok: true, ...(await op.likeCard(c)) });
    }

    case "likeDetail":
    case "favoriteDetail": {
      const d = await op.feedDump({ label: "open-detail" });
      const cards = op.feedCards(d);
      const c = cards[step.idx ?? 0];
      if (!c) return emit({ ok: false, step: "noCard", skipped: true });
      const opened = await op.openCard(c);
      if (!opened.opened) return emit({ ok: false, step: "openCard", skipped: true, activity: opened.activity });
      const dd = await op.dump({ label: "detailBar" });
      const bar = op.detailEngagementBar(dd);
      const target = step.action === "likeDetail" ? bar?.like : bar?.favorite;
      if (!target?.icon?.center) {
        await op.backToFeed(4);
        return emit({ ok: false, step: "noBarButton", skipped: true, activity: opened.activity });
      }
      const r = step.action === "likeDetail" ? await op.likeDetail(bar) : await op.favoriteDetail(bar);
      await op.backToFeed(4);
      return emit({ ok: true, ...r });
    }

    case "commentOnOpenNote": {
      // 评论频次风控：每圈达 cap 即跳过（不计数、不 abort）
      if (ctx.commentCountThisLoop >= ctx.commentCap) {
        return emit({ ok: false, step: "commentCapReached", skipped: true });
      }
      const d = await op.feedDump({ label: "comment-open" });
      const cards = op.feedCards(d);
      const c = cards[step.idx ?? 0];
      if (!c) return emit({ ok: false, step: "noCard", skipped: true });
      const opened = await op.openCard(c);
      const act = (opened.activity || "");
      // skipVideo：开到 DetailFeed 即跳过该张（原语内部其实支持视频评论，此为任务层偏好）
      if (step.skipVideo && act.includes("DetailFeed")) {
        await op.backToFeed(4);
        return emit({ ok: false, step: "skippedVideo", skipped: true, activity: act });
      }
      // dry-run：视频走 zero-send commentOnVideoNote(dryRun:true)；图文仅开+回（零输入零发，最安全）
      if (ctx.dryRun) {
        if (act.includes("DetailFeed")) {
          const r = await op.commentOnVideoNote({ text: step.text || "测试输入落地", dryRun: true });
          await op.backToFeed(4);
          return emit({ ok: r.ok, step: r.step, skipped: !r.ok, dryRun: true, activity: r.activity });
        }
        await op.backToFeed(4);
        return emit({ ok: true, step: "dryRunImageSkip", skipped: true, dryRun: true, activity: act });
      }
      // 真发：commentOnOpenNote 内部对 DetailFeed 自动委托 commentOnVideoNote
      const r = await op.commentOnOpenNote({ text: step.text, maxScrolls: step.maxScrolls ?? 6 });
      await op.backToFeed(5);
      const skipped = !r.ok && SKIP_STEPS.has(r.step);
      if (r.ok) ctx.commentCountThisLoop += 1; // 仅实发成功才计数 cap
      return emit({ ok: r.ok, step: r.step, skipped, verified: r.verified, verifyMethod: r.verifyMethod, beforeCount: r.beforeCount, afterCount: r.afterCount, activity: r.activity });
    }

    case "openProfile": {
      const d = await op.feedDump({ label: "open-profile" });
      const cards = op.feedCards(d);
      const c = cards[step.idx ?? 0];
      if (!c) return emit({ ok: false, step: "noCard", skipped: true });
      const r = await op.openProfile(c);
      return emit({ ok: !!r.opened, ...r });
    }
    case "scrollProfile":
      return emit({ ok: true, ...(await op.scrollProfile(step.n ?? 1, "task-profile-scroll")) });
    case "playProfileVideo": {
      const d = await op.dump({ label: "task-profile-grid" });
      const r = await op.playProfileVideo(d, step.idx ?? 0);
      return emit({ ok: !!r.opened, ...r });
    }
    case "backFromNote":
      return emit({ ok: true, ...(await op.backFromNote()) });
    case "backFromProfile":
      return emit({ ok: true, ...(await op.backFromProfile(step.maxBack ?? 4)) });

    case "backToFeed":
      return emit({ ok: true, ...(await op.backToFeed(step.maxBack ?? 4)) });

    case "rest":
      return emit({ ok: true, rested: true });

    default:
      return emit({ ok: false, step: "unknownAction", skipped: true });
  }
}

// ---- 归位：不在 IndexActivity 先 backToFeed，仍不在则 monkey 起 xhs ----
async function ensureOnFeed(op) {
  const f = await op.currentFocus();
  if ((f.activity || "").includes("IndexActivity")) return { ok: true, activity: f.activity };
  const back = await op.backToFeed(5);
  const f2 = await op.currentFocus();
  if ((f2.activity || "").includes("IndexActivity")) return { ok: true, activity: f2.activity, back };
  // 仍不在 feed（可能被退到 Launcher）→ monkey 起 xhs
  await op.session.exec("monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1", 12000);
  await new Promise((r) => setTimeout(r, 3000));
  const f3 = await op.currentFocus();
  return { ok: (f3.activity || "").includes("IndexActivity"), activity: f3.activity, launched: true };
}

// ---- 日志 ----
function openLog(logDir, name) {
  const dir = logDir || join(__dirname, "logs");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `task-${name}-${ts}.jsonl`);
  writeFileSync(path, ""); // touch
  const writeLine = (obj) => { try { writeFileSync(path, JSON.stringify(obj) + "\n", { flag: "a" }); } catch {} };
  return { path, writeLine };
}

// ---- LLM 自主决策层（叠在脚本层之上）----
// 每张 feed 卡片：openCard → dump 详情 → LLM 从 caption 决定 like/favorite/comment/skip
// → 执行 → backToFeed。评论仍守 Slice 2 约束 + commentCap 风控。

// 评论文本安全过滤：命中即降级 skip（绝不发外向/敏感动作指令）
const UNSAFE_COMMENT_RE = /(点赞|关注|私[信聊]|发布|删除|自动|批量|加群|扫码|代购|转账|打款|微信|qq|vx|加我|联系我)/i;

async function llmChat(op, messages, { maxTokens = 200, temperature = 0.6, timeoutMs = 15000 } = {}) {
  const ep = op.llmEndpoint;
  if (!ep) return null;
  const body = {
    model: op.llmModel || "grok-4.20-0309-non-reasoning",
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  const headers = { "content-type": "application/json" };
  if (op.llmKey) headers.authorization = `Bearer ${op.llmKey}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
  finally { clearTimeout(to); }
}

// 从详情页 dump 解析 caption / 评论数 / 底部栏数字
// 标题：全宽 TextView(width>600)、非可点击、y 在 1500-1950，排除 UI 占位串
const DETAIL_UI_NOISE = /^(关注|说点什么|猜你想搜|不感兴趣|不喜欢|分享|收藏|评论|举报|识图搜同款|去逛逛|立即购买|¥|\d+(\.\d+)?万?|起价|券后)$/;
function extractDetail(doc) {
  const nodes = doc?.nodes || [];
  const tvs = nodes.filter((n) => n.className === "android.widget.TextView" && (n.text || "").trim());
  let title = null;
  for (const n of tvs) {
    const b = n.bounds;
    const w = b[2] - b[0];
    const cy = (b[1] + b[3]) / 2;
    if (!n.clickable && w > 600 && cy >= 1500 && cy <= 1950) {
      const t = n.text.trim();
      if (t.length < 4) continue;
      if (DETAIL_UI_NOISE.test(t)) continue;
      title = t;
      break;
    }
  }
  let commentCount = null;
  for (const n of tvs) {
    const m = (n.text || "").match(/共\s*(\d+)\s*条评论/);
    if (m) { commentCount = Number(m[1]); break; }
  }
  // 底部栏数字（y>2150 纯数字/万）—— 备用，给 LLM 看热度
  const barNums = [];
  for (const n of tvs) {
    const b = n.bounds; const cy = (b[1] + b[3]) / 2;
    if (cy > 2150 && /^[\d.]+万?$/.test(n.text.trim())) barNums.push(n.text.trim());
  }
  return { title, commentCount, barNums };
}

// LLM 决策：返回 { action: like|favorite|comment|skip, commentText? }
async function decideAction(op, detail, ctx) {
  const capLeft = Math.max(0, ctx.commentCap - ctx.commentCountThisLoop);
  const sys = "你是小红书真人用户。根据笔记标题决定对这张笔记做什么互动。只回 JSON，不要多余文字。";
  const user = JSON.stringify({
    标题: detail.title || "(无法识别标题)",
    评论数: detail.commentCount,
    底部数字: detail.barNums,
    本圈还能评论: capLeft,
    可选动作: ["like", "favorite", "comment", "skip"],
    约束: [
      "像真人浏览，多数笔记只 like 或 skip，偶尔 favorite，少数 comment",
      "评论要符合笔记内容、自然口语、不超 20 字、不带表情符号刷屏",
      capLeft <= 0 ? "本圈评论已满，不要选 comment" : "只有内容确实有话说才 comment",
      "不要发任何点赞/关注/私信/扫码/转账/导流类话术",
    ],
    输出格式: '{"action":"like|favorite|comment|skip","commentText":"若 comment 则填，否则省略"}',
  });
  const raw = await llmChat(op, [
    { role: "system", content: sys },
    { role: "user", content: user },
  ], { maxTokens: 120, temperature: 0.7 });
  if (!raw) return { action: "skip", reason: "llmNull" };
  // 抽取第一个 {...}
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { action: "skip", reason: "llmNoJson" };
  try {
    const d = JSON.parse(m[0]);
    if (!["like", "favorite", "comment", "skip"].includes(d.action)) return { action: "skip", reason: "badAction" };
    if (d.action === "comment") {
      if (capLeft <= 0) return { action: "skip", reason: "capReached" };
      const t = (d.commentText || "").trim();
      if (!t || t.length > 20 || UNSAFE_COMMENT_RE.test(t)) return { action: "skip", reason: "unsafeComment" };
      return { action: "comment", commentText: t };
    }
    return { action: d.action };
  } catch { return { action: "skip", reason: "llmParseFail" }; }
}

// 执行单张卡片决策。返回 { ok, action, step?, skipped?, commented? }
async function executeAutonomousAction(op, decision, ctx, act) {
  if (decision.action === "skip") return { ok: true, action: "skip", skipped: true, reason: decision.reason };
  if (decision.action === "like") {
    const dd = await op.dump({ label: "auto-bar" });
    const bar = op.detailEngagementBar(dd);
    if (!bar?.like?.icon?.center) return { ok: false, action: "like", step: "noBarButton", skipped: true };
    return { ok: true, action: "like", ...(await op.likeDetail(bar)) };
  }
  if (decision.action === "favorite") {
    const dd = await op.dump({ label: "auto-bar" });
    const bar = op.detailEngagementBar(dd);
    if (!bar?.favorite?.icon?.center) return { ok: false, action: "favorite", step: "noBarButton", skipped: true };
    return { ok: true, action: "favorite", ...(await op.favoriteDetail(bar)) };
  }
  if (decision.action === "comment") {
    if (ctx.commentCountThisLoop >= ctx.commentCap) return { ok: false, action: "comment", step: "commentCapReached", skipped: true };
    if (ctx.dryRun) return { ok: true, action: "comment", step: "dryRunSkip", skipped: true, dryRun: true };
    // commentOnOpenNote 内部对 DetailFeed 自动委托 commentOnVideoNote
    const r = await op.commentOnOpenNote({ text: decision.commentText, maxScrolls: 6 });
    const skipped = !r.ok && SKIP_STEPS.has(r.step);
    if (r.ok) ctx.commentCountThisLoop += 1;
    return { ok: r.ok, action: "comment", step: r.step, skipped, verified: r.verified, beforeCount: r.beforeCount, afterCount: r.afterCount, activity: r.activity, commented: r.ok };
  }
  return { ok: false, action: "skip", step: "unknownDecision", skipped: true };
}

// 自主循环：每圈扫一屏卡片，按 cardsPerScreen 张做 LLM 决策，然后 scrollN
async function runAutonomous(op, task, loops, ctx, logger, summary, onAbort) {
  const cfg = task.autonomous || {};
  const cardsPerScreen = Math.max(1, Number(cfg.cardsPerScreen ?? 2));
  const scrollN = Math.max(1, Number(cfg.scrollN ?? 2));
  const skipVideo = cfg.skipVideo !== false;
  const cardsSeen = { like: 0, favorite: 0, comment: 0, skip: 0 };

  for (let loop = 0; loop < loops && !summary.stop && !summary.aborted; loop++) {
    const run = { loop, t0: Date.now(), cards: [], mode: "autonomous" };
    const d = await op.feedDump({ label: "auto-feed" });
    const cards = op.feedCards(d);
    const take = Math.min(cardsPerScreen, cards.length);
    for (let i = 0; i < take; i++) {
      if (summary.stop) break;
      const c = cards[i];
      const c0 = Date.now();
      const opened = await op.openCard(c);
      const act = opened.activity || "";
      let cardRes = { idx: i, author: c.authorName, activity: act, ms: Date.now() - c0, action: "open" };
      // 视频笔记：skipVideo 直接跳过（原语支持评论，此为任务层偏好+降本）
      if (skipVideo && act.includes("DetailFeed")) {
        await op.backToFeed(4);
        cardRes.action = "skipVideo";
        cardRes.skipped = true;
        run.cards.push(cardRes);
        cardsSeen.skip += 1;
        await op.pacer.pace({ minMs: 800, maxMs: 2000 });
        continue;
      }
      // dump 详情 → 抽 caption → LLM 决策 → 执行 → 回 feed
      const dd = await op.dump({ label: "auto-detail" });
      const detail = extractDetail(dd);
      const decision = await decideAction(op, detail, ctx);
      const exec = await executeAutonomousAction(op, decision, ctx, act);
      await op.backToFeed(5);
      cardRes.action = exec.action;
      cardRes.ok = exec.ok;
      if (exec.skipped) cardRes.skipped = true;
      if (exec.step) cardRes.step = exec.step;
      if (exec.commented) cardRes.commented = true;
      if (exec.verified !== undefined) cardRes.verified = exec.verified;
      cardRes.caption = detail.title ? String(detail.title).slice(0, 40) : null;
      cardRes.ms = Date.now() - c0;
      run.cards.push(cardRes);
      cardsSeen[exec.action] = (cardsSeen[exec.action] || 0) + 1;
      if (!exec.ok && !exec.skipped && task.onError === "abort") {
        console.error(JSON.stringify({ phase: "abortCard", loop, ...cardRes }));
        summary.aborted = true; break;
      }
      await op.pacer.pace({ minMs: 1000, maxMs: 2800 }); // 卡间拟人停顿
    }
    // 滚一屏
    if (!summary.stop && !summary.aborted) {
      const sdoc = await op.scrollN({ n: scrollN, down: true });
      run.scrollNodes = (sdoc.nodes || []).length;
    }
    run.ms = Date.now() - run.t0;
    run.commentCount = ctx.commentCountThisLoop;
    run.cardsSeen = cardsSeen;
    run.metrics = op.metricsSummary();
    logger.writeLine(run);
    console.log(JSON.stringify({ phase: "loopDone", loop, ms: run.ms, cards: run.cards.length, seen: cardsSeen, comments: run.commentCount, metrics: run.metrics }));
    summary.loopsDone += 1;
    if (loop < loops - 1 && !summary.stop && !summary.aborted) {
      await op.pacer.pace(task.restBetweenLoops);
    }
  }
  return { cardsSeen };
}

// ---- main ----
async function main() {
  const adbPath = arg("--adb", null);
  const serial = arg("--serial", null);
  const taskPath = arg("--task", null);
  if (!adbPath || !serial || !taskPath) {
    console.error("usage: task-runner.mjs --adb <path> --serial <serial> --task <file.json> [--loops N] [--comment-cap N] [--dry-run] [--autonomous] [--fast] [--log-dir <dir>] [--on-error skip|abort]");
    process.exit(2);
  }
  const task = loadTask(resolve(taskPath));
  const loopsOverride = arg("--loops", null);
  const loops = Number(loopsOverride ?? task.loops);
  const commentCap = Number(arg("--comment-cap", "2"));
  const dryRun = flag("--dry-run");
  const onError = arg("--on-error", task.onError);
  const logDir = arg("--log-dir", null);
  const autonomous = flag("--autonomous") || !!task.autonomous;

  const opP = applyCommentFlags(new FastOperator({ adbPath, serial }).start());
  const op = await opP;
  const logger = openLog(logDir, task.name);

  let stop = false;
  let aborted = false;
  const stopSignal = async () => { stop = true; };
  process.on("SIGINT", () => { console.error("\n[SIGINT] finishing current step, then backToFeed..."); stopSignal(); });
  process.on("SIGTERM", stopSignal);

  const summary = { task: task.name, loops, dryRun, commentCap, onError, autonomous, t0: Date.now(), okSteps: 0, skipSteps: 0, errSteps: 0, loopsDone: 0, logPath: logger.path, stop, aborted };
  console.log(JSON.stringify({ phase: "start", task: task.name, loops, dryRun, commentCap, autonomous, log: logger.path }));

  const ensure = await ensureOnFeed(op);
  console.log(JSON.stringify({ phase: "ensureOnFeed", ...ensure }));
  if (!ensure.ok) {
    console.error(JSON.stringify({ phase: "abort", reason: "notOnFeed", activity: ensure.activity }));
    await op.close();
    process.exit(3);
  }

  // ---- 自主模式：LLM 每张卡片即时决策；脚本模式：固定 steps 循环 ----
  if (autonomous) {
    const ctx = { dryRun, commentCap, commentCountThisLoop: 0 };
    // 让 runAutonomous 与外层 stop/aborted 共享
    Object.defineProperty(summary, "stop", { get: () => stop, set: (v) => { stop = v; } });
    Object.defineProperty(summary, "aborted", { get: () => aborted, set: (v) => { aborted = v; } });
    const res = await runAutonomous(op, task, loops, ctx, logger, summary, () => stop);
    summary.cardsSeen = res.cardsSeen;
    summary.okSteps = res.cardsSeen.like + res.cardsSeen.favorite + res.cardsSeen.comment;
    summary.skipSteps = res.cardsSeen.skip;
    try { await op.backToFeed(5); } catch {}
    try { await op.close(); } catch {}
    summary.ms = Date.now() - summary.t0;
    summary.metrics = op.metricsSummary();
    summary.stopped = stop;
    summary.aborted = aborted;
    logger.writeLine({ phase: "summary", ...summary });
    console.log(JSON.stringify({ phase: "done", ...summary }));
    process.exit(0);
  }

  for (let loop = 0; loop < loops && !stop && !aborted; loop++) {
    const ctx = { dryRun, commentCap, commentCountThisLoop: 0 };
    const run = { loop, t0: Date.now(), steps: [] };
    for (const step of task.steps) {
      if (stop) break;
      const res = await dispatchStep(op, step, ctx);
      run.steps.push(res);
      if (res.ok) summary.okSteps += 1;
      else if (res.skipped) summary.skipSteps += 1;
      else summary.errSteps += 1;

      if (!res.ok && !res.skipped && onError === "abort") {
        console.error(JSON.stringify({ phase: "abortStep", loop, ...res }));
        aborted = true;
        break;
      }
      // 步间拟人停顿
      const rb = step.rest ?? { minMs: 800, maxMs: 2500 };
      await op.pacer.pace(rb);
    }
    run.ms = Date.now() - run.t0;
    run.commentCount = ctx.commentCountThisLoop;
    run.metrics = op.metricsSummary();
    logger.writeLine(run);
    console.log(JSON.stringify({ phase: "loopDone", loop, ms: run.ms, ok: run.steps.filter((s) => s.ok).length, skip: run.steps.filter((s) => s.skipped).length, comments: run.commentCount, metrics: run.metrics }));
    summary.loopsDone += 1;
    if (loop < loops - 1 && !stop && !aborted) {
      await op.pacer.pace(task.restBetweenLoops); // 圈间更长停顿
    }
  }

  // 收尾：回首页 + 关会话
  try { await op.backToFeed(5); } catch {}
  try { await op.close(); } catch {}

  summary.ms = Date.now() - summary.t0;
  summary.metrics = op.metricsSummary();
  summary.stopped = stop;
  summary.aborted = aborted;
  logger.writeLine({ phase: "summary", ...summary });
  console.log(JSON.stringify({ phase: "done", ...summary }));
  process.exit(0);
}

main().catch((e) => {
  console.error(JSON.stringify({ phase: "fatal", error: e.message, stack: e.stack }));
  process.exit(1);
});