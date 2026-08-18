#!/usr/bin/env node
/**
 * adopt-from-windows — 一条命令把 Windows 部署副本里先行落地的文件收编回 Mac 源仓库。
 *
 *   node scripts/adopt-from-windows.mjs ops/douyin-like.mjs skills/douyin/douyin-like/SKILL.md
 *
 * 背景：源在 Mac、实机在 Windows，Windows agent 验收时常直接在部署副本写新文件，
 *   若不收编，下次从 GitHub 单向 sync 会被冲掉。本脚本把指定文件从 Windows 副本
 *   base64 拉回 Mac 仓库对应路径，避免手敲 SSH/转义/乱码。
 *
 * 设计取舍：
 *   - 显式列文件，不自动 diff、不加 --confirm：agent 责任，避免把落后副本当新增拉回覆盖。
 *   - 只读 Windows、只写 Mac 仓库：不向 Windows 推部署（遵守「不必 Mac SSH 推」）。
 *   - 一次 SSH 读全部文件返回 base64 JSON，远端脚本只 readFileSync，无路径转义/引号问题。
 *   - 零第三方依赖（node: only）；Mac 侧治理工具，不进 npm run check（不在 Windows 跑）。
 *
 * 环境变量：ADOPT_SSH 覆盖 SSH host（默认 xhs-windows）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN_BASE = "C:\\Users\\Public\\xhs-registry\\";
const SSH_HOST = process.env.ADOPT_SSH || "xhs-windows";

const files = process.argv.slice(2);
if (!files.length || files.includes("-h") || files.includes("--help")) {
  console.log(`用法: node scripts/adopt-from-windows.mjs <相对路径...>
从 Windows 部署副本 (${WIN_BASE}) base64 拉回 Mac 源仓库对应路径。
例: node scripts/adopt-from-windows.mjs ops/douyin-like.mjs skills/douyin/douyin-like/SKILL.md
显式列文件，不自动 diff。ADOPT_SSH 覆盖 SSH host（默认 ${SSH_HOST}）。`);
  process.exit(files.length ? 0 : 4);
}

// Windows 路径（反斜杠）；JSON.stringify 已正确转义，远端脚本无需再 replace
const winPaths = files.map((f) => WIN_BASE + f.replace(/\//g, "\\"));

// 远端脚本：读所有文件返回 base64 JSON。参数经 JSON 注入，无裸 ${}、无引号冲突。
const remote =
  "const fs=require('fs');const ps=" + JSON.stringify(winPaths) +
  ";const rels=" + JSON.stringify(files) +
  ";const out={};for(let i=0;i<ps.length;i++){try{out[rels[i]]=fs.readFileSync(ps[i]).toString('base64');}catch(e){out[rels[i]]='ERR:'+e.message;}}process.stdout.write(JSON.stringify(out));";

const p = spawn("ssh", [SSH_HOST, "node -"], { stdio: ["pipe", "pipe", "inherit"] });
let out = "";
p.stdout.on("data", (d) => (out += d));
p.on("close", (code) => {
  if (code !== 0) {
    console.log(`✗ ssh exit ${code}`);
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    console.log("✗ 远端返回非 JSON（前 200 字）:", out.slice(0, 200));
    process.exit(2);
  }
  let bad = 0;
  for (const [rel, b64] of Object.entries(data)) {
    if (b64.startsWith("ERR:")) {
      console.log(`ERR  ${rel}  ${b64}`);
      bad++;
      continue;
    }
    const buf = Buffer.from(b64, "base64");
    const dest = join(REPO, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.log(`WROTE ${rel}  ${buf.length} bytes`);
  }
  process.exit(bad ? 1 : 0);
});
p.stdin.end(remote);