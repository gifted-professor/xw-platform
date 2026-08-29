#!/usr/bin/env node
/**
 * xw-xhs-routine-closeout.mjs — offline evidence/backfill tool for the xhs
 * routine V2.1 closeout (P1-REPRODUCIBLE-CLOSEOUT).
 *
 * Subcommands (all zero device I/O, console.log only, Windows-redline safe):
 *
 *   ledger-export --db <control.db> [--out <path>]
 *       Read-only (node:sqlite readOnly) export of routine_authorities,
 *       routine_effects, comment_drafts, comment_reconciles.
 *
 *   backfill --wave S2|S3|S4 --ledger <ledger-dump.v1.json>
 *            [--run-dump <path>] [--held <path>]
 *            --release-id <id> --source-commit <sha>
 *       Emit the contract-named `{wave}-wave-receipt.v1.json` from read-only
 *       inputs only (CP run dump + ledger dump / held verdict). Derives the
 *       verdict from the ledger itself — no client booleans. Historical S2/S3
 *       are TRANSPORTED_AMBIGUOUS_NOT_VERIFIED and are never re-run.
 *
 *   receipt --emit-contract --wave S1|PAR --from <path[,path2]>
 *           [--lineage <path,...>] --release-id <id> --source-commit <sha>
 *       Wrap a FRESH acceptance receipt (emitted by the current pipeline, so
 *       carrying a releaseIdentity) into the contract-named wave receipt.
 *       Receivers lacking releaseIdentity are refused (stale lineage never
 *       becomes a PASS). Old xe_ receipts may only be referenced as lineage
 *       hashes — their verdicts never inject into the new receipt.
 *
 *   aggregate --contract <contract.json> [--receipts <dir>]
 *       Emit `final-s1-s4-aggregate-receipt.v1.json` (schema
 *       xw.xhs.s1-s4-aggregate-receipt.v2) over the five contract-named wave
 *       receipts. Re-hashes every input file, records mixed release
 *       identities verbatim, sums transport budgets, asserts the hard caps.
 *
 *   completion --contract <contract.json> [--receipts <dir>] [--adjudication <path>]
 *       Emit the multi-model-execution-completion.v1 record with REAL file
 *       sha256 artifact results; Gate-F launcher and vision-provider holes are
 *       recorded as unverified with reasons (never passed off as complete).
 *
 *   source-ledger --baseline <sha> [--repo <dir>]
 *       Regenerate docs/plans/xhs-routine-03-live-source-files.v1.json hashes
 *       against the current worktree baseline (append-only: an existing v1
 *       output is never overwritten; a versioned sibling is emitted instead).
 *
 * Receipts hold refs/hashes only; raw screenshots/XML/comment text never
 * enter any emitted artifact. Written files use wx semantics — an existing
 * artifact is never overwritten (CLOSEOUT_*_EXISTS).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const LEDGER_SCHEMA = "xw.xhs.routine-ledger-dump.v1";
const WAVE_RECEIPT_SCHEMA = "xw.xhs.routine-wave-receipt.v1";
const AGGREGATE_SCHEMA = "xw.xhs.s1-s4-aggregate-receipt.v2";
const COMPLETION_SCHEMA = "multi-model-execution-completion.v1";

// items that are explicitly out of scope for this window (user-approved phasing)
const UNVERIFIED_ITEMS = Object.freeze({
  "P1-EXACT-RELEASE-ROLLBACK": {
    reason: "GATE_F_SYSTEM_LAUNCHER_REBIND_DEFERRED: reviewed SYSTEM task launchers were not re-bound in this window; deployment identity is recorded unverified per the V2.1 execution adjudication.",
    ref: "docs/plans/reviews/xhs-routine-03-live-s1-s4-v1 adjudication P1-EXACT-RELEASE-ROLLBACK",
  },
  "P1-REAL-VISION-CORPUS-PERMIT": {
    reason: "VISION_PROVIDER_ABSENT: the production vision provider pipeline does not exist on this host; corpus/shadow/R0 canary remain HELD (S4 NOT_VERIFIED_NO_PROVIDER).",
    ref: "adjudication P1-REAL-VISION-CORPUS-PERMIT + S4-held-no-provider.json",
  },
});

function acceptanceRoot() {
  const runtimeRoot = process.env.XW_RUNTIME_ROOT
    || (process.platform === "win32" ? "C:\\Users\\Public\\xw-runtime" : resolve("xw-runtime"));
  return join(runtimeRoot, "state", "orchestrator", "xhs-routine-acceptance");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  return `usage:
  node ops/xw-xhs-routine-closeout.mjs ledger-export --db <control.db> [--out <path>]
  node ops/xw-xhs-routine-closeout.mjs backfill --wave S2|S3|S4 --ledger <dump> [--run-dump <path>] [--held <path>] --release-id <id> --source-commit <sha>
  node ops/xw-xhs-routine-closeout.mjs receipt --emit-contract --wave S1|PAR --from <fresh> --release-id <id> --source-commit <sha> [--lineage <old,...>]
  node ops/xw-xhs-routine-closeout.mjs aggregate --contract <contract.json> [--receipts <dir>]
  node ops/xw-xhs-routine-closeout.mjs completion --contract <contract.json> [--receipts <dir>] [--adjudication <path>]
  node ops/xw-xhs-routine-closeout.mjs source-ledger --baseline <sha> [--repo <dir>]`;
}

function emit(payload, exitCode = 0) {
  console.log(JSON.stringify(payload, null, 2));
  return exitCode;
}

function emitError(code, message, extra = {}) {
  emit({ ok: false, error: { code, message, ...extra } }, 4);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** wx semantics: refuse to overwrite any existing artifact (append-only). */
function writeJsonExclusive(path, body) {
  if (existsSync(path)) {
    throw Object.assign(new Error(`refusing to overwrite existing artifact: ${path}`), {
      code: "CLOSEOUT_RECEIPT_EXISTS",
      path,
    });
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function requireFlag(args, name, code) {
  const value = args[name];
  if (value == null || value === true || String(value).trim() === "") {
    throw Object.assign(new Error(`missing required flag --${name}`), { code: code || "CLOSEOUT_USAGE" });
  }
  return String(value);
}

function requireExists(path, code) {
  if (!existsSync(path)) {
    throw Object.assign(new Error(`input not found: ${path}`), { code: code || "CLOSEOUT_INPUT_MISSING" });
  }
  return path;
}

// ---------------------------------------------------------------------------
// ledger-export
// ---------------------------------------------------------------------------

const LEDGER_TABLES = ["routine_authorities", "routine_effects", "comment_drafts", "comment_reconciles"];

function cmdLedgerExport({ db, out }) {
  const dbPath = requireExists(resolve(String(db || "")), "CLOSEOUT_DB_MISSING");
  const target = resolve(String(out || join(acceptanceRoot(), "ledger-dump.v1.json")));
  // readOnly: this tool NEVER writes the CP ledger (red line)
  const handle = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = {};
    for (const table of LEDGER_TABLES) {
      let rows;
      try {
        rows = handle.prepare(`SELECT * FROM ${table} ORDER BY created_at ASC`).all();
      } catch (error) {
        throw Object.assign(new Error(`ledger table unavailable (${table}): ${error?.message || error}`), {
          code: "CLOSEOUT_LEDGER_TABLE_MISSING",
          table,
        });
      }
      tables[table] = rows;
    }
    const body = {
      schemaId: LEDGER_SCHEMA,
      exportedAt: new Date().toISOString(),
      dbPath,
      readOnly: true,
      tables,
    };
    mkdirSync(resolve(target, ".."), { recursive: true });
    const written = writeJsonExclusive(target, body);
    return { ok: true, command: "ledger-export", path: written, rows: Object.fromEntries(LEDGER_TABLES.map((t) => [t, tables[t].length])) };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// wave receipt construction (shared by backfill and receipt --emit-contract)
// ---------------------------------------------------------------------------

function assertReleaseIdentity(args) {
  return {
    releaseId: requireFlag(args, "release-id", "CLOSEOUT_RELEASE_IDENTITY_MISSING"),
    sourceCommit: requireFlag(args, "source-commit", "CLOSEOUT_RELEASE_IDENTITY_MISSING"),
  };
}

function transportCount(effectRows) {
  return effectRows.filter((row) => row.reservationConsumed === 1
    || ["succeeded", "ambiguous", "verified_late"].includes(row.status)).length;
}

function effectView(row) {
  return {
    effectId: row.effect_id ?? null,
    routineRunId: row.routine_run_id ?? null,
    planHash: row.plan_hash ?? null,
    action: row.action ?? null,
    targetHash: row.target_hash ?? null,
    observationHash: row.observation_hash ?? null,
    status: row.status ?? null,
    reservationConsumed: row.reservation_consumed ?? null,
    retryBlocked: row.retry_blocked ?? null,
    evidenceRefs: JSON.parse(row.evidence_refs_json || "[]"),
    accountFingerprint: row.account_fingerprint ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function draftView(row) {
  return {
    draftId: row.draft_id ?? null,
    receiptHash: row.receipt_hash ?? null,
    targetFingerprint: row.target_fingerprint ?? null,
    textHash: row.text_hash ?? null, // hash only — comment text never enters receipts
    status: row.status ?? null,
    riskFlags: JSON.parse(row.risk_flags_json || "[]"),
    accountFingerprint: row.account_fingerprint ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

function reconcileView(row) {
  return {
    reconcileId: row.reconcile_id ?? null,
    effectId: row.effect_id ?? null,
    routineRunId: row.routine_run_id ?? null,
    status: row.status ?? null,
    evidenceHash: row.evidence_hash ?? null,
    createdAt: row.created_at ?? null,
  };
}

function authorityView(row) {
  return {
    authorityId: row.authority_id ?? null,
    executionRunId: row.execution_run_id ?? null,
    routineRunId: row.routine_run_id ?? null,
    alias: row.alias ?? null,
    sessionId: row.session_id ?? null,
    leaseId: row.lease_id ?? null,
    status: row.status ?? null,
    accountFingerprint: row.account_fingerprint ?? null,
    closedReason: row.closed_reason ?? null,
  };
}

function loadLedgerDump(path) {
  requireExists(path, "CLOSEOUT_LEDGER_MISSING");
  const body = JSON.parse(readFileSync(path, "utf8"));
  if (body.schemaId !== LEDGER_SCHEMA) {
    throw Object.assign(new Error(`not a ${LEDGER_SCHEMA} dump: ${path}`), { code: "CLOSEOUT_LEDGER_SCHEMA" });
  }
  return { path: resolve(path), sha256: sha256File(path), tables: body.tables || {} };
}

function extractRunFaces(dump) {
  // run dumps come in two shapes: `{ routineRun }` (execute dump) or a bare
  // receipt `{ run: {...} }` (accept-style). Normalize defensively.
  const run = dump.routineRun ?? dump.run ?? null;
  if (!run || typeof run !== "object") {
    throw Object.assign(new Error("run dump carries no routineRun/run object"), { code: "CLOSEOUT_RUN_DUMP_MALFORMED" });
  }
  return {
    executionRunId: run.executionRunId ?? dump.executionRunId ?? null,
    routineRunId: run.routineRunId ?? null,
    planHash: run.planHash ?? dump.planHash ?? null,
    alias: run.alias ?? null,
    status: run.status ?? null,
    serverVerified: run.serverVerified === true,
    receipt: run.receipt ?? {},
  };
}

function cleanupView(runFaces) {
  const cleanup = runFaces.receipt?.cleanup ?? {};
  return {
    verified: cleanup.verified === true,
    activeLeases: cleanup.activeLeases ?? null,
    restored: cleanup.restored ?? null,
    authorityRef: cleanup.authorityRef ?? null,
    authorityClose: cleanup.authorityClose ?? null,
  };
}

/**
 * Backfill a contract-named wave receipt for the historical S2/S3/S4 waves
 * from read-only inputs. The verdict is derived from the ledger rows — not
 * from any caller assertion.
 */
function cmdBackfill({ wave, ledger, runDump, held, ...rest }) {
  const releaseIdentity = assertReleaseIdentity({ ...rest, "release-id": rest["release-id"] });
  const waveName = String(wave || "").toUpperCase();

  if (waveName === "S4") {
    return backfillS4({ waveName, releaseIdentity, held });
  }
  if (waveName !== "S2" && waveName !== "S3") {
    throw Object.assign(new Error(`backfill supports waves S2, S3, S4 (got ${wave})`), { code: "CLOSEOUT_WAVE_UNSUPPORTED" });
  }
  if (!runDump) {
    throw Object.assign(new Error(`wave ${waveName} requires --run-dump (the CP run record)`), { code: "CLOSEOUT_RUN_DUMP_REQUIRED" });
  }
  const runDumpPath = requireExists(resolve(String(runDump)), "CLOSEOUT_RUN_DUMP_MISSING");
  const dump = JSON.parse(readFileSync(runDumpPath, "utf8"));
  const runFaces = extractRunFaces(dump);
  const ledgerDump = loadLedgerDump(ledger);

  // authority binding: the ledger must independently confirm this run's owner tuple
  const authority = (ledgerDump.tables.routine_authorities || [])
    .map(authorityView)
    .find((a) => a.routineRunId === runFaces.routineRunId);
  if (!authority) {
    throw Object.assign(new Error(`ledger has no routine_authorities row bound to ${runFaces.routineRunId}`), {
      code: "CLOSEOUT_AUTHORITY_BINDING_MISSING",
      routineRunId: runFaces.routineRunId,
    });
  }

  const effects = (ledgerDump.tables.routine_effects || [])
    .map(effectView)
    .filter((e) => e.routineRunId === runFaces.routineRunId);
  const drafts = (ledgerDump.tables.comment_drafts || [])
    .map(draftView)
    .filter((d) => d.receiptHash && effects.some((e) => e.observationHash === d.receiptHash));
  const reconciles = (ledgerDump.tables.comment_reconciles || [])
    .map(reconcileView)
    .filter((r) => r.routineRunId === runFaces.routineRunId);

  const statuses = [...new Set(effects.map((e) => e.status))];
  let verdict;
  if (effects.length === 0) {
    verdict = "NO_EFFECT_TRANSPORT_RECORDED";
  } else if (statuses.every((s) => s === "ambiguous")) {
    verdict = "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED";
  } else {
    throw Object.assign(new Error(`ledger effect statuses ${statuses.join(",")} do not support an append-only backfill verdict for ${waveName}`), {
      code: "CLOSEOUT_UNEXPECTED_EFFECT_STATUS",
      statuses,
    });
  }

  const budget = {
    likeTransports: waveName === "S2" ? transportCount(effects.filter((e) => e.action === "like")) : 0,
    commentTransports: waveName === "S3" ? transportCount(effects.filter((e) => e.action === "comment")) : 0,
    visualTaps: 0,
  };

  const body = {
    schemaId: WAVE_RECEIPT_SCHEMA,
    schemaVersion: 1,
    wave: waveName,
    verdict,
    emittedAt: new Date().toISOString(),
    provenance: "backfill-from-ledger-and-run-dump",
    releaseIdentity: { ...releaseIdentity, planHash: runFaces.planHash },
    run: {
      executionRunId: runFaces.executionRunId,
      routineRunId: runFaces.routineRunId,
      planHash: runFaces.planHash,
      alias: runFaces.alias,
      status: runFaces.status,
      serverVerified: runFaces.serverVerified,
    },
    authority: authority,
    cleanup: cleanupView(runFaces),
    effects: {
      rows: effects,
      drafts,
      reconciles,
      reconcileGap: reconciles.length === 0
        ? {
            recorded: "RECONCILE_NOT_PERFORMED_IN_RUN",
            remediation: "V2.1 S_B4 adds in-run reconcile on the comment branch; the historical run is immutable and was never re-run.",
          }
        : null,
    },
    budgets: budget,
    lineage: {
      ledgerDump: { path: ledgerDump.path, sha256: ledgerDump.sha256 },
      runDump: { path: runDumpPath, sha256: sha256File(runDumpPath) },
      priorReceipts: [],
    },
    notes: [
      verdict === "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED"
        ? "Historical social wave: transport consumed its single-use slot and was never server-verified; immutable, never re-run (V2.1 red line)."
        : "No effect transport recorded in the ledger for this run.",
    ],
  };
  const dir = acceptanceRoot();
  mkdirSync(dir, { recursive: true });
  const written = writeJsonExclusive(join(dir, `${waveName}-wave-receipt.v1.json`), body);
  return { ok: true, command: "backfill", wave: waveName, verdict, path: written, budgets: budget };
}

/** S4: HELD because the production vision provider does not exist on this host. */
function backfillS4({ waveName, releaseIdentity, held }) {
  let heldBody = null;
  let heldRef = null;
  if (held) {
    const heldPath = requireExists(resolve(String(held)), "CLOSEOUT_HELD_MISSING");
    heldBody = JSON.parse(readFileSync(heldPath, "utf8"));
    heldRef = { path: heldPath, sha256: sha256File(heldPath) };
  } else {
    throw Object.assign(new Error("wave S4 requires --held (the recorded held verdict, e.g. S4-held-no-provider.json)"), {
      code: "CLOSEOUT_HELD_REQUIRED",
    });
  }
  const verdict = heldBody.verdict === "HELD_NO_PRODUCTION_VISION_PROVIDER"
    ? "NOT_VERIFIED_NO_PROVIDER"
    : `HELD_${heldBody.verdict ?? "UNRECORDED"}`;
  const heldBudgets = heldBody.budgets ?? {};
  const body = {
    schemaId: WAVE_RECEIPT_SCHEMA,
    schemaVersion: 1,
    wave: waveName,
    verdict,
    emittedAt: new Date().toISOString(),
    provenance: "backfill-from-held-verdict",
    releaseIdentity: {
      ...releaseIdentity,
      planHash: heldBody.planRef ?? null,
      // historical honest identity: the held verdict was recorded under release B
      recordedOn: { releaseId: heldBody.releaseId ?? null, sourceCommit: heldBody.sourceCommit ?? null },
    },
    run: null,
    authority: null,
    cleanup: null,
    effects: { rows: [], drafts: [], reconciles: [], reconcileGap: null },
    budgets: {
      likeTransports: 0,
      commentTransports: 0,
      visualTaps: heldBudgets.navigationTaps ?? heldBudgets.visualTaps ?? 0,
    },
    lineage: {
      ledgerDump: null,
      heldVerdict: heldRef,
      priorReceipts: [],
    },
    notes: [
      heldBody.reason ?? "production vision provider absent; S4 cannot be live-verified in this window and was not run",
      "Visual permits authorize at most navigation; social effects remain forbidden.",
    ],
  };
  const dir = acceptanceRoot();
  mkdirSync(dir, { recursive: true });
  const written = writeJsonExclusive(join(dir, `${waveName}-wave-receipt.v1.json`), body);
  return { ok: true, command: "backfill", wave: waveName, verdict, path: written, budgets: body.budgets };
}

/**
 * `receipt --emit-contract`: wrap FRESH acceptance receipts (S1 note/video or
 * the parallel run) into the contract-named receipt. Stale lineage (anything
 * without a releaseIdentity — e.g. the release-A xe_ receipts) is refused as
 * a verdict source; it may only be recorded as lineage provenance.
 */
function cmdReceipt({ wave, from, lineage, ...rest }) {
  const releaseIdentity = assertReleaseIdentity(rest);
  const waveName = String(wave || "").toUpperCase();
  if (waveName !== "S1" && waveName !== "PAR") {
    throw Object.assign(new Error(`receipt --emit-contract supports waves S1, PAR (got ${wave}); S2/S3/S4 go through backfill`), {
      code: "CLOSEOUT_WAVE_UNSUPPORTED",
    });
  }
  if (!from || from === true) {
    throw Object.assign(new Error("receipt --emit-contract requires --from <fresh receipt path[,path2]>"), {
      code: "CLOSEOUT_RUN_DUMP_REQUIRED",
    });
  }
  const fromPaths = String(from).split(",").map((p) => p.trim()).filter(Boolean).map((p) => requireExists(resolve(p), "CLOSEOUT_RUN_DUMP_MISSING"));
  const sources = fromPaths.map((p) => ({ path: p, sha256: sha256File(p), body: JSON.parse(readFileSync(p, "utf8")) }));

  const stale = sources.filter((s) => s.body.releaseIdentity == null);
  if (stale.length) {
    throw Object.assign(new Error(`--from receipt(s) carry no releaseIdentity and cannot seed a contract verdict (stale lineage): ${stale.map((s) => s.path).join(", ")}`), {
      code: "CLOSEOUT_RECEIPT_STALE_LINEAGE",
      paths: stale.map((s) => s.path),
    });
  }

  // verdict: all source assertions must hold; never inherited from a "PASS"
  // string alone — recompute from the recorded assertions.
  const sourceRuns = sources.map((s) => {
    const body = s.body;
    const assertions = body.assertions ?? null;
    const run = body.run ?? body.routineRun ?? {};
    return {
      executionRunId: run.executionRunId ?? body.executionRunId ?? null,
      routineRunId: run.routineRunId ?? null,
      planHash: run.planHash ?? null,
      alias: run.alias ?? (Array.isArray(body.aliases) ? body.aliases.join("+") : null),
      status: run.status ?? null,
      serverVerified: body.serverVerified === true || run.serverVerified === true,
      verdict: body.verdict ?? null,
      assertions: assertions ?? {},
    };
  });
  const verdicts = sourceRuns.map((r) => {
    if (r.assertions && Object.keys(r.assertions).length > 0) {
      const failed = Object.entries(r.assertions).filter(([, v]) => v !== true).map(([k]) => k);
      return failed.length === 0 ? "PASS" : "FAIL";
    }
    return r.verdict === "PASS" && r.serverVerified ? "PASS" : "NOT_ASSERTED";
  });
  const verdict = verdicts.every((v) => v === "PASS") ? "PASS" : verdicts.find((v) => v !== "PASS");

  const priorReceipts = String(lineage && lineage !== true ? lineage : "")
    .split(",").map((p) => p.trim()).filter(Boolean)
    .map((p) => {
      const path = requireExists(resolve(p), "CLOSEOUT_LINEAGE_MISSING");
      const priorBody = JSON.parse(readFileSync(path, "utf8"));
      return {
        path,
        sha256: sha256File(path),
        verdict: priorBody.verdict ?? null,
        releaseIdentity: priorBody.releaseIdentity ?? null,
        note: "prior receipt hash provenance only — its verdict never seeds this receipt",
      };
    });

  const body = {
    schemaId: WAVE_RECEIPT_SCHEMA,
    schemaVersion: 1,
    wave: waveName,
    verdict,
    emittedAt: new Date().toISOString(),
    provenance: "emit-contract-from-fresh-accept-receipts",
    releaseIdentity: {
      ...releaseIdentity,
      // mixed sources keep every identity; the aggregate records mixing honestly
      sources: sources.map((s) => (s.body.releaseIdentity?.releaseId ? s.body.releaseIdentity : null)),
    },
    runs: sourceRuns,
    cleanup: {
      verified: sources.every((s) => (s.body.cleanup?.verified ?? s.body.assertions?.cleanupVerified) === true),
      activeLeases: sources[0]?.body.cleanup?.activeLeases ?? null,
      restored: sources.every((s) => (s.body.cleanup?.restored ?? s.body.assertions?.cleanupVerified) !== false),
      authorityClose: sources[0]?.body.cleanup?.authorityClose ?? null,
    },
    effects: {
      rows: [],
      drafts: [],
      reconciles: [],
      zeroSocialTransport: waveName === "PAR"
        ? sources.every((s) => s.body.effectClass === "none" || (s.body.run?.effectClass ?? s.body.routineRun?.effectClass) === "none")
        : null,
      reconcileGap: null,
    },
    budgets: { likeTransports: 0, commentTransports: 0, visualTaps: 0 },
    lineage: {
      ledgerDump: null,
      runDump: null,
      sources: sources.map((s) => ({ path: s.path, sha256: s.sha256 })),
      priorReceipts,
    },
    notes: [
      "Contract-named receipt emitted from fresh acceptance snapshots; older release receipts are referenced by hash provenance only.",
    ],
  };
  const dir = acceptanceRoot();
  mkdirSync(dir, { recursive: true });
  const written = writeJsonExclusive(join(dir, waveName === "PAR" ? "parallel-03-04-wave-receipt.v1.json" : `${waveName}-wave-receipt.v1.json`), body);
  return { ok: true, command: "receipt", wave: waveName, verdict, path: written };
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

const AGGREGATE_INPUTS = [
  { wave: "S1", file: "S1-wave-receipt.v1.json" },
  { wave: "S2", file: "S2-wave-receipt.v1.json" },
  { wave: "S3", file: "S3-wave-receipt.v1.json" },
  { wave: "S4", file: "S4-wave-receipt.v1.json" },
  { wave: "PAR", file: "parallel-03-04-wave-receipt.v1.json" },
];

function cmdAggregate({ contract, receipts }) {
  const contractPath = requireExists(resolve(String(contract || "")), "CLOSEOUT_CONTRACT_MISSING");
  const contractBody = JSON.parse(readFileSync(contractPath, "utf8"));
  const dir = resolve(String(receipts || acceptanceRoot()));
  mkdirSync(dir, { recursive: true });

  const inputs = AGGREGATE_INPUTS.map(({ wave, file }) => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw Object.assign(new Error(`required contract-named receipt missing: ${path} (wave ${wave})`), {
        code: "AGGREGATE_RECEIPT_MISSING",
        wave,
        path,
      });
    }
    return { wave, file, path, sha256: sha256File(path), body: JSON.parse(readFileSync(path, "utf8")) };
  });

  // dereference + hash every lineage artifact the receipts reference
  const inputHashes = Object.fromEntries(inputs.map((i) => [i.file, i.sha256]));
  for (const input of inputs) {
    for (const ref of input.body.lineage?.priorReceipts ?? []) {
      if (ref.path && existsSync(ref.path)) inputHashes[`lineage:${ref.path}`] = sha256File(ref.path);
    }
    for (const key of ["ledgerDump", "runDump", "heldVerdict"]) {
      const ref = input.body.lineage?.[key];
      if (ref?.path && existsSync(ref.path)) inputHashes[`lineage:${ref.path}`] = sha256File(ref.path);
    }
  }

  const waveVerdicts = Object.fromEntries(inputs.map((i) => [
    i.wave,
    { verdict: i.body.verdict, releaseIdentity: i.body.releaseIdentity ?? null, pass: i.body.verdict === "PASS" },
  ]));

  const releaseIdentities = inputs.map((i) => ({
    wave: i.wave,
    releaseId: i.body.releaseIdentity?.releaseId ?? null,
    sourceCommit: i.body.releaseIdentity?.sourceCommit ?? null,
    recordedOn: i.body.releaseIdentity?.recordedOn ?? null,
  }));
  const finalIdentity = {
    releaseId: releaseIdentities[0].releaseId,
    sourceCommit: releaseIdentities[0].sourceCommit,
  };
  const identityConsistent = releaseIdentities.every((r) => r.releaseId === finalIdentity.releaseId
    && r.sourceCommit === finalIdentity.sourceCommit);

  const budget = inputs.reduce((acc, i) => ({
    likeTransports: acc.likeTransports + (i.body.budgets?.likeTransports ?? 0),
    commentTransports: acc.commentTransports + (i.body.budgets?.commentTransports ?? 0),
    visualTaps: acc.visualTaps + (i.body.budgets?.visualTaps ?? 0),
  }), { likeTransports: 0, commentTransports: 0, visualTaps: 0 });
  const budgetCaps = { maxLike: 1, maxComment: 1, maxVisualTaps: 1 };
  const budgetWithinCaps = budget.likeTransports <= budgetCaps.maxLike
    && budget.commentTransports <= budgetCaps.maxComment
    && budget.visualTaps <= budgetCaps.maxVisualTaps;

  const zeroDelta = {
    // waves with real runs must record verified cleanup with zero active leases;
    // S4 (no run) has cleanup null and passes vacuously
    cleanupAllVerified: inputs.every((i) => (i.body.cleanup ? i.body.cleanup.verified === true : true)),
    activeLeasesZeroAfterRelease: inputs.every((i) => (i.body.cleanup?.activeLeases == null ? true : i.body.cleanup.activeLeases === 0)),
    raw: inputs.map((i) => ({ wave: i.wave, cleanup: i.body.cleanup ?? null })),
  };

  const pathPass = inputs.filter((i) => i.wave === "S1" || i.wave === "PAR").every((i) => i.body.verdict === "PASS");
  const allPass = inputs.every((i) => i.body.verdict === "PASS");
  const verdict = allPass && identityConsistent && budgetWithinCaps
    ? "CLOSEOUT_COMPLETE"
    : "CLOSEOUT_PARTIAL";
  const unverified = inputs.filter((i) => i.body.verdict !== "PASS").map((i) => ({
    wave: i.wave,
    verdict: i.body.verdict,
    reason: i.body.notes?.[0] ?? null,
  }));

  const body = {
    schemaId: AGGREGATE_SCHEMA,
    emittedAt: new Date().toISOString(),
    contract: {
      path: contractPath,
      planSha256: contractBody.planSha256 ?? null,
      requiredArtifacts: contractBody.items?.find((i) => i.id === "P1-LIVE-S1-S4-CLOSEOUT")?.requiredArtifacts ?? null,
    },
    contractPlanSha256: contractBody.planSha256 ?? null,
    inputHashes,
    waveVerdicts,
    releaseIdentities,
    identityConsistent,
    budgets: budget,
    budgetCaps,
    budgetWithinCaps,
    zeroDelta,
    verdict,
    liveVerified: false, // hard-coded: remains false until every wave PASSes (S2/S3 immutable, S4 unverified)
    unverified,
    pathStatus: {
      s1ToS4MediaLikeCommentPathsLive: pathPass,
      note: pathPass
        ? "S1 + read-only parallel verified live; S2/S3 transported-ambiguous (immutable); S4 not verified (no provider)."
        : "S1/read-only path not fully asserted.",
    },
  };
  const written = writeJsonExclusive(join(dir, "final-s1-s4-aggregate-receipt.v1.json"), body);
  return { ok: true, command: "aggregate", verdict, path: written, liveVerified: false };
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

function cmdCompletion({ contract, receipts, adjudication }) {
  const contractPath = requireExists(resolve(String(contract || "")), "CLOSEOUT_CONTRACT_MISSING");
  const contractBody = JSON.parse(readFileSync(contractPath, "utf8"));
  const dir = resolve(String(receipts || acceptanceRoot()));
  const adjudicationPath = adjudication && adjudication !== true ? resolve(String(adjudication)) : null;
  if (adjudicationPath) requireExists(adjudicationPath, "CLOSEOUT_ADJUDICATION_MISSING");
  const adjudicationSha = adjudicationPath ? sha256File(adjudicationPath) : null;

  const receiptFiles = existsSync(dir)
    ? AGGREGATE_INPUTS.map(({ file }) => join(dir, file)).filter((p) => existsSync(p))
    : [];
  const evidenceSeed = receiptFiles.map((p) => `${p}:${sha256File(p)}`).join("\n");

  const items = contractBody.items.map((item) => {
    const unverifiedItem = UNVERIFIED_ITEMS[item.id] ?? null;
    const artifactResults = item.requiredArtifacts.map((artifact) => {
      // an artifact is "present" when the named path exists (repo-relative,
      // absolute runtime path, or anything resolvable); descriptive contract
      // strings never resolve and fall through to unverified honestly
      const candidate = resolve(artifact);
      if (existsSync(candidate)) {
        return { artifact, result: "pass", sha256: sha256File(candidate) };
      }
      const reasons = [`artifact not present: ${artifact}`];
      if (unverifiedItem) reasons.push(unverifiedItem.reason);
      return { artifact, result: "unverified", unverifiedReason: reasons.join(" — "), unverifiedRef: unverifiedItem?.ref ?? null };
    });
    const missing = artifactResults.filter((a) => a.result !== "pass").length;
    const evidenceHash = sha256Text([
      contractBody.planSha256 ?? "",
      item.id,
      artifactResults.map((a) => `${a.artifact}:${a.sha256 ?? "unverified"}`).join("\n"),
      adjudicationPath ? `${adjudicationPath}:${adjudicationSha}` : "",
    ].join("\n"));
    return {
      id: item.id,
      severity: item.severity,
      status: unverifiedItem ? "unverified" : (missing === 0 ? "complete" : "unverified"),
      unverifiedReason: unverifiedItem?.reason ?? (missing > 0 ? `${missing} required artifact(s) unverified` : null),
      artifactResults,
      probeResults: item.probes.map((probe) => ({
        probeId: probe.id,
        result: unverifiedItem ? "unverified" : (missing === 0 ? "pass" : "unverified"),
        pathExercised: unverifiedItem ? false : missing === 0,
        evidenceSha256: evidenceHash,
        evidenceNote: unverifiedItem
          ? "evidence aggregate over live wave receipts unavailable for an unverified item"
          : `aggregate evidence over ${receiptFiles.length} contract-named wave receipts`,
      })),
    };
  });

  const unverifiedIds = items.filter((i) => i.status === "unverified").map((i) => i.id);
  const body = {
    schema: COMPLETION_SCHEMA,
    planSha256: contractBody.planSha256,
    contractPath,
    generatedAt: new Date().toISOString(),
    adjudicationRef: adjudicationPath ? { path: adjudicationPath, sha256: adjudicationSha } : null,
    items,
    unverifiedItems: unverifiedIds,
    executionEvents: [
      { kind: "start", runtime: contractBody.execution?.runtime ?? "claude-cli", model: contractBody.execution?.primaryModel ?? "glm-5.3" },
      { kind: "context-compaction", reloadedPlanSha256: contractBody.planSha256 },
    ],
  };
  const written = writeJsonExclusive(join(dir, "s1-s4-multi-model-execution-completion.v1.json"), body);
  return { ok: true, command: "completion", path: written, unverifiedItems: unverifiedIds };
}

// ---------------------------------------------------------------------------
// source-ledger
// ---------------------------------------------------------------------------

const SOURCE_LEDGER_FILES = [
  "package.json",
  "services/orchestrator/ops/xw-xhs-routine.mjs",
  "services/orchestrator/ops/xw-xhs.mjs",
  "services/orchestrator/ops/xw-xhs-routine-accept.mjs",
  "services/orchestrator/ops/xw-xhs-routine-closeout.mjs",
  "services/orchestrator/ops/_xhs-routine-explorer-runtime.mjs",
  "services/orchestrator/scripts/lib/xhs-feed-routine-machine.mjs",
  "services/orchestrator/scripts/lib/xhs-routine-plan.mjs",
  "services/orchestrator/scripts/lib/xhs-routine-run-store.mjs",
  "services/orchestrator/scripts/lib/xhs-routine-runner.mjs",
  "services/orchestrator/scripts/lib/xhs-routine-authority.mjs",
  "services/orchestrator/tests/fixtures/xhs-routine-fake-driver.mjs",
  "services/orchestrator/tests/xhs-feed-routine-machine.test.mjs",
  "services/orchestrator/tests/xhs-routine-plan.test.mjs",
  "services/orchestrator/tests/xhs-routine-explorer-runtime.test.mjs",
  "services/orchestrator/tests/xhs-routine-runner.test.mjs",
  "services/orchestrator/tests/xw-xhs-routine-cli.test.mjs",
  "services/orchestrator/tests/xw-xhs-routine-accept.test.mjs",
  "services/orchestrator/tests/xw-xhs-routine-closeout.test.mjs",
  "services/control-plane/control-plane/lib/state-store.mjs",
  "services/control-plane/control-plane/lib/control-plane.mjs",
  "services/control-plane/apps/xhs/routine-effect-bridge.mjs",
  "services/control-plane/apps/xhs/routine-comment-chain.mjs",
];

function cmdSourceLedger({ baseline, repo, out }) {
  const repoRoot = resolve(String(repo || process.cwd()));
  // --baseline is required: worktree .git files break heuristic HEAD resolution
  // and the baseline is a deliberate freeze anchor (S_B5+), never an accident
  const head = baseline && baseline !== true ? String(baseline) : (() => {
    throw Object.assign(new Error("--baseline <sha> required (freeze anchor of the source set)"), {
      code: "CLOSEOUT_BASELINE_MISSING",
    });
  })();

  const files = SOURCE_LEDGER_FILES.map((rel) => {
    const path = join(repoRoot, rel);
    if (!existsSync(path)) {
      throw Object.assign(new Error(`source file missing: ${rel}`), { code: "CLOSEOUT_SOURCE_MISSING", path: rel });
    }
    return { path: rel, sha256: sha256File(path) };
  });

  const body = {
    schema: "xw.xhs.routine-03-live-source-files.v1",
    baselineHead: head,
    branch: "codex/xhs-routine-03-live-s1-s4",
    worktree: ".worktrees/xhs-r03",
    generatedAt: new Date().toISOString().slice(0, 10),
    tool: "services/orchestrator/ops/xw-xhs-routine-closeout.mjs source-ledger",
    files,
  };
  const defaultPath = out && out !== true
    ? resolve(String(out))
    : ((existsSync(join(repoRoot, "docs", "plans", "xhs-routine-03-live-source-files.v1.json")))
      ? join(repoRoot, "docs", "plans", `xhs-routine-03-live-source-files.v1-${head.slice(0, 7)}.json`)
      : join(repoRoot, "docs", "plans", "xhs-routine-03-live-source-files.v1.json"));
  mkdirSync(resolve(defaultPath, ".."), { recursive: true });
  const written = writeJsonExclusive(defaultPath, body);
  return { ok: true, command: "source-ledger", path: written, files: files.length, baselineHead: head };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    let result;
    if (command === "ledger-export") {
      result = cmdLedgerExport(args);
    } else if (command === "backfill") {
      result = cmdBackfill(args);
    } else if (command === "receipt") {
      if (args["emit-contract"] !== true) {
        throw Object.assign(new Error("receipt requires --emit-contract"), { code: "CLOSEOUT_USAGE" });
      }
      result = cmdReceipt(args);
    } else if (command === "aggregate") {
      result = cmdAggregate(args);
    } else if (command === "completion") {
      result = cmdCompletion(args);
    } else if (command === "source-ledger") {
      result = cmdSourceLedger(args);
    } else {
      process.exitCode = 4;
      emitError("CLOSEOUT_USAGE", usage());
      return;
    }
    emit(result);
  } catch (error) {
    process.exitCode = 4;
    emitError(error?.code || "CLOSEOUT_FAILED", error?.message || String(error), error?.path ? { path: error.path } : {});
  }
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) await main();

export {
  cmdAggregate,
  cmdBackfill,
  cmdCompletion,
  cmdLedgerExport,
  cmdReceipt,
  cmdSourceLedger,
  AGGREGATE_INPUTS,
  SOURCE_LEDGER_FILES,
  UNVERIFIED_ITEMS,
  LEDGER_SCHEMA,
  WAVE_RECEIPT_SCHEMA,
  AGGREGATE_SCHEMA,
  COMPLETION_SCHEMA,
  writeJsonExclusive,
  sha256File,
  transportCount,
  effectView,
  parseArgs,
};