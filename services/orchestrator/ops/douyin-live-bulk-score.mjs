#!/usr/bin/env node
/**
 * Score a Douyin title/caption for Xinjiang bulk Live slides harvest.
 *
 *   node ops/douyin-live-bulk-score.mjs --text "用45张live图回忆我的新疆之旅"
 *   node ops/douyin-live-bulk-score.mjs --file captions.txt
 *
 * stdout: SCORE=N KIND=A|B|… REASONS=… ACTION=…
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "./_explore-lib.mjs";
import {
  scoreXjLiveTitle,
  classifyXjLivePrior,
  XJ_LIVE_SEARCH_QUERIES,
} from "./_douyin-xj-live-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/douyin-live-bulk-score.mjs --text <标题> | --file <path>
stdout: SCORE=… KIND=… REASONS=… ACTION=…
推荐搜索词见 --queries`);
  process.exit(0);
}

if (flag("--queries")) {
  for (const q of XJ_LIVE_SEARCH_QUERIES) console.log(`QUERY=${q}`);
  process.exit(0);
}

const text = opt("--text") || (opt("--file") ? readFileSync(opt("--file"), "utf8") : null);
if (!text) {
  console.log("✗ need --text or --file");
  process.exit(4);
}

const lines = String(text)
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

for (const line of lines) {
  const { score, reasons } = scoreXjLiveTitle(line);
  const prior = classifyXjLivePrior(line);
  console.log(`TEXT=${line.slice(0, 120)}`);
  console.log(`SCORE=${score}`);
  console.log(`KIND=${prior.kind}`);
  console.log(`ACTION=${prior.action}`);
  console.log(`REASONS=${reasons.join(",") || "-"}`);
  console.log(`SX=${prior.S},${prior.X},${prior.C}`);
  console.log("---");
}
process.exit(0);
