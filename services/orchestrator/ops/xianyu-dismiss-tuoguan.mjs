#!/usr/bin/env node
/**
 * Dismiss post-publish 「托管无忧卖」 modal / bottom banner (never tap 立即托管).
 *
 *   node ops/xianyu-dismiss-tuoguan.mjs --aliases 01,02,03,04 --actor <pilot>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, optionalEnv } from "../scripts/lib/load-dotenv.mjs";
import { findTuoguanClose, sleep, stillTuoguanPromo } from "./feishu-to-xianyu-idle-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const ACTOR = opt("--actor", optionalEnv("XHS_ACTOR", "claude-pilot-20260809"));
const ALIASES = String(opt("--aliases", "01,02,03,04"))
  .split(",")
  .map((s) => String(s).trim().padStart(2, "0"))
  .filter(Boolean);
const OUT = opt("--out", join(ROOT, "outbox", "work", `_dismiss-tuoguan-${Date.now()}`));
mkdirSync(OUT, { recursive: true });

function log(m) {
  console.log(m);
}
function sessionFile(alias) {
  return join(process.env.USERPROFILE || "", ".xhs-explorer-sessions", `xw-dismiss-tuoguan-${alias}.json`);
}
function run(args, timeout = 120000) {
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    cwd: ROOT,
    timeout,
    maxBuffer: 16 << 20,
    windowsHide: true,
  });
}
function acquire(alias) {
  const sf = sessionFile(alias);
  if (existsSync(sf)) {
    try {
      run([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf]);
    } catch {
      /* ignore */
    }
  }
  return run([
    join(ROOT, "ops", "xw-explore-session.mjs"),
    "acquire",
    "--alias",
    alias,
    "--actor",
    ACTOR,
    "--session-file",
    sf,
  ]);
}
function release(alias) {
  const sf = sessionFile(alias);
  if (!existsSync(sf)) return;
  try {
    run([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf]);
  } catch (e) {
    log(`[${alias}] release warn: ${e.message}`);
  }
}
function op(alias, script, extra = []) {
  return run([join(ROOT, "ops", script), "--alias", alias, "--session-file", sessionFile(alias), ...extra]);
}

const results = [];
for (const alias of ALIASES) {
  const row = { alias, ok: false, steps: [] };
  try {
    log(`=== ${alias} ===`);
    acquire(alias);
    for (let pass = 0; pass < 3; pass += 1) {
      const dumpPath = join(OUT, `${alias}-pass${pass}.xml`);
      op(alias, "dump-ui.mjs", ["--out", dumpPath]);
      const xml = readFileSync(dumpPath, "utf8");
      if (!stillTuoguanPromo(xml)) {
        row.ok = true;
        row.steps.push({ pass, action: "done" });
        break;
      }
      const target = findTuoguanClose(xml);
      if (!target) {
        row.steps.push({ pass, action: "no-target" });
        break;
      }
      log(`[${alias}] tap ${target.kind} ${target.cx},${target.cy}`);
      op(alias, "tap.mjs", ["--x", String(target.cx), "--y", String(target.cy)]);
      sleep(1500);
      row.steps.push({ pass, action: target.kind, x: target.cx, y: target.cy });
    }
    const finalDump = join(OUT, `${alias}-final.xml`);
    op(alias, "dump-ui.mjs", ["--out", finalDump]);
    row.ok = !stillTuoguanPromo(readFileSync(finalDump, "utf8"));
    try {
      op(alias, "screenshot-and-analyze.mjs", ["--out", join(OUT, `${alias}-dismissed.png`)]);
    } catch {
      /* soft */
    }
  } catch (e) {
    row.error = String(e.message || e).slice(0, 400);
  } finally {
    release(alias);
    results.push(row);
    log(`[${alias}] ok=${row.ok}`);
  }
}
writeFileSync(join(OUT, "dismiss-results.json"), JSON.stringify(results, null, 2));
log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
