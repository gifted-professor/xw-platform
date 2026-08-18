#!/usr/bin/env node
/**
 * Shared helpers for /xw balance (WeChat + Alipay read-only).
 * Amounts must never enter public knowledge.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const ROOT = "C:\\Users\\Public\\xhs-registry";
export const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "") + "/";
export const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "") + "/";
export const DEFAULT_ACTOR = process.env.XHS_ACTOR || "claude-pilot-20260809";
export const ALIPAY_PKG = "com.eg.android.AlipayGphone";
export const WECHAT_PKG = "com.tencent.mm";
export const WEIGOU_PKG = "com.truedian.dragon";
export const DEFAULT_PADDLE_OCR_PYTHON =
  process.env.XHS_PADDLE_OCR_PYTHON
  || "C:\\Users\\Public\\xhs-registry-visual-tap\\experiments\\visual-tap-resolver\\.venv-ocr\\Scripts\\python.exe";

export function normalizeAliases(raw) {
  const parts = String(raw ?? "01,02,03,04").split(/[,:\s]+/).filter(Boolean);
  const aliases = parts.map((part) => {
    const digits = String(part).replace(/\D/g, "");
    const n = Number(digits);
    if (![1, 2, 3, 4].includes(n)) throw new Error(`invalid alias ${part}`);
    return `0${n}`;
  });
  return [...new Set(aliases)];
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

export function validateBalanceParentTask(task, { runId, actor }) {
  if (!task || typeof task !== "object") throw new Error("parent task ledger is invalid");
  if (task.runId !== runId) throw new Error("parent task runId mismatch");
  if (task.actor !== actor) throw new Error("parent task actor mismatch");
  if (task.mode !== "runner") throw new Error("parent task mode must be runner");
  if (!/三平台账户余额只读/.test(String(task.goal || ""))) throw new Error("parent task goal mismatch");
  return task;
}

export function assertBalanceParentRun({ runId, actor, deferHome }) {
  if (!/^run_[A-Za-z0-9._-]+$/.test(String(runId || "")) || String(runId).includes("..")) {
    throw new Error("valid parent task runId required");
  }
  if (deferHome !== true) throw new Error("parent task must own HOME restoration");
  const workRoot = realpathSync(join(ROOT, "outbox", "work"));
  if (existsSync(join(ROOT, "outbox", "harvest", runId))) {
    throw new Error("parent task run is already closed");
  }
  const taskPath = join(workRoot, runId, "task.json");
  if (!existsSync(taskPath)) throw new Error(`parent task ledger missing: ${runId}`);
  const stat = lstatSync(taskPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("parent task ledger must be a regular file");
  const taskReal = realpathSync(taskPath);
  if (!taskReal.toLowerCase().startsWith(`${workRoot.toLowerCase()}\\`)) {
    throw new Error("parent task ledger escapes work root");
  }
  return validateBalanceParentTask(JSON.parse(readFileSync(taskReal, "utf8")), { runId, actor });
}

export function runNode(args, { allowFail = false, timeoutMs = 180000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    timeout: timeoutMs,
  });
  if (!allowFail && result.status !== 0) {
    throw new Error(`exit ${result.status}: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export function sleep(ms) {
  spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { windowsHide: true });
}

export async function fetchText(url, { timeoutMs = 30000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastErr = error;
      sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

export async function loadLiveFleet() {
  const text = await fetchText(new URL("agent-entry.md", REGISTRY));
  const devices = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^- (0[1-4]) \| online=(yes|no) \| ready=(yes|no).*?\| lease=([^ |]+).*?\| quarantined=(yes|no).*?\| unresolvedFailure=([^ |]+)/);
    if (!match) continue;
    devices.push({
      alias: match[1],
      online: match[2] === "yes",
      ready: match[3] === "yes",
      lease: match[4],
      quarantined: match[5] === "yes",
      unresolvedFailure: match[6] === "none" ? null : match[6],
      capabilityIds: ["xiaowei.explorer.primitive"],
    });
  }
  if (!devices.length) throw new Error("agent-entry exposed no devices");
  return devices;
}

export function sessionFile(tag, alias) {
  return join(homedir(), ".xhs-explorer-sessions", `xw-balance-${tag}-${alias}.json`);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function parseFocus(stdout) {
  const m = String(stdout).match(/^FOCUS=(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Login-wall heuristics (fail closed → skip collect). */
export function detectLoginWall({ app, focus, texts = [] }) {
  const blob = `${focus || ""} ${texts.join(" ")}`;
  if (app === "alipay") {
    if (/LoginActivity|loginupgrade/i.test(focus || "")) {
      return { skipped: true, reason: "alipay_login_activity" };
    }
    if (/短信验证码登录|注册账号|其他验证方式/.test(blob) && !/可用余额|总资产|最近消息|扫一扫|我的/.test(blob)) {
      return { skipped: true, reason: "alipay_login_wall" };
    }
  }
  if (app === "wechat") {
    if (/登录|LogInUI|LoginPasswordUI|LoginSMS/i.test(blob) && !/钱包|服务|通讯录/.test(blob)) {
      return { skipped: true, reason: "wechat_login_wall" };
    }
  }
  if (app === "weigou") {
    if (/登录|验证码|注册账号|手机号登录/.test(blob) && !/我的钱包|自营收入|动态|工作台/.test(blob)) {
      return { skipped: true, reason: "weigou_login_wall" };
    }
  }
  return { skipped: false, reason: null };
}

/**
 * Generic PaddleOCR over an image crop; returns texts + money-like candidates.
 */
export function ocrScreen(imagePath, {
  pythonPath = DEFAULT_PADDLE_OCR_PYTHON,
  y0 = 0.05,
  y1 = 0.65,
  x0 = 0,
  x1 = 1,
  timeoutMs = 120000,
} = {}) {
  if (!imagePath || !existsSync(imagePath)) {
    return { ok: false, code: "IMAGE_NOT_FOUND", message: `missing ${imagePath}` };
  }
  if (!existsSync(pythonPath)) {
    return { ok: false, code: "OCR_PYTHON_MISSING", message: pythonPath };
  }
  const script = `
import json, os, re, sys
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MKLDNN", "1")
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass
import cv2
from paddleocr import PaddleOCR
img = cv2.imread(sys.argv[1])
if img is None:
    print(json.dumps({"ok": False, "code": "IMAGE_UNREADABLE"}))
    raise SystemExit(2)
h, w = img.shape[:2]
y0, y1, x0, x1 = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
ox, oy = int(w*x0), int(h*y0)
crop = img[oy:int(h*y1), ox:int(w*x1)]
ocr = PaddleOCR(lang="ch", use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)
rec = (ocr.predict(crop) or [None])[0] or {}
texts = [str(t).strip() for t in (rec.get("rec_texts") or []) if str(t).strip()]
polys = list(rec.get("rec_polys") or rec.get("dt_polys") or [])
boxes = []
for t, p in zip(texts, polys):
    xs = [pt[0] for pt in p]; ys = [pt[1] for pt in p]
    # Absolute screen coords (crop offset applied) so taps/findLabelPoint stay correct.
    boxes.append({"text": t, "x": int(sum(xs)/len(xs))+ox, "y": int(sum(ys)/len(ys))+oy,
                  "bounds": [int(min(xs))+ox, int(min(ys))+oy, int(max(xs))+ox, int(max(ys))+oy]})
joined = " ".join(texts)
cands = list(dict.fromkeys(re.findall(r"(?<![.\\d])(\\d{1,9}\\.\\d{2})(?![.\\d])", joined) + re.findall(r"¥\\s*(\\d{1,9}\\.\\d{2})", joined)))
print(json.dumps({"ok": True, "texts": texts, "boxes": boxes, "amountCandidates": cands, "offset": {"x": ox, "y": oy}}, ensure_ascii=False))
`;
  const tmp = join(ROOT, "runtime", "plans", `_ocr_${Date.now()}.py`);
  ensureDir(join(ROOT, "runtime", "plans"));
  writeFileSync(tmp, script);
  const result = spawnSync(
    pythonPath,
    [tmp, imagePath, String(y0), String(y1), String(x0), String(x1)],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        FLAGS_use_mkldnn: "0",
        PADDLE_PDX_DISABLE_MKLDNN: "1",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  try {
    const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
    return line ? JSON.parse(line) : { ok: false, code: "OCR_OUTPUT_INVALID", message: String(result.stderr || "").slice(0, 300) };
  } catch {
    return { ok: false, code: "OCR_OUTPUT_INVALID", message: String(result.stderr || "").slice(0, 300) };
  }
}

export function findLabelPoint(ocr, labels) {
  const boxes = ocr?.boxes || [];
  for (const label of labels) {
    const hit = boxes.find((b) => String(b.text).includes(label));
    if (hit) return { x: hit.x, y: hit.y, text: hit.text };
  }
  return null;
}

export function privacyNote() {
  return { publicKnowledge: false, redactInCommonLogs: ["amountCny"] };
}

/** Same set as control-plane return-home.mjs */
export const LAUNCHER_PACKAGE_RE =
  /^(com\.miui\.home|com\.android\.launcher3?|com\.google\.android\.apps\.nexuslauncher|com\.huawei\.android\.launcher|com\.sec\.android\.app\.launcher|com\.oppo\.launcher|com\.vivo\.launcher)$/i;

export const LAUNCHER_PACKAGES = [
  "com.miui.home",
  "com.android.launcher3",
  "com.google.android.apps.nexuslauncher",
  "com.huawei.android.launcher",
  "com.sec.android.app.launcher",
  "com.oppo.launcher",
  "com.vivo.launcher",
];

export function packageFromFocus(focus) {
  const raw = String(focus || "");
  const m = raw.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\//);
  if (m) return m[1];
  const m2 = raw.match(/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/);
  return m2 ? m2[1] : null;
}

export function isLauncherFocus(focus) {
  return LAUNCHER_PACKAGE_RE.test(String(packageFromFocus(focus) || ""));
}

/**
 * Fixed closeout: return device to system launcher.
 * Must run with explorer lease already released — uses formal R0 job so CP
 * returnHome presses KEYCODE_HOME (Explorer deliberately skips that path).
 */
export function closeoutAliasToDesktop({ alias, actor, tag = "closeout" }) {
  const home = runNode(
    [join(ROOT, "ops", "home.mjs"), "--alias", alias, "--actor", actor],
    { allowFail: true, timeoutMs: 60000 },
  );
  const stdout = String(home.stdout || "");
  const packageName = (stdout.match(/^PACKAGE=(.+)$/m) || [])[1] || null;
  const jobId = (stdout.match(/^JOB=(.+)$/m) || [])[1] || null;
  const reason = (stdout.match(/^REASON=(.+)$/m) || [])[1] || null;
  const ok = home.status === 0 && /^HOME=ok$/m.test(stdout);
  return {
    alias,
    ok,
    packageName,
    jobId,
    reason: ok ? (reason || "launcher_focus") : (reason || "return_home_failed"),
    via: "formal_job_return_home",
    tag,
    stdout: stdout.slice(0, 400),
  };
}

/** @deprecated Prefer closeoutAliasToDesktop after releasing explorer lease. */
export function returnToDesktop({ alias, actor, sessionFilePath }) {
  if (sessionFilePath && existsSync(sessionFilePath)) {
    runNode(
      [join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sessionFilePath],
      { allowFail: true },
    );
  }
  return closeoutAliasToDesktop({ alias, actor: actor || DEFAULT_ACTOR, tag: "in-session" });
}
