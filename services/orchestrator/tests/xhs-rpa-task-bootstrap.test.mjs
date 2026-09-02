import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createXhsRpaLedger } from "../../control-plane/control-plane/lib/xhs-rpa-ledger.mjs";
import {
  XHS_RPA_M5_RUNTIME_SCHEMA_ID,
  XHS_RPA_P6_REF_SCHEMA_ID,
  XHS_RPA_P6_SCHEMA_ID,
  buildXhsRpaCatalogInventory,
  createXhsRpaApprovedM5BindingForTest,
  createXhsRpaTaskBootstrapForTest,
  verifyTaskOwnedXhsV3FreeExplorationPass,
} from "../scripts/lib/xhs-rpa-task-bootstrap.mjs";
import { canonicalXhsRpaJson, hashXhsRpa } from "../scripts/lib/xhs-rpa-program.mjs";

const NOW = 1_788_012_000_000;
function identity() {
  return Object.freeze({
    schemaId: "xw.xhs.v3-gate-f-identity.v1",
    taskName: "XW Platform Control Plane",
    taskBindingHash: "1".repeat(64),
    launcherHash: "2".repeat(64),
    callerPathHash: "3".repeat(64),
    releaseId: "xhs-v3-formal-20260830",
    sourceCommit: "4".repeat(40),
    providerBundleDigest: "5".repeat(64),
    providerConfigSha256: "6".repeat(64),
    digestKeyringSha256: "7".repeat(64),
    accountFingerprint: "8".repeat(64),
  });
}

function p6Artifact(formal = identity()) {
  const phases = Object.fromEntries(["R0", "R1", "R2", "R3", "R4"].map((phase, index) => [phase, {
    invocationId: `acceptance-${phase.toLowerCase()}`,
    runRecordHash: String(index + 1).repeat(64),
    resultReceiptHash: String(index + 5).repeat(64),
  }]));
  return Object.freeze({
    schemaId: XHS_RPA_P6_SCHEMA_ID,
    schemaVersion: 1,
    status: "PASS",
    verificationMarker: "XHS_V3_FREE_EXPLORATION_VERIFIED=true",
    XHS_V3_FREE_EXPLORATION_VERIFIED: true,
    runSetId: "acceptance",
    taskBinding: {
      taskName: formal.taskName,
      taskBindingHash: formal.taskBindingHash,
      launcherHash: formal.launcherHash,
      callerPathHash: formal.callerPathHash,
    },
    runtime: {
      releaseId: formal.releaseId,
      sourceCommit: formal.sourceCommit,
      providerBundleDigest: formal.providerBundleDigest,
      digestKeyId: "xhs-evidence-20260830",
      accountFingerprint: formal.accountFingerprint,
    },
    placement: { aliases: ["03", "04"], laneRoles: ["feed_lane", "search_lane"] },
    phases,
    coverage: {
      requiredRoutes: ["HOME_FEED", "SEARCH_RESULTS", "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL"],
      minimumDistinctFramesPerRoute: 3,
      distinctFramesByRoute: {
        HOME_FEED: 3,
        SEARCH_RESULTS: 3,
        IMAGE_NOTE: 3,
        VIDEO_NOTE: 3,
        COMMENT_PANEL: 3,
      },
    },
    safety: {
      socialTransport: 0,
      effectTransport: 0,
      r3VisualIssued: 1,
      r3VisualConsumed: 1,
      r3VisualPhysical: 1,
      allOtherVisualHardZero: true,
    },
    cleanup: {
      semanticRestoreAllLanes: true,
      authorityClosedAllWaves: true,
      sessionReleaseAllSettled: true,
      zeroOwnedLeases: true,
    },
  });
}

function paths(runtimeRoot) {
  const privateRoot = join(runtimeRoot, "private", "xhs-rpa");
  const xhsV3 = join(runtimeRoot, "private", "xhs-v3");
  return Object.freeze({
    runtimeRoot,
    privateRoot,
    releaseRoot: join(privateRoot, "releases"),
    ledgerRoot: join(privateRoot, "ledger"),
    ledgerPath: join(privateRoot, "ledger", "xhs-rpa.sqlite"),
    schedulerRoot: join(privateRoot, "m5-work"),
    traceRoot: join(privateRoot, "m5-trace"),
    receiptRoot: join(privateRoot, "manual-receipts"),
    closeoutRoot: join(privateRoot, "closeouts"),
    p6CurrentPath: join(xhsV3, "acceptance", "p6-current.v1.json"),
    p6ArtifactRoot: join(xhsV3, "acceptance", "p6-artifacts"),
    routineAcceptanceRoot: join(runtimeRoot, "state", "orchestrator", "xhs-routine-acceptance"),
    recipeDatabasePath: join(runtimeRoot, "state", "orchestrator", "registry.db"),
  });
}

function writeCanonical(path, value) {
  writeFileSync(path, canonicalXhsRpaJson(value), { flag: "wx", mode: 0o600 });
}

function fixture({
  withP6 = true,
  taskRunnerReady = true,
  freshLeaseCount = 0,
  ownedLeaseCount = 0,
  restoreFails = false,
  runGate = null,
} = {}) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "xhs-rpa-bootstrap-"));
  const fixed = paths(runtimeRoot);
  mkdirSync(join(runtimeRoot, "private"));
  mkdirSync(join(runtimeRoot, "state"));
  mkdirSync(join(runtimeRoot, "state", "orchestrator"));
  mkdirSync(join(runtimeRoot, "private", "xhs-v3"));
  mkdirSync(join(runtimeRoot, "private", "xhs-v3", "acceptance"));
  mkdirSync(fixed.p6ArtifactRoot);
  const p6 = p6Artifact();
  const p6Hash = hashXhsRpa(p6);
  let p6Published = false;
  function publishP6() {
    if (p6Published) return;
    const artifactRoot = join(fixed.p6ArtifactRoot, p6Hash);
    mkdirSync(artifactRoot);
    writeCanonical(join(artifactRoot, "xhs-v3-p6-pass.v1.json"), p6);
    writeCanonical(fixed.p6CurrentPath, {
      schemaId: XHS_RPA_P6_REF_SCHEMA_ID,
      schemaVersion: 1,
      artifactHash: p6Hash,
      artifactSchemaId: XHS_RPA_P6_SCHEMA_ID,
      relativePath: `p6-artifacts/${p6Hash}/xhs-v3-p6-pass.v1.json`,
    });
    p6Published = true;
  }
  if (withP6) publishP6();
  const calls = { submits: 0, auditBegin: 0, auditComplete: 0, restores: 0, leases: 0, recurring: 0 };
  const m5Runtime = Object.freeze({
    schemaId: XHS_RPA_M5_RUNTIME_SCHEMA_ID,
    async beginLeaseAudit({ tickId }) {
      calls.auditBegin += 1;
      return { ok: true, tickId, baselineLeaseHash: "b".repeat(64) };
    },
    async completeLeaseAudit({ tickId, baselineLeaseHash }) {
      calls.auditComplete += 1;
      return {
        ok: true,
        tickId,
        baselineLeaseHash,
        freshLeaseCount,
        freshLeaseHash: "c".repeat(64),
      };
    },
    async restoreOwnedResources() {
      calls.restores += 1;
      if (restoreFails) throw new Error("restore unavailable");
      return { restored: true };
    },
    async listOwnedLeases() {
      calls.leases += 1;
      return Array.from({ length: ownedLeaseCount }, (_, index) => ({ leaseId: `owned-${index}` }));
    },
    async listRecurringTasks() { calls.recurring += 1; return []; },
  });
  const bootstrapCalls = { prepare: 0, run: 0 };
  const xhsV3TaskBootstrap = {
    health() {
      return {
        schemaId: "xw.xhs.v3-task-bootstrap.v1",
        status: taskRunnerReady ? "READY_R0_R4" : "READY_R0_R2",
        releaseId: identity().releaseId,
        providerBundleDigest: identity().providerBundleDigest,
        taskOwned: true,
      };
    },
    async prepareInvocation(input) {
      bootstrapCalls.prepare += 1;
      return { ok: true, ...input, invocationHash: "d".repeat(64) };
    },
    async runTask(input) {
      bootstrapCalls.run += 1;
      calls.submits += 1;
      if (runGate) {
        runGate.entered();
        await runGate.wait;
      }
      return {
        ok: true,
        status: "SUCCEEDED",
        phase: input.phase,
        receiptHash: "e".repeat(64),
        children: [
          { alias: "03", laneRole: "feed_lane", status: "COMPLETED", committed: true,
            receiptHash: "f".repeat(64), receipt: { restored: { restored: true }, safety: { socialTransport: 0, effectTransport: 0 } } },
          { alias: "04", laneRole: "search_lane", status: "COMPLETED", committed: true,
            receiptHash: "a".repeat(64), receipt: { restored: { restored: true }, safety: { socialTransport: 0, effectTransport: 0 } } },
        ],
        cleanup: {
          authorityClosed: { ok: true, status: "closed" },
          releases: [{ alias: "03", ok: true }, { alias: "04", ok: true }],
          leaseOracle: { checked: true, ok: true, activeLeaseCount: 0 },
        },
        safety: { socialTransport: 0, effectTransport: 0, visualIssued: 0, visualConsumed: 0, visualPhysical: 0 },
      };
    },
  };
  const approvedM5Binding = createXhsRpaApprovedM5BindingForTest({
    xhsV3TaskBootstrap,
    m5Runtime,
    formalIdentity: identity(),
    schedulerRoot: fixed.schedulerRoot,
    traceRoot: fixed.traceRoot,
  });
  const aclController = { protect() {}, verify() {} };
  const fsImpl = {
    existsSync: (path) => {
      try { lstatSync(path); return true; } catch { return false; }
    },
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    unlinkSync,
    writeFileSync,
  };
  const bootstrap = createXhsRpaTaskBootstrapForTest({
    paths: fixed,
    identity: identity(),
    fsImpl,
    aclController,
    openLedgerDatabase: (path) => new DatabaseSync(path),
    openEvidenceDatabase: (path) => new DatabaseSync(path, { readOnly: true }),
    approvedM5Binding,
    clock: () => NOW,
    randomUUIDFn: () => `00000000-0000-4000-8000-${String(calls.submits).padStart(12, "0")}`,
  });
  return {
    bootstrap,
    calls,
    fixed,
    p6,
    publishP6,
    bootstrapCalls,
    approvedM5Binding,
    cleanup() {
      bootstrap.close();
      rmSync(runtimeRoot, { recursive: true, force: true });
    },
  };
}

function ledgerP6Artifact(program) {
  const body = {
    schemaId: "xw.xhs.v3-p6-artifact.v1",
    schemaVersion: 1,
    ownership: "task_owned",
    contentAddressed: true,
    verdict: "PASS",
    programId: program.programId,
    programVersion: program.programVersion,
    generation: program.generation,
    programHash: program.programHash,
    taskPlanHash: program.taskPlanHash,
    releaseId: program.runtime.releaseId,
    sourceCommit: program.runtime.sourceCommit,
  };
  return Object.freeze({ ...body, artifactHash: hashXhsRpa(body) });
}

async function seedDurableActiveTick(f, stage = "DISPATCHED") {
  const planned = await f.bootstrap.plan({ programId: "xrp_explore_foundation" });
  const database = new DatabaseSync(f.fixed.ledgerPath);
  const ledger = createXhsRpaLedger({ database, now: () => NOW });
  ledger.registerProgram(planned.program);
  const tick = ledger.reserveTick({
    programId: planned.program.programId,
    generation: planned.program.generation,
    idempotencyKey: `task-recovery:${stage.toLowerCase()}:12345678`,
    trigger: "manual_once",
    scheduledAtMs: NOW,
    p6Artifact: ledgerP6Artifact(planned.program),
  });
  if (["DISPATCHED", "CLEANING", "CANCEL_REQUESTED"].includes(stage)) {
    ledger.markDispatched({ tickId: tick.tickId, killGeneration: tick.killGeneration });
  }
  if (stage === "CLEANING") ledger.beginCleanup({ tickId: tick.tickId });
  if (stage === "CANCEL_REQUESTED") ledger.kill({ reason: "task_restart_recovery" });
  database.close();
  return tick;
}

test("task-owned P6 verifier binds content hash, task, release, provider, account and exact aliases", () => {
  const artifact = p6Artifact();
  assert.equal(verifyTaskOwnedXhsV3FreeExplorationPass(artifact, identity()).verified, true);
  for (const mutate of [
    (value) => { value.taskBinding.taskBindingHash = "0".repeat(64); },
    (value) => { value.runtime.providerBundleDigest = "0".repeat(64); },
    (value) => { value.runtime.accountFingerprint = "0".repeat(64); },
    (value) => { value.placement.aliases = ["03"]; },
    (value) => { value.safety.socialTransport = 1; },
    (value) => { value.cleanup.zeroOwnedLeases = false; },
    (value) => { value.XHS_V3_FREE_EXPLORATION_VERIFIED = false; },
  ]) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.equal(verifyTaskOwnedXhsV3FreeExplorationPass(changed, identity()).verified, false);
  }
});

test("actual inventory keeps code-only/candidate/social entries ineligible and admits explore only after P6 plus task runner", () => {
  const noP6 = { artifact: null, verification: { verified: false }, blocker: "P6_PASS_MISSING" };
  const blocked = buildXhsRpaCatalogInventory({
    identity: identity(),
    p6: noP6,
    routineReceipts: [],
    recipeRows: [],
    approvedM5Binding: { taskRunnerReady: false },
  });
  for (const id of ["xhs.feed.read", "xhs.scout.read", "xhs.explore.read", "xhs.search.candidate", "xhs.browse.candidate"]) {
    assert.equal(blocked.entries.find((entry) => entry.entryId === id).eligible, false);
  }
  assert.ok(blocked.entries.find((entry) => entry.entryId === "xhs.search.candidate")
    .reasons.includes("CURRENT_CANDIDATE_INELIGIBLE"));
  assert.ok(blocked.entries.filter((entry) => entry.entryId.includes("nurture"))
    .every((entry) => entry.reasons.includes("EFFECT_NOT_NONE")));

  const pass = p6Artifact();
  const admitted = buildXhsRpaCatalogInventory({
    identity: identity(),
    p6: { artifact: pass, verification: { verified: true, artifactHash: hashXhsRpa(pass) }, blocker: null },
    routineReceipts: [],
    recipeRows: [],
    approvedM5Binding: { taskRunnerReady: true, taskRunnerContractHash: "c".repeat(64) },
  });
  assert.equal(admitted.entries.find((entry) => entry.entryId === "xhs.explore.read").eligible, true);
  assert.equal(admitted.entries.find((entry) => entry.entryId === "xhs.feed.read").eligible, false);
});

test("fixed bootstrap seals blocked feed/scout and P6-bound explore, then runs one opaque manual-once with recurring false", async () => {
  const f = fixture();
  try {
    const initialized = f.bootstrap.initialize();
    assert.equal(initialized.RPA_RECURRING_ENABLED, false);
    assert.deepEqual(initialized.examples.map((entry) => [entry.exampleKind, entry.status]), [
      ["feed", "BLOCKED_CATALOG"],
      ["scout", "BLOCKED_CATALOG"],
      ["explore", "SEALED"],
    ]);
    const blocked = await f.bootstrap.plan({ programId: "xrp_feed_foundation" });
    assert.equal(blocked.status, "BLOCKED_CATALOG");
    const plan = await f.bootstrap.plan({ programId: "xrp_explore_foundation" });
    assert.equal(plan.ioOperations, 0);
    assert.equal(plan.stateMutations, 0);
    assert.equal(plan.lowering.taskPlan.nodes.length, 1);
    assert.equal(plan.lowering.taskPlan.nodes[0].shards.length, 1);
    assert.deepEqual(plan.lowering.taskPlan.nodes[0].shards[0].placement, {});
    assert.deepEqual(plan.lowering.dag.nodes[0].targetAliases, []);
    const run = await f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:manual-once:00000001",
    });
    assert.equal(run.result.status, "SUCCEEDED", JSON.stringify(run));
    assert.equal(run.result.receipt.taskOwned, true);
    assert.equal(run.recurringEnabled, false);
    assert.equal(run.closeout.RPA_FOUNDATION_VERIFIED, true);
    assert.equal(run.closeout.RPA_RECURRING_ENABLED, false);
    assert.deepEqual(f.calls, {
      submits: 1, auditBegin: 1, auditComplete: 1, restores: 1, leases: 1, recurring: 1,
    });
    assert.deepEqual(f.bootstrapCalls, { prepare: 1, run: 1 });
    const tickId = run.result.receipt.tickId;
    const schedulerResult = JSON.parse(readFileSync(
      join(f.fixed.schedulerRoot, `run_${tickId}`, "orchestration", "result.v1.json"),
      "utf8",
    ));
    assert.equal(schedulerResult.status, "completed");
    assert.equal(schedulerResult.results.length, 1);
    assert.equal(schedulerResult.results[0].output.aggregateReceiptHash, "e".repeat(64));
    assert.deepEqual(schedulerResult.results[0].output.laneReceiptHashes, ["f".repeat(64), "a".repeat(64)]);
    const traceFiles = readdirSync(f.fixed.traceRoot);
    assert.equal(traceFiles.length, 1);
    const traceBytes = readFileSync(join(f.fixed.traceRoot, traceFiles[0]));
    const traceEvents = traceBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(traceEvents.filter((event) => event.type === "WorkerAssigned").length, 1);
    assert.equal(traceEvents.at(-1).type, "ValidationPassed");
    assert.equal(
      run.result.receipt.schedulerTraceHash,
      createHash("sha256").update(traceBytes).digest("hex"),
    );
    const persisted = JSON.parse(readFileSync(
      join(f.fixed.receiptRoot, `${run.result.receipt.receiptHash}.v1.json`),
      "utf8",
    ));
    assert.equal(persisted.receiptHash, run.result.receipt.receiptHash);
  } finally {
    f.cleanup();
  }
});

test("production RPA contract carries sealed generation through plan/status/manual and adopts disable after commit", async () => {
  const f = fixture();
  try {
    const programId = "xrp_explore_foundation";
    const planned = await f.bootstrap.plan({ programId });
    assert.equal(planned.program.programId, programId);
    assert.equal(planned.program.generation, 1);
    assert.equal(planned.program.enabled, false);
    assert.equal(planned.program.recurringEnabled, false);
    assert.equal(planned.stateMutations, 0);
    assert.equal(planned.ioOperations, 0);

    const before = f.bootstrap.status({ programId });
    assert.equal(before.sealedProgramId, programId);
    assert.equal(before.sealedGeneration, 1);
    assert.equal(before.generation, 1);
    assert.equal(before.registered, false);
    assert.equal(before.disabled, false);
    assert.equal(before.disabledAtMs, null);
    assert.equal(before.recurringEnabled, false);
    await assert.rejects(
      f.bootstrap.disable({ programId, generation: 1 }),
      { code: "XHS_RPA_PROGRAM_NOT_REGISTERED" },
    );

    const manual = await f.bootstrap.manualOnce({
      programId,
      generation: before.generation,
      idempotencyKey: "task-owned:contract:00000001",
    });
    assert.equal(manual.result.status, "SUCCEEDED");
    assert.equal(manual.result.receipt.committed, true);
    assert.equal(manual.recurringEnabled, false);

    const active = f.bootstrap.status({ programId });
    assert.equal(active.generation, 1);
    assert.equal(active.registered, true);
    assert.equal(active.disabled, false);
    assert.equal(active.ledger.activeTicks, 0);

    const disabled = await f.bootstrap.disable({ programId, generation: active.generation });
    assert.equal(disabled.programId, programId);
    assert.equal(disabled.generation, 2);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.recurringEnabled, false);
    assert.equal(disabled.activeTicks, 0);
    assert.ok(Number.isSafeInteger(disabled.disabledAtMs));

    // Simulates loss of the first HTTP response: the original generation is
    // adopted from the durable post-mutation ledger row without mutating twice.
    const retry = await f.bootstrap.disable({ programId, generation: active.generation });
    assert.deepEqual(retry, disabled);
    const after = f.bootstrap.status({ programId });
    assert.equal(after.generation, 2);
    assert.equal(after.disabled, true);
    assert.equal(after.disabledAtMs, disabled.disabledAtMs);
    assert.equal(after.activeTickCount, 0);
    assert.equal(after.recurringEnabled, false);
    assert.equal(f.calls.recurring, 1);
  } finally {
    f.cleanup();
  }
});

test("listener lease diff is all-settled and refuses commit when a fresh lease remains", async () => {
  const f = fixture({ freshLeaseCount: 1 });
  try {
    const run = await f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:lease-diff:00000001",
    });
    assert.equal(run.result.status, "BLOCKED");
    assert.equal(run.closeout, null);
    assert.equal(f.calls.auditBegin, 1);
    assert.equal(f.calls.auditComplete, 1);
    assert.equal(f.calls.submits, 1);
    assert.deepEqual(f.bootstrapCalls, { prepare: 1, run: 1 });
  } finally {
    f.cleanup();
  }
});

test("approved M5 bridge reuses its committed scheduler receipt without a second R4 call", async () => {
  const f = fixture();
  try {
    const planned = await f.bootstrap.plan({ programId: "xrp_explore_foundation" });
    const tickId = `tick_${"1".repeat(32)}`;
    const request = Object.freeze({
      tickId,
      idempotencyKey: `xhs-rpa:${tickId}`,
      dag: planned.lowering.dag,
      taskPlan: planned.lowering.taskPlan,
      localCalendarSlot: "2026-08-30",
      nodeSeeds: Object.freeze({ explore_read: "9".repeat(64) }),
    });
    const first = await f.approvedM5Binding.submit(request);
    const traceBefore = readFileSync(join(f.fixed.traceRoot, readdirSync(f.fixed.traceRoot)[0]));
    const second = await f.approvedM5Binding.submit(request);
    const traceAfter = readFileSync(join(f.fixed.traceRoot, readdirSync(f.fixed.traceRoot)[0]));
    assert.equal(first.schedulerTraceHash, second.schedulerTraceHash);
    assert.deepEqual(traceAfter, traceBefore);
    assert.deepEqual(f.bootstrapCalls, { prepare: 1, run: 1 });
    assert.equal(f.calls.submits, 1);
    assert.equal(f.calls.auditBegin, 2);
    assert.equal(f.calls.auditComplete, 2);
  } finally {
    f.cleanup();
  }
});

test("missing P6 or missing task-owned R0-R4 runner blocks before ledger/device submission", async () => {
  for (const options of [{ withP6: false }, { taskRunnerReady: false }]) {
    const f = fixture(options);
    try {
      const health = f.bootstrap.health();
      const explore = health.examples.find((entry) => entry.exampleKind === "explore");
      assert.equal(explore.status, "BLOCKED_CATALOG");
      await assert.rejects(f.bootstrap.manualOnce({
        programId: "xrp_explore_foundation",
        generation: 1,
        idempotencyKey: "task-owned:blocked:00000001",
      }), { code: "XHS_RPA_CATALOG_INELIGIBLE" });
      assert.equal(f.calls.submits, 0);
    } finally {
      f.cleanup();
    }
  }
});

test("pre-P6 health is provisional and promotes in the same listener only when task-owned P6 appears", async () => {
  const f = fixture({ withP6: false });
  try {
    const before = f.bootstrap.health();
    assert.equal(before.examples.find((entry) => entry.exampleKind === "explore").status, "BLOCKED_CATALOG");
    assert.equal(before.recoveryRequired, false);
    f.publishP6();
    const after = f.bootstrap.health();
    assert.equal(after.examples.find((entry) => entry.exampleKind === "explore").status, "SEALED");
    assert.notEqual(after.catalogSnapshotHash, before.catalogSnapshotHash);
    const planned = await f.bootstrap.plan({ programId: "xrp_explore_foundation" });
    assert.equal(planned.ioOperations, 0);

    // Once the verified snapshot is promoted it is immutable for this
    // listener lifetime; loss/drift of P6 cannot hot-switch the program.
    unlinkSync(f.fixed.p6CurrentPath);
    await assert.rejects(f.bootstrap.plan({ programId: "xrp_explore_foundation" }), {
      code: "XHS_RPA_CATALOG_SNAPSHOT_DRIFT",
    });
    assert.equal(f.calls.submits, 0);
  } finally {
    f.cleanup();
  }
});

test("manual-once reconciles a durable prior-process tick before any new M5 submission", async () => {
  const f = fixture();
  try {
    const stale = await seedDurableActiveTick(f, "DISPATCHED");
    assert.equal(f.bootstrap.status({ programId: "xrp_explore_foundation" }).recoveryRequired, true);
    const run = await f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:after-recovery:00000001",
    });
    assert.equal(run.result.status, "SKIPPED_DAILY_CAP");
    assert.equal(run.closeout, null);
    assert.equal(f.calls.submits, 0);
    assert.equal(f.calls.restores, 1);
    assert.equal(f.calls.leases, 1);
    const status = f.bootstrap.status({ programId: "xrp_explore_foundation" });
    assert.equal(status.recoveryRequired, false);
    assert.equal(status.recoveryComplete, true);

    const database = new DatabaseSync(f.fixed.ledgerPath);
    const ledger = createXhsRpaLedger({ database, now: () => NOW });
    assert.equal(ledger.getTick(stale.tickId).status, "BLOCKED");
    assert.equal(ledger.verifyJournal(stale.tickId).valid, true);
    database.close();
  } finally {
    f.cleanup();
  }
});

test("a concurrent manual-once never reconciles the live process tick as crash residue", async () => {
  let releaseRun;
  let signalEntered;
  const runGate = {
    wait: new Promise((resolve) => { releaseRun = resolve; }),
    entered: null,
  };
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  runGate.entered = signalEntered;
  const f = fixture({ runGate });
  let firstPromise = null;
  try {
    firstPromise = f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:live-concurrency:00000001",
    });
    await entered;
    const liveStatus = f.bootstrap.status({ programId: "xrp_explore_foundation" });
    assert.equal(liveStatus.activeTickCount, 1);
    assert.equal(liveStatus.recoveryRequired, false);
    assert.equal(liveStatus.recoveryComplete, true);

    const second = await f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:live-concurrency:00000002",
    });
    assert.equal(second.result.status, "SKIPPED_ACCOUNT_CONCURRENCY");
    assert.equal(f.calls.restores, 0);
    assert.equal(f.calls.leases, 0);
    assert.equal(f.calls.submits, 1);

    releaseRun();
    const first = await firstPromise;
    assert.equal(first.result.status, "SUCCEEDED");
    assert.equal(f.calls.restores, 1);
    assert.equal(f.calls.leases, 1);
    assert.equal(f.calls.submits, 1);
  } finally {
    releaseRun?.();
    try { await firstPromise; } catch {}
    f.cleanup();
  }
});

test("manual-once refuses new work while startup recovery cannot prove zero owned leases", async () => {
  const f = fixture({ ownedLeaseCount: 1 });
  try {
    await seedDurableActiveTick(f, "CLEANING");
    await assert.rejects(f.bootstrap.manualOnce({
      programId: "xrp_explore_foundation",
      generation: 1,
      idempotencyKey: "task-owned:recovery-blocked:00000001",
    }), { code: "XHS_RPA_RECOVERY_INCOMPLETE" });
    assert.equal(f.calls.submits, 0);
    assert.deepEqual(f.bootstrapCalls, { prepare: 0, run: 0 });
    assert.equal(f.calls.restores, 1);
    assert.equal(f.calls.leases, 1);
    const health = f.bootstrap.health();
    assert.equal(health.recoveryRequired, true);
    assert.equal(health.activeTickCount, 1);
  } finally {
    f.cleanup();
  }
});

test("operation surface rejects path/endpoint/alias/goal/provider/recipe injection before state", async () => {
  const f = fixture();
  try {
    for (const [method, base] of [
      ["plan", { programId: "xrp_explore_foundation" }],
      ["status", { programId: "xrp_explore_foundation" }],
      ["disable", { programId: "xrp_explore_foundation", generation: 1 }],
      ["manualOnce", {
        programId: "xrp_explore_foundation",
        generation: 1,
        idempotencyKey: "task-owned:injection:00000001",
      }],
    ]) {
      for (const field of ["path", "endpoint", "alias", "goal", "provider", "recipe", "command", "coordinates"]) {
        await assert.rejects(Promise.resolve().then(() => f.bootstrap[method]({ ...base, [field]: "caller" })));
      }
    }
    assert.equal(f.calls.submits, 0);
  } finally {
    f.cleanup();
  }
});
