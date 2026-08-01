#!/usr/bin/env node
/**
 * review-windows — 评审 Windows 落盘的验收证据，对照 Mac 已固化子 skill，出事实报告。
 *
 *   node scripts/review-windows.mjs
 *
 * 把「收编后核证据」这步的机械部分固化：SSH Windows 列+拉回 tmp-know 下 ACCEPTANCE 与
 * EXPLORE 报告；本地遍历各 skills 子目录的 SKILL.md frontmatter（version/verified）；对照
 * exit 码，出 markdown 事实表到 stdout。agent 拿表按 governance §6 评判、出路由提案。
 *
 * 设计取舍（同 adopt-from-windows.mjs）：
 *   - 零第三方依赖（node: only）；一次 SSH 返回 base64 JSON，远端只 readFileSync。
 *   - 只读 Windows、只读 Mac 仓库、不写任何文件（纯输出 stdout）。
 *   - 不自动 diff、不自动扫库：远端显式 filter ACCEPTANCE-/EXPLORE- 前缀，本地显式遍历 skills/。
 *   - Mac 治理工具，不进 npm run check（不在 Windows 跑）；实现后跑 node --check 确认语法。
 *
 * 边界：脚本只做事实采集 + 机械对照，**不做评判**——自由度等级、地图保 v0.1、能否成
 *   业务行的判断含主观，由 agent 读 modes/governance.md §6 做。脚本标三档（✅一致 /
 *   ⚠️ 有证据但缺显式 exit 码 / ❌ 无证据），档位基于「verified 自报 vs ACCEPTANCE 落盘」
 *   的事实对照，不含主观。
 *
 * 环境变量：ADOPT_SSH 覆盖 SSH host（默认 xhs-windows）。
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN_BASE = "C:\\Users\\Public\\xhs-registry\\";
const TMPKNOW = WIN_BASE + "tmp-know";
const SSH_HOST = process.env.ADOPT_SSH || "xhs-windows";

// 基础设施目录（不是 App，不进 App 级报告）
const NON_APP = new Set(["shared", "device", "CONTRIBUTING.md"]);

// ── 远端：列并读 tmp-know 下 ACCEPTANCE-*.md + EXPLORE-*.md，返回 base64 JSON ──
const remote =
  "const fs=require('fs'),path=require('path');const dir=" + JSON.stringify(TMPKNOW) +
  ";let files=[];try{files=fs.readdirSync(dir).filter(f=>/^(ACCEPTANCE|EXPLORE)-.+\\.md$/i.test(f));}" +
  "catch(e){process.stderr.write('ERR dir: '+e.message+'\\n');}" +
  "const out={};for(const f of files){try{out[f]=fs.readFileSync(path.join(dir,f)).toString('base64');}" +
  "catch(e){out[f]='ERR:'+e.message;}}process.stdout.write(JSON.stringify(out));";

function pullRemote() {
  return new Promise((resolve, reject) => {
    const p = spawn("ssh", [SSH_HOST, "node -"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ssh exit ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error("远端非 JSON: " + out.slice(0, 200))); }
    });
    p.on("error", reject);
    p.stdin.end(remote);
  });
}

// ── 简易 frontmatter 解析（零依赖；只取 version + verified result 列表 + note exit 码）──
function parseSkill(path) {
  let content;
  try { content = readFileSync(path, "utf8"); } catch { return null; }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { path, version: null, results: [], hasExitNote: false };
  const block = m[1];
  const version = (block.match(/^version:\s*"?([^"\r\n]+)"?/m) || [])[1] || null;
  const results = [...block.matchAll(/^\s*result:\s*(\S+)/gm)].map((x) => x[1]);
  const hasExitNote = /exit=0|exit 0/i.test(block);
  // verified 各条 note 里的 device/mode 顺带抽出来，报告里好读
  const notes = [...block.matchAll(/^\s*note:\s*"?(.*?)"?\s*$/gm)].map((x) => x[1]);
  return { path, version, results, hasExitNote, notes };
}

// 判断已固化子 skill：version 1.0 + verified 含 pass（至少一条）
function isFixed(skill) {
  return skill && skill.version === "1.0" && skill.results.includes("pass");
}

// ── 对照：在所有 ACCEPTANCE 内容里搜 skill name，提证据行 + 是否含显式 exit=0 ──
//   先按 app 前缀过滤文件（xhs 子 skill 只看 ACCEPTANCE-XHS-*，不跨 app 误命中 douyin），
//   再在文件名/正文里匹配 skill 名。
function evidenceFor(skillName, app, accept) {
  const needle = skillName.toLowerCase();
  const key = skillName.replace(/^douyin-|^xhs-|^xianyu-|^wechat-/i, "").toLowerCase();
  const appPrefix = "ACCEPTANCE-" + app.toUpperCase() + "-";
  const hits = [];
  for (const [fname, b64] of Object.entries(accept)) {
    if (!fname.startsWith(appPrefix) || String(b64).startsWith("ERR:")) continue;
    const text = Buffer.from(b64, "base64").toString("utf8");
    const tl = text.toLowerCase();
    const fnameHit = fname.toLowerCase().includes(key);
    const textHit = tl.includes(needle) || tl.includes(key);
    if (!fnameHit && !textHit) continue;
    const lines = text
      .split(/\r?\n/)
      .filter((l) => /exit|PASS=|=ok|=✅|outcome[:：]/i.test(l))
      .map((l) => l.trim())
      .slice(0, 6);
    hits.push({
      file: fname,
      lines,
      hasExit0: /\bexit[ =]+0\b/i.test(text) || /\bexit 0\b/i.test(text),
    });
  }
  return hits;
}

function consistency(skill, hits) {
  const anyPass = skill.results.includes("pass");
  if (!anyPass) return { mark: "—", label: "verified 无 pass" };
  if (!hits.length) return { mark: "❌", label: "无对应 ACCEPTANCE" };
  if (hits.some((h) => h.hasExit0)) return { mark: "✅", label: "ACCEPTANCE 含 exit=0" };
  if (hits.some((h) => h.lines.length)) return { mark: "⚠️", label: "有证据但缺显式 exit=0" };
  return { mark: "⚠️", label: "命中但无证据行" };
}

// ── 遍历 App：skills/<app> 下子 skill + 地图 ──
function apps() {
  const out = [];
  for (const e of readdirSync(join(REPO, "skills"), { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || NON_APP.has(e.name)) continue;
    const appDir = join(REPO, "skills", e.name);
    const mapPath = join(appDir, "SKILL.md");
    const map = parseSkill(mapPath);
    const subs = [];
    for (const se of readdirSync(appDir, { withFileTypes: true })) {
      if (!se.isDirectory() || se.name.startsWith(".")) continue;
      const sp = join(appDir, se.name, "SKILL.md");
      const sk = parseSkill(sp);
      if (sk) subs.push({ name: `${e.name}/${se.name}`, skill: sk });
    }
    out.push({ app: e.name, hasMap: !!map, map, subs });
  }
  return out;
}

function esc(s) {
  return String(s).replace(/\|/g, "\\|");
}

// ── 主 ──
(async () => {
  const remote = await pullRemote();
  const accept = {};
  const explore = {};
  let dirErr = false;
  for (const [fname, b64] of Object.entries(remote)) {
    if (String(b64).startsWith("ERR:")) { dirErr = true; continue; }
    if (fname.startsWith("ACCEPTANCE-")) accept[fname] = b64;
    else if (fname.startsWith("EXPLORE-")) explore[fname] = b64;
  }

  const acceptNames = Object.keys(accept).sort();
  const exploreNames = Object.keys(explore).sort();

  // stale 原料：从 EXPLORE 里抽含「已发/已通/已做/已绿/成功」的行（op 表矛盾线索）
  const staleLines = [];
  for (const [fname, b64] of Object.entries(explore)) {
    const text = Buffer.from(b64, "base64").toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (/已发|已通|已做|已绿|成功|未做|未登录|青少年|更新弹窗/.test(line)) {
        staleLines.push(`${fname} ｜ ${line.trim()}`);
      }
    }
  }

  console.log(`# registry-review 事实报告\n`);
  console.log(`> 自动采集：Windows ${TMPKNOW} （ACCEPTANCE ${acceptNames.length} / EXPLORE ${exploreNames.length}）↔ Mac skills/ 已固化子 skill。只列事实，评判见 governance §6。\n`);

  if (dirErr) console.log(`> ⚠️ 远端 tmp-know 列目录出错（部分文件可能拉取失败）\n`);

  for (const { app, hasMap, map, subs } of apps()) {
    const fixed = subs.filter((s) => isFixed(s.skill));
    console.log(`## ${app}${hasMap ? `（地图 v${map.version || "?"}；${fixed.length} 已固化子 skill / ${acceptNames.length} ACCEPTANCE）` : `（无 App 级地图；${fixed.length} 已固化子 skill）`}\n`);

    if (subs.length) {
      console.log(`### 已固化子 skill ↔ ACCEPTANCE 对照\n`);
      console.log(`| 子 skill | ver | verified results | 命中 ACCEPTANCE | exit 证据 | 一致 |`);
      console.log(`|---|---|---|---|---|---|`);
      for (const { name, skill } of subs) {
        const v = isFixed(skill) ? skill : null;
        if (!v) {
          console.log(`| ${name} | ${skill.version || "?"} | ${(skill.results.join(",") || "—")} | — | — | 非 v1.0/pass |`);
          continue;
        }
        const hits = evidenceFor(name.split("/")[1], app, accept);
        const c = consistency(skill, hits);
        const files = hits.length ? hits.map((h) => h.file.replace(/^ACCEPTANCE-|\.md$/g, "")).join(", ") : "—";
        const ev = hits.length ? hits.map((h) => h.hasExit0 ? "exit=0" : h.lines.length ? "证据行无 exit=0" : "无证据行").join("；") : "—";
        console.log(`| ${name} | ${skill.version} | ${esc(skill.results.join(",")) || "—"} | ${esc(files)} | ${esc(ev)} | ${c.mark} ${c.label} |`);
      }
      console.log("");
    } else {
      console.log(`### 已固化子 skill\n（无子 skill 目录）\n`);
    }

    // 候选业务行原料：已固化 + 有 exit 证据 的
    if (fixed.length) {
      console.log(`### 候选业务行原料（待 agent 按 §6 判自由度）`);
      for (const { name, skill } of fixed) {
        const hits = evidenceFor(name.split("/")[1], app, accept);
        const c = consistency(skill, hits);
        console.log(`- **${name}**　v${skill.version} / verified: ${skill.results.join(",")} / ${c.mark} ${c.label}`);
        if (skill.notes.length) console.log(`  - note: ${esc(skill.notes.join(" | "))}`);
      }
      console.log("");
    } else {
      console.log(`### 候选业务行原料\n无（无 v1.0+pass 固化子 skill）\n`);
    }

    // EXPLORE 短报（探索态，未固化）
    const appExplore = exploreNames.filter((f) => f.toLowerCase().includes(app));
    if (appExplore.length) {
      console.log(`### EXPLORE 短报（探索态，未固化，无对应 ACCEPTANCE = 未成业务行）`);
      for (const f of appExplore) console.log(`- ${f}`);
      console.log("");
    }

    // stale 原料
    const appStale = staleLines.filter((l) => l.toLowerCase().includes(app));
    if (appStale.length) {
      console.log(`### stale 原料（op 表自报 vs EXPLORE 矛盾线索，待 agent / Win 判）`);
      for (const l of appStale.slice(0, 8)) console.log(`- ${esc(l)}`);
      console.log("");
    }

    if (!hasMap) console.log(`### 缺地图\n\`skills/${app}/\` 有子 skill 但无 \`skills/${app}/SKILL.md\` 聚合页 ← 待 Win 建（Mac 不替 Win 建地图）\n`);
  }

  // 落盘清单（governance §4 审核要核实「adopt 拉回的文件是否齐」）
  console.log(`## 落盘清单\n`);
  console.log(`ACCEPTANCE (${acceptNames.length}):`);
  for (const f of acceptNames) console.log(`- ${f}`);
  console.log(`\nEXPLORE (${exploreNames.length}):`);
  for (const f of exploreNames) console.log(`- ${f}`);
  console.log("");
})();