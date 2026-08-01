// evidence-contract.mjs — REX Phase 3 §5.2 item 5 / A2：A 仓统一 evidence reader helper
//
// 同时读 legacy 与 v1 两类证据 bundle，对外暴露统一 readBundle(dir) →
// { kind, schemaVersion, runId, events, manifest, debt, seals }。四种组合都可读：
//   - legacy-only：旧 Markdown/JSONL（无 bundle.seal）
//   - v1-only：events.jsonl + manifest.json + bundle.seal（见 B 仓 evidence-exporter）
//   - both：v1 优先，legacy 作 fallback 附在 legacyEvents
//   - neither：空 bundle（只读，绝不 throw 到业务层；返回 debt 记号）
//
// 只读源、绝不原地改写历史。读取失败只记 debt，不抛到调用方业务层（§5.4 GO）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const V1_SCHEMA = "xhs.evidence-v1";

export function detectBundleKind(dir) {
  if (!existsSync(dir)) return "missing";
  const hasV1 = existsSync(join(dir, "events.jsonl")) && existsSync(join(dir, "bundle.seal"));
  const hasLegacy = hasLegacyArtifacts(dir);
  if (hasV1 && hasLegacy) return "both";
  if (hasV1) return "v1";
  if (hasLegacy) return "legacy";
  return "empty";
}

function hasLegacyArtifacts(dir) {
  try {
    const entries = readdirSync(dir);
    return entries.some((n) => /\.(md|jsonl|json)$/i.test(n) && n !== "events.jsonl" && n !== "manifest.json" && n !== "bundle.seal");
  } catch {
    return false;
  }
}

export function readBundle(dir) {
  const kind = detectBundleKind(dir);
  const debt = [];
  if (kind === "missing" || kind === "empty") {
    return { dir, kind, schemaVersion: null, runId: null, events: [], manifest: null, seals: [], debt };
  }

  let events = [];
  let manifest = null;
  let seals = [];
  let runId = null;

  if (kind === "v1" || kind === "both") {
    try {
      events = readJsonl(join(dir, "events.jsonl"));
    } catch (error) {
      debt.push({ layer: "v1-events", code: error.code ?? "READ_FAIL", cause: error.message });
    }
    try {
      manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      runId = manifest.runId ?? null;
    } catch (error) {
      debt.push({ layer: "v1-manifest", code: error.code ?? "READ_FAIL", cause: error.message });
    }
    try {
      seals.push({ file: "bundle.seal", hash: readFileSync(join(dir, "bundle.seal"), "utf8").trim() });
    } catch (error) {
      debt.push({ layer: "v1-seal", code: error.code ?? "READ_FAIL", cause: error.message });
    }
  }

  const legacyEvents = [];
  if (kind === "legacy" || kind === "both") {
    for (const event of readLegacyEvents(dir)) legacyEvents.push(event);
  }

  return {
    dir,
    kind,
    schemaVersion: manifest?.schemaVersion ?? (kind === "legacy" ? "legacy" : V1_SCHEMA),
    runId,
    events,
    legacyEvents,
    manifest,
    seals,
    debt,
  };
}

export function verifyBundleSeal(bundle) {
  if (bundle.kind !== "v1" && bundle.kind !== "both") return { ok: true, reason: "no v1 seal to verify" };
  const seal = bundle.seals.find((s) => s.file === "bundle.seal");
  if (!seal) return { ok: false, reason: "missing bundle.seal" };
  const content = bundle.events.map((e) => canonicalJson(e)).join("") + (bundle.events.length ? "" : "");
  // events.jsonl 用 canonicalJson(event)+"\n" 逐行拼接；这里重算需带换行。
  const lined = bundle.events.map((e) => `${canonicalJson(e)}\n`).join("");
  const expected = sha256(lined);
  if (seal.hash !== expected) return { ok: false, reason: "seal mismatch (bundle tampered)", expected, actual: seal.hash };
  return { ok: true, sealHash: seal.hash };
}

function readJsonl(path) {
  const text = readFileSync(path, "utf8");
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function readLegacyEvents(dir) {
  // legacy：把 .md/.jsonl/.json（非 v1 文件）原样读成 { file, text } 事件，不改写。
  const out = [];
  for (const name of readdirSync(dir)) {
    if (["events.jsonl", "manifest.json", "bundle.seal"].includes(name)) continue;
    if (!/\.(md|jsonl|json)$/i.test(name)) continue;
    try {
      out.push({ file: name, text: readFileSync(join(dir, name), "utf8"), schemaVersion: "legacy" });
    } catch {
      // 读失败不 throw，跳过（上层 debt 已由 readBundle 兜底）
    }
  }
  return out;
}

// summarizeBundle — 纯函数，把一个 readBundle 结果渲染成 Markdown 事实摘要。
// 只读、只输出字符串，绝不触发 Windows/设备/派发（§5.4 GO「Review 结论不影响下一任务派发」）。
export function summarizeBundle(bundle) {
  const lines = [];
  lines.push(`### bundle ${bundle.runId ?? "(no runId)"} — kind: ${bundle.kind}`);
  lines.push(`- schemaVersion: ${bundle.schemaVersion ?? "—"}`);
  lines.push(`- v1 events: ${bundle.events.length}`);
  lines.push(`- legacy artifacts: ${bundle.legacyEvents?.length ?? 0}`);
  lines.push(`- seals: ${bundle.seals.length ? bundle.seals.map((s) => s.hash.slice(0, 12)).join(", ") : "—"}`);
  const verify = verifyBundleSeal(bundle);
  lines.push(`- seal verify: ${verify.ok ? "ok" : "FAIL — " + (verify.reason ?? "")}`);
  if (bundle.debt.length) {
    lines.push(`- evidence debt (${bundle.debt.length}):`);
    for (const d of bundle.debt) lines.push(`  - [${d.layer}] ${d.code}: ${d.cause}`);
  } else {
    lines.push(`- evidence debt: 0`);
  }
  return lines.join("\n");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }