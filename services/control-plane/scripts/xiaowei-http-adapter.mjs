// xiaowei-http-adapter.mjs — 效卫 typed HTTP API 适配器
//
// 包裹 GatewayOperator，将 tap / capturePng / home / back 四个 D3 认证能力
// 切换到效卫 typed HTTP API（127.0.0.1:17910），其他操作（shellExec / dumpXml /
// inputTextViaXiaowei / xiaoweiInvoke / setIme / currentFocus / currentIme）透传
// 给 inner GatewayOperator（直连 ws://127.0.0.1:22222）。
//
// HTTP API 不可用时自动降级到 inner GatewayOperator（fallback 透明）。
// 串行化与 GatewayOperator 一致：promise 链 + 200ms 起搏，防 libuv 崩溃。
//
// 用法：
//   const op = await new XiaoweiHttpAdapter({ serial }).start();
//   // 等价于 GatewayOperator，但 tap/capturePng/home/back 走 typed HTTP

import { connect } from "node:net";
import { readFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { GatewayOperator } from "./gateway-operator.mjs";

const DEFAULT_HTTP = "http://127.0.0.1:17910";

export class XiaoweiHttpAdapter {
  constructor({ serial, xwWs, xwHttp = DEFAULT_HTTP, deviceAlias = "01", fallbackOnError = true } = {}) {
    if (!serial) throw new Error("XiaoweiHttpAdapter 缺 serial");
    this.serial = serial;
    this._deviceAlias = deviceAlias;
    this._fallbackOnError = fallbackOnError;
    this._httpReady = false;
    this._xwHttp = xwHttp;
    this._chain = Promise.resolve();

    // 内部 GatewayOperator 负责所有非迁移操作
    this._inner = new GatewayOperator({ serial, xwWs });

    // 暴露与 GatewayOperator 兼容的接口字段
    this.transport = "gateway";
    this.adbPath = null;
    this.xwBridgeIme = this._inner.xwBridgeIme;
    this.metrics = this._inner.metrics;
  }

  // ─── 启动 ────────────────────────────────────────────────

  async start() {
    // 先起 inner GatewayOperator（探活 WS 网关）
    await this._inner.start();
    // 再探测 HTTP API 是否在监听
    this._httpReady = await this._healthCheck();
    if (!this._httpReady && !this._fallbackOnError) {
      throw new Error("Xiaowei HTTP API not reachable at " + this._xwHttp);
    }
    return this;
  }

  // ─── D3: input.pointer.tap ──────────────────────────────

  async tap(x, y) {
    this.metrics.taps += 1;
    if (!this._httpReady) return this._inner.tap(x, y);
    const body = {
      capability: "input.pointer.tap",
      deviceAlias: this._deviceAlias,
      params: {
        coordinate: {
          space: "sourcePixels",
          x: Math.round(x),
          y: Math.round(y),
          width: 1080,
          height: 2400,
        },
      },
    };
    await this._httpInvoke("input.pointer.tap", body, 15000);
  }

  // ─── D3: screen.capture ─────────────────────────────────

  async capturePng(targetPath, timeoutMs = 20000) {
    if (!this._httpReady) return this._inner.capturePng(targetPath, timeoutMs);

    try {
      const dir = dirname(targetPath);
      try { mkdirSync(dir, { recursive: true }); } catch {}
      const { readdirSync: ls } = await import("node:fs");
      const before = new Set((() => {
        try { return ls(dir).filter((f) => /\.png$/i.test(f)); } catch { return []; }
      })());

      const body = {
        capability: "screen.capture",
        deviceAlias: this._deviceAlias,
        params: { savePath: dir },
      };
      const r = await this._httpInvoke("screen.capture", body, timeoutMs);

      const verification = r?.verification;
      if (verification?.bytes != null) {
        if (existsSync(targetPath)) {
          const buf = readFileSync(targetPath);
          return { path: targetPath, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
        }
        // 只允许消费本次 capture 新生成的文件。若扫描所有历史 PNG，同一画面哈希相同会把
        // 上一份证据 rename 走，导致 result 中前一条路径凭空消失。
        const files = ls(dir)
          .filter((f) => /\.png$/i.test(f) && !before.has(f))
          .sort()
          .reverse();
        for (const f of files) {
          const p = join(dir, f);
          const buf = readFileSync(p);
          const h = createHash("sha256").update(buf).digest("hex");
          if (h === verification.sha256) {
            try { renameSync(p, targetPath); } catch {}
            return { path: existsSync(targetPath) ? targetPath : p, bytes: buf.length, sha256: h };
          }
        }
        if (files.length) {
          const p = join(dir, files[0]);
          const buf = readFileSync(p);
          try { renameSync(p, targetPath); } catch {}
          return { path: existsSync(targetPath) ? targetPath : p, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
        }
      }

      // typed API 返回异常时降级到 inner
      return this._inner.capturePng(targetPath, timeoutMs);
    } catch {
      // typed API capture 失败（如 verifyStableFile 超时），降级到 inner
      return this._inner.capturePng(targetPath, timeoutMs);
    }
  }

  // ─── D3: input.key.home / input.key.back ────────────────

  async home() {
    if (!this._httpReady) return this._inner.home();
    const body = { capability: "input.key.home", deviceAlias: this._deviceAlias, params: {} };
    return this._httpInvoke("input.key.home", body, 15000);
  }

  async back() {
    if (!this._httpReady) return this._inner.back();
    const body = { capability: "input.key.back", deviceAlias: this._deviceAlias, params: {} };
    return this._httpInvoke("input.key.back", body, 15000);
  }

  // ─── 透传方法（非迁移操作）──────────────────────────────

  async shellExec(cmd, timeoutMs) { return this._inner.shellExec(cmd, timeoutMs); }
  async currentFocus() { return this._inner.currentFocus(); }
  async currentIme() { return this._inner.currentIme(); }
  async setIme(ime) { return this._inner.setIme(ime); }
  async inputTextViaXiaowei(text, opts) { return this._inner.inputTextViaXiaowei(text, opts); }
  async xiaoweiInvoke(action, data, timeoutMs) { return this._inner.xiaoweiInvoke(action, data, timeoutMs); }
  async dumpXml(label) { return this._inner.dumpXml(label); }
  async close() { return this._inner.close(); }

  // ─── 内部方法 ────────────────────────────────────────────

  // TCP connect 探活 HTTP API（不做实际 API 调用，避免副作用）
  async _healthCheck() {
    try {
      const url = new URL(this._xwHttp);
      return new Promise((resolve) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) || 17910 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
        socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
      });
    } catch {
      return false;
    }
  }

  // HTTP POST /device/v1/invoke，串行化 + 重试
  async _httpInvoke(capability, body, timeoutMs = 15000) {
    const run = () => this._chain.then(async () => {
      await new Promise((r) => setTimeout(r, 200)); // 200ms 起搏

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${this._xwHttp}/device/v1/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(t);

        const data = await res.json();
        if (!data.ok && data.ok !== undefined) {
          const err = new Error(`typed API ${capability} failed: ${data.error?.message || JSON.stringify(data.error)}`);
          err.code = data.error?.code;
          throw err;
        }
        // typed API 响应没有 ok 字段（直接返回 {status, vendorResponse, ...}）
        // 有 status 字段就表示成功
        return data;
      } catch (e) {
        clearTimeout(t);
        if (e.name === "AbortError") throw new Error(`typed API timeout (${timeoutMs}ms) capability=${capability}`);
        throw e;
      }
    });

    // 最多 3 次重试（连接失败/超时），typed API 错误不重试
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const p = run();
        this._chain = p.catch(() => {});
        return await p;
      } catch (e) {
        lastErr = e;
        if (e.code) throw e; // typed API 业务错误不重试
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }
}
