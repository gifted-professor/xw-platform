#!/usr/bin/env node
/**
 * 闲鱼「我发布的 → 在卖」指标采集（dump-only）
 *
 * 只采在卖：标题(列表截断)、曝光、浏览、想要、价格、小刀价。
 * 若截断标题撞车：点进详情拿完整标题后返回列表继续。
 * 无商品 id（页面不暴露）；撞车用 标题截断+曝光+浏览+价格 区分卡片。
 *
 *   set XHS_LOCAL=1
 *   node ops/xianyu-published-metrics.mjs --alias 04
 *   node ops/xianyu-published-metrics.mjs --alias 04 --out tmp-know/pub-metrics.json --swipes 30
 *
 * stdout: PUBLISHED=ok COUNT=N CONFLICTS=N RESOLVED=N OUT=...
 * exit: 0 ok | 2 设备/页面 | 4 参数
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./_explore-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG = "com.taobao.idlefish";
const MAIN = "com.taobao.idlefish.maincontainer.activity.MainActivity";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/xianyu-published-metrics.mjs --alias <01-04> [选项]

选项:
  --out <json>     默认 tmp-know/xianyu-published-metrics-<alias>.json
  --swipes <n>     列表最大下滑次数，默认 40
  --no-resolve     撞车也不进详情补全标题
  --ssh xhs-windows
  --local / XHS_LOCAL=1

只采「在卖」。草稿/已下架不采。`);
  process.exit(0);
}

const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const maxSwipes = Math.max(5, Number(opt("--swipes", "40")) || 40);
const resolveConflicts = !flag("--no-resolve");
const outPath = opt(
  "--out",
  join(ROOT, "tmp-know", `xianyu-published-metrics-${alias || "x"}.json`),
);
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}

function sleep(ms) {
  spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { stdio: "ignore" });
}

function runOps(args, timeoutMs = 120000) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    code: r.status ?? 1,
    out: `${r.stdout || ""}${r.stderr || ""}`,
  };
}

function ops(args) {
  const extra = [];
  if (process.env.XHS_LOCAL === "1" || process.argv.includes("--local")) {
    // child scripts read env / win32 auto
  }
  return runOps([...args, ...(ssh ? ["--ssh", ssh] : [])]);
}

function parseNodes(xml) {
  return [...xml.matchAll(/<node\b[^>]*\/?>/g)]
    .map((m) => m[0])
    .map((n) => {
      const attr = (k) => {
        const m = n.match(new RegExp(`${k}="([^"]*)"`));
        return m ? m[1] : "";
      };
      const bounds = attr("bounds");
      const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!bm) return null;
      return {
        text: attr("text"),
        desc: (attr("content-desc") || "").replace(/&#10;/g, "\n"),
        click: attr("clickable"),
        x: Math.floor((+bm[1] + +bm[3]) / 2),
        y: Math.floor((+bm[2] + +bm[4]) / 2),
        y1: +bm[2],
        y2: +bm[4],
        x1: +bm[1],
        x2: +bm[3],
      };
    })
    .filter(Boolean);
}

function parseExposure(raw) {
  if (raw == null) return null;
  if (String(raw).includes("万")) return Math.round(parseFloat(raw) * 10000);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseListingDesc(desc, y1, y2) {
  if (!/曝光/.test(desc) || !/想要/.test(desc)) return null;
  const lines = String(desc).split("\n").map((s) => s.trim()).filter(Boolean);
  let title = "";
  for (const line of lines) {
    if (/^【/.test(line) || (/折/.test(line) && line.length > 12 && !/曝光|浏览|想要|托管|编辑|降价|小刀/.test(line))) {
      title = line;
      break;
    }
  }
  if (!title) {
    const i = lines.findIndex((l) => l === "编辑" || l.endsWith("编辑"));
    if (i >= 0 && lines[i + 1]) title = lines[i + 1];
  }
  const expM = desc.match(/曝光([0-9.]+万?)/);
  const viewM = desc.match(/浏览(\d+)/);
  const wantM = desc.match(/想要(\d+)/);
  const priceM = desc.match(/¥\n?(\d+(?:\.\d+)?)/) || desc.match(/¥(\d+(?:\.\d+)?)/);
  const knifeM = desc.match(/2人小刀价¥(\d+(?:\.\d+)?)/);
  if (!expM || !title) return null;
  return {
    titleTrunc: title,
    titleFull: null,
    exposureRaw: expM[1],
    exposure: parseExposure(expM[1]),
    views: viewM ? Number(viewM[1]) : null,
    wants: wantM ? Number(wantM[1]) : null,
    price: priceM ? Number(priceM[1]) : null,
    knifePrice: knifeM ? Number(knifeM[1]) : null,
    y1,
    y2,
    fingerprint: `${title}|${expM[1]}|${viewM?.[1] || ""}|${wantM?.[1] || ""}|${priceM?.[1] || ""}`,
  };
}

function listingsFromXml(xml) {
  const out = [];
  for (const n of parseNodes(xml)) {
    const item = parseListingDesc(n.desc, n.y1, n.y2);
    if (!item) continue;
    // skip partially off-screen cards
    if (n.y2 - n.y1 < 200) continue;
    if (n.y1 < 640 || n.y1 > 2300) continue;
    item.tapX = 420;
    item.tapY = Math.min(Math.max(n.y1 + 120, 750), 2100);
    out.push(item);
  }
  return out;
}

function detailTitleFromXml(xml) {
  const nodes = parseNodes(xml);
  // prefer long description block starting with 【
  for (const n of nodes) {
    const d = n.desc || n.text || "";
    if (/^【/.test(d) && d.length > 20) {
      return d.split(/\n|&#10;/)[0].trim();
    }
  }
  // native search-bar title is often short — prefer long product text
  const texts = nodes.map((n) => n.text).filter((t) => t && t.length > 20);
  const hit = texts.find((t) => /奥莱|Adidas|Nike|耐克|三叶草|折/.test(t));
  return hit || null;
}

function dumpTo(path) {
  mkdirSync(dirname(path), { recursive: true });
  const r = ops(["ops/dump-ui.mjs", "--alias", alias, "--out", path]);
  if (r.code !== 0 || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function ensureSellingList() {
  ops(["ops/launch-app.mjs", "--alias", alias, "--package", PKG, "--activity", MAIN]);
  sleep(2000);
  // 我的
  ops(["ops/tap.mjs", "--alias", alias, "--x", "960", "--y", "2292"]);
  sleep(1800);
  // 我发布的
  ops(["ops/tap.mjs", "--alias", alias, "--x", "124", "--y", "869"]);
  sleep(2500);
  // 在卖 tab（第1个标签中心）
  ops(["ops/tap.mjs", "--alias", alias, "--x", "90", "--y", "710"]);
  sleep(1200);
  const xml = dumpTo(join(ROOT, "tmp-know", `_pub-${alias}-entry.xml`));
  if (!xml) throw Object.assign(new Error("entry dump failed"), { code: 2 });
  const blob = xml;
  if (!/在卖|我发布的/.test(blob)) {
    console.log("WARN_FOCUS maybe not on 我发布的");
  }
  return xml;
}

function mergeItem(map, item) {
  const prev = map.get(item.fingerprint);
  if (!prev) {
    map.set(item.fingerprint, { ...item });
    return;
  }
  // keep earliest y / any fuller title
  if (item.titleFull && !prev.titleFull) prev.titleFull = item.titleFull;
  if ((item.titleTrunc || "").length > (prev.titleTrunc || "").length) prev.titleTrunc = item.titleTrunc;
}

async function main() {
  const t0 = Date.now();
  mkdirSync(dirname(outPath), { recursive: true });
  ensureSellingList();

  const byFp = new Map();
  let stagnant = 0;
  for (let i = 0; i <= maxSwipes; i++) {
    const xml = dumpTo(join(ROOT, "tmp-know", `_pub-${alias}-p${String(i).padStart(2, "0")}.xml`));
    if (!xml) break;
    const before = byFp.size;
    for (const it of listingsFromXml(xml)) mergeItem(byFp, it);
    const neu = byFp.size - before;
    console.log(`LIST_STEP=${i} NEW=${neu} TOTAL=${byFp.size}`);
    if (i === maxSwipes) break;
    if (neu === 0) {
      stagnant += 1;
      if (stagnant >= 3) break;
    } else stagnant = 0;
    ops(["ops/swipe.mjs", "--alias", alias, "--x1", "540", "--y1", "1700", "--x2", "540", "--y2", "700", "--duration", "350"]);
    sleep(850);
  }

  let items = [...byFp.values()];
  // conflicts: same truncated title, different fingerprint
  const byTitle = new Map();
  for (const it of items) {
    const k = it.titleTrunc;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(it);
  }
  const conflictTitles = [...byTitle.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`CONFLICT_TITLES=${conflictTitles.length}`);

  let resolved = 0;
  if (resolveConflicts && conflictTitles.length) {
    for (const [title, group] of conflictTitles) {
      for (const target of group) {
        console.log(`RESOLVE title=${title.slice(0, 24)}… exp=${target.exposureRaw} views=${target.views}`);
        // back to list top then scroll until fingerprint visible
        ensureSellingList();
        let found = null;
        for (let s = 0; s < maxSwipes + 5; s++) {
          const xml = dumpTo(join(ROOT, "tmp-know", `_pub-${alias}-find.xml`));
          if (!xml) break;
          const visible = listingsFromXml(xml);
          found = visible.find((v) => v.fingerprint === target.fingerprint);
          if (found) break;
          ops(["ops/swipe.mjs", "--alias", alias, "--x1", "540", "--y1", "1700", "--x2", "540", "--y2", "700", "--duration", "350"]);
          sleep(700);
        }
        if (!found) {
          console.log(`RESOLVE_MISS fp=${target.fingerprint}`);
          continue;
        }
        ops(["ops/tap.mjs", "--alias", alias, "--x", String(found.tapX), "--y", String(found.tapY)]);
        sleep(2800);
        const dxml = dumpTo(join(ROOT, "tmp-know", `_pub-${alias}-detail.xml`));
        const full = dxml ? detailTitleFromXml(dxml) : null;
        if (full) {
          target.titleFull = full;
          resolved += 1;
          console.log(`RESOLVE_OK full=${full.slice(0, 60)}`);
        } else {
          console.log("RESOLVE_NO_TITLE");
        }
        ops(["ops/back.mjs", "--alias", alias]);
        sleep(1200);
      }
    }
    // refresh items from map
    items = [...byFp.values()];
  }

  const result = {
    ok: true,
    alias,
    collectedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    count: items.length,
    conflictTitleGroups: conflictTitles.length,
    resolvedFullTitles: resolved,
    items: items.map((it) => ({
      title: it.titleFull || it.titleTrunc,
      titleTrunc: it.titleTrunc,
      titleFull: it.titleFull,
      titleResolved: Boolean(it.titleFull),
      exposure: it.exposure,
      exposureRaw: it.exposureRaw,
      views: it.views,
      wants: it.wants,
      price: it.price,
      knifePrice: it.knifePrice,
      fingerprint: it.fingerprint,
      itemId: null,
    })),
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`PUBLISHED=ok`);
  console.log(`COUNT=${result.count}`);
  console.log(`CONFLICTS=${result.conflictTitleGroups}`);
  console.log(`RESOLVED=${resolved}`);
  console.log(`OUT=${outPath}`);
  console.log(`ELAPSED_MS=${result.elapsedMs}`);
  process.exit(0);
}

main().catch((e) => {
  console.log(`✗ ${e.message || e}`);
  process.exit(e.code === 2 ? 2 : 4);
});
