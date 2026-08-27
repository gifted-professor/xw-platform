/**
 * xw-xhs-execute-truth.test.mjs — S0 execution-truth regression (plan V2
 * §3.4/§6.6/§10.2).
 *
 * Locks the fake-execution gap: pre-S0 `xw-xhs.mjs --execute` printed
 * `{ok:true, plan, gate:null}` when the action's live gate was open, without
 * calling the Runner, workflow, or any capability — gate status posed as
 * device-executed evidence. Regression contract:
 *   1. gate pass alone is NEVER ok — an authoritative CP terminal receipt
 *      (runId + transport + terminal status, bound to the same planHash) is
 *      required;
 *   2. the old gate-only success shape is rejected as a receipt;
 *   3. with no executor wired, every --execute fails closed
 *      (XHS_EXECUTE_NOT_WIRED) at the pure layer AND at the CLI surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  EXECUTE_RECEIPT_SCHEMA_ID,
  isAuthoritativeExecuteReceipt,
  resolveExecuteOutcome,
  planAction,
} from "../scripts/lib/xw-xhs-dispatcher.mjs";

const execFileAsync = promisify(execFile);
const OPS_XW_XHS = join(import.meta.dirname, "..", "ops", "xw-xhs.mjs");

const ALL_OPEN = Object.freeze({
  search: true, browse: true, inbox: true, read: true,
  like: true, collect: true, follow: true, nurture: true,
  comment: true, reply: true, "publish prepare": true, "publish send": true,
});

function validReceipt(plan, overrides = {}) {
  return {
    schemaId: EXECUTE_RECEIPT_SCHEMA_ID,
    runId: "rr_test0000000001",
    planHash: plan.planHash,
    status: "SUCCEEDED",
    transport: { count: 0 },
    cleanup: { activeLeases: 0, restored: true },
    ...overrides,
  };
}

test("S0 truth: gate open + no executor -> XHS_EXECUTE_NOT_WIRED for every action", () => {
  const actions = [
    ["search", { keyword: "x" }], ["browse", {}], ["inbox", {}],
    ["read", { thread: "t" }], ["like", { keyword: "x" }], ["collect", { keyword: "x" }],
    ["follow", { keyword: "x" }], ["nurture", { minutes: 20 }],
    ["comment", { keyword: "x", text: "t" }], ["reply", { thread: "t", text: "t" }],
    ["publish prepare", { title: "t", body: "b" }], ["publish send", { run: "r" }],
  ];
  for (const [id, params] of actions) {
    const plan = planAction({ actionId: id, params });
    const outcome = resolveExecuteOutcome(plan, ALL_OPEN, null);
    assert.equal(outcome.ok, false, `${id}: gate-open --execute must not succeed without an executor`);
    assert.equal(outcome.code, "XHS_EXECUTE_NOT_WIRED", `${id}: expected not-wired, got ${outcome.code}`);
  }
});

test("S0 truth: gate closed still fails with ACTION_GATED (unchanged fail-closed)", () => {
  const plan = planAction({ actionId: "browse", params: {} });
  const outcome = resolveExecuteOutcome(plan, {}, null);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "ACTION_GATED");
  assert.match(outcome.reason, /^action_gated:/);
});

test("S0 truth: the old gate-only fake-success shape is not an authoritative receipt", () => {
  // Exactly the pre-S0 CLI payload that posed gate status as execute success.
  const plan = planAction({ actionId: "browse", params: {} });
  const fake = { ok: true, command: "execute", plan, gate: null };
  const v = isAuthoritativeExecuteReceipt(fake, plan.planHash);
  assert.equal(v.ok, false);
  assert.match(v.reason, /^receipt_(missing|schema)$/);

  // Even after wrapping the fake in the receipt schema, it has no runId /
  // transport / terminal status — still rejected.
  const wrapped = { ...fake, schemaId: EXECUTE_RECEIPT_SCHEMA_ID };
  assert.equal(isAuthoritativeExecuteReceipt(wrapped, plan.planHash).ok, false);
});

test("receipt validator: runId/transport/terminal/planHash are each required", () => {
  const plan = planAction({ actionId: "browse", params: {} });
  const cases = [
    [null, "null receipt"],
    [{}, "empty receipt"],
    [validReceipt(plan, { runId: "" }), "empty runId"],
    [validReceipt(plan, { runId: 42 }), "non-string runId"],
    [validReceipt(plan, { planHash: "0".repeat(64) }), "planHash mismatch"],
    [validReceipt(plan, { status: "RUNNING" }), "non-terminal status"],
    [validReceipt(plan, { status: null }), "missing status"],
    [validReceipt(plan, { transport: null }), "missing transport"],
    [validReceipt(plan, { transport: { count: -1 } }), "negative transport count"],
    [validReceipt(plan, { transport: { count: 1.5 } }), "non-integer transport count"],
    [validReceipt(plan, { transport: {} }), "missing transport count"],
  ];
  for (const [receipt, label] of cases) {
    const v = isAuthoritativeExecuteReceipt(receipt, plan.planHash);
    assert.equal(v.ok, false, `${label} must be rejected`);
  }
});

test("receipt validator: an authoritative terminal receipt passes and echoes", () => {
  const plan = planAction({ actionId: "browse", params: {} });
  const receipt = validReceipt(plan);
  assert.equal(isAuthoritativeExecuteReceipt(receipt, plan.planHash).ok, true);
  const outcome = resolveExecuteOutcome(plan, { browse: true }, receipt);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.receipt.runId, receipt.runId);
  // planHash binding is enforced even when the validator is called without one
  assert.equal(isAuthoritativeExecuteReceipt(receipt, null).ok, true);
});

test("CLI surface: --execute with an open gate still fails closed (fake-execution regression)", async () => {
  // Dispatch state with every gate promoted — pre-S0 this printed ok:true with
  // only plan+gate. It must now fail closed with XHS_EXECUTE_NOT_WIRED.
  const dir = mkdtempSync(join(tmpdir(), "xhs-execute-truth-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ recipeRevisions: {}, liveGates: { browse: true } }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      OPS_XW_XHS, "browse", "--execute",
    ], { env: { ...process.env, XHS_DISPATCH_STATE: statePath } })
      .then((r) => ({ stdout: r.stdout }))
      .catch((e) => ({ stdout: e.stdout || "" })); // exit 4 = fail-closed, expected
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false, "gate-open --execute must not report ok:true");
    assert.equal(payload.error?.code, "XHS_EXECUTE_NOT_WIRED");
    assert.ok(!payload.receipt, "no receipt may be fabricated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI surface: --execute with a closed gate keeps ACTION_GATED (exit 4)", async () => {
  const { stdout, code } = await execFileAsync(process.execPath, [
    OPS_XW_XHS, "browse", "--execute",
  ], { env: { ...process.env, XHS_DISPATCH_STATE: join(import.meta.dirname, "does-not-exist.json") } })
    .then((r) => ({ ...r, code: r.code ?? 0 }))
    .catch((e) => ({ stdout: e.stdout || "", code: e.code }));
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, "ACTION_GATED");
  assert.match(payload.gate || "", /^action_gated:W3$/);
  assert.equal(Number(code), 4);
});