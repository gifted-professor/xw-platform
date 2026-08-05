#!/usr/bin/env node
// node ops/focus.mjs --alias 01
import { authorizeExplorerLease, parseArgs, resolveDevice, ensureWinHelper, runWinXiaowei, parseJsonLine } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/focus.mjs --alias <01-04> --session-file <context.json>\nstdout: FOCUS=pkg/activity");
  process.exit(0);
}
const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const raw = runWinXiaowei(ssh, helper, ["--serial", serial, "--action", "focus"]);
  const j = parseJsonLine(raw);
  if (!j.ok) {
    console.log(`✗ ${j.error || "focus failed"}`);
    process.exit(2);
  }
  const focus = j.package && j.activity ? `${j.package}/${j.activity}` : (j.raw || "unknown");
  console.log(`FOCUS=${focus}`);
  if (j.package) console.log(`PACKAGE=${j.package}`);
  if (j.activity) console.log(`ACTIVITY=${j.activity}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
