#!/usr/bin/env node
/**
 * xw-evolve-replay-once.mjs — C4: one formal capability replay for a recipe revision.
 *
 * Flow (Windows local, no SSH):
 *   1. Load recipe spec from registry.db
 *   2. job submit via local routing devicectl (visible lease)
 *   3. poll to terminal
 *   4. POST /api/recipes/attempts with only ids (server verifies job)
 *   5. evaluatePromotion + optional overlay write
 *
 * Usage:
 *   node ops/xw-evolve-replay-once.mjs --recipe douyin.observe.search.wrap --revision 2 \
 *     --alias 01 --keyword 测试 --worker-window w1 --i-understand-live
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRecipeTables,
  getRecipe,
  evaluatePromotion,
  writeOverlayFromDb,
  DEFAULT_OVERLAY_PATH,
} from "../scripts/lib/recipe-catalog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const ROUTING = process.env.XHS_ROUTING_ROOT || "C:\\Users\\Public\\xhs-routing-v1-1";
const REGISTRY_URL = process.env.XHS_REGISTRY_URL || "http://127.0.0.1:17930";
const NODE24 = process.env.XHS_NODE_EXE || "D:\\Program Files\\Node\\node.exe";

function arg(name, fb = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fb;
}
function flag(name) {
  return process.argv.includes(name);
}

function fail(msg, code = 1) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function parseJson(stdout) {
  const s = String(stdout || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`no JSON in output: ${s.slice(0, 200)}`);
  return JSON.parse(s.slice(a, b + 1));
}

function loadToken() {
  const dumped = spawnSync("schtasks", ["/query", "/tn", "XhsDeviceRegistry", "/xml"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const xml = dumped.stdout || "";
  const m = xml.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  if (!m) return null;
  const args = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  for (const flagName of ["--human-token", "--agent-token", "--token"]) {
    const hit = args.match(new RegExp(`${flagName}\\s+([^\\s\"]+)`));
    if (hit) return hit[1];
  }
  return null;
}

async function resolveAliasDeviceId(alias) {
  const res = await fetch("http://127.0.0.1:17920/control/v1/devices");
  const body = await res.json();
  const dev = (body.devices || []).find((d) => d.alias === String(alias));
  if (!dev?.deviceId) throw new Error(`alias ${alias} not found`);
  return dev.deviceId;
}

function runDevicectl(argv) {
  const script = join(ROUTING, "control-plane", "devicectl.mjs");
  const r = spawnSync(NODE24, [script, ...argv], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    cwd: ROUTING,
  });
  if (r.status !== 0) {
    throw new Error(`devicectl failed: ${(r.stderr || r.stdout || "").slice(0, 500)}`);
  }
  return parseJson(r.stdout);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!flag("--i-understand-live")) {
    fail("refusing: pass --i-understand-live to submit a real job");
  }
  const recipeId = arg("--recipe");
  const revision = Number(arg("--revision", "0"));
  const alias = arg("--alias", "01");
  const keyword = arg("--keyword", "测试");
  const workerWindowId = arg("--worker-window", `ww-${Date.now()}`);
  const actor = arg("--actor", "evolve-replay-c4");
  const dbPath = resolve(arg("--db", join(ROOT, "registry.db")));
  const writeOverlay = !flag("--no-write-overlay");

  if (!recipeId || !Number.isInteger(revision) || revision < 1) {
    fail("--recipe and --revision required");
  }

  const db = new DatabaseSync(dbPath);
  ensureRecipeTables(db);
  let recipe;
  try {
    recipe = getRecipe(db, recipeId);
  } catch (e) {
    fail(e.message);
  }
  const version = recipe.versions.find((v) => Number(v.revision) === revision);
  if (!version) fail(`revision not found: ${recipeId}@${revision}`);
  const spec = version.spec || {};
  const capabilityId = spec.executor?.capabilityId;
  if (!capabilityId) fail("recipe executor.capabilityId missing");

  const paramsTemplate = spec.executor?.paramsTemplate || {};
  const params = { ...paramsTemplate };
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.includes("{{keyword}}")) {
      params[k] = v.replaceAll("{{keyword}}", keyword);
    }
  }
  // If template empty but search capability, still pass keyword.
  if (capabilityId.includes("search") && params.keyword == null) params.keyword = keyword;

  const deviceId = await resolveAliasDeviceId(alias);
  const key = `evolve-${recipeId.replace(/[^a-z0-9]+/gi, "")}-r${revision}-${Date.now()}`;

  console.log(JSON.stringify({
    phase: "submit",
    recipeId,
    revision,
    capabilityId,
    alias,
    deviceId,
    workerWindowId,
    params,
  }));

  const submitted = runDevicectl([
    "job", "submit",
    "--capability", capabilityId,
    "--device", deviceId,
    "--actor", actor,
    "--idempotency-key", key,
    "--params", JSON.stringify(params),
  ]);
  const jobId = submitted.job?.jobId;
  const runId = submitted.job?.runId;
  if (!jobId || !runId) fail(`submit missing ids: ${JSON.stringify(submitted).slice(0, 300)}`);

  let job = submitted.job;
  const terminal = new Set(["succeeded", "failed", "ambiguous", "recovery_required", "cancelled", "denied"]);
  for (let i = 0; i < 120; i++) {
    if (terminal.has(job.status)) break;
    await sleep(2000);
    const st = runDevicectl(["job", "status", "--job", jobId]);
    job = st.job || st;
  }

  console.log(JSON.stringify({
    phase: "terminal",
    jobId,
    runId,
    status: job.status,
    errorCode: job.errorCode || null,
  }));

  if (job.status !== "succeeded") {
    fail(`job did not succeed: ${job.status} ${job.errorCode || ""}`, 2);
  }

  const token = loadToken();
  if (!token) fail("unable to load registry token from task XML");
  const attemptUrl = `${REGISTRY_URL}/api/recipes/attempts?token=${encodeURIComponent(token)}`;
  const attemptRes = await fetch(attemptUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipeId,
      revision,
      jobId,
      runId,
      workerWindowId,
    }),
  });
  const attemptBody = await attemptRes.json();
  if (!attemptRes.ok || !attemptBody.ok) {
    fail(`attempt record failed: ${JSON.stringify(attemptBody).slice(0, 400)}`, 3);
  }

  const evaluation = evaluatePromotion(db, recipeId, revision);
  let overlay = null;
  if (writeOverlay) {
    overlay = writeOverlayFromDb(db, { path: DEFAULT_OVERLAY_PATH });
  }

  console.log(JSON.stringify({
    ok: true,
    recipeId,
    revision,
    jobId,
    runId,
    workerWindowId,
    attempt: attemptBody.attempt,
    receiptHash: attemptBody.receipt?.receiptHash || null,
    evaluation,
    overlay: overlay ? { recipeCount: overlay.recipeCount, sha256: overlay.sha256 } : null,
  }, null, 2));

  db.close();
}

main().catch((e) => fail(String(e?.message || e)));
