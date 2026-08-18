import { createHash, randomUUID } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash("sha256").update(input).digest("hex");
}

export function fingerprint(value) {
  return sha256(canonicalJson(value));
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}
