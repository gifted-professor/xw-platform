import { createHash } from "node:crypto";

export const XHS_EXPLORATION_VISION_CORPUS_SCHEMA_ID =
  "xw.xhs.exploration-vision-corpus.v1";

export const XHS_EXPLORATION_VISION_CORPUS_ROUTES = Object.freeze([
  "HOME_FEED",
  "SEARCH_RESULTS",
  "IMAGE_NOTE",
  "VIDEO_NOTE",
  "COMMENT_PANEL",
]);

export const XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE = 3;
export const XHS_EXPLORATION_VISION_CORPUS_MIN_CONFIDENCE = 0.9;

const ROUTE_ROLES = Object.freeze({
  HOME_FEED: Object.freeze(["OPEN_CONTENT_CARD"]),
  SEARCH_RESULTS: Object.freeze(["OPEN_CONTENT_CARD"]),
  IMAGE_NOTE: Object.freeze(["OPEN_COMMENT_PANEL"]),
  VIDEO_NOTE: Object.freeze(["PAUSE_VIDEO_SAFE_ZONE", "OPEN_COMMENT_PANEL"]),
  COMMENT_PANEL: Object.freeze(["BACK"]),
});

const DUMP_VERDICTS = new Set(["AMBIGUOUS_SAFE", "ABSENT_OR_INVALID"]);
const PROTECTED_REGION_KINDS = new Set([
  "STATUS_BAR",
  "TOP_CHROME",
  "BOTTOM_NAV",
  "SOCIAL_ACTIONS",
  "COMMENT_COMPOSER",
]);
const IDENTITY_FIELDS = Object.freeze(["pythonHash", "modelHash", "scriptHash", "configHash"]);
const HEX_64 = /^[0-9a-f]{64}$/;
const SOURCE_REF = /^src:[0-9a-f]{64}$/;
const ALIAS = /^0[1-4]$/;
const FORBIDDEN_PUBLIC_KEYS = new Set([
  "path",
  "filepath",
  "filename",
  "file",
  "root",
  "ocr",
  "ocrtext",
  "text",
  "label",
  "landmark",
  "landmarks",
  "serial",
  "leaseid",
  "actor",
]);
const EFFECT_SEMANTIC_CLASSES = new Set([
  "EFFECT_CONTROL",
  "SOCIAL_EFFECT",
  "LIKE",
  "FAVORITE",
  "FOLLOW",
  "COMMENT_SUBMIT",
  "SHARE",
]);

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function annotationBody(row) {
  return {
    sourceRef: row?.sourceRef ?? null,
    frame: row?.frame ?? null,
    pageClass: row?.pageClass ?? null,
    dumpVerdict: row?.dumpVerdict ?? null,
    positiveRoles: row?.positiveRoles ?? null,
    geometry: row?.geometry ?? null,
  };
}

/**
 * Hand-authored annotations are sealed independently from provider output.
 * The digest binds source, exact frame, route, DUMP verdict, roles and geometry.
 */
export function deriveVisionCorpusAnnotationHash(row) {
  return sha256(Buffer.from(stableJson(annotationBody(row)), "utf8"));
}

function issue(errors, code, message, rowId = null) {
  errors.push(rowId ? { code, rowId, message } : { code, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBounds(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every(Number.isInteger)
    && value[0] >= 0
    && value[1] >= 0
    && value[2] > value[0]
    && value[3] > value[1];
}

function scanPublicValue(value, errors, pointer = "$") {
  if (typeof value === "string") {
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(?:home|users|var|tmp)\//i.test(value)) {
      issue(errors, "CORPUS_PUBLIC_PATH_FORBIDDEN", `absolute path at ${pointer}`);
    }
    if (/\brun_[0-9a-f-]{16,}\b/i.test(value)) {
      issue(errors, "CORPUS_RAW_RUN_ID_FORBIDDEN", `raw run identity at ${pointer}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPublicValue(item, errors, `${pointer}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) {
      issue(errors, "CORPUS_PUBLIC_FIELD_FORBIDDEN", `forbidden public field ${pointer}.${key}`);
    }
    scanPublicValue(child, errors, `${pointer}.${key}`);
  }
}

function validateFrame(frame, errors, rowId) {
  if (!isPlainObject(frame)) {
    issue(errors, "CORPUS_FRAME_INVALID", "frame must be an object", rowId);
    return;
  }
  if (!HEX_64.test(String(frame.sha256 ?? ""))) {
    issue(errors, "CORPUS_FRAME_HASH_INVALID", "frame.sha256 must be lowercase sha256", rowId);
  }
  if (!Number.isInteger(frame.width) || frame.width <= 0
    || !Number.isInteger(frame.height) || frame.height <= 0) {
    issue(errors, "CORPUS_FRAME_DIMS_INVALID", "frame dimensions must be positive integers", rowId);
  }
  if (!ALIAS.test(String(frame.alias ?? ""))) {
    issue(errors, "CORPUS_FRAME_ALIAS_INVALID", "frame.alias must be 01..04", rowId);
  }
  const hasReceipt = HEX_64.test(String(frame.receiptHash ?? ""));
  const hasRelease = HEX_64.test(String(frame.releaseHash ?? ""));
  if (!hasReceipt && !hasRelease) {
    issue(errors, "CORPUS_FRAME_PROVENANCE_INVALID", "frame needs a receiptHash or releaseHash", rowId);
  }
  const keys = Object.keys(frame);
  if (keys.some((key) => !["sha256", "width", "height", "alias", "receiptHash", "releaseHash"].includes(key))) {
    issue(errors, "CORPUS_FRAME_FIELD_INVALID", "frame contains an unrecognized public field", rowId);
  }
}

function validateGeometry(row, errors, rowId) {
  const geometry = row?.geometry;
  if (!isPlainObject(geometry)
    || !Array.isArray(geometry.positiveRegions)
    || geometry.positiveRegions.length === 0
    || !Array.isArray(geometry.protectedRegions)
    || geometry.protectedRegions.length === 0) {
    issue(errors, "CORPUS_GEOMETRY_INVALID", "geometry needs positiveRegions and protectedRegions", rowId);
    return;
  }
  if (Object.keys(geometry).some((key) => !["positiveRegions", "protectedRegions"].includes(key))) {
    issue(errors, "CORPUS_GEOMETRY_FIELD_INVALID", "geometry contains an unrecognized public field", rowId);
  }
  for (const region of geometry.positiveRegions) {
    if (!isPlainObject(region)
      || !Array.isArray(row.positiveRoles)
      || !row.positiveRoles.includes(region.role)
      || !isBounds(region.bounds)
      || Object.keys(region).some((key) => !["role", "bounds"].includes(key))) {
      issue(errors, "CORPUS_POSITIVE_REGION_INVALID", "positive region must bind an allowed role to valid bounds", rowId);
      continue;
    }
    if (Number.isInteger(row.frame?.width) && Number.isInteger(row.frame?.height)
      && !boundsInsideFrame(region.bounds, row.frame.width, row.frame.height)) {
      issue(errors, "CORPUS_POSITIVE_REGION_OOB", "positive region exceeds frame bounds", rowId);
    }
  }
  for (const region of geometry.protectedRegions) {
    if (!isPlainObject(region)
      || !PROTECTED_REGION_KINDS.has(region.kind)
      || !isBounds(region.bounds)
      || Object.keys(region).some((key) => !["kind", "bounds"].includes(key))) {
      issue(errors, "CORPUS_PROTECTED_REGION_INVALID", "protected region kind/bounds are invalid", rowId);
      continue;
    }
    if (Number.isInteger(row.frame?.width) && Number.isInteger(row.frame?.height)
      && !boundsInsideFrame(region.bounds, row.frame.width, row.frame.height)) {
      issue(errors, "CORPUS_PROTECTED_REGION_OOB", "protected region exceeds frame bounds", rowId);
    }
  }
}

function derivedCoverage(manifest) {
  const counts = Object.fromEntries(XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [route, 0]));
  const hashes = Object.fromEntries(XHS_EXPLORATION_VISION_CORPUS_ROUTES.map((route) => [route, new Set()]));
  for (const row of Array.isArray(manifest?.rows) ? manifest.rows : []) {
    if (!XHS_EXPLORATION_VISION_CORPUS_ROUTES.includes(row?.pageClass)) continue;
    const hash = String(row?.frame?.sha256 ?? "");
    if (HEX_64.test(hash)) hashes[row.pageClass].add(hash);
  }
  for (const route of XHS_EXPLORATION_VISION_CORPUS_ROUTES) counts[route] = hashes[route].size;
  const verifiedRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES
    .filter((route) => counts[route] >= XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE);
  const missingRoutes = XHS_EXPLORATION_VISION_CORPUS_ROUTES
    .filter((route) => counts[route] < XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE);
  return {
    complete: missingRoutes.length === 0,
    distinctFramesByRoute: counts,
    verifiedRoutes,
    missingRoutes,
  };
}

/** Validate the public, pixel-free corpus manifest without resolving private evidence. */
export function validateVisionCorpusManifest(manifest) {
  const errors = [];
  scanPublicValue(manifest, errors);
  if (!isPlainObject(manifest)
    || manifest.schemaId !== XHS_EXPLORATION_VISION_CORPUS_SCHEMA_ID
    || manifest.schemaVersion !== 1) {
    issue(errors, "CORPUS_SCHEMA_INVALID", `expected ${XHS_EXPLORATION_VISION_CORPUS_SCHEMA_ID}@1`);
  }
  const topLevelKeys = [
    "schemaId", "schemaVersion", "requiredRoutes",
    "minimumDistinctFramesPerRoute", "coverage", "rows",
  ];
  if (isPlainObject(manifest)
    && Object.keys(manifest).some((key) => !topLevelKeys.includes(key))) {
    issue(errors, "CORPUS_PUBLIC_FIELD_INVALID", "manifest contains an unrecognized public field");
  }
  if (stableJson(manifest?.requiredRoutes) !== stableJson(XHS_EXPLORATION_VISION_CORPUS_ROUTES)) {
    issue(errors, "CORPUS_ROUTES_INVALID", "requiredRoutes must be the closed five-route set in canonical order");
  }
  if (manifest?.minimumDistinctFramesPerRoute !== XHS_EXPLORATION_VISION_CORPUS_MIN_FRAMES_PER_ROUTE) {
    issue(errors, "CORPUS_MINIMUM_INVALID", "minimumDistinctFramesPerRoute is fixed at 3");
  }
  if (!Array.isArray(manifest?.rows)) {
    issue(errors, "CORPUS_ROWS_INVALID", "rows must be an array");
  }

  const rowIds = new Set();
  const sourceRefs = new Set();
  const frameHashes = new Set();
  for (const [index, row] of (Array.isArray(manifest?.rows) ? manifest.rows : []).entries()) {
    const rowId = typeof row?.id === "string" ? row.id : `row[${index}]`;
    if (!/^row-[0-9]{3}$/.test(rowId) || rowIds.has(rowId)) {
      issue(errors, "CORPUS_ROW_ID_INVALID", "row id must be a unique opaque row-NNN", rowId);
    }
    rowIds.add(rowId);
    if (!SOURCE_REF.test(String(row?.sourceRef ?? "")) || sourceRefs.has(row?.sourceRef)) {
      issue(errors, "CORPUS_SOURCE_REF_INVALID", "sourceRef must be a unique opaque src:sha256", rowId);
    }
    sourceRefs.add(row?.sourceRef);
    validateFrame(row?.frame, errors, rowId);
    if (HEX_64.test(String(row?.frame?.sha256 ?? "")) && frameHashes.has(row.frame.sha256)) {
      issue(errors, "CORPUS_FRAME_DUPLICATE", "frame sha256 must be globally unique", rowId);
    }
    frameHashes.add(row?.frame?.sha256);
    if (!XHS_EXPLORATION_VISION_CORPUS_ROUTES.includes(row?.pageClass)) {
      issue(errors, "CORPUS_PAGE_CLASS_INVALID", "pageClass is outside the closed route set", rowId);
    }
    if (!DUMP_VERDICTS.has(row?.dumpVerdict)) {
      issue(errors, "CORPUS_DUMP_VERDICT_INVALID", "dumpVerdict is outside the closed vision-eligible set", rowId);
    }
    const routeRoles = XHS_EXPLORATION_VISION_CORPUS_ROUTES.includes(row?.pageClass)
      ? ROUTE_ROLES[row.pageClass]
      : [];
    if (!Array.isArray(row?.positiveRoles)
      || row.positiveRoles.length === 0
      || new Set(row.positiveRoles).size !== row.positiveRoles.length
      || row.positiveRoles.some((role) => !routeRoles.includes(role))) {
      issue(errors, "CORPUS_POSITIVE_ROLES_INVALID", "positiveRoles are not a unique subset of the route's closed roles", rowId);
    }
    validateGeometry(row, errors, rowId);
    if (!HEX_64.test(String(row?.annotationHash ?? ""))
      || row.annotationHash !== deriveVisionCorpusAnnotationHash(row)) {
      issue(errors, "CORPUS_ANNOTATION_HASH_INVALID", "annotationHash does not bind the hand-authored row", rowId);
    }
    const allowedKeys = [
      "id", "sourceRef", "frame", "pageClass", "dumpVerdict",
      "positiveRoles", "geometry", "annotationHash",
    ];
    if (!isPlainObject(row) || Object.keys(row).some((key) => !allowedKeys.includes(key))) {
      issue(errors, "CORPUS_ROW_FIELD_INVALID", "row contains an unrecognized public field", rowId);
    }
  }

  const coverage = derivedCoverage(manifest);
  if (stableJson(manifest?.coverage) !== stableJson(coverage)) {
    issue(errors, "CORPUS_COVERAGE_DRIFT", "declared coverage does not match distinct frame hashes");
  }
  return Object.freeze({
    valid: errors.length === 0,
    passed: errors.length === 0 && coverage.complete,
    complete: coverage.complete,
    coverage,
    errors,
  });
}

function validProviderIdentity(identity) {
  return isPlainObject(identity)
    && IDENTITY_FIELDS.every((field) => HEX_64.test(String(identity[field] ?? "")))
    && Object.keys(identity).every((field) => IDENTITY_FIELDS.includes(field));
}

function sameProviderIdentity(actual, expected) {
  return validProviderIdentity(actual)
    && IDENTITY_FIELDS.every((field) => actual[field] === expected[field]);
}

function readPngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)
    || bytes.length < 24
    || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function boundsInsideFrame(bounds, width, height) {
  return isBounds(bounds) && bounds[2] <= width && bounds[3] <= height;
}

function contains(outer, inner) {
  return outer[0] <= inner[0]
    && outer[1] <= inner[1]
    && outer[2] >= inner[2]
    && outer[3] >= inner[3];
}

function intersects(left, right) {
  return left[0] < right[2]
    && left[2] > right[0]
    && left[1] < right[3]
    && left[3] > right[1];
}

function providerAnalyze(provider) {
  if (typeof provider === "function") return provider;
  if (provider && typeof provider.analyze === "function") return provider.analyze.bind(provider);
  return null;
}

function compareProviderResult({ row, result, expectedProviderIdentity, minimumConfidence }) {
  const errors = [];
  const rowId = row.id;
  if (!isPlainObject(result)) {
    issue(errors, "CORPUS_PROVIDER_RESULT_INVALID", "provider result must be an object", rowId);
    return { tapAuthorized: false, errors };
  }
  if (result.rowId !== row.id
    || result.sourceRef !== row.sourceRef
    || result.frameSha256 !== row.frame.sha256
    || result.annotationHash !== row.annotationHash
    || result.pageClass !== row.pageClass) {
    issue(errors, "CORPUS_PROVIDER_BINDING_DRIFT", "provider result is not bound to row/source/frame/annotation/route", rowId);
  }
  if (!sameProviderIdentity(result.providerIdentity, expectedProviderIdentity)) {
    issue(errors, "CORPUS_PROVIDER_IDENTITY_DRIFT", "provider identity does not match the pinned identity", rowId);
  }
  if (result.verdict !== "SAFE") {
    issue(errors, "CORPUS_PROVIDER_UNSAFE_OR_AMBIGUOUS", "only a SAFE unique navigation candidate can pass", rowId);
  }
  if (!Array.isArray(result.blocks) || result.blocks.length !== 1) {
    issue(errors, "CORPUS_PROVIDER_NOT_UNIQUE", "provider must return exactly one candidate block", rowId);
    return { tapAuthorized: false, errors };
  }
  const block = result.blocks[0];
  if (!isPlainObject(block)) {
    issue(errors, "CORPUS_PROVIDER_BLOCK_INVALID", "provider candidate is invalid", rowId);
    return { tapAuthorized: false, errors };
  }
  if (!row.positiveRoles.includes(block.role)
    || !(ROUTE_ROLES[row.pageClass] ?? []).includes(block.role)) {
    issue(errors, "CORPUS_PROVIDER_ROLE_INVALID", "provider role is outside the row and route allowlists", rowId);
  }
  if (block.semanticClass !== "NAVIGATION" || EFFECT_SEMANTIC_CLASSES.has(block.semanticClass)) {
    issue(errors, "CORPUS_PROVIDER_EFFECT_RELABEL", "candidate semantic class is not navigation-only", rowId);
  }
  if (typeof block.confidence !== "number"
    || !Number.isFinite(block.confidence)
    || block.confidence < minimumConfidence
    || block.confidence > 1) {
    issue(errors, "CORPUS_PROVIDER_CONFIDENCE_LOW", "candidate confidence is below the sealed minimum", rowId);
  }
  if (!boundsInsideFrame(block.bounds, row.frame.width, row.frame.height)) {
    issue(errors, "CORPUS_PROVIDER_BOUNDS_INVALID", "candidate bounds are invalid or outside the frame", rowId);
  } else {
    const positive = row.geometry.positiveRegions
      .some((region) => region.role === block.role && contains(region.bounds, block.bounds));
    if (!positive) {
      issue(errors, "CORPUS_PROVIDER_OUTSIDE_POSITIVE", "candidate is outside every positive region for its role", rowId);
    }
    if (row.geometry.protectedRegions.some((region) => intersects(region.bounds, block.bounds))) {
      issue(errors, "CORPUS_PROVIDER_INTERSECTS_PROTECTED", "candidate intersects a protected region", rowId);
    }
  }
  return { tapAuthorized: errors.length === 0, errors };
}

/**
 * Resolve the private frames and run an injected pinned provider against every
 * corpus row. Any single failure suppresses the aggregate tap count to zero.
 */
export async function evaluateVisionCorpusGate({
  manifest,
  loadFrame,
  provider,
  expectedProviderIdentity,
  minimumConfidence = XHS_EXPLORATION_VISION_CORPUS_MIN_CONFIDENCE,
} = {}) {
  const validation = validateVisionCorpusManifest(manifest);
  const errors = [...validation.errors];
  const rowResults = [];
  const analyze = providerAnalyze(provider);
  if (!validation.complete) {
    issue(errors, "CORPUS_INCOMPLETE", "all five routes need at least three distinct verified frames");
  }
  if (typeof loadFrame !== "function") {
    issue(errors, "CORPUS_FRAME_LOADER_MISSING", "private frame loader is required");
  }
  if (!validProviderIdentity(expectedProviderIdentity)) {
    issue(errors, "CORPUS_PROVIDER_IDENTITY_MISSING", "a complete pinned provider identity is required");
  }
  if (!analyze) {
    issue(errors, "CORPUS_PROVIDER_MISSING", "provider analyze function is required");
  }
  if (minimumConfidence !== XHS_EXPLORATION_VISION_CORPUS_MIN_CONFIDENCE) {
    issue(errors, "CORPUS_CONFIDENCE_POLICY_INVALID", "minimum confidence is sealed at 0.9");
  }

  for (const row of Array.isArray(manifest?.rows) ? manifest.rows : []) {
    const rowErrors = [];
    let bytes = null;
    if (typeof loadFrame === "function" && SOURCE_REF.test(String(row?.sourceRef ?? ""))) {
      try {
        bytes = await loadFrame(row.sourceRef);
      } catch (error) {
        issue(rowErrors, "CORPUS_FRAME_LOAD_FAILED", `private frame load failed: ${error?.message || error}`, row.id);
      }
    } else if (typeof loadFrame === "function") {
      issue(rowErrors, "CORPUS_FRAME_SOURCE_REF_UNSAFE", "unsafe sourceRef was not passed to the private frame loader", row?.id);
    }
    if (!Buffer.isBuffer(bytes)) {
      issue(rowErrors, "CORPUS_FRAME_BYTES_MISSING", "frame loader must return a Buffer", row.id);
    } else {
      const actualHash = sha256(bytes);
      if (actualHash !== row.frame?.sha256) {
        issue(rowErrors, "CORPUS_FRAME_HASH_DRIFT", "resolved frame bytes do not match frame.sha256", row.id);
      }
      const dimensions = readPngDimensions(bytes);
      if (!dimensions
        || dimensions.width !== row.frame?.width
        || dimensions.height !== row.frame?.height) {
        issue(rowErrors, "CORPUS_FRAME_DIMS_DRIFT", "resolved PNG dimensions do not match the manifest", row.id);
      }
    }

    let comparison = { tapAuthorized: false, errors: [] };
    if (rowErrors.length === 0
      && validation.valid
      && validation.complete
      && analyze
      && validProviderIdentity(expectedProviderIdentity)
      && minimumConfidence === XHS_EXPLORATION_VISION_CORPUS_MIN_CONFIDENCE) {
      try {
        const result = await analyze({
          rowId: row.id,
          sourceRef: row.sourceRef,
          frame: {
            bytes,
            sha256: row.frame.sha256,
            width: row.frame.width,
            height: row.frame.height,
            alias: row.frame.alias,
          },
          annotation: annotationBody(row),
          annotationHash: row.annotationHash,
          expectedProviderIdentity: { ...expectedProviderIdentity },
        });
        comparison = compareProviderResult({
          row,
          result,
          expectedProviderIdentity,
          minimumConfidence: XHS_EXPLORATION_VISION_CORPUS_MIN_CONFIDENCE,
        });
      } catch (error) {
        issue(rowErrors, "CORPUS_PROVIDER_CRASH", `provider failed: ${error?.message || error}`, row.id);
      }
    }
    rowErrors.push(...comparison.errors);
    errors.push(...rowErrors);
    rowResults.push({
      id: row.id,
      passed: rowErrors.length === 0 && comparison.tapAuthorized,
      tapAuthorized: rowErrors.length === 0 && comparison.tapAuthorized,
      errors: rowErrors,
    });
  }

  const passed = validation.valid
    && validation.complete
    && errors.length === 0
    && rowResults.length > 0
    && rowResults.every((row) => row.tapAuthorized);
  return Object.freeze({
    passed,
    complete: validation.complete,
    coverage: validation.coverage,
    tapCount: passed ? rowResults.length : 0,
    rows: rowResults,
    errors,
  });
}
