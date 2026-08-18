#!/usr/bin/env node
/**
 * Source-only Xiaohongshu intent compiler.
 *
 *   node ops/xw-xhs-compose.mjs plan --goal "小红书浏览20分钟，每5分钟点赞2条，收藏1条，最后回首页"
 *   node ops/xw-xhs-compose.mjs catalog
 *   node ops/xw-xhs-compose.mjs validate --input runtime/plans/xhs-compose-example/plan.json
 *
 * This command never acquires a lease or touches a device. `run --execute` stays
 * fail-closed until the dynamic XHS workflow has an authorized live canary.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compileXhsComposePlan,
  loadXhsComposeCatalog,
  resolveSafePlanInput,
  validateXhsComposeCatalog,
  validateXhsComposePlan,
} from "../scripts/lib/xhs-compose.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) { out[key] = next; index += 1; }
    else out[key] = true;
  }
  return out;
}

function bareFlag(args, key) {
  if (!(key in args)) return false;
  if (args[key] !== true) throw new Error(`--${key} must be a bare flag`);
  return true;
}

function usage() {
  return `usage: node ops/xw-xhs-compose.mjs plan --goal <小红书自然语言目标> [--aliases 03,04] [--keyword 词] [--duration-min N] [--interval-sec N] [--locate-only]
       node ops/xw-xhs-compose.mjs catalog
       node ops/xw-xhs-compose.mjs validate --input <plan.json>
       node ops/xw-xhs-compose.mjs run --goal <目标> [--execute]

plan/catalog/validate are source-only. run --execute is intentionally unavailable before live canary promotion.`;
}

function tags(raw) {
  return String(raw || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean);
}

function compile(args) {
  return compileXhsComposePlan({
    goal: args.goal || args._.slice(1).join(" "),
    aliases: args.aliases || null,
    keyword: args.keyword || null,
    durationMinutes: args["duration-min"] || null,
    intervalSec: args["interval-sec"] || null,
    locateOnly: bareFlag(args, "locate-only") || null,
    title: args.title || null,
    body: args.body || null,
    tags: tags(args.tags),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log(usage()); return; }
  const command = args._[0] || "plan";
  if (command === "catalog") {
    const catalog = loadXhsComposeCatalog();
    const errors = validateXhsComposeCatalog(catalog);
    console.log(JSON.stringify({ ok: errors.length === 0, command, sourceOnly: true, errors, catalog }, null, 2));
    if (errors.length) process.exitCode = 2;
    return;
  }
  if (command === "validate") {
    const path = resolveSafePlanInput(args.input, ROOT);
    if (!existsSync(path)) throw new Error(`plan not found: ${args.input}`);
    const plan = JSON.parse(readFileSync(path, "utf8"));
    const errors = validateXhsComposePlan(plan);
    console.log(JSON.stringify({ ok: errors.length === 0, command, sourceOnly: true, errors, planId: plan.planId || null }, null, 2));
    if (errors.length) process.exitCode = 2;
    return;
  }
  if (!new Set(["plan", "run"]).has(command)) throw new Error(`unsupported command: ${command}`);
  const plan = compile(args);
  if (command === "run" && bareFlag(args, "execute")) {
    const reason = plan.execution.executionReady
      ? "xhs_compose_executor_not_implemented"
      : plan.execution.reason;
    console.log(JSON.stringify({
      ok: false,
      command,
      executionReady: false,
      reason,
      message: "source-only compiler is installed; live execution remains fail-closed until an authorized canary promotes the workflow",
      plan,
    }, null, 2));
    process.exitCode = 4;
    return;
  }
  console.log(JSON.stringify({ ok: true, command, sourceOnly: true, plan }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: { code: "XHS_COMPOSE_FAILED", message: String(error?.message || error) } }, null, 2));
    process.exit(2);
  });
}
