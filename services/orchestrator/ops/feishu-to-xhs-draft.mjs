#!/usr/bin/env node
/**
 * 飞书发布表 → 真人身份拉图 → 手机相册保序暂存 → （可选）走 XHS 存草稿 UI 流。
 * 全程飞书侧 --as user；绝不点最终「发布」。
 *
 *   node ops/feishu-to-xhs-draft.mjs --record-id rec_xxx --alias 04 --push-only
 *   node ops/feishu-to-xhs-draft.mjs --record-id rec_xxx --alias 04 --select 2
 *   node ops/feishu-to-xhs-draft.mjs --record-id rec_xxx --alias 04 --select 2 --caption "文案"
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callLarkCli, DEFAULT_FEISHU_CONFIG } from "../scripts/lib/xhs-feishu-sync.mjs";
import { extractOrderedAttachments, downloadAttachmentsInOrder } from "../scripts/lib/feishu-attachment-loader.mjs";
import { stageImagesToDeviceAlbum, getXhsAlbumPath } from "../scripts/lib/device-album-staging.mjs";
import { validatePublishContent, assertDecodableImage } from "../scripts/lib/xhs-publish-preflight.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/feishu-to-xhs-draft.mjs --record-id <rec> --alias <01-07> [--push-only] [--select N] [--caption 文案]
飞书(真人身份 user)拉图 → 倒序 touch 保序推手机 → 交给 ops/xhs-save-draft.mjs 存草稿（不点发布）。`);
  process.exit(0);
}

const recordId = opt("--record-id");
const alias = opt("--alias", "04");
const pushOnly = flag("--push-only");
const selectN = Math.max(1, Math.min(9, Number(opt("--select", "2")) || 2));
const captionArg = opt("--caption");
if (!recordId) {
  console.log("✗ need --record-id");
  process.exit(4);
}

const t0 = Date.now();

// 1. 真人身份读记录（--as user 由 DEFAULT_FEISHU_CONFIG.identity 保证）
const row = callLarkCli([
  "base", "+record-get",
  "--base-token", DEFAULT_FEISHU_CONFIG.baseToken,
  "--table-id", DEFAULT_FEISHU_CONFIG.publishTableId,
  "--record-id", recordId,
  "--as", "user",
  "--format", "json",
]);
const cells = row?.data?.data?.[0];
const fields = row?.data?.fields || [];
if (!cells) {
  console.log("✗ record not found");
  process.exit(4);
}
const record = {};
fields.forEach((name, i) => { record[name] = cells[i]; });

const title = String(Array.isArray(record["笔记标题"]) ? record["笔记标题"][0] : record["笔记标题"] || "").trim();
const body = String(record["正文描述"] || "").trim();
const tags = Array.isArray(record["话题标签"]) ? record["话题标签"] : [];
const attachments = extractOrderedAttachments({ fields: record }, "图片素材");
const rawAttachmentCount = Array.isArray(record["图片素材"]) ? record["图片素材"].length : 0;
console.log(`TITLE=${title}`);
console.log(`BODY=${body.slice(0, 60)}`);
console.log(`TAGS=${tags.join(",")}`);
console.log(`IMAGES=${attachments.length}`);
if (!attachments.length) {
  console.log("✗ 图片素材为空，先在飞书上传图片");
  process.exit(4);
}
if (rawAttachmentCount > 9) {
  console.log(`✗ 图片素材 ${rawAttachmentCount} 张 > 9 上限（fail-closed，不静默丢图）`);
  process.exit(4);
}

// 内容预检：对齐 xhs.publish.edit_dry_run 硬限制，fail-closed 不截断（碰机之前拦下）
const effectiveCaption = captionArg || body || title;
try {
  const { fullBodyText } = validatePublishContent({
    title,
    body: effectiveCaption,
    tags,
    imageCount: Math.min(selectN, attachments.length),
  });
  console.log(`PREFLIGHT=ok fullBodyLen=${fullBodyText.length}`);
} catch (err) {
  console.log(`✗ 预检失败: ${err.message}`);
  process.exit(4);
}

// 2. 下载（强制 --as user，01-/02- 前缀）
const outDir = join(ROOT, "tmp-imgs", "feishu-draft", recordId);
mkdirSync(outDir, { recursive: true });
const downloaded = downloadAttachmentsInOrder({
  recordId,
  attachments,
  outputDir: outDir,
  config: { notesTableId: DEFAULT_FEISHU_CONFIG.publishTableId },
});
for (const d of downloaded) {
  console.log(`  ✓ ${d.fileName} sha=${d.sha256.slice(0, 12)}`);
}
if (downloaded.some((d) => !existsSync(d.localPath))) {
  console.log("✗ 下载缺文件");
  process.exit(2);
}
// magic-byte 检查：坏文件（HTML 错误页/0 字节）不推机
for (const d of downloaded) {
  try {
    assertDecodableImage(readFileSync(d.localPath), d.fileName);
  } catch (err) {
    console.log(`✗ ${err.message}`);
    process.exit(2);
  }
}

// 3. 倒序推送 + touch 保序（最后推封面 → mtime 最新 → 相册左上第一格）
const serialEnv = process.env.XHS_SERIAL_04;
let serial = serialEnv;
if (!serial) {
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), ".xhs-serial-cache.json"), "utf8"));
    serial = cache?.[alias]?.serial || null;
  } catch { /* fallthrough */ }
}
if (!serial) {
  console.log(`✗ alias ${alias} serial 未知（设 XHS_SERIAL_${alias} 或等待 serial 缓存生效）`);
  process.exit(4);
}

const staged = stageImagesToDeviceAlbum({
  serial,
  alias,
  images: downloaded.map((d) => ({
    orderIndex: d.orderIndex,
    localPath: d.localPath,
    fileName: d.fileName,
    sha256: d.sha256,
  })),
  options: { touchGapMs: 500 },
});
console.log(`STAGED_ALBUM=${getXhsAlbumPath(alias)}`);
for (const s of staged) {
  console.log(`  → ${s.phonePath} (order#${s.orderIndex + 1})`);
}
console.log(`PUSH_DONE=ok MS=${Date.now() - t0}`);

if (pushOnly) {
  console.log(`PUSH_ONLY=yes STOP_BEFORE_UI`);
  process.exit(0);
}

// 4. 存草稿 UI 流（绝不点发布）
const caption = effectiveCaption;
const child = spawn("node", [
  "ops/xhs-save-draft.mjs",
  "--alias", alias,
  "--select", String(selectN),
  "--caption", caption,
], { cwd: ROOT, stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));