#!/usr/bin/env node
// node ops/tap.mjs --alias 01 --session-file <ctx> --x 540 --y 1200
import { authorizeExplorerLease, parseArgs, resolveDevice, runExplorerPrimitive } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/tap.mjs --alias <01-04> --session-file <context.json> --x <px> --y <px>\n正式 session_action（xiaowei.explorer.primitive）。stdout: TAP=ok");
  process.exit(0);
}
const alias = opt("--alias");
const x = opt("--x");
const y = opt("--y");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
if (!alias || x == null || y == null) {
  console.log("✗ need --alias --x --y");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const result = await runExplorerPrimitive({
    primitive: "tap",
    x: Math.round(Number(x)),
    y: Math.round(Number(y)),
  });
  console.log(`TAP=ok`);
  console.log(`X=${result.output?.x ?? Math.round(Number(x))}`);
  console.log(`Y=${result.output?.y ?? Math.round(Number(y))}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
