#!/usr/bin/env node
// feishu-to-xianyu.mjs — 飞书商品目录表 → 闲鱼并发发布 dry-run 一键编排（跑在 Mac）
//
// 链路：lark-cli 读飞书商品表（按 SKU+READY_TO_PUBLISH）→ 提取标题/价格/颜色/尺码/文案
//      → 下载 Yupoo原图 → phone-push 到 01/02/04 相册 → 组装 full_dry_run fixture
//      → 预检 fleet → 并发 submit + poll（dry-run 时不 submit）。
//
// 结构镜像 ops/conc4-full-dry-run.mjs（预检/submit/poll/汇总/退出码）
//      + sync-feishu.mjs（lark-cli 读取 + 位置字段索引）。零新依赖。
//
// 用法：
//   node ops/feishu-to-xianyu.mjs --sku DX1488-100 --actor hermes-f2x --dry-run
//   node ops/feishu-to-xianyu.mjs --sku DX1488-100 --aliases 01,02,04 --actor hermes-f2x
//
// 退出码：
//   0  全绿 succeeded（dry-run 时 = 预检+组装通过）
//   1  部分失败 / recovery_required / verification 不绿
//   2  预检未过（fleet 不干净）—— 仅实跑模式硬拦；dry-run 仅告警
//   3  超时
//   4  客户端 / SSH / 飞书 / 解析错误
//
// 注意：禁 console.error（Windows 远端约束传染防御，与 registry.mjs 一致），一律 console.log。
// 多行描述：fixture 写 descriptionPrefix/productTitle/descriptionBody，由 operator 组装逐行输入
//          （依赖 Repo B 的 fillDescriptionMultiLine；落地前实跑描述会被压成单行）。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---------- 常量 ----------
const FEISHU_BASE_TOKEN = "REDACTED_FEISHU_BASE_TOKEN";
const FEISHU_TABLE_ID = "REPLACE_FEISHU_PRODUCT_TABLE_ID";
const SSH = "xhs-windows";
const REGISTRY = "http://127.0.0.1:17930";
const REGISTRY_TOKEN = "REDACTED_OLD_AGENT_TOKEN";
const GPFS = "/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1";
const DEVICTL = join(GPFS, "control-plane/devicectl.mjs");
const BRIDGE = join(
  process.env.HOME || "/Users/a1234",
  ".claude/skills/windows-tailscale-bridge/scripts/windows_bridge.py",
);

// 飞书显示名 → 逻辑键（按 record-list 的 fields 数组位置解析，不靠 field-list 顺序）
const F = {
  sku: "SKU",
  productTitle: "商品简称",
  price: "售价",
  color: "颜色",
  sizes: "尺码",
  copywriting: "闲鱼文案内容",
  packStatus: "商品包状态",
  yupoo: "Yupoo原图",
};
const YUPOO_EXPECTED_INDEX = 13; // 用户指定 Yupoo原图 在 record-list 行序 index 13（断言用）

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);
const FORCE = flag("--force");

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/feishu-to-xianyu.mjs --sku <SKU> --actor <id> [选项]

必填:
  --sku <SKU>          飞书商品表 SKU 列匹配值，如 DX1488-100
  --actor <id>         例 hermes-f2x / mimo-f2x

选项:
  --aliases 01,02,04   默认 01,02,04（03 无 ADB，已知限制）
  --ssh <host>         默认 xhs-windows
  --capability <id>    默认 xianyu.publish.full_dry_run
  --gpfs <path>        默认 GPFS 路由仓（devicectl 所在）
  --freight <str>      默认 包邮
  --sku-stock <n>      默认 2
  --timeout-s <n>      默认 1200
  --poll-s <n>         默认 20
  --img-dir <dir>      默认 <repo>/tmp-imgs（Yupoo 原图本地落盘）
  --dry-run            只做飞书读取+图片下载+phone-push+组装+预检，不 submit
  --force              跳过 ready + lease 检查（仅拦 quarantine + offline）；注意 lease 真占时控制面仍会 device_busy
  --keep-log <dir>     落组装的 fixture + submit/status JSON

退出码: 0 全绿 | 1 部分失败 | 2 预检失败(实跑) | 3 超时 | 4 客户端错误`);
  process.exit(0);
}

const SKU_ARG = opt("--sku");
const ACTOR = opt("--actor");
const ALIASES = (opt("--aliases", "01,02,04") || "01,02,04")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CAP = opt("--capability", "xianyu.publish.full_dry_run");
const FREIGHT = opt("--freight", "包邮");
const SKU_STOCK = opt("--sku-stock", "2");
const TIMEOUT_S = Number(opt("--timeout-s", "1200")) || 1200;
const POLL_S = Number(opt("--poll-s", "20")) || 20;
const IMG_DIR = opt("--img-dir", join(ROOT, "tmp-imgs"));
const DRY = flag("--dry-run");
const KEEP_LOG = opt("--keep-log", null);

if (!SKU_ARG || !String(SKU_ARG).trim()) {
  console.log("✗ 需要 --sku <SKU>（如 DX1488-100）。见 --help");
  process.exit(4);
}
if (!ACTOR || !String(ACTOR).trim()) {
  console.log("✗ 需要 --actor <id>（如 hermes-f2x）。见 --help");
  process.exit(4);
}

const TS = Date.now();
const logDir = KEEP_LOG || join("/tmp", `f2x-${TS}`);
mkdirSync(logDir, { recursive: true });
const log = (m) => console.log(m);

// ---------- 通用执行 ----------
function sh(cmd, args, { timeout = 120000, input, cwd } = {}) {
  return execFileSync(cmd, args, {
    input: input == null ? undefined : input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function lark(args, cwd) {
  let out;
  try {
    out = sh("lark-cli", args, { timeout: 90000, cwd });
  } catch (e) {
    throw new Error(`lark-cli ${args.slice(0, 3).join(" ")} exec: ${(e.stderr || e.message || "").toString().slice(0, 400)}`);
  }
  let d;
  try {
    d = JSON.parse(out);
  } catch (e) {
    throw new Error(`lark-cli 非 JSON: ${out.slice(0, 240)}`);
  }
  if (!d.ok) throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${d.error?.message || "unknown"}`);
  return d.data;
}

function parseJsonBlob(stdout) {
  const s = String(stdout);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON in output: " + s.slice(0, 240));
  return JSON.parse(s.slice(a, b + 1));
}

function runNode(args) {
  try {
    return execFileSync("node", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
    const err = new Error(out.slice(0, 800));
    err.cause = e;
    throw err;
  }
}

function sshCurl(path) {
  try {
    return execFileSync(
      "ssh",
      [SSH, "curl.exe", "-s", "-m", "15", `http://127.0.0.1:17930${path}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    throw new Error(`ssh curl registry failed: ${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
}

function sha256File(p) {
  const h = createHash("sha256");
  const buf = readFileSync(p);
  h.update(buf);
  return h.digest("hex");
}

// ---------- 1. 读飞书 ----------
function readFeishuProduct(sku) {
  const data = lark([
    "base", "+record-list",
    "--base-token", FEISHU_BASE_TOKEN,
    "--table-id", FEISHU_TABLE_ID,
    "--limit", "200",
    "--as", "user",
    "--format", "json",
  ]);
  const fields = data.fields;
  if (!Array.isArray(fields)) throw new Error("飞书 record-list 无 fields 数组");
  const idx = Object.fromEntries(Object.values(F).map((name) => [name, fields.indexOf(name)]));
  for (const [k, name] of Object.entries(F)) {
    if (idx[name] < 0) throw new Error(`飞书表缺字段: ${name}（键 ${k}）`);
  }
  if (idx[F.yupoo] !== YUPOO_EXPECTED_INDEX) {
    log(`⚠️  Yupoo原图 在 index ${idx[F.yupoo]}（预期 ${YUPOO_EXPECTED_INDEX}），按名继续`);
  }
  const yupooOf = (values) => {
    const cell = values[idx[F.yupoo]];
    return Array.isArray(cell)
      ? cell.filter((x) => x && typeof x === "object" && x.file_token).map((x) => ({ file_token: x.file_token, name: x.name || `${x.file_token}.png` }))
      : [];
  };
  const rows = data.data.map((values, i) => ({
    recordId: data.record_id_list[i],
    values,
  }));
  const matches = rows.filter((r) => {
    const v = r.values[idx[F.sku]];
    return v != null && String(v).trim() === String(sku).trim();
  });
  if (matches.length === 0) {
    throw new Error(`飞书表无 SKU=${sku} 的记录（limit=200，确认 SKU 拼写或翻页）`);
  }
  // 同 SKU 多条：取商品包状态 READY_TO_PUBLISH 的；仍多条优先取 Yupoo原图 已填充的
  const ready = matches.filter((r) => String(r.values[idx[F.packStatus]] || "").trim() === "READY_TO_PUBLISH");
  if (ready.length === 0) {
    const statuses = matches.map((r) => r.values[idx[F.packStatus]]).join(", ");
    throw new Error(`SKU=${sku} 有 ${matches.length} 条但无 READY_TO_PUBLISH（状态: ${statuses}）`);
  }
  let candidates = ready;
  const withImg = ready.filter((r) => yupooOf(r.values).length > 0);
  if (withImg.length >= 1) {
    // 优先取有 Yupoo 原图的（去空壳重复行）；多条都有图才算真冲突
    if (withImg.length > 1) {
      throw new Error(`SKU=${sku} 有 ${withImg.length} 条 READY_TO_PUBLISH 且均有 Yupoo原图，冲突，需人工去重`);
    }
    candidates = withImg;
    if (ready.length > 1) log(`  ℹ  SKU=${sku} 有 ${ready.length} 条 READY_TO_PUBLISH，取有 Yupoo原图 的那条（去空壳重复）`);
  } else if (ready.length > 1) {
    throw new Error(`SKU=${sku} 有 ${ready.length} 条 READY_TO_PUBLISH 但均无 Yupoo原图，无法去重，需人工`);
  }
  const row = candidates[0];
  const get = (key) => row.values[idx[F[key]]] ?? null;

  // 颜色：text "白色" 或 select ["白色"] → 归一成数组
  const colorRaw = get("color");
  const colorArr = Array.isArray(colorRaw)
    ? colorRaw.map((x) => String(x).trim()).filter(Boolean)
    : (colorRaw != null && String(colorRaw).trim() ? [String(colorRaw).trim()] : []);
  // 尺码：text "S-M-L-XL-XXL" → 按 - 拆
  const sizesRaw = get("sizes");
  const sizeArr = Array.isArray(sizesRaw)
    ? sizesRaw.map((x) => String(x).trim()).filter(Boolean)
    : String(sizesRaw || "").split(/[-、,，\s]+/).map((s) => s.trim()).filter(Boolean);

  // 闲鱼文案内容 → 前缀 + body
  const copyRaw = String(get("copywriting") || "");
  const { prefix, body } = derivePrefixAndBody(copyRaw);

  // Yupoo原图：attachment cell = [{file_token,name,size}, ...]
  const yupooFiles = yupooOf(row.values);

  const price = Number(get("price"));
  if (!Number.isFinite(price)) throw new Error(`售价非数字: ${get("price")}`);

  return {
    sku: String(sku).trim(),
    recordId: row.recordId,
    productTitle: String(get("productTitle") || "").trim(),
    price,
    colorArr,
    sizeArr,
    descriptionPrefix: prefix,
    descriptionBody: body,
    yupooFiles,
  };
}

// 闲鱼文案内容 首行含关键词 → 派生前缀；body = 去掉首行后的剩余行
function derivePrefixAndBody(copy) {
  const lines = String(copy || "").replace(/\r\n/g, "\n").split("\n");
  const firstLine = (lines[0] || "").trim();
  let prefix;
  if (firstLine.includes("奥莱折扣")) prefix = "【奥莱折扣】";
  else if (firstLine.includes("撤店清仓")) prefix = "【撤店清仓】";
  else if (firstLine.includes("出全新")) prefix = "出全新 ";
  else prefix = "出闲置 ";
  const body = lines.slice(1).join("\n").trim();
  return { prefix, body };
}

// ---------- 2. 下载 Yupoo 原图 ----------
function downloadYupooImages(product) {
  const dir = join(IMG_DIR, product.sku);
  mkdirSync(dir, { recursive: true });
  const downloaded = [];
  if (product.yupooFiles.length === 0) {
    log(`⚠️  SKU=${product.sku} Yupoo原图 为空，fixture 将无图片`);
    return downloaded;
  }
  for (const f of product.yupooFiles) {
    const outPath = join(dir, f.name);
    try {
      // lark-cli --output 要求相对当前目录的路径 → cwd=dir，--output 用裸文件名
      lark(
        [
          "base", "+record-download-attachment",
          "--base-token", FEISHU_BASE_TOKEN,
          "--table-id", FEISHU_TABLE_ID,
          "--record-id", product.recordId,
          "--file-token", f.file_token,
          "--output", f.name,
          "--overwrite",
          "--as", "user",
        ],
        dir,
      );
    } catch (e) {
      throw new Error(`下载 Yupoo 图 ${f.name} 失败: ${e.message.slice(0, 200)}`);
    }
    if (!existsSync(outPath)) {
      throw new Error(`下载后文件不存在: ${outPath}（lark-cli 输出路径不符预期）`);
    }
    const sha = sha256File(outPath);
    downloaded.push({ name: f.name, localPath: outPath, sha256: sha });
    log(`  ✓ ${f.name}  sha=${sha.slice(0, 12)}…  ${Math.round(readFileSync(outPath).length / 1024)}KB`);
  }
  return downloaded;
}

// ---------- 3. phone-push 到每台 ----------
function phonePushAll(images, aliases) {
  const perAlias = {}; // alias -> [{phonePath, sha256}]
  for (const alias of aliases) {
    const n = Number(alias);
    const album = `XianyuFull${n}`;
    const imgs = [];
    for (const img of images) {
      const phonePath = `/sdcard/Pictures/${album}/${img.name}`;
      const args = [
        BRIDGE, "phone-push",
        img.localPath,
        alias,
        phonePath,
        "--media-scan",
        "--overwrite-phone",
      ];
      let out;
      try {
        out = sh("python3", args, { timeout: 120000 });
      } catch (e) {
        throw new Error(`phone-push ${alias} ${img.name} 失败: ${(e.stdout || e.stderr || e.message || "").toString().slice(0, 400)}`);
      }
      // bridge 成功输出含 OK / pushed / sha 校验；失败会非零退出（已被 catch）
      log(`  ✓ ${alias} ← ${img.name} → ${phonePath}${/sha|ok|pushed/i.test(out) ? " ✓" : ""}`);
      imgs.push({ phonePath, sha256: img.sha256 });
    }
    perAlias[alias] = { album, images: imgs };
  }
  return perAlias;
}

// ---------- 4. 组装 fixture ----------
function assembleFixture(alias, product, pushed) {
  const n = Number(alias);
  const album = `XianyuFull${n}`;
  const images = pushed[alias].images;
  return {
    descriptionPrefix: product.descriptionPrefix,
    productTitle: product.productTitle,
    descriptionBody: product.descriptionBody,
    price: product.price,
    skuPrice: product.price,
    skuStock: SKU_STOCK,
    skuReplaceExisting: true,
    skuSpecs: {
      // 单色不当 SKU 维度（单色不构成规格选择，只留尺码；多色才同时带颜色+尺码）
      ...(product.colorArr.length > 1 ? { 颜色: product.colorArr } : {}),
      ...(product.sizeArr.length ? { 尺码: product.sizeArr } : {}),
    },
    freightTemplate: FREIGHT,
    imageAlbum: album,
    images,
    maxImages: Math.min(Math.max(images.length, 1), 9),
    saveDraft: false,
    skipAddress: true,
    skipCategory: true,
    calibrated: { freight: true, sku: true, image: true },
  };
}

// ---------- 5. 预检（镜像 conc4） ----------
function deviceFromEntry(entry, alias) {
  const devices = entry.devices || [];
  const d = devices.find((x) => x.alias === alias);
  if (!d) return null;
  const state = d.state || {};
  const control = d.control || {};
  const deviceId = control.deviceId || d.deviceId || null;
  return {
    alias,
    deviceId,
    ready: state.ready,
    quarantined: state.quarantined ?? control.quarantined ?? null,
    leaseFree: state.leaseFree ?? (control.lease == null || control.lease === null),
    online: state.online ?? control.online,
    serial: d.serial || control.serial || null,
  };
}

function preflight(aliases) {
  if (!existsSync(DEVICTL)) {
    throw Object.assign(new Error(`devicectl 不存在: ${DEVICTL}（GPFS 未挂载？用 --gpfs 覆盖）`), { code: 4 });
  }
  let entry;
  try {
    entry = JSON.parse(sshCurl("/api/agent-entry"));
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 4 });
  }
  const cp = entry.controlPlane || {};
  const activeLeases = cp.activeLeases ?? entry.activeLeases;
  const rows = [];
  const problems = [];  // 硬拦：submit 前必须清零
  const warnings = [];  // 告警：不拦，控制面仍接受
  for (const alias of aliases) {
    const row = deviceFromEntry(entry, alias);
    if (!row) { problems.push(`${alias}: 不在 agent-entry.devices`); continue; }
    if (!row.deviceId) problems.push(`${alias}: 无 deviceId`);
    // 硬拦：quarantine（设备真坏）+ offline（不可达）
    if (row.quarantined === true) problems.push(`${alias}: quarantined`);
    if (row.online === false) problems.push(`${alias}: offline`);
    // lease 占用（有任务在跑）：默认硬拦，--force 降为告警
    if (row.leaseFree === false) {
      if (FORCE) warnings.push(`${alias}: lease 占用中（--force 忽略）`);
      else problems.push(`${alias}: lease 占用中`);
    }
    // ready=false 非阻塞：registry 观测的 ready 含 lease 未刷新/历史 unresolved 等，
    // 控制面仍接受 job（实证：01/02/04 ready=false 但 full_dry_run 可跑）
    if (row.ready !== true) warnings.push(`${alias}: ready=${row.ready}（非阻塞）`);
    rows.push(row);
  }
  // activeLeases 是 fleet 级在跑计数，非本设备门 → 一律告警，per-device leaseFree 才是真门
  if (activeLeases != null && Number(activeLeases) > 0) {
    warnings.push(`controlPlane.activeLeases=${activeLeases}${FORCE ? "（--force 忽略）" : "（fleet 有在跑，仅告警）"}`);
  }
  return { entry, rows, problems, warnings, activeLeases };
}

// ---------- 6. submit / poll（镜像 conc4） ----------
function submitOne(alias, deviceId, params) {
  const idem = `f2x-${alias}-${TS}`;
  const paramsStr = JSON.stringify(params);
  const out = runNode([
    DEVICTL, "--ssh", SSH, "job", "submit",
    "--actor", ACTOR,
    "--capability", CAP,
    "--device", deviceId,
    "--idempotency-key", idem,
    "--params", paramsStr,
  ]);
  const j = parseJsonBlob(out);
  const job = j.job || j;
  const jobId = job.jobId || j.jobId;
  if (!jobId) throw new Error(`${alias}: submit 无 jobId: ${out.slice(0, 300)}`);
  try { writeFileSync(join(logDir, `submit-${alias}.json`), JSON.stringify(j, null, 2)); } catch { /* ignore */ }
  return { alias, jobId, idem, raw: j };
}

function statusOne(jobId) {
  const out = runNode([DEVICTL, "--ssh", SSH, "job", "status", "--job", jobId]);
  const j = parseJsonBlob(out);
  return j.job || j;
}

function summarizeJob(job) {
  const result = job.result || {};
  const verification = result.verification || job.verification || {};
  const restoration = result.restoration || job.restoration || {};
  const output = result.output || job.output || {};
  return {
    status: job.status || "?",
    errorCode: job.errorCode || null,
    outputOk: output.ok === true || result?.output?.ok === true,
    verificationOk: verification.ok !== false && (verification.ok === true || verification.ok == null),
    restorationOk: restoration.ok !== false && (restoration.ok === true || restoration.ok == null),
    restorationFailed: restoration.ok === false,
    verificationFailed: verification.ok === false,
  };
}

function isTerminal(status) {
  return ["succeeded", "failed", "recovery_required", "cancelled", "denied", "ambiguous"].includes(status);
}

function sleepSync(seconds) {
  try { execFileSync("sleep", [String(seconds)], { stdio: "ignore" }); }
  catch { const end = Date.now() + seconds * 1000; while (Date.now() < end) { /* spin */ } }
}

// ========== main ==========
let product;
try {
  log(`[f2x] sku=${SKU_ARG} actor=${ACTOR} aliases=${ALIASES.join(",")} dryRun=${DRY}`);
  log(`[f2x] 飞书表 ${FEISHU_TABLE_ID} · 读取中…`);
  product = readFeishuProduct(SKU_ARG);
} catch (e) {
  console.log(`✗ 飞书读取失败: ${e.message}`);
  process.exit(4);
}

log(`[f2x] SKU=${product.sku} record=${product.recordId}`);
log(`  商品简称=${product.productTitle}`);
log(`  售价=${product.price}  颜色=[${product.colorArr.join(",")}]  尺码=[${product.sizeArr.join(",")}]`);
log(`  前缀=${product.descriptionPrefix}  body行数=${product.descriptionBody ? product.descriptionBody.split("\n").length : 0}`);
log(`  Yupoo原图=${product.yupooFiles.length} 张`);

let images;
try {
  log(`[f2x] 下载 Yupoo 原图 → ${IMG_DIR}`);
  images = downloadYupooImages(product);
} catch (e) {
  console.log(`✗ 图片下载失败: ${e.message}`);
  process.exit(4);
}

let pushed;
try {
  log(`[f2x] phone-push 到 ${ALIASES.join(", ")}`);
  pushed = phonePushAll(images, ALIASES);
} catch (e) {
  console.log(`✗ phone-push 失败: ${e.message}`);
  process.exit(4);
}

// 组装每台 fixture
const plans = ALIASES.map((alias) => {
  const params = assembleFixture(alias, product, pushed);
  const p = join(logDir, `fixture-${alias}-full.json`);
  writeFileSync(p, JSON.stringify(params, null, 2));
  return { alias, params, fixturePath: p };
});

log(`\n[f2x] 组装 fixture（写入 ${logDir}/）:`);
for (const p of plans) {
  const img = p.params.images.map((x) => x.phonePath.split("/").pop()).join(",");
  log(`  ${p.alias} → ${p.params.imageAlbum} [${img}] x${p.params.maxImages}`);
  log(`    desc0=${p.params.descriptionPrefix}${p.params.productTitle}`);
  log(`    price=${p.params.price} specs=${JSON.stringify(p.params.skuSpecs)}`);
  log(`    fixture=${p.fixturePath}`);
}

// 预检
let pre;
try {
  log(`\n[f2x] 预检 fleet…`);
  pre = preflight(ALIASES);
} catch (e) {
  console.log(`✗ 预检错误: ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
log(`[f2x] activeLeases=${pre.activeLeases}`);
for (const r of pre.rows) {
  log(`  ${r.alias} deviceId=${r.deviceId} ready=${r.ready} q=${r.quarantined} leaseFree=${r.leaseFree} online=${r.online}`);
}
if (pre.warnings.length) {
  log("⚠️  预检告警（非阻塞，控制面仍接受）:");
  for (const w of pre.warnings) log(`  - ${w}`);
}
if (pre.problems.length) {
  console.log("✗ 预检硬拦（quarantine / offline / 无 deviceId / lease 占用）:");
  for (const p of pre.problems) console.log(`  - ${p}`);
  if (!DRY) {
    console.log("  不 submit。先恢复设备/释放 lease；或在确认安全时加 --force 跳过 lease。");
    process.exit(2);
  }
  log("  (dry-run 模式：硬拦项仅报告，不退出)");
}

if (DRY) {
  log(`\n✓ dry-run 完成：飞书提取+图片下载+phone-push+组装+预检均跑过，未 submit`);
  log(`  fixture 目录=${logDir}`);
  process.exit(0);
}

// 实跑：submit + poll
const jobs = [];
log(`\n[f2x] submitting…`);
for (const p of plans) {
  const row = pre.rows.find((r) => r.alias === p.alias);
  if (!row?.deviceId) {
    console.log(`✗ ${p.alias} 无 deviceId，跳过 submit`);
    continue;
  }
  try {
    const s = submitOne(p.alias, row.deviceId, p.params);
    jobs.push(s);
    log(`  ${p.alias} jobId=${s.jobId} idem=${s.idem}`);
  } catch (e) {
    console.log(`✗ submit ${p.alias} 失败: ${e.message}`);
  }
}
if (jobs.length === 0) {
  console.log("✗ 无 job 提交成功");
  process.exit(4);
}

const byAlias = Object.fromEntries(jobs.map((j) => [j.alias, j]));
const deadline = Date.now() + TIMEOUT_S * 1000;
log(`\n[f2x] polling (timeout=${TIMEOUT_S}s poll=${POLL_S}s)…`);

const final = {};
while (Date.now() < deadline) {
  let allDone = true;
  const line = [];
  for (const alias of ALIASES) {
    if (!byAlias[alias]) continue;
    let job;
    try { job = statusOne(byAlias[alias].jobId); }
    catch (e) { allDone = false; line.push(`${alias}=?`); continue; }
    const sum = summarizeJob(job);
    final[alias] = { jobId: byAlias[alias].jobId, ...sum, job };
    line.push(`${alias}=${sum.status}`);
    if (!isTerminal(sum.status)) allDone = false;
    try { writeFileSync(join(logDir, `status-${alias}.json`), JSON.stringify(job, null, 2)); } catch { /* ignore */ }
  }
  log(`[poll] ${line.join(" | ")}`);
  if (allDone) break;
  sleepSync(POLL_S);
}

log("\n=== FINAL ===");
log(["alias", "jobId", "status", "out", "rest", "ver", "err"].map((h) => h.padEnd(h === "jobId" ? 40 : 12)).join(" "));
let anyNonTerminal = false;
let anyBad = false;
for (const alias of ALIASES) {
  const f = final[alias];
  if (!f || !isTerminal(f.status)) { anyNonTerminal = true; log(`${alias.padEnd(12)} ${(f?.jobId || "?").padEnd(40)} TIMEOUT/pending`); continue; }
  const rest = f.restorationFailed ? "fail" : f.restorationOk ? "ok" : "?";
  const ver = f.verificationFailed ? "fail" : f.verificationOk ? "ok" : "?";
  const out = f.outputOk ? "ok" : "?";
  if (f.status !== "succeeded" || f.restorationFailed || f.verificationFailed) anyBad = true;
  log(`${alias.padEnd(12)} ${f.jobId.padEnd(40)} ${String(f.status).padEnd(12)} ${out.padEnd(12)} ${rest.padEnd(12)} ${ver.padEnd(12)} ${f.errorCode || ""}`);
}
log(`\nlogDir=${logDir}`);

if (anyNonTerminal) { console.log("✗ 超时：仍有 job 非终态"); process.exit(3); }
if (anyBad) { console.log("✗ 未全绿"); process.exit(1); }
console.log(`✓ ${ALIASES.length} 台 succeeded + restoration/verification 未失败`);
process.exit(0);