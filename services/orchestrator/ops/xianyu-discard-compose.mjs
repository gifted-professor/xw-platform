#!/usr/bin/env node
/** Discard 发闲置 compose (关闭→放弃) so next fill starts clean. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, optionalEnv } from "../scripts/lib/load-dotenv.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);
const ACTOR = process.argv.includes("--actor")
  ? process.argv[process.argv.indexOf("--actor") + 1]
  : optionalEnv("XHS_ACTOR", "claude-pilot-20260809");
const ALIASES = (process.argv.includes("--aliases")
  ? process.argv[process.argv.indexOf("--aliases") + 1]
  : "01,02,03,04"
)
  .split(",")
  .map((s) => s.trim().padStart(2, "0"))
  .filter(Boolean);
const OUT = join(ROOT, "outbox", "work", `_discard-compose-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sf(alias) {
  return join(process.env.USERPROFILE, ".xhs-explorer-sessions", `xw-discard-${alias}.json`);
}
function run(args) {
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 120000,
    maxBuffer: 16 << 20,
    windowsHide: true,
  });
}
function op(alias, script, extra = []) {
  return run([join(ROOT, "ops", script), "--alias", alias, "--session-file", sf(alias), ...extra]);
}
function nodes(xml) {
  const out = [];
  for (const n of [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0])) {
    const text = (n.match(/text="([^"]*)"/) || [])[1] || "";
    const desc = (n.match(/content-desc="([^"]*)"/) || [])[1] || "";
    const blob = `${text} ${desc}`.trim();
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b || !blob) continue;
    out.push({
      blob,
      text,
      desc,
      click: /clickable="true"/.test(n),
      cx: Math.round((+b[1] + +b[3]) / 2),
      cy: Math.round((+b[2] + +b[4]) / 2),
    });
  }
  return out;
}

const results = [];
for (const alias of ALIASES) {
  const row = { alias, ok: false, steps: [] };
  try {
    console.log(`=== discard ${alias} ===`);
    if (existsSync(sf(alias))) {
      try {
        run([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf(alias)]);
      } catch {
        /* ignore */
      }
    }
    run([
      join(ROOT, "ops", "xw-explore-session.mjs"),
      "acquire",
      "--alias",
      alias,
      "--actor",
      ACTOR,
      "--session-file",
      sf(alias),
    ]);
    for (let i = 0; i < 8; i += 1) {
      const dump = join(OUT, `${alias}-${i}.xml`);
      op(alias, "dump-ui.mjs", ["--out", dump]);
      const xml = readFileSync(dump, "utf8");
      const ns = nodes(xml);
      const onCompose = /发闲置/.test(xml) && /存草稿/.test(xml);
      const abandon = ns.find((n) => n.click && /^(放弃)$/.test(String(n.text || n.desc).trim()));
      if (abandon) {
        console.log(`[${alias}] tap 放弃`);
        op(alias, "tap.mjs", ["--x", String(abandon.cx), "--y", String(abandon.cy)]);
        row.steps.push("abandon");
        sleep(1500);
        continue;
      }
      const close = ns.find(
        (n) =>
          n.click &&
          (/^关闭/.test(n.blob.replace(/\s/g, "")) || (n.blob.includes("关闭") && n.cy < 300)),
      );
      if (onCompose && close) {
        console.log(`[${alias}] tap 关闭`);
        op(alias, "tap.mjs", ["--x", String(close.cx), "--y", String(close.cy)]);
        row.steps.push("close");
        sleep(1500);
        continue;
      }
      if (!onCompose) {
        row.ok = true;
        row.steps.push("cleared");
        break;
      }
      op(alias, "launch-app.mjs", ["--package", "com.taobao.idlefish"]);
      row.steps.push("launch");
      sleep(2500);
    }
    const dumpF = join(OUT, `${alias}-final.xml`);
    op(alias, "dump-ui.mjs", ["--out", dumpF]);
    row.ok = !(/发闲置/.test(readFileSync(dumpF, "utf8")) && /存草稿/.test(readFileSync(dumpF, "utf8")));
  } catch (e) {
    row.error = String(e.message || e).slice(0, 300);
  } finally {
    try {
      run([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf(alias)]);
    } catch {
      /* ignore */
    }
    results.push(row);
    console.log(`[${alias}] ok=${row.ok} ${row.steps.join(",")}`);
  }
}
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
