#!/usr/bin/env node
/**
 * 青岛飞书表 → 闲鱼闲置默认链路（Windows 本机）
 *
 * 阶段：
 *   prepare  飞书取货 + 下图 → runtime/plans/...
 *   fill     推图 + full_dry_run(idle + leaveOnCompose) 停发闲置页目检（默认不真发）
 *   publish  人确认后真点「发布」→ 关托管弹层 → 写回「闲鱼已发布设备」
 *
 * 用法：
 *   node ops/feishu-to-xianyu-idle-publish.mjs --sku LHJK6MNT01 --actor <pilot> --dry-run
 *   node ops/feishu-to-xianyu-idle-publish.mjs --sku LHJK6MNT01 --actor <pilot> --phase fill
 *   node ops/feishu-to-xianyu-idle-publish.mjs --plan <dir> --phase publish --i-confirm-live-publish
 *
 * 退出码：0 全绿；1 部分失败；2 预检未过；4 参数/飞书错误
 */
import { execFileSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadDotenv, optionalEnv } from "../scripts/lib/load-dotenv.mjs";
import {
  QINGDAO_DEFAULTS,
  assembleIdleFixture,
  composeMatchesProduct,
  downloadQingdaoImages,
  fetchQingdaoProduct,
  findTuoguanClose,
  listPublishTargets,
  parseJsonBlob,
  sleep,
  stillCompose,
  stillTuoguanPromo,
  writePlanProduct,
} from "./feishu-to-xianyu-idle-lib.mjs";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
loadDotenv(ROOT);

const ROUTING = optionalEnv("XHS_ROUTING_ROOT", "C:\\Users\\Public\\xhs-routing-v1-1");
const DEVICTL = join(ROUTING, "control-plane", "devicectl.mjs");
const ADB = optionalEnv("ADB_PATH", "C:\\Program Files (x86)\\xiaowei_android\\tools\\adb.exe");
const CAP = "xianyu.publish.full_dry_run";
const ALBUM_DEFAULT = "XianyuIdle";
const CONTROL = (process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920").replace(/\/$/, "");

const argv = process.argv.slice(2);
const opt = (n, fb = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : fb;
};
const flag = (n) => argv.includes(n);
// Windows 本机编排默认 loopback；勿默认用 Tailscale XHS_REGISTRY_URL（需 token）
const REGISTRY = opt("--registry", "http://127.0.0.1:17930");

function usage() {
  return `feishu-to-xianyu-idle-publish — 青岛飞书 → 闲鱼闲置默认链路

必填：
  --sku <SKU>                 或 --plan <runtime/plans/...>
  --actor <pilot>             须在 pilotActors（可用 XHS_ACTOR）

阶段（--phase，默认 fill = prepare+fill）：
  prepare                     只读飞书+下图
  fill                        推图+闲置填表 leaveOnCompose（不真发）
  publish                     真点发布（必须 --i-confirm-live-publish）

选项：
  --aliases 01,02,03,04
  --stock 10 --freight 包邮 --album XianyuIdle
  --stagger-ms 8000 --timeout-s 1500
  --skip-push                 相册已有足够图则跳过推送
  --reuse-plan <dir>          同 --plan
  --dry-run                   等同 --phase prepare
  --skip-compose-check        发布前跳过 SKU 匹配校验（默认校验，防发错）
  --i-confirm-live-publish    真发闸门（仅 publish）
`;
}

if (flag("--help") || flag("-h")) {
  console.log(usage());
  process.exit(0);
}

const ACTOR = opt("--actor", optionalEnv("XHS_ACTOR", ""));
const SKU = opt("--sku");
const PLAN_ARG = opt("--plan", opt("--reuse-plan"));
const PHASE_RAW = flag("--dry-run") ? "prepare" : opt("--phase", "fill");
const ALIASES = String(opt("--aliases", "01,02,03,04"))
  .split(",")
  .map((s) => String(s).trim().padStart(2, "0"))
  .filter((s) => /^0[1-4]$/.test(s));
const STOCK = opt("--stock", "10");
const FREIGHT = opt("--freight", "包邮");
const ALBUM = opt("--album", ALBUM_DEFAULT);
const STAGGER_MS = Number(opt("--stagger-ms", "8000")) || 8000;
const TIMEOUT_MS = (Number(opt("--timeout-s", "1500")) || 1500) * 1000;
const SKIP_PUSH = flag("--skip-push");
const CONFIRM_LIVE = flag("--i-confirm-live-publish");
const SKIP_COMPOSE_CHECK = flag("--skip-compose-check");
const BASE = opt("--base-token", optionalEnv("FEISHU_QINGDAO_BASE_TOKEN", optionalEnv("FEISHU_BASE_TOKEN", "")));
const TABLE = opt("--table-id", optionalEnv("FEISHU_QINGDAO_TABLE_ID", QINGDAO_DEFAULTS.tableId));
const VIEW = opt("--view-id", optionalEnv("FEISHU_QINGDAO_VIEW_ID", QINGDAO_DEFAULTS.viewId));

if (!ACTOR) {
  console.log("need --actor or XHS_ACTOR");
  process.exit(4);
}
if (!SKU && !PLAN_ARG && PHASE_RAW !== "publish") {
  console.log("need --sku or --plan");
  process.exit(4);
}
if (!ALIASES.length) {
  console.log("need --aliases");
  process.exit(4);
}
if (!BASE) {
  console.log("need FEISHU_QINGDAO_BASE_TOKEN or FEISHU_BASE_TOKEN in .env");
  process.exit(4);
}

function log(m) {
  console.log(m);
}

function sleepAsync(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, { method = "GET", body = null, timeoutMs = 60000 } = {}) {
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

function loadSerials() {
  const seedPath = join(ROOT, "identities.seed.json");
  if (!existsSync(seedPath)) throw new Error("missing identities.seed.json");
  return Object.fromEntries(
    JSON.parse(readFileSync(seedPath, "utf8")).identities.map((item) => [item.alias, item.serial]),
  );
}

async function adb(serial, args, timeout = 180000) {
  const r = await execFileAsync(ADB, ["-s", serial, ...args], {
    encoding: "utf8",
    env: { ...process.env, ANDROID_ADB_SERVER_PORT: "5038" },
    timeout,
    maxBuffer: 32 << 20,
    windowsHide: true,
  });
  return r.stdout;
}

function runNode(args, { cwd = ROOT, timeout = 120000 } = {}) {
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    cwd,
    timeout,
    maxBuffer: 32 << 20,
    windowsHide: true,
  });
}

function agentEntry() {
  const out = execFileSync("curl.exe", ["-s", `${REGISTRY.replace(/\/$/, "")}/api/agent-entry`], {
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(out);
}

function waitFleetIdle({ timeoutMs = 120000, label = "fleet-idle" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const leasesRaw = execFileSync("curl.exe", ["-s", "http://127.0.0.1:17920/control/v1/leases"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const leases = JSON.parse(leasesRaw).leases || [];
      if (!leases.length) {
        log(`[${label}] leases=0`);
        return true;
      }
      log(`[${label}] waiting leases=${leases.length} ...`);
    } catch {
      /* retry */
    }
    sleep(5000);
  }
  return false;
}

function preflight(serials) {
  const problems = [];
  const ae = agentEntry();
  const devicesList = execFileSync(ADB, ["devices"], {
    encoding: "utf8",
    env: { ...process.env, ANDROID_ADB_SERVER_PORT: "5038" },
    windowsHide: true,
  });
  for (const alias of ALIASES) {
    const serial = serials[alias];
    if (!serial) problems.push(`${alias}: no serial in identities.seed.json`);
    else if (!devicesList.split(/\r?\n/).some((l) => l.startsWith(`${serial}\tdevice`))) {
      problems.push(`${alias}: missing on ADB 5038`);
    }
    const d = (ae.devices || []).find((x) => x.alias === alias);
    if (!d?.state?.ready) problems.push(`${alias}: not ready`);
    if (d?.state?.hasUnresolvedFailure) problems.push(`${alias}: unresolvedFailure`);
    if (d?.state?.leaseFree === false) problems.push(`${alias}: lease busy`);
  }
  return { problems, ae };
}

async function ensureAlbum(alias, serial, locals, outDir) {
  const phoneDir = `/sdcard/Pictures/${ALBUM}`;
  let count = 0;
  try {
    const ls = await adb(serial, ["shell", `ls -1 ${phoneDir} 2>/dev/null || true`], 30000);
    count = ls.split(/\r?\n/).filter((l) => /\.jpe?g$/i.test(l.trim())).length;
  } catch {
    count = 0;
  }
  const need = locals.length;
  const frontName = locals[0]?.name || "01.jpg";
  if (SKIP_PUSH && count >= need) {
    log(`[${alias}] album reuse count=${count}`);
  } else {
    log(`[${alias}] push album (${count}→${need}) ${phoneDir} (front=${frontName} newest)`);
    await adb(serial, ["shell", "rm", "-rf", phoneDir], 60000);
    await adb(serial, ["shell", "mkdir", "-p", phoneDir], 30000);
    // 相册「最新在前」：倒序推，且每张 touch 后错开 ≥1.2s，避免 01/02 同秒 mtime
    // 导致部分机（实证 01/03）把反面选成首图。最后再强制 touch 正面。
    for (const item of [...locals].reverse()) {
      const phonePath = `${phoneDir}/${item.name}`;
      await adb(serial, ["push", item.localPath, phonePath], 180000);
      await adb(serial, ["shell", "touch", phonePath], 15000);
      await adb(
        serial,
        ["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${phonePath}`],
        30000,
      );
      await sleepAsync(1200);
    }
    const frontPath = `${phoneDir}/${frontName}`;
    await sleepAsync(800);
    await adb(serial, ["shell", "touch", frontPath], 15000);
    await adb(
      serial,
      ["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${frontPath}`],
      30000,
    );
    await sleepAsync(500);
    const ls2 = await adb(serial, ["shell", "ls", "-1", phoneDir], 30000);
    count = ls2.split(/\r?\n/).filter((l) => /\.jpe?g$/i.test(l.trim())).length;
    if (count < need) throw new Error(`${alias} push incomplete count=${count} need=${need}`);
    try {
      const lt = await adb(serial, ["shell", `ls -lt ${phoneDir} | head -n 3`], 15000);
      log(`[${alias}] newest3:\n${lt.trim()}`);
    } catch {
      /* soft */
    }
  }
  const images = locals.map((item) => ({
    phonePath: `${phoneDir}/${item.name}`,
    sha256: item.sha256,
    name: item.name,
  }));
  writeFileSync(join(outDir, `pushed-${alias}.json`), JSON.stringify({ album: ALBUM, count, images }, null, 2));
  return images;
}

function submitJob(alias, params, outDir) {
  const key = `xy-idle-${alias}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  writeFileSync(join(outDir, `fixture-${alias}.json`), JSON.stringify(params, null, 2));
  const out = runNode(
    [
      DEVICTL,
      "--local",
      "job",
      "submit",
      "--actor",
      ACTOR,
      "--capability",
      CAP,
      "--alias",
      alias,
      "--idempotency-key",
      key,
      "--params",
      JSON.stringify(params),
    ],
    { cwd: ROUTING, timeout: 120000 },
  );
  const wrap = parseJsonBlob(out);
  const job = wrap.job || wrap;
  const jobId = job.jobId || job.id;
  if (!jobId) throw new Error(`${alias} submit no jobId`);
  writeFileSync(join(outDir, `submit-${alias}.json`), JSON.stringify(wrap, null, 2));
  return { alias, jobId, key };
}

async function waitJobs(jobs, outDir) {
  const terminal = new Set(["succeeded", "failed", "cancelled", "expired", "ambiguous"]);
  const deadline = Date.now() + TIMEOUT_MS;
  const done = new Set();
  const results = [];
  while (done.size < jobs.length && Date.now() < deadline) {
    for (const row of jobs) {
      if (done.has(row.alias)) continue;
      let stJob;
      try {
        const payload = await fetchJson(`${CONTROL}/control/v1/jobs/${encodeURIComponent(row.jobId)}`);
        stJob = payload.job || payload;
      } catch (e) {
        log(`status ${row.alias}=? (${String(e.message || e).slice(0, 120)})`);
        continue;
      }
      writeFileSync(join(outDir, `status-${row.alias}.json`), JSON.stringify(stJob, null, 2));
      log(
        `status ${row.alias}=${stJob.status} step=${stJob.result?.output?.step || ""} leave=${stJob.result?.output?.leaveOnCompose || ""}`,
      );
      if (terminal.has(stJob.status)) {
        done.add(row.alias);
        results.push({
          alias: row.alias,
          jobId: row.jobId,
          status: stJob.status,
          errorCode: stJob.errorCode || null,
          leaveOnCompose: stJob.result?.output?.leaveOnCompose === true,
          step: stJob.result?.output?.step || null,
        });
      }
    }
    if (done.size < jobs.length) await sleepAsync(10000);
  }
  for (const row of jobs) {
    if (!done.has(row.alias)) results.push({ alias: row.alias, jobId: row.jobId, status: "timeout" });
  }
  return results;
}

function sessionFile(alias, tag) {
  return join(process.env.USERPROFILE || "", ".xhs-explorer-sessions", `xy-idle-${tag}-${alias}.json`);
}

function exploreOp(alias, tag, script, extra = []) {
  return runNode([join(ROOT, "ops", script), "--alias", alias, "--session-file", sessionFile(alias, tag), ...extra]);
}

function acquireExplore(alias, tag) {
  const sf = sessionFile(alias, tag);
  if (existsSync(sf)) {
    try {
      runNode([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf]);
    } catch {
      /* ignore */
    }
  }
  return runNode([
    join(ROOT, "ops", "xw-explore-session.mjs"),
    "acquire",
    "--alias",
    alias,
    "--actor",
    ACTOR,
    "--session-file",
    sf,
  ]);
}

function releaseExplore(alias, tag) {
  const sf = sessionFile(alias, tag);
  if (!existsSync(sf)) return;
  try {
    runNode([join(ROOT, "ops", "xw-explore-session.mjs"), "release", "--session-file", sf]);
  } catch (e) {
    log(`[${alias}] release warn: ${e.message}`);
  }
}

function dismissTuoguan(alias, tag, evidenceDir) {
  for (let pass = 0; pass < 3; pass += 1) {
    const dumpP = join(evidenceDir, `${alias}-tuoguan-${pass}.xml`);
    exploreOp(alias, tag, "dump-ui.mjs", ["--out", dumpP]);
    const xml = readFileSync(dumpP, "utf8");
    if (!stillTuoguanPromo(xml)) return { ok: true, pass };
    const t = findTuoguanClose(xml);
    if (!t) return { ok: false, reason: "no-target" };
    log(`[${alias}] dismiss ${t.kind} ${t.cx},${t.cy}`);
    exploreOp(alias, tag, "tap.mjs", ["--x", String(t.cx), "--y", String(t.cy)]);
    sleep(1500);
  }
  const dumpL = join(evidenceDir, `${alias}-tuoguan-final.xml`);
  exploreOp(alias, tag, "dump-ui.mjs", ["--out", dumpL]);
  return { ok: !stillTuoguanPromo(readFileSync(dumpL, "utf8")) };
}

function publishOne(alias, evidenceDir) {
  const tag = "publish";
  const row = { alias, ok: false, steps: [] };
  try {
    acquireExplore(alias, tag);
    const dump1 = join(evidenceDir, `${alias}-before.xml`);
    exploreOp(alias, tag, "dump-ui.mjs", ["--out", dump1]);
    const xml1 = readFileSync(dump1, "utf8");
    if (!SKIP_COMPOSE_CHECK) {
      const match = composeMatchesProduct(xml1, product);
      if (!match.ok) {
        row.error = `compose-mismatch (${match.reason})`;
        row.steps.push("compose-check:fail");
        return row;
      }
      row.steps.push("compose-check:ok");
    }
    const pub = listPublishTargets(xml1).find((t) => t.kind === "final-publish");
    if (!pub) {
      row.error = "publish-button-missing";
      return row;
    }
    log(`[${alias}] tap 发布 ${pub.cx},${pub.cy}`);
    exploreOp(alias, tag, "tap.mjs", ["--x", String(pub.cx), "--y", String(pub.cy)]);
    row.steps.push(`tap-publish:${pub.cx},${pub.cy}`);
    sleep(2500);
    for (let i = 0; i < 3; i += 1) {
      const dumpC = join(evidenceDir, `${alias}-after-${i}.xml`);
      exploreOp(alias, tag, "dump-ui.mjs", ["--out", dumpC]);
      const xmlC = readFileSync(dumpC, "utf8");
      const conf = listPublishTargets(xmlC).find((t) => t.kind === "confirm");
      if (conf) {
        exploreOp(alias, tag, "tap.mjs", ["--x", String(conf.cx), "--y", String(conf.cy)]);
        row.steps.push(`tap-confirm:${conf.blob}`);
        sleep(2000);
        continue;
      }
      row.ok = !stillCompose(xmlC) || /发布成功|已发布/.test(xmlC);
      break;
    }
    const dismiss = dismissTuoguan(alias, tag, evidenceDir);
    row.tuoguanDismissed = dismiss.ok;
    row.steps.push(dismiss.ok ? "tuoguan:cleared" : "tuoguan:left");
    try {
      exploreOp(alias, tag, "screenshot-and-analyze.mjs", ["--out", join(evidenceDir, `${alias}-after.png`)]);
    } catch {
      /* soft */
    }
  } catch (e) {
    row.error = String(e.message || e).slice(0, 400);
  } finally {
    releaseExplore(alias, tag);
  }
  return row;
}

function markPublished(sku, aliases, recordId) {
  const args = [join(ROOT, "ops", "feishu-mark-xianyu-published.mjs"), "--aliases", aliases.join(",")];
  if (recordId) args.push("--record-id", recordId);
  else args.push("--sku", sku);
  if (BASE) args.push("--base-token", BASE);
  if (TABLE) args.push("--table-id", TABLE);
  const out = runNode(args, { timeout: 60000 });
  log(out.trim().split(/\r?\n/).slice(-8).join("\n"));
  return out;
}

// ---------- phases ----------
let planDir = PLAN_ARG;
let product = null;

async function phasePrepare() {
  const outDir = planDir || join(ROOT, "runtime", "plans", `qingdao-idle-${Date.now()}`);
  mkdirSync(join(outDir, "imgs"), { recursive: true });
  log(`[prepare] sku=${SKU} → ${outDir}`);
  product = fetchQingdaoProduct(SKU, { baseToken: BASE, tableId: TABLE, viewId: VIEW });
  for (const w of product.softWarnings || []) log(`  soft: ${w}`);
  const locals = await downloadQingdaoImages(product, join(outDir, "imgs"));
  writePlanProduct(outDir, product, locals);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        sku: product.sku,
        recordId: product.recordId,
        aliases: ALIASES,
        album: ALBUM,
        stock: STOCK,
        freight: FREIGHT,
        actor: ACTOR,
        phase: "prepare",
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  planDir = outDir;
  log(`[prepare] ok imgs=${locals.length} record=${product.recordId}`);
  return outDir;
}

async function phaseFill(outDir) {
  const serials = loadSerials();
  const pre = preflight(serials);
  if (pre.problems.length) {
    for (const p of pre.problems) log(`✗ ${p}`);
    process.exit(2);
  }
  const productPath = join(outDir, "product.json");
  product = JSON.parse(readFileSync(productPath, "utf8"));
  if (!product.locals?.length) throw new Error("plan missing locals — run prepare first");
  log(`[fill] sku=${product.sku} aliases=${ALIASES.join(",")}`);
  // 跨设备并行推图（ADB 按 serial 独立，不碰效卫 22222 传输锁；每台内部 mtime 错开不变）。
  const imagesByAlias = {};
  await Promise.all(
    ALIASES.map(async (alias) => {
      imagesByAlias[alias] = await ensureAlbum(alias, serials[alias], product.locals, outDir);
    }),
  );
  const jobs = [];
  for (const alias of ALIASES) {
    const params = assembleIdleFixture(product, imagesByAlias[alias], {
      stock: STOCK,
      freight: FREIGHT,
      album: ALBUM,
      leaveOnCompose: true,
    });
    log(`submit ${alias}`);
    jobs.push(submitJob(alias, params, outDir));
    if (alias !== ALIASES[ALIASES.length - 1]) sleep(STAGGER_MS);
  }
  writeFileSync(join(outDir, "jobs.json"), JSON.stringify({ out: outDir, mode: "idle-leave", jobs }, null, 2));
  const results = await waitJobs(jobs, outDir);
  writeFileSync(join(outDir, "fill-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        ...(existsSync(join(outDir, "manifest.json"))
          ? JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))
          : {}),
        phase: "fill-done",
        fillResults: results,
        next: `目检通过后: node ops/feishu-to-xianyu-idle-publish.mjs --plan "${outDir}" --phase publish --i-confirm-live-publish --actor ${ACTOR}`,
      },
      null,
      2,
    ),
  );
  log(JSON.stringify(results, null, 2));
  log(`NEXT: 目检后跑 publish --i-confirm-live-publish --plan ${outDir}`);
  return results.every((r) => r.status === "succeeded") ? 0 : 1;
}

function phasePublish(outDir) {
  if (!CONFIRM_LIVE) {
    console.log("refuse: live publish requires --i-confirm-live-publish");
    process.exit(4);
  }
  if (!waitFleetIdle({ label: "publish-pre" })) {
    console.log("refuse: fleet still has active leases after fill jobs");
    process.exit(2);
  }
  product = JSON.parse(readFileSync(join(outDir, "product.json"), "utf8"));
  const evidenceDir = join(outDir, "publish-live");
  mkdirSync(evidenceDir, { recursive: true });
  log(`[publish] LIVE sku=${product.sku} aliases=${ALIASES.join(",")}`);
  const results = [];
  for (const alias of ALIASES) {
    const row = publishOne(alias, evidenceDir);
    results.push(row);
    log(`[${alias}] ok=${row.ok} tuoguan=${row.tuoguanDismissed} err=${row.error || ""}`);
  }
  writeFileSync(join(evidenceDir, "results.json"), JSON.stringify(results, null, 2));
  const okAliases = results.filter((r) => r.ok).map((r) => r.alias);
  if (okAliases.length) {
    log(`[publish] mark Feishu 闲鱼已发布设备 ← ${okAliases.join(",")}`);
    try {
      markPublished(product.sku, okAliases, product.recordId);
    } catch (e) {
      log(`mark warn: ${e.message}`);
    }
  }
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        ...(existsSync(join(outDir, "manifest.json"))
          ? JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))
          : {}),
        phase: "publish-done",
        publishResults: results,
        markedAliases: okAliases,
      },
      null,
      2,
    ),
  );
  return results.every((r) => r.ok) ? 0 : 1;
}

// ---------- main ----------
(async () => {
  try {
    if (PHASE_RAW === "prepare") {
      await phasePrepare();
      process.exit(0);
    }
    if (PHASE_RAW === "fill") {
      if (!planDir) planDir = await phasePrepare();
      else if (SKU && !existsSync(join(planDir, "product.json"))) planDir = await phasePrepare();
      const code = await phaseFill(planDir);
      process.exit(code);
    }
    if (PHASE_RAW === "publish") {
      if (!planDir) {
        console.log("publish needs --plan <dir> from fill");
        process.exit(4);
      }
      process.exit(phasePublish(planDir));
    }
    console.log(`unknown --phase ${PHASE_RAW}`);
    process.exit(4);
  } catch (e) {
    console.log(`FATAL: ${e.message || e}`);
    process.exit(4);
  }
})();
