/**
 * Zero-dep .env loader. Does not override existing process.env values.
 * Fail closed at call sites via requireEnv() — never embed production secrets in source.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadDotenv(root = DEFAULT_ROOT, filename = ".env") {
  const filePath = path.join(root, filename);
  if (!existsSync(filePath)) return { loaded: false, path: filePath };
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return { loaded: true, path: filePath };
}

export function requireEnv(name, { hint } = {}) {
  const value = process.env[name];
  if (value == null || String(value).trim() === "") {
    const where = hint || "Copy .env.example to .env and fill local secrets (never commit .env).";
    throw new Error(`Missing required env ${name}. ${where}`);
  }
  return String(value).trim();
}

export function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  if (value == null || String(value).trim() === "") return fallback;
  return String(value).trim();
}
