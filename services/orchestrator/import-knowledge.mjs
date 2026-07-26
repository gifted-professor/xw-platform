#!/usr/bin/env node
/**
 * import-knowledge.mjs — 把 knowledge seed JSON 批量导入 Windows registry（经 SSH curl）
 * 用法: node import-knowledge.mjs <seed1.json> [seed2.json ...] [--update]
 *   默认遇 409（id 已存在）跳过并计数；--update 时先删同 id 再插（registry 暂无 DELETE 则报错提示）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SSH_HOST = "xhs-windows";
const seeds = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (seeds.length === 0) {
  console.log("usage: node import-knowledge.mjs <seed.json> [...]");
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

let ok = 0, dup = 0, fail = 0;
for (const file of seeds) {
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`== ${file}: ${items.length} 条 ==`);
  for (const it of items) {
    try {
      const res = sshCurlJson(
        ["-X", "POST", "http://127.0.0.1:17930/api/knowledge", "-H", '"content-type: application/json"', "--data-binary", '"@-"'],
        JSON.stringify(it),
      );
      if (res.ok) { ok++; console.log(`  + ${it.id}`); }
      else if (/already exists/.test(res.error || "")) { dup++; console.log(`  = ${it.id} (已存在跳过)`); }
      else { fail++; console.log(`  ! ${it.id}: ${res.error}`); }
    } catch (e) {
      fail++;
      console.log(`  ! ${it.id}: ${e.message.slice(0, 120)}`);
    }
  }
}
console.log(`\n导入完成: 新增=${ok} 跳过=${dup} 失败=${fail}`);
