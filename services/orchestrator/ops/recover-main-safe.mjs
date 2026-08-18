#!/usr/bin/env node
// 一键 main-safe 零动作恢复：recover-inspect → scp 截图 → analyze.py → build envelope → record → recover
// 把原来 6 步手工压成一条命令。任何设备 hiccup 进 recovery_required 后，只要它停在闲鱼主页，
// 跑这个就能清隔离。fail-closed：视觉分析不认 main-safe 就停，不 recover，保留隔离。
//
// 用法：
//   node ops/recover-main-safe.mjs --job <jobId> [--actor claude-main] [--ssh xhs-windows] \
//     [--gpfs <GPFS repo path>] [--vgp <visual-grounding-poc path>] [--keep]
//
// 前提：设备已停在闲鱼主页（focus=com.taobao.idlefish/MainActivity，底栏闲鱼/卖闲置/消息/我的）。
// 若设备停在 compose/SKU/服务类目等非主页，本脚本会在 record 步判非 main-safe 而 fail-closed 停下——
// 那是正确行为，需先人手把设备退回闲鱼主页再跑。

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);

const JOB = opt("--job");
const ACTOR = opt("--actor", "claude-main");
const SSH = opt("--ssh", "xhs-windows");
const GPFS = opt("--gpfs", "/Volumes/GPFS/Users/a1234/Desktop/Coding/xhs-device-agent-routing-v1-1");
const VGP = opt("--vgp", "/Users/a1234/Desktop/Coding/visual-grounding-poc");
const KEEP = flag("--keep");

if (!JOB) {
  console.log("用法: node ops/recover-main-safe.mjs --job <jobId> [--actor claude-main] [--ssh xhs-windows] [--gpfs <path>] [--vgp <path>] [--keep]");
  process.exit(2);
}

const DEVICTL = join(GPFS, "control-plane/devicectl.mjs");
const BUILD = join(GPFS, "scripts/build-recovery-analysis.mjs");
const ANALYZE = join(VGP, "analyze.py");
const VENV_PY = join(VGP, ".venv/bin/python");
const WIN_RUNS = "C:/Users/Public/xhs-agent-runs";

const workDir = join(tmpdir(), `recover-${JOB.slice(0, 8)}-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

// 从一段输出里抠出第一个完整 JSON 对象（devicectl stdout 可能带警告行）
function parseJson(stdout) {
  const s = String(stdout);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON in output: " + s.slice(0, 200));
  return JSON.parse(s.slice(a, b + 1));
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts }).toString();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const key = (tag) => `${tag}-${JOB.slice(0, 8)}-${Date.now()}`;
const log = (m) => console.log(m);

try {
  // --- 1. recover-inspect（只读，截图 + SHA）---
  log(`[1/6] recover-inspect job=${JOB}`);
  const inspectRaw = run(`node ${DEVICTL} --ssh ${SSH} job recover-inspect --job ${JOB} --actor ${ACTOR} --idempotency-key ${key("inspect")}`);
  const ins = parseJson(inspectRaw).inspection || parseJson(inspectRaw);
  const inspectionId = ins.inspectionId;
  const runId = ins.runId;
  const sha = ins.screenshot?.sha256;
  if (!inspectionId || !runId || !sha) throw new Error("inspect 缺字段: " + JSON.stringify({ inspectionId, runId, sha }).slice(0, 200));
  log(`      inspectionId=${inspectionId} runId=${runId} sha=${sha.slice(0, 12)}…`);

  // --- 2. scp 截图到 Mac ---
  const pngName = `xianyu-${sha.slice(0, 12)}.png`;
  const winPng = `${WIN_RUNS}/${runId}/evidence/${pngName}`;
  const localPng = join(workDir, "shot.png");
  log(`[2/6] scp 截图 ${winPng}`);
  run(`scp ${SSH}:${winPng} ${localPng}`);
  if (!existsSync(localPng)) throw new Error("scp 未拿到截图");

  // --- 3. 校验 SHA 必须匹配 inspect 审计的 ---
  const got = sha256(localPng);
  if (got !== sha) throw new Error(`SHA 不匹配: inspect=${sha} 实际=${got}（截图非审计那张，拒绝恢复）`);
  log(`[3/6] SHA 匹配 ✓`);

  // --- 4. analyze.py 视觉元素 ---
  const elementsPath = join(workDir, "elements.json");
  log(`[4/6] analyze.py 视觉元素`);
  // analyze.py 以 cwd=VGP 跑（模型 models/icon_detect.pt 是相对 cwd 解析的）
  run(`${VENV_PY} analyze.py ${localPng} -o ${elementsPath}`, { cwd: VGP });
  const elements = JSON.parse(readFileSync(elementsPath, "utf8"));
  if (!Array.isArray(elements.elements) || !Array.isArray(elements.resolution)) {
    throw new Error("analyze.py 输出缺 elements/resolution");
  }
  log(`      elements=${elements.elements.length} resolution=${JSON.stringify(elements.resolution)}`);

  // --- 5. build xhs.visual-elements.v1 envelope ---
  const analysisPath = join(workDir, "analysis.json");
  log(`[5/6] build recovery-analysis envelope`);
  run(`node ${BUILD} --image ${localPng} --elements ${elementsPath} --output ${analysisPath}`);
  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  if (analysis.image?.sha256 !== sha) throw new Error("envelope image.sha256 与截图不符");

  // --- 6. recover-inspect-record → 必须 main-safe + safeStateVerified，否则 fail-closed ---
  log(`[6/6] recover-inspect-record（main-safe 硬闸）`);
  const recordRaw = run(`node ${DEVICTL} --ssh ${SSH} job recover-inspect-record --job ${JOB} --inspection ${inspectionId} --idempotency-key ${key("rec")} --analysis "$(cat ${analysisPath})" --actor ${ACTOR}`);
  const rec = parseJson(recordRaw).analysis || parseJson(recordRaw);
  const cls = rec.pageClassification || {};
  log(`      pageType=${cls.pageType} confidence=${cls.confidence} safeStateVerified=${cls.safeStateVerified}`);
  if (cls.pageType !== "main-safe" || cls.safeStateVerified !== true) {
    throw new Error(`FAIL-CLOSED：视觉分析判 pageType=${cls.pageType}（非 main-safe），不恢复，保留隔离。设备可能没停在闲鱼主页——人手退回主页后再跑。`);
  }

  // --- 7. job recover（零动作清隔离）---
  log(`[+] job recover（零动作）`);
  const recoverRaw = run(`node ${DEVICTL} --ssh ${SSH} job recover --job ${JOB} --actor ${ACTOR} --idempotency-key ${key("recover")}`);
  const rc = parseJson(recoverRaw).recovery || parseJson(recoverRaw);
  log(`      restoration.ok=${rc.restoration?.ok} step=${rc.restoration?.step} quarantineCleared=${rc.quarantineCleared}`);
  if (rc.quarantineCleared !== true) {
    throw new Error(`recover 未清隔离：restoration.ok=${rc.restoration?.ok} step=${rc.restoration?.step}。可能 isRecoverySafeMain 仍不认该机型 a11y——看 xianyu-operator.mjs。`);
  }
  log(`\n✓ 恢复完成：${JOB} quarantineCleared=true`);
  log(`  注意：原 job 仍是 terminal recovery_required，registry state.ready 需一个成功 capability job 刷 lastSuccess 才转 true。`);
  log(`  跑个 R0 snapshot 即可：node ${DEVICTL} --ssh ${SSH} job submit --capability xianyu.observe.snapshot --device <devId> --actor ${ACTOR} --idempotency-key snap-<ts> --params '{}'`);
} catch (e) {
  console.log(`\n✗ 恢复中止：${e.message}`);
  process.exit(1);
} finally {
  if (!KEEP) rmSync(workDir, { recursive: true, force: true });
}