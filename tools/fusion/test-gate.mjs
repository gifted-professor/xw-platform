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

export function platformKey() {
  return process.platform === "win32" ? "win32" : "posix";
}

export function allowedNamesFor(suite, platform = platformKey()) {
  const base = suite.allowedFailures || [];
  const extra = platform === "win32"
    ? suite.allowedFailuresWin32 || []
    : suite.allowedFailuresPosix || [];
  return [...base, ...extra];
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
  const result = spawnSync("npm", suite.npmArgs, {
    cwd,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const failingNames = parseFailingNames(text);
  const summary = parseSummary(text);
  let verdict = evaluateSuite(allowedNamesFor(suite), failingNames);
  // 进程非零退出但解析不到失败名（崩溃、无 "✖ failing tests:" 摘要）→ 必须 BLOCK，
  // 不能当作 PASS 放过。解析不到 = 无法证明失败在 allowlist 内。
  if ((result.status ?? 1) !== 0 && failingNames.length === 0) {
    verdict = {
      unexpectedFailures: ["<unparseable> test process exited non-zero without a parseable failing-tests summary"],
      allowedFailuresHit: [],
      status: "BLOCK",
    };
  }
  return {
    name,
    cwd: suite.cwd,
    exitCode: result.status ?? 1,
    ...summary,
    failingNames,
    ...verdict,
  };
}

export function runTestGate(root, { only } = {}) {
  const baseline = loadBaseline(root);
  const selected = Object.entries(baseline.suites).filter(([name]) => !only || name === only);
  if (only && selected.length === 0) {
    return {
      status: "BLOCK",
      runtimeCutoverAllowed: false,
      unexpectedFailures: [`unknown suite: ${only}`],
      suites: [],
    };
  }
  const suites = selected.map(([name, suite]) => runSuite(root, name, suite));
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
