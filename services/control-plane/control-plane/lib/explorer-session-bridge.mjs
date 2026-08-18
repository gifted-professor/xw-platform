// explorer-session-bridge.mjs — REX Phase 4 §6.3 item 7：Explorer session bridge
//
// 一个 Explorer session 只 acquire 一次 lease，连续 primitive 走持久热传输 + heartbeat/
// sequence，不逐 primitive 重新申请 lease、不逐 primitive preflight。普通 primitive
// 零同步分类器观测（observation 只在 financial_commit candidate 才触发，走 PHC 路径）。
//
// 不碰手机、不改 adapter 调用语义：transport 由调用方注入，bridge 只保证 acquire/preflight
// 各一次、transport 每 primitive 一次、同步观测按需。

export class ExplorerSessionBridge {
  constructor({ acquire, preflight, transport, observeForClassifier, heartbeat = null, now = () => Date.now() } = {}) {
    if (typeof acquire !== "function") throw new Error("ExplorerSessionBridge: acquire function required");
    if (typeof transport !== "function") throw new Error("ExplorerSessionBridge: transport function required");
    this._acquire = acquire;
    this._preflight = typeof preflight === "function" ? preflight : null;
    this._transport = transport;
    this._observeForClassifier = typeof observeForClassifier === "function" ? observeForClassifier : null;
    this._heartbeat = typeof heartbeat === "function" ? heartbeat : null;
    this._now = now;
  }

  async open(session) {
    const acquired = await this._acquire(session);
    const handle = {
      session,
      sessionId: acquired?.sessionId ?? null,
      leaseId: acquired?.leaseId ?? null,
      token: acquired?.token ?? null,
      sequence: 0,
      openedAt: this._now(),
    };
    if (this._preflight) await this._preflight(handle);
    return {
      handle,
      dispatchPrimitive: (primitive) => this._dispatch(handle, primitive),
      close: () => this._close(handle),
    };
  }

  async _dispatch(handle, primitive) {
    handle.sequence += 1;
    // 普通 primitive 直走热传输；financial_commit candidate 才同步观测（默认不触发）。
    if (primitive?.actionClass === "financial_commit_candidate" && this._observeForClassifier) {
      await this._observeForClassifier({ handle, primitive });
    }
    if (this._heartbeat) {
      try { await this._heartbeat(handle); } catch { /* heartbeat 失败不阻 dispatch */ }
    }
    return this._transport({ handle, primitive, sequence: handle.sequence });
  }

  async _close(handle) {
    return { closed: true, sessionId: handle.sessionId, sequence: handle.sequence };
  }

  // L0 read-only：控制面不可用时，无 lease 直读（dump/focus/screenshot），不 acquire、
  // 不 preflight、不走 session 互斥。仅限只读 primitive（§6.3 item 8 / §7.2 L0）。
  static async l0Observe({ transport, primitive }) {
    if (typeof transport !== "function") throw new Error("l0Observe: transport function required");
    return transport({ handle: { sessionId: null, leaseId: null, l0: true, sequence: 0 }, primitive, sequence: 0 });
  }
}