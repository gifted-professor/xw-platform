import { ControlPlaneError } from "./errors.mjs";
import { classifyRecoveryPage } from "../../scripts/recovery-page-classifier.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function boundedString(value, name, maxLength = 160) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", `${name} is required`, { status: 400 });
  }
  return value.trim().slice(0, maxLength);
}

function normalizeResolution(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", "image.resolution must be [width,height]", { status: 400 });
  }
  const resolution = value.map(Number);
  if (resolution.some((part) => !Number.isInteger(part) || part < 100 || part > 10000)) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", "image resolution is out of bounds", { status: 400 });
  }
  return resolution;
}

function normalizeElement(value, index, resolution) {
  if (!value || typeof value !== "object") {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", `elements[${index}] must be an object`, { status: 400 });
  }
  if (!Array.isArray(value.bounds) || value.bounds.length !== 4) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", `elements[${index}].bounds is invalid`, { status: 400 });
  }
  const bounds = value.bounds.map(Number);
  const [width, height] = resolution;
  if (bounds.some((part) => !Number.isFinite(part))
    || bounds[0] < 0 || bounds[1] < 0
    || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]
    || bounds[2] > width || bounds[3] > height) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", `elements[${index}].bounds is outside the image`, { status: 400 });
  }
  const confidence = value.conf === undefined ? null : Number(value.conf);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", `elements[${index}].conf is invalid`, { status: 400 });
  }
  return {
    id: typeof value.id === "string" ? value.id.slice(0, 120) : `element-${index}`,
    label: String(value.label || "").replace(/\s+/g, " ").trim().slice(0, 240),
    bounds,
    center: [
      Math.round((bounds[0] + bounds[2]) / 2),
      Math.round((bounds[1] + bounds[3]) / 2),
    ],
    conf: confidence,
    source: typeof value.source === "string" ? value.source.slice(0, 80) : "unknown",
    ...(typeof value.tap_policy === "string" ? { tapPolicy: value.tap_policy.slice(0, 80) } : {}),
  };
}

function normalizeTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => /^[A-Za-z][A-Za-z0-9_.-]{0,60}$/.test(key)
      && Number.isFinite(Number(item))
      && Number(item) >= 0
      && Number(item) <= 600000)
    .map(([key, item]) => [key, Number(item)]));
}

export function normalizeRecoveryVisualAnalysis(input, { expectedImageSha256, focus = null } = {}) {
  if (!input || typeof input !== "object" || input.schemaVersion !== "xhs.visual-elements.v1") {
    throw new ControlPlaneError(
      "RECOVERY_ANALYSIS_SCHEMA_INVALID",
      "analysis must use schemaVersion xhs.visual-elements.v1",
      { status: 400 },
    );
  }
  const imageSha256 = String(input.image?.sha256 || "").toLowerCase();
  if (!SHA256.test(imageSha256)) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", "image.sha256 is invalid", { status: 400 });
  }
  if (imageSha256 !== expectedImageSha256) {
    throw new ControlPlaneError(
      "RECOVERY_ANALYSIS_IMAGE_HASH_MISMATCH",
      "analysis image hash does not match the audited screenshot",
      { status: 409, details: { expectedImageSha256, receivedImageSha256: imageSha256 } },
    );
  }
  const resolution = normalizeResolution(input.image?.resolution);
  if (!Array.isArray(input.elements) || input.elements.length > 1000) {
    throw new ControlPlaneError("RECOVERY_ANALYSIS_SCHEMA_INVALID", "elements must contain at most 1000 entries", { status: 400 });
  }
  const elements = input.elements.map((value, index) => normalizeElement(value, index, resolution));
  const analyzer = {
    name: boundedString(input.analyzer?.name, "analyzer.name"),
    version: boundedString(input.analyzer?.version, "analyzer.version"),
    timings: normalizeTimings(input.analyzer?.timings),
  };
  const pageClassification = classifyRecoveryPage({ elements, focus, resolution });
  return {
    schemaVersion: "xhs.visual-elements.v1",
    image: {
      sha256: imageSha256,
      resolution,
      ...(Number.isInteger(Number(input.image?.bytes)) && Number(input.image.bytes) > 0
        ? { bytes: Number(input.image.bytes) }
        : {}),
    },
    analyzer,
    elementCount: elements.length,
    elements,
    pageClassification,
  };
}
