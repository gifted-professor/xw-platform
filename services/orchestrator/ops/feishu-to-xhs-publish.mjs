#!/usr/bin/env node
/**
 * 飞书商品表前 N 行 → 每台下载 6 图 → ADB 推图 → xhs.publish.edit_dry_run --stay
 *
 *   node ops/feishu-to-xhs-publish.mjs --rows 4 --actor claude-pilot-20260809
 *   node ops/feishu-to-xhs-publish.mjs --rows 4 --dry-run
 *   node ops/feishu-to-xhs-publish.mjs --discard --aliases 01,02,03,04
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  FEISHU_BASE_TOKEN,
  FEISHU_TABLE_ID,
  FEISHU_VIEW_ID,
  pushOrderImages,
  readFirstRowsFromRecordList,
  xhsAlbumPath,
  albumFileName,
  imageSelectIndex,
} from "./feishu-to-xhs-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");
const REGISTRY = (process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930").replace(/\/$/, "");
const ADB = process.env.ADB_PATH || "C:\\Program Files (x86)\\xiaowei_android\\tools\\adb.exe";
const ADB_ENV = { ...process.env, ANDROID_ADB_SERVER_PORT: "5038" };
const SERIALS = Object.fromEntries(
  JSON.parse(readFileSync(join(ROOT, "identities.seed.json"), "utf8")).identities.map((item) => [item.alias, item.serial]),
);

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

if (flag("--help") || flag("-h")) {
  console.log(`用法:
  node ops/feishu-to-xhs-publish.mjs --rows 4 --actor <id> [--stay] [--dry-run] [--skip-push]
  node ops/feishu-to-xhs-publish.mjs --aliases 01,02,03,04 --rows 4 --row-offset 4 --actor <id>
  node ops/feishu-to-xhs-publish.mjs --discard --aliases 01,02,03,04 --actor <id>

  从飞书 view ${FEISHU_VIEW_ID} 取前 N 行（可用 --row-offset 跳过，回归用 5–8 行 → offset 4）；
  每行 6 图：四宫格、货架正/背、试穿主/近/背；UTF-8 JSON 提交 job。
  推图：倒序 + touch 修手机 mtime（相册最新在前 → 四宫格第一）。`);
  process.exit(0);
}

const ROWS = Number(opt("--rows", "4")) || 4;
const ROW_OFFSET = Number(opt("--row-offset", "0")) || 0;
const ACTOR = opt("--actor");
const DRY = flag("--dry-run");
const DISCARD = flag("--discard");
const STAY = !flag("--no-stay");
const SKIP_PUSH = flag("--skip-push");
const ALIASES_EXPLICIT = opt("--aliases", null);
const ALIASES = ALIASES_EXPLICIT
  ? ALIASES_EXPLICIT.split(",").map((v) => v.trim()).filter(Boolean)
  : Array.from({ length: ROWS }, (_, i) => String(i + 1 + ROW_OFFSET).padStart(2, "0"));
const IMG_ROOT = opt("--img-dir", join(ROOT, "tmp-imgs", "xhs-publish"));
const TS = Date.now();

function log(msg) {
  console.log(msg);
}

function sh(cmd, args, { cwd, timeout = 120000 } = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: ADB_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function lark(args, cwd) {
  let out;
  try {
    out = sh("lark-cli", args, { cwd, timeout: 120000 });
  } catch (e) {
    throw new Error(`lark-cli: ${(e.stderr || e.message || "").toString().slice(0, 300)}`);
  }
  const data = JSON.parse(out);
  if (!data.ok) throw new Error(data.error?.message || "lark-cli failed");
  return data.data;
}

async function fetchJson(url, { method = "GET", body = null, timeoutMs = 120000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json; charset=utf-8" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`fetch failed ${method} ${url}: ${error?.message || error}`);
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 240)}`);
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error?.code || `HTTP ${response.status} ${url}`);
  }
  if (data?.ok === false) {
    throw new Error(data?.error?.message || data?.error?.code || `request failed ${url}`);
  }
  return data;
}

function readFeishuRows(count, offset = 0) {
  const data = lark([
    "base", "+record-list",
    "--base-token", FEISHU_BASE_TOKEN,
    "--table-id", FEISHU_TABLE_ID,
    "--view-id", FEISHU_VIEW_ID,
    "--limit", String(count + offset),
    "--as", "user",
    "--format", "json",
  ]);
  return readFirstRowsFromRecordList(data, count, { offset });
}

function downloadRowImages(row, alias) {
  const dir = join(IMG_ROOT, row.sku || alias);
  mkdirSync(dir, { recursive: true });
  const local = [];
  for (const image of row.images) {
    const outName = `${image.field}-${image.name}`;
    const outPath = join(dir, outName);
    lark([
      "base", "+record-download-attachment",
      "--base-token", FEISHU_BASE_TOKEN,
      "--table-id", FEISHU_TABLE_ID,
      "--record-id", row.recordId,
      "--file-token", image.file_token,
      "--output", outName,
      "--overwrite",
      "--as", "user",
    ], dir);
    if (!existsSync(outPath)) throw new Error(`下载后缺失: ${outPath}`);
    const sha256 = createHash("sha256").update(readFileSync(outPath)).digest("hex");
    local.push({ ...image, localPath: outPath, outName, sha256 });
    log(`  ✓ ${alias} ${outName} sha=${sha256.slice(0, 12)}`);
  }
  return local;
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* sync gap between touches so album mtimes strictly increase */
  }
}

function adbPush(serial, localPath, phonePath) {
  sh(ADB, ["-s", serial, "push", localPath, phonePath], { timeout: 180000 });
  // adb push keeps the host file mtime; force phone mtime to "now" so push
  // order (not Feishu download order) controls album "最新在前".
  sh(ADB, ["-s", serial, "shell", "touch", phonePath], { timeout: 15000 });
  sh(ADB, [
    "-s", serial, "shell", "am", "broadcast",
    "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d", `file://${phonePath}`,
  ], { timeout: 30000 });
}

function pushImagesToPhone(alias, images) {
  const serial = SERIALS[alias];
  if (!serial) throw new Error(`alias ${alias} 无 serial`);
  const album = xhsAlbumPath(alias);
  // Wipe prior pushes so leftover reverse-order files cannot win album sort.
  sh(ADB, ["-s", serial, "shell", "rm", "-rf", album], { timeout: 30000 });
  sh(ADB, ["-s", serial, "shell", "mkdir", "-p", album], { timeout: 30000 });
  // Reverse push: last file (四宫格) gets newest mtime → album "最新在前" 左上第一。
  // albumFileName still uses select index so 01=四宫格 for name-asc albums.
  const ordered = pushOrderImages(images);
  const pushed = [];
  for (const image of ordered) {
    const selectIndex = imageSelectIndex(image, images);
    const fileName = albumFileName(image, selectIndex);
    const phonePath = `${album}/${fileName}`;
    adbPush(serial, image.localPath, phonePath);
    sleepMs(500);
    pushed.push({ phonePath, sha256: image.sha256, field: image.field, fileName, selectIndex });
    log(`  → ${alias} ${phonePath} (select#${selectIndex + 1})`);
  }
  return pushed;
}

async function preflightAliases(aliases) {
  const [entryText, devices, health] = await Promise.all([
    fetch(`${REGISTRY}/agent-entry.md`).then((r) => r.text()),
    fetchJson(`${CONTROL}/control/v1/devices`),
    fetchJson(`${CONTROL}/control/v1/health`),
  ]);
  const byAlias = new Map((devices.devices || []).map((d) => [d.alias, d]));
  const problems = [];
  for (const alias of aliases) {
    const line = entryText.split(/\r?\n/).find((l) => l.startsWith(`- ${alias} `));
    if (!line || !/ready=yes/.test(line) || !/lease=free/.test(line) || /quarantined=yes/.test(line)) {
      problems.push(`${alias}: not ready/free`);
    }
    if (!byAlias.get(alias)?.deviceId) problems.push(`${alias}: missing deviceId`);
  }
  const actors = health?.policyMode?.pilotActors || [];
  const actor = ACTOR || (actors.length === 1 ? actors[0] : null);
  if (!actor) problems.push("need --actor");
  return {
    problems,
    actor,
    rows: aliases.map((alias) => ({ alias, deviceId: byAlias.get(alias)?.deviceId || null })),
  };
}

async function submitJob(row, alias, actor) {
  let title = String(row.title || "").trim();
  if (title.length > 20) {
    log(`  WARN alias=${alias} title ${title.length}>20, truncate to 20`);
    title = title.slice(0, 20);
  }
  const params = {
    title,
    body: row.body,
    tags: row.tags,
    imageCount: 6,
    ...(STAY ? { stayForAccept: true } : {}),
  };
  const body = {
    actorId: actor,
    capabilityId: DISCARD ? "xhs.publish.discard_editor" : "xhs.publish.edit_dry_run",
    params: DISCARD ? {} : params,
    canary: false,
    placement: { alias },
    idempotencyKey: `xhs-feishu-${alias}-${TS}-${randomUUID().slice(0, 8)}`,
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const submission = await fetchJson(`${CONTROL}/control/v1/jobs`, {
        method: "POST",
        body,
        timeoutMs: 120000,
      });
      if (!submission?.job?.jobId) throw new Error("submit missing jobId");
      return submission.job;
    } catch (error) {
      lastErr = error;
      log(`  WARN submit ${alias} attempt=${attempt}: ${String(error.message || error).slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error(`submit failed for ${alias}`);
}

async function pollJob(jobId, timeoutS = 300) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const payload = await fetchJson(`${CONTROL}/control/v1/jobs/${encodeURIComponent(jobId)}`);
    const job = payload.job || payload;
    if (["succeeded", "failed", "recovery_required", "cancelled", "denied"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timeout job ${jobId}`);
}

async function main() {
  if (DISCARD) {
    const pre = await preflightAliases(ALIASES);
    if (pre.problems.length) {
      for (const p of pre.problems) log(`PROBLEM=${p}`);
      process.exit(2);
    }
    for (const row of pre.rows) {
      const job = await submitJob({}, row.alias, pre.actor);
      const final = await pollJob(job.jobId, 120);
      log(`ALIAS=${row.alias} jobId=${job.jobId} status=${final.status}`);
    }
    process.exit(0);
  }

  const aliases = ALIASES;
  const feishuRows = readFeishuRows(aliases.length, ROW_OFFSET);
  if (feishuRows.length !== aliases.length) throw new Error("飞书行数与 alias 数不一致");

  const plan = aliases.map((alias, i) => ({
    alias,
    sku: feishuRows[i].sku,
    title: feishuRows[i].title,
    body: feishuRows[i].body,
    tags: feishuRows[i].tags,
    images: feishuRows[i].images.map((img) => img.name),
  }));

  const planPath = join(ROOT, "outbox", "work", `xhs-feishu-plan-${TS}.json`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify({ plan, feishuRows: plan }, null, 2)}\n`, "utf8");
  log(`XHS_FEISHU_PLAN=${planPath}`);
  for (const item of plan) {
    log(`PLAN alias=${item.alias} sku=${item.sku} title=${item.title}`);
  }

  if (DRY) {
    log("XHS_FEISHU=dry_run");
    process.exit(0);
  }

  const pre = await preflightAliases(aliases);
  if (pre.problems.length) {
    for (const p of pre.problems) log(`PROBLEM=${p}`);
    process.exit(2);
  }

  const prepared = [];
  for (let i = 0; i < aliases.length; i += 1) {
    const alias = aliases[i];
    const row = feishuRows[i];
    log(`\n== prep ${alias} SKU=${row.sku} ==`);
    const locals = downloadRowImages(row, alias);
    if (SKIP_PUSH) {
      log(`  skip-push ${alias} (reuse /sdcard/Pictures/XhsPublish${Number(alias)}/)`);
    } else {
      pushImagesToPhone(alias, locals);
    }
    prepared.push({ alias, row });
  }

  const jobs = [];
  for (const item of prepared) {
    const job = await submitJob(item.row, item.alias, pre.actor);
    log(`SUBMIT alias=${item.alias} jobId=${job.jobId}`);
    jobs.push({ alias: item.alias, jobId: job.jobId, sku: item.row.sku });
  }

  let ok = 0;
  for (const entry of jobs) {
    const final = await pollJob(entry.jobId, 360);
    const step = final.result?.output?.step || final.errorCode || "";
    const titleLanded = final.result?.output?.titleLanded;
    const bodyLanded = final.result?.output?.bodyLanded;
    log(`RESULT alias=${entry.alias} jobId=${entry.jobId} status=${final.status} step=${step} titleLanded=${titleLanded} bodyLanded=${bodyLanded}`);
    if (final.status === "succeeded") ok += 1;
  }
  log(`XHS_FEISHU=${ok === jobs.length ? "ok" : "partial"} ok=${ok}/${jobs.length}`);
  process.exit(ok === jobs.length ? 0 : 1);
}

main().catch((error) => {
  log(`XHS_FEISHU=error`);
  log(`REASON=${String(error.message || error).slice(0, 400)}`);
  process.exit(4);
});
