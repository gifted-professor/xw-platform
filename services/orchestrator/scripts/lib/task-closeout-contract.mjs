import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TASK_CLOSEOUT_SCHEMA_ID = "xhs.task-closeout.v1";
const HERE = dirname(fileURLToPath(import.meta.url));
export const TASK_CLOSEOUT_SCHEMA_PATH = resolve(HERE, "../../contracts/task-closeout.v1.schema.json");
const TASK_CLOSEOUT_SCHEMA = JSON.parse(readFileSync(TASK_CLOSEOUT_SCHEMA_PATH, "utf8"));

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
export function sha256Bytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function sha256File(path) { return sha256Bytes(readFileSync(path)); }
export function currentTaskCloseoutContractSha256() { return sha256File(TASK_CLOSEOUT_SCHEMA_PATH); }

export function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value)) return false;
  return !value.replaceAll("\\", "/").split("/").some((part) => part === "" || part === "." || part === "..");
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function add(errors, path, message) { errors.push({ path, message }); }

function jsonPointer(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error(`unsupported schema ref: ${ref}`);
  return ref.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function hasType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateSchemaNode(value, schema, path, errors, root = TASK_CLOSEOUT_SCHEMA) {
  if (!schema || typeof schema !== "object") {
    add(errors, path, "contract schema node is invalid");
    return;
  }
  if (schema.$ref) {
    validateSchemaNode(value, jsonPointer(root, schema.$ref), path, errors, root);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((candidate) => {
      const branchErrors = [];
      validateSchemaNode(value, candidate, path, branchErrors, root);
      return branchErrors.length === 0;
    });
    if (!matched) add(errors, path, "must match one allowed contract shape");
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && canonicalJson(value) !== canonicalJson(schema.const)) add(errors, path, `must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) add(errors, path, `must be one of ${schema.enum.join(", ")}`);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => hasType(value, type))) {
      add(errors, path, `must be ${types.join(" or ")}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) add(errors, path, `must have length >= ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) add(errors, path, `must match pattern ${schema.pattern}`);
    if (schema.format === "date-time" && !validTime(value)) add(errors, path, "must be a date-time");
  }
  if (typeof value === "number" && Number.isFinite(schema.minimum) && value < schema.minimum) add(errors, path, `must be >= ${schema.minimum}`);

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) add(errors, path, `must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        const key = canonicalJson(item);
        if (seen.has(key)) add(errors, `${path}[${index}]`, "must be unique");
        seen.add(key);
      }
    }
    if (schema.items) value.forEach((item, index) => validateSchemaNode(item, schema.items, `${path}[${index}]`, errors, root));
  }

  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, key)) add(errors, `${path}.${key}`, "is required");
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) add(errors, `${path}.${key}`, "additional property is not allowed");
    for (const [key, childSchema] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) validateSchemaNode(value[key], childSchema, `${path}.${key}`, errors, root);
  }
}

function uniqueIds(items, key, path, errors) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    const id = item?.[key];
    if (typeof id !== "string" || id.length === 0) add(errors, `${path}[${index}].${key}`, "must be non-empty");
    else if (seen.has(id)) add(errors, `${path}[${index}].${key}`, `duplicate id: ${id}`);
    else seen.add(id);
  }
}

export function validateTaskCloseout(closeout, { contractSha256 = currentTaskCloseoutContractSha256() } = {}) {
  const errors = [];
  if (!isObject(closeout)) return [{ path: "$", message: "closeout must be an object" }];
  validateSchemaNode(closeout, TASK_CLOSEOUT_SCHEMA, "$", errors);
  if (!validTime(closeout.startedAt) || !validTime(closeout.endedAt)) add(errors, "time", "startedAt and endedAt must be date-times");
  else if (Date.parse(closeout.endedAt) < Date.parse(closeout.startedAt)) add(errors, "endedAt", "must not precede startedAt");
  if (closeout.producer?.contractSha256 !== contractSha256) add(errors, "producer.contractSha256", "must bind canonical contract bytes");
  if (Array.isArray(closeout.checks)) uniqueIds(closeout.checks, "id", "checks", errors);
  if (Array.isArray(closeout.effects)) uniqueIds(closeout.effects, "effectId", "effects", errors);
  if (Array.isArray(closeout.artifacts)) uniqueIds(closeout.artifacts, "artifactId", "artifacts", errors);
  if (Array.isArray(closeout.candidates)) uniqueIds(closeout.candidates, "candidateId", "candidates", errors);
  if (Array.isArray(closeout.claims)) uniqueIds(closeout.claims, "claimId", "claims", errors);
  if (Array.isArray(closeout.evidenceDebt)) uniqueIds(closeout.evidenceDebt, "debtId", "evidenceDebt", errors);
  if (Array.isArray(closeout.sources)) for (const [sourceIndex, source] of closeout.sources.entries()) if (Array.isArray(source?.changedFiles)) for (const [fileIndex, file] of source.changedFiles.entries()) if (!isSafeRelativePath(file?.path)) add(errors, `sources[${sourceIndex}].changedFiles[${fileIndex}].path`, "unsafe path");
  if (Array.isArray(closeout.artifacts)) {
    closeout.artifacts.forEach((artifact, index) => {
      if (!isSafeRelativePath(artifact?.path)) add(errors, `artifacts[${index}].path`, "must be a safe root-relative path");
      if (artifact?.availability === "present" && !/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? "")) add(errors, `artifacts[${index}].sha256`, "present artifact requires SHA256");
      if (artifact?.availability === "present" && !Number.isInteger(artifact?.bytes)) add(errors, `artifacts[${index}].bytes`, "present artifact requires byte count");
    });
  }
  if (closeout.closure?.status === "completed" && ((closeout.closure.remainingWork?.length ?? 0) > 0 || (closeout.closure.blockers?.length ?? 0) > 0)) add(errors, "closure", "completed cannot retain remaining work or blockers");
  return errors;
}

function safeFile(rootReal, name) {
  const target = resolve(rootReal, name);
  const rel = relative(rootReal, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${name} escapes bundle`);
  if (!existsSync(target)) throw new Error(`${name} is missing`);
  const lst = lstatSync(target);
  if (lst.isSymbolicLink() || !lst.isFile()) throw new Error(`${name} must be a regular file`);
  const real = realpathSync(target);
  const realRel = relative(rootReal, real);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`${name} escapes through symlink`);
  return real;
}

export function readAndVerifyTaskCloseoutBundle(bundleDir) {
  const errors = [];
  const root = resolve(bundleDir);
  if (!existsSync(root)) return { ok: false, errors: [{ path: "$", message: "bundle is missing" }] };
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, errors: [{ path: "$", message: "bundle root must be a real directory" }] };
  const rootReal = realpathSync(root);
  let closeout;
  let manifest;
  let manifestSha256;
  try {
    const closeoutPath = safeFile(rootReal, "closeout.v1.json");
    const manifestPath = safeFile(rootReal, "manifest.json");
    const sealPath = safeFile(rootReal, "manifest.sha256");
    manifestSha256 = sha256File(manifestPath);
    if (readFileSync(sealPath, "utf8").trim() !== manifestSha256) throw new Error("manifest.sha256 does not match manifest.json bytes");
    closeout = JSON.parse(readFileSync(closeoutPath, "utf8"));
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const closeoutBytes = statSync(closeoutPath).size;
    if (manifest?.schemaId !== "xhs.task-closeout-manifest.v1" || manifest?.schemaVersion !== 1) throw new Error("invalid manifest schema");
    if (!Array.isArray(manifest.files) || manifest.files.length !== 1 || manifest.files[0]?.path !== "closeout.v1.json") throw new Error("minimal manifest must bind only closeout.v1.json");
    if (manifest.files[0].sha256 !== sha256File(closeoutPath) || manifest.files[0].bytes !== closeoutBytes) throw new Error("closeout.v1.json hash or size mismatch");
  } catch (error) {
    return { ok: false, errors: [{ path: "bundle", message: error.message }], root: rootReal, manifestSha256 };
  }
  errors.push(...validateTaskCloseout(closeout));
  if (manifest.runId !== closeout?.runId) add(errors, "manifest.runId", "does not match closeout");
  if (manifest.producerCommit !== closeout?.producer?.commit) add(errors, "manifest.producerCommit", "does not match closeout");
  if (manifest.contractSha256 !== closeout?.producer?.contractSha256) add(errors, "manifest.contractSha256", "does not match closeout");
  return { ok: errors.length === 0, errors, root: rootReal, manifest, manifestSha256, closeout };
}
