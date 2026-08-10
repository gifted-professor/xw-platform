/**
 * Feishu 商品表 → 小红书发布 dry-run 字段/图片解析（record-list 行序）。
 */
export const FEISHU_BASE_TOKEN = "REDACTED_FEISHU_BASE_TOKEN";
export const FEISHU_TABLE_ID = "REPLACE_FEISHU_PRODUCT_TABLE_ID";
export const FEISHU_VIEW_ID = "REPLACE_FEISHU_PRODUCT_VIEW_ID";

/** record-list fields 数组中的列名（与 view REPLACE_FEISHU_PRODUCT_VIEW_ID 一致） */
export const F = {
  sku: "SKU",
  xhsTags: "小红书标签",
  xhsTitle: "小红书标题",
  xhsBody: "小红书正文",
  packStatus: "商品包状态",
  shelfFront: "货架正面图",
  shelfBack: "货架背面图",
  tryonMain: "试穿主图",
  tryonDetail: "试穿近景",
  tryonBack: "试穿背面",
  xhsGrid: "小红书四宫格",
};

/** 发布页选图顺序：四宫格 → 货架正/背 → 试穿主/近/背 */
export const XHS_IMAGE_FIELD_KEYS = [
  "xhsGrid",
  "shelfFront",
  "shelfBack",
  "tryonMain",
  "tryonDetail",
  "tryonBack",
];

export function splitTags(raw) {
  return String(raw || "")
    .split(/[,，、]/)
    .map((value) => value.trim().replace(/^#+/, ""))
    .filter(Boolean);
}

function attachmentCell(values, idx) {
  const cell = values[idx];
  if (!Array.isArray(cell) || !cell.length) return null;
  const file = cell.find((item) => item && item.file_token);
  if (!file) return null;
  return { file_token: file.file_token, name: file.name || `${file.file_token}.jpg` };
}

export function buildFieldIndex(fields) {
  const idx = Object.fromEntries(Object.values(F).map((name) => [name, fields.indexOf(name)]));
  for (const [key, name] of Object.entries(F)) {
    if (idx[name] < 0) throw new Error(`飞书表缺字段: ${name}（键 ${key}）`);
  }
  return idx;
}

export function parseXhsRow(values, idx, { recordId = null } = {}) {
  const get = (key) => values[idx[F[key]]] ?? null;
  const images = [];
  for (const key of XHS_IMAGE_FIELD_KEYS) {
    const att = attachmentCell(values, idx[F[key]]);
    if (!att) throw new Error(`缺图字段 ${F[key]}`);
    images.push({ field: key, ...att });
  }
  return {
    recordId,
    sku: String(get("sku") || "").trim(),
    title: String(get("xhsTitle") || "").trim(),
    body: String(get("xhsBody") || "").trim(),
    tags: splitTags(get("xhsTags")),
    packStatus: String(get("packStatus") || "").trim(),
    images,
  };
}

export function readFirstRowsFromRecordList(data, count = 4, { offset = 0 } = {}) {
  const fields = data.fields;
  if (!Array.isArray(fields)) throw new Error("飞书 record-list 无 fields");
  const idx = buildFieldIndex(fields);
  const rows = [];
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(0, Number(count) || 0);
  if (!Array.isArray(data.data) || data.data.length < end) {
    throw new Error(`飞书行不足：需要到第 ${end} 行，实际 ${data.data?.length || 0}`);
  }
  for (let i = start; i < end; i += 1) {
    const values = data.data[i];
    const recordId = data.record_id_list?.[i] || null;
    const row = parseXhsRow(values, idx, { recordId });
    if (row.packStatus && row.packStatus !== "READY_TO_PUBLISH") {
      throw new Error(`第 ${i + 1} 行 SKU=${row.sku} 状态=${row.packStatus}，非 READY_TO_PUBLISH`);
    }
    rows.push(row);
  }
  return rows;
}

export function xhsAlbumPath(alias) {
  return `/sdcard/Pictures/XhsPublish${Number(alias)}`;
}

/**
 * 推到手机的文件名：01-…06- 对应发布选图顺序（四宫格=01 … 试穿背=06）。
 * 前缀保证「按名升序」时四宫格仍第一。
 */
export function albumFileName(image, selectIndex) {
  const seq = String(selectIndex + 1).padStart(2, "0");
  const base = image.outName || `${image.field}-${image.name || "img.jpg"}`;
  return `${seq}-${base}`;
}

export function imageSelectIndex(image, images = null) {
  const fromField = XHS_IMAGE_FIELD_KEYS.indexOf(image?.field);
  if (fromField >= 0) return fromField;
  if (Array.isArray(images)) {
    const found = images.findIndex((item) => item === image || item?.field === image?.field);
    if (found >= 0) return found;
  }
  return 0;
}

/**
 * 推图顺序：倒序推（先推试穿背 … 最后推四宫格）。
 * 小红书相册「最新在前」：最后写入的四宫格 mtime 最新 → 落在左上第一格。
 * 文件名仍用 01-四宫格…06-，兼顾按名排序。
 */
export function pushOrderImages(images) {
  return [...images].reverse();
}
