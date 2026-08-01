import assert from "node:assert/strict";
import test from "node:test";

import { createRunContext, runContextFingerprint } from "../ops/_run-context.mjs";

test("createRunContext carries the unified run/effect/release/schema/policy fields and freezes them", () => {
  const ctx = createRunContext({
    runId: "run-42",
    flow: "explore",
    branch: "main",
    effectId: "eff-1",
    actor: "agent:hermes",
    app: "xhs",
    device: "serial-01",
    job: "job-9",
    session: "sess-3",
    lease: "lease-1",
    sequence: 7,
    releaseId: "rel-2026-08-01",
    policyMode: "shadow",
  });
  assert.equal(ctx.runId, "run-42");
  assert.equal(ctx.effectId, "eff-1");
  assert.equal(ctx.releaseId, "rel-2026-08-01");
  assert.equal(ctx.schemaVersion, "xhs.run-context.v1");
  assert.equal(ctx.policyMode, "shadow");
  assert.equal(ctx.sequence, 7);
  assert.equal(Object.isFrozen(ctx), true);
  assert.throws(() => { ctx.runId = "x"; }, TypeError);
});

test("createRunContext fills defaults for schemaVersion/policyMode/sequence and requires runId + actor", () => {
  const ctx = createRunContext({ runId: "run-1", actor: "agent:hermes", app: "xhs" });
  assert.equal(ctx.schemaVersion, "xhs.run-context.v1");
  assert.equal(ctx.policyMode, "legacy"); // 默认 legacy，不假设 shadow 已铺开
  assert.equal(ctx.sequence, 0);
  assert.equal(ctx.flow, null);
  assert.throws(() => createRunContext({ actor: "a" }), /runId/);
  assert.throws(() => createRunContext({ runId: "r" }), /actor/);
});

test("withEffect derives a new context with a new effectId and bumped sequence (immutable)", () => {
  const ctx = createRunContext({ runId: "run-1", actor: "agent:hermes", sequence: 5 });
  const next = ctx.withEffect("eff-2");
  assert.equal(next.effectId, "eff-2");
  assert.equal(next.sequence, 6, "sequence must bump on each derived effect");
  assert.equal(ctx.sequence, 5, "original context untouched");
  assert.notEqual(next, ctx);
  assert.equal(Object.isFrozen(next), true);
});

test("runContextFingerprint is deterministic across key-order variations and stable for equal content", () => {
  const a = createRunContext({ runId: "run-1", actor: "agent:hermes", app: "xhs", effectId: "eff-1", sequence: 1 });
  const fp1 = runContextFingerprint(a);
  // 重新构造一个字段顺序不同的等价上下文 → 同一指纹（canonical key sort）
  const b = createRunContext({ sequence: 1, effectId: "eff-1", app: "xhs", actor: "agent:hermes", runId: "run-1" });
  assert.equal(runContextFingerprint(b), fp1);
  // 改任一字段 → 指纹变
  const c = createRunContext({ runId: "run-1", actor: "agent:hermes", app: "xhs", effectId: "eff-2", sequence: 1 });
  assert.notEqual(runContextFingerprint(c), fp1);
});

test("policyMode is constrained to the known set; unknown mode throws", () => {
  assert.throws(() => createRunContext({ runId: "r", actor: "a", policyMode: "aggressive" }), /policyMode/);
  for (const mode of ["legacy", "shadow", "v1", "staging"]) {
    assert.doesNotThrow(() => createRunContext({ runId: "r", actor: "a", policyMode: mode }));
  }
});
// ─── _evidence-ledger：写失败不 throw 到业务层，runWithEvidence 跑 action 恰好一次 ───

import { createEvidenceLedger, artifactFingerprint } from "../ops/_evidence-ledger.mjs";

test("evidence ledger: write failure becomes debt, never throws to business layer", async () => {
  const ledger = createEvidenceLedger({
    writePrimary: async () => { throw Object.assign(new Error("sqlite locked"), { code: "SQLITE_LOCKED" }); },
    writeSpool: async () => { throw Object.assign(new Error("spool gone"), { code: "ENOENT" }); },
  });
  const ctx = createRunContext({ runId: "run-l", actor: "agent:hermes", effectId: "eff-1" });
  // prepare/outcome 写失败不抛
  const r = await ledger.outcome(ctx, { ok: true });
  assert.equal(r.ok, false);
  assert.equal(ledger.debt.length, 1);
  assert.equal(ledger.debt[0].code, "ENOENT");
});

test("evidence ledger runWithEvidence runs action exactly once even when all writers fail", async () => {
  let actionCalls = 0;
  const ledger = createEvidenceLedger({
    writePrimary: async () => { throw new Error("fail"); },
    writeSpool: async () => { throw new Error("fail"); },
    writeRing: null, // 摘掉 ring 兜底，强制落 debt
  });
  const ctx = createRunContext({ runId: "run-l2", actor: "agent:hermes", effectId: "eff-1" });
  const out = await ledger.runWithEvidence(ctx, async () => { actionCalls += 1; return { ok: true }; });
  assert.equal(actionCalls, 1, "action must run exactly once regardless of evidence failure");
  assert.equal(out.result.ok, true);
  assert.ok(out.debt.length > 0, "evidence failure recorded as debt");
});

test("evidence ledger: successful primary write records no debt and threads run-context fields", async () => {
  const written = [];
  const ledger = createEvidenceLedger({ writePrimary: async (e) => { written.push(e); } });
  const ctx = createRunContext({ runId: "run-l3", actor: "agent:hermes", effectId: "eff-9", policyMode: "shadow" });
  await ledger.outcome(ctx, { ok: true });
  assert.equal(ledger.debt.length, 0);
  assert.equal(written[0].runId, "run-l3");
  assert.equal(written[0].policyMode, "shadow");
  assert.equal(written[0].schemaVersion, "xhs.evidence-ledger.v1");
});

test("artifactFingerprint is deterministic for same path+bytes", () => {
  const a = artifactFingerprint("/tmp/x.png", 1024);
  const b = artifactFingerprint("/tmp/x.png", 1024);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(artifactFingerprint("/tmp/x.png", 1025), a);
});
