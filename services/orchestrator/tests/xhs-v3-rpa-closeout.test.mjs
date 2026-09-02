import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createXhsRpaLedger } from "../../control-plane/control-plane/lib/xhs-rpa-ledger.mjs";
import { runXwRpaCli } from "../ops/xw-rpa.mjs";
import { buildXhsV3RpaCloseout, createXhsRpaRuntime } from "../scripts/lib/xhs-rpa-runtime.mjs";
import { deriveNodeSeed, hashXhsRpa } from "../scripts/lib/xhs-rpa-program.mjs";
import {
  childReceipt,
  makeProgram,
  p6Artifact,
  RPA_NOW,
  ZERO_SAFETY,
} from "./fixtures/xhs-rpa-fixtures.mjs";

function runtimeFixture({ p6 = true, onSubmit = null } = {}) {
  const examples = [makeProgram("feed"), makeProgram("scout"), makeProgram("explore")];
  const byId = new Map(examples.map((entry) => [entry.program.programId, entry]));
  const database = new DatabaseSync(":memory:");
  const ledger = createXhsRpaLedger({ database, now: () => RPA_NOW });
  const calls = { submit: 0, restore: 0, leases: 0, lastSubmit: null };
  const runtime = createXhsRpaRuntime({
    ledger,
    loadProgram: async (id) => byId.get(id)?.program,
    loadCatalogSnapshot: async (id) => byId.get(id)?.catalogSnapshot,
    loadP6Artifact: async (id) => {
      const artifact = p6Artifact(byId.get(id).program);
      if (typeof p6 === "function") return p6(artifact);
      return p6 ? artifact : { verdict: "PASS" };
    },
    submitM5TaskPlan: async (request) => {
      calls.submit += 1;
      calls.lastSubmit = request;
      if (onSubmit) await onSubmit({ request, ledger });
      const plannedNode = request.taskPlan.nodes[0];
      return {
        schedulerTraceHash: "2".repeat(64),
        childReceipts: [childReceipt(
          plannedNode.nodeId,
          plannedNode.acceptance.expectedReceiptSchema,
          plannedNode.acceptance.cleanupContractHash,
        )],
        validator: { passed: true, reportHash: "3".repeat(64) },
        aggregateSafety: ZERO_SAFETY,
      };
    },
    restoreOwnedResources: async () => { calls.restore += 1; return { restored: true }; },
    listOwnedLeases: async () => { calls.leases += 1; return []; },
    clock: () => RPA_NOW,
  });
  return { examples, byId, database, ledger, calls, runtime };
}

function eligibilityReport(example) {
  const body = {
    schemaId: "xw.xhs.rpa-catalog-eligibility-report.v1",
    catalogSnapshotHash: example.catalogSnapshot.catalogSnapshotHash,
    entries: example.catalogSnapshot.entries.map((entry) => ({
      entryId: entry.entryId,
      eligible: entry.eligible,
      reasons: entry.reasons,
      descriptorHash: entry.descriptorHash,
      acceptanceReceiptHashes: entry.acceptanceReceiptHashes,
    })),
  };
  return { ...body, reportHash: hashXhsRpa(body) };
}

function gateReport(examples, catalogReport, receipt, planResults, ledgerStatuses) {
  const body = {
    schemaId: "xw.xhs.rpa-gate-report.v1",
    formalReleaseBinding: `${examples[0].program.runtime.releaseId}:${examples[0].program.runtime.sourceCommit}`,
    compilerReportHash: hashXhsRpa(planResults.map((result) => ({
      programHash: result.program.programHash,
      dagHash: result.lowering.dagHash,
      taskPlanHash: result.lowering.taskPlanHash,
      thirdSchedulerIntroduced: result.lowering.thirdSchedulerIntroduced,
      stateMutations: result.stateMutations,
      ioOperations: result.ioOperations,
    })).sort((left, right) => left.programHash.localeCompare(right.programHash))),
    ledgerReportHash: hashXhsRpa(ledgerStatuses.filter(Boolean)
      .sort((left, right) => left.programId.localeCompare(right.programId))),
    journalReportHash: hashXhsRpa({
      tickId: receipt.tickId,
      journalHeadHash: receipt.journalHeadHash,
      journalLength: receipt.journalLength,
    }),
    killReportHash: hashXhsRpa({
      killGeneration: receipt.killGeneration,
      activeTicks: ledgerStatuses.find((status) => status?.programId === receipt.programId).activeTicks,
      recurringEnabled: false,
    }),
    catalogReportHash: catalogReport.reportHash,
    manualReceiptHash: receipt.receiptHash,
    programHashes: examples.map((entry) => entry.program.programHash).sort(),
  };
  return { ...body, reportHash: hashXhsRpa(body) };
}

test("feed/scout/explore plan-only examples make zero state/I-O but cannot close before post-P6 manual-once", async () => {
  const f = runtimeFixture();
  const planResults = [];
  for (const example of f.examples) {
    const result = await f.runtime.plan({ programId: example.program.programId });
    planResults.push(result);
    assert.equal(result.stateMutations, 0);
    assert.equal(result.ioOperations, 0);
    assert.equal(f.ledger.status(example.program.programId), null);
  }
  assert.equal(f.calls.submit, 0);
  assert.throws(() => buildXhsV3RpaCloseout({
    programs: f.examples,
    planResults,
    ledgerStatuses: [null, null, null],
    installedTasks: [],
    manualOnceReceipts: [],
    gateReport: null,
    catalogEligibilityReport: null,
  }), { code: "XHS_RPA_CLOSEOUT_INPUT_INVALID" });
  f.database.close();
});

test("manual-once runtime requires verified P6, lowers once to M5, and commits clean child aggregate", async () => {
  const f = runtimeFixture();
  const feed = f.examples[0].program;
  const result = await f.runtime.tick({
    programId: feed.programId,
    generation: feed.generation,
    idempotencyKey: "runtime:manual:verified:12345678",
    trigger: "manual_once",
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.receipt.committed, true);
  assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.restore, 1);
  assert.equal(f.calls.leases, 1);
  assert.equal(
    f.calls.lastSubmit.nodeSeeds.feed_read,
    deriveNodeSeed(feed.programHash, f.calls.lastSubmit.localCalendarSlot, "feed_read"),
  );
  assert.equal(f.ledger.status(feed.programId).recurringEnabled, false);
  const plans = await Promise.all(f.examples.map((example) => f.runtime.plan({ programId: example.program.programId })));
  const catalogReport = eligibilityReport(f.examples[0]);
  const ledgerStatuses = f.examples.map((example) => f.ledger.status(example.program.programId));
  const gates = gateReport(f.examples, catalogReport, result.receipt, plans, ledgerStatuses);
  const closeoutInput = {
    programs: f.examples,
    planResults: plans,
    ledgerStatuses,
    installedTasks: [],
    manualOnceReceipts: [result.receipt],
    gateReport: gates,
    catalogEligibilityReport: catalogReport,
  };
  const closeout = buildXhsV3RpaCloseout(closeoutInput);
  assert.equal(closeout.RPA_FOUNDATION_VERIFIED, true);
  assert.equal(closeout.RPA_RECURRING_ENABLED, false);
  assert.equal(closeout.manualReceiptHash, result.receipt.receiptHash);
  assert.match(closeout.closeoutHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(buildXhsV3RpaCloseout(closeoutInput), closeout);

  const unsafeBody = {
    ...result.receipt,
    aggregateSafety: { ...result.receipt.aggregateSafety, socialTransportDelta: 1 },
  };
  delete unsafeBody.receiptHash;
  const unsafeReceipt = { ...unsafeBody, receiptHash: hashXhsRpa(unsafeBody) };
  assert.throws(() => buildXhsV3RpaCloseout({ ...closeoutInput, manualOnceReceipts: [unsafeReceipt] }), {
    code: "XHS_RPA_CLOSEOUT_MANUAL_RECEIPT_INVALID",
  });

  const catalogBody = {
    ...catalogReport,
    entries: catalogReport.entries.map((entry) => entry.entryId === "xhs.search.candidate"
      ? { ...entry, eligible: true, reasons: [] }
      : entry),
  };
  delete catalogBody.reportHash;
  const unsafeCatalog = { ...catalogBody, reportHash: hashXhsRpa(catalogBody) };
  assert.throws(() => buildXhsV3RpaCloseout({ ...closeoutInput, catalogEligibilityReport: unsafeCatalog }), {
    code: "XHS_RPA_CLOSEOUT_CATALOG_INVALID",
  });
  const forgedGateBody = { ...gates, compilerReportHash: "f".repeat(64) };
  delete forgedGateBody.reportHash;
  const forgedGate = { ...forgedGateBody, reportHash: hashXhsRpa(forgedGateBody) };
  assert.throws(() => buildXhsV3RpaCloseout({ ...closeoutInput, gateReport: forgedGate }), {
    code: "XHS_RPA_CLOSEOUT_GATE_INVALID",
  });
  f.database.close();

  const denied = runtimeFixture({ p6: false });
  const deniedFeed = denied.examples[0].program;
  const skipped = await denied.runtime.tick({
    programId: deniedFeed.programId,
    generation: deniedFeed.generation,
    idempotencyKey: "runtime:manual:denied:12345678",
    trigger: "manual_once",
  });
  assert.equal(skipped.status, "SKIPPED_P6_UNVERIFIED");
  assert.equal(denied.calls.submit, 0);
  denied.database.close();
});

test("recurring wake is inert before loading program/P6 or touching ledger", async () => {
  const f = runtimeFixture();
  const feed = f.examples[0].program;
  const result = await f.runtime.tick({
    programId: feed.programId,
    generation: feed.generation,
    idempotencyKey: "runtime:recurring:disabled:12345678",
    trigger: "recurring_wake",
  });
  assert.deepEqual(result, {
    programId: feed.programId,
    generation: 1,
    status: "SKIPPED_RECURRING_DISABLED",
    admitted: false,
    recurringEnabled: false,
    stateMutations: 0,
    schedulerDispatches: 0,
  });
  assert.equal(f.ledger.status(feed.programId), null);
  assert.equal(f.calls.submit, 0);
  f.database.close();
});

test("content-addressed P6 artifact rejects task ownership/runtime mutation before scheduler I/O", async () => {
  const f = runtimeFixture({
    p6: (artifact) => {
      const body = { ...artifact, ownership: "caller_owned" };
      delete body.artifactHash;
      return { ...body, artifactHash: hashXhsRpa(body) };
    },
  });
  const feed = f.examples[0].program;
  const result = await f.runtime.tick({
    programId: feed.programId,
    generation: feed.generation,
    idempotencyKey: "runtime:p6:ownership:12345678",
    trigger: "manual_once",
  });
  assert.equal(result.status, "SKIPPED_P6_UNVERIFIED");
  assert.equal(f.calls.submit, 0);
  f.database.close();
});

test("runtime observes kill generation after child settlement and still restores/releases", async () => {
  const f = runtimeFixture({ onSubmit: async ({ ledger }) => { ledger.kill({ reason: "test_mid_child_kill" }); } });
  const feed = f.examples[0].program;
  const result = await f.runtime.tick({
    programId: feed.programId,
    generation: feed.generation,
    idempotencyKey: "runtime:manual:killed:12345678",
    trigger: "manual_once",
  });
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.receipt.cleanup.zeroOwnedLeases, true);
  assert.equal(f.calls.restore, 1);
  assert.equal(f.calls.leases, 1);
  f.database.close();
});

test("CLI exposes only plan/status/disable/manual tick opaque inputs and never recurring enable", async () => {
  const calls = [];
  const runtime = Object.fromEntries(["plan", "status", "disable", "tick"].map((method) => [method, async (input) => {
    calls.push({ method, input });
    return { method, ok: true };
  }]));
  const emitted = [];
  const deps = { runtime, emit: (value) => emitted.push(value) };
  await runXwRpaCli(["plan", "--program-id", "xrp_feed_foundation"], deps);
  await runXwRpaCli(["status", "--program-id", "xrp_feed_foundation"], deps);
  await runXwRpaCli(["disable", "--program-id", "xrp_feed_foundation", "--generation", "1"], deps);
  await runXwRpaCli([
    "tick", "--program-id", "xrp_feed_foundation", "--generation", "1",
    "--idempotency-key", "cli:manual:12345678",
  ], deps);
  assert.deepEqual(calls[3], {
    method: "tick",
    input: {
      programId: "xrp_feed_foundation",
      generation: 1,
      idempotencyKey: "cli:manual:12345678",
      trigger: "manual_once",
    },
  });
  assert.equal(emitted.length, 4);
  for (const argv of [
    ["enable", "--program-id", "xrp_feed_foundation"],
    ["tick", "--program-id", "xrp_feed_foundation", "--generation", "1", "--endpoint", "bad"],
    ["plan", "--program-id", "xrp_feed_foundation", "--alias", "03"],
  ]) await assert.rejects(runXwRpaCli(argv, deps), { code: "XHS_RPA_ARGUMENT_INVALID" });
});
