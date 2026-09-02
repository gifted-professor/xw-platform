/**
 * Derived proof for the single CP-owned V3 exploration budget ledger.
 *
 * This module never owns mutable budget state.  It seals the reservation rows
 * returned by the control plane and mechanically reconciles them with the
 * final authority view.  The SQLite `exploration_reservations` table remains
 * the only budget ledger.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "./xhs-exploration-mission.mjs";

export const XHS_V3_SHARED_BUDGET_RESERVATION_SCHEMA_ID =
  "xw.xhs.v3-shared-budget-reservation.v1";
export const XHS_V3_SHARED_BUDGET_PROOF_SCHEMA_ID =
  "xw.xhs.v3-shared-budget-proof.v1";

const HEX64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const RESERVATION_STATES = new Set(["reserved", "consumed", "failed"]);
const RECEIPT_KINDS = new Set([
  "reservedPrimitives",
  "novelOpens",
  "resultScreensPerQuery",
  "commentScreens",
]);
const PROOF_CAPS = Object.freeze([
  "reservedPrimitives",
  "novelOpens",
  "resultScreensPerQuery",
  "commentScreens",
  "visionAnalysisAttempts",
  "visionMaxIssuedPermits",
  "visionMaxPhysicalTaps",
]);
const LEDGER_KIND_TO_CAP = Object.freeze({
  primitives: "reservedPrimitives",
  novelOpens: "novelOpens",
  resultScreens: "resultScreensPerQuery",
  commentScreens: "commentScreens",
  visionAnalysis: "visionAnalysisAttempts",
  visionPermits: "visionMaxIssuedPermits",
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hashBody(schemaId, body) {
  return sha256(`${schemaId}:${canonicalJson(body)}`);
}

function exactObject(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key)));
}

function safeCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `${name} must be a non-negative safe integer`);
  }
  return value;
}

export function sharedBudgetKindForNavigationRole(navigationRole) {
  if (navigationRole === "OPEN_CONTENT_CARD") return "novelOpens";
  if (navigationRole === "SCROLL_RESULTS") return "resultScreens";
  if (["OPEN_COMMENT_PANEL", "SCROLL_COMMENTS"].includes(navigationRole)) return "commentScreens";
  return null;
}

/** Bind one persisted CP reservation response to its exact lane operation. */
export function sealSharedBudgetReservation({
  reservation,
  authorityId,
  missionHash,
  alias,
  operationHash,
  navigationRole,
  expectedKind,
  expectedCap,
} = {}) {
  const keys = [
    "reservationId", "kind", "alias", "amount", "used", "cap", "state", "operationHash",
  ];
  if (!exactObject(reservation, keys)
    || !SAFE_ID.test(String(reservation.reservationId ?? ""))
    || !RECEIPT_KINDS.has(expectedKind)
    || reservation.kind !== expectedKind
    || reservation.alias !== alias
    || reservation.amount !== 1
    || !Number.isSafeInteger(reservation.used) || reservation.used < 1
    || !Number.isSafeInteger(reservation.cap) || reservation.cap < 0
    || reservation.used > reservation.cap
    || reservation.cap !== expectedCap
    || !RESERVATION_STATES.has(reservation.state)
    || !HEX64.test(String(operationHash ?? ""))
    || reservation.operationHash !== operationHash
    || !SAFE_ID.test(String(authorityId ?? ""))
    || !HEX64.test(String(missionHash ?? ""))
    || !["03", "04"].includes(alias)
    || !SAFE_ID.test(String(navigationRole ?? ""))) {
    fail(
      "XHS_V3_SHARED_BUDGET_RESERVATION_INVALID",
      "CP shared-budget reservation response is malformed or rebound",
    );
  }
  const body = Object.freeze({
    schemaId: XHS_V3_SHARED_BUDGET_RESERVATION_SCHEMA_ID,
    authorityId,
    missionHash,
    alias,
    operationHash,
    navigationRole,
    reservationId: reservation.reservationId,
    kind: reservation.kind,
    amount: reservation.amount,
    used: reservation.used,
    cap: reservation.cap,
    state: reservation.state,
  });
  return Object.freeze({
    ...body,
    receiptHash: hashBody(XHS_V3_SHARED_BUDGET_RESERVATION_SCHEMA_ID, body),
  });
}

function normalizeReservationReceipt(value, { authorityId, missionHash, alias, caps }) {
  const keys = [
    "schemaId", "authorityId", "missionHash", "alias", "operationHash", "navigationRole",
    "reservationId", "kind", "amount", "used", "cap", "state", "receiptHash",
  ];
  if (!exactObject(value, keys)
    || value.schemaId !== XHS_V3_SHARED_BUDGET_RESERVATION_SCHEMA_ID
    || value.authorityId !== authorityId || value.missionHash !== missionHash || value.alias !== alias
    || !HEX64.test(String(value.operationHash ?? ""))
    || !SAFE_ID.test(String(value.navigationRole ?? ""))
    || !SAFE_ID.test(String(value.reservationId ?? ""))
    || !RECEIPT_KINDS.has(value.kind)
    || value.amount !== 1
    || !Number.isSafeInteger(value.used) || value.used < 1
    || value.cap !== caps[value.kind] || value.used > value.cap
    || !RESERVATION_STATES.has(value.state)
    || !HEX64.test(String(value.receiptHash ?? ""))) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "lane budget receipt is malformed or rebound");
  }
  const { receiptHash, ...body } = value;
  if (receiptHash !== hashBody(XHS_V3_SHARED_BUDGET_RESERVATION_SCHEMA_ID, body)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "lane budget receipt content address drifted");
  }
  if ((value.kind === "novelOpens" && value.navigationRole !== "OPEN_CONTENT_CARD")
    || (value.kind === "resultScreensPerQuery" && value.navigationRole !== "SCROLL_RESULTS")
    || (value.kind === "commentScreens"
      && !["OPEN_COMMENT_PANEL", "SCROLL_COMMENTS"].includes(value.navigationRole))) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "budget kind is not bound to its closed navigation role");
  }
  return value;
}

function normalizeLedger(ledger, { authorityId, missionHash }) {
  const keys = ["schemaId", "authorityId", "missionHash", "caps", "rows", "totals", "ledgerHash"];
  if (!exactObject(ledger, keys)
    || ledger.schemaId !== "xw.xhs.exploration-budget-ledger-view.v1"
    || ledger.authorityId !== authorityId || ledger.missionHash !== missionHash
    || !Array.isArray(ledger.rows)
    || !HEX64.test(String(ledger.ledgerHash ?? ""))) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "final CP authority budget ledger is absent or malformed");
  }
  const caps = {};
  for (const name of PROOF_CAPS) caps[name] = safeCount(ledger.caps?.[name], `cap.${name}`);
  const rowKeys = ["reservationId", "kind", "capName", "alias", "amount", "state", "operationHash"];
  const ids = new Set();
  const operationHashes = new Set();
  const totals = Object.fromEntries(PROOF_CAPS.map((name) => [name, 0]));
  for (const row of ledger.rows) {
    if (!exactObject(row, rowKeys)
      || !SAFE_ID.test(String(row.reservationId ?? ""))
      || LEDGER_KIND_TO_CAP[row.kind] !== row.capName
      || !PROOF_CAPS.includes(row.capName)
      || !["03", "04", null].includes(row.alias)
      || !Number.isSafeInteger(row.amount) || row.amount <= 0
      || !RESERVATION_STATES.has(row.state)
      || !HEX64.test(String(row.operationHash ?? ""))
      || ids.has(row.reservationId) || operationHashes.has(row.operationHash)) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "CP budget ledger row is malformed, duplicate, or unbound");
    }
    ids.add(row.reservationId);
    operationHashes.add(row.operationHash);
    totals[row.capName] += row.amount;
  }
  for (const name of PROOF_CAPS) {
    if (ledger.totals?.[name] !== totals[name] || totals[name] > caps[name]) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `CP shared budget ${name} exceeds or disagrees with its cap`);
    }
  }
  const { ledgerHash, ...body } = ledger;
  if (ledgerHash !== hashBody(ledger.schemaId, body)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "CP budget ledger content address drifted");
  }
  return { ledger, caps, totals };
}

/**
 * Reconcile task-persisted lane receipts with every persisted CP reservation
 * row. Reserved and failed rows count exactly like consumed rows.
 */
export function deriveSharedExplorationBudgetProof({
  phase,
  authorityId,
  missionHash,
  children,
  budgetLedger,
  visionCounters,
} = {}) {
  if (!XHS_V3_PHASES.has(phase)
    || !SAFE_ID.test(String(authorityId ?? ""))
    || !HEX64.test(String(missionHash ?? ""))
    || !Array.isArray(children) || children.length !== 2
    || canonicalJson(children.map((child) => child?.alias)) !== canonicalJson(["03", "04"])) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "shared-budget proof lacks the exact phase/authority/lane pair");
  }
  const normalizedLedger = normalizeLedger(budgetLedger, { authorityId, missionHash });
  const { caps, totals } = normalizedLedger;
  const receipts = [];
  for (const child of children) {
    if (!Array.isArray(child?.receipt?.budgetReservations)) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `lane ${child?.alias} lacks CP budget receipts`);
    }
    for (const receipt of child.receipt.budgetReservations) {
      receipts.push(normalizeReservationReceipt(receipt, {
        authorityId,
        missionHash,
        alias: child.alias,
        caps,
      }));
    }
    const primitiveCount = child.receipt.budgetReservations
      .filter((receipt) => receipt.kind === "reservedPrimitives").length;
    if (child.receipt?.driver?.consumedPermits !== primitiveCount) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `lane ${child.alias} primitive receipts do not match consumed permits`);
    }
    for (const [field, kind] of [["novelOpensUsed", "novelOpens"], ["commentScreensUsed", "commentScreens"]]) {
      const localUsed = safeCount(child.receipt?.state?.[field], `lane.${child.alias}.${field}`);
      const reserved = child.receipt.budgetReservations.filter((receipt) => receipt.kind === kind).length;
      if (localUsed > reserved) {
        fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `lane ${child.alias} local ${kind} exceeds its authority reservations`);
      }
    }
  }
  const receiptIds = new Set();
  const receiptOperations = new Set();
  const receiptByKind = Object.fromEntries([...RECEIPT_KINDS].map((kind) => [kind, []]));
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.reservationId) || receiptOperations.has(receipt.operationHash)) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "lane budget receipt id/operation replayed across the pair");
    }
    receiptIds.add(receipt.reservationId);
    receiptOperations.add(receipt.operationHash);
    receiptByKind[receipt.kind].push(receipt);
  }

  const ledgerRowsByCap = Object.fromEntries(PROOF_CAPS.map((name) => [name, []]));
  for (const row of normalizedLedger.ledger.rows) ledgerRowsByCap[row.capName].push(row);
  for (const kind of RECEIPT_KINDS) {
    const ledgerRows = ledgerRowsByCap[kind];
    const rowsById = new Map(ledgerRows.map((row) => [row.reservationId, row]));
    if (ledgerRows.length !== receiptByKind[kind].length) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `${kind} has hidden or missing CP reservation rows`);
    }
    for (const receipt of receiptByKind[kind]) {
      const row = rowsById.get(receipt.reservationId);
      if (!row || row.alias !== receipt.alias || row.amount !== receipt.amount
        || row.state !== receipt.state || row.operationHash !== receipt.operationHash) {
        fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `${kind} lane receipt differs from its persisted CP row`);
      }
    }
    const used = receiptByKind[kind].map((receipt) => receipt.used).sort((a, b) => a - b);
    if (canonicalJson(used) !== canonicalJson(Array.from({ length: used.length }, (_v, index) => index + 1))) {
      fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `${kind} global used sequence is not contiguous`);
    }
  }

  const visionKeys = ["analysisAttempts", "permitsIssued", "permitsConsumed", "physicalTaps"];
  if (!exactObject(visionCounters, visionKeys)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "CP vision counters are malformed");
  }
  for (const key of visionKeys) safeCount(visionCounters[key], `vision.${key}`);
  if (totals.visionAnalysisAttempts !== visionCounters.analysisAttempts
    || totals.visionMaxIssuedPermits !== visionCounters.permitsIssued
    || visionCounters.permitsConsumed > visionCounters.permitsIssued
    || visionCounters.physicalTaps > visionCounters.permitsConsumed
    || visionCounters.physicalTaps > caps.visionMaxPhysicalTaps) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "CP vision rows/counters do not form one bounded authority chain");
  }
  const localVision = children.reduce((sum, child) => ({
    analysisAttempts: sum.analysisAttempts + safeCount(child.receipt?.vision?.analysisAttempts, "lane.vision.analysisAttempts"),
    permitsIssued: sum.permitsIssued + safeCount(child.receipt?.vision?.permitsIssued, "lane.vision.permitsIssued"),
    permitsConsumed: sum.permitsConsumed + safeCount(child.receipt?.vision?.permitsConsumed, "lane.vision.permitsConsumed"),
    physicalTaps: sum.physicalTaps + safeCount(child.receipt?.vision?.physicalTaps, "lane.vision.physicalTaps"),
  }), { analysisAttempts: 0, permitsIssued: 0, permitsConsumed: 0, physicalTaps: 0 });
  if (["permitsIssued", "permitsConsumed", "physicalTaps"]
    .some((key) => localVision[key] > visionCounters[key])) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "lane-local vision counters exceed the persisted CP authority counters");
  }
  const alias04 = children.find((child) => child.alias === "04");
  if (["permitsIssued", "permitsConsumed", "physicalTaps"]
    .some((key) => safeCount(alias04.receipt?.vision?.[key], `lane.04.vision.${key}`) !== 0)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "alias 04 carried visual permit/physical authority");
  }
  if (["R1", "R2", "R4"].includes(phase)
    && [visionCounters.permitsIssued, visionCounters.permitsConsumed, visionCounters.physicalTaps]
      .some((value) => value !== 0)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", `${phase} did not preserve visual hard zero`);
  }
  if (phase === "R3" && (visionCounters.permitsIssued > 1 || visionCounters.physicalTaps > 1)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "R3 exceeded the authority-global visual one-shot");
  }

  const body = Object.freeze({
    schemaId: XHS_V3_SHARED_BUDGET_PROOF_SCHEMA_ID,
    phase,
    authorityId,
    missionHash,
    ledgerHash: normalizedLedger.ledger.ledgerHash,
    caps: Object.freeze({ ...caps }),
    used: Object.freeze({
      totalSteps: totals.reservedPrimitives,
      novelOpens: totals.novelOpens,
      resultScreens: totals.resultScreensPerQuery,
      commentScreens: totals.commentScreens,
      visionAnalysisAttempts: visionCounters.analysisAttempts,
      visualPermitsIssued: visionCounters.permitsIssued,
      visualPermitsConsumed: visionCounters.permitsConsumed,
      visualPhysicalTaps: visionCounters.physicalTaps,
    }),
    reservationCount: normalizedLedger.ledger.rows.length,
    reservationReceiptsSha256: sha256(receipts.map((receipt) => receipt.receiptHash).sort().join("\n")),
    operationSetSha256: sha256(normalizedLedger.ledger.rows.map((row) => row.operationHash).sort().join("\n")),
  });
  return Object.freeze({
    ...body,
    proofHash: hashBody(XHS_V3_SHARED_BUDGET_PROOF_SCHEMA_ID, body),
  });
}

const XHS_V3_PHASES = new Set(["R1", "R2", "R3", "R4"]);

/** Recompute a persisted run's proof; never trust its derived summary. */
export function verifyPersistedSharedExplorationBudgetProof({ result, phase, missionHash } = {}) {
  const derived = deriveSharedExplorationBudgetProof({
    phase,
    authorityId: result?.authorityId,
    missionHash,
    children: result?.children,
    budgetLedger: result?.view?.budgetLedger,
    visionCounters: result?.view?.visionCounters,
  });
  if (canonicalJson(derived) !== canonicalJson(result?.sharedBudget)) {
    fail("XHS_V3_SHARED_BUDGET_PROOF_INVALID", "persisted shared-budget proof differs from CP authority/receipt evidence");
  }
  return derived;
}
