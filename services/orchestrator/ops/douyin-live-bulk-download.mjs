#!/usr/bin/env node
/**
 * Download Live mp4 list from a harvest folder (video-urls.txt).
 *
 *   node ops/douyin-live-bulk-download.mjs --dir runtime/xj-live/01
 *   node ops/douyin-live-bulk-download.mjs --dir tmp-know/exp-max-01/lyk-lives/downloads/01
 *
 * Expects video-urls.txt (one https URL per line). Writes live-01.mp4 …
 * stdout: DOWNLOAD=ok|partial|fail OK=N TOTAL=N DIR=…
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "./_explore-lib.mjs";
import { bizRecord } from "./_biz-trace.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-live-bulk-download.mjs --dir <folder-with-video-urls.txt>
从龙猫提取后的 URL 列表批量落盘 mp4（不碰手机）。`);
  process.exit(0);
}

const dir = opt("--dir");
const t0 = Date.now();
if (!dir) {
  console.log("✗ need --dir");
  process.exit(4);
}
mkdirSync(dir, { recursive: true });
const listPath = join(dir, "video-urls.txt");
if (!existsSync(listPath)) {
  console.log("DOWNLOAD=fail");
  console.log("REASON=missing_video_urls_txt");
  process.exit(2);
}

const urls = readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((u) => /^https?:\/\//.test(u));

console.log(`TOTAL=${urls.length}`);
console.log(`DIR=${dir}`);
let ok = 0;
for (let i = 0; i < urls.length; i++) {
  const dest = join(dir, `live-${String(i + 1).padStart(2, "0")}.mp4`);
  if (existsSync(dest) && statSync(dest).size > 10000) {
    ok += 1;
    continue;
  }
  const r = spawnSync("curl.exe", ["-L", "--retry", "2", "--connect-timeout", "20", "-o", dest, urls[i]], {
    encoding: "utf8",
    timeout: 180000,
  });
  const sz = existsSync(dest) ? statSync(dest).size : 0;
  if (sz > 10000) {
    ok += 1;
    if ((i + 1) % 5 === 0) console.log(`PROGRESS=${i + 1}/${urls.length} ok=${ok}`);
  } else {
    console.log(`FAIL_INDEX=${i + 1} status=${r.status} size=${sz}`);
  }
}

const meta = { urls: urls.length, downloaded: ok, at: new Date().toISOString() };
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
const outcome = ok === 0 ? "fail" : ok < urls.length ? "partial" : "ok";
console.log(`DOWNLOAD=${outcome}`);
console.log(`OK=${ok}`);
console.log(`TOTAL=${urls.length}`);
bizRecord({
  op: "douyin-live-bulk-download",
  outcome,
  extra: meta,
  alias: null,
  serial: null,
  startMs: t0,
});
process.exit(outcome === "fail" ? 2 : 0);
