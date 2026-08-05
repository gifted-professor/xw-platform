#!/usr/bin/env node
// node ops/back.mjs --alias 01 --session-file <ctx> [--times 2]
import { authorizeExplorerLease, parseArgs, resolveDevice, runExplorerPrimitive } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/back.mjs --alias <01-04> --session-file <context.json> [--times 1]\nstdout: BACK=ok");
  process.exit(0);
}
const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
const times = Math.max(1, Math.min(5, Number(opt("--times", "1")) || 1));
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const result = await runExplorerPrimitive({ primitive: "back", times });
  console.log(`BACK=ok`);
  console.log(`TIMES=${result.output?.times ?? times}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
