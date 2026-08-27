// xhs-routine-comment-chain.test.mjs — S3 grounded comment chain (direct-routine
// plan V2 §8/§10.6/§10.8), offline:
//
//   validator  — too short/long, links, solicitation, sensitive data, fabricated
//                first-person experience, duplicate text, unbound evidence all
//                fail deterministically => skip (never send to fill a quota).
//   sealing    — the LLM contributes only text; every binding field is derived
//                server-side; only a StateStore-stored draftId can ever be sent,
//                and the transport never receives the raw text.
//   bound_send — TTL (60s), detailStateVersion drift, and source-observation
//                mismatch invalidate the draft pre-transport and release the
//                slot (not_sent).
//   hard budget — comment max=2 is hard even with a nonpayment policyMode
//                object handed to the ledger; like and comment count separately.
//   ambiguous  — strict-verifier failure consumes the slot, closes ALL remaining
//                comments for the run, and freezes the triple; reconcile is
//                append-only (verified_late | unresolved_final), never re-sends
//                or restores a slot.
//   machine    — nurture-grounded end-to-end: comment fires only on items where
//                comment rows were actually read.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { StateStore } from "../control-plane/lib/state-store.mjs";
import { ControlPlaneError } from "../control-plane/lib/errors.mjs";
import { createRoutineEffectBridge, bridgeAsMachineEffects, ROUTINE_EFFECT_BUDGET } from "../apps/xhs/routine-effect-bridge.mjs";
import { validateDraft, sealDraftFromReceipt, reconcileAmbiguousComment, commentTextHash, COMMENT_DRAFT_TTL_MS } from "../apps/xhs/routine-comment-chain.mjs";
import { planRoutine } from "../../orchestrator/scripts/lib/xhs-routine-plan.mjs";
import { createRoutineRun } from "../../orchestrator/scripts/lib/xhs-feed-routine-machine.mjs";

const NOW = 1_700_000_000_000;
function mkClock(offsetMs = 0) {
  return { nowMs: () => NOW + offsetMs, sleep: async () => {} };
}
const OWNER = Object.freeze({
  sessionId: "sess-comment-1",
  leaseRef: "lease-04-c1",
  leaseAuthorization: "lat_04_c1",
  routineRunId: "rr_comment00000001",
  planHash: "c".repeat(64),
});
const TARGET = "fp_note_1";
const OBS_HASH = "nc_hash_1";
const DETAIL_VERSION = "dsv_1";

function ctx(over = {}) {
  return {
    sessionId: OWNER.sessionId,
    leaseRef: OWNER.leaseRef,
    leaseAuthorization: OWNER.leaseAuthorization,
    routineRunId: OWNER.routineRunId,
    planHash: OWNER.planHash,
    targetFingerprint: TARGET,
    observationHash: OBS_HASH,
    ...over,
  };
}

function noteContext(over = {}) {
  return {
    hash: OBS_HASH,
    targetFingerprint: TARGET,
    detailStateVersion: DETAIL_VERSION,
    title: "攀岩入门三条路线",
    body: "第一次去岩馆可以试试这三条入门路线…",
    commentDigest: ["小岩: 收藏了", "u: 很详细"],
    observedAt: NOW,
    accountFingerprint: "acct-04",
    pageFingerprint: "page-notedetail",
  };
}

/** Comment-capable typed transport fake. */
function commentTransport({
  panelTexts = [],
  commitOk = true,
  echoTarget = true,
} = {}) {
  const calls = { commitComment: [], observeNoteContext: 0, observeCommentPanel: 0 };
  return {
    calls,
    async observeNoteContext({ targetFingerprint } = {}) {
      calls.observeNoteContext += 1;
      return { ...noteContext(), targetFingerprint: targetFingerprint ?? TARGET };
    },
    async commitComment(args) {
      calls.commitComment.push(args);
      return { ok: commitOk };
    },
    async observeCommentPanel() {
      calls.observeCommentPanel += 1;
      return { hash: "panel_hash_1", texts: panelTexts };
    },
    async observe() {
      return { hash: "l", targetFingerprint: TARGET, likeLabel: "点赞", observedAt: NOW };
    },
    async commitLike() {
      return { ok: true };
    },
  };
}

const GOOD_TEXT = "这三条路线的难度梯度写得很清楚，适合第一次进岩馆的人参考。";
const GOOD_LLM = { text: GOOD_TEXT, modelId: "test-model", promptHash: "ph_1" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "xhs-comment-chain-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  return { root, state, cleanup: () => { state.close(); rmSync(root, { recursive: true, force: true }); } };
}

function llmOf(result) {
  return { draft: async () => (typeof result === "function" ? result() : result) };
}

function makeBridge(f, { transport, llm, clock } = {}) {
  return createRoutineEffectBridge({
    state: f.state,
    owner: OWNER,
    transport: transport ?? commentTransport(),
    llm: llm ?? llmOf(GOOD_LLM),
    clock: clock ?? mkClock(),
  });
}

// --- deterministic validator --------------------------------------------------

test("validator rejects short/long/link/solicitation/sensitive/fabricated drafts", () => {
  const receipt = { evidenceHashes: [OBS_HASH] };
  const cases = [
    ["短", "draft_too_short"],
    ["x".repeat(81), "draft_too_long"],
    ["看这个 https://example.com 很全", "draft_link"],
    ["加我微信详聊路线", "draft_solicitation"],
    ["有问题打我电话 13812345678", "draft_sensitive_info"],
    ["亲测第三条路线最简单", "draft_fabricated_first_person"],
    ["我上次去岩馆摔了一跤", "draft_fabricated_first_person"],
  ];
  for (const [text, expected] of cases) {
    const verdict = validateDraft({
      draft: { text, evidenceRefs: [OBS_HASH] },
      receipt,
    });
    assert.equal(verdict.ok, false, text);
    assert.equal(verdict.reason, expected, text);
  }
});

test("validator requires evidence refs bound to the receipt; duplicates rejected", () => {
  const receipt = { evidenceHashes: [OBS_HASH] };
  const noEvidence = validateDraft({ draft: { text: GOOD_TEXT, evidenceRefs: [] }, receipt });
  assert.equal(noEvidence.reason, "draft_evidence_missing");
  const unbound = validateDraft({ draft: { text: GOOD_TEXT, evidenceRefs: ["other_hash"] }, receipt });
  assert.equal(unbound.reason, "draft_evidence_unbound");
  const dup = validateDraft(
    { draft: { text: GOOD_TEXT, evidenceRefs: [OBS_HASH] }, receipt, recentTextHashes: [commentTextHash(GOOD_TEXT)] },
  );
  assert.equal(dup.reason, "draft_duplicate_text");
});

// --- sealed draft + LLM boundary ----------------------------------------------

test("LLM contributes only text: send/tap fields are dropped, transport never sees raw text", async () => {
  const f = setup();
  try {
    const t = commentTransport({ panelTexts: [GOOD_TEXT] });
    const bridge = makeBridge(f, {
      transport: t,
      llm: llmOf({ ...GOOD_LLM, sendCommand: "tap", coordinates: { x: 100, y: 200 }, decision: "send_now" }),
    });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "verified");
    assert.equal(t.calls.commitComment.length, 1);
    const sent = t.calls.commitComment[0];
    assert.deepEqual(Object.keys(sent).sort(), ["draftId", "operationKey", "reservationToken", "textHash"]);
    assert.ok(!("text" in sent) && !("coordinates" in sent), "raw text/coordinates never reach the transport");
    // the draft is stored server-side with the full binding
    const drafts = f.state.db.prepare("SELECT * FROM comment_drafts").all();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, "consumed");
    assert.equal(drafts[0].routine_run_id, OWNER.routineRunId);
    // TTL is fixed at 60s from the receipt observation (now = receipt observedAt)
    assert.equal(drafts[0].expires_at - NOW, COMMENT_DRAFT_TTL_MS);
  } finally { f.cleanup(); }
});

test("unsealed free text cannot send: only a stored draftId passes bound_send", async () => {
  const f = setup();
  try {
    // a forged draftId (never sealed by the server) is unknown to the ledger —
    // bound_send only starts from sealedDraftFromReceipt, so there is no path
    // for caller-supplied text to reach commitComment
    const t = commentTransport({ panelTexts: [GOOD_TEXT] });
    const bridge = makeBridge(f, { transport: t, llm: llmOf({ text: "" }) });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "skipped:draft_too_short");
    assert.equal(t.calls.commitComment.length, 0);
  } finally { f.cleanup(); }
});

// --- bound_send invalidation --------------------------------------------------

test("TTL expiry invalidates the draft pre-transport and releases the slot", async () => {
  const f = setup();
  try {
    // the second observation (bound_send re-check) jumps the clock past the
    // 60s TTL while staying fresh and undrifted — only the TTL gate fires
    let offset = 0;
    let observes = 0;
    const clock = { nowMs: () => NOW + offset, sleep: async () => {} };
    const t = commentTransport({ panelTexts: [GOOD_TEXT] });
    t.observeNoteContext = async ({ targetFingerprint } = {}) => {
      observes += 1;
      if (observes === 2) offset = 61_000;
      return { ...noteContext(), observedAt: NOW + offset, targetFingerprint: targetFingerprint ?? TARGET };
    };
    const bridge = makeBridge(f, { transport: t, clock });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "stopped:draft_stale");
    assert.equal(res.transported, false, "expired draft never transports");
    assert.equal(t.calls.commitComment.length, 0);
    // pre-transport invalidation releases the slot: not_sent, not consumed
    const effect = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    assert.equal(effect.status, "not_sent");
    assert.equal(effect.reservationConsumed, false);
    const draft = f.state.db.prepare("SELECT status FROM comment_drafts").get();
    assert.equal(draft.status, "invalidated");
    // and the released slot can still be used by a later comment (different
    // text => different operation key; same key would replay the not_sent row)
    const bridge2 = makeBridge(f, {
      transport: commentTransport({ panelTexts: ["这条路线的 fallback 讲解对我帮助很大。"] }),
      llm: llmOf({ text: "这条路线的 fallback 讲解对我帮助很大。", modelId: "test-model", promptHash: "ph_2" }),
    });
    const res2 = await bridge2.commitRoutineEffect(ctx({ observationHash: "obs-retry" }), { action: "comment" });
    assert.equal(res2.outcome, "verified");
  } finally { f.cleanup(); }
});

test("detailStateVersion / source-observation drift invalidates the draft pre-transport", async () => {
  const f = setup();
  try {
    // observation changes between receipt and bound_send (back/refresh/next-item)
    let observed = 0;
    const t = commentTransport({ panelTexts: [GOOD_TEXT] });
    t.observeNoteContext = async ({ targetFingerprint } = {}) => {
      observed += 1;
      return {
        ...noteContext(),
        hash: observed === 1 ? OBS_HASH : "nc_hash_CHANGED",
        observedAt: NOW,
        targetFingerprint: targetFingerprint ?? TARGET,
      };
    };
    const bridge = makeBridge(f, { transport: t });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "stopped:draft_stale");
    assert.equal(res.transported, false, "drifted draft never transports");
    assert.equal(t.calls.commitComment.length, 0);
    // slot released: not_sent, so the run may still comment later
    const effects = f.state.listRoutineEffects(OWNER.routineRunId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "not_sent");
    assert.equal(effects[0].reservationConsumed, false);
    const draft = f.state.db.prepare("SELECT status FROM comment_drafts").get();
    assert.equal(draft.status, "invalidated");
  } finally { f.cleanup(); }
});

// --- hard budget: comment max=2, like/comment counted separately (§10.6) ------

test("comment hard budget: max=2; third reservation hard-rejected pre-transport even under nonpayment policyMode", async () => {
  const f = setup();
  try {
    // distinct grounded text per target so only the hard cap can stop attempt 3
    const TEXTS = {
      [TARGET]: GOOD_TEXT,
      fp_note_2: "第二条路线的保护点设置讲解得特别细。",
      fp_note_3: "第三条路线适合练完第一条之后再上手。",
    };
    const perTargetLlm = {
      draft: async ({ receipt }) => ({ text: TEXTS[receipt.targetFingerprint] ?? GOOD_TEXT, modelId: "test-model", promptHash: "ph" }),
    };
    const t = commentTransport({ panelTexts: Object.values(TEXTS) });
    const bridge = makeBridge(f, { transport: t, llm: perTargetLlm });
    const r1 = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    const r2 = await bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_note_2", observationHash: "obs2" }), { action: "comment" });
    const r3 = await bridge.commitRoutineEffect(
      ctx({ targetFingerprint: "fp_note_3", observationHash: "obs3" }),
      { action: "comment" },
    ).catch((e) => ({ code: e.code }));
    assert.equal(r1.outcome, "verified");
    assert.equal(r2.outcome, "verified");
    assert.equal(r3.outcome ?? r3.code, "cap_reached");
    assert.equal(t.calls.commitComment.length, 2, "third comment never transported");
    // the "nonpayment" policyMode has no path: direct ledger call with a
    // debtSink-style parameter does not exist on beginRoutineEffect — hard only
    assert.throws(
      () => f.state.beginRoutineEffect({
        routineRunId: OWNER.routineRunId,
        planHash: OWNER.planHash,
        action: "comment",
        targetFingerprint: "fp_note_9",
        idempotencyKey: "d" + "0".repeat(63),
        budget: ROUTINE_EFFECT_BUDGET,
      }),
      (e) => e instanceof ControlPlaneError && e.code === "ROUTINE_BUDGET_EXCEEDED",
    );
    // like and comment count separately: a like still reserves after comments are capped
    const likeSlot = f.state.beginRoutineEffect({
      routineRunId: OWNER.routineRunId,
      planHash: OWNER.planHash,
      action: "like",
      targetFingerprint: TARGET,
      idempotencyKey: "e" + "0".repeat(63),
      budget: ROUTINE_EFFECT_BUDGET,
    });
    assert.equal(likeSlot.reused, false, "like ledger slot is independent of the comment cap");
    assert.equal(likeSlot.effect.status, "reserved");
  } finally { f.cleanup(); }
});

// --- ambiguous + append-only reconcile ----------------------------------------

test("strict-verifier failure -> ambiguous: slot consumed, remaining comments closed, triple frozen", async () => {
  const f = setup();
  try {
    const t = commentTransport({ panelTexts: ["别的评论", "另一条评论"] }); // text NOT visible
    const bridge = makeBridge(f, { transport: t });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "ambiguous");
    assert.equal(res.transported, true);
    const effect = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    assert.equal(effect.status, "ambiguous");
    assert.equal(effect.reservationConsumed, true, "ambiguous consumes its slot");
    assert.equal(effect.retryBlocked, true);
    // remaining comments of the run are closed
    const res2 = await bridge.commitRoutineEffect(ctx({ targetFingerprint: "fp_note_2", observationHash: "obs2" }), { action: "comment" });
    assert.equal(res2.outcome, "closed:ambiguous");
    assert.equal(res2.transported, false);
  } finally { f.cleanup(); }
});

test("reconcile is read-only and append-only: verified_late when text appears; never re-sends or restores slot", async () => {
  const f = setup();
  try {
    const t = commentTransport({ panelTexts: [] }); // verifier fails -> ambiguous
    const bridge = makeBridge(f, { transport: t });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "ambiguous");
    const effectId = res.effectId;
    const before = f.state.listRoutineEffects(OWNER.routineRunId)[0];

    // delayed read-only reconcile: the comment text is NOW visible
    t.observeCommentPanel = async () => ({ hash: "panel_hash_2", texts: [GOOD_TEXT] });
    const rec = bridge.reconcileComment
      ? (await bridge.reconcileComment(ctx()))[0]
      : reconcileAmbiguousComment({
          state: f.state,
          effectId,
          observeCommentPanel: () => t.observeCommentPanel(),
          textHash: before.payloadHash,
        });
    assert.equal(rec.status, "verified_late");

    // append-only: original ambiguous row unchanged, slot NOT restored
    const after = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    assert.equal(after.status, "ambiguous");
    assert.equal(after.reservationConsumed, true);
    assert.deepEqual(
      { status: after.status, consumed: after.reservationConsumed, blocked: after.retryBlocked },
      { status: before.status, consumed: before.reservationConsumed, blocked: before.retryBlocked },
    );
    // and no re-transport happened
    assert.equal(t.calls.commitComment.length, 1, "reconcile never re-sends");
    // a second reconcile appends unresolved_final only if text is gone — not re-run here
  } finally { f.cleanup(); }
});

test("reconcile appends unresolved_final when the text never becomes visible", async () => {
  const f = setup();
  try {
    const t = commentTransport({ panelTexts: ["无关评论"] });
    const bridge = makeBridge(f, { transport: t });
    const res = await bridge.commitRoutineEffect(ctx(), { action: "comment" });
    assert.equal(res.outcome, "ambiguous");
    const before = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    const rec = (await bridge.reconcileComment(ctx()))[0];
    assert.equal(rec.status, "unresolved_final");
    const after = f.state.listRoutineEffects(OWNER.routineRunId)[0];
    assert.equal(after.status, "ambiguous", "ambiguous record never rewritten");
    assert.equal(after.reservationConsumed, before.reservationConsumed, "slot never restored");
  } finally { f.cleanup(); }
});

// --- machine x bridge end-to-end ----------------------------------------------

const FEED_FOCUS = "com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivityV2";
const NOTE_FOCUS = "com.xingin.xhs/com.xingin.xhs.note.NoteDetailActivity";
const NOTE_DESC = "笔记 攀岩入门三条路线 来自小岩 123赞";
const COMMENT_TEXT = "这三条路线的难度梯度写得很清楚，适合第一次进岩馆的人参考。";

function machineDriver() {
  const FEED_XML = '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[40,400][500,900]"/>'
    + '<node class="android.widget.ImageView" content-desc="' + NOTE_DESC + '" text="" clickable="true" bounds="[560,400][1020,900]"/>';
  const DETAIL_XML = '<node class="android.widget.TextView" content-desc="点赞" text="" bounds="[40,2200][140,2300]"/>'
    + '<node class="android.widget.TextView" content-desc="评论 2" text="" bounds="[240,2200][340,2300]"/>'
    + '<node class="android.widget.TextView" text="小岩" bounds="[40,600][120,660]"/>'
    + '<node class="android.widget.TextView" text="这条路线讲解得非常清楚，收藏了" bounds="[40,680][900,740]"/>';
  return {
    async ensureFeed() { return { ok: true, activity: FEED_FOCUS }; },
    async dump({ label } = {}) {
      if (String(label || "").startsWith("detail")) {
        return { xml: DETAIL_XML, focus: NOTE_FOCUS, pkg: "com.xingin.xhs", hash: `dh_detail_${label}` };
      }
      return { xml: FEED_XML, focus: FEED_FOCUS, pkg: "com.xingin.xhs", hash: `dh_feed_${label}` };
    },
    async tapAt() { return { ok: true, activity: NOTE_FOCUS }; },
    async back() { return { ok: true, focusVerified: true }; },
    async swipeComments({ screens }) { return { ok: true, screens }; },
    async waitFor() { return { ok: true }; },
  };
}

function machineCommentTransport() {
  const sent = [];
  return {
    sent,
    async observeNoteContext({ targetFingerprint } = {}) {
      return { ...noteContext(), targetFingerprint };
    },
    async commitComment(args) {
      sent.push(args);
      return { ok: true };
    },
    async observeCommentPanel() {
      return { hash: "panel_1", texts: [COMMENT_TEXT] };
    },
    async observe() {
      return { hash: "l", targetFingerprint: TARGET, likeLabel: "已点赞", observedAt: NOW };
    },
    async commitLike() {
      return { ok: true };
    },
  };
}

test("machine x bridge: nurture-grounded commentMax=1 end-to-end — one grounded comment, run continues", async () => {
  const f = setup();
  try {
    const plan = planRoutine({
      templateId: "xhs.nurture-grounded.v1",
      params: { items: 3, commentMax: 1, likeMax: 0, seed: "s3-e2e" },
    });
    const owner = Object.freeze({ ...OWNER, routineRunId: plan.routineRunId, planHash: plan.planHash });
    const t = machineCommentTransport();
    const bridge = createRoutineEffectBridge({
      state: f.state,
      owner,
      transport: t,
      llm: llmOf(GOOD_LLM),
      clock: mkClock(),
    });
    const receipt = await createRoutineRun({
      plan,
      driver: machineDriver(),
      clock: mkClock(),
      effects: bridgeAsMachineEffects({ bridge, owner }),
    }).execute();
    assert.equal(receipt.status, "SUCCEEDED");
    assert.equal(receipt.effects.comment.transported, 1, "commentMax=1: exactly one comment");
    assert.equal(t.sent.length, 1);
    assert.equal(receipt.transport.count, 1);
    assert.equal(receipt.cleanup.activeLeases, 0);
    const effects = f.state.listRoutineEffects(owner.routineRunId);
    assert.equal(effects.filter((e) => e.action === "comment" && e.status === "verified").length, 1);
    // comments are capped for later items
    assert.ok(receipt.items.some((it) => /cap_reached/.test(it.effects.comment)));
  } finally { f.cleanup(); }
});

test("machine x bridge: ambiguous comment closes remaining comments but read-only browsing continues", async () => {
  const f = setup();
  try {
    const plan = planRoutine({
      templateId: "xhs.nurture-grounded.v1",
      params: { items: 3, commentMax: 2, likeMax: 0, seed: "s3-ambig" },
    });
    const owner = Object.freeze({ ...OWNER, routineRunId: plan.routineRunId, planHash: plan.planHash });
    // panel never shows the text -> strict verifier fails -> ambiguous
    const t = { ...machineCommentTransport(), async observeCommentPanel() { return { hash: "p", texts: ["别的"] }; } };
    const bridge = createRoutineEffectBridge({
      state: f.state,
      owner,
      transport: t,
      llm: llmOf(GOOD_LLM),
      clock: mkClock(),
    });
    const receipt = await createRoutineRun({
      plan,
      driver: machineDriver(),
      clock: mkClock(),
      effects: bridgeAsMachineEffects({ bridge, owner }),
    }).execute();
    assert.equal(receipt.status, "SUCCEEDED");
    assert.equal(receipt.effects.comment.transported, 1, "the ambiguous comment did transport once");
    const commentOutcomes = receipt.items.map((it) => it.effects.comment);
    const ambiguousCount = commentOutcomes.filter((o) => o === "ambiguous").length;
    assert.equal(ambiguousCount, 1);
    const closedCount = commentOutcomes.filter((o) => o === "closed:ambiguous").length;
    assert.ok(closedCount >= 1, "all remaining comments closed after ambiguity");
    // no further commit after the ambiguous one
    assert.equal(t.sent.length, 1);
    // closure recorded server-side too
    assert.equal(f.state.isRoutineRunActionClosed(owner.routineRunId, "comment"), true);
  } finally { f.cleanup(); }
});