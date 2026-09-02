import { createHash } from "node:crypto";

const REDLINE = /(支付|付款|pay(?:ment)?|删除|delete|发布|publish|评论|comment|关注|follow|私信|message|登录|login|账号|account)/iu;
const AD = /(广告|推广|sponsor|\bad\b)/iu;
const KEYBOARD = /(keyboard|inputmethod|输入法|键盘|sogou|iflytek|baidu\.input)/iu;
const SYSTEM_PACKAGE = /^(android|com\.android|com\.miui|com\.google\.android\.inputmethod)/u;
const FORBIDDEN_OPERATION = /(payment|financial|delete|destructive|publish|public|social|comment|follow|message|account|security|settings?|draft)/iu;
const UI_REDLINE_RADIUS_RATIO = 0.03;

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

function parseUiTree(dumpXml) {
  const nodes = [];
  const stack = [];
  let structurallyValid = true;
  for (const match of dumpXml.matchAll(/<\/?node\b[^>]*>/gu)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      if (stack.length === 0) structurallyValid = false;
      else stack.pop();
      continue;
    }
    const attributeText = /^<node\b([^>]*)>/u.exec(tag)?.[1] || "";
    const attrs = attributes(attributeText);
    const parentIndex = stack.length > 0 ? stack.at(-1) : null;
    const index = nodes.length;
    nodes.push({ index, attrs, bounds: bounds(attrs.bounds), parentIndex, children: [] });
    if (parentIndex !== null) nodes[parentIndex].children.push(index);
    if (!/\/\s*>$/u.test(tag)) stack.push(index);
  }
  return { nodes, structurallyValid: structurallyValid && stack.length === 0 };
}

function descendants(nodes, index, result = []) {
  for (const childIndex of nodes[index].children) {
    result.push(childIndex);
    descendants(nodes, childIndex, result);
  }
  return result;
}

function ancestors(nodes, index) {
  const result = [];
  let cursor = nodes[index].parentIndex;
  while (cursor !== null) {
    result.push(cursor);
    cursor = nodes[cursor].parentIndex;
  }
  return result;
}

function rectangleDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = Math.max(a.x1 - b.x2, b.x1 - a.x2, 0);
  const dy = Math.max(a.y1 - b.y2, b.y1 - a.y2, 0);
  return Math.hypot(dx, dy);
}

function nodeSemantic(attrs) {
  return [attrs.text, attrs["content-desc"], attrs["resource-id"], attrs.class]
    .filter(Boolean).join(" ").normalize("NFKC");
}

export function deriveM6PrivateBoundsRef({ blockId, bounds: region }) {
  if (!/^[0-9a-f]{64}$/u.test(blockId || "") || !region
    || ![region.x1, region.y1, region.x2, region.y2].every(Number.isInteger)
    || region.x2 <= region.x1 || region.y2 <= region.y1) {
    throw Object.assign(new Error("private block bounds are invalid"), { code: "M6_PRIVATE_BOUNDS_INVALID" });
  }
  return m6LiveSha256(`xw.m6-private-bounds.v1:${blockId}:${canonical(region)}`);
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
    accountBindingHash: input.accountBindingHash,
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
  const parsedTree = parseUiTree(dumpXml);
  if (!parsedTree.structurallyValid) {
    return { disposition: "HARD_STOP", reason: "M6_LIVE_DUMP_STRUCTURE_INVALID", blockSet: null, privateGeometry: new Map() };
  }
  const parsed = parsedTree.nodes;
  const width = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.x2));
  const height = Math.max(0, ...parsed.filter((node) => node.bounds).map((node) => node.bounds.y2));
  const redlineRadius = Math.max(24, Math.min(96, Math.round(Math.min(width, height) * UI_REDLINE_RADIUS_RATIO)));
  const privateGeometry = new Map();
  const blocks = [];
  let redlineCandidateCount = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    const { attrs, bounds: region } = parsed[index];
    const related = new Set([index, ...ancestors(parsed, index), ...descendants(parsed, index)]);
    for (const neighbor of parsed) {
      if (neighbor.index !== index && rectangleDistance(region, neighbor.bounds) <= redlineRadius) related.add(neighbor.index);
    }
    const semantic = [...related].map((relatedIndex) => nodeSemantic(parsed[relatedIndex].attrs)).filter(Boolean).join(" ");
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
    if (actionable && flags.sensitive) redlineCandidateCount += 1;
    const safeRegion = actionable && width > 0 && height > 0 && region.y1 >= Math.floor(height * 0.03)
      && region.y2 <= Math.ceil(height * 0.94) && !flags.sensitive && !flags.advertisement && !flags.keyboard;
    if (!actionable || !safeRegion) continue;
    const publicFeatures = {
      classHash: hashText(attrs.class),
      resourceHash: hashText(attrs["resource-id"]),
      textHash: hashText(attrs.text),
      descriptionHash: hashText(attrs["content-desc"]),
      packageHash: hashText(packageName),
      structureHash: m6LiveSha256(canonical({
        index,
        parentIndex: parsed[index].parentIndex,
        childCount: parsed[index].children.length,
        relatedSemanticHashes: [...related].map((relatedIndex) => hashText(nodeSemantic(parsed[relatedIndex].attrs))).filter(Boolean).sort(),
        classHash: hashText(attrs.class),
        resourceHash: hashText(attrs["resource-id"]),
      })),
      flags,
      safeRegion: true,
    };
    const nodeFingerprint = m6LiveSha256(canonical({ frameId: frame.frameId, index, ...publicFeatures }));
    const blockId = m6LiveSha256(`xw.m6-live-block.v1:${frame.frameId}:${nodeFingerprint}`);
    const boundsRef = deriveM6PrivateBoundsRef({ blockId, bounds: region });
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
    disposition: blocks.length > 0 ? "ALLOW_ONCE" : redlineCandidateCount > 0 ? "HARD_STOP" : "REPLAN",
    reason: blocks.length > 0 ? null : redlineCandidateCount > 0 ? "M6_LIVE_HARD_REDLINE_NO_SAFE_CANDIDATE" : "M6_LIVE_NO_SAFE_BLOCKS",
    blockSet: blocks.length > 0
      ? Object.freeze({ ...core, integritySha256: m6LiveSha256(`xw.visual-block-set.v2:${canonical(core)}`) })
      : null,
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
