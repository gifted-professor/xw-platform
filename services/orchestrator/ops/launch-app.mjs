#!/usr/bin/env node
// node ops/launch-app.mjs --alias 01 --package com.taobao.idlefish
// node ops/launch-app.mjs --alias 01 --package com.taobao.idlefish --activity com.taobao.idlefish.maincontainer.activity.MainActivity
import { parseArgs, resolveDevice, ensureWinHelper, runWinXiaowei, parseJsonLine } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/launch-app.mjs --alias <01-04> --package <pkg> [--activity <comp>] [--force-stop] [--ssh xhs-windows]
默认不 force-stop。stdout: LAUNCH=ok + FOCUS=…`);
  process.exit(0);
}
const alias = opt("--alias");
const pkg = opt("--package");
const activity = opt("--activity");
const ssh = opt("--ssh", "xhs-windows");
const force = flag("--force-stop");
if (!alias || !pkg) {
  console.log("✗ need --alias --package");
  process.exit(4);
}
try {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const args = ["--serial", serial, "--action", "start", "--package", pkg];
  if (activity) args.push("--activity", activity);
  if (force) args.push("--force-stop");
  const raw = runWinXiaowei(ssh, helper, args);
  const j = parseJsonLine(raw);
  if (!j.ok) {
    console.log(`✗ ${j.error || "launch failed"}`);
    process.exit(2);
  }
  const f = j.focus || {};
  const focus = f.package && f.activity ? `${f.package}/${f.activity}` : (f.raw || "");
  console.log(`LAUNCH=ok`);
  console.log(`PACKAGE=${pkg}`);
  if (focus) console.log(`FOCUS=${focus}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
