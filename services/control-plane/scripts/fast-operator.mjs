// fast-operator.mjs — AI 员工高速运营旁路（Slice 1 核心）
//
// 长驻进程，不经过网关：每台设备一条持久 `adb shell` 会话，命令走 stdin、
// stdout 用 sentinel 分帧。砍掉每个 primitive 的 adb 客户端启动 + 网关 3 进程
// spawn + 每个 primitive 的 WS 握手。hierarchy 一次 dump 服务同卡多动作。
//
// 本批原语（全部非互动 / 零封号风险，用于验证吞吐架构）：
//   currentFocus / dump / observeFeed / scrollDown / scrollUp / scrollNThenDump / tap
// 互动原语（like/favorite/comment/profile）在 Slice 1 后续按需追加，需最小真实
// 互动验收，单独管控。
//
// 安全边界：
//   - 仅 loopback HTTP（127.0.0.1），不对外。
//   - 拟人限速层 pace()：动作间随机间隔，默认 800-2500ms，可调。
//   - 不碰私信。不自动发送评论（Slice 2 才拆围栏）。
//
// 用法：
//   node fast-operator.mjs --adb "<adb.exe>" --serial <serial> serve [--port 17895]
//   node fast-operator.mjs --adb "<adb.exe>" --serial <serial> demo-scroll <N>

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 跨进程文件锁串行化小薇 WS 访问：xiaowei 单实例 WS accept 串行，多设备并发建连会持续 connection failed
// （非瞬时，retry 无效）。4 个 task-runner 进程抢同一 lock 文件，O_EXCL 互斥，每次只 1 路连 22222。
// 陈旧检测：持锁进程崩溃残留 lock，30s 后强删（xiaoweiInvoke 最坏 3×12s<36s，留余量）。
const XW_LOCK = join(tmpdir(), "xw-ws-22222.lock");
async function withXwLock(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try { writeFileSync(XW_LOCK, String(process.pid), { flag: "wx" }); break; }
    catch (e) {
      if (e.code === "EEXIST") {
        try { const st = statSync(XW_LOCK); if (Date.now() - st.mtimeMs > 30000) { try { unlinkSync(XW_LOCK); } catch {} } } catch {}
        await new Promise((r) => setTimeout(r, 50 + (attempt % 8) * 30));
        continue;
      }
      throw e;
    }
  }
  try { return await fn(); }
  finally { try { unlinkSync(XW_LOCK); } catch {} }
}

// ---------- uiautomator XML 解析（自包含，不依赖原文件） ----------

function parseBounds(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function centerOf(b) {
  if (!b) return null;
  return [((b[0] + b[2]) / 2) | 0, ((b[1] + b[3]) / 2) | 0];
}

function decodeAttr(value) {
  if (typeof value !== "string") return value;
  // uiautomator 转义: " & ' < >
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseUiAutomatorXml(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)(?:\/>|>\s*<\/node>)/g;
  let m;
  const attrRe = /(\b[a-zA-Z:_][a-zA-Z0-9:_-]*)\s*=\s*"([^"]*)"/g;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const a = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(body)) !== null) a[am[1]] = am[2];
    nodes.push({
      index: a.index ?? "",
      text: decodeAttr(a.text ?? ""),
      contentDesc: decodeAttr(a["content-desc"] ?? ""),
      resourceDesc: decodeAttr(a["resource-desc"] ?? ""),
      className: a.class ?? "",
      resourceId: a["resource-id"] ?? "",
      package: a.package ?? "",
      bounds: parseBounds(a.bounds ?? ""),
      clickable: a.clickable === "true",
      focused: a.focused === "true",
      focusable: a.focusable === "true",
      scrollable: a.scrollable === "true",
      enabled: a.enabled !== "false",
    });
  }
  return { nodes };
}

// child bounds 是否完全落在 parent bounds 内（带 2px 容差），用于评论 item 子树归属判定
function isDescendantBounds(child, parent) {
  if (!child || !parent) return false;
  return child[0] >= parent[0] - 2 && child[1] >= parent[1] - 2
    && child[2] <= parent[2] + 2 && child[3] <= parent[3] + 2;
}

// 通用 JSON POST（Node 24 全局 fetch），用于 LLM 改写调用
async function httpPostJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ---------- 持久 adb shell 会话 ----------

class AdbShellSession {
  constructor(adbPath, serial) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.proc = null;
    this.buf = "";
    this.waiters = [];
    this.cmdSeq = 0;
  }

  async start() {
    this.proc = spawn(this.adbPath, ["-s", this.serial, "shell"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      this.drain();
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => {});
    await this.exec("echo fastop-ready"); // warm up
    return this;
  }

  drain() {
    while (this.waiters.length > 0) {
      const w = this.waiters[0];
      const idx = this.buf.indexOf(w.marker);
      if (idx < 0) break;
      const end = idx + w.marker.length;
      const out = this.buf.slice(0, idx).replace(/\r$/g, "");
      this.buf = this.buf.slice(end);
      this.waiters.shift();
      w.resolve(out);
    }
  }

  exec(cmd, timeoutMs = 30000) {
    if (!this.proc) throw new Error("adb shell session not started");
    const marker = `__FO_END_${this.cmdSeq++}__`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.marker === marker);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`adb shell timeout (${timeoutMs}ms): ${cmd.slice(0, 80)}`));
      }, timeoutMs);
      this.waiters.push({
        marker,
        resolve: (out) => { clearTimeout(t); resolve(out); },
      });
      this.proc.stdin.write(`${cmd}; echo ${marker}\n`);
    });
  }

  // exec-out 风格：拿二进制/大文本不走持久 shell（用一次性 adb，避免分帧冲突）
  async execOut(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.adbPath, ["-s", this.serial, "exec-out", ...args], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      let done = false;
      const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`exec-out timeout ${timeoutMs}ms`)); }, timeoutMs);
      p.stdout.on("data", (c) => chunks.push(c));
      p.on("error", (e) => { clearTimeout(t); reject(e); });
      p.on("close", () => { if (done) return; done = true; clearTimeout(t); resolve(Buffer.concat(chunks)); });
    });
  }

  async close() {
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
  }
}

// ---------- 拟人限速层 ----------

class Pacer {
  constructor({ minMs = 800, maxMs = 2500, seed = 1234 } = {}) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    // 简单确定性伪随机（不依赖 Math.random，便于复现）
    this.s = seed >>> 0;
  }
  next() {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 0xffffffff;
  }
  async pace({ minMs = this.minMs, maxMs = this.maxMs } = {}) {
    const d = minMs + this.next() * (maxMs - minMs);
    await new Promise((r) => setTimeout(r, d));
    return d;
  }
}

// ---------- fast-operator 主体 ----------

export class FastOperator {
  constructor({ adbPath, serial, pacer } = {}) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.session = new AdbShellSession(adbPath, serial);
    this.pacer = pacer ?? new Pacer();
    this.metrics = { actions: 0, dumps: 0, scrolls: 0, taps: 0, totalDumpMs: 0, totalScrollMs: 0 };
    // Slice 2 评论自主配置（由 CLI flag 注入，见 serve()/demoScroll 末尾）
    this.xwWs = null;            // ws://127.0.0.1:22222/
    this.xwBridgeIme = null;     // com.android.xwkeyboard/.XwIME
    this.llmEndpoint = null;     // http://100.84.194.46:8317/v1/chat/completions
    this.llmKey = null;
    this.llmModel = null;
    // Slice 2 优化配置（默认保持原拟人/校验行为；由 --ime-sticky/--pace-fast/--verify/--fast 注入）
    this.imeSticky = false;      // 批处理时发送后不切回 SogouIME，批结束用 restoreImeToPrior() 统一还原
    this.verifyMode = "strict";  // none|light|strict
    this._priorIme = null;       // inputTextViaXiaowei 记录的原始 IME，供 imeSticky 批后还原
    this.paceFast = false;       // --pace-fast/--fast：评论流程 pace 收紧（牺牲拟人度换吞吐）
  }

  // 评论流程 pace：paceFast 时收紧到 400-800，否则按 kind 给拟人间隔。
  commentPace(kind = "preBox") {
    if (this.paceFast) return this.pacer.pace({ minMs: 400, maxMs: 800 });
    const bounds = {
      preBox: { minMs: 1500, maxMs: 3500 },   // 开评论框前
      postTap: { minMs: 800, maxMs: 2000 },   // tap 框后等编辑器
      postOpen: { minMs: 1200, maxMs: 2800 }, // openCard 后
    }[kind] || { minMs: 800, maxMs: 2000 };
    return this.pacer.pace(bounds);
  }

  async start() { await this.session.start(); return this; }
  async close() { await this.session.close(); }

  async currentFocus() {
    const out = await this.session.exec("dumpsys window 2>/dev/null | grep -E mCurrentFocus", 10000);
    const m = out.match(/mCurrentFocus=Window\{[^}]+ ([^/}\s]+)\/([^}\s]+)/);
    return m ? { package: m[1], activity: m[2], raw: out } : { package: null, activity: null, raw: out };
  }

  // hierarchy dump：exec-out uiautomator dump /dev/tty（一次性，避免持久 shell 分帧）
  // 注：详情页 like/收藏/评论按钮 content-desc 为空（xhs 图标按钮无 label），resource-id
  // 被混淆，所以靠位置+class+clickability 解析，不依赖文本。解码用 utf-8。
  async dump({ label, retries = 2, settleMs = 0 } = {}) {
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    const t0 = Date.now();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let buf;
      try {
        buf = await this.session.execOut(["uiautomator", "dump", "/dev/tty"], 15000);
      } catch (e) {
        // 退路：写到 /sdcard 再 cat
        await this.session.exec("uiautomator dump /sdcard/fo-dump.xml 2>/dev/null", 15000);
        try { buf = await this.session.execOut(["cat", "/sdcard/fo-dump.xml"], 10000); }
        catch (e2) { lastErr = e2; if (attempt < retries) { await new Promise((r) => setTimeout(r, 600)); continue; } throw e2; }
      }
      const xml = buf ? buf.toString("utf8") : "";
      // uiautomator "could not get idle state" 偶发把错误文本混进 stdout 或只产截断 XML——
      // 检测到 idle 失败信号且无完整 hierarchy 时视为不完整重试（视频自动播放/动画 settle 期常见）。
      const idleFail = /could not get idle state|UiAutomator.*[Ee]rror|AndroidRuntime/i.test(xml) && xml.indexOf("<hierarchy") < 0;
      const start = xml.indexOf("<hierarchy");
      const end = xml.indexOf("</hierarchy>", start);
      if (start >= 0 && end >= 0 && !idleFail) {
        const doc = parseUiAutomatorXml(xml.slice(start, end + "</hierarchy>".length));
        this.metrics.dumps += 1;
        this.metrics.totalDumpMs += Date.now() - t0;
        doc._dumpMs = Date.now() - t0;
        doc._label = label;
        return doc;
      }
      lastErr = new Error(idleFail ? "uiautomator idle state failed" : "hierarchy dump incomplete");
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600)); // uiautomator 瞬时截断/idle 失败，加长重试间隔常恢复
    }
    throw lastErr;
  }

  // feed 滚屏：连续 N 次 input swipe，只在末次后 dump 一次。
  // startX/Y 控制方向（默认下滚）。返回最后一次 dump。
  async scrollN({ n = 1, down = true, settleMs = 350, label } = {}) {
    const t0 = Date.now();
    const w = 1080, h = 2400; // 01 物理尺寸；如需可读 wm size
    const startY = down ? Math.round(h * 0.7) : Math.round(h * 0.3);
    const endY = down ? Math.round(h * 0.3) : Math.round(h * 0.7);
    const x = Math.round(w / 2);
    for (let i = 0; i < n; i += 1) {
      await this.session.exec(`input swipe ${x} ${startY} ${x} ${endY} 300`, 8000);
      if (i < n - 1) await new Promise((r) => setTimeout(r, settleMs));
    }
    await new Promise((r) => setTimeout(r, settleMs));
    this.metrics.scrolls += n;
    this.metrics.totalScrollMs += Date.now() - t0;
    const doc = await this.dump({ label: label ?? `scroll-${n}` });
    return doc;
  }

  async scrollDown(n = 1, label) { return this.scrollN({ n, down: true, label }); }
  async scrollUp(n = 1, label) { return this.scrollN({ n, down: false, label }); }

  async tap(x, y) {
    this.metrics.taps += 1;
    return this.session.exec(`input tap ${x} ${y}`, 8000);
  }

  // 从 feed document 提取可见卡片。按结构 + 坐标解析，不依赖中文文本（dump 为
  // GBK 乱码时仍稳）。返回每张卡的封面（进详情）、点赞按钮（不进正文点赞）、
  // 头像/作者区（进主页）。bounds 与 center 已预算。
  feedCards(doc) {
    const cards = [];
    // 封面：大 ImageView（click=false、高>500、在 feed 区）。点它进详情。
    const covers = doc.nodes.filter((n) =>
      n.className === "android.widget.ImageView" && n.bounds && !n.clickable
      && (n.bounds[3] - n.bounds[1]) > 500 && (n.bounds[2] - n.bounds[0]) > 400
      && n.bounds[1] > 300 && n.bounds[3] < 2200);
    // 数值 TextView：accept 纯数字 + "1.2万/3.4亿" 风格（之前 regex 拒了万/亿）
    const numRe = /^[\d.]+[万千亿]?$/u;
    const nums = doc.nodes.filter((n) => n.clickable && n.bounds && numRe.test(n.text));
    // 点赞按钮：clickable ImageView + 紧邻右侧数值 TextView（同 y 中心）
    const likeBtns = [];
    for (const n of doc.nodes) {
      if (n.className !== "android.widget.ImageView" || !n.clickable || !n.bounds) continue;
      const num = nums.find((m) => Math.abs((m.bounds[1] + m.bounds[3]) / 2 - (n.bounds[1] + n.bounds[3]) / 2) < 60
        && m.bounds[0] >= n.bounds[2] - 20 && m.bounds[0] - n.bounds[2] < 120);
      if (num) likeBtns.push({ bounds: n.bounds, center: centerOf(n.bounds), countText: num.text });
    }
    for (const c of covers) {
      const cover = { bounds: c.bounds, center: centerOf(c.bounds) };
      // 该卡片的点赞按钮：x 落在 cover 同列 + y 在封面正上方 header 区
      const like = likeBtns.find((b) =>
        b.center[0] >= c.bounds[0] - 20 && b.center[0] <= c.bounds[2] + 20
        && b.bounds[3] <= c.bounds[1] + 60 && c.bounds[1] - b.bounds[1] < 320);
      // 作者行（与 like 同 y，cover 上方）：头像 71×71 click=0 在最左；作者名 TextView 非数字在头像与 like 之间
      let avatar = null, authorName = null;
      if (like) {
        const rowY = like.center[1];
        const likeCx = like.center[0];
        // 头像候选：非 clickable ImageView，尺寸 55-90，同 y，x 在 like 左侧
        const avatarCands = doc.nodes.filter((n) =>
          n.className === "android.widget.ImageView" && !n.clickable && n.bounds
          && (n.bounds[2] - n.bounds[0]) >= 55 && (n.bounds[2] - n.bounds[0]) <= 90
          && Math.abs(centerOf(n.bounds)[1] - rowY) < 60
          && centerOf(n.bounds)[0] < likeCx - 40
          && centerOf(n.bounds)[0] >= c.bounds[0] - 40 && centerOf(n.bounds)[0] <= c.bounds[2] + 40)
          .sort((a, b) => centerOf(a.bounds)[0] - centerOf(b.bounds)[0]);
        avatar = avatarCands[0] ? { bounds: avatarCands[0].bounds, center: centerOf(avatarCands[0].bounds) } : null;
        // 作者名：TextView，非数字非空，同 y，在头像右与 like 左之间
        const nameCands = doc.nodes.filter((n) =>
          n.className === "android.widget.TextView" && n.bounds && n.text && !/^\d/u.test(n.text)
          && Math.abs(centerOf(n.bounds)[1] - rowY) < 60
          && (avatar ? centerOf(n.bounds)[0] > avatar.center[0] + 20 : true)
          && centerOf(n.bounds)[0] < likeCx - 20);
        authorName = nameCands[0]?.text ?? null;
      }
      cards.push({ cover, likeButton: like ?? null, avatar, authorName });
    }
    return cards;
  }

  // 把 "1.2万" 风格计数转成数值，用于点赞前后 delta 判断
  static countValue(text) {
    if (!text) return null;
    const m = text.match(/^([\d.]+)([万千亿]?)$/u);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (m[2] === "万") v *= 1e4; else if (m[2] === "亿") v *= 1e8;
    return Math.round(v);
  }

  // 进详情：tap 封面中心，等待并确认进入 NoteDetail/DetailFeed。视频笔记(DetailFeed)自动播放会让
  // uiautomator "could not get idle state"，此处 tap 屏幕中心暂停视频（仅对 DetailFeed 触发，图笔记 NoteDetail 不动）。
  async openCard(card) {
    if (!card?.cover?.center) throw new Error("card cover not resolved");
    await this.tap(card.cover.center[0], card.cover.center[1]);
    await new Promise((r) => setTimeout(r, 900));
    const f = await this.currentFocus();
    const act = f.activity || "";
    const opened = act.includes("NoteDetail") || act.includes("DetailFeed");
    if (opened && act.includes("DetailFeed")) await this.pauseIfVideoNote();
    return { opened, activity: act };
  }

  // 暂停视频笔记的自动播放：tap 屏幕中心切换播放/暂停。若 tap 偏到别的 activity（理论上不会），BACK 回 NoteDetail。
  async pauseIfVideoNote() {
    await this.tap(540, 960);
    await new Promise((r) => setTimeout(r, 600));
    const f = await this.currentFocus();
    if (!/NoteDetail|DetailFeed/.test(f.activity || "")) {
      await this.session.exec("input keyevent KEYCODE_BACK", 6000);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { paused: true, activity: (await this.currentFocus()).activity };
  }

  // feed dump：feed 内联视频自动播放也会让 uiautomator 拿不到 idle。失败时小滚一次把视频移出视口再重试。
  async feedDump({ label, retries = 2 } = {}) {
    for (let i = 0; i <= retries; i++) {
      try {
        const d = await this.dump({ label, retries: 0 });
        const cards = this.feedCards(d);
        if (cards.length) return d;
        // dump 成功但没卡：滚一下再试
      } catch (e) { /* idle/incomplete，下面滚一下再试 */ }
      if (i < retries) {
        await this.session.exec("input swipe 540 1500 540 1100 300", 4000);
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    return this.dump({ label, retries: 1 });
  }

  // 返回 feed：BACK 直到回到 IndexActivityV2，最多 maxBack 次。
  async backToFeed(maxBack = 3) {
    for (let i = 0; i < maxBack; i += 1) {
      await this.session.exec("input keyevent KEYCODE_BACK", 5000);
      await new Promise((r) => setTimeout(r, 700));
      const f = await this.currentFocus();
      if ((f.activity || "").includes("IndexActivityV2")) return { back: i + 1, activity: f.activity };
    }
    return { back: maxBack, activity: (await this.currentFocus()).activity };
  }

  // 进作者主页。01 这版 xhs：feed 头像/名字 tap 都只开笔记，主页不是独立 activity，
  // 而是 NoteDetail 上的浮层（focus 仍 NoteDetail，但出现 profile 节点：clickable 头像
  // desc="头像,xxx" + 粉丝/获赞统计 + 关注/私信按钮 + 笔记网格）。
  // 流程：feed 卡片 → openCard 进笔记 → tap 详情头部作者头像 → 主页浮层。
  // 主页浮层信号：clickable ImageView + content-desc（浮层头像），y<600。
  async openProfile(card) {
    if (!card?.cover?.center) throw new Error("card cover not resolved");
    const opened = await this.openCard(card);
    if (!opened.opened) return { opened: false, activity: opened.activity, reason: "openCard failed" };
    const det = await this.dump({ label: "detail-for-profile" });
    // 详情头部作者头像：大 ImageView(>=120×120) click=0，x<250 y<300（back 按钮在 x~54 但 27×49 太小被排除）
    const av = det.nodes.find((n) =>
      n.className === "android.widget.ImageView" && !n.clickable && n.bounds
      && (n.bounds[2] - n.bounds[0]) >= 120 && (n.bounds[3] - n.bounds[1]) >= 120
      && centerOf(n.bounds)[0] < 250 && centerOf(n.bounds)[1] < 300);
    if (!av) return { opened: false, activity: (await this.currentFocus()).activity, reason: "no detail header avatar" };
    const [ax, ay] = centerOf(av.bounds);
    await this.tap(ax, ay);
    await new Promise((r) => setTimeout(r, 1300));
    const prof = await this.dump({ label: "profile-overlay" });
    const detected = prof.nodes.some((n) =>
      n.className === "android.widget.ImageView" && n.clickable && n.bounds && n.contentDesc
      && centerOf(n.bounds)[1] < 600);
    return { opened: detected, activity: (await this.currentFocus()).activity, authorName: card.authorName, tapped: [ax, ay] };
  }

  // 主页浮层笔记网格封面：大 ImageView click=0，宽 250-600、高 250-1000（排除内容容器 543x1964 那种过高 frame），y>800。
  // 点其中一张进该笔记（视频笔记会自动播放）。
  profileGridCovers(doc) {
    return doc.nodes.filter((n) =>
      n.className === "android.widget.ImageView" && !n.clickable && n.bounds
      && (n.bounds[2] - n.bounds[0]) >= 250 && (n.bounds[2] - n.bounds[0]) <= 600
      && (n.bounds[3] - n.bounds[1]) >= 250 && (n.bounds[3] - n.bounds[1]) <= 1000
      && centerOf(n.bounds)[1] > 800)
      .map((n) => ({ bounds: n.bounds, center: centerOf(n.bounds) }))
      .sort((a, b) => a.center[1] - b.center[1] || a.center[0] - b.center[0]);
  }

  // 主页滚屏：复用 scrollN（纯刷屏 N 次后 dump 一次）。主页浮层是 RecyclerView，swipe 通用。
  async scrollProfile(n = 1, label) { return this.scrollN({ n, down: true, label: label ?? `profile-scroll-${n}` }); }

  // 刷主页视频：tap 主页网格的某张封面 → 开该笔记。视频笔记(DetailFeedActivity)自动播放，
  // 图文笔记(NoteDetailActivity)仅展示。需先 openProfile 打开主页浮层。返回 {opened, isVideo, activity}。
  // 调用方按 isVideo 决定停留观看或跳过。点完用 backFromNote 回到主页浮层。
  async playProfileVideo(doc, idx = 0) {
    const grid = this.profileGridCovers(doc);
    const g = grid[idx];
    if (!g) return { opened: false, reason: "no grid cover at idx " + idx, gridCount: grid.length };
    await this.tap(g.center[0], g.center[1]);
    await new Promise((r) => setTimeout(r, 1500));
    const f = await this.currentFocus();
    const isVideo = /DetailFeedActivity/.test(f.activity || "");
    return { opened: true, isVideo, activity: f.activity, tapped: g.center, gridCount: grid.length };
  }

  // 从笔记返回主页浮层：1 次 BACK（笔记→主页浮层）。若想直接回 feed 用 backFromProfile。
  async backFromNote() {
    await this.session.exec("input keyevent KEYCODE_BACK", 5000);
    await new Promise((r) => setTimeout(r, 800));
    return { activity: (await this.currentFocus()).activity };
  }

  // 从主页返回 feed：BACK 直到 IndexActivityV2（主页浮层→笔记→feed，最多 maxBack 次）。
  async backFromProfile(maxBack = 4) { return this.backToFeed(maxBack); }

  // 不进正文点赞：tap feed 卡片的 like 按钮。返回 tapped 坐标。
  // 注意：这会在真实账号上对陌生人帖子产生一次点赞——调用方负责 like-then-unlike
  // 验收或运营意图授权。
  async likeCard(card) {
    if (!card?.likeButton?.center) throw new Error("card like-button not resolved");
    const [x, y] = card.likeButton.center;
    await this.tap(x, y);
    return { tapped: [x, y], countBefore: card.likeButton.countText };
  }

  // 详情页互动栏解析。两类笔记布局不同但规律一致：
  //   图文(NoteDetailActivity)：底部条 [评论框][点赞][收藏][分享]
  //   视频(DetailFeedActivity) ：分享在右上角；底部条 [评论框][点赞][收藏][评论]
  // 底部大图标(≥70×70)按 x 排序 → groups[0]=点赞, groups[1]=收藏, groups[2]=评论/分享。
  // 小图标(44×44 等)是 nav(返回/更多/搜索/音乐)，按尺寸过滤掉。
  // 图文笔记收藏未收藏时 label 显示"收藏"文字(非数字)，已收藏显示数字——可视锚点。
  // 注：dump 文本为 GBK 乱码，但不依赖文本字符串匹配，只靠位置+class+尺寸+是否数字。
  detailEngagementBar(doc) {
    const isVideo = doc.nodes.some((n) => /VideoSeekBar|TextureView|SurfaceView/i.test(n.className));
    const stripY = 2150;
    const inStrip = (b) => b && (b[1] + b[3]) / 2 > stripY;
    const icons = doc.nodes.filter((n) =>
      n.className === "android.widget.ImageView" && inStrip(n.bounds)
      && (n.bounds[2] - n.bounds[0]) >= 70 && (n.bounds[3] - n.bounds[1]) >= 70);
    const texts = doc.nodes.filter((n) =>
      n.className === "android.widget.TextView" && inStrip(n.bounds) && (n.text || n.contentDesc));
    // 计数判定：以数字开头且短（≤8 字符）。不依赖万/千/亿后缀——dump 文本经
    // GBK→UTF8 乱码后"万"会变"涓?"等，硬匹配后缀会漏。label（"收藏"/"说点什么"）
    // 以中文开头不匹配。大计数(如"10万")tap+1 仍显示"10万"，delta 验证不可用，
    // 但按钮解析靠位置不靠计数，tap 仍正确。
    const isCountText = (t) => !!t && /^\d/u.test(t) && t.length <= 8;
    const groups = [];
    for (const ic of icons) {
      const [ix, iy] = centerOf(ic.bounds);
      // 右侧相邻 TextView（计数或 label），同 y
      const txt = texts.find((t) => {
        const [tx, ty] = centerOf(t.bounds);
        return tx >= ix - 20 && tx - ix < 220 && Math.abs(ty - iy) < 60;
      });
      groups.push({
        icon: { bounds: ic.bounds, center: centerOf(ic.bounds) },
        label: txt?.text ?? null,
        labelCenter: txt ? centerOf(txt.bounds) : null,
        isNumeric: txt ? isCountText(txt.text) : false,
        countValue: txt ? FastOperator.countValue(txt.text) : null,
      });
    }
    groups.sort((a, b) => a.icon.center[0] - b.icon.center[0]);
    // 右上角分享（视频笔记）：y<300 的 clickable ImageView + content-desc 非空，
    // 取最右侧那个（返回/搜索/更多都在更左；desc 乱码无法串匹配，靠 max-x 定位）。
    let topShare = null;
    for (const n of doc.nodes) {
      if (n.className !== "android.widget.ImageView" || !n.clickable || !n.bounds || !n.contentDesc) continue;
      if ((n.bounds[1] + n.bounds[3]) / 2 >= 300) continue;
      const cx = (n.bounds[0] + n.bounds[2]) / 2;
      if (!topShare || cx > topShare.cx) topShare = { bounds: n.bounds, contentDesc: n.contentDesc, cx };
    }
    return {
      type: isVideo ? "video" : "image",
      groups,
      like: groups[0] ?? null,
      favorite: groups[1] ?? null,
      third: groups[2] ?? null,
      topShare: topShare ? { bounds: topShare.bounds, center: centerOf(topShare.bounds), desc: topShare.contentDesc } : null,
    };
  }

  // 详情页点赞：tap groups[0] 图标。countBefore 来自解析的计数（无计数返回 null）。
  async likeDetail(bar) {
    if (!bar?.like?.icon?.center) throw new Error("detail like button not resolved");
    const [x, y] = bar.like.icon.center;
    await this.tap(x, y);
    return { tapped: [x, y], countBefore: bar.like.countValue, labelBefore: bar.like.label };
  }

  // 详情页收藏：tap groups[1] 图标。labelBefore 用于判断收藏态（"收藏"=未收藏, 数字=已收藏）。
  async favoriteDetail(bar) {
    if (!bar?.favorite?.icon?.center) throw new Error("detail favorite button not resolved");
    const [x, y] = bar.favorite.icon.center;
    await this.tap(x, y);
    return { tapped: [x, y], countBefore: bar.favorite.countValue, labelBefore: bar.favorite.label, wasNumeric: bar.favorite.isNumeric };
  }

  // ===== Slice 2：评论自主 =====
  // 详情页底部评论入口框（content-desc="评论框"/"说点什么"占位）。UTF-8 desc 稳定锚点；
  // 退路：底部条(y>2150)最左 clickable TextView——但须排除商品/带货入口，见下。
  commentBox(doc) {
    const box = doc.nodes.find((n) =>
      n.className === "android.widget.TextView" && n.clickable && n.contentDesc
      && /评论框|说点什么|写评论/.test(n.contentDesc));
    if (box) return { center: centerOf(box.bounds), bounds: box.bounds, desc: box.contentDesc };
    // 退路：底部条最左 clickable TextView。DetailFeed 带货笔记底部条是商品入口
    // (识图搜同款/款式/图片/立即购买/加入购物车...)，误点会进商品页/加购=外发动作。
    // 排除这些商品/带货关键词，宁可返回 null(调用方跳过) 也不误点商品入口。
    const goodsRe = /识图搜同款|款式|图片|立即购买|加入购物车|逛逛|选品|同款|店铺|客服|咨询|领券|优惠券/;
    const stripY = 2150;
    const cands = doc.nodes.filter((n) =>
      n.className === "android.widget.TextView" && n.clickable && n.bounds
      && (n.bounds[1] + n.bounds[3]) / 2 > stripY
      && !goodsRe.test(n.text || "") && !goodsRe.test(n.contentDesc || ""))
      .sort((a, b) => centerOf(a.bounds)[0] - centerOf(b.bounds)[0]);
    const c = cands[0];
    return c ? { center: centerOf(c.bounds), bounds: c.bounds, desc: c.contentDesc || c.text } : null;
  }

  // 滚到评论区：图文笔记评论在内容下方。优化——先滚 1 屏再 dump（评论通常 1 滚即见），
  // 省掉"评论必不在顶部"时的首次空 dump（1-scroll 常见场景从 2 dump 降到 1 dump）。
  // 0-scroll 场景：评论本在视口，1 滚不致滚过短评论区，parseComments 仍能命中。
  async scrollToComments({ maxScrolls = 6, settleMs = 600 } = {}) {
    const w = 1080, h = 2400;
    const rawSwipe = () => this.session.exec(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.7)} ${Math.round(w / 2)} ${Math.round(h * 0.3)} 300`, 8000);
    await rawSwipe();
    this.metrics.scrolls += 1;
    await new Promise((r) => setTimeout(r, settleMs));
    let doc = await this.dump({ label: "comments-0" });
    if (this.parseComments(doc).length > 0) return { doc, scrolls: 1, found: true };
    for (let i = 1; i < maxScrolls; i += 1) {
      await rawSwipe();
      this.metrics.scrolls += 1;
      await new Promise((r) => setTimeout(r, settleMs));
      doc = await this.dump({ label: `comments-${i}` });
      if (this.parseComments(doc).length > 0) return { doc, scrolls: i + 1, found: true };
    }
    return { doc, scrolls: maxScrolls, found: this.parseComments(doc).length > 0 };
  }

  // 解析可见评论。这版 xhs 评论区不是 LinearLayout 容器，而是按行排列：
  //   每行 = 可点 username TextView(锚) + 下方非可点 text TextView + 右侧 likeCount TextView(空格=0赞)
  //   + 时间戳 TextView("…天前 … 回复") + 可选"作者"badge(同行右侧)。
  // 用几何锚定 username，按 y 偏移收 text/likeCount，不依赖 LinearLayout 子树。
  // isAuthor=同行右侧有 text/content-desc=="作者" 的 TextView（博主本人评论，必须过滤）。
  parseComments(doc) {
    const ns = doc.nodes;
    const isNum = (t) => !!t && /^[\d.]+[万千亿]?$/u.test(t) && /^\d/u.test(t) && t.length <= 8;
    const isMeta = (t) => !t
      || /^(回复|展开|关注|删除|作者|分享|收藏|点赞|说点什么)$/.test(t)
      || (/回复\s*$/.test(t) && t.length < 28)
      || /展开\s*\d+\s*条回复/.test(t)
      || /共\s*\d+\s*条评论/.test(t)
      || /快来评论|有话要说|有话却说/.test(t);
    // username 锚：可点 TextView，2-20 字，非数字非 meta，且不是评论框(content-desc 含"评论框/说点什么")
    const users = ns.filter((n) =>
      n.className === "android.widget.TextView" && n.clickable && n.bounds
      && !isMeta(n.text) && !isNum(n.text)
      && (n.text || "").length >= 2 && (n.text || "").length <= 20
      && !/评论框|说点什么|写评论/.test(n.contentDesc || ""));
    const items = [];
    for (const u of users) {
      const ub = u.bounds;
      const uy = (ub[1] + ub[3]) / 2;
      const uBottom = ub[3];
      // isAuthor：右侧同行有"作者"badge
      const isAuthor = ns.some((n) =>
        n.className === "android.widget.TextView" && n.bounds
        && (n.text === "作者" || n.contentDesc === "作者")
        && Math.abs(((n.bounds[1] + n.bounds[3]) / 2) - uy) < 70
        && n.bounds[0] > ub[2] - 40);
      // 评论正文：username 正下方非可点 TextView，左半区(x<600)、宽(右沿>500)、非时间戳非数字
      let text = null;
      for (const n of ns) {
        if (n.className !== "android.widget.TextView" || n.clickable || !n.bounds) continue;
        const b = n.bounds;
        const cy = (b[1] + b[3]) / 2;
        if (cy < uBottom - 5 || cy > uBottom + 120) continue;
        if (b[0] > 600) continue;
        const t = (n.text || "").trim();
        if (!t || isMeta(t)) continue;
        if (/^\d/.test(t) && t.length <= 8) continue; // 纯数字当点赞数，不当正文
        if (!text || t.length > text.length) text = t;
      }
      // 时间戳行：含"前"+结尾"回复"的非可点 TextView，y 在 username 下方 15-130，x<800。
      // 用它的 y 锚定 likeCount，避免误抓底部互动条(note 评论总数)。
      let tsCy = null;
      for (const n of ns) {
        if (n.className !== "android.widget.TextView" || n.clickable || !n.bounds) continue;
        const b = n.bounds;
        const cy = (b[1] + b[3]) / 2;
        if (cy < uBottom + 15 || cy > uBottom + 130) continue;
        if ((b[0] + b[2]) / 2 > 800) continue;
        const t = (n.text || "").trim();
        if (/前.*回复\s*$/.test(t)) { tsCy = cy; break; }
      }
      // 点赞数：右半区(x>880)、窄(宽≤80)、y 紧贴时间戳行(|cy-tsCy|<45)；
      // 无时间戳时回退 [uBottom+30,uBottom+130] 且 y<2230（避开底部互动条 y≈2256）
      let likeText = null;
      for (const n of ns) {
        if (n.className !== "android.widget.TextView" || n.clickable || !n.bounds) continue;
        const b = n.bounds;
        const cx = (b[0] + b[2]) / 2;
        const cy = (b[1] + b[3]) / 2;
        if (cx < 880 || (b[2] - b[0]) > 80) continue;
        if (tsCy != null) {
          if (Math.abs(cy - tsCy) > 45) continue;
        } else {
          if (cy < uBottom + 30 || cy > uBottom + 130 || cy > 2229) continue;
        }
        const t = (n.text || "").trim();
        if (!t) { if (likeText === null) likeText = "0"; continue; } // 空格 = 0 赞
        if (isNum(t)) likeText = t;
      }
      if (!text && likeText === null) continue; // 既无正文也无点赞数 → 不是评论行
      const likeCount = likeText != null ? (FastOperator.countValue(likeText) ?? (likeText === "0" ? 0 : null)) : null;
      items.push({
        username: u.text, text, likeText, likeCount,
        isAuthor, bounds: ub, center: centerOf(ub),
      });
    }
    return items;
  }

  // 选非作者评论里点赞最高的。空时回退 null（调用方用兜底文案）。
  topComment(comments) {
    const cands = comments.filter((c) => !c.isAuthor && c.likeCount != null && c.text);
    if (!cands.length) return null;
    return cands.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))[0];
  }

  // 评论输入编辑器（开"说点什么"后）：focused EditText。
  commentEditor(doc) {
    const ed = doc.nodes.find((n) => n.className === "android.widget.EditText" || n.focused);
    return ed ? { center: centerOf(ed.bounds), bounds: ed.bounds, text: ed.text } : null;
  }

  // 编辑器"发送"按钮：TextView text="发送" click=true。UTF-8 锚点。
  sendButton(doc) {
    const b = doc.nodes.find((n) =>
      n.className === "android.widget.TextView" && n.clickable && (n.text === "发送" || /发送|发\s*布/.test(n.text || "")));
    return b ? { center: centerOf(b.bounds), bounds: b.bounds, text: b.text } : null;
  }

  // xiaowei WS 网关单请求（ws://127.0.0.1:22222/）。一连接一请求，首条消息即响应；code===10000=SUCCESS。
  // xiaowei WS 网关单请求（ws://127.0.0.1:22222/）。一连接一请求，首条消息即响应；code===10000=SUCCESS。
  // 多设备并发时 4 路同时建 WS 会偶发 connection failed（xiaowei 单实例 accept 串行），
  // 故对连接失败/超时做最多 3 次重试（间隔 400ms），malformed 响应不重试（协议级错误）。
  async xiaoweiInvoke(action, data, timeoutMs = 12000) {
    const url = this.xwWs || "ws://127.0.0.1:22222/";
    const req = { action, devices: this.serial };
    if (data != null) req.data = data;
    // 多设备并发时 4 路同时建 WS 会偶发 connection failed（xiaowei 单实例 accept 串行）。
    // withXwLock 串行化建连（每次只 1 路连 22222）；对连接失败/超时做最多 3 次重试，
    // 锁外随机退避错开多进程；malformed 响应是协议级错误不重试。
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await withXwLock(() => new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          let settled = false;
          const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch {} fn(v); };
          const t = setTimeout(() => finish(reject, new Error(`xiaowei WS timeout (${timeoutMs}ms) action=${action}`)), timeoutMs);
          ws.addEventListener("open", () => { try { ws.send(JSON.stringify(req)); } catch (e) { finish(reject, e); } });
          ws.addEventListener("message", (e) => {
            let r; try { r = JSON.parse(String(e.data)); } catch { return finish(reject, new Error("xiaowei WS malformed response")); }
            finish(resolve, r);
          });
          ws.addEventListener("error", () => finish(reject, new Error(`xiaowei WS connection failed action=${action}`)));
        }));
      } catch (e) {
        lastErr = e;
        if (e.message.includes("malformed")) throw e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
      }
    }
    throw lastErr;
  }
  async currentIme() {
    const out = await this.session.exec("settings get secure default_input_method", 8000);
    return out.trim();
  }

  async setIme(ime) {
    const r = await this.xiaoweiInvoke("selectIme", { ime });
    if (r.code !== 10000) throw new Error(`selectIme failed: ${r.message || JSON.stringify(r)}`);
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if ((await this.currentIme()) === ime) return true;
    }
    return false;
  }

  // imeSticky 批后还原 IME 到原始（通常 SogouIME）。批处理结束必调，否则设备手动输入异常。
  async restoreImeToPrior() {
    const target = this._priorIme || "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
    const cur = await this.currentIme();
    if (cur === target) return { restored: true, already: true, ime: cur };
    const ok = await this.setIme(target);
    return { restored: ok, ime: await this.currentIme() };
  }

  // 经 xiaowei 网关输中文：selectIme→bridge → 有界清空(MOVE_END + DEL×48，编辑器空时可跳) → inputText。
  // deferRestore=true 时不立即还原 IME（还原会令编辑器失焦关闭），返回 restore() 让调用方在【发送之后】再还原。
  // clearFirst 默认 false：评论编辑器(图文/视频笔记均开 NoteCommentActivity 独立 activity，或底部 sheet)新开即空，
  // 无需清空。clearFirst 的 48x KEYCODE_DEL 在独立 NoteCommentActivity 的空 EditText 上会触发 dismiss(回上一屏)，
  // 导致 editorLostAfterInput——这是 xhs UI 改用独立 activity 后的回归点。底部 sheet 对 DEL 容忍但也不需要清。
  async inputTextViaXiaowei(text, { bridgeIme, priorIme, clearFirst = false, deferRestore = false } = {}) {
    bridgeIme = bridgeIme || this.xwBridgeIme || "com.android.xwkeyboard/.XwIME";
    priorIme = priorIme || (await this.currentIme());
    this._priorIme = priorIme; // 记原始 IME，供 imeSticky 批后 restoreImeToPrior() 还原
    const audit = { priorIme, bridgeIme, selected: false, cleared: false, inputAccepted: false, restored: false };
    const restore = async () => {
      try {
        if ((await this.currentIme()) !== priorIme) { await this.setIme(priorIme); audit.restored = true; }
        else audit.restored = true;
      } catch { audit.restoreError = true; }
      return audit;
    };
    try {
      if ((await this.currentIme()) !== bridgeIme) {
        if (!(await this.setIme(bridgeIme))) throw new Error("bridge IME select failed");
      }
      audit.selected = true;
      await new Promise((r) => setTimeout(r, 400));
      if (clearFirst) {
        await this.session.exec("input keyevent KEYCODE_MOVE_END " + Array(48).fill("KEYCODE_DEL").join(" "), 8000);
        await new Promise((r) => setTimeout(r, 150));
        audit.cleared = true;
      }
      const r = await this.xiaoweiInvoke("inputText", { content: String(text) });
      if (r.code !== 10000) throw new Error(`inputText failed: ${r.message || JSON.stringify(r)}`);
      audit.inputAccepted = true;
    } catch (e) {
      // 失败时立即还原（不留编辑器在 bridge IME）
      await restore();
      throw e;
    }
    if (deferRestore) return { audit, restore };
    await restore();
    return audit;
  }

  // 改写评论为非雷同自然变体。有 LLM endpoint 走 LLM，否则规则兜底（剥尾 emoji + 加一个温和 emoji）。
  async rewriteComment(text, { llmEndpoint, llmKey, llmModel } = {}) {
    const src = String(text || "").trim();
    if (!src) return src;
    const ep = llmEndpoint || this.llmEndpoint;
    const key = llmKey || this.llmKey;
    const model = llmModel || this.llmModel || "grok-4.20-0309-non-reasoning";
    if (ep && key) {
      try {
        const r = await httpPostJson(ep, {
          model, max_tokens: 120, temperature: 0.9,
          messages: [
            { role: "system", content: "你把用户给的评论改写成自然、不与原句雷同的变体，保持语义和语气，可加1个emoji，20-40字，只输出改写后的评论本身，不要引号不要解释。" },
            { role: "user", content: src },
          ],
        }, { Authorization: `Bearer ${key}` });
        const out = r?.choices?.[0]?.message?.content?.trim();
        if (out && out.length <= 80 && !/点赞|关注|私信|发布|删除|自动|批量/.test(out)) return out;
      } catch { /* 退规则 */ }
    }
    const emojis = ["[doge]", "[偷笑R]", "[笑哭R]", "[飞吻R]", "[害羞R]"];
    const cleaned = src.replace(/\[[^\]]+R?\]\s*$/, "").trim();
    return `${cleaned} ${emojis[cleaned.length % emojis.length]}`;
  }

  fallbackComment() {
    const pool = ["好内容，学到了[doge]", "这波操作可以", "看着就舒服[偷笑R]", "记录一下，太真实了", "会一直关注[飞吻R]"];
    return pool[(this.metrics.actions || 0) % pool.length];
  }

  // 笔记评论总数：扫 "共N条评论" 标题 TextView。无则回退到底部 engagement bar 最右 numeric 组
  // （评论计数；图文/视频笔记底部条都有 like/favorite/comment 计数，评论在最右）——覆盖
  // "共N条评论" header 滚出视口、大计数("10万+"舍入)等 beforeCount:null 导致 verified:false 的偶发场景。
  // 用作发送前 beforeCount / 发送后 afterCount 的 delta 实证校验来源。
  noteCommentCount(doc) {
    for (const n of doc.nodes) {
      const t = (n.text || "").trim();
      const m = t.match(/共\s*(\d+)\s*条评论/);
      if (m) return Number(m[1]);
    }
    return this.videoNoteCommentCount(doc);
  }

  // 发送后实证校验：评论数 +1 delta（主）→ 文案扫描（回退）→ 都做不到则明确未验证。
  // 调用前需仍在 NoteDetail（未回首页）。beforeCount 由 commentOnOpenNote 在发送前抓取。
  // 不撒谎：countDelta 不可验且文案没扫到时返回 verified:false，让调用方知道"疑似发出但未实证"。
  // mode: none=跳过实证(skipped)；light=1 scroll+1 dump 取 countDelta，不做 textScan 多滚；
  //       strict=当前完整（countDelta + textScan 回退）。默认 strict。
  async verifyCommentSent({ beforeCount, sentText, maxScrolls = 4, mode } = {}) {
    const m = mode || this.verifyMode || "strict";
    if (m === "none") return { verified: false, method: "skipped", beforeCount, afterCount: null };
    if (m === "light") {
      const sc = await this.scrollToComments({ maxScrolls: 1 });
      const afterCount = this.noteCommentCount(sc.doc);
      if (beforeCount != null && afterCount != null && afterCount - beforeCount >= 1)
        return { verified: true, method: "countDelta", beforeCount, afterCount, delta: afterCount - beforeCount };
      return { verified: false, method: "none", beforeCount, afterCount };
    }
    // strict
    const sc = await this.scrollToComments({ maxScrolls });
    const afterCount = this.noteCommentCount(sc.doc);
    if (beforeCount != null && afterCount != null && afterCount - beforeCount >= 1) {
      return { verified: true, method: "countDelta", beforeCount, afterCount, delta: afterCount - beforeCount };
    }
    // 大计数(如"10万+")delta 舍入为 0、或计数缺失 → 扫刚发的文案（新评论非作者、文本==sentText）
    if (sentText) {
      const comments = this.parseComments(sc.doc);
      const hit = comments.find((c) => !c.isAuthor && c.text
        && (c.text === sentText || c.text.includes(sentText) || sentText.includes(c.text)));
      if (hit) return { verified: true, method: "textScan", beforeCount, afterCount, matched: (hit.text || "").slice(0, 40) };
    }
    return { verified: false, method: "none", beforeCount, afterCount };
  }

  // 视频笔记(DetailFeed)评论入口：底部"说点什么..."占位 TextView（非 clickable、无 desc），
  // tap 它开 NoteCommentActivity 评论编辑器（EditText 已 focused + 发送 按钮）。
  // 与 commentBox 不同：视频笔记底部评论元素均非 clickable，靠 text 锚定而非 clickable/desc。
  // 带货笔记底部是商品入口（识图搜同款/款式...），goodsRe 排除，宁 null 不误点商品页（外发动作）。
  videoNoteCommentBox(doc) {
    const goodsRe = /识图搜同款|款式|图片|立即购买|加入购物车|逛逛|选品|同款|店铺|客服|咨询|领券|优惠券/;
    const stripY = 2200;
    const ph = doc.nodes.find((n) =>
      n.className === "android.widget.TextView" && n.bounds
      && (n.bounds[1] + n.bounds[3]) / 2 > stripY
      && /说点什么|写评论|有话要说|发条评论/.test(n.text || "")
      && !goodsRe.test(n.text || ""));
    if (ph) return { center: centerOf(ph.bounds), bounds: ph.bounds, desc: ph.text, via: "placeholder" };
    return null;
  }

  // 视频笔记(DetailFeed)底部 engagement bar 评论计数 = 最右带 numeric label 的图标组。
  // 顺序：点赞/收藏/评论，评论在最右；用 detailEngagementBar 的 groups，取最后一个 isNumeric。
  // icon 分组失败(dump 截断/overlay 隐藏导致 icon 节点缺失)时回退直扫底部条最右 numeric TextView。
  videoNoteCommentCount(doc) {
    const bar = this.detailEngagementBar(doc);
    const numeric = (bar.groups || []).filter((g) => g.isNumeric);
    if (numeric.length) return numeric[numeric.length - 1].countValue;
    // 回退：底部条(y>2150)最右纯数字 TextView（评论计数在最右）
    const stripY = 2150;
    const nums = (doc.nodes || [])
      .filter((n) => n.className === "android.widget.TextView" && n.bounds
        && (n.bounds[1] + n.bounds[3]) / 2 > stripY
        && FastOperator.countValue(n.text) != null)
      .sort((a, b) => centerOf(a.bounds)[0] - centerOf(b.bounds)[0]);
    return nums.length ? FastOperator.countValue(nums[nums.length - 1].text) : null;
  }

  // 视频笔记(DetailFeed)评论全流程：tap 底部"说点什么..." → NoteCommentActivity 编辑器
  // (EditText 已 focused + 发送) → 输入 → 发送 → 回 DetailFeed 读 countDelta 验证 → 回 feed。
  // 不需 scrollToComments / commentBox 狩猎：编辑器直接开、EditText 已聚焦，比图文笔记链路更短更快。
  // dryRun=true 时不点发送、BACK 丢弃，仅验证输入落地（zero-send 真机测试用）。
  // 调用方需保证视频已暂停（openCard 已 pauseIfVideoNote；HTTP 直驱由 case 补 pause）。
  async commentOnVideoNote({ text, log: logArg, t0: t0Arg, dryRun = false } = {}) {
    const t0 = t0Arg ?? Date.now();
    const log = logArg ?? [];
    const push = (k, v) => log.push([k, v]);
    // 0. 读底部评论计数（beforeCount，发送后 delta 验证用）。视频笔记 settle 期 dump 偶发不完整
    //（占位条/计数未渲染全），box/count 任一为 null 时带 settleMs 重 dump 一次再判。
    let d0 = await this.dump({ label: "video-bar" });
    let box = this.videoNoteCommentBox(d0);
    if (!box) {
      push("video-bar-incomplete", { nodes: (d0.nodes || []).length });
      d0 = await this.dump({ label: "video-bar-retry", settleMs: 700 });
      box = this.videoNoteCommentBox(d0);
    }
    const beforeCount = this.videoNoteCommentCount(d0);
    push("beforeCount", beforeCount);
    // 1. 找"说点什么..."入口并 tap → NoteCommentActivity
    push("videoNoteCommentBox", box ? { via: box.via, center: box.center } : null);
    if (!box) {
      return { ok: false, step: "detailfeedUnsupported", reason: "no comment placeholder (likely 带货/carousel note)", text, log, ms: Date.now() - t0, activity: "DetailFeed" };
    }
    await this.tap(box.center[0], box.center[1]);
    await new Promise((r) => setTimeout(r, this.paceFast ? 700 : 1200));
    const f = await this.currentFocus();
    push("openedEditor", f.activity);
    if (!/NoteComment|comment\.input/.test(f.activity || "")) {
      return { ok: false, step: "openEditor", text, log, ms: Date.now() - t0, activity: f.activity };
    }
    // 2. EditText 已 focused，直接输入（无 commentBox 狩猎、无 scrollToComments）
    let finalText = text;
    if (!finalText) {
      finalText = await this.rewriteComment(this.fallbackComment());
      push("rewriteComment", { to: finalText.slice(0, 30) });
    }
    // NoteCommentActivity 编辑器新开即空，clearFirst 的 48x DEL 在独立 activity 空 EditText 上会触发
    // dismiss（回 DetailFeed），故 clearFirst:false。NoteDetail 底部 sheet 不受影响仍用默认 true。
    const { audit, restore } = await this.inputTextViaXiaowei(finalText, { deferRestore: true, clearFirst: false });
    push("inputText", audit);
    if (!audit.inputAccepted) {
      if (!this.imeSticky) await restore();
      await this.backToFeed(3);
      return { ok: false, step: "inputText", text: finalText, log, ms: Date.now() - t0 };
    }
    // 3. dryRun：验证输入落地后 BACK 丢弃，不发送
    if (dryRun) {
      await new Promise((r) => setTimeout(r, 400));
      const fPre = await this.currentFocus();
      const ed = await this.dump({ label: "video-dryrun-verify" });
      const editor = this.commentEditor(ed);
      const edits = (ed.nodes || []).filter((n) => n.className === "android.widget.EditText");
      push("dryRunDiag", { focus: fPre.activity, nodeCount: (ed.nodes || []).length, editorCount: edits.length, edits: edits.map((n) => ({ text: (n.text || "").slice(0, 40), focus: !!n.focused, center: centerOf(n.bounds) })) });
      if (!this.imeSticky) await restore();
      await this.session.exec("input keyevent KEYCODE_BACK", 6000);
      await new Promise((r) => setTimeout(r, 600));
      await this.backToFeed(3);
      push("dryRunEditor", editor ? { text: (editor.text || "").slice(0, 30) } : null);
      return { ok: !!editor, step: editor ? "dryRunOk" : "editorLostAfterInput", text: finalText, log, ms: Date.now() - t0, activity: (await this.currentFocus()).activity };
    }
    // 4. 发送：确认编辑器在、点 发送
    const ed = await this.dump({ label: "video-editor-before-send" });
    if (!this.commentEditor(ed)) {
      if (!this.imeSticky) await restore();
      await this.backToFeed(3);
      return { ok: false, step: "editorLostAfterInput", text: finalText, log, ms: Date.now() - t0, focus: (await this.currentFocus()).activity };
    }
    const send = this.sendButton(ed);
    if (!send) {
      if (!this.imeSticky) await restore();
      await this.backToFeed(3);
      return { ok: false, step: "sendButton", text: finalText, log, ms: Date.now() - t0, focus: (await this.currentFocus()).activity };
    }
    await this.tap(send.center[0], send.center[1]);
    await new Promise((r) => setTimeout(r, 1200));
    if (!this.imeSticky) await restore();
    // 5. 发送后：回 DetailFeed 读评论计数 delta 验证
    const f2 = await this.currentFocus();
    const sent = !/comment\.input|NoteComment/.test(f2.activity || "");
    push("sent", { sent, activity: f2.activity });
    // 发送后通常自动回 DetailFeed；若仍在 NoteComment 则 BACK
    if (/NoteComment|comment\.input/.test(f2.activity || "")) {
      await this.session.exec("input keyevent KEYCODE_BACK", 6000);
      await new Promise((r) => setTimeout(r, 700));
    }
    const fd = await this.currentFocus();
    let afterCount = null;
    if (fd.activity && fd.activity.includes("DetailFeed")) {
      let dd = await this.dump({ label: "video-after-count", settleMs: 500 });
      afterCount = this.videoNoteCommentCount(dd);
      if (afterCount == null) {
        // 底部条可能尚未 settle，重 dump 一次
        dd = await this.dump({ label: "video-after-count-retry", settleMs: 700 });
        afterCount = this.videoNoteCommentCount(dd);
      }
    }
    push("afterCount", afterCount);
    const verified = beforeCount != null && afterCount != null && afterCount - beforeCount >= 1;
    push("verifyCountDelta", { verified, beforeCount, afterCount });
    // 6. 回 feed
    const back = await this.backToFeed(5);
    push("backToFeed", back);
    return {
      ok: sent,
      verified,
      verifyMethod: verified ? "countDelta" : "none",
      beforeCount,
      afterCount,
      imeSticky: this.imeSticky,
      verifyMode: this.verifyMode,
      text: finalText, log, ms: Date.now() - t0, metrics: this.metricsSummary(),
    };
  }

  // 评论全流程（对已打开的 NoteDetail）：滚到评论 → 取 top 非作者 → 改写 → 开编辑器 → 输入 → 发送 → 早退验证 → 回首页。
  // text 直传则跳过抓 top+改写。全程 pace 拟人限速（评论用更长间隔）。
  async commentOnOpenNote({ text, maxScrolls = 6, log: logArg, t0: t0Arg } = {}) {
    const t0 = t0Arg ?? Date.now();
    const log = logArg ?? [];
    const push = (k, v) => log.push([k, v]);
    // 0. 视频笔记(DetailFeed)走专用流程：tap 底部"说点什么..." → NoteCommentActivity 编辑器
    //    (EditText 已 focused + 发送 按钮) → 输入 → 发送 → countDelta 验证。
    //    Slice 3：视频笔记评论入口是底部"说点什么..."占位条(非 clickable，靠 text 锚定)，
    //    tap 开独立评论 activity，复用 commentEditor/sendButton 检测，无需 scrollToComments/commentBox 狩猎。
    //    带货笔记底部是商品入口(goodsRe 排除)，找不到占位条仍 fast-fail 跳过，不误点商品页。
    const preFocus = await this.currentFocus();
    if ((preFocus.activity || "").includes("DetailFeed")) {
      return this.commentOnVideoNote({ text, log, t0 });
    }
    // 1. 滚到评论区
    const sc = await this.scrollToComments({ maxScrolls });
    push("scrollToComments", { found: sc.found, scrolls: sc.scrolls });
    // 1b. 发送前评论总数（发送后 delta 实证校验用）。header 可能滚出视口，回滚一次再取。
    // 复用 dump：boxDoc 优先用 sc.doc；若回滚取 beforeCount，则用那次 count-before dump 兼作 box doc。
    let boxDoc = sc.doc;
    let beforeCount = this.noteCommentCount(sc.doc);
    if (beforeCount == null && sc.found) {
      await this.scrollUp(1, "count-rewind");
      boxDoc = await this.dump({ label: "count-before" });
      beforeCount = this.noteCommentCount(boxDoc);
    }
    push("beforeCount", beforeCount);
    let finalText = text;
    if (!finalText) {
      const comments = this.parseComments(sc.doc);
      const top = this.topComment(comments);
      push("topComment", top ? { username: top.username, likeCount: top.likeCount, isAuthor: top.isAuthor, text: (top.text || "").slice(0, 30) } : null);
      push("commentsParsed", comments.length);
      const base = top?.text || this.fallbackComment();
      finalText = await this.rewriteComment(base);
      push("rewriteComment", { from: base.slice(0, 20), to: finalText.slice(0, 30) });
    }
    await this.commentPace("preBox");
    // 2. 开编辑器（tap 评论框）。评论框在底部条，滚屏后仍在底部。复用 boxDoc 找框，找不到才补 dump（省 2.5s）。
    let box = this.commentBox(boxDoc);
    let boxReused = !!box;
    if (!box) { const det = await this.dump({ label: "before-comment-box" }); box = this.commentBox(det); }
    push("boxReused", boxReused);
    if (!box) return { ok: false, step: "commentBox", text: finalText, log, ms: Date.now() - t0, activity: (await this.currentFocus()).activity };
    await this.tap(box.center[0], box.center[1]);
    await new Promise((r) => setTimeout(r, this.paceFast ? 700 : 1500));
    push("openedEditor", (await this.currentFocus()).activity);
    // 3. 输入中文（经 xiaowei 网关，延迟还原 IME——还原会让编辑器失焦关闭，必须在发送之后）
    const { audit, restore } = await this.inputTextViaXiaowei(finalText, { deferRestore: true });
    push("inputText", audit);
    if (!audit.inputAccepted) { if (!this.imeSticky) await restore(); return { ok: false, step: "inputText", text: finalText, log, ms: Date.now() - t0 }; }
    await this.commentPace("postTap");
    // 4. 发送前守卫：编辑器必须在岗（EditText 存在）。若已失焦关闭 → editorLostAfterInput，
    //    区别于"编辑器在但找不到发送按钮"的 sendButton——这是 IME 还原时机坑的明确失败码。
    const ed = await this.dump({ label: "editor-before-send" });
    if (!this.commentEditor(ed)) {
      if (!this.imeSticky) await restore();
      return { ok: false, step: "editorLostAfterInput", text: finalText, log, ms: Date.now() - t0, focus: (await this.currentFocus()).activity };
    }
    const send = this.sendButton(ed);
    if (!send) { if (!this.imeSticky) await restore(); return { ok: false, step: "sendButton", text: finalText, log, ms: Date.now() - t0, focus: (await this.currentFocus()).activity }; }
    await this.tap(send.center[0], send.center[1]);
    await new Promise((r) => setTimeout(r, 1200));
    // 5. 还原 IME（发送完成，编辑器即将关闭，安全还原）。imeSticky 批处理时跳过，批后统一 restoreImeToPrior。
    if (!this.imeSticky) await restore();
    // 6. 早退验证：编辑器应关闭（focus 离开 comment.input；或回到 NoteDetail）
    const f = await this.currentFocus();
    const sent = !/comment\.input/.test(f.activity || "");
    push("sent", { sent, activity: f.activity });
    // 6b. 发送后实证校验：评论数 +1 delta / 文案扫描。仍在 NoteDetail，未回首页。verifyMode 分档。
    const verify = await this.verifyCommentSent({ beforeCount, sentText: finalText, maxScrolls: 4, mode: this.verifyMode });
    push("verifyCommentSent", verify);
    // 7. 回首页
    const back = await this.backToFeed(5);
    push("backToFeed", back);
    return {
      ok: sent,
      verified: verify.verified,
      verifyMethod: verify.method,
      beforeCount: verify.beforeCount,
      afterCount: verify.afterCount,
      imeSticky: this.imeSticky,
      verifyMode: this.verifyMode,
      text: finalText, log, ms: Date.now() - t0, metrics: this.metricsSummary(),
    };
  }

  // 评论 dry-run benchmark：openCard→scrollToComments→beforeCount→topComment→rewriteComment→
  // 开编辑器→inputText(deferRestore)→【量时到此，不 tap 发送】→还原/关编辑器→回首页。
  // 零 outward 评论，可反复跑 N 次量速度。返回每步 ms + beforeCount + topComment。
  async commentBenchmark({ maxScrolls = 6, log: logArg, t0: t0Arg } = {}) {
    const t0 = t0Arg ?? Date.now();
    const log = logArg ?? [];
    const push = (k, v) => log.push([k, v]);
    const steps = {};
    let s0 = Date.now();
    const sc = await this.scrollToComments({ maxScrolls });
    steps.scrollToComments = Date.now() - s0;
    push("scrollToComments", { found: sc.found, scrolls: sc.scrolls });
    let boxDoc = sc.doc;
    let beforeCount = this.noteCommentCount(sc.doc);
    if (beforeCount == null && sc.found) {
      await this.scrollUp(1, "cb-rewind");
      boxDoc = await this.dump({ label: "cb-count" });
      beforeCount = this.noteCommentCount(boxDoc);
    }
    push("beforeCount", beforeCount);
    const comments = this.parseComments(sc.doc);
    const top = this.topComment(comments);
    push("topComment", top ? { username: top.username, likeCount: top.likeCount, isAuthor: top.isAuthor, text: (top.text || "").slice(0, 30) } : null);
    s0 = Date.now();
    const base = top?.text || this.fallbackComment();
    const finalText = await this.rewriteComment(base);
    steps.rewriteComment = Date.now() - s0;
    push("rewriteComment", { from: base.slice(0, 16), to: finalText.slice(0, 24) });
    await this.commentPace("preBox");
    s0 = Date.now();
    // 复用 boxDoc 找评论框，找不到才补 dump。boxReused=true 时 commentBoxDump≈0（省 2.5s）。
    let box = this.commentBox(boxDoc);
    const boxReused = !!box;
    if (!box) box = this.commentBox(await this.dump({ label: "cb-before-box" }));
    steps.commentBoxDump = Date.now() - s0;
    push("boxReused", boxReused);
    if (!box) { await this.backToFeed(5); return { ok: false, step: "commentBox", steps, beforeCount, log, ms: Date.now() - t0 }; }
    await this.tap(box.center[0], box.center[1]);
    await new Promise((r) => setTimeout(r, this.paceFast ? 700 : 1500));
    push("openedEditor", (await this.currentFocus()).activity);
    s0 = Date.now();
    const { audit, restore } = await this.inputTextViaXiaowei(finalText, { deferRestore: true });
    steps.inputText = Date.now() - s0;
    push("inputText", audit);
    // 不发送：dry-run 量时到此。还原 IME（非 sticky）+ BACK 关编辑器（不触发发送）+ 回首页，零 outward 痕迹。
    if (!this.imeSticky) await restore();
    await this.session.exec("input keyevent KEYCODE_BACK", 6000);
    await new Promise((r) => setTimeout(r, this.paceFast ? 400 : 800));
    push("dryRunClosed", (await this.currentFocus()).activity);
    const back = await this.backToFeed(5);
    push("backToFeed", back);
    return {
      ok: true, dryRun: true, steps, beforeCount,
      topComment: top ? (top.text || "").slice(0, 30) : null,
      text: finalText, log, ms: Date.now() - t0, metrics: this.metricsSummary(),
    };
  }

  // 在【已打开的同一笔记】上原地循环 iters 次 dry-run：scrollToComments→(可选 rewrite)→开编辑器→input(deferRestore)→BACK 关编辑器。
  // 不 openCard、不 backToFeed，避开 feed 波动，隔离"单条机制成本"。skipRewrite=true 时不调 LLM，测无 LLM 地板。
  async noteBenchmark({ iters = 6, maxScrolls = 6, skipRewrite = false, log: logArg, t0: t0Arg } = {}) {
    const t0 = t0Arg ?? Date.now();
    const log = logArg ?? [];
    const push = (k, v) => log.push([k, v]);
    const runs = [];
    for (let i = 0; i < iters; i++) {
      const it = { i };
      let s0 = Date.now();
      const sc = await this.scrollToComments({ maxScrolls });
      it.scrollToComments = Date.now() - s0;
      it.scrolls = sc.scrolls;
      const comments = this.parseComments(sc.doc);
      const top = this.topComment(comments);
      it.topComment = top ? (top.text || "").slice(0, 24) : null;
      s0 = Date.now();
      const base = top?.text || this.fallbackComment();
      let finalText;
      if (skipRewrite) { finalText = this.templateComment(base); it.rewriteComment = 0; }
      else { finalText = await this.rewriteComment(base); it.rewriteComment = Date.now() - s0; }
      it.text = finalText.slice(0, 24);
      await this.commentPace("preBox");
      s0 = Date.now();
      // 复用 scrollToComments 的 sc.doc 找评论框，找不到才补 dump（省 2.5s/iter）。
      let box = this.commentBox(sc.doc);
      if (!box) box = this.commentBox(await this.dump({ label: "nb-before-box" }));
      it.commentBoxDump = Date.now() - s0;
      it.boxReused = !!this.commentBox(sc.doc);
      if (!box) { it.ok = false; it.step = "commentBox"; runs.push(it); await this.backToFeed(5); break; }
      await this.tap(box.center[0], box.center[1]);
      await new Promise((r) => setTimeout(r, this.paceFast ? 700 : 1500));
      s0 = Date.now();
      const { audit, restore } = await this.inputTextViaXiaowei(finalText, { deferRestore: true });
      it.inputText = Date.now() - s0;
      it.inputAccepted = audit?.inputAccepted;
      if (!this.imeSticky) await restore();
      await this.session.exec("input keyevent KEYCODE_BACK", 6000); // 关编辑器，留在 NoteDetail
      await new Promise((r) => setTimeout(r, this.paceFast ? 400 : 800));
      it.ok = true;
      runs.push(it);
    }
    // 收尾：还原 IME（非 sticky）+ 回首页
    if (!this.imeSticky) await this.restoreImeToPrior();
    await this.backToFeed(5);
    return {
      ok: true, iters, skipRewrite, runs, ms: Date.now() - t0, metrics: this.metricsSummary(),
    };
  }

  // 不调 LLM 的本地改写模板：给原评论文案做轻量变换，避免与原评论文案完全雷同（xhs 去重兜底）。
  templateComment(base) {
    const t = (base || "").trim();
    if (!t) return "说说我的看法～";
    const prefixes = ["感觉", "我觉得", "其实", "个人感觉", "话说"];
    const suffixes = ["～", "呀", "呢", "哈", ""];
    const p = prefixes[t.length % prefixes.length];
    const s = suffixes[(t.length * 3) % suffixes.length];
    // 去掉原结尾表情/标点再加轻前后缀
    const core = t.replace(/[~～!！。.]+$/u, "");
    return (p + core + s).slice(0, 40);
  }

  // 评论全流程（从 feed 开笔记起）：openCard → commentOnOpenNote。
  async commentTransaction(card, { text, idx = 0, maxScrolls = 6 } = {}) {
    const t0 = Date.now();
    const log = [];
    const push = (k, v) => log.push([k, v]);
    this.metrics.actions += 1;
    const opened = await this.openCard(card);
    push("openCard", opened);
    if (!opened.opened) return { ok: false, step: "openCard", log, ms: Date.now() - t0 };
    await this.commentPace("postOpen");
    return this.commentOnOpenNote({ text, maxScrolls, log, t0 });
  }

  metricsSummary() {
    const m = this.metrics;
    return {
      ...m,
      avgDumpMs: m.dumps ? Math.round(m.totalDumpMs / m.dumps) : 0,
      avgScrollMs: m.scrolls ? Math.round(m.totalScrollMs / m.scrolls) : 0,
    };
  }
}

// ---------- CLI / HTTP ----------

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function demoScroll(N) {
  const adb = arg("--adb");
  const serial = arg("--serial");
  if (!adb || !serial) throw new Error("usage: --adb <path> --serial <serial> demo-scroll <N>");
  const op = await new FastOperator({ adbPath: adb, serial }).start();
  const t0 = Date.now();
  console.log(JSON.stringify({ phase: "start", focus: await op.currentFocus() }));
  for (let i = 0; i < N; i += 1) {
    const ts = Date.now();
    const doc = await op.scrollDown(1, `card-${i}`);
    const cards = op.observeFeed(doc);
    console.log(JSON.stringify({ i, ms: Date.now() - ts, dumpMs: doc._dumpMs, likeButtons: cards.length }));
  }
  console.log(JSON.stringify({ phase: "done", totalMs: Date.now() - t0, perScrollMs: Math.round((Date.now() - t0) / N), metrics: op.metricsSummary() }));
  await op.close();
}

function applyCommentFlags(opP) {
  // Slice 2 评论自主配置（可选 flag；缺省走默认/兜底）
  return opP.then((op) => {
    op.xwWs = arg("--xw-ws", "ws://127.0.0.1:22222/");
    op.xwBridgeIme = arg("--xw-bridge-ime", "com.android.xwkeyboard/.XwIME");
    op.llmEndpoint = arg("--llm-endpoint", null);
    op.llmKey = arg("--llm-key", null);
    op.llmModel = arg("--llm-model", "grok-4.20-0309-non-reasoning"); // CPA 非 reasoning 快档(0.9s/0 reasoning)；gpt-4o-mini 在 CPA 不存在
    // Slice 2 优化 flags（默认关，保持原拟人/strict 校验行为）
    op.imeSticky = process.argv.includes("--ime-sticky");
    op.verifyMode = arg("--verify", "strict"); // none|light|strict
    op.paceFast = process.argv.includes("--pace-fast");
    if (process.argv.includes("--pace-fast")) op.pacer = new Pacer({ minMs: 400, maxMs: 800 });
    // --fast preset = ime-sticky + pace-fast + verify=light（一个开关组合）
    if (process.argv.includes("--fast")) {
      op.imeSticky = true;
      op.verifyMode = "light";
      op.paceFast = true;
      op.pacer = new Pacer({ minMs: 400, maxMs: 800 });
    }
    return op;
  });
}

function serve(port) {
  const adb = arg("--adb");
  const serial = arg("--serial");
  if (!adb || !serial) throw new Error("usage: --adb <path> --serial <serial> serve [--port N]");
  const opP = applyCommentFlags(new FastOperator({ adbPath: adb, serial }).start());
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end("405"); }
    let body = "";
    for await (const c of req) body += c;
    let q;
    try { q = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end("bad json"); }
    const op = await opP;
    try {
      let out;
      switch (q.action) {
        case "focus": out = await op.currentFocus(); break;
        case "dump": out = await op.dump({ label: q.label }); break;
        case "scrollDown": out = await op.scrollDown(q.n ?? 1, q.label); break;
        case "scrollUp": out = await op.scrollUp(q.n ?? 1, q.label); break;
        case "scrollN": out = await op.scrollN({ n: q.n ?? 1, down: q.down !== false, label: q.label }); break;
        case "tap": out = await op.tap(q.x, q.y); break;
        case "feedCards": { const d = await op.dump({ label: q.label }); out = { cards: op.feedCards(d), dumpMs: d._dumpMs }; break; }
        case "openCard": { const d = await op.dump({ label: "open" }); const cards = op.feedCards(d); const c = cards[q.idx ?? 0]; out = await op.openCard(c); break; }
        case "backToFeed": out = await op.backToFeed(q.maxBack ?? 3); break;
        case "likeCard": { const d = await op.dump({ label: "like" }); const cards = op.feedCards(d); const c = cards[q.idx ?? 0]; out = { resolved: !!c?.likeButton, card: c, tapped: c?.likeButton ? await op.likeCard(c) : null }; break; }
        case "detailBar": { const d = await op.dump({ label: "detailBar" }); out = { bar: op.detailEngagementBar(d), dumpMs: d._dumpMs }; break; }
        case "likeDetail": { const d = await op.dump({ label: "likeDetail" }); const bar = op.detailEngagementBar(d); out = { resolved: !!bar?.like?.icon?.center, bar, tapped: bar?.like?.icon?.center ? await op.likeDetail(bar) : null }; break; }
        case "favoriteDetail": { const d = await op.dump({ label: "favoriteDetail" }); const bar = op.detailEngagementBar(d); out = { resolved: !!bar?.favorite?.icon?.center, bar, tapped: bar?.favorite?.icon?.center ? await op.favoriteDetail(bar) : null }; break; }
        case "openProfile": { const d = await op.dump({ label: "openProfile" }); const cards = op.feedCards(d); const c = cards[q.idx ?? 0]; out = { resolved: !!c?.cover?.center, card: c, opened: c?.cover?.center ? await op.openProfile(c) : null }; break; }
        case "scrollProfile": out = await op.scrollProfile(q.n ?? 1, q.label); break;
        case "profileGrid": { const d = await op.dump({ label: "profileGrid" }); out = { covers: op.profileGridCovers(d), dumpMs: d._dumpMs }; break; }
        case "playProfileVideo": { const d = await op.dump({ label: "playProfileVideo" }); out = await op.playProfileVideo(d, q.idx ?? 0); break; }
        case "backFromNote": out = await op.backFromNote(); break;
        case "backFromProfile": out = await op.backFromProfile(q.maxBack ?? 4); break;
        case "openCommentSection": {
          const d = await op.dump({ label: "openCommentSection" });
          const cards = op.feedCards(d);
          const c = cards[q.idx ?? 0];
          if (!c?.cover?.center) { out = { ok: false, step: "noCard" }; break; }
          const opened = await op.openCard(c);
          const sc = await op.scrollToComments({ maxScrolls: q.maxScrolls ?? 6 });
          out = { opened, found: sc.found, scrolls: sc.scrolls, comments: op.parseComments(sc.doc) };
          break;
        }
        case "parseComments": {
          const d = await op.dump({ label: "parseComments" });
          const comments = op.parseComments(d);
          out = { comments, topNonAuthor: op.topComment(comments) };
          break;
        }
        case "rewriteComment": {
          out = { rewritten: await op.rewriteComment(q.text) };
          break;
        }
        case "commentBox": { const d = await op.dump({ label: "commentBox" }); out = { box: op.commentBox(d), editor: op.commentEditor(d), send: op.sendButton(d), dumpMs: d._dumpMs }; break; }
        case "inputTextDryRun": {
          // 零发送 dry-run：tap 评论框 → 输入 → 不按发送 → BACK 清掉，留零痕迹。
          const d0 = await op.dump({ label: "inputTextDryRun-open" });
          const box = op.commentBox(d0);
          if (!box) { out = { ok: false, step: "commentBox" }; break; }
          await op.tap(box.center[0], box.center[1]);
          await new Promise((r) => setTimeout(r, 1500));
          const audit = await op.inputTextViaXiaowei(q.text || "测试输入");
          // 验证编辑器有中文，再 BACK 清掉
          const d1 = await op.dump({ label: "inputTextDryRun-verify" });
          const ed = op.commentEditor(d1);
          await op.session.exec("input keyevent KEYCODE_BACK", 6000);
          await new Promise((r) => setTimeout(r, 600));
          out = { audit, editorText: ed?.text || null };
          break;
        }
        case "commentTransaction": {
          const d = await op.feedDump({ label: "commentTransaction-open" });
          const cards = op.feedCards(d);
          const c = cards[q.idx ?? 0];
          if (!c?.cover?.center) { out = { ok: false, step: "noCard" }; break; }
          out = await op.commentTransaction(c, { text: q.text, idx: q.idx ?? 0, maxScrolls: q.maxScrolls ?? 6 });
          break;
        }
        case "commentOnOpenNote": {
          // 对当前已打开的 NoteDetail/DetailFeed 跑评论流程（设备由人驱动到目标笔记时用）。
          // DetailFeed 走 Slice 3 视频笔记流程(commentOnVideoNote)；直驱时先 pauseIfVideoNote
          // (openCard→commentTransaction 路径已在 openCard 暂停，不经此 case，不会双 toggle)。
          const f = await op.currentFocus();
          if (!/NoteDetail|DetailFeed/.test(f.activity || "")) { out = { ok: false, step: "notOnNote", activity: f.activity }; break; }
          if ((f.activity || "").includes("DetailFeed")) await op.pauseIfVideoNote();
          out = await op.commentOnOpenNote({ text: q.text, maxScrolls: q.maxScrolls ?? 6 });
          break;
        }
        case "videoNoteDryRun": {
          // zero-send 真机测试：对当前 DetailFeed 视频笔记跑评论流程到 inputText，不点发送、BACK 丢弃。
          const f = await op.currentFocus();
          if (!/DetailFeed/.test(f.activity || "")) { out = { ok: false, step: "notOnVideoNote", activity: f.activity }; break; }
          await op.pauseIfVideoNote();
          out = await op.commentOnVideoNote({ text: q.text, dryRun: true });
          break;
        }
        case "commentBenchmark": {
          // dry-run 零发送 benchmark：从 feed 开卡→跑评论流程到 inputText→不发送→回首页。量每步 ms。
          const d = await op.feedDump({ label: "commentBenchmark-open" });
          const cards = op.feedCards(d);
          const c = cards[q.idx ?? 0];
          if (!c?.cover?.center) { out = { ok: false, step: "noCard" }; break; }
          op.metrics.actions += 1;
          const opened = await op.openCard(c);
          if (!opened.opened) { out = { ok: false, step: "openCard", opened }; break; }
          out = await op.commentBenchmark({ maxScrolls: q.maxScrolls ?? 6 });
          break;
        }
        case "restoreIme": out = await op.restoreImeToPrior(); break;
        case "noteBenchmark": {
          // 在同一笔记上原地循环 dry-run，避开 feed 波动。若不在 NoteDetail 则先 openCard 一次。视频笔记先暂停。
          let f = await op.currentFocus();
          if (!/NoteDetail|DetailFeed/.test(f.activity || "")) {
            const d = await op.feedDump({ label: "noteBenchmark-open" });
            const cards = op.feedCards(d);
            const c = cards[q.idx ?? 0];
            if (!c?.cover?.center) { out = { ok: false, step: "noCard", activity: f.activity }; break; }
            op.metrics.actions += 1;
            const opened = await op.openCard(c);
            if (!opened.opened) { out = { ok: false, step: "openCard", opened }; break; }
            f = await op.currentFocus();
          }
          if ((f.activity || "").includes("DetailFeed")) await op.pauseIfVideoNote();
          out = await op.noteBenchmark({
            iters: q.iters ?? 6, maxScrolls: q.maxScrolls ?? 6, skipRewrite: !!q.skipRewrite,
          });
          break;
        }
        case "metrics": out = op.metricsSummary(); break;
        default: res.writeHead(400); return res.end(JSON.stringify({ error: "unknown action" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: out, metrics: op.metricsSummary() }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message, metrics: op.metricsSummary() }));
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ phase: "serving", port, serial })));
}

const cmd = process.argv.find((a) => a === "serve" || a === "demo-scroll");
if (cmd === "serve") serve(Number(arg("--port", "17895")));
else if (cmd === "demo-scroll") demoScroll(Number(process.argv[process.argv.indexOf("demo-scroll") + 1] ?? 10));
else if (process.argv[1] && process.argv[1].endsWith("fast-operator.mjs")) {
  console.error("usage: fast-operator.mjs --adb <path> --serial <serial> (serve|demo-scroll <N>) [--port 17895]");
  process.exit(2);
}