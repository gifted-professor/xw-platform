/**
 * Canonical, content-addressed provider bundle for XHS exploration vision.
 *
 * Absolute installation paths are deliberately excluded from the manifest:
 * identity is the exact canonical manifest bytes, which transitively bind the
 * interpreter, entry script, primary model, every auxiliary data file, and
 * the provider/process protocol configuration by SHA-256 and byte length.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "./xhs-exploration-mission.mjs";

export const EXPLORATION_VISION_PROVIDER_BUNDLE_SCHEMA_ID =
  "xw.xhs.exploration-vision-provider-bundle.v1";
export const EXPLORATION_VISION_PROVIDER_NAME = "xhs-exploration-local-navigation";
export const EXPLORATION_VISION_PROCESS_PROTOCOL =
  "xw.xhs.exploration-vision-process.v1";
export const EXPLORATION_VISION_PROCESS_RESULT_SCHEMA_ID =
  "xw.xhs.exploration-vision-process-result.v1";

export const EXPLORATION_VISION_BUNDLE_ROUTE_ROLES = Object.freeze([
  Object.freeze({ page: "COMMENT_PANEL", roles: Object.freeze(["BACK"]) }),
  Object.freeze({ page: "HOME_FEED", roles: Object.freeze(["OPEN_CONTENT_CARD"]) }),
  Object.freeze({ page: "IMAGE_NOTE", roles: Object.freeze(["OPEN_COMMENT_PANEL"]) }),
  Object.freeze({ page: "SEARCH_RESULTS", roles: Object.freeze(["OPEN_CONTENT_CARD"]) }),
  Object.freeze({ page: "VIDEO_NOTE", roles: Object.freeze(["OPEN_COMMENT_PANEL", "PAUSE_VIDEO_SAFE_ZONE"]) }),
]);

export const EXPLORATION_VISION_BUNDLE_LABELS = Object.freeze([
  "打开内容卡片安全区",
  "打开评论面板导航区",
  "暂停视频安全区",
  "返回导航区",
]);

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FILE_ROLES = new Set(["interpreter", "entry", "model", "data"]);
export const EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX = "data/python-runtime/";
export const EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY = Object.freeze({
  aclSids: Object.freeze(["S-1-5-18", "S-1-5-32-544"]),
  dataPrefix: EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX,
  isolationArgs: Object.freeze(["-I", "-S", "-B"]),
  kind: "cpython-exact-private.v1",
  namespace: "ProgramFiles/XWPlatform/providers/{providerBundleDigest}",
  pycachePolicy: "fresh-private-per-request",
  sourceExecutionAllowed: false,
});

function bundleError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    name: "ExplorationVisionProviderBundleError",
    status: 409,
    details,
  });
}

function exactKeys(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(path, { allowEmpty = false } = {}) {
  if (!existsSync(path)) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_FILE_MISSING", "provider bundle input is absent");
  }
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  let size = 0;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (!allowEmpty && before.size <= 0)) {
      throw bundleError("EXPLORATION_VISION_BUNDLE_INPUT_INVALID", "provider bundle input must be a regular file with an allowed size");
    }
    const chunk = Buffer.alloc(1 << 20);
    for (let n = 0; (n = readSync(fd, chunk, 0, chunk.length)) > 0;) {
      hash.update(chunk.subarray(0, n));
      size += n;
    }
    const after = fstatSync(fd);
    if (!after.isFile() || size !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw bundleError("EXPLORATION_VISION_BUNDLE_FILE_RACE", "provider bundle input changed while it was hashed");
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), size };
}

function absoluteFile(value, label) {
  const path = String(value ?? "");
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    throw bundleError(
      "EXPLORATION_VISION_BUNDLE_INPUT_INVALID",
      `${label} must be an existing absolute file`,
      { label },
    );
  }
  return resolve(path);
}

function normalizeDataFiles(dataFiles = []) {
  if (!Array.isArray(dataFiles)) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_INPUT_INVALID", "dataFiles must be an array");
  }
  const rows = dataFiles.map((row, index) => {
    if (!exactKeys(row, ["logicalPath", "path"])) {
      throw bundleError(
        "EXPLORATION_VISION_BUNDLE_INPUT_INVALID",
        "each data file needs exactly logicalPath and path",
        { index },
      );
    }
    const logicalPath = String(row.logicalPath ?? "");
    if (!/^data\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(logicalPath)
      || logicalPath.includes("//")
      || logicalPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw bundleError(
        "EXPLORATION_VISION_BUNDLE_INPUT_INVALID",
        "data logicalPath must be a relative data/... path",
        { index },
      );
    }
    return { logicalPath, path: absoluteFile(row.path, `data[${index}]`) };
  }).sort((left, right) => left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0);
  if (new Set(rows.map((row) => row.logicalPath)).size !== rows.length) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_INPUT_INVALID", "data logical paths must be unique");
  }
  return rows;
}

function runtimeClosureError(code, message, details = {}) {
  return bundleError(code, message, details);
}

const PYTHON_THIRD_PARTY_DIRECTORY = ["site", "packages"].join("-");

function walkRuntimeFiles(root, logicalRoot, { skipSitePackages = false } = {}) {
  const rows = [];
  function visit(directory, logicalDirectory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    } catch (error) {
      throw runtimeClosureError(
        "EXPLORATION_VISION_RUNTIME_CLOSURE_INVALID",
        "Python runtime closure directory is unreadable",
        { logicalDirectory, cause: error?.code ?? null },
      );
    }
    for (const entry of entries) {
      if (entry.name === "__pycache__") continue;
      if (skipSitePackages && logicalDirectory === logicalRoot && entry.name === PYTHON_THIRD_PARTY_DIRECTORY) continue;
      const path = join(directory, entry.name);
      const logicalPath = `${logicalDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(path, logicalPath);
      } else if (entry.isFile()) {
        rows.push({ logicalPath, path: resolve(path) });
      } else {
        throw runtimeClosureError(
          "EXPLORATION_VISION_RUNTIME_CLOSURE_INVALID",
          "Python runtime closure may not contain symlinks, junctions, or special files",
          { logicalPath },
        );
      }
    }
  }
  if (existsSync(root)) visit(root, logicalRoot);
  return rows;
}

/**
 * Enumerate the complete mutable, non-system CPython runtime search closure.
 * The provider launches with -I -S and a private pycache prefix, so
 * third-party install directories and on-install __pycache__ trees are mechanically unreachable.
 * All root files plus the exact DLLs/Lib trees that remain searchable are
 * content-addressed. The interpreter itself is already the manifest head.
 */
export function enumeratePythonRuntimeClosure({ python } = {}) {
  const executable = absoluteFile(python, "python");
  const runtimeRoot = dirname(executable);
  let rootEntries;
  try {
    rootEntries = readdirSync(runtimeRoot, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } catch (error) {
    throw runtimeClosureError(
      "EXPLORATION_VISION_RUNTIME_CLOSURE_INVALID",
      "Python runtime root is unreadable",
      { cause: error?.code ?? null },
    );
  }
  const rows = [];
  for (const entry of rootEntries) {
    const path = join(runtimeRoot, entry.name);
    if (entry.isFile()) {
      if (resolve(path) !== executable) {
        rows.push({
          logicalPath: `${EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX}root/${entry.name}`,
          path: resolve(path),
        });
      }
    } else if (entry.isSymbolicLink()) {
      throw runtimeClosureError(
        "EXPLORATION_VISION_RUNTIME_CLOSURE_INVALID",
        "Python runtime root may not contain symlinked files or directories",
        { entry: entry.name },
      );
    }
  }
  rows.push(...walkRuntimeFiles(
    join(runtimeRoot, "DLLs"),
    `${EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX}DLLs`,
  ));
  rows.push(...walkRuntimeFiles(
    join(runtimeRoot, "Lib"),
    `${EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX}Lib`,
    { skipSitePackages: true },
  ));
  return rows.sort((left, right) => left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0);
}

/** Exact-set/path verification catches both changed and newly injected modules. */
export function verifyPythonRuntimeClosure({ python, dataFiles = [] } = {}) {
  if (!Array.isArray(dataFiles)) {
    throw runtimeClosureError("EXPLORATION_VISION_RUNTIME_CLOSURE_INVALID", "runtime closure dataFiles must be an array");
  }
  const actual = enumeratePythonRuntimeClosure({ python });
  const pinned = dataFiles
    .filter((row) => String(row?.logicalPath ?? "").startsWith(EXPLORATION_VISION_PYTHON_RUNTIME_PREFIX))
    .map((row) => ({ logicalPath: String(row.logicalPath), path: resolve(String(row.path ?? "")) }))
    .sort((left, right) => left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0);
  if (canonicalJson(actual) !== canonicalJson(pinned)) {
    throw runtimeClosureError(
      "EXPLORATION_VISION_RUNTIME_CLOSURE_DRIFT",
      "Python runtime file set or path mapping drifted from the canonical provider closure",
      { expectedCount: pinned.length, actualCount: actual.length },
    );
  }
  return Object.freeze(actual.map((row) => Object.freeze({ ...row })));
}

function descriptor(role, logicalPath, path) {
  return { role, logicalPath, ...hashFile(path, { allowEmpty: role === "data" }) };
}

function expectedConfiguration({ maxBufferBytes, timeoutMs }) {
  if (!Number.isInteger(maxBufferBytes) || maxBufferBytes <= 0 || maxBufferBytes > 16 * 1024 * 1024) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_CONFIG_INVALID", "maxBufferBytes must be within 1..16777216");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 8_000) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_CONFIG_INVALID", "timeoutMs must be within 1..8000");
  }
  return {
    allowEffectLabels: false,
    candidateLabels: [...EXPLORATION_VISION_BUNDLE_LABELS],
    maxBufferBytes,
    processProtocol: EXPLORATION_VISION_PROCESS_PROTOCOL,
    resultSchemaId: EXPLORATION_VISION_PROCESS_RESULT_SCHEMA_ID,
    runtimePolicy: {
      aclSids: [...EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.aclSids],
      dataPrefix: EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.dataPrefix,
      isolationArgs: [...EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.isolationArgs],
      kind: EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.kind,
      namespace: EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.namespace,
      pycachePolicy: EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.pycachePolicy,
      sourceExecutionAllowed: EXPLORATION_VISION_PRIVATE_RUNTIME_POLICY.sourceExecutionAllowed,
    },
    routeRoles: EXPLORATION_VISION_BUNDLE_ROUTE_ROLES.map((row) => ({
      page: row.page,
      roles: [...row.roles],
    })),
    timeoutMs,
  };
}

export function buildExplorationVisionProviderBundle({
  python,
  script,
  model,
  dataFiles = [],
  maxBufferBytes = 8 * 1024 * 1024,
  timeoutMs = 8_000,
} = {}) {
  const resolvedPython = absoluteFile(python, "python");
  const resolvedScript = absoluteFile(script, "script");
  const resolvedModel = absoluteFile(model, "model");
  const resolvedData = normalizeDataFiles(dataFiles);
  verifyPythonRuntimeClosure({ python: resolvedPython, dataFiles: resolvedData });
  const manifest = {
    schemaId: EXPLORATION_VISION_PROVIDER_BUNDLE_SCHEMA_ID,
    schemaVersion: 1,
    provider: EXPLORATION_VISION_PROVIDER_NAME,
    files: [
      descriptor("interpreter", "runtime/interpreter", resolvedPython),
      descriptor("entry", "provider/analyze.py", resolvedScript),
      descriptor("model", "model/primary", resolvedModel),
      ...resolvedData.map((row) => descriptor("data", row.logicalPath, row.path)),
    ],
    configuration: expectedConfiguration({ maxBufferBytes, timeoutMs }),
  };
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  return Object.freeze({
    manifest: Object.freeze(manifest),
    bytes,
    providerBundleDigest: sha256(bytes),
    inputs: Object.freeze({
      python: resolvedPython,
      script: resolvedScript,
      model: resolvedModel,
      dataFiles: Object.freeze(resolvedData.map((row) => Object.freeze({ ...row }))),
    }),
  });
}

function validateManifestShape(manifest) {
  if (!exactKeys(manifest, ["schemaId", "schemaVersion", "provider", "files", "configuration"])
    || manifest.schemaId !== EXPLORATION_VISION_PROVIDER_BUNDLE_SCHEMA_ID
    || manifest.schemaVersion !== 1
    || manifest.provider !== EXPLORATION_VISION_PROVIDER_NAME
    || !Array.isArray(manifest.files)
    || manifest.files.length < 3) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle manifest header is invalid");
  }
  const expectedHeads = [
    ["interpreter", "runtime/interpreter"],
    ["entry", "provider/analyze.py"],
    ["model", "model/primary"],
  ];
  const logicalPaths = new Set();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const row = manifest.files[index];
    if (!exactKeys(row, ["role", "logicalPath", "sha256", "size"])
      || !FILE_ROLES.has(row.role)
      || typeof row.logicalPath !== "string"
      || !HEX_64.test(String(row.sha256 ?? ""))
      || !Number.isInteger(row.size) || row.size < 0 || (row.role !== "data" && row.size === 0)
      || logicalPaths.has(row.logicalPath)) {
      throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle file entry is invalid", { index });
    }
    logicalPaths.add(row.logicalPath);
    if (index < expectedHeads.length) {
      const [role, logicalPath] = expectedHeads[index];
      if (row.role !== role || row.logicalPath !== logicalPath) {
        throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle primary file order is invalid", { index });
      }
    } else if (row.role !== "data"
      || !/^data\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(row.logicalPath)
      || row.logicalPath.includes("//")
      || row.logicalPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "auxiliary bundle entries must be data files", { index });
    }
  }
  const dataPaths = manifest.files.slice(3).map((row) => row.logicalPath);
  if (canonicalJson(dataPaths) !== canonicalJson([...dataPaths].sort())) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "data file entries must be canonical-sorted");
  }
  const config = manifest.configuration;
  if (!exactKeys(config, [
    "allowEffectLabels", "candidateLabels", "maxBufferBytes", "processProtocol",
    "resultSchemaId", "runtimePolicy", "routeRoles", "timeoutMs",
  ])) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle configuration fields are invalid");
  }
  const expected = expectedConfiguration({
    maxBufferBytes: config.maxBufferBytes,
    timeoutMs: config.timeoutMs,
  });
  if (canonicalJson(config) !== canonicalJson(expected)) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle configuration is outside the closed protocol");
  }
  return manifest;
}

export function readExplorationVisionProviderBundle(manifestPath) {
  const path = String(manifestPath ?? "");
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_MISSING", "provider bundle manifest must be an existing absolute file");
  }
  const bytes = readFileSync(path);
  if (bytes.length <= 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle manifest size is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw bundleError("EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID", "provider bundle manifest is not valid JSON");
  }
  validateManifestShape(manifest);
  const canonicalBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw bundleError(
      "EXPLORATION_VISION_BUNDLE_MANIFEST_NONCANONICAL",
      "provider bundle manifest bytes are not the canonical representation",
    );
  }
  return Object.freeze({
    manifest: Object.freeze(manifest),
    bytes,
    path: resolve(path),
    providerBundleDigest: sha256(bytes),
  });
}

export function verifyExplorationVisionProviderBundle({
  manifestPath,
  python,
  script,
  model,
  dataFiles = [],
} = {}) {
  const sealed = readExplorationVisionProviderBundle(manifestPath);
  const reproduced = buildExplorationVisionProviderBundle({
    python,
    script,
    model,
    dataFiles,
    maxBufferBytes: sealed.manifest.configuration.maxBufferBytes,
    timeoutMs: sealed.manifest.configuration.timeoutMs,
  });
  if (!sealed.bytes.equals(reproduced.bytes)
    || sealed.providerBundleDigest !== reproduced.providerBundleDigest) {
    throw bundleError(
      "EXPLORATION_VISION_BUNDLE_DRIFT",
      "provider bundle inputs or configuration drifted from the canonical manifest",
    );
  }
  return Object.freeze({
    ...sealed,
    inputs: reproduced.inputs,
  });
}

export function stageExplorationVisionProviderBundle({ manifestPath, ...input } = {}) {
  const path = String(manifestPath ?? "");
  if (!path || !isAbsolute(path)) {
    throw bundleError("EXPLORATION_VISION_BUNDLE_OUTPUT_INVALID", "manifestPath must be absolute");
  }
  const bundle = buildExplorationVisionProviderBundle(input);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bundle.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw bundleError(
      "EXPLORATION_VISION_BUNDLE_OUTPUT_EXISTS",
      "provider bundle manifest is create-only and could not be written",
      { cause: error?.code ?? null },
    );
  }
  return Object.freeze({
    manifestPath: resolve(path),
    providerBundleDigest: bundle.providerBundleDigest,
    manifest: bundle.manifest,
  });
}
