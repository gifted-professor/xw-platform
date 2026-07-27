#!/usr/bin/env node
/**
 * import-knowledge.mjs — 把 knowledge seed JSON 批量导入 Windows registry（经 SSH curl）
 * 用法: node import-knowledge.mjs <seed1.json> [seed2.json ...] [--update] [--dry-run]
 *   默认遇 409（id 已存在）跳过并计数。
 *   --update：已存在的条目改走 PATCH 更新 appliesTo/steps/verifyMode（registry 没有 DELETE，
 *             也不该有——lifecycle 有终态约束，删了重插会丢历史）。lifecycle 不由本脚本改。
 *   --dry-run：只打印将要做什么，不发任何写请求。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SSH_HOST = "xhs-windows";
const BASE = "http://127.0.0.1:17930";
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const seeds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const UPDATE = flags.includes("--update");
const DRY_RUN = flags.includes("--dry-run");
if (seeds.length === 0) {
  console.log("usage: node import-knowledge.mjs <seed.json> [...] [--update] [--dry-run]");
  process.exit(1);
}

function sshCurlJson(curlArgs, stdinData) {
  const out = execFileSync("ssh", [SSH_HOST, "curl.exe", "-s", ...curlArgs], {
    input: stdinData,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    timeout: 60000,
  });
  return JSON.parse(out);
}

function post(path, body) {
  return sshCurlJson(["-X", "POST", `${BASE}${path}`, "-H", '"content-type: application/json"', "--data-binary", '"@-"'], JSON.stringify(body));
}

function patch(path, body) {
  return sshCurlJson(["-X", "PATCH", `${BASE}${path}`, "-H", '"content-type: application/json"', "--data-binary", '"@-"'], JSON.stringify(body));
}

let ok = 0, dup = 0, updated = 0, fail = 0;
for (const file of seeds) {
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`== ${file}: ${items.length} 条${DRY_RUN ? "（dry-run）" : ""} ==`);
  for (const it of items) {
    if (DRY_RUN) {
      console.log(`  ? ${it.id} — 将尝试新增${UPDATE ? "，已存在则 PATCH appliesTo/steps/verifyMode" : "，已存在则跳过"}`);
      continue;
    }
    try {
      const res = post("/api/knowledge", it);
      if (res.ok) { ok++; console.log(`  + ${it.id}`); continue; }
      if (!/already exists/.test(res.error || "")) { fail++; console.log(`  ! ${it.id}: ${res.error}`); continue; }
      if (!UPDATE) { dup++; console.log(`  = ${it.id} (已存在跳过)`); continue; }
      const patchBody = {};
      if (it.appliesTo !== undefined) patchBody.appliesTo = it.appliesTo;
      if (it.steps !== undefined) patchBody.steps = it.steps;
      if (it.verifyMode !== undefined) patchBody.verifyMode = it.verifyMode;
      if (Object.keys(patchBody).length === 0) { dup++; console.log(`  = ${it.id} (已存在，无可更新字段)`); continue; }
      const upd = patch(`/api/knowledge/${encodeURIComponent(it.id)}`, patchBody);
      if (upd.ok) { updated++; console.log(`  ~ ${it.id} (已更新 ${Object.keys(patchBody).join("/")})`); }
      else { fail++; console.log(`  ! ${it.id} 更新失败: ${upd.error}`); }
    } catch (e) {
      fail++;
      console.log(`  ! ${it.id}: ${e.message.slice(0, 120)}`);
    }
  }
}
console.log(`\n导入完成: 新增=${ok} 更新=${updated} 跳过=${dup} 失败=${fail}`);
