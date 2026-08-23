import { createHash } from "node:crypto";

const REDLINE = /(支付|付款|pay(?:ment)?|删除|delete|发布|publish|评论|comment|关注|follow|私信|message|登录|login|账号|account)/iu;
const AD = /(广告|推广|sponsor|\bad\b)/iu;
const KEYBOARD = /(keyboard|inputmethod|输入法|键盘|sogou|iflytek|baidu\.input)/iu;
const SYSTEM_PACKAGE = /^(android|com\.android|com\.miui|com\.google\.android\.inputmethod)/u;
const FORBIDDEN_OPERATION = /(payment|delete|publish|comment|follow|message|account|settings_write)/iu;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function m6LiveSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashText(value) {
  return value ? m6LiveSha256(String(value).normalize("NFKC").trim().toLowerCase()) : null;
}

function decodeXml(value = "") {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function attributes(fragment) {
  const result = {};
  for (const match of fragment.matchAll(/([A-Za-z0-9_$:.-]+)="([^"]*)"/gu)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function bounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(value || "");
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

export function deriveTargetEnvironmentAttestation(input) {
  const raw = {
    schemaId: "xw.m6-target-environment-attestation.v1",
    appPackageHash: input.appPackageHash,
    appBuildHash: input.appBuildHash,
    signingHash: input.signingHash,
    osBuildHash: input.osBuildHash,
    displayHash: input.displayHash,
    localeThemeHash: input.localeThemeHash,
    imeHash: input.imeHash,
    accessibilityHash: input.accessibilityHash,
    accountIsolationHash: input.accountIsolationHash,
    capturedAt: input.capturedAt,
    expiresAt: input.expiresAt,
  };
  if (Object.entries(raw).some(([key, value]) => key.endsWith("Hash") && !/^[0-9a-f]{64}$/.test(value || ""))) {
    throw Object.assign(new Error("environment attestation has an invalid hash"), { code: "M6_ENV_ATTESTATION_INVALID" });
  }
  if (!Number.isFinite(Date.parse(raw.capturedAt)) || !Number.isFinite(Date.parse(raw.expiresAt))
    || Date.parse(raw.expiresAt) <= Date.parse(raw.capturedAt)) {
    throw Object.assign(new Error("environment attestation lifetime is invalid"), { code: "M6_ENV_ATTESTATION_INVALID" });
  }
  return Object.freeze({ ...raw, attestationHash: m6LiveSha256(`xw.m6-target-environment-attestation.v1:${canonical(raw)}`) });
}

export function deriveLiveVisualBlockSet({ frame, dumpXml, environmentAttestation }) {
  if (!frame || !/^[0-9a-f]{64}$/.test(frame.frameId || "") || typeof dumpXml !== "string" || !dumpXml.includes("<hierarchy")) {
    return { disposition: "REPLAN", reason: "M6_LIVE_DUMP_UNUSABLE", blockSet: null, privateGeometry: new Map() };
  }
  if (!environmentAttestation || environmentAttestation.attestationHash !== frame.environmentAttestationHash) {
    return { disposition: "REPLAN", reason: "M6_ENV_ATTESTATION_MISMATCH", blockSet: null, privateGeometry: new Map() };
  }
  const rawNodes = Array.from(dumpXml.matchAll(/<node\b([^>]*)\/?\s*>/gu), (match) => attributes(match[1]));
  const parsed = rawNodes.map((attrs) => ({ attrs, bounds: bounds(attrs.bounds) }));
  const width = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.x2));
  const height = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.y2));
  const privateGeometry = new Map();
  const blocks = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const { attrs, bounds: region } = parsed[index];
    const semantic = [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class].filter(Boolean).join(" ").normalize("NFKC");
    const packageName = attrs.package || /^([^:]+):id\//u.exec(attrs["resource-id"] || "")?.[1] || "unknown";
    const flags = {
      clickable: attrs.clickable === "true",
      scrollable: attrs.scrollable === "true",
      editable: /EditText/u.test(attrs.class || ""),
      system: SYSTEM_PACKAGE.test(packageName),
      sensitive: REDLINE.test(semantic),
      advertisement: AD.test(semantic),
      keyboard: KEYBOARD.test(`${semantic} ${packageName}`),
    };
    const actionable = region && (flags.clickable || flags.scrollable || flags.editable);
    const safeRegion = actionable && width > 0 && height > 0 && region.y1 >= Math.floor(height * 0.03)
      && region.y2 <= Math.ceil(height * 0.94) && !flags.sensitive && !flags.advertisement && !flags.keyboard;
    if (!actionable || !safeRegion) continue;
    const publicFeatures = {
      classHash: hashText(attrs.class),
      resourceHash: hashText(attrs["resource-id"]),
      textHash: hashText(attrs.text),
      descriptionHash: hashText(attrs["content-desc"]),
      packageHash: hashText(packageName),
      structureHash: m6LiveSha256(canonical({ index, classHash: hashText(attrs.class), resourceHash: hashText(attrs["resource-id"]) })),
      flags,
      safeRegion: true,
    };
    const nodeFingerprint = m6LiveSha256(canonical({ frameId: frame.frameId, index, ...publicFeatures }));
    const blockId = m6LiveSha256(`xw.m6-live-block.v1:${frame.frameId}:${nodeFingerprint}`);
    const boundsRef = m6LiveSha256(`xw.m6-private-bounds.v1:${blockId}:${canonical(region)}`);
    privateGeometry.set(boundsRef, Object.freeze({ ...region }));
    blocks.push(Object.freeze({ blockId, boundsRef, nodeFingerprint, ...publicFeatures }));
  }
  blocks.sort((a, b) => a.blockId.localeCompare(b.blockId));
  const pageFingerprint = m6LiveSha256(canonical({ frameId: frame.frameId, blocks: blocks.map((block) => block.blockId) }));
  const core = {
    schemaId: "xw.visual-block-set.v2",
    frameId: frame.frameId,
    environmentAttestationHash: environmentAttestation.attestationHash,
    pageFingerprint,
    blocks,
  };
  return {
    disposition: blocks.length > 0 ? "ALLOW_ONCE" : "REPLAN",
    reason: blocks.length > 0 ? null : "M6_LIVE_NO_SAFE_BLOCKS",
    blockSet: Object.freeze({ ...core, integritySha256: m6LiveSha256(`xw.visual-block-set.v2:${canonical(core)}`) }),
    privateGeometry,
  };
}

export function decideLiveGrounding({ frame, blockSet, intent, candidateBlockId = null, bindings }) {
  const targetKind = intent?.targetKind;
  let disposition = "ALLOW_ONCE";
  let target;
  if (!intent || FORBIDDEN_OPERATION.test(intent.operation || "")) disposition = "HARD_STOP";
  if (targetKind === "block") {
    const block = blockSet?.blocks?.find((candidate) => candidate.blockId === candidateBlockId);
    if (!block || !block.safeRegion || block.flags?.sensitive || block.flags?.advertisement || block.flags?.keyboard) disposition = "REPLAN";
    target = block ? { kind: "block", frameId: frame.frameId, blockId: block.blockId } : { kind: "none" };
  } else if (targetKind === "screen") {
    target = { kind: "screen", frameId: frame.frameId, pageFingerprint: blockSet.pageFingerprint, focusHash: frame.focusHash };
  } else if (targetKind === "none") {
    target = { kind: "none" };
  } else {
    disposition = "HARD_STOP";
    target = { kind: "none" };
  }
  if (blockSet?.frameId !== frame?.frameId || blockSet?.environmentAttestationHash !== bindings?.environmentAttestationHash) {
    disposition = "REPLAN";
  }
  const raw = {
    schemaId: "xw.grounding-decision.v2",
    operationKey: intent?.operationKey || "invalid",
    disposition,
    target,
    bindings: { ...bindings },
  };
  return Object.freeze({ ...raw, decisionRef: m6LiveSha256(`xw.grounding-decision.v2:${canonical(raw)}`) });
}
