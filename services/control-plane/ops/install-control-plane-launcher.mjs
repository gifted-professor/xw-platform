#!/usr/bin/env node
import { installGateFLauncherArtifacts } from "./gate-f-launcher-identity.mjs";

function usage() {
  return [
    "Usage:",
    "  node services/control-plane/ops/install-control-plane-launcher.mjs",
    "    --runtime-root <absolute-path>",
    "    --release-id <release-id>",
    "    --source-commit <40-hex>",
    "",
    "Creates immutable launcher/binding/task-XML artifacts only.",
    "Requires pre-provisioned fixed private material, provider config, M6 FINAL binding, and serve 03/04 bindings.",
    "It never registers, replaces, starts, stops, or restarts a scheduled task.",
  ].join("\n");
}

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const allowed = new Set(["--runtime-root", "--release-id", "--source-commit"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`GATE_F_INSTALL_ARGUMENT_INVALID: ${key ?? "<missing>"}`);
    }
    if (Object.hasOwn(parsed, key)) throw new Error(`GATE_F_INSTALL_ARGUMENT_DUPLICATE: ${key}`);
    parsed[key] = value;
  }
  if (Object.keys(parsed).length !== allowed.size) {
    throw new Error("GATE_F_INSTALL_ARGUMENT_REQUIRED: runtime root, release id, and source commit are required");
  }
  return {
    runtimeRoot: parsed["--runtime-root"],
    expectedReleaseId: parsed["--release-id"],
    expectedSourceCommit: parsed["--source-commit"],
  };
}

try {
  const input = parseArgs(process.argv.slice(2));
  if (input.help) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
  } else {
    const receipt = installGateFLauncherArtifacts(input);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error?.message || "GATE_F_INSTALL_FAILED"}\n`);
  process.exitCode = 1;
}
