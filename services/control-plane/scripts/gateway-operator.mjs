// gateway-operator.mjs — 闲鱼/设备操作的「绿箭网关」传输层
//
// 不依赖 adb.exe：所有设备操作经小薇/绿箭 WS 网关 ws://127.0.0.1:22222 的独立 USB 传输。
//  - shellExec  → action=adb_shell {command}      （uiautomator dump / input tap / dumpsys / cat …）
//  - tap        → shellExec("input tap x y")      （像素坐标，与 FastOperator.tap 同语义）
//  - currentFocus → shellExec dumpsys mCurrentFocus
//  - setIme/currentIme → selectIme / adb_shell settings
//  - inputTextViaXiaowei → 效卫桥 IME inputText + adb_shell keyevent 清空
//  - capturePng → action=Screen {savePath}（存 Windows 本地路径，node 直接 readFileSync）
//
// 接口与 FastOperator 对齐（serial/transport/tap/shellExec/currentFocus/currentIme/setIme/
// xiaoweiInvoke/inputTextViaXiaowei/xwBridgeIme/close），xianyu-operator 按 op.transport 分支 dump/capture。
// 在 Windows 本机运行：网关 localhost、Screen 落本地盘、node 直读。

import { readFileSync, existsSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { XiaoweiTransport } from "../control-plane/lib/xiaowei-transport.mjs";

const DEFAULT_WS = "ws://127.0.0.1:22222/";
const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";

export function parseFocusOutput(output) {
  const raw = String(output || "");
  const patterns = [
    /mCurrentFocus=Window\{[^}]+ (?:u\d+\s+)?([^/}\s]+)\/([^}\s]+)/,
    /mFocusedApp=ActivityRecord\{[^}]+ (?:u\d+\s+)?([^/}\s]+)\/([^}\s]+)/,
    /mResumedActivity[:=]\s*ActivityRecord\{[^}]+ (?:u\d+\s+)?([^/}\s]+)\/([^}\s]+)/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return { package: match[1], activity: match[2], raw };
  }
  return { package: null, activity: null, raw };
}

export class GatewayOperator {
  constructor({
    serial,
    xwWs = DEFAULT_WS,
    pacer = null,
    leaseAuthorization = null,
    fetchImpl = globalThis.fetch,
    transportClient = null,
    allowBypass = process.env.XHS_ALLOW_BYPASS === "1",
    bypassReason = process.env.XHS_BYPASS_REASON || "",
  } = {}) {
    if (!serial) throw new Error("GatewayOperator 缺 serial");
    this.serial = serial;
    this.xwWs = xwWs;
    this.transport = "gateway";
    this.adbPath = null; // 不走 adb；仅为接口兼容保留
    this.xwBridgeIme = BRIDGE_IME;
    this._httpReady = false; // 是否已确认 HTTP 接口可用
    this._deviceAlias = "01"; // 默认使用 alias 01，可通过外部参数覆盖
    this.metrics = { actions: 0, dumps: 0, scrolls: 0, taps: 0, totalDumpMs: 0, totalScrollMs: 0 };
    this._priorIme = null;
    this._chain = Promise.resolve(); // 串行化 WS（单设备顺序调用，避免并发 accept 失败）
    this._fetch = fetchImpl;
    this._allowBypass = allowBypass;
    this._bypassReason = String(bypassReason || "").trim();
    this._leaseAuthorization = leaseAuthorization || {
      leaseId: process.env.XHS_OPERATOR_LEASE_ID,
      token: process.env.XHS_OPERATOR_LEASE_TOKEN,
      deviceId: process.env.XHS_OPERATOR_DEVICE_ID,
      controlUrl: process.env.XHS_OPERATOR_CONTROL_URL || "http://127.0.0.1:17920",
    };
    this._xiaoweiTransport = transportClient || new XiaoweiTransport({ url: xwWs });
  }

  async start() {
    await this.authorizeLease();
    // 探活：跑一条 echo；失败说明网关/设备不可达，fail-fast。
    const out = await this.shellExec("echo gateway-ready", 8000).catch(() => null);
    if (out == null || !String(out).includes("gateway-ready")) {
      throw new ControlPlaneError(
        "GATEWAY_DEVICE_PROBE_FAILED",
        "gateway could not reach the leased device",
        { status: 503, details: { phase: "gateway-ready" } },
      );
    }
    return this;
  }

  async authorizeLease() {
    const auth = this._leaseAuthorization || {};
    const hasLeaseContext = Boolean(auth.leaseId && auth.token && auth.deviceId);
    if (!hasLeaseContext && this._allowBypass) {
      if (!this._bypassReason) {
        throw new ControlPlaneError(
          "CONTROL_BYPASS_REASON_REQUIRED",
          "XHS_ALLOW_BYPASS=1 also requires XHS_BYPASS_REASON for an auditable lab exception",
          { status: 403 },
        );
      }
      console.error(JSON.stringify({
        event: "operator.lease-bypass",
        reason: this._bypassReason.slice(0, 200),
        at: new Date().toISOString(),
      }));
      return { authorized: true, bypass: true };
    }
    if (!hasLeaseContext) {
      throw new ControlPlaneError(
        "CONTROL_LEASE_REQUIRED",
        "GatewayOperator requires an active control-plane lease; use job/session or XHS_ALLOW_BYPASS=1 for an explicitly recorded lab bypass",
        { status: 423 },
      );
    }
    let response;
    try {
      response = await this._fetch(new URL("/control/v1/leases/authorize", auth.controlUrl || "http://127.0.0.1:17920"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-control-token": auth.token,
        },
        body: JSON.stringify({
          leaseId: auth.leaseId,
          deviceId: auth.deviceId,
          runtimeId: this.serial,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new ControlPlaneError("CONTROL_LEASE_AUTH_UNAVAILABLE", "unable to authorize operator lease", {
        status: 503,
        cause: error,
      });
    }
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok || result?.authorized !== true) {
      throw new ControlPlaneError(
        result?.error?.code || "CONTROL_LEASE_REJECTED",
        result?.error?.message || "operator lease was rejected",
        { status: response.status || 403, details: result?.error?.details || {} },
      );
    }
    return result;
  }

  async close() { /* WS 一连接一请求，无需关闭长连 */ }

  // 单请求一连接：发 {action, devices:serial, data}，首条消息即响应，code===10000=SUCCESS。
  async xiaoweiInvoke(action, data, timeoutMs = 15000) {
    const request = { action, devices: this.serial, ...(data != null ? { data } : {}) };
    // XiaoweiTransport 使用跨进程文件锁。不同手机可由不同 Agent 同时推进，
    // 但共享的 22222 单实例每一条 WS 请求都严格互斥，避免并发建连击穿网关。
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await this._xiaoweiTransport.invoke(request, { timeoutMs }); }
      catch (e) {
        lastErr = e;
        if (e.code === "XIAOWEI_MALFORMED_RESPONSE") throw e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }

  // 串行化包装：所有 WS 调用排队，避免并发 accept 失败。
  // 加 200ms 起搏：高频 connect/close 会触发 Windows node 的 libuv UV_HANDLE_CLOSING 崩溃（2026-07-22 实证，120ms 仍偶发）。
  _invoke(action, data, timeoutMs) {
    const p = this._chain.then(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return this.xiaoweiInvoke(action, data, timeoutMs);
    });
    this._chain = p.catch(() => {});
    return p;
  }

  // 统一 shell：action=adb_shell {command}，返回该设备 stdout 字符串。
  async shellExec(cmd, timeoutMs = 15000) {
    const r = await this._invoke("adb_shell", { command: String(cmd) }, timeoutMs);
    if (r.code !== 10000) throw new Error(`adb_shell failed: ${r.message || JSON.stringify(r)}`);
    const out = r.data?.[this.serial];
    return out == null ? "" : String(out);
  }

  async tap(x, y) {
    this.metrics.taps += 1;
    return this.shellExec(`input tap ${Math.round(x)} ${Math.round(y)}`, 8000);
  }

  async home() {
    return this.shellExec("input keyevent 3", 8000);
  }

  async back() {
    return this.shellExec("input keyevent 4", 6000);
  }

  async currentFocus() {
    const out = await this.shellExec(
      "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'; "
      + "dumpsys activity activities 2>/dev/null | grep -E 'mResumedActivity' | head -1",
      10000,
    ).catch(() => "");
    return parseFocusOutput(out);
  }

  async currentIme() {
    const out = await this.shellExec("settings get secure default_input_method", 8000).catch(() => "");
    return String(out).trim();
  }

  async setIme(ime) {
    const r = await this._invoke("selectIme", { ime }, 12000);
    if (r.code !== 10000) throw new Error(`selectIme failed: ${r.message || JSON.stringify(r)}`);
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if ((await this.currentIme()) === ime) return true;
    }
    return false;
  }

  // 效卫桥 IME 输入中文：切 XwIME → 清空（adb_shell keyevent）→ inputText → 还原。
  // 与 FastOperator.inputTextViaXiaowei 行为对齐；keyevent 走 shellExec（不经 adb.exe）。
  // FlutterBoost 关键修法（2026-07-22 E6 实证）：切 IME 后 Flutter 的 input connection 已随旧 IME
  // 销毁，commitText 会石沉大海（inputAccepted=true 但字不进字段）。必须在切 IME 后**重新聚焦**
  // （refocus 回调，一般是重点一次字段），让 Flutter 在 XwIME 名下重建 connection，再 inputText。
  async inputTextViaXiaowei(text, { bridgeIme, priorIme, clearFirst = false, deferRestore = false, refocus = null } = {}) {
    bridgeIme = bridgeIme || this.xwBridgeIme || BRIDGE_IME;
    priorIme = priorIme || (await this.currentIme());
    this._priorIme = priorIme;
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
      if (refocus) {
        await refocus();
        await new Promise((r) => setTimeout(r, 600));
        audit.refocused = true;
      }
      if (clearFirst) {
        await this.shellExec("input keyevent KEYCODE_MOVE_END " + Array(48).fill("KEYCODE_DEL").join(" "), 8000);
        await new Promise((r) => setTimeout(r, 150));
        audit.cleared = true;
      }
      const r = await this._invoke("inputText", { content: String(text) }, 12000);
      if (r.code !== 10000) throw new Error(`inputText failed: ${r.message || JSON.stringify(r)}`);
      audit.inputAccepted = true;
    } catch (e) {
      await restore();
      throw e;
    }
    if (deferRestore) return { audit, restore };
    await restore();
    return audit;
  }

  // 截图：绿箭 Screen 的 savePath 是**目录**（默认 D:\Pictures），不是文件路径；
  // Screen 把图存为 <serial>_Screenshot_<ts>.png 到该目录。故：
  // 取 targetPath 的**每设备子目录**作 savePath（并发多机时避免互相抢新文件），
  // Screen 后找新生成的 png，重命名到 targetPath，再读字节算 sha256。
  // 读盘失败会重试；rename 失败则回退 src 路径（2026-07-26 四机并发 ENOENT 实证）。
  async capturePng(targetPath, timeoutMs = 15000) {
    const parent = dirname(targetPath);
    // 每 serial 独立落盘目录，杜绝并发 capture 把别人的截图 rename 走
    const dir = join(parent, `_gwshot_${String(this.serial).replace(/[^A-Za-z0-9_-]/g, "_")}`);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    try { mkdirSync(parent, { recursive: true }); } catch {}
    const before = (() => { try { return new Set(readdirSync(dir).filter((f) => /\.png$/i.test(f))); } catch { return new Set(); } })();
    const r = await this._invoke("Screen", { savePath: dir }, timeoutMs);
    if (r.code !== 10000) throw new Error(`Screen failed: ${r.message || JSON.stringify(r)}`);
    let found = null;
    const serialHint = String(this.serial);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((res) => setTimeout(res, 200));
      const after = (() => {
        try {
          return readdirSync(dir).filter((f) => {
            if (!/\.png$/i.test(f) || before.has(f)) return false;
            // 优先本机 serial 前缀，避免扫到脏文件
            return f.includes(serialHint) || !/^[A-Za-z0-9]+_Screenshot_/.test(f);
          });
        } catch { return []; }
      })();
      if (after.length) {
        const preferred = after.filter((f) => f.includes(serialHint));
        found = (preferred.length ? preferred : after).sort().slice(-1)[0];
        break;
      }
    }
    if (!found) throw new Error("Screen: no new png written");
    const src = join(dir, found);
    // Screen 异步写文件：文件名一出现就可能还是 0 字节在 flush。等非零且两次读大小稳定再 rename。
    let size = 0, prev = -1, stable = 0;
    for (let i = 0; i < 30; i += 1) {
      try { size = existsSync(src) ? readFileSync(src).length : 0; } catch { size = 0; }
      if (size > 0 && size === prev) { stable += 1; if (stable >= 2) break; } else stable = 0;
      prev = size;
      await new Promise((res) => setTimeout(res, 120));
    }
    let p = src;
    try {
      if (existsSync(src)) {
        renameSync(src, targetPath);
        if (existsSync(targetPath)) p = targetPath;
      }
    } catch {
      // rename 竞态/锁：继续用 src
      p = existsSync(targetPath) ? targetPath : src;
    }
    // 读盘重试（ENOENT / 短暂锁）
    let lastErr = null;
    for (let i = 0; i < 8; i += 1) {
      const candidates = [p, targetPath, src].filter((x, idx, arr) => x && arr.indexOf(x) === idx);
      for (const cand of candidates) {
        try {
          if (!existsSync(cand)) continue;
          const buf = readFileSync(cand);
          if (buf.length > 0) {
            return { path: cand, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
          }
        } catch (e) {
          lastErr = e;
        }
      }
      await new Promise((res) => setTimeout(res, 150));
    }
    throw new Error(`Screen: cannot read png after retries (${lastErr?.message || "empty"})`);
  }

  // uiautomator dump → base64 回传纯 ASCII（经网关文本通道不丢 UTF-8）→ node 解码 UTF-8 XML。
  // 不能用 cat：网关 adb_shell 会把设备 UTF-8 stdout 按 GBK 解再回传，中文 content-desc 变 mojibake。
  // base64 是纯 ASCII，不受网关文本编码影响；node 端 Buffer.from(b64,'base64').toString('utf8') 还原。
  async dumpXml(label) {
    const token = `${process.pid}-${Date.now()}`;
    const remote = `/sdcard/xianyu-dump-${token}.xml`;
    const t0 = Date.now();
    await this.shellExec(`uiautomator dump ${remote}`, 20000);
    let b64 = "";
    for (let i = 0; i < 3; i += 1) {
      b64 = await this.shellExec(`base64 ${remote}`, 20000).catch(() => "");
      if (b64 && b64.trim()) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.shellExec(`rm -f ${remote}`, 5000).catch(() => null);
    if (!b64 || !b64.trim()) throw new Error("gateway dump: empty base64");
    const xml = Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
    if (!xml.includes("<hierarchy")) throw new Error("gateway dump: hierarchy XML not returned");
    this.metrics.dumps += 1;
    this.metrics.totalDumpMs += Date.now() - t0;
    return xml;
  }
}
