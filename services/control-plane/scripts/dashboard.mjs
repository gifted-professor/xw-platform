// xhs-device-agent 操作面板后端
// 原生 node:http,零依赖。聚合 4 个 fast-operator serve(17895-98)+ adb one-shot,
// spawn task-runner.mjs 子进程跑预设任务并实时捕获进度。绑 0.0.0.0 供 Tailscale Serve 反代。
//
// 路由:GET /  静态页 | GET /status 4 台聚合 | GET /tasks 任务列表
//       POST /task {serial,task,loops?,commentCap?,action}  POST /home {serial}
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

// ---- 任务子进程 ----
function startTask(serial, taskName, loops, cap) {
  const prev = running.get(serial);
  if (prev && prev.child) { try { prev.child.kill("SIGINT"); } catch {} }
  const taskFile = join(TASKS_DIR, taskName + ".json");
  if (!existsSync(taskFile)) throw new Error("task not found: " + taskName);
  const args = [TASK_RUNNER, "--adb", ADB, "--serial", serial, "--task", taskFile];
  if (loops) args.push("--loops", String(loops));
  if (cap) args.push("--comment-cap", String(cap));
  args.push("--llm-endpoint", LLM_ENDPOINT, "--llm-key", LLM_KEY, "--llm-model", LLM_MODEL);
  const child = spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
  const rec = {
    child, task: taskName, loops: loops || null, cap: cap || null,
    startedAt: Date.now(), loop: 0, loopsDone: 0, ok: 0, skip: 0, comments: 0,
    lastErr: null, phase: "start", exitCode: null,
  };
  running.set(serial, rec);
  log("startTask", serial, taskName, "loops", loops, "cap", cap, "pid", child.pid);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(serial, rec, line);
    }
  });
  let ebuf = "";
  child.stderr.on("data", (d) => { ebuf += d.toString(); });
  child.on("exit", (code) => {
    rec.phase = "done";
    rec.exitCode = code;
    rec.endedAt = Date.now();
    log("task exit", serial, taskName, "code", code, "loopsDone", rec.loopsDone, "ok", rec.ok, "skip", rec.skip, "comments", rec.comments);
    if (ebuf.trim()) log("task stderr", serial, ebuf.trim().slice(-500));
  });
  return rec;
}

function handleLine(serial, rec, line) {
  let j;
  try { j = JSON.parse(line); } catch { return; } // 非 JSON 行忽略
  if (j.phase === "loopDone") {
    rec.loop = j.loop ?? rec.loop;
    rec.loopsDone = (rec.loopsDone || 0) + 1;
    // loopDone 里 ok/skip/comments 是当圈计数,累加
    rec.ok += Number(j.ok) || 0;
    rec.skip += Number(j.skip) || 0;
    rec.comments += Number(j.comments) || 0;
    rec.phase = "running";
  } else if (j.phase === "done" || j.phase === "summary") {
    // 末尾 summary 若带累计,覆盖(更准)
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
  try { rec.child.kill("SIGINT"); } catch {}
  rec.phase = "stopping";
  return { stopped: true, pid: rec.child.pid };
}

// ---- /status 聚合 ----
async function buildStatus() {
  const out = [];
  for (const d of DEVICES) {
    const rec = running.get(serialKey(d.serial));
    const isRunning = rec && rec.child && rec.phase !== "done";
    const st = { serial: d.serial, port: d.port, running: !!isRunning, task: null, progress: null };
    if (isRunning) {
      // 跑批期间跳过 focus/IME 降扰(避免与持久 shell 抢 adb),只回任务进度
      st.task = {
        name: rec.task, loops: rec.loops, cap: rec.cap,
        loop: rec.loopsDone, phase: rec.phase,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        startedAt: rec.startedAt, lastErr: rec.lastErr,
      };
      // serve 健康仍探(metrics 轻量)
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
      // 末次任务结果(已结束)
      if (rec) st.lastTask = {
        name: rec.task, loops: rec.loops, loop: rec.loopsDone,
        ok: rec.ok, skip: rec.skip, comments: rec.comments,
        exitCode: rec.exitCode, lastErr: rec.lastErr, endedAt: rec.endedAt,
      };
    }
    out.push(st);
  }
  return { devices: out, ts: Date.now() };
}

// 便利:Map key 用 serial
function serialKey(serial) { return serial; }

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
        const rec = startTask(b.serial, b.task, Number(b.loops) || null, Number(b.commentCap) || null);
        return send(res, 200, { ok: true, pid: rec.child.pid, task: rec.task });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    return send(res, 400, { error: "bad action" });
  }
  send(res, 404, { error: "not found", path });
});

server.listen(PORT, "0.0.0.0", () => log("dashboard serving on 0.0.0.0:" + PORT));

// dashboard 退出时杀掉所有运行中的任务子进程,避免手机上无人值守继续跑
function cleanup() {
  for (const [s, rec] of running) {
    if (rec.child) { try { rec.child.kill("SIGINT"); } catch {} }
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

export { DEVICES, startTask, stopTask };