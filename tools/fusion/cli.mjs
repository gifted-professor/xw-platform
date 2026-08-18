#!/usr/bin/env node
// Fusion verification CLI. stdout: one JSON object. stderr: diagnostics.
// Not imported by runtime. Never talks to devices or live ports.

import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyRepo } from "./verify.mjs";
import { runTestGate } from "./test-gate.mjs";

const VERSION = "xhs.fusion.cli.v1";

function emit(obj) {
  process.stdout.write(JSON.stringify({ ...obj, cliVersion: VERSION }) + "\n");
}

function diag(msg) {
  process.stderr.write(String(msg) + "\n");
}

export function main(argv = process.argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  try {
    if (cmd === "--version" || cmd === "version") {
      emit({ subcommand: "version", version: VERSION });
      return 0;
    }
    if (cmd === "verify") {
      const root = resolve(args[1] || ".");
      const report = verifyRepo(root);
      emit({ subcommand: "verify", root, ...report });
      if (report.status !== "PASS") {
        process.exitCode = 1;
        return 1;
      }
      return 0;
    }
    if (cmd === "test-run") {
      const here = dirname(fileURLToPath(import.meta.url));
      const testDir = resolve(args[1] || join(here, "test"));
      const files = readdirSync(testDir)
        .filter((f) => f.endsWith(".test.mjs"))
        .map((f) => join(testDir, f));
      const r = spawnSync(process.execPath, ["--test", ...files], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      process.stderr.write(r.stderr || "");
      process.stdout.write(r.stdout || "");
      const combined = `${r.stdout || ""}\n${r.stderr || ""}`;
      const summary = {};
      for (const k of ["tests", "pass", "fail", "skipped"]) {
        const m = combined.match(new RegExp(`(?:#|ℹ)\\s+${k}\\s+(\\d+)`));
        if (m) summary[k] = Number(m[1]);
      }
      emit({
        subcommand: "test-run",
        status: (summary.fail || 0) > 0 ? "FAIL" : "PASS",
        exitCode: r.status,
        ...summary,
      });
      if ((summary.fail || 0) > 0 || r.status !== 0) {
        process.exitCode = 1;
        return 1;
      }
      return 0;
    }
    if (cmd === "test-gate") {
      const suiteIdx = args.indexOf("--suite");
      const only = suiteIdx >= 0 ? args[suiteIdx + 1] : null;
      const positional = args.filter((a, i) => !a.startsWith("--") && (suiteIdx < 0 || i !== suiteIdx + 1));
      const root = resolve(positional[0] || ".");
      const report = runTestGate(root, { only });
      emit({ subcommand: "test-gate", root, ...report });
      if (report.status === "BLOCK") {
        process.exitCode = 1;
        return 1;
      }
      return 0;
    }
    diag("usage: cli.mjs <verify|test-gate|test-run|version> [repoRoot]");
    emit({ subcommand: cmd || "unknown", status: "BLOCK", reason: `unknown command: ${cmd}` });
    process.exitCode = 2;
    return 2;
  } catch (e) {
    diag(`error: ${e.stack || e.message}`);
    emit({ subcommand: cmd || "unknown", status: "BLOCK", reason: e.message });
    process.exitCode = 1;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
