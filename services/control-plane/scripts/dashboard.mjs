// xhs-device-agent 操作面板后端
// 原生 node:http,零依赖。聚合 4 个 fast-operator serve(17895-98)+ adb one-shot,
// spawn task-runner.mjs 子进程跑【任务队列】并实时捕获进度。绑 0.0.0.0 供 Tailscale Serve 反代。
//
// 路由:GET /  静态页 | GET /status 4 台聚合 | GET /tasks 任务列表
//       POST /task {serial, action:start|stop, queue|task, durationMin, cap}  POST /home {serial}
//
// 队列模型:每台一个 [(task,durationMin,cap), ...],依次跑。每项到点 SIGINT 优雅停
// (task-runner 当前圈跑完才退),再接下一项;队列空或用户停 → done。
// task-runner 不动:用大 --loops 安全上限 + dashboard 计时 SIGINT + 30s SIGKILL 兜底。
// durationMin=0 表示该项手动停(无到点)。
//
// 设计原则:不改 fast-operator.mjs / task-runner.mjs / 4 个 serve / task 模板(零侵入)。
// task-runner 跑批时与该 serial serve 各持一条持久 adb shell,故活跃任务期间跳过 focus/IME 轮询降扰。

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = __dirname; // dashboard.mjs 放 scripts/
const TASK_RUNNER = join(SCRIPTS, "task-runner.mjs");
const TASKS_DIR = join(SCRIPTS, "tasks");
const STATIC_DIR = join(SCRIPTS, "dashboard");
const LOGS_DIR = join(SCRIPTS, "logs");

// 同 4 个 serve 的硬编码路径
const ADB = "C:\\PROGRA~2\\xiaowei_android\\tools\\adb.exe";
const NODE = "D:\\Program Files\\Node\\node.exe";
const LLM_ENDPOINT = "http://100.84.194.46:8317/v1/chat/completions";
const LLM_KEY = "cliproxy-codexapp";
const LLM_MODEL = "grok-4.20-0309-non-reasoning";

// 安全上限:dashboard 计时 SIGINT 是主停法,这只是 SIGINT 失效时的兜底,正常远不会触达。
const LOOPS_SAFETY = 100000;
const KILL_GRACE_MS = 30000; // SIGINT 后 30s 仍不退则 SIGKILL 兜底

const PORT = Number(process.env.DASH_PORT || 17900);

const DEVICES = [
  { serial: "REPLACE_SERIAL_01", port: 17895 },
  { serial: "REPLACE_SERIAL_03", port: 17896 },
  { serial: "REPLACE_SERIAL_02", port: 17897 },
  { serial: "REPLACE_SERIAL_04", port: 17898 },
];

// serial -> 运行态记录
const running = new Map();

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ---- serve HTTP 调用 ----
async function serveCall(port, action, extra = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- adb one-shot ----
function adb(serial, args) {
  try {
    const r = spawnSync(ADB, ["-s", serial, ...args], { encoding: "utf8", timeout: 8000 });
    return (r.stdout || "").trim();
  } catch (e) {
    return "";
  }
}

function imeOf(serial) {
  const v = adb(serial, ["shell", "settings", "get", "secure", "default_input_method"]);
  return v || "unknown";
}

// 用自己 one-shot adb 取前台 activity(serve 的 focus 走持久 shell,实测会 10s 超时;one-shot 秒回更可靠)
function activityOf(serial) {
  const v = adb(serial, ["shell", "dumpsys window | grep -E mCurrentFocus"]);
  if (!v) return null;
  const lines = v.split("\n").map((s) => s.trim()).filter((s) => s.includes("mCurrentFocus=") && !s.includes("=null"));
  const last = lines[lines.length - 1] || "";
  const m = last.match(/mCurrentFocus=Window\{[^}]*\s+([\w.]+)\/([\w.$]+)\}/);
  return m ? `${m[1]}/${m[2]}` : (last || null);
}

// 回首页:force-stop 清任务栈再重启,保证从 xhs 深处(NoteDetail 等)也重置到 IndexActivityV2。
// 单纯 monkey -c LAUNCHER 对已在 xhs 深处的 app 只会把现有任务栈拉前台,不重置到首页。
function launchXhs(serial) {
  adb(serial, ["shell", "am", "force-stop", "com.xingin.xhs"]);
  const v = adb(serial, ["shell", "monkey", "-p", "com.xingin.xhs", "-c", "android.intent.category.LAUNCHER", "1"]);
  return /Events injected/i.test(v) ? "ok" : v.slice(-120);
}

// ---- 任务队列子进程 ----
// 队列项归一:{task, durationMin, cap}
function normItem(x) {
  const task = String(x.task || "").trim();
  const durationMin = Math.max(0, Number(x.durationMin) || 0);
  const cap = Math.max(0, Number(x.cap ?? x.commentCap ?? 0));
  return { task, durationMin, cap };
}

function startQueue(serial, queueRaw) {
  const prev = running.get(serial);
  if (prev && prev.child) killRec(prev);
  const queue = queueRaw.map(normItem).filter((q) => q.task);
  if (!queue.length) throw new Error("empty queue");
  // 校验 task 文件存在
  for (const q of queue) {
    if (!existsSync(join(TASKS_DIR, q.task + ".json"))) throw new Error("task not found: " + q.task);
  }
  const rec = {
    queue,
    idx: 0,
    child: null,
    itemStartedAt: null,
    timer: null,
    killTimer: null,
    stopRequested: false,
    // 队列累计
    ok: 0, skip: 0, comments: 0, loopsDone: 0,
    // 当前项实时
    loop: 0,
    phase: "start",
    lastErr: null,
    startedAt: Date.now(),
    endedAt: null, exitCode: null,
  };
  running.set(serial, rec);
  log("startQueue", serial, queue.length, "items:", queue.map((q) => q.task + "@" + q.durationMin + "m").join(" → "));
  runItem(serial, rec, 0);
  return rec;
}

function runItem(serial, rec, idx) {
  if (rec.stopRequested) return finishRec(rec);
  if (idx >= rec.queue.length) return finishRec(rec);
  const item = rec.queue[idx];
  rec.idx = idx;
  rec.loop = 0;
  const args = [
    TASK_RUNNER, "--adb", ADB, "--serial", serial,
    "--task", join(TASKS_DIR, item.task + ".json"),
    "--loops", String(LOOPS_SAFETY),
    "--comment-cap", String(item.cap),
    "--llm-endpoint", LLM_ENDPOINT, "--llm-key", LLM_KEY, "--llm-model", LLM_MODEL,
  ];
  const child = spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
  rec.child = child;
  rec.itemStartedAt = Date.now();
  rec.phase = "running";
  log("startItem", serial, (idx + 1) + "/" + rec.queue.length, item.task, item.durationMin + "min", "cap", item.cap, "pid", child.pid);

  // 到点优雅停(SIGINT,task-runner 当前圈跑完才退)
  if (item.durationMin > 0) {
    rec.timer = setTimeout(() => {
      log("itemTimeUp", serial, idx, item.task, item.durationMin + "min 到点 → SIGINT");
      stopChild(rec);
    }, item.durationMin * 60000);
  }

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(rec, line);
    }
  });
  let ebuf = "";
  child.stderr.on("data", (d) => { ebuf += d.toString(); });
  child.on("exit", (code) => {
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.killTimer) { clearTimeout(rec.killTimer); rec.killTimer = null; }
    log("itemExit", serial, idx, item.task, "code", code, "loops", rec.loopsDone, "ok", rec.ok, "skip", rec.skip, "comments", rec.comments);
    rec.child = null;
    if (ebuf.trim()) log("itemStderr", serial, ebuf.trim().slice(-500));
    if (rec.stopRequested) return finishRec(rec, code);
    if (idx + 1 < rec.queue.length) runItem(serial, rec, idx + 1);
    else finishRec(rec, code);
  });
}

function stopChild(rec) {
  if (!rec.child) return;
  rec.phase = "stopping";
  try { rec.child.kill("SIGINT"); } catch {}
  // SIGINT 30s 仍不退则 SIGKILL 兜底(防止某圈卡死)
  rec.killTimer = setTimeout(() => {
    if (rec.child) { try { rec.child.kill("SIGKILL"); } catch {} }
  }, KILL_GRACE_MS);
}

function killRec(rec) {
  // 异常清理(进程退出/被新队列顶替):立即停,不等当前圈
  if (rec.timer) clearTimeout(rec.timer);
  if (rec.killTimer) { clearTimeout(rec.killTimer); rec.killTimer = null; }
  rec.stopRequested = true;
  if (rec.child) { try { rec.child.kill("SIGKILL"); } catch {} }
}

function finishRec(rec, code) {
  rec.phase = "done";
  rec.endedAt = Date.now();
  if (code != null) rec.exitCode = code;
  log("queueDone", "loops", rec.loopsDone, "ok", rec.ok, "skip", rec.skip, "comments", rec.comments);
}

function handleLine(rec, line) {
  let j;
  try { j = JSON.parse(line); } catch { return; } // 非 JSON 行忽略
  if (j.phase === "loopDone") {
    rec.loop = j.loop ?? rec.loop;
    rec.loopsDone = (rec.loopsDone || 0) + 1;
    rec.ok += Number(j.ok) || 0;
    rec.skip += Number(j.skip) || 0;
    rec.comments += Number(j.comments) || 0;
    rec.phase = "running";
  } else if (j.phase === "done" || j.phase === "summary") {
    if (typeof j.okSteps === "number") rec.ok = j.okSteps;
    if (typeof j.skipSteps === "number") rec.skip = j.skipSteps;
    if (typeof j.comments === "number") rec.comments = j.comments;
    if (j.errSteps) rec.lastErr = `errSteps=${j.errSteps}`;
  } else if (j.phase === "start" || j.phase === "ensureOnFeed") {
    rec.phase = j.phase;
  }
  if (j.error || j.err) rec.lastErr = String(j.error || j.err).slice(-200);
}

function stopTask(serial) {
  const rec = running.get(serial);
  if (!rec || !rec.child) return { stopped: false, reason: "not running" };
  rec.stopRequested = true;
  stopChild(rec);
  log("stopQueue", serial, "idx", rec.idx, "remaining", rec.queue.length - rec.idx);
  return { stopped: true, pid: rec.child.pid, remainingItems: rec.queue.length - rec.idx };
}

// ---- /status 聚合 ----
async function buildStatus() {
  const out = [];
  for (const d of DEVICES) {
    const rec = running.get(d.serial);
    const isRunning = rec && rec.child && rec.phase !== "done";
    const st = { serial: d.serial, port: d.port, running: !!isRunning, task: null, queue: null };
    if (isRunning) {
      const item = rec.queue[rec.idx];
      const elapsed = Date.now() - rec.itemStartedAt;
      const remaining = item && item.durationMin > 0 ? Math.max(0, item.durationMin * 60000 - elapsed) : null;
      st.task = {
        name: item ? item.task : null,
        idx: rec.idx + 1, total: rec.queue.length,
        durationMin: item ? item.durationMin : 0,
        elapsedMs: elapsed, remainingMs: remaining,
        loop: rec.loopsDone, phase: rec.phase,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        startedAt: rec.startedAt, lastErr: rec.lastErr,
      };
      st.queue = rec.queue.map((q) => ({ task: q.task, durationMin: q.durationMin, cap: q.cap }));
      const m = await serveCall(d.port, "metrics");
      st.serve = m.ok ? "ok" : "down";
      st.activity = "(running task)";
      st.ime = null;
    } else {
      const metrics = await serveCall(d.port, "metrics"); // metrics 进程内计数,无 adb,即存活探针
      st.serve = metrics.ok ? "ok" : "down";
      st.activity = activityOf(d.serial); // one-shot adb,不走 serve 持久 shell
      st.ime = imeOf(d.serial);
      st.metrics = metrics.ok ? metrics.result : null;
      if (rec) st.lastTask = {
        queue: rec.queue.map((q) => ({ task: q.task, durationMin: q.durationMin })),
        idx: rec.idx, total: rec.queue.length, loopsDone: rec.loopsDone,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        exitCode: rec.exitCode, lastErr: rec.lastErr, endedAt: rec.endedAt,
      };
    }
    out.push(st);
  }
  return { devices: out, ts: Date.now() };
}

// ---- 任务列表 ----
function listTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((f) => extname(f) === ".json")
    .map((f) => f.slice(0, -5));
}

// ---- HTTP 路由 ----
async function readBody(req) {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { res(b ? JSON.parse(b) : {}); } catch { res({}); }
    });
  });
}

function send(res, code, obj, type = "application/json") {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  if (Buffer.isBuffer(obj)) return res.end(obj);
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") {
    try {
      const html = await readFile(join(STATIC_DIR, "index.html"));
      return send(res, 200, html, "text/html");
    } catch {
      return send(res, 404, { error: "index.html not found" });
    }
  }
  if (req.method === "GET" && path === "/status") {
    return send(res, 200, await buildStatus());
  }
  if (req.method === "GET" && path === "/tasks") {
    return send(res, 200, { tasks: listTasks() });
  }
  if (req.method === "POST" && path === "/home") {
    const b = await readBody(req);
    const d = DEVICES.find((x) => x.serial === b.serial);
    if (!d) return send(res, 400, { error: "bad serial" });
    return send(res, 200, { serial: b.serial, result: launchXhs(b.serial) });
  }
  if (req.method === "POST" && path === "/task") {
    const b = await readBody(req);
    const d = DEVICES.find((x) => x.serial === b.serial);
    if (!d) return send(res, 400, { error: "bad serial" });
    if (b.action === "stop") return send(res, 200, stopTask(b.serial));
    if (b.action === "start") {
      try {
        let queue;
        if (Array.isArray(b.queue) && b.queue.length) queue = b.queue;
        else if (b.task) queue = [{ task: b.task, durationMin: Number(b.durationMin ?? b.minutes) || 0, cap: b.cap ?? b.commentCap ?? 0 }];
        else return send(res, 400, { error: "no queue/task" });
        const rec = startQueue(b.serial, queue);
        return send(res, 200, { ok: true, pid: rec.child ? rec.child.pid : null, items: rec.queue.length });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    return send(res, 400, { error: "bad action" });
  }
  send(res, 404, { error: "not found", path });
});

server.listen(PORT, "0.0.0.0", () => log("dashboard serving on 0.0.0.0:" + PORT));

// dashboard 退出时强杀所有运行中的任务子进程,避免手机上无人值守继续跑
function cleanup() {
  for (const [s, rec] of running) killRec(rec);
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

export { DEVICES, startQueue, stopTask };