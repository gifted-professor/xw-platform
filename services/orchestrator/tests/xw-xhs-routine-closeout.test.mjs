/**
 * Offline tests for xw-xhs-routine-closeout.mjs (W2 — P1-REPRODUCIBLE-CLOSEOUT).
 * Zero device I/O: everything runs in temp dirs with synthetic ledger dumps,
 * run dumps, and held verdicts. The negatives assert the append-only and
 * stale-lineage red lines:
 *   - existing contract-named artifacts are never overwritten
 *   - verdicts are derived from the ledger, not client booleans
 *   - old release receipts (no releaseIdentity) can never seed a contract verdict
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  cmdAggregate,
  cmdBackfill,
  cmdCompletion,
  cmdLedgerExport,
  cmdReceipt,
  cmdSourceLedger,
  LEDGER_SCHEMA,
  SOURCE_LEDGER_FILES,
  UNVERIFIED_ITEMS,
  parseArgs,
  sha256File,
} from "../ops/xw-xhs-routine-closeout.mjs";

const RELEASE = { "release-id": "xw-xhs-routine-b4-test", "source-commit": "abc1234567890" };

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "xhs-closeout-"));
  process.env.XW_RUNTIME_ROOT = root;
  return root;
}

function acceptanceDir() {
  return join(process.env.XW_RUNTIME_ROOT, "state", "orchestrator", "xhs-routine-acceptance");
}

function writeJson(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path;
}

/** Build a ledger dump JSON the way ledger-export emits it. */
function ledgerDumpPath(dir, { authorities, effects, drafts = [], reconciles = [], name = "ledger-dump.v1.json" } = {}) {
  return writeJson(join(dir, name), {
    schemaId: LEDGER_SCHEMA,
    exportedAt: "2026-08-29T00:00:00.000Z",
    dbPath: "synthetic",
    readOnly: true,
    tables: {
      routine_authorities: authorities,
      routine_effects: effects,
      comment_drafts: drafts,
      comment_reconciles: reconciles,
    },
  });
}

const AUTHORITY = (routineRunId) => ({
  authority_id: `routine-auth_${routineRunId}`,
  execution_run_id: routineRunId.replace("rr_", "xe_"),
  routine_run_id: routineRunId,
  plan_hash: "planhash_s2",
  alias: "03",
  device_id: "dev_x",
  session_id: "session_x",
  lease_id: "lease_x",
  actor_id: "actor_x",
  effect_caps_json: '["like"]',
  canary_authorized: 1,
  status: "closed",
  account_fingerprint: "acct_03",
  created_at: 1,
  closed_at: 2,
  closed_reason: "run-succeeded",
});

const AMBIGUOUS_LIKE = (routineRunId) => ({
  effect_id: "eff_like_1",
  routine_run_id: routineRunId,
  plan_hash: "planhash_s2",
  idempotency_key: "idem_1",
  action: "like",
  target_hash: "target_x",
  observation_hash: "obs_x",
  payload_hash: "payload_x",
  intent_json: '{"surface":"x"}',
  status: "ambiguous",
  reservation_consumed: 1,
  retry_blocked: 1,
  evidence_refs_json: '["ev1"]',
  account_fingerprint: "acct_03",
  created_at: 1,
  updated_at: 2,
  finished_at: 3,
});

const RUN_DUMP = (routineRunId, overrides = {}) => ({
  ok: true,
  command: "execute",
  planHash: "planhash_s2",
  routineRun: {
    schemaId: "xw.xhs.routine-run.v1",
    executionRunId: routineRunId.replace("rr_", "xe_"),
    routineRunId,
    planHash: "planhash_s2",
    template: "xhs.nurture-lite.v1",
    alias: "03",
    effectClass: "social",
    status: "SUCCEEDED",
    serverVerified: true,
    receipt: {
      schemaId: "xw.xhs.execute-receipt.v1",
      cleanup: { verified: true, activeLeases: 0, restored: true, authorityRef: "control-plane:StateStore.listLeases" },
      ...(overrides.receipt ?? {}),
    },
    ...(overrides.run ?? {}),
  },
});

test("usage: unknown command reports CLOSEOUT_USAGE via parseArgs-driven main shape", () => {
  const args = parseArgs(["nope"]);
  assert.equal(args._[0], "nope");
});

test("ledger-export exports the four ledger tables read-only and refuses overwrite", () => {
  const root = tempRoot();
  const dbPath = join(root, "control.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE routine_authorities (authority_id TEXT PRIMARY KEY, execution_run_id TEXT, routine_run_id TEXT, created_at INTEGER);
    CREATE TABLE routine_effects (effect_id TEXT PRIMARY KEY, routine_run_id TEXT, created_at INTEGER);
    CREATE TABLE comment_drafts (draft_id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE comment_reconciles (reconcile_id TEXT PRIMARY KEY, created_at INTEGER);
  `);
  db.prepare("INSERT INTO routine_authorities VALUES ('a1','xe_1','rr_1',1)").run();
  db.prepare("INSERT INTO routine_effects VALUES ('e1','rr_1',1)").run();
  db.close();

  const out = join(root, "ledger-dump.v1.json");
  const result = cmdLedgerExport({ db: dbPath, out });
  assert.equal(result.ok, true);
  const body = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(body.readOnly, true);
  assert.equal(body.tables.routine_authorities.length, 1);
  assert.equal(body.tables.routine_effects.length, 1);

  assert.throws(() => cmdLedgerExport({ db: dbPath, out }), (e) => e.code === "CLOSEOUT_RECEIPT_EXISTS");
});

test("backfill S2 derives TRANSPORTED_AMBIGUOUS_NOT_VERIFIED from the ledger", () => {
  const root = tempRoot();
  const routineRunId = "rr_s2run";
  const ledger = ledgerDumpPath(root, {
    authorities: [AUTHORITY(routineRunId)],
    effects: [AMBIGUOUS_LIKE(routineRunId)],
  });
  const runDump = writeJson(join(root, "s2-run.json"), RUN_DUMP(routineRunId));

  const result = cmdBackfill({ wave: "S2", ledger, runDump, ...RELEASE });
  assert.equal(result.verdict, "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED");

  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(receipt.schemaId, "xw.xhs.routine-wave-receipt.v1");
  assert.equal(receipt.wave, "S2");
  assert.equal(receipt.budgets.likeTransports, 1);
  assert.equal(receipt.budgets.commentTransports, 0);
  assert.equal(receipt.authority.accountFingerprint, "acct_03");
  assert.equal(receipt.effects.rows[0].status, "ambiguous");
  assert.equal(receipt.cleanup.verified, true);
  assert.ok(receipt.lineage.runDump.sha256 && receipt.lineage.ledgerDump.sha256);
  // immutable historical run: reconcile was never performed in-run
  assert.equal(receipt.effects.reconcileGap.recorded, "RECONCILE_NOT_PERFORMED_IN_RUN");

  assert.throws(
    () => cmdBackfill({ wave: "S2", ledger, runDump, ...RELEASE }),
    (e) => e.code === "CLOSEOUT_RECEIPT_EXISTS",
  );
});

test("backfill S3 binds drafts by observation hash and flags the reconcile gap", () => {
  const root = tempRoot();
  const routineRunId = "rr_s3run";
  const ledger = ledgerDumpPath(root, {
    authorities: [AUTHORITY(routineRunId)],
    effects: [{
      ...AMBIGUOUS_LIKE(routineRunId),
      effect_id: "eff_comment_1",
      action: "comment",
    }],
    drafts: [{
      draft_id: "draft_1",
      receipt_hash: "obs_x",
      target_fingerprint: "target_x",
      text_hash: "texthash_1",
      status: "sealed",
      risk_flags_json: "[]",
      account_fingerprint: "acct_03",
    }],
  });
  const runDump = writeJson(join(root, "s3-run.json"), RUN_DUMP(routineRunId));

  const result = cmdBackfill({ wave: "S3", ledger, runDump, ...RELEASE });
  assert.equal(result.verdict, "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED");
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(receipt.budgets.commentTransports, 1);
  assert.equal(receipt.effects.drafts.length, 1);
  assert.equal(receipt.effects.drafts[0].text, undefined, "comment text never enters receipts");
  assert.equal(receipt.effects.drafts[0].textHash, "texthash_1");
});

test("backfill S2 rejects a run with no authority binding and unexpected statuses", () => {
  const root = tempRoot();
  const routineRunId = "rr_orphan";
  const ledger = ledgerDumpPath(root, { authorities: [], effects: [AMBIGUOUS_LIKE(routineRunId)] });
  const runDump = writeJson(join(root, "s2-run.json"), RUN_DUMP(routineRunId));

  assert.throws(
    () => cmdBackfill({ wave: "S2", ledger, runDump, ...RELEASE }),
    (e) => e.code === "CLOSEOUT_AUTHORITY_BINDING_MISSING" && e.routineRunId === routineRunId,
  );

  const routineRunId2 = "rr_verified";
  const ledger2 = ledgerDumpPath(root, {
    authorities: [AUTHORITY(routineRunId2)],
    effects: [{ ...AMBIGUOUS_LIKE(routineRunId2), status: "succeeded" }],
    name: "ledger-2.json",
  });
  const runDump2 = writeJson(join(root, "s2b-run.json"), RUN_DUMP(routineRunId2));
  assert.throws(
    () => cmdBackfill({ wave: "S2", ledger: ledger2, runDump: runDump2, out: undefined, ...RELEASE }),
    (e) => e.code === "CLOSEOUT_UNEXPECTED_EFFECT_STATUS",
  );
});

test("backfill S4 records NOT_VERIFIED_NO_PROVIDER from the held verdict", () => {
  const root = tempRoot();
  const held = writeJson(join(root, "S4-held-no-provider.json"), {
    schemaId: "xw.xhs.routine-wave-verdict.v1",
    wave: "S4",
    verdict: "HELD_NO_PRODUCTION_VISION_PROVIDER",
    reason: "production vision provider absent",
    releaseId: "xw-xhs-routine-b-5f7d22c",
  });
  const result = cmdBackfill({ wave: "S4", held, ...RELEASE });
  assert.equal(result.verdict, "NOT_VERIFIED_NO_PROVIDER");
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(receipt.wave, "S4");
  assert.equal(receipt.releaseIdentity.recordedOn.releaseId, "xw-xhs-routine-b-5f7d22c", "historical identity recorded honestly");

  assert.throws(() => cmdBackfill({ wave: "S4", ...RELEASE }), (e) => e.code === "CLOSEOUT_HELD_REQUIRED");
});

function freshAcceptReceipt(dir, { withReleaseIdentity = true, assertions, wave = "S1-note" } = {}) {
  return writeJson(join(dir, `fresh-${wave}.json`), {
    schemaId: "xw.xhs.routine-live-wave-receipt.v1",
    wave,
    verdict: "PASS",
    run: { executionRunId: `xe_${wave}`, routineRunId: `rr_${wave}`, planHash: "planhash_s1", alias: "03", status: "SUCCEEDED", serverVerified: true },
    releaseIdentity: withReleaseIdentity ? { releaseId: "xw-xhs-routine-b4-test", sourceCommit: "abc1234567890" } : undefined,
    assertions: assertions ?? {
      runSucceeded: true, serverVerified: true, cleanupVerified: true, noNewLeases: true,
      ownedLeaseReleased: true, primitiveTracePresent: true,
    },
    cleanup: { verified: true, activeLeases: 0, restored: true },
  });
}

test("receipt --emit-contract: fresh receipts produce contract-named S1; stale lineage is refused", () => {
  const root = tempRoot();
  const freshA = freshAcceptReceipt(root, { wave: "S1-note" });
  const freshB = freshAcceptReceipt(root, { wave: "S1-video" });

  const result = cmdReceipt({
    "emit-contract": true, wave: "S1", from: `${freshA},${freshB}`,
    ...RELEASE,
  });
  assert.equal(result.verdict, "PASS");
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(result.path.endsWith("S1-wave-receipt.v1.json"), true, "contract naming");
  assert.equal(receipt.runs.length, 2);
  assert.equal(receipt.budgets.likeTransports, 0);

  // append-only: the contract-named artifact is never overwritten
  assert.throws(
    () => cmdReceipt({ "emit-contract": true, wave: "S1", from: freshA, ...RELEASE }),
    (e) => e.code === "CLOSEOUT_RECEIPT_EXISTS",
  );

  // negative: an old release-A receipt (no releaseIdentity) can NEVER seed a verdict
  const stale = writeJson(join(root, "S1-old-receipt.json"), {
    schemaId: "xw.xhs.routine-live-wave-receipt.v1",
    wave: "S1", verdict: "PASS",
    run: { executionRunId: "xe_old", status: "SUCCEEDED", serverVerified: true },
  });
  assert.throws(
    () => cmdReceipt({ "emit-contract": true, wave: "S1", from: stale, ...RELEASE }),
    (e) => e.code === "CLOSEOUT_RECEIPT_STALE_LINEAGE",
  );

  // separate run: stale receipts are only acceptable as lineage provenance (hash-only)
  const root2 = tempRoot();
  const freshC = freshAcceptReceipt(root2, { wave: "S1-note" });
  const withLineage = cmdReceipt({
    "emit-contract": true, wave: "S1", from: freshC, ...RELEASE, lineage: stale,
  });
  const lineageReceipt = JSON.parse(readFileSync(withLineage.path, "utf8"));
  assert.equal(withLineage.path.endsWith("S1-wave-receipt.v1.json"), true);
  assert.equal(lineageReceipt.lineage.priorReceipts.length, 1);
  assert.equal(lineageReceipt.lineage.priorReceipts[0].verdict, "PASS", "recorded as provenance only");
  assert.ok(lineageReceipt.lineage.priorReceipts[0].sha256);
});

test("receipt --emit-contract recomputes verdict from assertions, not the PASS label", () => {
  const root = tempRoot();
  const failing = freshAcceptReceipt(root, {
    wave: "S1-note",
    assertions: { runSucceeded: true, serverVerified: true, cleanupVerified: true, noNewLeases: true, ownedLeaseReleased: false, primitiveTracePresent: true },
  });
  const result = cmdReceipt({ "emit-contract": true, wave: "S1", from: failing, ...RELEASE });
  assert.equal(result.verdict, "FAIL");
});

function buildAggregateInputs(dir, { releaseId = "xw-xhs-routine-b4-test", s1Verdict = "PASS" } = {}) {
  const s1 = writeJson(join(dir, "S1-wave-receipt.v1.json"), {
    schemaId: "xw.xhs.routine-wave-receipt.v1", wave: "S1", verdict: s1Verdict,
    releaseIdentity: { releaseId, sourceCommit: "abc1234567890" },
    cleanup: { verified: true, activeLeases: 0, restored: true },
    budgets: { likeTransports: 0, commentTransports: 0, visualTaps: 0 },
    lineage: { priorReceipts: [{ path: join(dir, "old-s1.json"), sha256: "deadbeef" }] },
  });
  writeJson(join(dir, "old-s1.json"), { schemaId: "xw.xhs.routine-live-wave-receipt.v1", verdict: "PASS" });
  const s2 = writeJson(join(dir, "S2-wave-receipt.v1.json"), {
    schemaId: "xw.xhs.routine-wave-receipt.v1", wave: "S2", verdict: "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED",
    releaseIdentity: { releaseId, sourceCommit: "abc1234567890" },
    cleanup: { verified: true, activeLeases: 0, restored: true },
    budgets: { likeTransports: 1, commentTransports: 0, visualTaps: 0 },
    notes: ["transported, ambiguous, immutable"],
  });
  const s3 = writeJson(join(dir, "S3-wave-receipt.v1.json"), {
    schemaId: "xw.xhs.routine-wave-receipt.v1", wave: "S3", verdict: "TRANSPORTED_AMBIGUOUS_NOT_VERIFIED",
    releaseIdentity: { releaseId, sourceCommit: "abc1234567890" },
    cleanup: { verified: true, activeLeases: 0, restored: true },
    budgets: { likeTransports: 0, commentTransports: 1, visualTaps: 0 },
    notes: ["transported, ambiguous, immutable"],
  });
  const s4 = writeJson(join(dir, "S4-wave-receipt.v1.json"), {
    schemaId: "xw.xhs.routine-wave-receipt.v1", wave: "S4", verdict: "NOT_VERIFIED_NO_PROVIDER",
    releaseIdentity: { releaseId, sourceCommit: "abc1234567890" },
    cleanup: null,
    budgets: { likeTransports: 0, commentTransports: 0, visualTaps: 0 },
    notes: ["no vision provider"],
  });
  const par = writeJson(join(dir, "parallel-03-04-wave-receipt.v1.json"), {
    schemaId: "xw.xhs.routine-wave-receipt.v1", wave: "PAR", verdict: "PASS",
    releaseIdentity: { releaseId, sourceCommit: "abc1234567890" },
    cleanup: { verified: true, activeLeases: 0, restored: true },
    budgets: { likeTransports: 0, commentTransports: 0, visualTaps: 0 },
  });
  return dir;
}

const MINIMAL_CONTRACT = {
  schema: "multi-model-execution-contract.v1",
  planSha256: "a".repeat(64),
  items: [{
    id: "P1-LIVE-S1-S4-CLOSEOUT",
    severity: "P1",
    requiredArtifacts: ["services/orchestrator/ops/xw-xhs-routine-closeout.mjs", "C:/definitely/not/present/receipt.json"],
    probes: [{ id: "P1-closeout-reproduction", kind: "reproduction" }],
  }, {
    id: "P1-REAL-VISION-CORPUS-PERMIT",
    severity: "P1",
    requiredArtifacts: ["services/orchestrator/ops/xw-xhs-routine-closeout.mjs"],
    probes: [{ id: "P1-vision-adversarial", kind: "adversarial" }],
  }],
  execution: { runtime: "claude-cli", primaryModel: "glm-5.3" },
};

test("aggregate: partial closeout, real input hashes, identity and caps recorded", () => {
  const root = tempRoot();
  const dir = buildAggregateInputs(acceptanceDir());
  const contractPath = writeJson(join(root, "contract.json"), MINIMAL_CONTRACT);

  const result = cmdAggregate({ contract: contractPath, receipts: dir });
  assert.equal(result.verdict, "CLOSEOUT_PARTIAL");
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(receipt.schemaId, "xw.xhs.s1-s4-aggregate-receipt.v2");
  assert.equal(receipt.liveVerified, false, "hard-coded until every wave PASSes");
  assert.equal(receipt.budgets.likeTransports, 1);
  assert.equal(receipt.budgets.commentTransports, 1);
  assert.equal(receipt.budgetWithinCaps, true);
  assert.equal(receipt.identityConsistent, true);
  // inputHashes re-hash the actual files
  assert.equal(receipt.inputHashes["S1-wave-receipt.v1.json"], sha256File(join(dir, "S1-wave-receipt.v1.json")));
  assert.equal(receipt.inputHashes["parallel-03-04-wave-receipt.v1.json"], sha256File(join(dir, "parallel-03-04-wave-receipt.v1.json")));
  // lineage dereferenced and hashed when present on disk
  assert.ok(receipt.inputHashes[`lineage:${join(dir, "old-s1.json")}`]);
  assert.equal(receipt.unverified.map((u) => u.wave).sort().join(","), "S2,S3,S4");

  // negative: a missing contract-named receipt aborts the aggregate
  const root2 = tempRoot();
  buildAggregateInputs(acceptanceDir());
  rmSync(join(acceptanceDir(), "S1-wave-receipt.v1.json"));
  assert.throws(
    () => cmdAggregate({ contract: contractPath, receipts: acceptanceDir() }),
    (e) => e.code === "AGGREGATE_RECEIPT_MISSING",
  );
});

test("aggregate records mixed release identities honestly", () => {
  const root = tempRoot();
  buildAggregateInputs(acceptanceDir());
  // rewrite S4 with a different (historical) release identity
  const s4Path = join(acceptanceDir(), "S4-wave-receipt.v1.json");
  const s4 = JSON.parse(readFileSync(s4Path, "utf8"));
  s4.releaseIdentity = { releaseId: "xw-xhs-routine-b-5f7d22c", sourceCommit: "5f7d22c", recordedOn: { releaseId: "xw-xhs-routine-b-5f7d22c" } };
  writeFileSync(s4Path, `${JSON.stringify(s4, null, 2)}\n`, "utf8");

  const result = cmdAggregate({ contract: writeJson(join(root, "c.json"), MINIMAL_CONTRACT), receipts: acceptanceDir() });
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(receipt.identityConsistent, false, "mixed identities are recorded, never normalized away");
  assert.equal(receipt.verdict, "CLOSEOUT_PARTIAL");
});

test("completion: unverified items recorded honestly, real sha256 for present artifacts", () => {
  const root = tempRoot();
  const dir = buildAggregateInputs(acceptanceDir());
  const contractPath = join(dir, "contract.json");
  writeJson(contractPath, {
    ...MINIMAL_CONTRACT,
    items: [
      { ...MINIMAL_CONTRACT.items[0], requiredArtifacts: [contractPath, "contract-absent-artifact.json"] },
      { ...MINIMAL_CONTRACT.items[1], requiredArtifacts: [contractPath] },
    ],
  });

  const result = cmdCompletion({ contract: contractPath, receipts: dir });
  assert.equal(result.ok, true);
  const completion = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(completion.schema, "multi-model-execution-completion.v1");
  assert.equal(completion.planSha256, MINIMAL_CONTRACT.planSha256);
  const [closeout, vision] = completion.items;
  // missing artifact -> unverified (not pass, not crash)
  assert.equal(closeout.status, "unverified");
  assert.equal(closeout.artifactResults.some((a) => a.result === "unverified" && a.unverifiedReason), true);
  // explicit UNVERIFIED item (vision provider) is unverified even with artifacts present
  assert.equal(vision.status, "unverified");
  assert.match(vision.unverifiedReason, /VISION_PROVIDER_ABSENT/);
  assert.equal(vision.probeResults[0].result, "unverified");
  // present artifacts carry REAL hashes
  const passResults = closeout.artifactResults.filter((a) => a.result === "pass");
  assert.equal(passResults.length, 1);
  for (const a of passResults) {
    assert.equal(a.sha256, sha256File(contractPath));
  }
  assert.equal(UNVERIFIED_ITEMS["P1-REAL-VISION-CORPUS-PERMIT"].reason.length > 20, true);
  assert.ok(existsSync(result.path));
});

test("source-ledger: hash list regenerates against a supplied baseline, v1 never overwritten", () => {
  const root = tempRoot();
  const repo = mkdtempSync(join(tmpdir(), "xhs-closeout-repo-"));
  for (const rel of SOURCE_LEDGER_FILES) {
    writeJson(join(repo, rel), { rel, stub: true });
  }
  const baseline = "b".repeat(40);
  const result = cmdSourceLedger({ baseline, repo });
  assert.equal(result.files, SOURCE_LEDGER_FILES.length);
  assert.equal(result.baselineHead, baseline);
  const ledgerPath = join(repo, "docs", "plans", "xhs-routine-03-live-source-files.v1.json");
  const body = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(body.files.length, SOURCE_LEDGER_FILES.length);
  const entry = body.files.find((f) => f.path === SOURCE_LEDGER_FILES[0]);
  assert.equal(entry.sha256, sha256File(join(repo, SOURCE_LEDGER_FILES[0])));
  assert.ok(existsSync(ledgerPath));

  // second run with a new baseline -> versioned sibling, v1 untouched
  const first = readFileSync(ledgerPath, "utf8");
  const result2 = cmdSourceLedger({ baseline: "c".repeat(40), repo });
  assert.equal(result2.path.endsWith("v1-ccccccc.json"), true);
  assert.equal(readFileSync(ledgerPath, "utf8"), first, "append-only: v1 never rewritten");

  // missing --baseline fails closed
  assert.throws(() => cmdSourceLedger({ repo }), (e) => e.code === "CLOSEOUT_BASELINE_MISSING");
});