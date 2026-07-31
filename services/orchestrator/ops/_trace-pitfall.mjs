#!/usr/bin/env node
// 扫 trace → 知识库（probe_unknown，达阈值才 POST）
//
//   node ops/_trace-pitfall.mjs                      # 扫最近 7 天（含今天）
//   node ops/_trace-pitfall.mjs --date 2026-07-30    # 只扫某一天
//   node ops/_trace-pitfall.mjs --dry-run            # 只输出，不 POST
//   node ops/_trace-pitfall.mjs --since-hour 2       # 只看最近 N 小时（相对 now）
//   node ops/_trace-pitfall.mjs --confirm            # 真实 POST（仅人手动触发）
//   node ops/_trace-pitfall.mjs --evidence "kind:biz op:like" --json  # 只读证据模式
//
// 升级门槛（硬规则）：
//   - 单次失败 → 只记 trace，不写知识库
//   - 同一签名（kind+deviceKey+op+normalizedError）滚动 7 天内 ≥2 次，或 ≥2 台设备同一签名 → POST
// 只写 lifecycle=probe_unknown，绝不自动升 active_blocker/backlog。
// 多机条件按 kind+op+norm（不含 deviceKey）聚设备数；deviceKey = serial || alias || "?"。
// 业务层（kind:biz）失败也按同一阈值 POST，id 前缀 auto-biz-，content 带 attempts/ok-rate。
// --evidence <query> 只读证据模式（不 POST），--json 输出供 Mac 复验比对。
//
// 依赖：Windows 本机 registry http://127.0.0.1:17930；node:fs / node:child_process / node:path / node:crypto
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

const TRACE_DIR = process.env.XHS_TRACE_DIR || "C:/Users/Public/xhs-agent-runs/ops-trace";
const REGISTRY = "http://127.0.0.1:17930";
const WINDOW_DAYS = 7;          // 滚动窗口
const REPEAT_THRESHOLD = 2;     // 同一签名次数
const DRY_RUN = !flag("--confirm");
const DATE_OVERRIDE = opt("--date", null); // YYYY-MM-DD
const SINCE_HOUR = Number(opt("--since-hour", "0") || 0);

function hash8(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

// ---- 行级辅助 ----
function deviceKeyOf(r) { return String(r.serial || r.alias || "?"); }
function rowKind(r) { return r.kind === "biz" ? "biz" : "mech"; }
function isFailure(r) { return r.kind === "biz" ? r.outcome === "fail" : r.ok === false; }

// 归一化 error：去路径/数字序列/pid/时间戳/ip，截前 80 字符，保证同坑不同参数不裂签名。
function normalizeError(e) {
  return String(e || "")
    .replace(/[A-Za-z]:[\\/][^\s,;)"'\]]+/g, "<path>")   // C:\... /tmp/...
    .replace(/\/[A-Za-z0-9._-]+\.(?:xml|png|json|mjs)/g, "/<file>") // 文件路径
    .replace(/\b\d{5,}\b/g, "<n>")                          // ≥5 位数字
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, "<ts>")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// ---- 证据查询解析 ----
function parseEvidenceQuery(terms) {
  const q = { kind: null, ops: [], serials: [], aliases: [], outcomes: [], bare: [] };
  for (const t of terms) {
    if (!t) continue;
    if (t === "kind:all") { q.kind = "all"; continue; }
    const m = t.match(/^(kind|op|serial|alias|outcome):(.+)$/);
    if (m) {
      const [, k, v] = m;
      if (k === "kind") q.kind = v;
      else if (k === "op") q.ops.push(v);
      else if (k === "serial") q.serials.push(v);
      else if (k === "alias") q.aliases.push(v);
      else if (k === "outcome") q.outcomes.push(v);
    } else {
      q.bare.push(t.toLowerCase());
    }
  }
  return q;
}

function structuralMatch(q, r) {
  const kind = rowKind(r);
  if (q.kind && q.kind !== "all" && kind !== q.kind) return false;
  if (q.ops.length && !q.ops.includes(r.op)) return false;
  if (q.serials.length && !q.serials.includes(String(r.serial || ""))) return false;
  if (q.aliases.length && !q.aliases.includes(String(r.alias || ""))) return false;
  return true;
}

function fullMatch(q, r) {
  if (!structuralMatch(q, r)) return false;
  if (q.outcomes.length) {
    if (rowKind(r) !== "biz") return false; // mech 行无 outcome，outcome 过滤仅 biz
    if (!q.outcomes.includes(r.outcome)) return false;
  }
  if (q.bare.length) {
    const norm = normalizeError(r.error || r.reason || "").toLowerCase();
    for (const b of q.bare) if (!norm.includes(b)) return false;
  }
  return true;
}

// ---- 签名聚合 ----
function aggregate(rows) {
  const agg = new Map(); // `${kind}|${op}|${norm}` -> {kind,op,norm,count,firstTs,lastTs,devices:Set,perDevice:Map,perDay:Map,aliases:Set,errors:[]}
  for (const r of rows) {
    if (!isFailure(r)) continue;
    const kind = rowKind(r);
    const norm = normalizeError(r.error || r.reason || "");
    const dk = deviceKeyOf(r);
    const key = `${kind}|${r.op || "?"}|${norm}`;
    let a = agg.get(key);
    if (!a) {
      a = { kind, op: r.op || "?", norm, count: 0, firstTs: r.ts, lastTs: r.ts, devices: new Set(), perDevice: new Map(), perDay: new Map(), aliases: new Set(), errors: [] };
      agg.set(key, a);
    }
    a.count += 1;
    a.devices.add(dk);
    a.perDevice.set(dk, (a.perDevice.get(dk) || 0) + 1);
    a.perDay.set(r._date, (a.perDay.get(r._date) || 0) + 1);
    a.aliases.add(String(r.alias || ""));
    a.errors.push(r.error || r.reason || "");
    if (r.ts && r.ts < a.firstTs) a.firstTs = r.ts;
    if (r.ts && r.ts > a.lastTs) a.lastTs = r.ts;
  }
  return agg;
}

// ---- op 级 tally（biz 行） ----
function opTallyFor(rows, op) {
  let total = 0, ok = 0, fail = 0, skip = 0, dryRun = 0;
  for (const r of rows) {
    if (rowKind(r) !== "biz" || r.op !== op) continue;
    total += 1;
    const o = r.outcome || "fail";
    if (o === "ok") ok++;
    else if (o === "fail") fail++;
    else if (o === "skip") skip++;
    else if (o === "dry-run") dryRun++;
    else fail++;
  }
  const attempts = ok + fail;
  return { total, ok, fail, skip, dryRun, attempts, okRate: attempts ? +(ok / attempts).toFixed(3) : null };
}

function localHttpGet(url, timeoutMs = 8000) {
  return execFileSync(process.execPath, [
    "-e",
    `const http=require('http');http.get(${JSON.stringify(url)},{timeout:${timeoutMs}},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>process.stdout.write(Buffer.concat(a)))}).on('error',e=>{console.error(e.message);process.exit(1)})`,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 2000 });
}

function localHttpPost(url, body) {
  return execFileSync(process.execPath, [
    "-e",
    `const http=require('http');const b=process.env.__POST_BODY;const data=JSON.stringify(JSON.parse(b));const r=http.request(${JSON.stringify(url)},{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{const a=[];res.on('data',d=>a.push(d));res.on('end',()=>process.stdout.write(Buffer.concat(a)))});r.on('error',e=>{console.error(e.message);process.exit(1)});r.write(data);r.end();`,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 12000, env: { ...process.env, __POST_BODY: JSON.stringify(body) } });
}

function listTraceDates() {
  let files;
  try { files = readdirSync(TRACE_DIR); } catch { return []; }
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
}

function readTraceFile(date) {
  const p = join(TRACE_DIR, `${String(date).replace(/\.jsonl$/, "")}.jsonl`);
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return rows;
}

// ---- 证据模式（只读，不 POST） ----
function runEvidence(qRaw, rows, dates) {
  const q = parseEvidenceQuery(qRaw.split(/\s+/).filter(Boolean));
  const structRows = rows.filter((r) => structuralMatch(q, r));
  const matchRows = structRows.filter((r) => isFailure(r) && fullMatch(q, r));
  const agg = aggregate(matchRows);

  // biz op 级 tally（structRows 中该 op 的全部 biz 行）
  const bizTally = new Map();
  for (const r of structRows) {
    if (rowKind(r) !== "biz") continue;
    const o = r.op || "?";
    if (!bizTally.has(o)) bizTally.set(o, opTallyFor(structRows, o));
  }

  const matched = [];
  for (const a of agg.values()) {
    const via = a.devices.size >= 2 ? "multi-device" : (a.count >= REPEAT_THRESHOLD ? "repeat" : null);
    const tally = a.kind === "biz" ? bizTally.get(a.op) : null;
    matched.push({
      kind: a.kind, op: a.op, norm: a.norm,
      count: a.count,
      perDay: Object.fromEntries([...a.perDay].sort()),
      devices: [...a.devices].sort(),
      aliases: [...a.aliases].filter(Boolean).sort(),
      perSerial: Object.fromEntries([...a.perDevice].sort()),
      firstTs: a.firstTs, lastTs: a.lastTs,
      sampleErrors: a.errors.slice(0, 3),
      ...(tally ? { attempts: tally.attempts, failures: tally.fail, ok: tally.ok, skip: tally.skip, dryRun: tally.dryRun, okRate: tally.okRate } : {}),
      qualified: via !== null,
      qualifiedVia: via,
    });
  }

  // 统计
  let mechFail = 0, bizFail = 0;
  for (const r of rows) {
    if (!isFailure(r)) continue;
    if (rowKind(r) === "biz") bizFail++; else mechFail++;
  }
  let bizTot = { total: 0, ok: 0, fail: 0, skip: 0, dryRun: 0 };
  for (const t of bizTally.values()) { bizTot.total += t.total; bizTot.ok += t.ok; bizTot.fail += t.fail; bizTot.skip += t.skip; bizTot.dryRun += t.dryRun; }

  const command = `node ops/_trace-pitfall.mjs --evidence "${qRaw}" --json`;
  const reVerify = `ssh xhs-windows 'node C:\\Users\\Public\\xhs-registry\\ops\\_trace-pitfall.mjs --evidence "${qRaw}" --json'`;

  const out = {
    ok: true, mode: "evidence",
    command, reVerify,
    scanned: TRACE_DIR,
    window: { dates, windowDays: WINDOW_DAYS, sinceHour: SINCE_HOUR },
    query: { kind: q.kind || "all", ops: q.ops, serials: q.serials, aliases: q.aliases, outcomes: q.outcomes, bareTokens: q.bare },
    rowsScanned: rows.length,
    totalFailures: mechFail + bizFail,
    totalBizAttempts: bizTot.total,
    matched,
  };

  if (flag("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`TRACE DIR: ${TRACE_DIR}`);
    console.log(`WINDOW: ${dates.join("..")} (${dates.length} files)`);
    console.log(`COMMAND: ${command}`);
    console.log(`RE-VERIFY (Mac): ${reVerify}`);
    console.log(`rows scanned: ${rows.length} | failures: ${mechFail + bizFail} (mech ${mechFail} / biz ${bizFail})`);
    if (bizTot.total) console.log(`biz attempts: ${bizTot.total} (ok ${bizTot.ok} / fail ${bizTot.fail} / skip ${bizTot.skip} / dry-run ${bizTot.dryRun})`);
    console.log(`matched signatures: ${matched.length}`);
    for (const m of matched) {
      const tag = m.kind === "biz" ? "[biz]" : "[mech]";
      console.log(`\n${tag} op=${m.op}  norm=${m.norm.slice(0, 60)}`);
      console.log(`  failures: ${m.count} | devices: ${m.devices.join(", ")}`);
      if (m.attempts != null) console.log(`  attempts: ${m.attempts} | ok-rate: ${Math.round((m.okRate || 0) * 100)}% (ok ${m.ok} / fail ${m.failures} / skip ${m.skip} / dry-run ${m.dryRun})`);
      console.log(`  per-day: ${Object.entries(m.perDay).map(([d, c]) => `${d}:${c}`).join("  ")}`);
      console.log(`  qualified: ${m.qualified} (${m.qualifiedVia || "no"})`);
    }
  }
}

// ---- 默认扫描 + POST ----
function main() {
  let dates;
  if (DATE_OVERRIDE) {
    dates = [DATE_OVERRIDE];
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const all = listTraceDates();
    dates = all.filter((d) => d.slice(0, 10) <= today).slice(-WINDOW_DAYS);
    if (SINCE_HOUR > 0) dates = all.slice(-1);
  }
  if (!dates.length) {
    console.log("no trace files found in " + TRACE_DIR);
    return;
  }

  // 读全部日期
  const rows = [];
  const bizOpTally = new Map(); // op -> {total, ok, fail, skip, dryRun}
  const cutoff = SINCE_HOUR > 0 ? Date.now() - SINCE_HOUR * 3600 * 1000 : 0;
  for (const d of dates) {
    for (const r of readTraceFile(d)) {
      if (cutoff && Date.parse(r.ts || "") < cutoff) continue;
      r._date = d;
      rows.push(r);
      if (rowKind(r) === "biz") {
        const o = r.op || "?";
        const t = bizOpTally.get(o) || { total: 0, ok: 0, fail: 0, skip: 0, dryRun: 0 };
        t.total += 1;
        const oc = r.outcome || "fail";
        if (oc === "ok") t.ok++; else if (oc === "fail") t.fail++; else if (oc === "skip") t.skip++; else if (oc === "dry-run") t.dryRun++; else t.fail++;
        bizOpTally.set(o, t);
      }
    }
  }

  // 证据模式（只读，不 POST）
  const evidenceQuery = opt("--evidence");
  if (evidenceQuery != null) { runEvidence(evidenceQuery, rows, dates); return; }

  // 签名聚合（按 kind|op|norm 跨 deviceKey 汇总）
  const agg = aggregate(rows);

  // 统计
  let mechFail = 0, bizFail = 0;
  for (const r of rows) {
    if (!isFailure(r)) continue;
    if (rowKind(r) === "biz") bizFail++; else mechFail++;
  }
  let bizTot = { total: 0, ok: 0, fail: 0, skip: 0, dryRun: 0 };
  for (const t of bizOpTally.values()) { bizTot.total += t.total; bizTot.ok += t.ok; bizTot.fail += t.fail; bizTot.skip += t.skip; bizTot.dryRun += t.dryRun; }

  // 达阈值
  const qualified = [];
  for (const a of agg.values()) {
    const via = a.devices.size >= 2 ? "multi-device" : (a.count >= REPEAT_THRESHOLD ? "repeat" : null);
    if (via) qualified.push({ ...a, qualifiedVia: via });
  }

  console.log(`trace files: ${dates.join(", ")}`);
  console.log(`sessions failures (ok:false rows): ${mechFail}`);
  if (bizFail) console.log(`biz failures (kind:biz fail): ${bizFail}`);
  if (bizTot.total) console.log(`biz attempts: ${bizTot.total} (ok ${bizTot.ok} / fail ${bizTot.fail} / skip ${bizTot.skip} / dry-run ${bizTot.dryRun})`);
  console.log(`distinct signatures: ${agg.size}`);
  console.log(`qualified (repeat>=${REPEAT_THRESHOLD} or multi-device): ${qualified.length}`);

  // POST
  let created = 0, skipped = 0, wouldCreate = 0;
  for (const a of qualified) {
    const multi = a.qualifiedVia === "multi-device";
    const deviceKey = multi ? "multi" : [...a.devices][0];
    const firstAlias = [...a.aliases].find(Boolean) || deviceKey;
    const kindTag = a.kind === "biz" ? "biz|" : "";
    const hashBase = multi ? `${kindTag}multi|${a.op}|${a.norm}` : `${kindTag}${deviceKey}|${a.op}|${a.norm}`;
    const sigHash = hash8(hashBase);
    const id = `auto-${a.kind === "biz" ? "biz-" : ""}${multi ? `multi-${a.devices.size}` : deviceKey}-${a.op}-${sigHash}`;
    const title = `[auto]${a.kind === "biz" ? "[biz]" : ""} ${multi ? `multi-device(${a.devices.size})` : firstAlias} ${a.op} failure: ${a.norm.slice(0, 60)}`;
    const devices = [...a.devices].sort().join(", ");
    const tally = a.kind === "biz" ? bizOpTally.get(a.op) : null;
    const content =
      `Auto-detected from trace ${a.firstTs}..${a.lastTs}.\n\n` +
      `Devices: ${devices}\nAlias: ${firstAlias}\nOp: ${a.op}\n` +
      `Occurrences: ${a.count} across ${a.devices.size} device(s)\n` +
      (tally ? `Attempts/ok-rate: ${tally.ok + tally.fail} attempts, ${tally.ok + tally.fail ? Math.round(tally.ok / (tally.ok + tally.fail) * 100) : 0}% ok (ok ${tally.ok} / fail ${tally.fail} / skip ${tally.skip} / dry-run ${tally.dryRun})\n` : "") +
      `First/Last: ${a.firstTs} / ${a.lastTs}\n\n` +
      `Sample errors:\n${a.errors.slice(0, 3).map((e) => "  - " + String(e).slice(0, 300)).join("\n")}\n\n` +
      `Context dumps (if any): C:\\Users\\Public\\xhs-agent-runs\\ops-trace\\context\\${multi ? "fail-<serial>-* (per device)" : `fail-${deviceKey}-*`}\n` +
      `Steps: view context dump -> reproduce -> classify transient or persistent`;

    // 已存在检查
    const qs = encodeURIComponent(`${a.op} ${a.norm}`);
    let existing = false;
    try {
      const resp = localHttpGet(`${REGISTRY}/api/knowledge?q=${qs}`);
      const j = JSON.parse(resp);
      const hit = (j.knowledge || []).some((x) => {
        const title = String(x.title || "");
        return title.includes("auto-") && (title.includes(a.op) || (deviceKey !== "multi" && title.includes(deviceKey)));
      });
      existing = hit;
    } catch { /* assume not existing */ }
    if (existing) { skipped += 1; continue; }

    const body = {
      id, app: "xhs", category: "pitfall", lifecycle: "probe_unknown",
      title, content,
      appliesTo: [...a.devices],
      verifyMode: "human",
      steps: ["查看 context dump", "复现", "判断偶发/持久"],
    };

    if (DRY_RUN) {
      wouldCreate += 1;
      console.log(`  [dry-run] would POST ${id}`);
      continue;
    }
    try {
      const resp = localHttpPost(`${REGISTRY}/api/knowledge`, body);
      const j = JSON.parse(resp);
      if (j.ok) created += 1;
      else skipped += 1;
    } catch (e) {
      console.log(`  [post failed] ${id}: ${String(e.message || e).slice(0, 120)}`);
      skipped += 1;
    }
  }

  console.log(`---`);
  console.log(`created: ${created} | skipped(dup/post-fail): ${skipped} | would-create(dry-run): ${wouldCreate}`);
}

main();
