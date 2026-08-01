// evidence-spool.mjs — REX Phase 3：Evidence v1 降级链 + 证据债
//
// 核心不变量（§5.1 / §5.4 GO）：证据更严谨，但证据失败只能形成 debt，
// 绝不阻止非支付执行。非支付 dispatch 永远先跑、永远跑一次——writer 正常/
// 失败时 adapter 调用数完全相同。
//
// 降级链：primary(SQLite) → spool(落盘 spool 目录) → ring(进程内 bounded 环)
//   → stdout(兜底打印) → debt(终端债记录)。任一层成功即停止；全失败落 debt。
// 每层都是调用方注入的 async (event) => void；缺省层跳过。debt 记录最终未
// 落盘的 event，供后续补偿/审计，不影响 dispatch。

const DEFAULT_RING_CAPACITY = 256;

// 只把「显式提供为函数」的层纳入降级链。未提供的层跳过——降级链是调用方
// 按运行环境装配的（SQLite→spool→ring→stdout），sidecar 不替调用方决定哪些
// 层可用。所有提供的层都失败时落 debt，绝不回滚已执行的非支付 dispatch。
export function createEvidenceSidecar({
  writePrimary = null,
  writeSpool = null,
  writeRing = null,
  writeStdout = null,
  ringCapacity = DEFAULT_RING_CAPACITY,
  now = () => Date.now(),
} = {}) {
  const ring = [];
  const evidenceDebt = [];

  // 顺序：primary → spool → ring → stdout。只有「显式提供为函数」的层才纳入链；
  // 未提供（undefined/null）的层跳过。调用方按运行环境装配降级链，sidecar 不替
  // 它决定哪些层可用。所有提供的层都失败（或一个都没提供）时落 debt。
  const layers = [
    ["primary", typeof writePrimary === "function" ? writePrimary : null],
    ["spool", typeof writeSpool === "function" ? writeSpool : null],
    ["ring", typeof writeRing === "function" ? writeRing : null],
    ["stdout", typeof writeStdout === "function" ? writeStdout : null],
  ];

  async function attemptWrite(event) {
    let lastError = null;
    for (const [layer, fn] of layers) {
      if (typeof fn !== "function") continue;
      try {
        await fn(event);
        return { ok: true, layer };
      } catch (error) {
        lastError = { layer, code: error?.code ?? null, message: error?.message ?? String(error) };
      }
    }
    return { ok: false, lastError };
  }

  return {
    ring,
    evidenceDebt,
    async runNonpayment(event, action) {
      // 非支付执行永远先跑、永远跑一次。证据写在 action 之后，失败不得回滚 dispatch。
      const result = await action();
      const write = await attemptWrite(event);
      if (!write.ok) {
        evidenceDebt.push({
          eventId: event?.eventId ?? null,
          code: write.lastError?.code ?? "EVIDENCE_DEBT",
          lastLayer: write.lastError?.layer ?? null,
          cause: write.lastError?.message ?? null,
          createdAt: new Date(now()).toISOString(),
        });
      }
      return {
        result,
        evidenceDebt,
        dispatched: true,
        evidenceWritten: write.ok,
        evidenceLayer: write.ok ? write.layer : null,
      };
    },
  };
}

// 调用方按需装配的兜底层 helper。createEvidenceSidecar 不会自动接入它们——
// 显式传给 writeRing / writeStdout 才进入降级链。

export function createRingWriter(ring = [], capacity = DEFAULT_RING_CAPACITY) {
  return async (event) => {
    ring.push(event);
    while (ring.length > capacity) ring.shift();
  };
}

export function stdoutFallbackWriter(event) {
  // 兜底层：只打印 eventId，绝不打印可能含隐私的 event 体（脱敏由上层 writePrimary 负责）。
  if (event?.eventId) console.log(`[evidence-spool] stdout fallback: ${event.eventId}`);
}