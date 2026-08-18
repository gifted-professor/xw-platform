// _evidence-ledger.mjs — REX Phase 3 §5.2 / A4：A 仓 evidence ledger
//
// 给 ops/ 业务脚本一个统一的证据记账入口：prepare（执行前快照）/ outcome（执行后
// 结果）/ artifact（落盘文件指纹）/ spool（降级写）/ debt（终端债）。核心不变量
// （§5.4 GO + A4「写失败不 throw 到业务层」）：任何 ledger 写失败只记 debt，
// 绝不向调用方业务层抛异常——业务脚本的非支付执行不被证据失败阻塞。
//
// 与 B 仓 evidence-spool.mjs 同构：调用方注入 writePrimary/writeSpool/writeRing，
// runWithEvidence(ctx, action) 先跑 action（永远一次），再写证据，失败落 debt。
// ledger 条目携带 createRunContext 的 runId/effectId/schemaVersion/policyMode，
// 保证 A/B 共用层贯穿。

import { createHash } from "node:crypto";

export function createEvidenceLedger({
  writePrimary = null,
  writeSpool = null,
  writeRing = null,
  ring = [],
  ringCapacity = 256,
  now = () => Date.now(),
} = {}) {
  const debt = [];
  // 与 B 仓 evidence-spool 同契约：只有显式提供为函数的层才纳入降级链；
  // writeRing 未提供/null → 摘掉 ring 兜底，全失败落 debt（供故障注入测试）。
  const layers = [
    ["primary", typeof writePrimary === "function" ? writePrimary : null],
    ["spool", typeof writeSpool === "function" ? writeSpool : null],
    ["ring", typeof writeRing === "function" ? writeRing : null],
  ];

  async function attemptWrite(entry) {
    let lastError = null;
    for (const [layer, fn] of layers) {
      if (typeof fn !== "function") continue;
      try { await fn(entry); return { ok: true, layer }; }
      catch (error) { lastError = { layer, code: error?.code ?? null, message: error?.message ?? String(error) }; }
    }
    return { ok: false, lastError };
  }

  async function record(ctx, payload) {
    const entry = Object.freeze({
      schemaVersion: "xhs.evidence-ledger.v1",
      runId: ctx?.runId ?? null,
      effectId: ctx?.effectId ?? null,
      policyMode: ctx?.policyMode ?? "legacy",
      createdAt: new Date(now()).toISOString(),
      ...payload,
    });
    const write = await attemptWrite(entry);
    if (!write.ok) {
      debt.push({
        effectId: entry.effectId,
        phase: entry.phase,
        code: write.lastError?.code ?? "EVIDENCE_DEBT",
        lastLayer: write.lastError?.layer ?? null,
        cause: write.lastError?.message ?? null,
      });
      return { ok: false, debt, entry };
    }
    return { ok: true, layer: write.layer, entry };
  }

  return {
    ring,
    debt,
    prepare: (ctx, snapshot) => record(ctx, { phase: "prepare", snapshot }),
    outcome: (ctx, result) => record(ctx, { phase: "outcome", result }),
    artifact: (ctx, { file, sha256, bytes }) => record(ctx, { phase: "artifact", file, sha256, bytes }),
    // 业务执行 + 证据记账一体：action 先跑、永远一次；证据失败只落 debt，不抛业务层。
    async runWithEvidence(ctx, action) {
      const result = await action();
      await record(ctx, { phase: "outcome", result });
      return { result, debt };
    },
  };
}

// 调用方按需装配的进程内 ring 兜底层；createEvidenceLedger 不自动接入——
// 显式传给 writeRing 才进入降级链。
export function createLedgerRingWriter(ring = [], capacity = 256) {
  return async (entry) => {
    ring.push(entry);
    while (ring.length > capacity) ring.shift();
  };
}

function makeRingWriter(ring, capacity) {
  return createLedgerRingWriter(ring, capacity);
}

export function artifactFingerprint(filePath, bytes) {
  // 文件指纹：path + bytes 的 sha256（内容 hash 由调用方对实际文件算好后传入）。
  return createHash("sha256").update(`${filePath}:${bytes ?? 0}`).digest("hex");
}