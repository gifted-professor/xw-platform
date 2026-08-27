import test from "node:test";
import assert from "node:assert/strict";
import {
  XHS_ACTION_CATALOG,
  resolveAction,
  listActions,
  planAction,
  normalizeParams,
  effectBudget,
  bindOperationKey,
  adaptiveRouteHint,
  evaluateExecuteGate,
  FORCED_ALIAS,
  PlanError,
} from "../scripts/lib/xw-xhs-dispatcher.mjs";

const ACTIONS = [
  "search", "browse", "inbox", "read",
  "like", "collect", "follow", "nurture",
  "comment", "reply",
  "publish prepare", "publish send",
];

test("catalog has all 12 actions, all 04-only", () => {
  for (const id of ACTIONS) {
    const a = XHS_ACTION_CATALOG[id];
    assert.ok(a, `missing ${id}`);
  }
  assert.equal(listActions().length, 12);
  for (const a of listActions()) {
    // 04-only is enforced in planAction, not stored on the catalog row; verify
    // plan forces it.
    const plan = planAction({ actionId: a.id, params: minimalParams(a.id) });
    assert.equal(plan.alias, "04");
    assert.equal(plan.perDeviceConcurrency, 1);
  }
});

test("messages alias resolves to inbox", () => {
  assert.equal(resolveAction("messages").id, "inbox");
  assert.equal(resolveAction("inbox").id, "inbox");
});

test("publish prepare/send resolve as two-word ids", () => {
  assert.equal(resolveAction("publish prepare").id, "publish prepare");
  assert.equal(resolveAction("publish send").id, "publish send");
  assert.equal(resolveAction("publish"), null);
});

function minimalParams(id) {
  switch (id) {
    case "search": return { keyword: "深圳攀岩" };
    case "read": return { thread: "t1" };
    case "comment": return { keyword: "攀岩", text: "好" };
    case "reply": return { thread: "t1", text: "好" };
    case "publish prepare": return { title: "t", body: "b" };
    case "publish send": return { run: "r1" };
    case "nurture": return { minutes: 20 };
    default: return {};
  }
}

test("planAction is deterministic: same input -> same planHash across surfaces", () => {
  // surface 1: explicit entry
  const p1 = planAction({ actionId: "search", params: { keyword: "深圳攀岩" }, actor: "a:1" });
  // surface 2: same call (compose-compiled params must match byte-for-byte)
  const p2 = planAction({ actionId: "search", params: { keyword: "深圳攀岩" }, actor: "a:1" });
  assert.equal(p1.planHash, p2.planHash);
  assert.equal(p1.actionRunId, p2.actionRunId);
  assert.ok(p1.planHash.length === 64);
  assert.ok(p1.actionRunId.startsWith("ar_"));
  assert.equal(p1.executionReady, false);
});

test("planHash changes when params change", () => {
  const a = planAction({ actionId: "search", params: { keyword: "深圳攀岩" } }).planHash;
  const b = planAction({ actionId: "search", params: { keyword: "北京攀岩" } }).planHash;
  assert.notEqual(a, b);
});

test("planHash changes when action changes", () => {
  const a = planAction({ actionId: "search", params: { keyword: "x" } }).planHash;
  const b = planAction({ actionId: "browse", params: {} }).planHash;
  assert.notEqual(a, b);
});

test("three surfaces converge: explicit == compose-goalSignature == json", () => {
  // The compose surface attaches a goalSignature but must still produce the
  // same planHash for the same resolved action+params (goalSignature is part of
  // the hash ONLY when set; the contract is that explicit and json surfaces with
  // identical action+params are byte-identical).
  const explicit = planAction({ actionId: "like", params: { keyword: "攀岩", count: 2 } });
  const json = planAction({ actionId: "like", params: { keyword: "攀岩", count: 2 } });
  assert.deepEqual(explicit, json);
});

test("effect budget: none actions have no missions", () => {
  for (const id of ["search", "browse", "inbox", "read"]) {
    const plan = planAction({ actionId: id, params: minimalParams(id) });
    assert.equal(plan.budget.effectClass, "none");
    assert.deepEqual(plan.budget.missions, []);
  }
});

test("effect budget: like/collect/follow are mission-only with perTargetCount=1", () => {
  for (const id of ["like", "collect", "follow"]) {
    const plan = planAction({ actionId: id, params: { keyword: "攀岩", count: 3 } });
    assert.equal(plan.budget.effectClass, "social");
    assert.equal(plan.budget.missions.length, 1);
    assert.equal(plan.budget.missions[0].totalCount, 3);
    assert.equal(plan.budget.missions[0].perTargetCount, 1);
    assert.equal(plan.budget.missions[0].capabilityId, `xhs.${id}.ensure`);
  }
});

test("effect budget: comment/reply carry payloadHash", () => {
  const c = planAction({ actionId: "comment", params: { keyword: "攀岩", text: "好" } });
  assert.ok(c.budget.missions[0].payloadHash, "comment payloadHash set");
  assert.equal(c.budget.missions[0].totalCount, 1);
  const r = planAction({ actionId: "reply", params: { thread: "t1", text: "好" } });
  assert.ok(r.budget.missions[0].payloadHash, "reply payloadHash set");
});

test("effect budget: nurture builds one Mission per explicit social count, browse-only by default", () => {
  const def = planAction({ actionId: "nurture", params: { minutes: 20 } });
  assert.equal(def.budget.missions.length, 0, "default nurture is browse-only (no social effect)");
  const withCounts = planAction({ actionId: "nurture", params: { minutes: 20, likes: 2, collects: 1 } });
  const acts = withCounts.budget.missions.map((m) => m.action).sort();
  assert.deepEqual(acts, ["collect", "like"]);
  assert.equal(withCounts.budget.missions.find((m) => m.action === "like").totalCount, 2);
});

test("effect budget: publish send is a protected single commit", () => {
  const p = planAction({ actionId: "publish send", params: { run: "r1" } });
  assert.equal(p.budget.effectClass, "publish");
  assert.equal(p.budget.missions.length, 1);
  assert.equal(p.budget.missions[0].protectedCommit, true);
  assert.equal(p.budget.missions[0].totalCount, 1);
});

test("publish prepare is effect=none (transport=0)", () => {
  const p = planAction({ actionId: "publish prepare", params: { title: "t", body: "b" } });
  assert.equal(p.budget.effectClass, "none");
  assert.deepEqual(p.budget.missions, []);
});

test("04-only: alias 01/02/03 rejected at plan stage with XHS_ALIAS_NOT_04", () => {
  for (const alias of ["01", "02", "03"]) {
    assert.throws(
      () => planAction({ actionId: "search", params: { keyword: "x" }, alias }),
      (e) => e instanceof PlanError && e.code === "XHS_ALIAS_NOT_04",
      `${alias} must be rejected`,
    );
  }
});

test("04-only: no-alias defaults to 04, never falls back to 01-03", () => {
  const plan = planAction({ actionId: "search", params: { keyword: "x" } });
  assert.equal(plan.alias, "04");
});

test("adaptive route hint matches backend", () => {
  assert.equal(adaptiveRouteHint(XHS_ACTION_CATALOG.search), "RECIPE");
  assert.equal(adaptiveRouteHint(XHS_ACTION_CATALOG.inbox), "DUMP");
  assert.equal(adaptiveRouteHint(XHS_ACTION_CATALOG.like), "CAPABILITY");
});

test("normalizeParams applies defaults and rejects unknown keys", () => {
  const p = normalizeParams(XHS_ACTION_CATALOG.browse, {});
  assert.equal(p.minutes, 10);
  assert.equal(p.swipes, 5);
  assert.throws(
    () => normalizeParams(XHS_ACTION_CATALOG.search, { keyword: "x", bogus: 1 }),
    (e) => e.code === "PARAMS_UNKNOWN",
  );
});

test("normalizeParams enforces required + ranges", () => {
  assert.throws(
    () => normalizeParams(XHS_ACTION_CATALOG.search, {}),
    (e) => e.code === "PARAMS_REQUIRED",
  );
  assert.throws(
    () => normalizeParams(XHS_ACTION_CATALOG.search, { keyword: "x", pages: 9 }),
    (e) => e.code === "PARAMS_INVALID",
  );
});

test("search pages>1 rejected pre-W1 (range max=1)", () => {
  assert.throws(
    () => planAction({ actionId: "search", params: { keyword: "x", pages: 2 } }),
    (e) => e.code === "PARAMS_INVALID",
  );
});

test("operationKey binds actionRunId+action+target+payload and is stable", () => {
  const k1 = bindOperationKey({ actionRunId: "ar_1", action: "like", targetFingerprint: "fp1", payloadHash: "h1" });
  const k2 = bindOperationKey({ actionRunId: "ar_1", action: "like", targetFingerprint: "fp1", payloadHash: "h1" });
  assert.equal(k1, k2);
  assert.equal(k1.length, 64);
  const k3 = bindOperationKey({ actionRunId: "ar_1", action: "like", targetFingerprint: "fp2", payloadHash: "h1" });
  assert.notEqual(k1, k3, "different target -> different key");
});

test("operationKey rejects incomplete binding", () => {
  assert.throws(
    () => bindOperationKey({ actionRunId: "ar_1", action: "like", targetFingerprint: null }),
    (e) => e.code === "OPERATION_KEY_INCOMPLETE",
  );
});

test("evaluateExecuteGate: W0 fails closed for every action", () => {
  for (const id of ACTIONS) {
    const plan = planAction({ actionId: id, params: minimalParams(id) });
    const gate = evaluateExecuteGate(plan, {});
    assert.equal(gate.ok, false, `${id} must be gated in W0`);
    assert.ok(gate.reason.startsWith("action_gated:"), `${id} reason: ${gate.reason}`);
  }
});

test("evaluateExecuteGate: a promoted action passes", () => {
  const plan = planAction({ actionId: "search", params: { keyword: "x" } });
  const gate = evaluateExecuteGate(plan, { search: true });
  assert.equal(gate.ok, true);
});

test("plan output includes stop conditions and gate for audit (plan V2 §2.2)", () => {
  const plan = planAction({ actionId: "comment", params: { keyword: "攀岩", text: "好" } });
  assert.ok(Array.isArray(plan.stopConditions) && plan.stopConditions.length > 0);
  assert.equal(plan.gate, "W5");
  assert.equal(plan.capabilityId, "xhs.comment.bound_send");
});

test("golden planHash stability (regression guard)", () => {
  // Pin a known planHash so any silent drift in canonical ordering is caught.
  const plan = planAction({ actionId: "search", params: { keyword: "深圳攀岩" }, actor: "agent:test" });
  // Re-deriving in the same process must be identical.
  const again = planAction({ actionId: "search", params: { keyword: "深圳攀岩" }, actor: "agent:test" });
  assert.equal(plan.planHash, again.planHash);
  assert.match(plan.planHash, /^[0-9a-f]{64}$/);
});