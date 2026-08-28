// xhs-routine-authority.test.mjs — direct-routine plan V2 §8.1: the CP-owned
// routine authority + typed effect RPC + production transport.
//
// Everything here runs against the REAL ControlPlane/adapter/primitive stack
// with only the vendor transport scripted: a fake 03 XHS device that serves a
// deterministic note-detail dump, flips the like control on tap, opens the
// comment editor on a comment-box tap, and appends the sent text as a comment
// row after send. Zero mocks inside control-plane.mjs / state-store.mjs /
// routine-effect-*.mjs — the harness proves the production wiring end to end:
//
//   registerRoutineAuthority   sealed canary policy, 03-only, server-hard caps
//   commitRoutineAuthorityEffect  like oracle → 1 tap → verified / replay /
//                              sealed-without-grant / binding mismatch
//   reconcile/close            authority lifecycle dies with the session
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CapabilityRegistry } from "../control-plane/lib/capability-registry.mjs";
import { AdapterRegistry, ControlPlane } from "../control-plane/lib/control-plane.mjs";
import { EvidenceStore } from "../control-plane/lib/evidence-store.mjs";
import { StateStore } from "../control-plane/lib/state-store.mjs";
import { createXiaoweiAdapter } from "../apps/xiaowei/adapter.mjs";

const registry = CapabilityRegistry.load(fileURLToPath(new URL("../apps", import.meta.url)));
const capability = registry.require("xiaowei.explorer.primitive");
const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));

const BRIDGE_IME = "com.android.xwkeyboard/.XwIME";
const DETAIL_FOCUS = "mCurrentFocus=com.xingin.xhs/com.xingin.xhs.commercial.note.NoteDetailActivity";

// --- scripted 03 device ------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function node({ text = "", desc = "", cls = "android.widget.TextView", clickable = false, focused = false, bounds }) {
  return [
    `<node index="0" class="${cls}" text="${esc(text)}"`,
    desc ? `content-desc="${esc(desc)}"` : null,
    clickable ? 'clickable="true"' : 'clickable="false"',
    focused ? 'focused="true"' : null,
    `bounds="${bounds}"/>`,
  ].filter(Boolean).join(" ");
}

const LIKE_BOUNDS = "[980,1780][1080,1880]";
const COLLECT_BOUNDS = "[760,1780][860,1880]";
const COMMENT_BOUNDS = "[540,1780][640,1880]";
const BOX_BOUNDS = "[40,1880][400,1940]";
const SEND_BOUNDS = "[900,1860][1040,1930]";
const EDIT_BOUNDS = "[40,1860][880,1930]";

function inBounds(bounds, x, y) {
  const m = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  const [L, T, R, B] = [+m[1], +m[2], +m[3], +m[4]];
  return x >= L && x <= R && y >= T && y <= B;
}

function detailXml(state) {
  const rows = ['<hierarchy rotation="0">'];
  rows.push(node({ text: state.title, bounds: "[60,220][1000,290]" }));
  rows.push(node({ text: "烘焙日记", bounds: "[60,300][220,340]" }));
  for (const t of state.commentSent) {
    rows.push(node({ text: t, bounds: "[120,900][1000,950]" }));
    rows.push(node({ text: "3", bounds: "[60,960][100,990]" }));
  }
  rows.push(node({ text: "这个配方我也试过，很好成功", bounds: "[120,780][1000,830]" }));
  rows.push(node({ text: "128", bounds: "[60,840][100,870]" }));
  // bottom bar: like / collect / comment count / comment box entry
  rows.push(node({ text: "", desc: state.liked ? "已点赞" : "点赞", cls: "android.widget.ImageView", clickable: true, bounds: LIKE_BOUNDS }));
  rows.push(node({ text: "", desc: "收藏", cls: "android.widget.ImageView", clickable: true, bounds: COLLECT_BOUNDS }));
  rows.push(node({ text: "", desc: "评论 32", cls: "android.widget.ImageView", clickable: true, bounds: COMMENT_BOUNDS }));
  if (state.editorOpen) {
    rows.push(node({ text: "", cls: "android.widget.EditText", focused: true, bounds: EDIT_BOUNDS }));
    rows.push(node({ text: "发送", cls: "android.widget.Button", clickable: true, bounds: SEND_BOUNDS }));
  } else {
    rows.push(node({ text: "", desc: "评论框", cls: "android.widget.TextView", clickable: true, bounds: BOX_BOUNDS }));
  }
  rows.push("</hierarchy>");
  return rows.join("");
}

function createDevice() {
  const state = {
    title: "手工烘焙欧包的完整流程分享",
    liked: false,
    editorOpen: false,
    commentSent: [],
    currentInput: null,
    taps: [],
    inputs: [],
  };
  const transport = {
    async invoke(input) {
      const action = input.action;
      if (action === "adb_shell") {
        const cmd = String(input.data?.command || "");
        if (cmd.includes("settings get secure default_input_method")) {
          return { code: 10000, data: BRIDGE_IME };
        }
        if (cmd.includes("dumpsys window")) {
          return { code: 10000, data: DETAIL_FOCUS };
        }
        if (cmd.includes("uiautomator dump")) {
          return { code: 10000, data: "" };
        }
        if (cmd.startsWith("base64")) {
          return { code: 10000, data: Buffer.from(detailXml(state), "utf8").toString("base64") };
        }
        if (cmd.startsWith("rm -f")) {
          return { code: 10000, data: "" };
        }
        if (cmd.startsWith("input tap")) {
          const [x, y] = cmd.split(" ").slice(2).map(Number);
          state.taps.push({ x, y });
          if (inBounds(LIKE_BOUNDS, x, y)) state.liked = !state.liked;
          else if (inBounds(BOX_BOUNDS, x, y)) state.editorOpen = true;
          else if (inBounds(SEND_BOUNDS, x, y) && state.editorOpen && state.currentInput) {
            state.commentSent.push(state.currentInput);
            state.currentInput = null;
            state.editorOpen = false;
          }
          return { code: 10000, data: "" };
        }
        if (cmd.startsWith("input keyevent")) {
          return { code: 10000, data: "" };
        }
        return { code: 10000, data: "" };
      }
      if (action === "inputText") {
        state.inputs.push(String(input.data?.content || ""));
        state.currentInput = String(input.data?.content || "");
        return { code: 10000 };
      }
      if (action === "selectIme") {
        return { code: 10000 };
      }
      if (action === "Screen") {
        return { code: 10000 };
      }
      return { code: 10000, data: {} };
    },
  };
  return { state, transport };
}

// --- control-plane fixture ----------------------------------------------------

function fixture() {
  const device = createDevice();
  const root = mkdtempSync(join(tempBase, "routine-authority-"));
  const state = new StateStore({ dbPath: join(root, "control.db") });
  const evidence = new EvidenceStore({
    runsRoot: join(root, "runs"),
    state,
    minFreeBytes: 0,
    minExternalEffectFreeBytes: 0,
  });
  const dev = state.upsertDevice({
    alias: "03",
    physicalLabel: "rack-03",
    nodeId: "DESKTOP-3I1EVHE",
    runtimeId: "routine-03-runtime",
    routingProfile: { enabled: true, tags: ["slot:03"], capabilityIds: [capability.id, "xiaowei.lab.raw"] },
  });
  const adapter = createXiaoweiAdapter({ transport: device.transport });
  const control = new ControlPlane({
    state,
    capabilities: registry,
    adapters: new AdapterRegistry([adapter]),
    evidence,
    leaseHeartbeatMs: 5000,
    leaseTtlMs: 60000,
    schedulerIntervalMs: 5,
  });
  control.start();
  let sessionCounter = 0;
  return {
    root,
    state,
    control,
    device: dev,
    screen: device.state,
    async openSession() {
      sessionCounter += 1;
      return control.createSession({
        actorId: `routine-operator-${sessionCounter}`,
        deviceId: dev.deviceId,
        capability,
        canary: true,
      });
    },
    registerAuthority(session, {
      routineRunId = `routine-run-${sessionCounter}`,
      canary = true,
      effectCaps = { like: 1, comment: 2 },
    } = {}) {
      return control.registerRoutineAuthority({
        sessionId: session.sessionId,
        token: session.token,
        executionRunId: "exec-r2-1",
        routineRunId,
        planHash: "planhash-r2-1",
        alias: "03",
        effectCaps,
        canaryAuthorized: canary,
        accountFingerprint: "acct-03",
      });
    },
    async close() {
      await control.stop();
      state.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function likeIntent(targetFingerprint) {
  return { action: "like", targetFingerprint, observationHash: "seed-observation", payloadHash: null };
}

test("routine authority registers with a server-sealed canary policy and hard caps", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session);
    assert.equal(authority.status, "active");
    assert.equal(authority.alias, "03");
    assert.equal(authority.deviceId, f.device.deviceId);
    assert.equal(authority.leaseId, session.leaseId);
    assert.equal(authority.canaryPolicy.granted, true);
    assert.equal(authority.canaryPolicy.transport.like, 1);
    assert.equal(authority.canaryPolicy.transport.comment, 2);
    assert.equal(authority.canaryPolicy.visualTap, 0);
    assert.match(authority.canaryPolicy.policyHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(authority.effectCaps, { like: 1, comment: 2 });

    // replay: same routineRunId returns the SAME authority, never a second one
    const replay = f.registerAuthority(session, { routineRunId: authority.routineRunId });
    assert.equal(replay.authorityId, authority.authorityId);
  } finally {
    await f.close();
  }
});

test("an authority without a canary request seals the transport policy (granted:false)", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const sealed = f.registerAuthority(session, { routineRunId: "routine-run-unsealed", canary: false });
    assert.equal(sealed.canaryPolicy.granted, false);
    assert.equal(sealed.canaryPolicy.transport.like, 0);
    assert.equal(sealed.canaryPolicy.transport.comment, 0);
  } finally {
    await f.close();
  }
});

test("authority negatives: alias 04 forbidden, cap raise forbidden, second active per session forbidden", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    assert.throws(
      () => f.control.registerRoutineAuthority({
        sessionId: session.sessionId, token: session.token, executionRunId: "e",
        routineRunId: "rr-alias", planHash: "p", alias: "04", effectCaps: { like: 1 },
        canaryAuthorized: true,
      }),
      { code: "ROUTINE_AUTHORITY_ALIAS_FORBIDDEN" },
    );
    assert.throws(
      () => f.control.registerRoutineAuthority({
        sessionId: session.sessionId, token: session.token, executionRunId: "e",
        routineRunId: "rr-cap", planHash: "p", alias: "03", effectCaps: { like: 5 },
        canaryAuthorized: true,
      }),
      { code: "ROUTINE_AUTHORITY_CAP_EXCEEDED" },
    );
    f.registerAuthority(session, { routineRunId: "rr-first" });
    assert.throws(
      () => f.registerAuthority(session, { routineRunId: "rr-second" }),
      { code: "ROUTINE_AUTHORITY_SESSION_ACTIVE" },
    );
  } finally {
    await f.close();
  }
});

test("like effect end-to-end: one tap, verified, replayed on repeat, skipped when already liked", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-like" });
    const target = "target-fp-like-1";

    const first = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token, intent: likeIntent(target),
    });
    assert.equal(first.outcome, "verified");
    assert.equal(first.transported, true);
    assert.equal(f.screen.liked, true);
    assert.equal(f.screen.taps.length, 1);

    // ledger: exactly one like effect, verified
    const effects = f.state.listRoutineEffects("rr-like");
    assert.equal(effects.length, 1);
    assert.equal(effects[0].action, "like");
    assert.equal(effects[0].status, "verified");

    // repeat commit: the fresh pre-state is already liked — skip wins over
    // replay, and zero new transport happens either way
    const again = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token, intent: likeIntent(target),
    });
    assert.equal(again.outcome, "skipped:already_liked");
    assert.equal(again.transported, false);
    assert.equal(f.screen.taps.length, 1);
  } finally {
    await f.close();
  }
});

test("already-liked target skips without reservation or transport", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-skip" });
    f.screen.liked = true;
    const res = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token, intent: likeIntent("target-fp-skip"),
    });
    assert.equal(res.outcome, "skipped:already_liked");
    assert.equal(res.transported, false);
    assert.equal(f.screen.taps.length, 0);
    assert.equal(f.state.listRoutineEffects("rr-skip").length, 0);
  } finally {
    await f.close();
  }
});

test("no server-sealed grant means the transport stays sealed with zero taps", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-sealed", canary: false });
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: authority.authorityId, token: session.token, intent: likeIntent("target-fp-sealed"),
      }),
      { code: "ROUTINE_TRANSPORT_SEALED" },
    );
    assert.equal(f.screen.taps.length, 0);
    assert.equal(f.screen.inputs.length, 0);
  } finally {
    await f.close();
  }
});

test("wrong token and unknown authority are rejected before any transport", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-token" });
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: authority.authorityId, token: "wrong-token", intent: likeIntent("target-fp-token"),
      }),
      { code: "SESSION_TOKEN_INVALID" },
    );
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: "routine-auth-missing", token: session.token, intent: likeIntent("t"),
      }),
      { code: "ROUTINE_AUTHORITY_INACTIVE" },
    );
    // a raw coordinate intent can never express an effect tap
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: authority.authorityId, token: session.token,
        intent: { action: "like", targetFingerprint: "t", observationHash: "s", x: 1000, y: 1830 },
      }),
      { code: "EFFECT_TAP_SURFACE_REJECTED" },
    );
    assert.equal(f.screen.taps.length, 0);
  } finally {
    await f.close();
  }
});

test("conflicting rebind of the same claimed target fails closed", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-rebind" });
    const target = "target-fp-rebind";
    const first = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token, intent: likeIntent(target),
    });
    assert.equal(first.outcome, "verified");
    // now the phone shows a DIFFERENT note (new title) while the claim is reused
    f.screen.title = "城市夜跑路线规划的七个要点";
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: authority.authorityId, token: session.token, intent: likeIntent(target),
      }),
      { code: "TARGET_BINDING_MISMATCH" },
    );
    // the like budget slot was NOT consumed by the failed rebind
    const likeEffects = f.state.listRoutineEffects("rr-rebind").filter((e) => e.action === "like");
    assert.equal(likeEffects.length, 1);
  } finally {
    await f.close();
  }
});

test("grounded comment: deterministic provider, single transport, strict panel verify", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-comment", effectCaps: { like: 1, comment: 1 } });
    const res = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token,
      intent: { action: "comment", targetFingerprint: "target-fp-comment", observationHash: "seed-observation" },
    });
    assert.equal(res.outcome, "verified");
    assert.equal(res.transported, true);
    // transport shape: comment box tap + send tap, one input of the sealed text
    assert.equal(f.screen.taps.length, 2);
    assert.equal(f.screen.inputs.length, 1);
    assert.equal(f.screen.commentSent.length, 1);
    const sentText = f.screen.commentSent[0];
    assert.ok(sentText.length >= 4 && sentText.length <= 80);

    const effects = f.state.listRoutineEffects("rr-comment").filter((e) => e.action === "comment");
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, "verified");
  } finally {
    await f.close();
  }
});

test("repeat comment request for the same target skips on duplicate draft before transport", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-dup", effectCaps: { like: 1, comment: 2 } });
    const first = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token,
      intent: { action: "comment", targetFingerprint: "target-fp-dup", observationHash: "seed-observation" },
    });
    assert.equal(first.outcome, "verified");
    const second = await f.control.commitRoutineAuthorityEffect({
      authorityId: authority.authorityId, token: session.token,
      intent: { action: "comment", targetFingerprint: "target-fp-dup", observationHash: "seed-observation" },
    });
    // the server-hard per-target cap (comment: 1 per target) rejects the repeat
    // before any draft or transport work — the first send is never duplicated
    assert.equal(second.outcome, "cap_reached:per_target");
    assert.equal(second.transported, false);
    assert.equal(f.screen.inputs.length, 1); // only the first draft ever reached the device
  } finally {
    await f.close();
  }
});

test("unwired actions and unproved surfaces never transport", async () => {
  const f = fixture();
  try {
    const session = await f.openSession();
    const authority = f.registerAuthority(session, { routineRunId: "rr-unwired" });
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: authority.authorityId, token: session.token,
        intent: { action: "follow", targetFingerprint: "t", observationHash: "s" },
      }),
      { code: "ROUTINE_ACTION_NOT_WIRED" },
    );
    assert.equal(f.screen.taps.length, 0);
    assert.equal(f.screen.inputs.length, 0);
  } finally {
    await f.close();
  }
});

test("authority lifecycle: explicit close, wrong-token close, session release closes", async () => {
  const f = fixture();
  try {
    // explicit close by the owning session
    const s1 = await f.openSession();
    const a1 = f.registerAuthority(s1, { routineRunId: "rr-close" });
    const closed = f.control.closeRoutineAuthorityViaRpc(a1.authorityId, s1.token, "wave-complete");
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "wave-complete");
    await assert.rejects(
      f.control.commitRoutineAuthorityEffect({
        authorityId: a1.authorityId, token: s1.token, intent: likeIntent("t"),
      }),
      { code: "ROUTINE_AUTHORITY_INACTIVE" },
    );
    f.control.releaseSession(s1.sessionId, s1.token);

    // wrong token may not close someone else's authority
    const s2 = await f.openSession();
    const a2 = f.registerAuthority(s2, { routineRunId: "rr-close-2" });
    assert.throws(
      () => f.control.closeRoutineAuthorityViaRpc(a2.authorityId, s1.token, "not-mine"),
      { code: "SESSION_TOKEN_INVALID" },
    );

    // releasing the owning session closes its authority (never outlives it)
    f.control.releaseSession(s2.sessionId, s2.token);
    assert.equal(f.state.getRoutineAuthority(a2.authorityId).status, "closed");
    assert.equal(f.state.getRoutineAuthority(a2.authorityId).closedReason, "session-released");
    assert.equal(f.state.listActiveRoutineAuthorities().length, 0);
  } finally {
    await f.close();
  }
});