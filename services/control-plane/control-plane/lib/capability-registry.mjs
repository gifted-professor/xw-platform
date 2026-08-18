import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ControlPlaneError } from "./errors.mjs";
import { attachNormalizedEffect, isClassificationStub } from "./capability-effect.mjs";

const REQUIRED_FIELDS = [
  "schemaVersion", "id", "appId", "packageName", "versionRange", "maturity", "risk",
  "resources", "inputSchema", "outputSchema", "preconditions", "verification",
  "restoration", "timeoutMs", "idempotency", "automationPolicy", "implementation", "evidence",
];
const ALLOWED_FIELDS = new Set([
  ...REQUIRED_FIELDS,
  "availability",
  "description",
  "effect",
  "exposure",
  "invocationPolicy",
  "lifecycle",
  "financialCommit",
]);
const MATURITY = new Set(["E0", "E1", "E2", "E3", "E4"]);
const RISK = new Set(["R0", "R1", "R2", "R3"]);
const RESOURCES = new Set(["device", "transport:xiaowei:22222"]);
const IDEMPOTENCY = new Set(["read_only", "replay_safe", "external_effect", "ambiguous_on_timeout"]);
const MODES = new Set(["lab_only", "automatic", "approval_required", "disabled"]);
const VERIFICATION_MODES = new Set(["none", "state", "hash", "count_delta", "text_scan", "custom"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, path) {
  if (!isObject(value)) throw new TypeError(`${path} must be an object`);
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
}

export function validateCapability(capability) {
  assertObject(capability, "capability");
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(capability, field)) throw new TypeError(`${capability.id || "<missing-id>"} missing ${field}`);
  }
  for (const field of Object.keys(capability)) {
    if (!ALLOWED_FIELDS.has(field)) throw new TypeError(`${capability.id || "<missing-id>"} unknown field ${field}`);
  }
  if (capability.schemaVersion !== 1) throw new TypeError(`${capability.id} unsupported schemaVersion`);
  assertString(capability.id, "capability.id");
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(capability.id)) throw new TypeError(`${capability.id} invalid ID`);
  assertString(capability.appId, `${capability.id}.appId`);
  if (capability.packageName !== null) assertString(capability.packageName, `${capability.id}.packageName`);
  assertString(capability.versionRange, `${capability.id}.versionRange`);
  if (!MATURITY.has(capability.maturity)) throw new TypeError(`${capability.id} invalid maturity`);
  if (!RISK.has(capability.risk)) throw new TypeError(`${capability.id} invalid risk`);
  if (!Array.isArray(capability.resources) || capability.resources.length === 0) {
    throw new TypeError(`${capability.id}.resources must be a non-empty array`);
  }
  if (new Set(capability.resources).size !== capability.resources.length) {
    throw new TypeError(`${capability.id}.resources contains duplicates`);
  }
  for (const resource of capability.resources) {
    if (!RESOURCES.has(resource)) throw new TypeError(`${capability.id} invalid resource ${resource}`);
  }
  assertObject(capability.inputSchema, `${capability.id}.inputSchema`);
  assertObject(capability.outputSchema, `${capability.id}.outputSchema`);
  if (!Array.isArray(capability.preconditions) || capability.preconditions.some((item) => typeof item !== "string")) {
    throw new TypeError(`${capability.id}.preconditions must be strings`);
  }
  assertObject(capability.verification, `${capability.id}.verification`);
  if (!VERIFICATION_MODES.has(capability.verification.mode)) throw new TypeError(`${capability.id} invalid verification mode`);
  assertString(capability.verification.description, `${capability.id}.verification.description`);
  assertObject(capability.restoration, `${capability.id}.restoration`);
  if (typeof capability.restoration.required !== "boolean") throw new TypeError(`${capability.id}.restoration.required must be boolean`);
  assertString(capability.restoration.description, `${capability.id}.restoration.description`);
  if (!Number.isInteger(capability.timeoutMs) || capability.timeoutMs < 1 || capability.timeoutMs > 900000) {
    throw new TypeError(`${capability.id}.timeoutMs out of range`);
  }
  if (!IDEMPOTENCY.has(capability.idempotency)) throw new TypeError(`${capability.id} invalid idempotency`);
  assertObject(capability.automationPolicy, `${capability.id}.automationPolicy`);
  if (!MODES.has(capability.automationPolicy.mode)) throw new TypeError(`${capability.id} invalid automation mode`);
  assertObject(capability.implementation, `${capability.id}.implementation`);
  assertString(capability.implementation.adapter, `${capability.id}.implementation.adapter`);
  assertString(capability.implementation.action, `${capability.id}.implementation.action`);
  if (capability.implementation.implementationClosureHash !== undefined) {
    if (typeof capability.implementation.implementationClosureHash !== "string"
      || !/^[a-f0-9]{64}$/.test(capability.implementation.implementationClosureHash)) {
      throw new TypeError(`${capability.id}.implementation.implementationClosureHash must be 64 hex`);
    }
  }
  if (capability.implementation.tcbManifestRef !== undefined) {
    assertString(capability.implementation.tcbManifestRef, `${capability.id}.implementation.tcbManifestRef`);
  }
  if (!Array.isArray(capability.evidence) || capability.evidence.some((item) => typeof item !== "string")) {
    throw new TypeError(`${capability.id}.evidence must be strings`);
  }
  if (capability.exposure !== undefined && !["public", "internal"].includes(capability.exposure)) {
    throw new TypeError(`${capability.id} invalid exposure`);
  }
  if (capability.lifecycle !== undefined
    && !["draft", "canary_only", "implemented", "deprecated", "retired"].includes(capability.lifecycle)) {
    throw new TypeError(`${capability.id} invalid lifecycle`);
  }
  if (capability.effect !== undefined) {
    assertObject(capability.effect, `${capability.id}.effect`);
  }
  return capability;
}

function validatePrimitive(value, schema, path) {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} is not an allowed value`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} is shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} is longer than ${schema.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} is above maximum`);
  }
}

export function validateAgainstSchema(value, schema, path = "params") {
  if (!schema || Object.keys(schema).length === 0) return value;
  const type = schema.type;
  if (type === "object") {
    if (!isObject(value)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be an object`);
    const entries = Object.entries(value);
    if (schema.minProperties !== undefined && entries.length < schema.minProperties) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} has fewer than ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && entries.length > schema.maxProperties) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} has more than ${schema.maxProperties} properties`);
    }
    if (schema.propertyNames) {
      for (const [key] of entries) validateAgainstSchema(key, schema.propertyNames, `${path} property name`);
    }
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path}.${required} is required`);
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path}.${key} is not allowed`);
      }
    }
    if (isObject(schema.additionalProperties)) {
      for (const [key, childValue] of entries) {
        if (!Object.hasOwn(properties, key)) {
          validateAgainstSchema(childValue, schema.additionalProperties, `${path}.${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateAgainstSchema(value[key], child, `${path}.${key}`);
    }
    return value;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} has fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} has more than ${schema.maxItems} items`);
    }
    value.forEach((item, index) => validateAgainstSchema(item, schema.items || {}, `${path}[${index}]`));
    return value;
  }
  if (type === "string" && typeof value !== "string") throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be a string`);
  if (type === "boolean" && typeof value !== "boolean") throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be a boolean`);
  if (type === "integer" && !Number.isInteger(value)) throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be an integer`);
  if (type === "number" && typeof value !== "number") throw new ControlPlaneError("PARAMS_SCHEMA_INVALID", `${path} must be a number`);
  validatePrimitive(value, schema, path);
  return value;
}

export class CapabilityRegistry {
  constructor(capabilities = []) {
    this.capabilities = [];
    this.byId = new Map();
    for (const raw of capabilities) {
      // Classification stubs: minimal draft entries without full required fields
      if (isClassificationStub(raw) && !raw.implementation) {
        const stub = structuredClone(raw);
        if (!stub.id) throw new TypeError("classification stub missing id");
        if (this.byId.has(stub.id)) throw new TypeError(`duplicate capability ID: ${stub.id}`);
        stub.runnable = false;
        stub.lifecycle = stub.lifecycle || "draft";
        stub.availability = stub.availability || "classification_required";
        this.byId.set(stub.id, stub);
        this.capabilities.push(stub);
        continue;
      }
      const capability = attachNormalizedEffect(structuredClone(validateCapability(raw)));
      capability.runnable = !isClassificationStub(capability);
      if (this.byId.has(capability.id)) throw new TypeError(`duplicate capability ID: ${capability.id}`);
      this.byId.set(capability.id, capability);
      this.capabilities.push(capability);
    }
  }

  static load(appsRoot) {
    const capabilities = [];
    if (!existsSync(appsRoot)) return new CapabilityRegistry();
    for (const app of readdirSync(appsRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const path = join(appsRoot, app.name, "capabilities.json");
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.capabilities;
      if (!Array.isArray(list)) throw new TypeError(`${path} must contain a capabilities array`);
      capabilities.push(...list);
    }
    return new CapabilityRegistry(capabilities);
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  require(id) {
    const capability = this.get(id);
    if (!capability) throw new ControlPlaneError("CAPABILITY_NOT_FOUND", `unknown capability ${id}`, { status: 404 });
    return capability;
  }

  listPublic() {
    return this.capabilities
      .filter((capability) => (capability.exposure || "public") !== "internal")
      .filter((capability) => capability.runnable !== false)
      .map(({ implementation, ...capability }) => ({
        ...structuredClone(capability),
        adapter: implementation?.adapter,
        normalizedEffect: capability.normalizedEffect || null,
        capabilityContractHash: capability.capabilityContractHash || null,
        capabilityContractHashAlgorithm: capability.capabilityContractHash
          ? (capability.capabilityContractHashAlgorithm || "legacy_algorithm_unknown")
          : null,
        implementationClosureHash: implementation?.implementationClosureHash || null,
        tcbManifestRef: implementation?.tcbManifestRef || null,
        authorizationHint: "context_required",
      }));
  }

  validateParams(id, params = {}) {
    const capability = this.require(id);
    validateAgainstSchema(params, capability.inputSchema);
    return capability;
  }
}
