// routine-comment-chain.mjs — grounded comment chain for the 04 XHS routine
// (direct-routine plan V2 §8). The chain is deliberately split so no single
// surface can send:
//
//   1. note_context receipt  — server-built from the CP-owned observation;
//                              binds target/title/body/comment digest/evidence.
//   2. draft_from_context    — LLM only ever sees the receipt and only returns
//                              TEXT; the CP assembles the sealed draft. TTL is
//                              fixed at 60s, bound to routineRunId +
//                              targetFingerprint + detailStateVersion +
//                              sourceObservationHash.
//   3. deterministic validator — evidence refs, duplicates, length, links/
//                              solicitation, sensitive data, fabricated
//                              first-person experience. Fail => skip, never
//                              "send something to fill the quota".
//   4. bound_send            — accepts ONLY a server-sealed draftId. TTL
//                              expiry, detailStateVersion drift, or a fresh
//                              observation hash that no longer matches the
//                              source invalidates the draft before transport.
//   5. reconcile             — read-only append of verified_late /
//                              unresolved_final; never re-sends, never
//                              restores a slot, never rewrites the ambiguous row.
//
// The LLM interface is structurally unable to decide send/tap/retry: the
// bridge passes the receipt to llm.draft and reads only `text` (+ metadata)
// from the result — extra fields cannot reach the transport.
import { createHash } from "node:crypto";

export const COMMENT_DRAFT_TTL_MS = 60_000;

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function textHashOf(text) {
  return sha256Hex(String(text ?? ""));
}

/** Deterministic draft id: content-bound, timestamp-free. */
export function sealedDraftId({ routineRunId, targetFingerprint, sourceObservationHash, textHash }) {
  return sha256Hex([routineRunId, targetFingerprint, sourceObservationHash, textHash].join("\0"));
}

export const DRAFT_VALIDATION_RULES = Object.freeze({
  minLength: 4,
  maxLength: 80,
});

const FORBIDDEN_PATTERNS = Object.freeze([
  { flag: "link", re: /https?:\/\/|www\./i },
  { flag: "solicitation", re: /加(?:我)?(?:微信|好友|群)|私聊|代购|威信|\bvx\b/i },
  { flag: "sensitive_info", re: /1[3-9]\d{9}|身份证|\b\d{6}\b\s*年/ },
  { flag: "fabricated_first_person", re: /亲测|我(?:试过|上次|用过|买过|去过)/ },
]);

/**
 * Deterministic draft validator (plan V2 §8.3). Returns
 * { ok: true, riskFlags } or { ok: false, reason, riskFlags }.
 *
 * Semantic contradiction with the note is covered upstream: the LLM is only
 * ever given the server receipt, so a draft cannot be grounded in anything
 * else; here we enforce the enumerable hard gates.
 */
export function validateDraft({ draft, receipt, recentTextHashes = [] }) {
  const riskFlags = [];
  const fail = (reason) => ({ ok: false, reason, riskFlags });
  const text = String(draft?.text ?? "");
  if (text.trim().length < DRAFT_VALIDATION_RULES.minLength) return fail("draft_too_short");
  if (text.length > DRAFT_VALIDATION_RULES.maxLength) return fail("draft_too_long");
  for (const { flag, re } of FORBIDDEN_PATTERNS) {
    if (re.test(text)) {
      riskFlags.push(flag);
      if (flag !== "sensitive_info") return fail(`draft_${flag}`);
      // sensitive data is always a hard reject too
      return fail(`draft_${flag}`);
    }
  }
  // evidence: refs must exist and be anchored in the receipt's evidence set
  const refs = Array.isArray(draft?.evidenceRefs) ? draft.evidenceRefs : [];
  if (refs.length === 0) return fail("draft_evidence_missing");
  const evidenceSet = new Set(receipt.evidenceHashes);
  if (refs.some((r) => !evidenceSet.has(r))) return fail("draft_evidence_unbound");
  // duplicate text within the run — never send the same comment twice
  const th = textHashOf(text);
  if (recentTextHashes.includes(th)) return fail("draft_duplicate_text");
  return { ok: true, riskFlags };
}

/**
 * Assemble + seal a draft on the server from an LLM text result and a stored
 * receipt. The LLM contributes ONLY `text`; every binding field is derived
 * here. The draft is persisted via the supplied StateStore and only a stored
 * draftId can ever be sent.
 */
export function sealDraftFromReceipt({ state, receipt, llmResult, recentTextHashes = [], accountFingerprint = null }) {
  if (!receipt || !receipt.receiptHash) throw new TypeError("sealed receipt required");
  const text = String(llmResult?.text ?? "");
  // the LLM's typed surface: only text (+ model/prompt metadata) is read — any
  // send/tap/retry fields it may return are dropped here by construction
  const draft = {
    receiptHash: receipt.receiptHash,
    routineRunId: receipt.routineRunId,
    planHash: receipt.planHash,
    targetFingerprint: receipt.targetFingerprint,
    detailStateVersion: receipt.detailStateVersion,
    text,
    textHash: textHashOf(text),
    sourceObservationHash: receipt.receiptHash,
    // evidence anchoring is chosen by the SERVER from the receipt's evidence set
    evidenceRefs: receipt.evidenceHashes,
    // V2.1: account binding is server-derived (authority tuple / receipt), the
    // LLM can never influence it
    accountFingerprint: accountFingerprint ?? receipt.accountFingerprint ?? null,
    modelId: String(llmResult?.modelId ?? "unknown"),
    promptHash: llmResult?.promptHash ?? null,
    riskFlags: [],
  };
  const verdict = validateDraft({ draft, receipt, recentTextHashes });
  draft.riskFlags = verdict.riskFlags;
  draft.validation = { ok: verdict.ok, reason: verdict.ok ? null : verdict.reason };
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason, riskFlags: verdict.riskFlags };
  }
  draft.draftId = sealedDraftId({
    routineRunId: draft.routineRunId,
    targetFingerprint: draft.targetFingerprint,
    sourceObservationHash: draft.sourceObservationHash,
    textHash: draft.textHash,
  });
  draft.draftHash = sha256Hex([
    draft.draftId, draft.receiptHash, draft.textHash, draft.modelId, draft.promptHash ?? "",
  ].join("\0"));
  draft.expiresAt = receipt.observedAt + COMMENT_DRAFT_TTL_MS;
  return { ok: true, draft: state.recordCommentDraft(draft) };
}

/**
 * Read-only reconcile for an ambiguous comment effect (§8 tail). Purely
 * observational: appends verified_late when the comment text is now visible,
 * otherwise unresolved_final. NEVER re-sends, NEVER restores a slot, NEVER
 * rewrites the original ambiguous record.
 */
export async function reconcileAmbiguousComment({ state, effectId, observeCommentPanel, textHash, clock = { nowMs: () => Date.now() } }) {
  const effect = state.db.prepare("SELECT * FROM routine_effects WHERE effect_id=?").get(effectId);
  if (!effect) {
    throw new TypeError(`unknown routine effect ${effectId}`);
  }
  if (effect.status !== "ambiguous") {
    throw new TypeError(`effect ${effectId} is not ambiguous (status=${effect.status})`);
  }
  const panel = await observeCommentPanel({ targetFingerprint: effect.target_hash });
  const found = Array.isArray(panel?.texts)
    && panel.texts.some((t) => textHashOf(t) === textHash);
  if (found) {
    return state.recordCommentReconcile({
      effectId,
      routineRunId: effect.routine_run_id,
      status: "verified_late",
      evidenceHash: panel.hash ?? null,
    });
  }
  return state.recordCommentReconcile({
    effectId,
    routineRunId: effect.routine_run_id,
    status: "unresolved_final",
    evidenceHash: panel?.hash ?? null,
  });
}

export { textHashOf as commentTextHash };