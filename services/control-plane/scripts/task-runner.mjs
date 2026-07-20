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
  if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) throw new Error(`task.steps must be a non-empty array: ${path}`);
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
]);

async function dispatchStep(op, step, ctx) {
  const s0 = Date.now();
  const ms = () => Date.now() - s0;
  const rest = step.rest; // 步间停顿覆盖（最终在 main 里 pace）
  const emit = (r) => Object.assign({ action: step.action, idx: step.idx, ms: ms() }, r);

  switch (step.action) {
    case "scrollN":
      return emit({ ok: true, ...(await op.scrollN({ n: step.n ?? 1, down: step.down !== false })) });

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

// ---- main ----
async function main() {
  const adbPath = arg("--adb", null);
  const serial = arg("--serial", null);
  const taskPath = arg("--task", null);
  if (!adbPath || !serial || !taskPath) {
    console.error("usage: task-runner.mjs --adb <path> --serial <serial> --task <file.json> [--loops N] [--comment-cap N] [--dry-run] [--fast] [--log-dir <dir>] [--on-error skip|abort]");
    process.exit(2);
  }
  const task = loadTask(resolve(taskPath));
  const loopsOverride = arg("--loops", null);
  const loops = Number(loopsOverride ?? task.loops);
  const commentCap = Number(arg("--comment-cap", "2"));
  const dryRun = flag("--dry-run");
  const onError = arg("--on-error", task.onError);
  const logDir = arg("--log-dir", null);

  const opP = applyCommentFlags(new FastOperator({ adbPath, serial }).start());
  const op = await opP;
  const logger = openLog(logDir, task.name);

  let stop = false;
  const stopSignal = async () => { stop = true; };
  process.on("SIGINT", () => { console.error("\n[SIGINT] finishing current step, then backToFeed..."); stopSignal(); });
  process.on("SIGTERM", stopSignal);

  const summary = { task: task.name, loops, dryRun, commentCap, onError, t0: Date.now(), okSteps: 0, skipSteps: 0, errSteps: 0, loopsDone: 0, logPath: logger.path };
  console.log(JSON.stringify({ phase: "start", task: task.name, loops, dryRun, commentCap, log: logger.path }));

  const ensure = await ensureOnFeed(op);
  console.log(JSON.stringify({ phase: "ensureOnFeed", ...ensure }));
  if (!ensure.ok) {
    console.error(JSON.stringify({ phase: "abort", reason: "notOnFeed", activity: ensure.activity }));
    await op.close();
    process.exit(3);
  }

  let aborted = false;
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