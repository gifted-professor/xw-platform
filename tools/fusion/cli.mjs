#!/usr/bin/env node
// Fusion verification CLI. stdout: one JSON object. stderr: diagnostics.
// Not imported by runtime. Never talks to devices or live ports.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { verifyRepo } from "./verify.mjs";

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
    diag("usage: cli.mjs <verify|version> [repoRoot]");
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
