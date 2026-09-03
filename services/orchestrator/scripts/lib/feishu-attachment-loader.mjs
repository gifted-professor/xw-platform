import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callLarkCli, DEFAULT_FEISHU_CONFIG } from './xhs-feishu-sync.mjs';

/**
 * 飞书多维表格附件解析与顺序下载模块（严格以真实用户身份 --as user 执行）
 */

/**
 * 从飞书记录中解析有序附件列表。
 * 飞书附件 cell 返回「后上传在前」，reverse 后 orderIndex 0 = 用户第一个上传的图（封面）。
 * @param {Object} record - 包含 fields 的记录对象
 * @param {string} fieldName - 附件字段名称，默认 '图片素材'
 * @param {number} maxCount - 最大提取图片数，小红书单笔记最多9张图
 * @returns {Array<{orderIndex: number, fileToken: string, name: string, size?: number}>}
 */
export function extractOrderedAttachments(record, fieldName = '图片素材', maxCount = 9) {
  if (!record) return [];
  const fields = record.fields || record;
  const cell = fields[fieldName];

  if (!Array.isArray(cell) || cell.length === 0) {
    return [];
  }

  // 飞书附件字段返回的数组是「后上传在前」（最新优先），与用户上传顺序相反。
  // 先 reverse 使下标与上传顺序一致，再按下标确定展示次序（0 = 第一个上传 = 封面），限制 1~maxCount 张。
  const uploadOrder = [...cell].reverse();
  return uploadOrder.slice(0, maxCount).map((item, index) => {
    const fileToken = item.file_token || item.fileToken;
    if (!fileToken) {
      throw new Error(`第 ${index + 1} 个附件缺少 file_token: ${JSON.stringify(item)}`);
    }
    return {
      orderIndex: index, // 0 为封面图
      fileToken,
      name: item.name || `image_${index + 1}.jpg`,
      size: item.size || 0
    };
  });
}

/**
 * 下载单条记录的一组附件到本地临时目录，并保证文件名带两位数序号（如 01-xxx.jpg, 02-xxx.jpg）。
 * 强制使用 --as user 身份。
 *
 * @param {Object} params
 * @param {string} params.recordId - 飞书记录 ID
 * @param {Array<{orderIndex: number, fileToken: string, name: string}>} params.attachments - 有序附件列表
 * @param {string} params.outputDir - 本地存储目录
 * @param {Object} [params.config] - 飞书配置覆盖项（默认 identity 为 'user'）
 * @param {Function} [params.caller] - 可选的 lark-cli 调用函数（便于单测 mock）
 * @returns {Array<{orderIndex: number, fileToken: string, localPath: string, fileName: string, sha256: string}>}
 */
export function downloadAttachmentsInOrder({
  recordId,
  attachments,
  outputDir,
  config = {},
  caller = callLarkCli
}) {
  if (!recordId) {
    throw new Error('downloadAttachmentsInOrder requires recordId');
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const mergedConfig = { ...DEFAULT_FEISHU_CONFIG, ...config };
  const { baseToken, notesTableId, identity } = mergedConfig;

  // 强制校验或设为 user 身份
  const safeIdentity = identity || 'user';

  fs.mkdirSync(outputDir, { recursive: true });

  const downloadedFiles = [];

  for (const att of attachments) {
    const seqStr = String(att.orderIndex + 1).padStart(2, '0');
    // 过滤文件名特殊字符
    const sanitizedName = (att.name || `image_${seqStr}.jpg`).replace(/[^\w.-]/g, '_');
    const fileName = `${seqStr}-${sanitizedName}`;
    const localFilePath = path.join(outputDir, fileName);

    // 调用 lark-cli 下载附件
    // 注意：lark-cli 强制 --output 为相对路径（安全沙箱），必须 cwd=outputDir + 相对文件名
    caller([
      'base', '+record-download-attachment',
      '--base-token', baseToken,
      '--table-id', notesTableId,
      '--record-id', recordId,
      '--file-token', att.fileToken,
      '--output', fileName,
      '--overwrite',
      '--as', safeIdentity,
      '--format', 'json'
    ], { cwd: outputDir });

    if (!fs.existsSync(localFilePath)) {
      throw new Error(`附件下载失败，未找到目标文件: ${localFilePath}`);
    }

    const fileBuffer = fs.readFileSync(localFilePath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    downloadedFiles.push({
      orderIndex: att.orderIndex,
      fileToken: att.fileToken,
      localPath: localFilePath,
      fileName,
      sha256
    });
  }

  return downloadedFiles;
}
