import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseFailingNames(text) {
  const marker = "✖ failing tests:";
  const idx = text.indexOf(marker);
  const block = idx >= 0 ? text.slice(idx + marker.length) : "";
  const names = [];
  const seen = new Set();
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*✖ (.+?) \(\d/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function parseSummary(text) {
  const out = {};
  for (const key of ["tests", "pass", "fail", "skipped"]) {
    const m = text.match(new RegExp(`(?:#|ℹ)\\s+${key}\\s+(\\d+)`));
    if (m) out[key] = Number(m[1]);
  }
  return out;
}

export function evaluateSuite(allowedFailures, failingNames) {
  const allowed = new Set(allowedFailures);
  const unexpectedFailures = failingNames.filter((name) => !allowed.has(name));
  const allowedFailuresHit = failingNames.filter((name) => allowed.has(name));
  return {
    unexpectedFailures,
    allowedFailuresHit,
    status: unexpectedFailures.length ? "BLOCK" : failingNames.length ? "KNOWN_FAILURE_MATCH" : "PASS",
  };
}

export function loadBaseline(root) {
  return JSON.parse(readFileSync(join(root, "docs/fusion/test-baseline.v1.json"), "utf8"));
}

export function runSuite(root, name, suite) {
  const cwd = join(root, suite.cwd);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, suite.npmArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const failingNames = parseFailingNames(text);
  const summary = parseSummary(text);
  const verdict = evaluateSuite(suite.allowedFailures || [], failingNames);
  return {
    name,
    cwd: suite.cwd,
    exitCode: result.status ?? 1,
    ...summary,
    failingNames,
    ...verdict,
  };
}

export function runTestGate(root) {
  const baseline = loadBaseline(root);
  const suites = Object.entries(baseline.suites).map(([name, suite]) => runSuite(root, name, suite));
  const unexpected = suites.flatMap((s) => s.unexpectedFailures.map((n) => `${s.name}: ${n}`));
  const status = unexpected.length
    ? "BLOCK"
    : suites.some((s) => s.status === "KNOWN_FAILURE_MATCH")
      ? "KNOWN_FAILURE_MATCH"
      : "PASS";
  return {
    status,
    runtimeCutoverAllowed: false,
    unexpectedFailures: unexpected,
    suites,
  };
}
