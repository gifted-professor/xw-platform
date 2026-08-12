/**
 * Qingdao Feishu → 闲鱼闲置链路：字段解析 / idle fixture / 共用工具。
 * 表：tblQ1hKZgbNX65gD（闲鱼文案D + 正/反/细节/尺码图）
 */
import { spawnSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 密钥只来自 .env / 环境变量（FEISHU_QINGDAO_BASE_TOKEN / FEISHU_BASE_TOKEN），不硬编码。
export const QINGDAO_DEFAULTS = {
  tableId: "tblQ1hKZgbNX65gD",
  viewId: "vewSOMU6fu",
  publishedField: "闲鱼已发布设备",
};

export function parseJsonBlob(s) {
  const a = String(s).indexOf("{");
  const b = String(s).lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`no JSON: ${String(s).slice(0, 240)}`);
  return JSON.parse(String(s).slice(a, b + 1));
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function normalizeSelect(cur) {
  if (cur == null) return [];
  if (Array.isArray(cur)) {
    return cur
      .map((x) => (typeof x === "string" ? x : x?.name || x?.text || ""))
      .map((s) => String(s).trim())
      .filter(Boolean);
  }
  return String(cur)
    .split(/[-、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function attachmentFiles(cell) {
  if (!Array.isArray(cell)) return [];
  return cell
    .filter((x) => x && typeof x === "object" && x.file_token)
    .map((x) => ({
      file_token: x.file_token,
      name: x.name || `${x.file_token}.jpg`,
      size: x.size || null,
    }));
}

export function larkJson(args, { cwd, timeout = 120000 } = {}) {
  const r = spawnSync("lark-cli", [...args, "--as", "user", "--format", "json"], {
    encoding: "utf8",
    cwd,
    windowsHide: true,
    maxBuffer: 64 << 20,
    timeout,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  let j;
  try {
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out);
  } catch {
    throw new Error(`lark-cli parse fail: ${out.slice(0, 400)}`);
  }
  if (!j.ok) throw new Error(j.error?.message || JSON.stringify(j.error || j).slice(0, 400));
  return j;
}

/** 异步版 lark-cli（并行下载用）。 */
export async function larkJsonAsync(args, { cwd, timeout = 120000 } = {}) {
  let out;
  try {
    const r = await execFileAsync("lark-cli", [...args, "--as", "user", "--format", "json"], {
      encoding: "utf8",
      cwd,
      windowsHide: true,
      maxBuffer: 64 << 20,
      timeout,
    });
    out = `${r.stdout || ""}${r.stderr || ""}`;
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  let j;
  try {
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || out);
  } catch {
    throw new Error(`lark-cli parse fail: ${out.slice(0, 400)}`);
  }
  if (!j.ok) throw new Error(j.error?.message || JSON.stringify(j.error || j).slice(0, 400));
  return j;
}

/**
 * Fetch one SKU from Qingdao table (exact SKU match).
 */
export function fetchQingdaoProduct(sku, {
  baseToken,
  tableId = QINGDAO_DEFAULTS.tableId,
  viewId = QINGDAO_DEFAULTS.viewId,
} = {}) {
  if (!baseToken) throw new Error("missing FEISHU_QINGDAO_BASE_TOKEN / FEISHU_BASE_TOKEN");
  const fieldIds = [
    "SKU",
    "售价",
    "颜色",
    "尺码",
    "闲鱼文案D",
    "正面图",
    "反面图",
    "细节图",
    "尺码图",
    "商品名称",
    "品牌",
    "闲鱼已发布设备",
  ];
  // 单 SKU 查询用 +record-search（按 SKU 字段搜），不再全表拉 200 行。
  const args = [
    "base",
    "+record-search",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--keyword",
    String(sku).trim(),
    "--search-field",
    "SKU",
    "--limit",
    "10",
  ];
  for (const f of fieldIds) {
    args.push("--field-id", f);
  }
  const j = larkJson(args);
  const fields = j.data?.fields || [];
  const rows = j.data?.data || [];
  const ids = j.data?.record_id_list || [];
  const idx = Object.fromEntries(fields.map((name, i) => [name, i]));
  const need = ["SKU", "售价", "闲鱼文案D", "正面图", "反面图", "细节图", "尺码图", "商品名称"];
  for (const name of need) {
    if (idx[name] == null || idx[name] < 0) throw new Error(`飞书缺字段: ${name}`);
  }
  const want = String(sku).trim();
  const hits = [];
  for (let i = 0; i < rows.length; i += 1) {
    const values = rows[i];
    if (String(values[idx.SKU] || "").trim() !== want) continue;
    hits.push({ recordId: ids[i], values });
  }
  if (hits.length !== 1) {
    throw new Error(`SKU=${want} resolve hits=${hits.length} (view ${viewId})`);
  }
  const { recordId, values } = hits[0];
  const get = (name) => values[idx[name]];
  const price = Number(get("售价"));
  if (!Number.isFinite(price)) throw new Error(`售价非数字: ${get("售价")}`);
  const copyD = String(get("闲鱼文案D") || "").trim();
  if (!copyD) throw new Error("缺闲鱼文案D");
  const name = String(get("商品名称") || "").trim() || want;
  const colors = normalizeSelect(get("颜色"));
  const sizes = normalizeSelect(get("尺码"));
  const published = normalizeSelect(get("闲鱼已发布设备"));
  const attachments = {
    front: attachmentFiles(get("正面图")),
    back: attachmentFiles(get("反面图")),
    detail: attachmentFiles(get("细节图")),
    size: attachmentFiles(get("尺码图")),
  };
  const soft = [];
  if (attachments.front.length !== 1) soft.push(`正面图=${attachments.front.length}`);
  if (attachments.back.length !== 1) soft.push(`反面图=${attachments.back.length}`);
  if (attachments.detail.length < 1) soft.push(`细节图=${attachments.detail.length}`);
  if (attachments.size.length !== 1) soft.push(`尺码图=${attachments.size.length}`);
  const flat = [
    ...attachments.front,
    ...attachments.back,
    ...attachments.detail.slice(0, 6),
    ...attachments.size,
  ].slice(0, 9);
  if (!flat.length) throw new Error("无可下载图片");
  return {
    sku: want,
    recordId,
    name,
    price,
    colors,
    sizes,
    copyD,
    published,
    brand: Array.isArray(get("品牌")) ? get("品牌")[0] : get("品牌"),
    attachments,
    downloadPlan: flat,
    softWarnings: soft,
    baseToken,
    tableId,
    viewId,
  };
}

export async function downloadQingdaoImages(product, outDir, {
  baseToken = product.baseToken,
  tableId = product.tableId || QINGDAO_DEFAULTS.tableId,
} = {}) {
  if (!baseToken) throw new Error("missing FEISHU_QINGDAO_BASE_TOKEN / FEISHU_BASE_TOKEN");
  mkdirSync(outDir, { recursive: true });
  const plan = product.downloadPlan.map((file, i) => ({
    file,
    outName: `${String(i + 1).padStart(2, "0")}.jpg`,
  }));
  // 并行下载（不同 --output 文件名，cwd 共享安全）。
  await Promise.all(
    plan.map(({ file, outName }) =>
      larkJsonAsync(
        [
          "base",
          "+record-download-attachment",
          "--base-token",
          baseToken,
          "--table-id",
          tableId,
          "--record-id",
          product.recordId,
          "--file-token",
          file.file_token,
          "--output",
          outName,
          "--overwrite",
        ],
        { cwd: outDir, timeout: 180000 },
      ),
    ),
  );
  const locals = [];
  for (const { file, outName } of plan) {
    const outPath = join(outDir, outName);
    if (!existsSync(outPath)) throw new Error(`download missing ${outPath}`);
    const sha256 = sha256File(outPath);
    locals.push({
      name: outName,
      localPath: outPath,
      sha256,
      sourceName: file.name,
      file_token: file.file_token,
    });
  }
  return locals;
}

/**
 * 闲置最小 fixture：文案 + 价格 + 库存(默认10) + 运费；skipSku；leaveOnCompose 停页目检。
 */
export function assembleIdleFixture(product, images, {
  stock = "10",
  freight = "包邮",
  album = "XianyuIdle",
  leaveOnCompose = true,
  maxImages = null,
} = {}) {
  const imgs = Array.isArray(images) ? images : [];
  const n = Math.min(Math.max(imgs.length, 1), 9);
  return {
    descriptionPrefix: "",
    productTitle: product.name,
    descriptionBody: product.copyD,
    description: product.copyD,
    price: product.price,
    stock: String(stock),
    freightTemplate: freight,
    saveDraft: false,
    skipAddress: true,
    skipCategory: true,
    skipSku: true,
    skipUpload: imgs.length === 0,
    leaveOnCompose: leaveOnCompose === true,
    awaitingAccept: leaveOnCompose === true,
    calibrated: { freight: true, image: imgs.length > 0 },
    imageAlbum: album,
    images: imgs,
    maxImages: maxImages == null ? n : Math.min(Number(maxImages) || n, 9),
  };
}

export function writePlanProduct(outDir, product, locals) {
  mkdirSync(outDir, { recursive: true });
  const payload = { ...product, locals };
  writeFileSync(join(outDir, "product.json"), JSON.stringify(payload, null, 2));
  return payload;
}

/** 发布成功后关「托管无忧卖」：找 modal X / 底条 X，永不点「立即托管」。 */
export function stillTuoguanPromo(xml) {
  return (
    /立即托管/.test(xml) ||
    /恭喜可托管无忧卖/.test(xml) ||
    /预估流量提升/.test(xml) ||
    (/托管无忧卖/.test(xml) && /预估流量/.test(xml))
  );
}

export function findTuoguanClose(xml) {
  const ns = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]);
  const parse = (n) => {
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) return null;
    const cls = ((n.match(/class="([^"]*)"/) || [])[1] || "").split(".").pop();
    const x1 = +b[1];
    const y1 = +b[2];
    const x2 = +b[3];
    const y2 = +b[4];
    return {
      cls,
      click: /clickable="true"/.test(n),
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
      x1,
      y1,
      w: x2 - x1,
      h: y2 - y1,
    };
  };
  if (/立即托管/.test(xml) || /预估流量提升/.test(xml)) {
    for (const n of ns) {
      const p = parse(n);
      if (!p) continue;
      if (p.cls === "ImageView" && p.x1 > 900 && p.y1 > 900 && p.y1 < 1200 && p.w <= 100 && p.h <= 100) {
        return { kind: "modal-x", ...p };
      }
    }
    return { kind: "modal-x-blind", cx: 1020, cy: 1047 };
  }
  if (/恭喜可托管|托管无忧卖/.test(xml)) {
    const cands = [];
    for (const n of ns) {
      const p = parse(n);
      if (!p || p.y1 < 1900) continue;
      if (p.click && p.cls === "ImageView" && p.x1 > 980 && p.w <= 80) cands.push({ kind: "banner-x", ...p, score: 100 });
      else if (p.click && p.cls === "ImageView" && p.x1 > 900) cands.push({ kind: "banner-x", ...p, score: 70 });
    }
    cands.sort((a, b) => b.score - a.score || b.cx - a.cx);
    if (cands[0]) return cands[0];
    return { kind: "banner-x-blind", cx: 1036, cy: 2137 };
  }
  return null;
}

export function listPublishTargets(xml) {
  const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]);
  const out = [];
  for (const n of nodes) {
    const desc = (n.match(/content-desc="([^"]*)"/) || [])[1] || "";
    const text = (n.match(/text="([^"]*)"/) || [])[1] || "";
    const blob = `${text} ${desc}`.trim();
    if (!blob) continue;
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const cx = Math.round((+b[1] + +b[3]) / 2);
    const cy = Math.round((+b[2] + +b[4]) / 2);
    const click = /clickable="true"/.test(n);
    if (/^发布(?:\s|,|，|$)/.test(blob) && cy < 280 && cx > 700) {
      out.push({ kind: "final-publish", blob, click, cx, cy });
    }
    if (/^(确认发布|确认|继续发布|我知道了|知道了)$/.test(blob) && click) {
      out.push({ kind: "confirm", blob, click, cx, cy });
    }
  }
  return out;
}

export function stillCompose(xml) {
  return /发闲置/.test(xml) && /存草稿/.test(xml) && (/content-desc="发布/.test(xml) || /text="发布"/.test(xml));
}

/**
 * 发布前校验：compose 页是否与目标 SKU 匹配（防发错商品）。
 * 通过条件：xml 含价格独立数字，或标题 ≥4 字片段。宽松匹配，避免误拦。
 */
export function composeMatchesProduct(xml, product) {
  const price = product?.price;
  if (price != null && Number.isFinite(Number(price))) {
    const re = new RegExp(`\\b${String(price).replace(/\./g, "\\.")}\\b`);
    if (re.test(xml)) return { ok: true, via: "price" };
  }
  const title = String(product?.name || product?.productTitle || "").trim();
  const frags = title.split(/[\s,，、-]+/).filter((w) => w.length >= 4);
  if (title.length >= 4) frags.push(title.slice(0, 4));
  for (const w of frags) {
    if (xml.includes(w)) return { ok: true, via: "title" };
  }
  return { ok: false, reason: "compose-mismatch" };
}
