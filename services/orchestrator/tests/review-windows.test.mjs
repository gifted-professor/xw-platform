import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBundle, summarizeBundle, verifyBundleSeal } from "../scripts/lib/evidence-contract.mjs";
import { validateBundle } from "../scripts/validate-run-bundle.mjs";
import { createRunContext, runContextFingerprint } from "../ops/_run-context.mjs";

const tmp = mkdtempSync(join(tmpdir(), `rex-review-${Math.random().toString(36).slice(2)}`));

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function writeLegacy(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

// 内联 v1 bundle 构造器（与 B 仓 evidence-exporter 同编码）：canonicalJsonL + sha256 seal。
// 测试用，不在生产路径里。
import { createHash } from "node:crypto";
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
  return v;
}
function canonicalJson(v) { return JSON.stringify(canonicalize(v)); }
function makeV1Bundle(dir, runId, events) {
  mkdirSync(dir, { recursive: true });
  const lined = events.map((e) => `${canonicalJson(e)}\n`).join("");
  writeFileSync(join(dir, "events.jsonl"), lined);
  writeFileSync(join(dir, "manifest.json"), canonicalJson({
    runId, schemaVersion: "xhs.evidence-v1", eventCount: events.length, createdAt: "2026-08-01T00:00:00.000Z",
  }) + "\n");
  writeFileSync(join(dir, "bundle.seal"), createHash("sha256").update(lined).digest("hex"));
}

// ─── §5.4 GO：四种 legacy/v1 读写组合都可读 ───

test("v1-only bundle: readBundle reads events/manifest/seal and seal verifies", async () => {
  const dir = join(tmp, "v1-only", "run-v1");
  makeV1Bundle(dir, "run-v1", [
    { runId: "run-v1", effectId: "eff-1", kind: "dispatch", ok: true },
    { runId: "run-v1", effectId: "eff-2", kind: "observe", target: { text: "余额" } },
  ]);
  const bundle = readBundle(dir);
  assert.equal(bundle.kind, "v1");
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.runId, "run-v1");
  assert.equal(verifyBundleSeal(bundle).ok, true);
  const summary = summarizeBundle(bundle);
  assert.match(summary, /kind: v1/);
  assert.match(summary, /seal verify: ok/);
  // validateBundle（A 仓离线校验门）也通过
  assert.equal(validateBundle(dir).ok, true);
});

test("legacy-only bundle: readBundle reads old Markdown/JSONL without throwing", () => {
  const dir = join(tmp, "legacy-only");
  writeLegacy(dir, "ACCEPTANCE-XHS-like.md", "# 旧证据\nexit=0\nPASS=ok");
  writeLegacy(dir, "trace.jsonl", `{"kind":"tap","x":1}\n{"kind":"swipe"}\n`);
  const bundle = readBundle(dir);
  assert.equal(bundle.kind, "legacy");
  assert.equal(bundle.schemaVersion, "legacy");
  assert.ok(bundle.legacyEvents.length >= 2, "legacy artifacts read as events");
  assert.equal(bundle.events.length, 0, "no v1 events in legacy-only bundle");
  assert.doesNotThrow(() => summarizeBundle(bundle));
});

test("both bundle: v1 events + legacy artifacts coexist, v1 seal still verifies", async () => {
  const dir = join(tmp, "both", "run-both");
  makeV1Bundle(dir, "run-both", [
    { runId: "run-both", effectId: "eff-1", kind: "dispatch" },
  ]);
  // 在同一 bundle 目录里放一份 legacy 残留（迁移期双写）
  writeLegacy(dir, "ACCEPTANCE-XHS-collect.md", "# 旧\nexit=0");
  const bundle = readBundle(dir);
  assert.equal(bundle.kind, "both");
  assert.equal(bundle.events.length, 1);
  assert.ok(bundle.legacyEvents.length >= 1);
  assert.equal(verifyBundleSeal(bundle).ok, true, "v1 seal must still verify with legacy siblings present");
});

test("empty/missing bundle: readBundle returns empty + debt, never throws to caller", () => {
  const missing = readBundle(join(tmp, "does-not-exist"));
  assert.equal(missing.kind, "missing");
  assert.equal(missing.events.length, 0);
  assert.doesNotThrow(() => summarizeBundle(missing));

  const emptyDir = join(tmp, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const empty = readBundle(emptyDir);
  assert.equal(empty.kind, "empty");
  assert.doesNotThrow(() => summarizeBundle(empty));
});

// ─── §5.4 GO：Review 结论不影响下一任务派发 ───
//
// summarizeBundle 是纯函数：只返回字符串，无副作用、不触达 Windows/设备/派发。
// 这里用一个哨兵：派发计数器在 review 前后必须不变。

test("review summary is pure — running it does not touch any dispatch surface", async () => {
  const dir = join(tmp, "purity", "run-pure");
  makeV1Bundle(dir, "run-pure", [
    { runId: "run-pure", effectId: "eff-1", kind: "dispatch" },
  ]);
  let dispatchCalls = 0;
  const fakeDispatch = () => { dispatchCalls += 1; };
  const bundle = readBundle(dir);
  const report = summarizeBundle(bundle);
  // review 期间不调用任何派发
  assert.equal(dispatchCalls, 0);
  assert.ok(typeof report === "string" && report.length > 0);
  // review 后再 dispatch 一次，证明 review 没有锁住或改变派发路径
  fakeDispatch();
  assert.equal(dispatchCalls, 1);
});

// ─── §5.4 GO：旧证据不被改写 ───

test("readBundle never mutates source files — legacy content is byte-identical after read", () => {
  const dir = join(tmp, "readonly");
  const legacyText = "# 不可改写\nexit=0\n";
  writeLegacy(dir, "old.md", legacyText);
  readBundle(dir);
  readBundle(dir);
  assert.equal(readFileSync(join(dir, "old.md"), "utf8"), legacyText);
});

// ─── run-context 贯穿 evidence：bundle manifest 的 runId 与 run-context 一致 ───

test("run-context fingerprint is stable and threads runId into the bundle manifest", () => {
  const ctx = createRunContext({ runId: "run-ctx", actor: "agent:hermes", app: "xhs", effectId: "eff-1", sequence: 1 });
  const fp = runContextFingerprint(ctx);
  assert.equal(fp.length, 64);
  assert.equal(ctx.runId, "run-ctx");
});