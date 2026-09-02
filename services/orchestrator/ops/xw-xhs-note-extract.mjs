#!/usr/bin/env node
/**
 * xw-xhs-note-extract.mjs — offline semantic extraction of an XHS note record
 * from already-captured recipe-run evidence. Read-only: stdout JSON only, no
 * files written, no device I/O.
 *
 *   node ops/xw-xhs-note-extract.mjs --control http://127.0.0.1:17921 --run rr_xxx
 *     # joins the CP recipe run, reads its dump step artifact from disk
 *   node ops/xw-xhs-note-extract.mjs --dump-file <path/to/dump-ui.xml>
 *   node ops/xw-xhs-note-extract.mjs --scan <runs-root>
 *     # newest dump under runs/<runId>/dump-ui.xml that looks like a note detail
 *
 * Exit 0 = record (or scan hit) on stdout; exit 4 = JSON {ok:false,error}.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  extractNoteRecord,
  looksLikeNoteDetail,
} from "../scripts/lib/xhs-note-extract.mjs";

const DEFAULT_CONTROL = process.env.XHS_CONTROL_URL || "http://127.0.0.1:17920";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] != null && !String(argv[i + 1]).startsWith("-")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(code, message, details = {}) {
  console.log(JSON.stringify({ ok: false, error: { code, message, ...details } }, null, 2));
  process.exit(4);
}

async function fetchRecipeRun(control, recipeRunId) {
  const res = await fetch(`${control.replace(/\/$/, "")}/control/v1/recipe-runs/${encodeURIComponent(recipeRunId)}`, {
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`control response not JSON: ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(payload?.error?.message || `HTTP ${res.status}`);
  }
  return payload.recipeRun || payload;
}

async function fetchJob(control, jobId) {
  const res = await fetch(`${control.replace(/\/$/, "")}/control/v1/jobs/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`control response not JSON: ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(payload?.error?.message || `HTTP ${res.status}`);
  }
  return payload.job || payload;
}

/**
 * Resolve the note-detail dump XML bytes for a recipe run.
 * Priority: explicit dump steps (dump_detail — artifact lives on the primitive
 * job record, not the run's assertion observations) > observation dumps.
 * Observation dumps of tail steps (return_feed) hold the restored feed, which
 * is never the target.
 */
async function resolveDumpForRun(run, control, runsRoot) {
  const steps = Array.isArray(run.stepResults) ? run.stepResults.slice().reverse() : [];
  const explicit = steps.filter((s) => s.kind === "dump" && s.result?.jobId);
  const observed = steps.filter((s) => s.afterObservation?.rawDump?.path ?? s.afterObservation?.rawDump?.bytes);
  if (explicit.length === 0 && observed.length === 0) {
    return { error: "NO_DUMP_STEP", message: "recipe run has no dump-carrying step" };
  }

  // 1. Explicit dump steps: join the primitive job record for its artifact.
  for (const step of explicit) {
    const candidate = { jobId: step.result.jobId, kind: "dump-step", stepId: step.stepId };
    let job = null;
    try {
      job = await fetchJob(control, step.result.jobId);
    } catch (e) {
      candidate.jobError = e.message;
    }
    const out = job?.result?.output || {};
    if (typeof out.path === "string" && out.path && existsSync(out.path)) {
      return { xml: readFileSync(out.path, "utf8"), path: out.path, ...candidate };
    }
    if (runsRoot && job?.runId) {
      const fallback = join(String(runsRoot), String(job.runId), "dump-ui.xml");
      if (existsSync(fallback)) {
        return { xml: readFileSync(fallback, "utf8"), path: fallback, ...candidate };
      }
    }
  }
  // 2. Observation dumps carried on stepResults.
  for (const step of observed) {
    const raw = step.afterObservation.rawDump || {};
    if (typeof raw.path === "string" && raw.path && existsSync(raw.path)) {
      return { xml: readFileSync(raw.path, "utf8"), path: raw.path, kind: "observation", stepId: step.stepId };
    }
  }
  return {
    error: "DUMP_ARTIFACT_MISSING",
    message: "dump step found but its artifact is not on disk (pass --runs-root or read from the CP host)",
  };
}

/** Newest note-detail-looking dump under a runs root. */
function scanRunsRoot(runsRoot) {
  const root = String(runsRoot);
  if (!existsSync(root)) fail("SCAN_ROOT_MISSING", `runs root not found: ${root}`);
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === "dump-ui.xml") hits.push(p);
    }
  };
  walk(root, 0);
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const p of hits) {
    let xml = "";
    try {
      xml = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (looksLikeNoteDetail(xml)) return { xml, path: p };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || Object.keys(args).length <= 1) {
    console.log(
      `用法:
  node ops/xw-xhs-note-extract.mjs --control <url> --run <recipeRunId> [--runs-root <dir>]
  node ops/xw-xhs-note-extract.mjs --dump-file <dump-ui.xml>
  node ops/xw-xhs-note-extract.mjs --scan <runs-root>
stdout JSON only (xhs.note.record.v1); 不写文件、不碰设备。`,
    );
    process.exit(args.help ? 0 : 4);
  }

  let xml = "";
  let sourcePath = null;
  let runMeta = null;

  if (args["dump-file"]) {
    const p = String(args["dump-file"]);
    if (!existsSync(p)) fail("DUMP_FILE_MISSING", `dump file not found: ${p}`);
    xml = readFileSync(p, "utf8");
    sourcePath = p;
  } else if (args.scan) {
    const hit = scanRunsRoot(args.scan);
    if (!hit) fail("NO_NOTE_DETAIL_DUMP", "no note-detail-looking dump under the runs root", { runsRoot: String(args.scan) });
    xml = hit.xml;
    sourcePath = hit.path;
  } else if (args.run) {
    const control = String(args.control || DEFAULT_CONTROL);
    let run;
    try {
      run = await fetchRecipeRun(control, String(args.run));
    } catch (e) {
      fail("RECIPE_RUN_FETCH_FAILED", e.message, { control, recipeRunId: String(args.run) });
    }
    const resolved = await resolveDumpForRun(run, control, args["runs-root"]);
    if (resolved.error) {
      fail(resolved.error, resolved.message, {
        recipeRunId: run.recipeRunId,
        recipeId: run.recipeId,
        status: run.status,
        ...(args["runs-root"] ? { runsRoot: String(args["runs-root"]) } : {}),
      });
    }
    xml = resolved.xml;
    sourcePath = resolved.path;
    runMeta = { alias: run.alias, recipeRunId: run.recipeRunId, recipeId: run.recipeId };
  } else {
    fail("MODE_REQUIRED", "pass --run (+--control), --dump-file, or --scan");
  }

  const record = extractNoteRecord(xml);
  const out = { ok: true, ...record };
  if (runMeta) {
    out.alias = runMeta.alias;
    out.recipeRunId = runMeta.recipeRunId;
    out.recipeId = runMeta.recipeId;
  }
  out.sourceDumpPath = sourcePath;
  console.log(JSON.stringify(out, null, 2));
}

main();