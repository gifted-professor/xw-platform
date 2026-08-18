// Windows helper: Xiaowei ws://127.0.0.1:22222 原子动作
//   单发：node _win-xiaowei.mjs --serial <id> --action tap|shell|dump|focus|start|inputText [--x --y --cmd --out --package --activity --force-stop --text-b64 --text --refocus-x --refocus-y --clear-first --enter --defer-restore]
//   常驻：node _win-xiaowei.mjs --serial <id> --action repl
//        stdin 按行读 JSON 命令 {op, ...}，stdout 按行回 JSON 结果。
//        一条 ssh channel + 一个 node 进程常驻，一串动作复用，单动作延迟从 ~1.2s 降到 ~0.2s。
import { writeFileSync, mkdirSync, appendFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import {
  assertExplorerSessionIdentity,
  explorerSessionIdentity,
  verifyExplorerSession,
} from "./_explore-lease.mjs";

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";

const serial = opt("--serial");
const action = opt("--action");
const traceAlias = opt("--alias", null); // 调用方注入：设备 01-04
const traceTag = opt("--tag", null);     // 调用方注入：脚本名，如 xhs-like-one
const sessionFile = opt("--session-file", null);
let pinnedExplorerIdentity = null;
if (!serial || !action) {
  console.log(JSON.stringify({ ok: false, error: "need --serial and --action" }));
  process.exit(2);
}
if (!sessionFile) {
  console.log(JSON.stringify({ ok: false, error: "CONTROL_LEASE_REQUIRED: --session-file is required" }));
  process.exit(2);
}
async function assertActiveExplorerLease() {
  const authorization = await verifyExplorerSession({ contextPath: sessionFile, alias: traceAlias });
  if (authorization.serial !== serial) {
    throw Object.assign(new Error("EXPLORER_SESSION_SERIAL_MISMATCH"), { code: "EXPLORER_SESSION_SERIAL_MISMATCH" });
  }
  const currentIdentity = explorerSessionIdentity(authorization);
  if (pinnedExplorerIdentity === null) {
    pinnedExplorerIdentity = currentIdentity;
  } else assertExplorerSessionIdentity(pinnedExplorerIdentity, authorization);
  return authorization;
}
try {
  await assertActiveExplorerLease();
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: `${error.code || "CONTROL_LEASE_REQUIRED"}: ${error.message}` }));
  process.exit(2);
}

// ---- trace：被动记录每个设备动作，best-effort，绝不抛 ----
const TRACE_DIR = "C:/Users/Public/xhs-agent-runs/ops-trace";
const CONTEXT_DIR = join(TRACE_DIR, "context");
let lastSuccessfulDumpPath = null;

function traceRecord(op, ok, req, res, startMs) {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      serial,
      alias: traceAlias || null,
      tag: traceTag || null,
      pid: process.pid,
      op,
      ok: !!ok,
      durationMs: Math.max(0, Date.now() - startMs),
      req: scrubReq(op, req),
      error: ok ? undefined : ((res && (res.error || res.message)) ? String(res.error || res.message).slice(0, 500) : String(res || "").slice(0, 500)),
    }) + "\n";
    appendFileSync(join(TRACE_DIR, `${date}.jsonl`), line, "utf8");
  } catch { /* trace 是尽力而为，绝不炸主流程 */ }
}

function scrubReq(op, req) {
  if (!req) return undefined;
  const r = { ...req };
  // 脱敏：不落 base64 原文
  delete r.textB64;
  delete r.cmdB64;
  if (op === "inputText") {
    r.textPreview = String(r.text || "").slice(0, 30);
    delete r.text;
  }
  return r;
}

function saveFailureContext(req, errorText) {
  try {
    mkdirSync(CONTEXT_DIR, { recursive: true });
    const ts = Date.now();
    const prefix = join(CONTEXT_DIR, `fail-${serial}-${ts}`);
    // copy session 内最后成功的 dump（无则只写 error.json，不伪造）
    if (lastSuccessfulDumpPath && existsSync(lastSuccessfulDumpPath)) {
      copyFileSync(lastSuccessfulDumpPath, `${prefix}-dump.xml`);
    }
    writeFileSync(`${prefix}-error.json`, JSON.stringify({
      ts: new Date().toISOString(),
      serial,
      alias: traceAlias,
      tag: traceTag,
      failedOp: req && req.op,
      error: String(errorText || "").slice(0, 500),
      lastDumpPath: lastSuccessfulDumpPath,
    }, null, 2), "utf8");
  } catch { /* best-effort */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function xwInvoke(payload, timeoutMs = 25000) {
  // Revalidate immediately before every raw transport request, not only once per
  // high-level REPL dispatch. This narrows expiry/release windows for multi-step ops.
  await assertActiveExplorerLease();
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") throw new Error("WebSocket unavailable");
  return new Promise((resolve, reject) => {
    const ws = new WS("ws://127.0.0.1:22222/");
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error(`xiaowei timeout ${timeoutMs}ms action=${payload.action}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });
    ws.addEventListener("message", (ev) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(String(ev.data)));
      } catch (e) {
        reject(e);
      }
      try { ws.close(); } catch { /* */ }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(e.error || e);
    });
  });
}

async function adbShell(serial, command, timeoutMs = 20000) {
  const r = await xwInvoke({ action: "adb_shell", devices: serial, data: { command: String(command) } }, timeoutMs);
  if (r.code !== 10000) {
    throw new Error(`adb_shell failed code=${r.code} ${r.message || JSON.stringify(r).slice(0, 200)}`);
  }
  const data = r.data;
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    if (data[serial] != null) return String(data[serial]);
    const vals = Object.values(data);
    if (vals.length === 1) return String(vals[0] ?? "");
  }
  return String(data);
}

function parseFocus(raw) {
  const s = String(raw || "");
  const m = s.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/(\S+)/);
  if (m) return { package: m[1], activity: m[2].replace(/[\}\s].*$/, ""), raw: s.slice(0, 300) };
  const m2 = s.match(/mCurrentFocus=([^\n]+)/);
  return { package: null, activity: null, raw: (m2 ? m2[1] : s).slice(0, 300) };
}

// ---- 动作处理（提函数，repl 与单发共用）----

async function doShell(serial, p) {
  let cmd = p.cmd;
  if (p.cmdB64) cmd = Buffer.from(String(p.cmdB64), "base64").toString("utf8");
  if (!cmd) throw new Error("shell needs cmd or cmdB64");
  const stdout = await adbShell(serial, cmd);
  return { ok: true, action: "shell", stdout: String(stdout).slice(0, 50000) };
}

async function doTap(serial, p) {
  const x = Math.round(Number(p.x));
  const y = Math.round(Number(p.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("tap needs numeric x y");
  await adbShell(serial, `input tap ${x} ${y}`, 10000);
  return { ok: true, action: "tap", x, y };
}

async function doFocus(serial) {
  const raw = await adbShell(
    serial,
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity' | head -1",
    15000,
  );
  return { ok: true, action: "focus", ...parseFocus(raw) };
}

async function doDump(serial, p) {
  const out = p.out;
  if (!out) throw new Error("dump needs out path");
  mkdirSync(dirname(out), { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const remote = `/sdcard/xhs-dump-${token}.xml`;
  await adbShell(serial, `uiautomator dump ${remote}`, 25000);
  let b64 = "";
  for (let i = 0; i < 3; i += 1) {
    b64 = await adbShell(serial, `base64 ${remote}`, 25000).catch(() => "");
    if (b64 && String(b64).trim()) break;
    await sleep(400);
  }
  await adbShell(serial, `rm -f ${remote}`, 8000).catch(() => "");
  const cleaned = String(b64).replace(/\s+/g, "");
  if (!cleaned) throw new Error("dump empty base64");
  const xml = Buffer.from(cleaned, "base64").toString("utf8");
  if (!xml.includes("<hierarchy")) throw new Error("dump missing hierarchy");
  writeFileSync(out, xml, "utf8");
  return { ok: true, action: "dump", path: out, bytes: Buffer.byteLength(xml) };
}

async function doStart(serial, p) {
  const pkg = p.package;
  if (!pkg || !/^[a-zA-Z0-9._]+$/.test(pkg)) throw new Error("start needs safe package");
  const activity = p.activity;
  if (activity && !/^[A-Za-z0-9_$.\/]+$/.test(activity)) throw new Error("unsafe activity");
  if (p.forceStop) {
    await adbShell(serial, `am force-stop ${pkg}`, 12000);
    await sleep(500);
  }
  let cmd;
  if (activity) {
    const comp = activity.includes("/") ? activity : `${pkg}/${activity}`;
    cmd = `am start -W -n ${comp}`;
  } else {
    cmd = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
  }
  const stdout = await adbShell(serial, cmd, 20000);
  await sleep(800);
  const raw = await adbShell(
    serial,
    "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -3",
    12000,
  ).catch(() => "");
  return { ok: true, action: "start", stdout: String(stdout).slice(0, 2000), focus: parseFocus(raw) };
}

async function doInputText(serial, p) {
  const textRaw = p.textB64
    ? Buffer.from(String(p.textB64), "base64").toString("utf8")
    : (p.text || "");
  const text = String(textRaw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t ]+/g, " ")
    .trim();
  if (!text) throw new Error("inputText needs textB64 or text");

  const hasRefocus = p.refocusX != null && p.refocusY != null
    && Number.isFinite(Number(p.refocusX)) && Number.isFinite(Number(p.refocusY));
  const clearFirst = !!p.clearFirst;
  const doEnter = !!p.enter;
  const deferRestore = !!p.deferRestore;

  const priorImeRaw = await adbShell(serial, "settings get secure default_input_method", 8000).catch(() => "");
  const priorIme = String(priorImeRaw || "").trim();
  const audit = {
    priorIme, bridgeIme: BRIDGE_IME, selected: false, refocused: false,
    cleared: false, inputAccepted: false, enter: false, restored: false,
  };

  const restoreIme = async () => {
    if (!priorIme || priorIme === BRIDGE_IME || priorIme === "null") {
      audit.restored = true;
      return;
    }
    try {
      const cur = String(await adbShell(serial, "settings get secure default_input_method", 8000)).trim();
      if (cur !== priorIme) {
        const r = await xwInvoke({ action: "selectIme", devices: serial, data: { ime: priorIme } }, 12000);
        if (r.code !== 10000) throw new Error(`restore selectIme code=${r.code}`);
      }
      audit.restored = true;
    } catch (e) {
      audit.restoreError = String(e.message || e).slice(0, 200);
    }
  };

  try {
    let cur = String(await adbShell(serial, "settings get secure default_input_method", 8000)).trim();
    if (cur !== BRIDGE_IME) {
      const r = await xwInvoke({ action: "selectIme", devices: serial, data: { ime: BRIDGE_IME } }, 12000);
      if (r.code !== 10000) {
        throw new Error(`selectIme XwIME failed code=${r.code} ${r.message || ""}`.slice(0, 200));
      }
      for (let i = 0; i < 8; i += 1) {
        await sleep(200);
        cur = String(await adbShell(serial, "settings get secure default_input_method", 8000)).trim();
        if (cur === BRIDGE_IME) break;
      }
      if (cur !== BRIDGE_IME) throw new Error(`bridge IME not active after selectIme (cur=${cur})`);
    }
    audit.selected = true;
    await sleep(400);

    if (hasRefocus) {
      const rx = Math.round(Number(p.refocusX));
      const ry = Math.round(Number(p.refocusY));
      await adbShell(serial, `input tap ${rx} ${ry}`, 10000);
      await sleep(600);
      audit.refocused = true;
      audit.refocusX = rx;
      audit.refocusY = ry;
    }

    if (clearFirst) {
      await adbShell(
        serial,
        "input keyevent KEYCODE_MOVE_END " + Array(48).fill("KEYCODE_DEL").join(" "),
        8000,
      );
      await sleep(150);
      audit.cleared = true;
    }

    const ir = await xwInvoke(
      { action: "inputText", devices: serial, data: { content: text } },
      15000,
    );
    if (ir.code !== 10000) {
      throw new Error(`inputText failed code=${ir.code} ${ir.message || ""}`.slice(0, 200));
    }
    audit.inputAccepted = true;

    if (doEnter) {
      await sleep(200);
      await adbShell(serial, "input keyevent KEYCODE_ENTER", 8000);
      audit.enter = true;
    }
  } catch (e) {
    await restoreIme();
    throw e;
  }

  if (!deferRestore) await restoreIme();
  else audit.restored = false;

  return { ok: true, action: "inputText", audit, textLen: text.length, textPreview: text.slice(0, 40) };
}

const HANDLERS = {
  shell: doShell, tap: doTap, focus: doFocus, dump: doDump,
  start: doStart, inputText: doInputText,
  // 便捷别名
  back: async (serial, p) => {
    const times = Math.max(1, Math.min(5, Number(p.times ?? 1) || 1));
    for (let i = 0; i < times; i += 1) {
      await adbShell(serial, "input keyevent 4", 10000);
    }
    return { ok: true, action: "back", times };
  },
  swipe: async (serial, p) => {
    const x1 = Math.round(Number(p.x1));
    const y1 = Math.round(Number(p.y1));
    const x2 = Math.round(Number(p.x2));
    const y2 = Math.round(Number(p.y2));
    const ms = Math.max(50, Number(p.ms ?? 350) || 350);
    if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error("swipe needs x1 y1 x2 y2");
    await adbShell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`, 12000);
    return { ok: true, action: "swipe", x1, y1, x2, y2, ms };
  },
};

async function dispatch(req) {
  const h = HANDLERS[req.op];
  if (!h) throw new Error(`unknown op ${req.op}`);
  const start = Date.now();
  try {
    const result = await h(serial, req);
    if (result && result.ok === false) {
      // handler 返回 ok:false 但不抛（如某些失败走返回路径）——同样记失败
      traceRecord(req.op, false, req, result, start);
      saveFailureContext(req, result.error);
      return result;
    }
    traceRecord(req.op, true, req, result, start);
    if (req.op === "dump" && result && result.ok && result.path) {
      lastSuccessfulDumpPath = result.path;
    }
    return result;
  } catch (e) {
    traceRecord(req.op, false, req, { error: e.message }, start);
    saveFailureContext(req, e.message);
    throw e;
  }
}

// ---- repl：常驻 pipe，按行读命令/吐结果 ----
async function runRepl() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let req;
    try { req = JSON.parse(line); } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: `bad json: ${String(e.message || e).slice(0, 120)}` }) + "\n");
      return;
    }
    try {
      await assertActiveExplorerLease();
      const r = await dispatch(req);
      process.stdout.write(JSON.stringify(r) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, op: req && req.op, error: String(e.message || e).slice(0, 500) }) + "\n");
    }
  });
  rl.on("close", () => {
    traceRecord("_session_end", true, {}, {}, Date.now());
    process.exit(0);
  });
  // 给父进程一个就绪信号行，便于它在拿到这条后再开始发命令
  process.stdout.write(JSON.stringify({ ok: true, action: "repl-ready", serial }) + "\n");
}

// ---- main ----
async function main() {
  if (action === "repl") {
    await runRepl();
    return; // 常驻，不打印单发结果
  }
  // 单发：把 argv 参数翻译成 dispatch 入参
  const req = { op: action };
  if (action === "shell") {
    req.cmd = opt("--cmd");
    req.cmdB64 = opt("--cmd-b64");
  } else if (action === "tap") {
    req.x = opt("--x");
    req.y = opt("--y");
  } else if (action === "dump") {
    req.out = opt("--out");
  } else if (action === "start") {
    req.package = opt("--package");
    req.activity = opt("--activity");
    req.forceStop = flag("--force-stop");
  } else if (action === "inputText") {
    req.text = opt("--text");
    req.textB64 = opt("--text-b64");
    req.refocusX = opt("--refocus-x");
    req.refocusY = opt("--refocus-y");
    req.clearFirst = flag("--clear-first");
    req.enter = flag("--enter");
    req.deferRestore = flag("--defer-restore");
  } else if (action === "back") {
    req.times = Number(opt("--times", "1") || 1);
  } else if (action === "swipe") {
    req.x1 = opt("--x1"); req.y1 = opt("--y1"); req.x2 = opt("--x2"); req.y2 = opt("--y2");
    req.ms = opt("--ms");
  }
  const result = await dispatch(req);
  result.serial = serial;
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, action, serial, error: String(e.message || e).slice(0, 500) }));
  process.exit(5);
});
