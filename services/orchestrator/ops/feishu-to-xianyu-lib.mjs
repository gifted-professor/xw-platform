export const VALID_VERIFY_MODES = new Set(["replay", "constraint", "human", null]);

export function isValidVerifyMode(value) {
  return VALID_VERIFY_MODES.has(value ?? null);
}

export function planPhoneImages(images, aliases) {
  return Object.fromEntries(aliases.map((alias) => {
    const album = `XianyuFull${Number(alias)}`;
    return [alias, {
      album,
      images: images.map((image) => ({
        phonePath: `/sdcard/Pictures/${album}/${image.name}`,
        sha256: image.sha256,
      })),
    }];
  }));
}

export function assembleFixture(alias, product, pushed, {
  skuStock = "2",
  freight = "包邮",
} = {}) {
  const album = `XianyuFull${Number(alias)}`;
  const images = pushed[alias]?.images || [];
  return {
    descriptionPrefix: product.descriptionPrefix,
    productTitle: product.productTitle,
    descriptionBody: product.descriptionBody,
    price: product.price,
    skuPrice: product.price,
    skuStock,
    skuReplaceExisting: true,
    skuSpecs: {
      ...(product.colorArr.length > 1 ? { 颜色: product.colorArr } : {}),
      ...(product.sizeArr.length ? { 尺码: product.sizeArr } : {}),
    },
    freightTemplate: freight,
    imageAlbum: album,
    images,
    maxImages: Math.min(Math.max(images.length, 1), 9),
    saveDraft: false,
    skipAddress: true,
    skipCategory: true,
    calibrated: { freight: true, sku: true, image: true },
  };
}

export function deviceFromEntry(entry, alias) {
  const device = (entry.devices || []).find((item) => item.alias === alias);
  if (!device) return null;
  const state = device.state || {};
  const control = device.control || {};
  return {
    alias,
    deviceId: control.deviceId || device.deviceId || null,
    ready: state.ready,
    quarantined: state.quarantined ?? control.quarantined ?? null,
    leaseFree: state.leaseFree ?? (control.lease == null),
    lease: control.lease || null,
    online: state.online ?? control.online,
    serial: device.serial || control.serial || null,
    unresolvedFailure: device.jobStatus?.unresolvedFailure || null,
  };
}

export function classifyTarget(row, { force = false } = {}) {
  const hardProblems = [];
  const warnings = [];
  if (!row) return { hardProblems: ["设备不在 agent-entry.devices"], warnings, recoveryRequired: false };
  if (!row.deviceId) hardProblems.push("无 deviceId");
  if (row.quarantined === true) hardProblems.push("quarantined（先 recover）");
  if (row.online === false) hardProblems.push("offline");
  if (row.leaseFree === false) hardProblems.push("目标设备 lease 已占用（--force 不可跳过）");

  const recoveryRequired = row.ready !== true && row.unresolvedFailure != null;
  if (recoveryRequired) {
    warnings.push(`ready=false 且有 unresolvedFailure=${row.unresolvedFailure.errorCode || "unknown"}（先走恢复子路径）`);
  } else if (row.ready !== true) {
    warnings.push(force
      ? "FORCE=ready-only：跳过 ready=false 观测，仍由控制面裁决"
      : "ready=false 但 online/未隔离/lease 空：告警后允许 R0/R1 submit");
  }
  return { hardProblems, warnings, recoveryRequired };
}
