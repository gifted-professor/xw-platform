#!/usr/bin/env node
/**
 * Batch: run N complete idle-publish pipelines sequentially.
 * Usage: node ops/feishu-to-xianyu-idle-batch.mjs --skus A,B,C --actor <pilot> --i-confirm-live-publish
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, optionalEnv } from "../scripts/lib/load-dotenv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

const ACTOR = opt("--actor", optionalEnv("XHS_ACTOR", "claude-pilot-20260809"));
const ALIASES = opt("--aliases", "01,02,03,04");
const SKUS = String(opt("--skus", ""))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONFIRM = flag("--i-confirm-live-publish");
const OUT = join(ROOT, "runtime", "plans", `qingdao-idle-batch-${Date.now()}`);

if (!SKUS.length) {
  console.log("need --skus SKU1,SKU2,...");
  process.exit(4);
}
if (!CONFIRM) {
  console.log("refuse: batch live publish requires --i-confirm-live-publish");
  process.exit(4);
}

mkdirSync(OUT, { recursive: true });

function log(m) {
  console.log(m);
  try {
    writeFileSync(join(OUT, "batch.log"), `${new Date().toISOString()} ${m}\n`, { flag: "a" });
  } catch {
    /* ignore */
  }
}

function run(args) {
  try {
    return execFileSync(process.execPath, args, {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 2_000_000,
      maxBuffer: 32 << 20,
      windowsHide: true,
    });
  } catch (e) {
    const msg = `${e.message || e}\n${(e.stdout || "").slice(-2000)}\n${(e.stderr || "").slice(-2000)}`;
    throw new Error(msg);
  }
}

function waitFleetIdle(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = execFileSync("curl.exe", ["-s", "http://127.0.0.1:17920/control/v1/leases"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const leases = JSON.parse(raw).leases || [];
      if (!leases.length) return true;
      log(`waiting leases=${leases.length}`);
    } catch {
      /* retry */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  return false;
}

const summary = [];
log(`batch start n=${SKUS.length} out=${OUT}`);

for (let i = 0; i < SKUS.length; i += 1) {
  const sku = SKUS[i];
  const row = { index: i + 1, sku, ok: false };
  log(`\n======== [${i + 1}/${SKUS.length}] ${sku} FILL ========`);
  try {
    const fillOut = run([
      join(ROOT, "ops", "feishu-to-xianyu-idle-publish.mjs"),
      "--sku",
      sku,
      "--actor",
      ACTOR,
      "--aliases",
      "01,02,03,04",
      "--phase",
      "fill",
    ]);
    log(fillOut.trim().split(/\r?\n/).slice(-12).join("\n"));
    const planMatch = fillOut.match(/--plan\s+(\S+)/) || fillOut.match(/plans\\(qingdao-idle-\d+)/);
    let planDir = null;
    const nextLine = fillOut.split(/\r?\n/).find((l) => l.includes("NEXT:") && l.includes("qingdao-idle-"));
    if (nextLine) {
      const m = nextLine.match(/--plan\s+(\S+)/);
      if (m) planDir = m[1];
    }
    if (!planDir) {
      const m2 = fillOut.match(/qingdao-idle-\d+/g);
      if (m2?.length) planDir = join(ROOT, "runtime", "plans", m2[m2.length - 1]);
    }
    if (!planDir) throw new Error("could not resolve plan dir from fill output");
    row.planDir = planDir;
    if (!waitFleetIdle()) throw new Error("fleet not idle before publish");
    log(`======== [${i + 1}/${SKUS.length}] ${sku} PUBLISH plan=${planDir} ========`);
    const pubOut = run([
      join(ROOT, "ops", "feishu-to-xianyu-idle-publish.mjs"),
      "--plan",
      planDir,
      "--phase",
      "publish",
      "--i-confirm-live-publish",
      "--actor",
      ACTOR,
      "--aliases",
      "01,02,03,04",
    ]);
    log(pubOut.trim().split(/\r?\n/).slice(-20).join("\n"));
    row.ok = !/ok=false/.test(pubOut) && /mark Feishu/.test(pubOut);
    if (!row.ok && /exit/i.test(pubOut)) row.ok = false;
    // treat process exit 0 as success if all aliases ok=true
    const oks = [...pubOut.matchAll(/\[0[1-4]\] ok=(true|false)/g)].map((m) => m[1]);
    if (oks.length) row.ok = oks.every((x) => x === "true");
    row.publishSnippet = pubOut.trim().split(/\r?\n/).slice(-8);
  } catch (e) {
    row.error = String(e.message || e).slice(0, 500);
    log(`FAIL ${sku}: ${row.error}`);
  }
  summary.push(row);
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  log(`[${i + 1}/${SKUS.length}] ${sku} ok=${row.ok}`);
}

const allOk = summary.every((r) => r.ok);
log(`\nBATCH DONE ok=${allOk} ${summary.filter((r) => r.ok).length}/${summary.length}`);
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ allOk, summary }, null, 2));
process.exit(allOk ? 0 : 1);
