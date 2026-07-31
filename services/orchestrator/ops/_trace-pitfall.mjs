#!/usr/bin/env node
// 扫 trace → 知识库（probe_unknown，达阈值才 POST）
//
//   node ops/_trace-pitfall.mjs                      # 扫最近 7 天（含今天）
//   node ops/_trace-pitfall.mjs --date 2026-07-30    # 只扫某一天
//   node ops/_trace-pitfall.mjs --dry-run            # 只输出，不 POST
//   node ops/_trace-pitfall.mjs --since-hour 2       # 只看最近 N 小时（相对 now）
//   node ops/_trace-pitfall.mjs --confirm            # 真实 POST（仅人手动触发）
//
// 升级门槛（硬规则）：
//   - 单次失败 → 只记 trace，不写知识库
//   - 同一签名（serial+op+normalizedError）滚动 7 天内 ≥2 次，或 ≥2 台设备同一签名 → POST
// 只写 lifecycle=probe_unknown，绝不自动升 active_blocker/backlog。
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

const TRACE_DIR = "C:/Users/Public/xhs-agent-runs/ops-trace";
const REGISTRY = "http://127.0.0.1:17930";
const WINDOW_DAYS = 7;          // 滚动窗口
const REPEAT_THRESHOLD = 2;     // 同一签名次数
const DRY_RUN = !flag("--confirm");
const DATE_OVERRIDE = opt("--date", null); // YYYY-MM-DD
const SINCE_HOUR = Number(opt("--since-hour", "0") || 0);

function hash8(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

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

function signatureOf(serial, op, error) {
  return { serial, op, norm: normalizeError(error) };
}

function sigKey(s) {
  return `${s.serial}|${s.op}|${s.norm}`;
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
  // date 可能带扩展名（来自 listTraceDates）或不带（来自 --date），统一去重
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

function main() {
  let dates;
  if (DATE_OVERRIDE) {
    dates = [DATE_OVERRIDE];
  } else {
    // 最近 7 天（含今天）
    const today = new Date().toISOString().slice(0, 10);
    const all = listTraceDates();
    // 注意 d 是 "YYYY-MM-DD.jsonl"，比日期串长——必须 slice(0,10) 再比，否则永远 > today
    dates = all.filter((d) => d.slice(0, 10) <= today).slice(-WINDOW_DAYS);
    if (SINCE_HOUR > 0) dates = all.slice(-1); // since-hour 只看最新文件，行级过滤
  }
  if (!dates.length) {
    console.log("no trace files found in " + TRACE_DIR);
    return;
  }

  // 读全部日期 → 收集失败行
  const rowsByDate = {};
  let allFail = [];
  for (const d of dates) {
    const rows = readTraceFile(d);
    rowsByDate[d] = rows;
    const cutoff = SINCE_HOUR > 0 ? Date.now() - SINCE_HOUR * 3600 * 1000 : 0;
    for (const r of rows) {
      if (r.ok === false) {
        if (cutoff && Date.parse(r.ts || "") < cutoff) continue;
        allFail.push({ ...r, _date: d });
      }
    }
  }

  // 签名 → 次数 + 设备集合
  const sigCount = new Map(); // sigKey -> {count, firstTs, lastTs, serials:Set, ops:Set, alias, errors:[]}
  for (const f of allFail) {
    const sig = signatureOf(f.serial, f.op, f.error);
    const k = sigKey(sig);
    const e = sigCount.get(k) || { count: 0, firstTs: f.ts, lastTs: f.ts, serials: new Set(), alias: f.alias, errors: [] };
    e.count += 1;
    e.serials.add(f.serial);
    e.errors.push(f.error);
    if (f.ts < e.firstTs) e.firstTs = f.ts;
    if (f.ts > e.lastTs) e.lastTs = f.ts;
    sigCount.set(k, e);
  }

  // 达阈值：同签名 ≥2 次，或 ≥2 台设备
  const qualified = [];
  for (const [k, e] of sigCount) {
    const [serial, op, norm] = k.split("|");
    const multiDevice = e.serials.size >= 2;
    const repeat = e.count >= REPEAT_THRESHOLD;
    if (repeat || multiDevice) {
      qualified.push({ serial, op, norm, ...e });
    }
  }

  console.log(`trace files: ${dates.join(", ")}`);
  console.log(`sessions failures (ok:false rows): ${allFail.length}`);
  console.log(`distinct signatures: ${sigCount.size}`);
  console.log(`qualified (repeat>=${REPEAT_THRESHOLD} or multi-device): ${qualified.length}`);

  // 已存在检查
  let created = 0, skipped = 0, wouldCreate = 0;
  for (const q of qualified) {
    const qs = encodeURIComponent(`${q.op} ${q.norm}`);
    let existing = false;
    try {
      const resp = localHttpGet(`${REGISTRY}/api/knowledge?q=${qs}`);
      const j = JSON.parse(resp);
      const hit = (j.knowledge || []).some((x) => {
        const title = String(x.title || "");
        return title.includes("auto-") && (title.includes(q.op) || title.includes(q.serial));
      });
      existing = hit;
    } catch { /* query failed → assume not existing, will 409-guard on POST */ }

    if (existing) { skipped += 1; continue; }

    const sigHash = hash8(`${q.serial}|${q.op}|${q.norm}`);
    const id = `auto-${q.serial}-${q.op}-${sigHash}`;
    const title = `[auto] ${q.alias || q.serial} ${q.op} failure: ${q.norm.slice(0, 60)}`;
    const content =
      `Auto-detected from trace ${q.firstTs}..${q.lastTs}.\n\n` +
      `Serial: ${q.serial}\nAlias: ${q.alias || "-"}\nOp: ${q.op}\n` +
      `Occurrences: ${q.count} (${q.serials.size} device(s))\n` +
      `First/Last: ${q.firstTs} / ${q.lastTs}\n\n` +
      `Sample errors:\n${q.errors.slice(0, 3).map((e) => "  - " + String(e).slice(0, 300)).join("\n")}\n\n` +
      `Context dumps (if any): C:\\Users\\Public\\xhs-agent-runs\\ops-trace\\context\\fail-${q.serial}-*\n` +
      `Steps: view context dump -> reproduce -> classify transient or persistent`;
    const body = {
      id,
      app: "xhs",
      category: "pitfall",
      lifecycle: "probe_unknown",
      title,
      content,
      appliesTo: [q.serial],
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
