// Minimal JSON Schema Draft 2020-12 validator for the M0 schema subset.
// Zero third-party deps. Supports: type (+type arrays), const, enum, required,
// additionalProperties (false), properties, pattern (ECMAScript via RegExp),
// minimum, minLength, minItems, uniqueItems, anyOf, $ref (local #/$defs only),
// format (date-time only — RFC 3339 subset). Not a general-purpose validator.
//
// Usage:
//   import { validateInstance, loadSchema } from "./validate.mjs";
//   const schema = loadSchema("baseline-identity.v1.schema.json"); // from tools/m0/schemas
//   const errs = validateInstance(instance, schema); // [] if valid

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMAS_DIR = join(here, "schemas");

/** Load a schema by filename from tools/m0/schemas. */
export function loadSchema(filename) {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, filename), "utf8"));
}

/** Load every *.schema.json in tools/m0/schemas, keyed by schemaId const. */
export function loadAllSchemas() {
  const map = new Map();
  for (const f of readdirSync(SCHEMAS_DIR)) {
    if (!f.endsWith(".schema.json")) continue;
    const s = loadSchema(f);
    const id = s.properties?.schemaId?.const;
    if (id) map.set(id, { filename: f, schema: s });
  }
  return map;
}

/**
 * Validate an instance against a schema. Returns an array of error strings
 * (empty if valid). Errors carry a path for locality.
 * @param {*} instance
 * @param {object} schema
 * @param {string} [base]
 * @param {object} [root]
 * @returns {string[]}
 */
export function validateInstance(instance, schema, base = "", root) {
  root = root || schema;
  const errs = [];
  walk(instance, schema, base, root, errs);
  return errs;
}

function walk(instance, schema, path, root, errs) {
  if (!schema || typeof schema !== "object") return;

  // $ref — local only (#/$defs/...)
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (ref.startsWith("#/")) {
      const target = resolveLocalRef(root, ref.slice(2).split("/"));
      if (!target) {
        errs.push(`${path}: unresolvable $ref ${ref}`);
      } else {
        walk(instance, target, path, root, errs);
      }
    } else {
      errs.push(`${path}: only local #/ $ref supported, got ${ref}`);
    }
    return;
  }

  // anyOf
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => validateInstance(instance, s, "", root).length === 0);
    if (!ok) errs.push(`${path}: no anyOf branch matched`);
    // still allow sibling constraints? Draft says anyOf is independent; return.
    return;
  }

  // const
  if ("const" in schema) {
    if (!deepEqual(instance, schema.const)) {
      errs.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => deepEqual(instance, v))) {
      errs.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(instance)}`);
    }
  }

  // type
  if (typeof schema.type !== "undefined") {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(instance, t))) {
      errs.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${typeof instance}`);
      return; // further constraints meaningless if type wrong
    }
  }

  // null short-circuits remaining value constraints
  if (instance === null) return;

  // string constraints
  if (typeof instance === "string") {
    if (typeof schema.minLength === "number" && instance.length < schema.minLength) {
      errs.push(`${path}: string shorter than ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string") {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch (e) {
        errs.push(`${path}: invalid pattern ${schema.pattern}`);
      }
      if (re && !re.test(instance)) {
        errs.push(`${path}: string ${JSON.stringify(instance)} does not match ${schema.pattern}`);
      }
    }
    if (typeof schema.format === "string" && !checkFormat(instance, schema.format)) {
      errs.push(`${path}: not a valid ${schema.format}`);
    }
  }

  // number constraints
  if (typeof instance === "number") {
    if (typeof schema.minimum === "number" && instance < schema.minimum) {
      errs.push(`${path}: ${instance} < minimum ${schema.minimum}`);
    }
  }

  // array constraints
  if (Array.isArray(instance)) {
    if (typeof schema.minItems === "number" && instance.length < schema.minItems) {
      errs.push(`${path}: array shorter than ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const v of instance) {
        if (seen.some((x) => deepEqual(x, v))) {
          errs.push(`${path}: array has duplicate items`);
          break;
        }
        seen.push(v);
      }
    }
    if (Array.isArray(schema.items)) {
      for (let i = 0; i < instance.length; i++) {
        walk(instance[i], schema.items, `${path}[${i}]`, root, errs);
      }
    } else if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < instance.length; i++) {
        walk(instance[i], schema.items, `${path}[${i}]`, root, errs);
      }
    }
  }

  // object constraints
  if (typeof instance === "object" && !Array.isArray(instance)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in instance)) errs.push(`${path}: missing required property "${k}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(instance)) {
        if (!(k in schema.properties)) {
          errs.push(`${path}: additional property "${k}" not allowed`);
        }
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in instance) walk(instance[k], sub, path ? `${path}.${k}` : k, root, errs);
      }
    }
  }
}

function matchesType(v, t) {
  switch (t) {
    case "string": return typeof v === "string";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array": return Array.isArray(v);
    default: return false;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function resolveLocalRef(root, parts) {
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur;
}

// RFC 3339 date-time subset: YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)
function checkFormat(value, format) {
  if (format !== "date-time") return true; // unknown formats pass (per spec note)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}