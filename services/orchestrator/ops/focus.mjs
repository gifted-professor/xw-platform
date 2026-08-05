#!/usr/bin/env node
// node ops/focus.mjs --alias 01 --session-file <ctx>
import { authorizeExplorerLease, parseArgs, resolveDevice, runExplorerPrimitive } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/focus.mjs --alias <01-04> --session-file <context.json>\nstdout: FOCUS=package/activity");
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
  const result = await runExplorerPrimitive({ primitive: "focus" });
  const out = result.output || {};
  const focus = out.package && out.activity ? `${out.package}/${out.activity}` : (out.raw || "");
  console.log(`FOCUS=${focus}`);
  console.log(`PACKAGE=${out.package || ""}`);
  console.log(`ACTIVITY=${out.activity || ""}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
