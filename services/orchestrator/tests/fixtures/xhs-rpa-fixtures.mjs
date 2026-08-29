import {
  compileXhsRpaProgram,
  hashXhsRpa,
  projectXhsRpaCatalog,
} from "../../scripts/lib/xhs-rpa-program.mjs";

export const RPA_NOW = 1_788_012_000_000;
export const RPA_ACCOUNT = "a".repeat(64);
export const RPA_RUNTIME = Object.freeze({
  releaseId: "xhs-v3-formal-20260830",
  sourceCommit: "b".repeat(40),
});
export const ZERO_SAFETY = Object.freeze({
  likes: 0,
  comments: 0,
  follows: 0,
  shares: 0,
  saves: 0,
  publishes: 0,
  messages: 0,
  socialAuthorityDelta: 0,
  socialReservationDelta: 0,
  socialTransportDelta: 0,
});
export const CLEAN = Object.freeze({ restored: true, zeroOwnedLeases: true, ownedLeaseCount: 0 });

const chars = Object.freeze({
  "xhs.feed.read": "1",
  "xhs.scout.read": "2",
  "xhs.explore.read": "3",
  "xhs.search.candidate": "4",
  "xhs.browse.candidate": "5",
  "xhs.social.bad": "6",
  "xhs.inactive.read": "7",
  "xhs.stale.read": "8",
  "xhs.missing.acceptance": "9",
});

function entry(entryId, overrides = {}) {
  const marker = chars[entryId];
  const session = entryId === "xhs.explore.read";
  return {
    entryId,
    kind: "routine_template",
    revision: 1,
    descriptorHash: marker.repeat(64),
    templateHash: (Number(marker) % 9 + 1).toString().repeat(64),
    effectClass: "none",
    placement: session ? { mode: "exact_pair", aliases: ["03", "04"] } : { mode: "fixed", aliases: ["03"] },
    maturity: "accepted",
    status: "active",
    releaseId: RPA_RUNTIME.releaseId,
    sourceCommit: RPA_RUNTIME.sourceCommit,
    acceptanceReceiptHashes: ["c".repeat(64)],
    runner: {
      kind: session ? "session_workflow" : "typed_job",
      capabilityId: session ? "xiaowei.explorer.primitive" : `${entryId}.capability`,
      appId: "xiaowei",
      workflowId: session ? "xhs.explore.workflow" : null,
      contractHash: "d".repeat(64),
    },
    cleanupContractHash: "e".repeat(64),
    expectedReceiptSchema: session ? "xw.xhs.exploration-receipt.v1" : "xhs.work-receipt.v2",
    ...overrides,
  };
}

export function makeCatalog() {
  return projectXhsRpaCatalog({
    runtime: RPA_RUNTIME,
    entries: [
      entry("xhs.feed.read"),
      entry("xhs.scout.read"),
      entry("xhs.explore.read"),
      entry("xhs.search.candidate", { maturity: "candidate" }),
      entry("xhs.browse.candidate", { maturity: "candidate" }),
      entry("xhs.social.bad", { effectClass: "social" }),
      entry("xhs.inactive.read", { status: "inactive" }),
      entry("xhs.stale.read", { releaseId: "xhs-v3-old-release" }),
      entry("xhs.missing.acceptance", { acceptanceReceiptHashes: [] }),
    ],
  });
}

export function makeProgram(exampleKind = "feed", options = {}) {
  const catalogSnapshot = options.catalogSnapshot ?? makeCatalog();
  const entryId = options.entryId ?? `xhs.${exampleKind}.read`;
  const selected = catalogSnapshot.entries.find((item) => item.entryId === entryId);
  const catalogRef = Object.fromEntries([
    "entryId", "kind", "revision", "templateHash", "descriptorHash", "effectClass",
    "placement", "maturity", "status", "acceptanceReceiptHashes", "runner",
    "cleanupContractHash", "expectedReceiptSchema",
  ].map((key) => [key, selected[key]]));
  const program = compileXhsRpaProgram({
    programId: options.programId ?? `xrp_${exampleKind}_foundation`,
    programVersion: options.programVersion ?? 1,
    ownerRef: options.ownerRef ?? "own_xhs_v3_rpa_foundation",
    accountRef: options.accountRef ?? RPA_ACCOUNT,
    generation: options.generation ?? 1,
    rollbackGeneration: options.rollbackGeneration ?? 0,
    catalogSnapshot,
    pacing: options.pacing ?? {},
    ...(Object.hasOwn(options, "seedPolicy") ? { seedPolicy: options.seedPolicy } : {}),
    ...(Object.hasOwn(options, "budgetPolicy") ? { budgetPolicy: options.budgetPolicy } : {}),
    ...(Object.hasOwn(options, "failurePolicy") ? { failurePolicy: options.failurePolicy } : {}),
    ...(Object.hasOwn(options, "misfirePolicy") ? { misfirePolicy: options.misfirePolicy } : {}),
    ...(Object.hasOwn(options, "evidencePolicy") ? { evidencePolicy: options.evidencePolicy } : {}),
    ...(Object.hasOwn(options, "retentionPolicy") ? { retentionPolicy: options.retentionPolicy } : {}),
    ...(Object.hasOwn(options, "externalEffects") ? { externalEffects: options.externalEffects } : {}),
    ...(Object.hasOwn(options, "writeTransportBudget") ? { writeTransportBudget: options.writeTransportBudget } : {}),
    ...(Object.hasOwn(options, "forbiddenActions") ? { forbiddenActions: options.forbiddenActions } : {}),
    nodes: [{
      nodeId: `${exampleKind}_read`,
      catalogRef: options.catalogRef ?? catalogRef,
      fixedParams: options.params ?? { limit: 3, mode: "read_only" },
      inputPrivateRefs: options.inputPrivateRefs ?? [],
      dependsOn: [],
    }],
  });
  return Object.freeze({ exampleKind, program, catalogSnapshot });
}

export function p6Artifact(program) {
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

export function childReceipt(nodeId = "feed_read", schemaId = "xhs.work-receipt.v2", cleanupContractHash = "e".repeat(64)) {
  return Object.freeze({
    nodeId,
    schemaId,
    receiptHash: "1".repeat(64),
    cleanupContractHash,
    committed: true,
    safety: ZERO_SAFETY,
    cleanup: CLEAN,
  });
}
