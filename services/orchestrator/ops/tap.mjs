#!/usr/bin/env node
// node ops/tap.mjs --alias 01 --x 540 --y 1200
import { parseArgs, resolveDevice, ensureWinHelper, runWinXiaowei, parseJsonLine } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/tap.mjs --alias <01-04> --x <px> --y <px> [--ssh xhs-windows]\nExplorer lab（22222）。stdout: TAP=ok");
  process.exit(0);
}
const alias = opt("--alias");
const x = opt("--x");
const y = opt("--y");
const ssh = opt("--ssh", "xhs-windows");
if (!alias || x == null || y == null) {
  console.log("✗ need --alias --x --y");
  process.exit(4);
}
try {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  const raw = runWinXiaowei(ssh, helper, ["--serial", serial, "--action", "tap", "--x", String(x), "--y", String(y)]);
  const j = parseJsonLine(raw);
  if (!j.ok) {
    console.log(`✗ ${j.error || "tap failed"}`);
    process.exit(2);
  }
  console.log(`TAP=ok`);
  console.log(`X=${j.x}`);
  console.log(`Y=${j.y}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
