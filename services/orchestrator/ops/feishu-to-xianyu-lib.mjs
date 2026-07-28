export const VALID_VERIFY_MODES = new Set(["replay", "constraint", "human", null]);

export function isValidVerifyMode(value) {
  return VALID_VERIFY_MODES.has(value ?? null);
}

export function redactSensitiveArgValues(text, args, sensitiveFlags = ["--token"]) {
  let redacted = String(text || "");
  for (let index = 0; index < args.length - 1; index += 1) {
    if (!sensitiveFlags.includes(args[index])) continue;
    const value = String(args[index + 1] || "");
    if (value) redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
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
  const hasState = (key) => Object.prototype.hasOwnProperty.call(state, key);
  const hasControl = (key) => Object.prototype.hasOwnProperty.call(control, key);
  return {
    alias,
    deviceId: control.deviceId || device.deviceId || null,
    ready: state.ready,
    quarantined: hasState("quarantined") ? state.quarantined
      : hasControl("quarantined") ? control.quarantined : null,
    leaseFree: hasState("leaseFree") ? state.leaseFree
      : hasControl("lease") ? control.lease == null : null,
    lease: control.lease || null,
    online: hasState("online") ? state.online
      : hasControl("online") ? control.online : null,
    serial: device.serial || control.serial || null,
    unresolvedFailure: device.jobStatus?.unresolvedFailure || null,
  };
}

export function classifyTarget(row, { force = false } = {}) {
  const hardProblems = [];
  const warnings = [];
  if (!row) return { hardProblems: ["设备不在 agent-entry.devices"], warnings, recoveryRequired: false };
  if (!row.deviceId) hardProblems.push("无 deviceId");
  if (row.quarantined !== false) hardProblems.push(row.quarantined === true ? "quarantined（先 recover）" : "quarantine 状态未知");
  if (row.online !== true) hardProblems.push(row.online === false ? "offline" : "online 状态未知");
  if (row.leaseFree !== true) hardProblems.push(row.leaseFree === false
    ? "目标设备 lease 已占用（--force 不可跳过）"
    : "目标设备 lease 状态未知（--force 不可跳过）");

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

export function summarizeJob(job) {
  const result = job.result || {};
  const verification = result.verification || job.verification || {};
  const restoration = result.restoration || job.restoration || {};
  const output = result.output || job.output || {};
  return {
    status: job.status || "?",
    errorCode: job.errorCode || null,
    outputOk: output.ok === true,
    verificationOk: verification.ok === true,
    restorationOk: restoration.ok === true,
    restorationFailed: restoration.ok === false,
    verificationFailed: verification.ok === false,
  };
}
