#!/usr/bin/env node
// node ops/launch-app.mjs --alias 01 --session-file <ctx> --package com.taobao.idlefish
import { authorizeExplorerLease, parseArgs, resolveDevice, runExplorerPrimitive } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/launch-app.mjs --alias <01-04> --session-file <context.json> --package <pkg> [--activity <comp>] [--force-stop]
默认不 force-stop。stdout: LAUNCH=ok + FOCUS=…`);
  process.exit(0);
}
const alias = opt("--alias");
const pkg = opt("--package");
const activity = opt("--activity");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
const force = flag("--force-stop");
if (!alias || !pkg) {
  console.log("✗ need --alias --package");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const result = await runExplorerPrimitive({
    primitive: "launch_app",
    package: pkg,
    ...(activity ? { activity } : {}),
    ...(force ? { forceStop: true } : {}),
  });
  const f = result.output?.focus || {};
  const focus = f.package && f.activity ? `${f.package}/${f.activity}` : (f.raw || "");
  console.log(`LAUNCH=ok`);
  console.log(`PACKAGE=${pkg}`);
  if (focus) console.log(`FOCUS=${focus}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
