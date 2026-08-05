#!/usr/bin/env node
// node ops/dump-ui.mjs --alias 01 --session-file <ctx> [--out /tmp/a.xml]
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  authorizeExplorerLease,
  parseArgs,
  resolveDevice,
  runExplorerPrimitive,
} from "./_explore-lib.mjs";
import { copyExplorerEvidence } from "./_explore-session-action.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log("用法: node ops/dump-ui.mjs --alias <01-04> --session-file <context.json> [--out path.xml]\nstdout: DUMP=/abs/path.xml");
  process.exit(0);
}
const alias = opt("--alias");
const ssh = opt("--ssh", "xhs-windows");
const sessionFile = opt("--session-file");
const ts = Date.now();
const localOut = resolve(opt("--out", join(tmpdir(), "xhs-explore", `dump-${alias || "xx"}-${ts}.xml`)));
if (!alias) {
  console.log("✗ need --alias");
  process.exit(4);
}
try {
  await authorizeExplorerLease(ssh, alias, sessionFile);
  const { serial } = resolveDevice(ssh, alias);
  const result = await runExplorerPrimitive({ primitive: "dump_ui" });
  copyExplorerEvidence(result, "dump-ui.xml", localOut);
  if (!existsSync(localOut)) {
    console.log("✗ local dump missing after evidence copy");
    process.exit(4);
  }
  const xml = readFileSync(localOut, "utf8");
  if (!xml.includes("<hierarchy")) {
    console.log("✗ xml missing hierarchy");
    process.exit(2);
  }
  console.log(`DUMP=${localOut}`);
  console.log(`BYTES=${xml.length}`);
  console.log(`JOB=${result.jobId}`);
  console.log(`ALIAS=${alias}`);
  console.log(`SERIAL=${serial}`);
  const hasText = /text="[^"]+"/.test(xml);
  const hasDesc = /content-desc="[^"]+"/.test(xml);
  const nodes = (xml.match(/<node /g) || []).length;
  console.log(`NODES=${nodes}`);
  console.log(`DUMP_HINT=${hasText ? "text+ " : ""}${hasDesc ? "content-desc" : "sparse"}`);
  process.exit(0);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(e.code === 2 ? 2 : 4);
}
