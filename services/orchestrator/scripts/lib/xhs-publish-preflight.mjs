/**
 * 发布内容预检（fail-closed，离线，不碰设备）。
 *
 * 权威约束 = control-plane apps/xhs/capabilities.json 的 xhs.publish.edit_dry_run.inputSchema
 * 以及 adapter（publish-edit-dry-run.mjs validatePublishTextParams）的二次校验：
 *   title ≤20；拼 tags 后 fullBodyText ≤300；tags ≤10 项且每项 ≤30；imageCount 1–9。
 * 这里按同一语义独立实现（运行时不 import control-plane），limits 漂移由
 * tests/xhs-publish-preflight.test.mjs 对照 capabilities.json 兜底。
 *
 * 红线：超限一律抛错（fail-closed），禁止 slice 截断——截断会静默改变发布内容语义。
 */

export const PUBLISH_LIMITS = {
  titleMax: 20,
  titleWeightedMax: 20,
  bodyMax: 300,
  tagsMax: 10,
  tagMax: 30,
  imageMin: 1,
  imageMax: 9,
};

/**
 * XHS 语义的标题计数：半角（ASCII）字符 2 个 = 1 字，全角/中文/emoji = 1 字。
 * emoji 的实际权重未实测，先按 1（保守），待真机验证后修正。
 */
export function xhsTitleWeightedLength(text) {
  let weight = 0;
  for (const ch of String(text ?? "")) {
    weight += ch.charCodeAt(0) < 128 ? 0.5 : 1;
  }
  return weight;
}

export function normalizePublishTags(tags) {
  if (tags == null) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(/[,，]/);
  return list
    .map((value) => String(value).trim().replace(/^#+/, ""))
    .filter(Boolean);
}

export function appendTagsToBody(bodyText, tags) {
  const normalized = normalizePublishTags(tags);
  if (!normalized.length) return String(bodyText ?? "").trim();
  const base = String(bodyText ?? "").trim();
  return `${base}${normalized.map((tag) => ` #${tag}`).join("")}`.trim();
}

/**
 * 校验发布文案与图片数。与 adapter validatePublishTextParams 同语义，但 fail-closed 抛错。
 * @param {Object} options
 * @param {'raw'|'xhs'} [options.titleCounting] - 标题计数模式：
 *   'raw'（默认）= JS 字符数 ≤20，对齐 CP xhs.publish.edit_dry_run inputSchema（正式 job 链用）；
 *   'xhs' = 加权计数（半角 2 字母=1 字）≤20，对齐小红书 App 自身限制（存草稿 UI 链用）。
 * @returns {{fullBodyText: string}} 通过时返回拼 tags 后的正文，供调用方留痕
 * @throws {Error} message 带 step 名（titleInvalid/bodyInvalid/tagsInvalid/imageCountInvalid/textInvalid）
 */
export function validatePublishContent({ title, body, tags, imageCount, titleCounting = "raw" } = {}) {
  const titleText = String(title ?? "").trim();
  const bodyText = String(body ?? "").trim();
  const normalizedTags = normalizePublishTags(tags);
  const fullBodyText = appendTagsToBody(bodyText, normalizedTags);

  if (titleCounting === "xhs") {
    const weighted = xhsTitleWeightedLength(titleText);
    if (weighted > PUBLISH_LIMITS.titleWeightedMax) {
      throw new Error(`titleInvalid: title 加权长度 ${weighted} > ${PUBLISH_LIMITS.titleWeightedMax} 字（半角 2 字母=1 字；fail-closed，不自动截断）`);
    }
  } else if (titleText.length > PUBLISH_LIMITS.titleMax) {
    throw new Error(`titleInvalid: title ${titleText.length} > ${PUBLISH_LIMITS.titleMax} 字（fail-closed，不自动截断，请在飞书表改短）`);
  }
  if (fullBodyText.length > PUBLISH_LIMITS.bodyMax) {
    throw new Error(`bodyInvalid: 正文拼 tags 后 ${fullBodyText.length} > ${PUBLISH_LIMITS.bodyMax} 字（fail-closed，不自动截断）`);
  }
  if (normalizedTags.length > PUBLISH_LIMITS.tagsMax) {
    throw new Error(`tagsInvalid: tags ${normalizedTags.length} > ${PUBLISH_LIMITS.tagsMax} 项`);
  }
  if (normalizedTags.some((tag) => tag.length > PUBLISH_LIMITS.tagMax)) {
    throw new Error(`tagsInvalid: 存在超过 ${PUBLISH_LIMITS.tagMax} 字的 tag`);
  }
  const count = Number(imageCount);
  if (!Number.isInteger(count) || count < PUBLISH_LIMITS.imageMin || count > PUBLISH_LIMITS.imageMax) {
    throw new Error(`imageCountInvalid: imageCount ${imageCount} 不在 ${PUBLISH_LIMITS.imageMin}–${PUBLISH_LIMITS.imageMax}`);
  }
  if (!titleText && !fullBodyText) {
    throw new Error("textInvalid: title 与正文均为空");
  }
  return { fullBodyText };
}

/**
 * 图片 magic-byte 检查：PNG (89 50 4E 47) 或 JPEG (FF D8 FF)。
 * @throws {Error} 非可解码图片
 */
export function assertDecodableImage(buffer, fileName = "image") {
  const bytes = buffer;
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    throw new Error(`imageDecodeInvalid: ${fileName} 不是 PNG/JPEG（magic bytes 不匹配），拒绝推机`);
  }
}