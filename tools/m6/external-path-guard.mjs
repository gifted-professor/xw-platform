#!/usr/bin/env node
/**
 * M6-0 static external-path guard.
 *
 * Scans source files under services/orchestrator, packages and integrations
 * (.mjs/.js/.ts/.json/.py/.ps1; node_modules, tests, fixtures and docs skipped) for
 * machine-external absolute paths: Windows drive paths (C:\, D:\), POSIX
 * /Users|/home|/Volumes roots, Python venv markers (.venv*) and site-packages.
 *
 * Every match must be registered in the M6-0 baseline inside
 * services/orchestrator/contracts/m6/vision-inventory.v1.json
 * (externalPathBaseline[]). Registered compat exceptions pass; any new,
 * unregistered (file, literal) pair is listed and exits non-zero.
 *
 * Usage: node tools/m6/external-path-guard.mjs [--json] [--root <dir>] [--inventory <file>]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export const SCAN_ROOTS = Object.freeze([
  "services/orchestrator",
  "packages",
  "integrations",
]);
export const DEFAULT_INVENTORY = "services/orchestrator/contracts/m6/vision-inventory.v1.json";

const EXTENSIONS = new Set([".mjs", ".js", ".ts", ".json", ".py", ".ps1"]);
const SKIP_SEGMENTS = new Set(["node_modules", "tests", "test", "fixtures", "docs", ".git"]);
// The M6-0 contract data files literally register every baseline path; they are data, not source.
const EXEMPT_PREFIXES = ["services/orchestrator/contracts/m6/"];

const PATH_CHARS = "[^\\s\"'`<>|;,)\\]}{]";
const PATTERNS = [
  // Windows drive paths; lookbehind rejects URL schemes like http://
  new RegExp(`(?<![A-Za-z])[A-Za-z]:[\\\\/]${PATH_CHARS}*(?: ${PATH_CHARS}+)*`, "g"),
  // POSIX user/volume roots; lookbehind rejects the /Users tail of C:/Users/...
  new RegExp(`(?<![A-Za-z]:)/(?:Users|home|Volumes)/${PATH_CHARS}*(?: ${PATH_CHARS}+)*`, "g"),
  // Python virtualenv / interpreter markers
  /\.venv(?:[-_][A-Za-z0-9]+)*/g,
  /site-packages/g,
];

function normalizeLiteral(raw) {
  return String(raw).replace(/\\\\/g, "\\").replace(/[\\/_.-]+$/, "");
}

export function extractLiterals(text) {
  const out = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const literal = normalizeLiteral(match[0]);
      if (literal.length >= 3) out.push(literal);
    }
  }
  return [...new Set(out)].sort();
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_SEGMENTS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (EXTENSIONS.has(path.extname(entry))) files.push(full);
  }
  return files;
}

/** Collect every external-path literal as { file, line, literal } with repo-relative file. */
export function collectMatches(rootDir = REPO_ROOT, scanRoots = SCAN_ROOTS) {
  const matches = [];
  for (const scanRoot of scanRoots) {
    const absRoot = path.join(rootDir, scanRoot);
    let files = [];
    try {
      files = walk(absRoot);
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = path.relative(rootDir, file).split(path.sep).join("/");
      if (EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((lineText, index) => {
        for (const literal of extractLiterals(lineText)) {
          matches.push({ file: rel, line: index + 1, literal });
        }
      });
    }
  }
  return matches;
}

function baselinePairs(inventory) {
  const pairs = new Set();
  for (const entry of inventory?.externalPathBaseline || []) {
    for (const file of entry.files || []) {
      pairs.add(`${file}${entry.literal}`);
    }
  }
  return pairs;
}

/** Return violations: matches not registered as (file, literal) in the inventory baseline. */
export function evaluateMatches(matches, inventory) {
  const registered = baselinePairs(inventory);
  return matches.filter((match) => !registered.has(`${match.file}${match.literal}`));
}

export function runGuard({ rootDir = REPO_ROOT, inventoryPath = null, scanRoots = SCAN_ROOTS } = {}) {
  const resolvedInventory = inventoryPath || path.join(rootDir, DEFAULT_INVENTORY);
  const inventory = JSON.parse(readFileSync(resolvedInventory, "utf8"));
  const matches = collectMatches(rootDir, scanRoots);
  const violations = evaluateMatches(matches, inventory);
  return { ok: violations.length === 0, scanned: matches.length, violations };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const argOf = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const rootDir = argOf("--root") ? path.resolve(argOf("--root")) : REPO_ROOT;
  const inventoryPath = argOf("--inventory") ? path.resolve(argOf("--inventory")) : null;
  const result = runGuard({ rootDir, inventoryPath });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `EXTERNAL_PATH_GUARD_OK scanned=${result.scanned} violations=0 (baseline: ${DEFAULT_INVENTORY})\n`,
    );
  } else {
    process.stdout.write(`EXTERNAL_PATH_GUARD_FAILED violations=${result.violations.length}\n`);
    for (const violation of result.violations) {
      process.stdout.write(`  ${violation.file}:${violation.line}  ${violation.literal}\n`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
