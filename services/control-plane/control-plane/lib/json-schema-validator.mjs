// A minimal, zero-dependency JSON Schema (draft 2020-12 subset) validator. It is intentionally
// small: it supports the keywords the control-plane's own schemas use — type (incl. unions),
// const, enum, required, properties, additionalProperties, minLength, items — enough to enforce
// the effect-intent envelope at runtime against the canonical schema file, so the schema is the
// source of truth rather than a dormant document. It returns a list of human-readable errors.
// It is NOT a general-purpose validator; unsupported keywords are ignored.

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function checkType(value, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  return types.some((t) => TYPE_CHECKS[t]?.(value) ?? false);
}

export function validateJsonSchema(value, schema, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined && !checkType(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined) errors.push(`${path}.${key}: required`);
      }
    }
    const props = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (props[key]) {
        errors.push(...validateJsonSchema(value[key], props[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...validateJsonSchema(value[index], schema.items, `${path}[${index}]`));
    }
  }
  return errors;
}