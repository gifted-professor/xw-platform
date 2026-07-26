const XIANYU_PACKAGE = "com.taobao.idlefish";

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function validBounds(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every((part) => Number.isFinite(Number(part)));
}

function normalizeEntries(elements = [], semanticNodes = []) {
  const entries = [];
  for (const [source, values] of [["visual", elements], ["semantic", semanticNodes]]) {
    for (const value of values || []) {
      const label = cleanLabel(value?.label ?? value?.text ?? value?.contentDesc);
      if (!label) continue;
      entries.push({
        label,
        bounds: validBounds(value?.bounds) ? value.bounds.map(Number) : null,
        source,
      });
    }
  }
  return entries.filter((entry, index, all) => all.findIndex((other) => (
    other.label === entry.label
    && other.source === entry.source
    && JSON.stringify(other.bounds) === JSON.stringify(entry.bounds)
  )) === index);
}

function matching(entries, pattern, predicate = () => true) {
  return entries.filter((entry) => pattern.test(entry.label) && predicate(entry));
}

function labelsOf(entries) {
  return [...new Set(entries.map((entry) => entry.label))].slice(0, 24);
}

function result(pageType, confidence, matches, reasons, sourceCounts) {
  return {
    schemaVersion: 1,
    pageType,
    confidence: Number(confidence.toFixed(3)),
    safeStateVerified: pageType === "main-safe" && confidence >= 0.9,
    matchedLabels: labelsOf(matches),
    reasons,
    sources: sourceCounts,
  };
}

export function classifyXianyuPage({
  elements = [],
  semanticNodes = [],
  focus = null,
  resolution = null,
} = {}) {
  const entries = normalizeEntries(elements, semanticNodes);
  const sourceCounts = {
    visual: entries.filter((entry) => entry.source === "visual").length,
    semantic: entries.filter((entry) => entry.source === "semantic").length,
  };
  const height = Array.isArray(resolution) && Number(resolution[1]) > 0
    ? Number(resolution[1])
    : 2400;
  const inBottomBar = (entry) => entry.bounds && entry.bounds[1] >= height * 0.82;

  const discard = matching(entries, /不保存|放弃修改|放弃编辑/);
  const draft = matching(entries, /存草稿|保存草稿/);
  if (discard.length && draft.length) {
    return result(
      "discard-dialog",
      0.99,
      [...discard, ...draft],
      ["discard and draft actions are visible in the same dialog"],
      sourceCounts,
    );
  }

  const countedNext = matching(entries, /下一步\s*[（(]\s*\d+\s*[）)]/);
  const pickerMarker = matching(entries, /相册|最近项目|所有照片|拍照|拍视频/);
  if (countedNext.length || (pickerMarker.length >= 2 && matching(entries, /完成|下一步/).length)) {
    return result(
      "image-picker",
      countedNext.length && pickerMarker.length ? 0.98 : 0.92,
      [...countedNext, ...pickerMarker],
      ["image-picker navigation fingerprint is present"],
      sourceCounts,
    );
  }

  const stock = matching(entries, /(^|\s)库存($|\s)|库存数量/);
  const price = matching(entries, /(^|\s)价格($|\s)|售价/);
  const skuMarker = matching(entries, /批量设置|商品规格|销售属性|规格名称|规格值/);
  if (stock.length && price.length && skuMarker.length) {
    return result(
      "sku-sheet",
      0.97,
      [...stock, ...price, ...skuMarker],
      ["stock, price, and SKU configuration markers are present"],
      sourceCounts,
    );
  }

  const description = matching(entries, /宝贝描述|说说宝贝|描述一下宝贝|宝贝标题/);
  const commerce = matching(entries, /商品规格|分类|成色|运费|发货方式|退货地址/);
  const publish = matching(entries, /(^|\s)发布($|\s)/);
  if (description.length && commerce.length && publish.length) {
    return result(
      "publish-compose",
      0.96,
      [...description, ...commerce, ...publish],
      ["description, commerce field, and final publish markers are present"],
      sourceCounts,
    );
  }

  const bottomHome = matching(entries, /^(闲鱼|首页)$/, inBottomBar);
  const bottomMessages = matching(entries, /^消息$/, inBottomBar);
  const bottomMine = matching(entries, /^我的$/, inBottomBar);
  const bottomMatches = [...bottomHome, ...bottomMessages, ...bottomMine];
  const visualBottomLabels = new Set(bottomMatches
    .filter((entry) => entry.source === "visual")
    .map((entry) => entry.label));
  const focusIsMain = focus?.package === XIANYU_PACKAGE && /MainActivity/.test(String(focus?.activity || ""));
  const visualMainFingerprint = (visualBottomLabels.has("闲鱼") || visualBottomLabels.has("首页"))
    && visualBottomLabels.has("消息")
    && visualBottomLabels.has("我的");
  if (focusIsMain && visualMainFingerprint) {
    return result(
      "main-safe",
      0.98,
      bottomMatches,
      ["fresh MainActivity focus and complete bottom-bar fingerprint agree"],
      sourceCounts,
    );
  }

  const reasons = [];
  if (!entries.length) reasons.push("no visual or semantic labels were available");
  if (focusIsMain && !visualMainFingerprint) {
    reasons.push("MainActivity focus lacks the complete visual bottom-bar fingerprint");
  }
  if (!reasons.length) reasons.push("no page fingerprint reached the fail-closed threshold");
  return result("unknown", 0, entries.slice(0, 12), reasons, sourceCounts);
}
