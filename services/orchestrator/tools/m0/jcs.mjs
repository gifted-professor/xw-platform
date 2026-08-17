// RFC 8785 JSON Canonicalization Scheme (JCS). Faithful port of the ES6 reference
// (cyberphone/json-canonicalization node-es6/canonicalize.js). Zero third-party deps.
//
// Algorithm:
//   - Primitives (and objects with a toJSON property): JSON.stringify(value).
//   - Arrays: element order preserved, no whitespace.
//   - Objects: Object.keys(obj).sort() then emit. JS default sort compares UTF-16
//     code units; this is authoritative. The official "weird" vector puts the U+1F602
//     surrogate pair BEFORE U+FB33, which only holds under UTF-16 unit sort, not a
//     code-point comparator.
//   - Strings: JSON.stringify escaping equals RFC 8785 (short escapes for the usual
//     controls; backslash-u-XXXX for other controls below 0x20; non-ASCII raw).
//   - Numbers: JSON.stringify number serialization (shortest round-trip). The official
//     "values" vector confirms: 1E30 becomes 1e+30, 4.50 becomes 4.5, 2e-3 becomes
//     0.002, 1e-27 stays 1e-27.
//   - No insignificant whitespace.
//
// JS Number precision limits apply (same as the reference). Dossier data stays well
// within the safe-integer range, so this is not a practical constraint here.

import { createHash } from "node:crypto";

/** @param {unknown} value */
export function canonicalize(value) {
  let buffer = "";
  serialize(value);
  return buffer;

  function serialize(v) {
    if (v === null || typeof v !== "object" || v === undefined || v.toJSON != null) {
      const s = JSON.stringify(v);
      buffer += s === undefined ? "null" : s;
    } else if (Array.isArray(v)) {
      buffer += "[";
      let next = false;
      for (const element of v) {
        if (next) buffer += ",";
        next = true;
        serialize(element);
      }
      buffer += "]";
    } else {
      buffer += "{";
      let next = false;
      for (const key of Object.keys(v).sort()) {
        if (next) buffer += ",";
        next = true;
        buffer += JSON.stringify(key);
        buffer += ":";
        serialize(v[key]);
      }
      buffer += "}";
    }
  }
}

/** JCS-canonicalize then SHA-256 over the UTF-8 bytes. Returns lowercase hex. */
export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** UTF-8 byte length of the canonical serialization (for manifest size fields). */
export function canonicalByteLength(value) {
  return Buffer.byteLength(canonicalize(value), "utf8");
}