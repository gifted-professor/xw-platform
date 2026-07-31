#!/usr/bin/env node
// node ops/back.mjs --alias 01
// node ops/back.mjs --alias 01 --times 2
import { parseArgs, resolveDevice, ensureWinHelper, runWinShell } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/back.mjs --alias <01-04> [--times 1] [--ssh xhs-windows]\nstdout: BACK=ok");
  process.exit(0);
}
const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const times = Math.max(1, Math.min(5, Number(opt("--times", "1")) || 1));
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
try {
  const { serial } = resolveDevice(ssh, alias);
  const helper = ensureWinHelper(ssh);
  for (let i = 0; i < times; i++) {
    const j = runWinShell(ssh, serial, "input keyevent 4", helper);
    if (!j.ok) {
      console.log(`✗ ${j.error || "back failed"}`);
      process.exit(2);
    }
  }
  console.log(`BACK=ok`);
  console.log(`TIMES=${times}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
