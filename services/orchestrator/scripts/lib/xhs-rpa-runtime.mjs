import { lowerXhsRpaProgramToM5 } from "./xhs-rpa-m5-adapter.mjs";
import { deriveNodeSeed, hashXhsRpa } from "./xhs-rpa-program.mjs";

const PROGRAM_ID = /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;

function fail(code, message, cause) {
  throw Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function cleanupReceipt(restored, leases) {
  const restoredOk = restored.status === "fulfilled" && restored.value?.restored === true;
  const leaseList = leases.status === "fulfilled" && Array.isArray(leases.value) ? leases.value : null;
  return Object.freeze({
    restored: restoredOk,
    zeroOwnedLeases: leaseList !== null && leaseList.length === 0,
    ownedLeaseCount: leaseList?.length ?? -1,
  });
}

function shanghaiLocalCalendarSlot(epochMs) {
  return new Date(epochMs + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

export function createXhsRpaRuntime({
  ledger,
  loadProgram,
  loadCatalogSnapshot,
  loadP6Artifact,
  submitM5TaskPlan,
  restoreOwnedResources,
  listOwnedLeases,
  clock = () => Date.now(),
} = {}) {
  if (!ledger || typeof ledger.reserveTick !== "function"
    || typeof ledger.listActiveTicks !== "function"
    || typeof ledger.verifyJournal !== "function"
    || typeof ledger.cancelTick !== "function" || typeof ledger.blockTick !== "function"
    || ![loadProgram, loadCatalogSnapshot, loadP6Artifact, submitM5TaskPlan,
      restoreOwnedResources, listOwnedLeases].every((fn) => typeof fn === "function")) {
    fail("XHS_RPA_RUNTIME_DEPENDENCY_INVALID", "fixed RPA runtime dependencies are required");
  }

  async function loadSealed(programId) {
    if (!PROGRAM_ID.test(String(programId ?? ""))) fail("XHS_RPA_PROGRAM_ID_INVALID", "program id is invalid");
    const [program, catalogSnapshot] = await Promise.all([
      loadProgram(programId),
      loadCatalogSnapshot(programId),
    ]);
    if (!program || program.programId !== programId) fail("XHS_RPA_PROGRAM_NOT_FOUND", "fixed sealed program was not found");
    return Object.freeze({ program, catalogSnapshot });
  }

  /** Pure/read-only plan projection: no ledger reservation and no executor I/O. */
  async function plan(input = {}) {
    if (!exact(input, ["programId"])) fail("XHS_RPA_PLAN_INPUT_INVALID", "plan accepts only programId");
    const sealed = await loadSealed(input.programId);
    return Object.freeze({
      program: sealed.program,
      lowering: lowerXhsRpaProgramToM5(sealed),
      stateMutations: 0,
      ioOperations: 0,
      recurringEnabled: false,
    });
  }

  async function settleCleanup(tickId) {
    const [restored, leases] = await Promise.allSettled([
      restoreOwnedResources({ tickId }),
      listOwnedLeases({ tickId }),
    ]);
    return cleanupReceipt(restored, leases);
  }

  /**
   * Settle only ticks that pre-date this runtime instance.  This never calls
   * the scheduler or replays child I/O: a durable start remains consumed and
   * is closed only after the fixed restore + independent lease oracle agree.
   */
  async function reconcileActiveTicks() {
    const active = ledger.listActiveTicks();
    let settled = 0;
    let failed = 0;
    for (const tick of active) {
      const journalValid = ledger.verifyJournal(tick.tickId).valid === true;
      const cleanup = await settleCleanup(tick.tickId);
      if (!journalValid || !cleanup.restored || !cleanup.zeroOwnedLeases) {
        failed += 1;
        continue;
      }
      try {
        if (tick.status === "CANCEL_REQUESTED") {
          ledger.cancelTick({ tickId: tick.tickId, cleanup, reason: "STARTUP_RECOVERY_KILL" });
        } else {
          ledger.blockTick({ tickId: tick.tickId, cleanup, reason: "STARTUP_RECOVERY_CRASH" });
        }
        settled += 1;
      } catch {
        failed += 1;
      }
    }
    const remaining = ledger.listActiveTicks();
    const summary = Object.freeze({
      status: remaining.length === 0 ? "RECOVERED" : "RECOVERY_REQUIRED",
      discoveredActiveTicks: active.length,
      settledTicks: settled,
      failedTicks: failed,
      remainingActiveTicks: remaining.length,
      schedulerDispatches: 0,
      recurringEnabled: false,
    });
    if (remaining.length > 0) {
      fail(
        "XHS_RPA_RECOVERY_INCOMPLETE",
        "startup recovery could not prove restore and zero owned leases for every durable tick",
        summary,
      );
    }
    return summary;
  }

  async function tick(input = {}) {
    const keys = ["programId", "generation", "idempotencyKey", "trigger"];
    if (!exact(input, keys) || !PROGRAM_ID.test(String(input.programId ?? ""))
      || !Number.isInteger(input.generation) || input.generation < 1
      || !OPAQUE.test(String(input.idempotencyKey ?? ""))
      || !["manual_once", "recurring_wake"].includes(input.trigger)
      || typeof clock !== "function") {
      fail("XHS_RPA_TICK_INPUT_INVALID", "tick accepts only opaque program/generation trigger data");
    }
    if (input.trigger === "recurring_wake") {
      return Object.freeze({
        programId: input.programId,
        generation: input.generation,
        status: "SKIPPED_RECURRING_DISABLED",
        admitted: false,
        recurringEnabled: false,
        stateMutations: 0,
        schedulerDispatches: 0,
      });
    }
    const sealed = await loadSealed(input.programId);
    if (sealed.program.generation !== input.generation) fail("XHS_RPA_GENERATION_STALE", "sealed program generation differs");
    const lowering = lowerXhsRpaProgramToM5(sealed);
    ledger.registerProgram(sealed.program);
    const p6Artifact = await loadP6Artifact(input.programId);
    const scheduledAtMs = clock();
    if (!Number.isInteger(scheduledAtMs)) fail("XHS_RPA_CLOCK_INVALID", "CP-bound clock returned an invalid time");
    const reserved = ledger.reserveTick({ ...input, scheduledAtMs, p6Artifact });
    if (reserved.status !== "RESERVED") return reserved;
    let dispatched = false;
    try {
      ledger.recordPreIoAttempt({ tickId: reserved.tickId });
      ledger.markDispatched({ tickId: reserved.tickId, killGeneration: reserved.killGeneration });
      dispatched = true;
      const beforeIo = ledger.getTick(reserved.tickId);
      if (beforeIo.status !== "DISPATCHED") fail("XHS_RPA_KILL_OBSERVED", "kill observed before scheduler I/O");
      const localCalendarSlot = shanghaiLocalCalendarSlot(scheduledAtMs);
      const nodeSeeds = Object.freeze(Object.fromEntries(sealed.program.nodes.map((node) => [
        node.nodeId,
        deriveNodeSeed(sealed.program.programHash, localCalendarSlot, node.nodeId),
      ])));
      const result = await submitM5TaskPlan(Object.freeze({
        tickId: reserved.tickId,
        idempotencyKey: `xhs-rpa:${reserved.tickId}`,
        dag: lowering.dag,
        taskPlan: lowering.taskPlan,
        localCalendarSlot,
        nodeSeeds,
      }));
      const afterIo = ledger.getTick(reserved.tickId);
      if (afterIo.status === "CANCEL_REQUESTED") fail("XHS_RPA_KILL_OBSERVED", "kill observed after child execution");
      ledger.beginCleanup({ tickId: reserved.tickId });
      const cleanup = await settleCleanup(reserved.tickId);
      if (!cleanup.restored || !cleanup.zeroOwnedLeases) {
        fail("XHS_RPA_CLEANUP_INCOMPLETE", "restore/zero-owned-leases closeout failed");
      }
      return ledger.commitTick({
        tickId: reserved.tickId,
        killGeneration: reserved.killGeneration,
        schedulerTraceHash: result?.schedulerTraceHash,
        childReceipts: result?.childReceipts,
        validator: result?.validator,
        cleanup,
        aggregateSafety: result?.aggregateSafety,
      });
    } catch (error) {
      const current = ledger.getTick(reserved.tickId);
      if (!current || ["SUCCEEDED", "CANCELLED", "BLOCKED"].includes(current.status)) throw error;
      if (dispatched && current.status === "DISPATCHED") {
        try { ledger.beginCleanup({ tickId: reserved.tickId }); } catch {}
      }
      const cleanup = await settleCleanup(reserved.tickId);
      if (!cleanup.restored || !cleanup.zeroOwnedLeases) {
        fail("XHS_RPA_CLEANUP_INCOMPLETE", "failure cleanup did not restore with zero owned leases", error);
      }
      const killed = ledger.getTick(reserved.tickId)?.status === "CANCEL_REQUESTED"
        || error?.code === "XHS_RPA_KILL_OBSERVED"
        || error?.code === "XHS_RPA_KILL_GENERATION_STALE";
      return killed
        ? ledger.cancelTick({ tickId: reserved.tickId, cleanup, reason: "KILL_GENERATION" })
        : ledger.blockTick({ tickId: reserved.tickId, cleanup, reason: String(error?.code || "RUNTIME_FAILURE") });
    }
  }

  return Object.freeze({
    plan,
    tick,
    reconcileActiveTicks,
    status: (input = {}) => {
      if (!exact(input, ["programId"])) fail("XHS_RPA_STATUS_INPUT_INVALID", "status accepts only programId");
      return ledger.status(input.programId);
    },
    disable: (input = {}) => ledger.disable(input),
  });
}

/** Deterministic P7 closeout assertion; it never enables or creates a task. */
const CLOSEOUT_SAFETY_KEYS = [
  "likes", "comments", "follows", "shares", "saves", "publishes", "messages",
  "socialAuthorityDelta", "socialReservationDelta", "socialTransportDelta",
];

function closeoutZeroSafety(value) {
  return exact(value, CLOSEOUT_SAFETY_KEYS) && CLOSEOUT_SAFETY_KEYS.every((key) => value[key] === 0);
}

function closeoutClean(value) {
  return exact(value, ["restored", "zeroOwnedLeases", "ownedLeaseCount"])
    && value.restored === true && value.zeroOwnedLeases === true && value.ownedLeaseCount === 0;
}

function contentAddressed(value, schemaId) {
  if (!value || value.schemaId !== schemaId || !/^[0-9a-f]{64}$/.test(String(value.reportHash ?? ""))) return false;
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reportHash"));
  return value.reportHash === hashXhsRpa(body);
}

export function buildXhsV3RpaCloseout(input = {}) {
  const keys = [
    "programs", "planResults", "ledgerStatuses", "installedTasks", "manualOnceReceipts",
    "gateReport", "catalogEligibilityReport",
  ];
  if (!exact(input, keys)) fail("XHS_RPA_CLOSEOUT_INPUT_INVALID", "closeout input must be exact and evidence-complete");
  const {
    programs, planResults, ledgerStatuses, installedTasks, manualOnceReceipts,
    gateReport, catalogEligibilityReport,
  } = input;
  if (!Array.isArray(programs) || !Array.isArray(planResults) || !Array.isArray(ledgerStatuses)
    || !Array.isArray(installedTasks) || !Array.isArray(manualOnceReceipts)
    || programs.length !== 3 || planResults.length !== 3 || manualOnceReceipts.length !== 1) {
    fail("XHS_RPA_CLOSEOUT_INPUT_INVALID", "feed/scout/explore plan-only evidence is required");
  }
  const names = [...programs.map((program) => program.exampleKind)].sort();
  if (JSON.stringify(names) !== JSON.stringify(["explore", "feed", "scout"])) {
    fail("XHS_RPA_CLOSEOUT_EXAMPLES_MISSING", "closeout needs feed/scout/explore examples");
  }
  const blockedKeys = [
    "schemaId", "exampleKind", "programId", "status", "catalogSnapshotHash", "entryId",
    "blockers", "stateMutations", "ioOperations", "recurringEnabled", "exampleHash",
  ];
  function isBlockedExample(entry) {
    const body = entry && Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "exampleHash"));
    return exact(entry, blockedKeys)
      && entry.schemaId === "xw.xhs.rpa-plan-example.v1"
      && ["feed", "scout", "explore"].includes(entry.exampleKind)
      && /^xrp_[a-z0-9][a-z0-9._-]{2,63}$/.test(String(entry.programId ?? ""))
      && entry.status === "BLOCKED_CATALOG"
      && /^[0-9a-f]{64}$/.test(String(entry.catalogSnapshotHash ?? ""))
      && typeof entry.entryId === "string"
      && Array.isArray(entry.blockers) && entry.blockers.length > 0
      && entry.blockers.every((reason) => /^[A-Z0-9_]+$/.test(String(reason)))
      && entry.stateMutations === 0 && entry.ioOperations === 0
      && entry.recurringEnabled === false
      && entry.exampleHash === hashXhsRpa(body);
  }
  const sealedPrograms = programs.filter((entry) => entry?.program).map((entry) => entry.program);
  if (programs.some((entry) => !entry?.program && !isBlockedExample(entry)) || sealedPrograms.length < 1) {
    fail("XHS_RPA_CLOSEOUT_EXAMPLES_MISSING", "examples must be sealed programs or honest catalog-blocked records");
  }
  const releaseBindings = new Set(sealedPrograms.map((program) => `${program.runtime?.releaseId}:${program.runtime?.sourceCommit}`));
  if (releaseBindings.size !== 1) {
    fail("XHS_RPA_CLOSEOUT_RELEASE_DRIFT", "every executable RPA example must bind the same formal V3 release");
  }
  const formalReleaseBinding = [...releaseBindings][0];
  if (sealedPrograms.some((program) => program.enabled !== false || program.recurringEnabled !== false)
    || programs.filter((entry) => !entry?.program).some((entry) => entry.recurringEnabled !== false)
    || planResults.some((result) => result.stateMutations !== 0 || result.ioOperations !== 0 || result.recurringEnabled !== false)
    || ledgerStatuses.some((status) => status && (status.enabled !== false || status.recurringEnabled !== false))
    || installedTasks.some((task) => task?.kind === "xhs_rpa_recurring" || task?.recurringEnabled === true)) {
    fail("XHS_RPA_CLOSEOUT_UNSAFE", "RPA foundation is not disabled/plan-only");
  }
  for (const result of planResults) {
    if (isBlockedExample(result)) {
      const planned = programs.find((entry) => !entry?.program && entry.exampleKind === result.exampleKind);
      if (!planned || planned.exampleHash !== result.exampleHash) {
        fail("XHS_RPA_CLOSEOUT_COMPILER_INVALID", "blocked plan example differs from its sealed inventory record");
      }
      continue;
    }
    const planned = programs.find((entry) => entry?.program?.programId === result?.program?.programId)?.program;
    if (!exact(result, ["program", "lowering", "stateMutations", "ioOperations", "recurringEnabled"])
      || !planned || result.program.programHash !== planned.programHash
      || result.lowering?.adapterId !== "xw.xhs.rpa-to-m5.v1"
      || result.lowering?.taskPlanHash !== planned.taskPlanHash
      || result.lowering?.thirdSchedulerIntroduced !== false) {
      fail("XHS_RPA_CLOSEOUT_COMPILER_INVALID", "plan-only compiler evidence is incomplete or unbound");
    }
  }
  const exampleCatalogHashes = programs.map((entry) => entry?.program?.runtime?.catalogSnapshotHash
    ?? entry.catalogSnapshotHash);
  if (!exact(catalogEligibilityReport, ["schemaId", "catalogSnapshotHash", "entries", "reportHash"])
    || !contentAddressed(catalogEligibilityReport, "xw.xhs.rpa-catalog-eligibility-report.v1")
    || exampleCatalogHashes.some((hash) => hash !== catalogEligibilityReport.catalogSnapshotHash)
    || !Array.isArray(catalogEligibilityReport.entries)) {
    fail("XHS_RPA_CLOSEOUT_CATALOG_INVALID", "content-addressed catalog eligibility report is missing or drifted");
  }
  for (const entry of catalogEligibilityReport.entries) {
    if (!exact(entry, ["entryId", "eligible", "reasons", "descriptorHash", "acceptanceReceiptHashes"])
      || typeof entry.entryId !== "string" || typeof entry.eligible !== "boolean"
      || !Array.isArray(entry.reasons) || entry.reasons.some((reason) => !/^[A-Z0-9_]+$/.test(String(reason)))
      || !/^[0-9a-f]{64}$/.test(String(entry.descriptorHash ?? ""))
      || !Array.isArray(entry.acceptanceReceiptHashes)
      || entry.acceptanceReceiptHashes.some((hash) => !/^[0-9a-f]{64}$/.test(String(hash)))) {
      fail("XHS_RPA_CLOSEOUT_CATALOG_INVALID", "catalog report entry is not exact/private-safe evidence");
    }
  }
  const eligibility = new Map(catalogEligibilityReport.entries.map((entry) => [entry.entryId, entry]));
  for (const program of sealedPrograms) {
    for (const node of program.nodes) {
      const entry = eligibility.get(node.catalogRef.entryId);
      if (!entry || entry.eligible !== true || entry.descriptorHash !== node.catalogRef.descriptorHash
        || JSON.stringify(entry.acceptanceReceiptHashes) !== JSON.stringify(node.catalogRef.acceptanceReceiptHashes)) {
        fail("XHS_RPA_CLOSEOUT_CATALOG_INVALID", "program node lacks matching accepted catalog evidence");
      }
    }
  }
  for (const blocked of programs.filter((entry) => !entry?.program)) {
    const entry = eligibility.get(blocked.entryId);
    if (!entry || entry.eligible !== false
      || blocked.blockers.some((reason) => !entry.reasons.includes(reason))) {
      fail("XHS_RPA_CLOSEOUT_CATALOG_INVALID", "blocked example is not reproduced by the atomic catalog report");
    }
  }
  for (const candidateId of ["xhs.search.candidate", "xhs.browse.candidate"]) {
    const candidate = eligibility.get(candidateId);
    if (!candidate || candidate.eligible !== false || !candidate.reasons?.includes("CURRENT_CANDIDATE_INELIGIBLE")) {
      fail("XHS_RPA_CLOSEOUT_CATALOG_INVALID", "current search/browse candidate must stay ineligible");
    }
  }
  const receipt = manualOnceReceipts[0];
  const receiptKeys = [
    "schemaId", "tickId", "programId", "programVersion", "programHash", "taskPlanHash",
    "generation", "killGeneration", "trigger", "taskOwned", "p6ArtifactHash", "releaseId",
    "sourceCommit", "recurringEnabled", "externalEffects", "writeTransportBudget",
    "journalHeadHash", "journalLength", "schedulerTraceHash", "childReceipts", "validator", "cleanup", "aggregateSafety",
    "committed", "receiptHash",
  ];
  const receiptBody = receipt && Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptHash"));
  const program = sealedPrograms.find((entry) => entry.programId === receipt?.programId);
  if (!exact(receipt, receiptKeys) || !program || receipt.schemaId !== "xw.xhs.rpa-tick-receipt.v1"
    || receipt.receiptHash !== hashXhsRpa(receiptBody)
    || receipt.programVersion !== program.programVersion || receipt.programHash !== program.programHash
    || receipt.taskPlanHash !== program.taskPlanHash || receipt.generation !== program.generation
    || receipt.trigger !== "manual_once" || receipt.taskOwned !== true
    || !/^[0-9a-f]{64}$/.test(String(receipt.p6ArtifactHash ?? ""))
    || receipt.releaseId !== program.runtime.releaseId || receipt.sourceCommit !== program.runtime.sourceCommit
    || receipt.recurringEnabled !== false || receipt.externalEffects !== 0 || receipt.writeTransportBudget !== 0
    || !/^[0-9a-f]{64}$/.test(String(receipt.journalHeadHash ?? ""))
    || !Number.isInteger(receipt.journalLength) || receipt.journalLength < 1
    || receipt.committed !== true || !/^[0-9a-f]{64}$/.test(String(receipt.schedulerTraceHash ?? ""))
    || !exact(receipt.validator, ["passed", "reportHash"]) || receipt.validator.passed !== true
    || !/^[0-9a-f]{64}$/.test(String(receipt.validator.reportHash ?? ""))
    || !closeoutClean(receipt.cleanup) || !closeoutZeroSafety(receipt.aggregateSafety)
    || !Array.isArray(receipt.childReceipts) || receipt.childReceipts.length !== program.nodes.length) {
    fail("XHS_RPA_CLOSEOUT_MANUAL_RECEIPT_INVALID", "exactly one task-owned post-P6 manual-once receipt is required");
  }
  const expectedNodes = new Map(program.nodes.map((node) => [node.nodeId, node.catalogRef]));
  for (const child of receipt.childReceipts) {
    const expected = expectedNodes.get(child.nodeId);
    if (!exact(child, ["nodeId", "schemaId", "receiptHash", "cleanupContractHash", "committed", "safety", "cleanup"])
      || !expected || child.schemaId !== expected.expectedReceiptSchema
      || child.cleanupContractHash !== expected.cleanupContractHash || child.committed !== true
      || !/^[0-9a-f]{64}$/.test(String(child.receiptHash ?? ""))
      || !closeoutZeroSafety(child.safety) || !closeoutClean(child.cleanup)) {
      fail("XHS_RPA_CLOSEOUT_MANUAL_RECEIPT_INVALID", "manual child receipt is incomplete or effectful");
    }
  }
  const status = ledgerStatuses.find((entry) => entry?.programId === program.programId);
  if (!status || status.programHash !== program.programHash || status.activeTicks !== 0
    || status.enabled !== false || status.recurringEnabled !== false) {
    fail("XHS_RPA_CLOSEOUT_LEDGER_INVALID", "manual run ledger did not settle to disabled/zero-active");
  }
  const gateKeys = [
    "schemaId", "formalReleaseBinding", "compilerReportHash", "ledgerReportHash",
    "journalReportHash", "killReportHash", "catalogReportHash", "manualReceiptHash",
    "programHashes", "reportHash",
  ];
  const compilerRows = planResults.map((result) => isBlockedExample(result)
    ? {
        exampleHash: result.exampleHash,
        exampleKind: result.exampleKind,
        status: result.status,
        entryId: result.entryId,
        catalogSnapshotHash: result.catalogSnapshotHash,
        blockers: result.blockers,
        stateMutations: result.stateMutations,
        ioOperations: result.ioOperations,
        recurringEnabled: result.recurringEnabled,
      }
    : {
        programHash: result.program.programHash,
        dagHash: result.lowering.dagHash,
        taskPlanHash: result.lowering.taskPlanHash,
        thirdSchedulerIntroduced: result.lowering.thirdSchedulerIntroduced,
        stateMutations: result.stateMutations,
        ioOperations: result.ioOperations,
      }).sort((left, right) => String(left.programHash ?? left.exampleHash)
        .localeCompare(String(right.programHash ?? right.exampleHash)));
  const expectedCompilerReportHash = hashXhsRpa(compilerRows);
  const expectedLedgerReportHash = hashXhsRpa(ledgerStatuses.filter(Boolean)
    .sort((left, right) => left.programId.localeCompare(right.programId)));
  const expectedJournalReportHash = hashXhsRpa({
    tickId: receipt.tickId,
    journalHeadHash: receipt.journalHeadHash,
    journalLength: receipt.journalLength,
  });
  const expectedKillReportHash = hashXhsRpa({
    killGeneration: receipt.killGeneration,
    activeTicks: status.activeTicks,
    recurringEnabled: status.recurringEnabled,
  });
  if (!exact(gateReport, gateKeys) || !contentAddressed(gateReport, "xw.xhs.rpa-gate-report.v1")
    || gateReport.formalReleaseBinding !== formalReleaseBinding
    || gateReport.catalogReportHash !== catalogEligibilityReport.reportHash
    || gateReport.manualReceiptHash !== receipt.receiptHash
    || gateReport.compilerReportHash !== expectedCompilerReportHash
    || gateReport.ledgerReportHash !== expectedLedgerReportHash
    || gateReport.journalReportHash !== expectedJournalReportHash
    || gateReport.killReportHash !== expectedKillReportHash
    || JSON.stringify(gateReport.programHashes) !== JSON.stringify(programs
      .map((entry) => entry?.program?.programHash ?? entry.exampleHash).sort())) {
    fail("XHS_RPA_CLOSEOUT_GATE_INVALID", "compiler/ledger/journal/kill gate evidence is missing or unbound");
  }
  const closeoutBody = {
    schemaId: "xw.xhs.v3-rpa-closeout.v1",
    RPA_FOUNDATION_VERIFIED: true,
    RPA_RECURRING_ENABLED: false,
    recurringTaskCount: 0,
    formalReleaseBinding,
    manualReceiptHash: receipt.receiptHash,
    catalogEligibilityReportHash: catalogEligibilityReport.reportHash,
    gateReportHash: gateReport.reportHash,
    examples: Object.freeze(programs.map((entry) => entry?.program
      ? Object.freeze({
          exampleKind: entry.exampleKind,
          status: "SEALED",
          programHash: entry.program.programHash,
          taskPlanHash: entry.program.taskPlanHash,
        })
      : Object.freeze({
          exampleKind: entry.exampleKind,
          status: entry.status,
          exampleHash: entry.exampleHash,
          entryId: entry.entryId,
          blockers: entry.blockers,
        })).sort((a, b) => a.exampleKind.localeCompare(b.exampleKind))),
  };
  return Object.freeze({ ...closeoutBody, closeoutHash: hashXhsRpa(closeoutBody) });
}
