#!/usr/bin/env node
/**
 * Mark Feishu「闲鱼已发布设备」after successful xianyu publish.
 *
 * Default target: 青岛自动化飞书表（wiki 内嵌 Base）
 *   table=tblQ1hKZgbNX65gD  field=闲鱼已发布设备 (multi-select 01/02/03/04)
 *
 * Merges aliases into existing cell (union), does not wipe prior devices.
 *
 * Usage:
 *   node ops/feishu-mark-xianyu-published.mjs --sku LHJK6MNT01 --aliases 01,02,03,04
 *   node ops/feishu-mark-xianyu-published.mjs --record-id recvrRNN51QKys --aliases 02
 *   node ops/feishu-mark-xianyu-published.mjs --sku LHJK6MNT01 --aliases 01,02 --dry-run
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadDotenv, optionalEnv } from "../scripts/lib/load-dotenv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);

const DEFAULT_BASE = optionalEnv("FEISHU_QINGDAO_BASE_TOKEN", optionalEnv("FEISHU_BASE_TOKEN", ""));
const DEFAULT_TABLE = optionalEnv("FEISHU_QINGDAO_TABLE_ID", "tblQ1hKZgbNX65gD");
const FIELD = "闲鱼已发布设备";

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node ops/feishu-mark-xianyu-published.mjs (--sku <SKU> | --record-id <rec>) --aliases 01,02,03,04 [--dry-run]

Options:
  --sku <SKU>            lookup by SKU column
  --record-id <rec>      update known record directly
  --aliases 01,02        required; device aliases to merge in
  --base-token <tok>     default FEISHU_QINGDAO_BASE_TOKEN / FEISHU_BASE_TOKEN
  --table-id <tbl>       default FEISHU_QINGDAO_TABLE_ID or tblQ1hKZgbNX65gD
  --dry-run              print planned union, no write
`);
  process.exit(0);
}

const SKU = opt("--sku");
const RECORD_ARG = opt("--record-id");
const ALIASES = String(opt("--aliases", ""))
  .split(",")
  .map((s) => String(s).trim().padStart(2, "0"))
  .filter((s) => /^(0[1-4])$/.test(s));
const BASE = opt("--base-token", DEFAULT_BASE);
const TABLE = opt("--table-id", DEFAULT_TABLE);
const DRY = flag("--dry-run");

if (!SKU && !RECORD_ARG) {
  console.log("need --sku or --record-id");
  process.exit(4);
}
if (!ALIASES.length) {
  console.log("need --aliases 01,02,... (only 01-04)");
  process.exit(4);
}
if (!BASE || !TABLE) {
  console.log("missing base-token / table-id");
  process.exit(4);
}

function larkJson(args) {
  const r = spawnSync("lark-cli", [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8",
    cwd: ROOT,
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  let j;
  try {
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out);
  } catch {
    throw new Error(`lark-cli parse fail: ${out.slice(0, 400)}`);
  }
  if (!j.ok) throw new Error(j.error?.message || JSON.stringify(j.error || j).slice(0, 400));
  return j;
}

function resolveRecordId() {
  if (RECORD_ARG) return RECORD_ARG;
  const j = larkJson([
    "base",
    "+record-search",
    "--base-token",
    BASE,
    "--table-id",
    TABLE,
    "--keyword",
    SKU,
    "--search-field",
    "SKU",
    "--field-id",
    "SKU",
    "--field-id",
    FIELD,
    "--limit",
    "5",
  ]);
  const ids = j.data?.record_id_list || [];
  const rows = j.data?.data || [];
  const fields = j.data?.fields || [];
  const skuIdx = fields.indexOf("SKU");
  const hits = [];
  for (let i = 0; i < ids.length; i += 1) {
    const skuVal = skuIdx >= 0 ? rows[i]?.[skuIdx] : null;
    if (String(skuVal || "") === SKU) hits.push({ recordId: ids[i], row: rows[i], fields });
  }
  if (hits.length !== 1) {
    throw new Error(`SKU ${SKU} resolve hits=${hits.length} ids=${ids.join(",")}`);
  }
  return hits[0].recordId;
}

function normalizeSelect(cur) {
  if (cur == null) return [];
  if (Array.isArray(cur)) {
    return cur.map((x) => (typeof x === "string" ? x : x?.name || x?.text || "")).filter(Boolean);
  }
  return [String(cur)];
}

function readPublished(recordId) {
  const j = larkJson([
    "base",
    "+record-get",
    "--base-token",
    BASE,
    "--table-id",
    TABLE,
    "--record-id",
    recordId,
    "--field-id",
    "SKU",
    "--field-id",
    FIELD,
  ]);
  const d = j.data || {};
  // list shape: data=[[...]], fields=[...]
  if (Array.isArray(d.fields) && Array.isArray(d.data?.[0])) {
    const idx = d.fields.indexOf(FIELD);
    return normalizeSelect(idx >= 0 ? d.data[0][idx] : null);
  }
  // map shape fallback
  const rec = d.record || d;
  const fields = rec.fields || rec;
  return normalizeSelect(fields[FIELD] ?? fields["fldy442Cu1"] ?? null);
}

function writePublished(recordId, aliases) {
  const tmp = mkdtempSync(join(tmpdir(), "xhs-fmark-"));
  const fp = join(tmp, "patch.json");
  writeFileSync(fp, JSON.stringify({ [FIELD]: aliases }), "utf8");
  try {
    // lark-cli requires relative @path under cwd
    const rel = fp.startsWith(ROOT) ? fp.slice(ROOT.length + 1).replace(/\\/g, "/") : null;
    if (rel) {
      return larkJson([
        "base",
        "+record-upsert",
        "--base-token",
        BASE,
        "--table-id",
        TABLE,
        "--record-id",
        recordId,
        "--json",
        `@${rel}`,
      ]);
    }
    // fall back: pipe via stdin if supported, else copy into repo tmp
    const local = join(ROOT, "tmp-imgs", `_feishu-mark-${Date.now()}.json`);
    writeFileSync(local, JSON.stringify({ [FIELD]: aliases }), "utf8");
    try {
      return larkJson([
        "base",
        "+record-upsert",
        "--base-token",
        BASE,
        "--table-id",
        TABLE,
        "--record-id",
        recordId,
        "--json",
        `@tmp-imgs/${local.split(/[/\\]/).pop()}`,
      ]);
    } finally {
      try {
        rmSync(local, { force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const recordId = resolveRecordId();
const before = readPublished(recordId);
const merged = [...new Set([...before, ...ALIASES])].sort();
console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY,
      sku: SKU || null,
      recordId,
      before,
      add: ALIASES,
      after: merged,
      tableId: TABLE,
      field: FIELD,
    },
    null,
    2,
  ),
);
if (DRY) process.exit(0);
if (merged.join(",") === before.join(",")) {
  console.log("noop: already marked");
  process.exit(0);
}
const w = writePublished(recordId, merged);
console.log(JSON.stringify({ written: true, updated: w.data?.updated === true, record: w.data?.record?.update || null }, null, 2));
