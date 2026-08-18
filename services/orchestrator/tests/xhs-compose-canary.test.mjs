import test from "node:test";
import assert from "node:assert/strict";

import {
  XHS_COMPOSE_PAIR_COVER,
  actionCommand,
  classifyXhsSurface,
  compileCanarySequence,
  distributeSequences,
  pairCoverage,
} from "../scripts/lib/xhs-compose-canary.mjs";
import {
  assertCanaryWorkerParent,
  assertFreshCanaryRoot,
  canaryAttempt,
  canaryRootName,
  isRetryableBindingChangedResult,
  signalGlobalStop,
  workerStopRecord,
} from "../ops/xw-xhs-compose-canary.mjs";

test("seven pair-cover sequences cover all 20 directed transitions", () => {
  const coverage = pairCoverage();
  assert.equal(XHS_COMPOSE_PAIR_COVER.length, 7);
  assert.equal(coverage.expected.length, 20);
  assert.equal(coverage.covered.length, 20);
  assert.deepEqual(coverage.missing, []);
  assert.deepEqual(coverage.extra, []);
});

test("four-device distribution is balanced and lossless", () => {
  const assignments = distributeSequences(["01", "02", "03", "04"]);
  assert.deepEqual(Object.values(assignments).map((items) => items.length), [2, 2, 2, 1]);
  assert.equal(Object.values(assignments).flat().length, 7);
  const actual = Object.values(assignments).flat().map((item) => item.join("> ")).sort();
  const expected = XHS_COMPOSE_PAIR_COVER.map((item) => item.join("> ")).sort();
  assert.deepEqual(actual, expected);
});

test("every live sequence compiles in order with zero effects", () => {
  for (const sequence of XHS_COMPOSE_PAIR_COVER) {
    const plan = compileCanarySequence(sequence, { keyword: "夏季穿搭" });
    assert.deepEqual(plan.actions.map((action) => action.actionId), [...sequence, "return_xhs_home"]);
    assert.equal(plan.effectBudget.maximumTotal, 0);
    assert.equal(plan.execution.reason, "xhs_compose_workflow_canary_required");
  }
});

test("effect actions are mechanically forced to dry-run", () => {
  for (const actionId of ["like_note", "collect_note", "follow_author"]) {
    const command = actionCommand(actionId, { alias: "03", sessionFile: "C:\\ctx.json" });
    assert.ok(command.includes("--session-file"));
    assert.ok(command.includes("--dry-run"));
  }
  const search = actionCommand("search_notes", { alias: "03", sessionFile: "C:\\ctx.json", keyword: "穿搭" });
  assert.ok(search.includes("--keyword"));
  assert.equal(search.includes("--open-first"), false);
});

test("surface classifier fail-closes login, captcha, risk and unknown apps", () => {
  assert.equal(classifyXhsSurface({ focus: "com.xingin.xhs/.IndexActivityV2", xml: "首页" }).safe, true);
  assert.equal(classifyXhsSurface({ focus: "com.other/.Main", xml: "" }).code, "UNKNOWN_PAGE");
  assert.equal(classifyXhsSurface({ focus: "com.xingin.xhs/.LoginActivity", xml: "登录小红书" }).code, "LOGIN_WALL");
  assert.equal(classifyXhsSurface({ focus: "com.xingin.xhs/.Main", xml: "请输入验证码" }).code, "CAPTCHA");
  assert.equal(classifyXhsSurface({ focus: "com.xingin.xhs/.Main", xml: "操作频繁" }).code, "RISK_CONTROL");
});

test("only the exact pre-I/O binding snapshot failure receives one bounded retry", () => {
  assert.equal(isRetryableBindingChangedResult({
    status: 4,
    stdout: "✗ alias/device/serial binding changed while session was active\n",
    stderr: "",
  }), true);
  assert.equal(isRetryableBindingChangedResult({
    status: 2,
    stdout: "SEARCH=fail\nREASON=launch\nDETAIL=✗ alias/device/serial binding changed while session was active\n",
    stderr: "",
  }), true);
  assert.equal(isRetryableBindingChangedResult({ status: 4, stdout: "✗ dump missing hierarchy" }), false);
  assert.equal(isRetryableBindingChangedResult({ status: 0, stdout: "✗ alias/device/serial binding changed while session was active" }), false);
});

test("ordinary worker failures request global STOP while peer-stop does not overwrite it", () => {
  assert.deepEqual(workerStopRecord("02", new Error("focus failed"), "2026-08-13T00:00:00.000Z"), {
    alias: "02",
    stage: "worker",
    code: "action_failure",
    detail: "focus failed",
    observedAt: "2026-08-13T00:00:00.000Z",
  });
  const peerError = Object.assign(new Error("global stop requested by another worker"), { stopClass: "peer_stop" });
  assert.equal(workerStopRecord("03", peerError), null);
});

test("replays use an explicit attempt namespace without overwriting attempt one", () => {
  assert.equal(canaryAttempt(undefined), 1);
  assert.equal(canaryAttempt("2"), 2);
  assert.equal(canaryRootName(1), "xhs-compose-conc4");
  assert.equal(canaryRootName(2), "xhs-compose-conc4-attempt2");
  assert.throws(() => canaryAttempt("0"), /positive integer/);
  assert.doesNotThrow(() => assertFreshCanaryRoot("fresh", (_path, options) => {
    assert.deepEqual(options, { recursive: false });
  }));
  assert.throws(
    () => assertFreshCanaryRoot("existing", () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }),
    /evidence root already exists; use a new --attempt/,
  );
});

test("STOP preserves the first root cause with exclusive creation", () => {
  let alreadyWritten = false;
  const writer = (_path, _body, options) => {
    assert.equal(options.flag, "wx");
    if (alreadyWritten) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    alreadyWritten = true;
  };
  assert.equal(signalGlobalStop("STOP.json", { alias: "02" }, writer), true);
  assert.equal(signalGlobalStop("STOP.json", { alias: "03" }, writer), false);
});

test("worker execution is bound to its parent run, attempt and nonce", () => {
  const record = {
    schemaId: "xhs.compose-conc4-parent.v1",
    runId: "run_fixture",
    attempt: 3,
    nonce: "nonce-fixture",
  };
  assert.doesNotThrow(() => assertCanaryWorkerParent(record, {
    runId: "run_fixture", attempt: 3, nonce: "nonce-fixture",
  }));
  assert.throws(() => assertCanaryWorkerParent(record, {
    runId: "run_fixture", attempt: 4, nonce: "nonce-fixture",
  }), /worker parent binding/);
  assert.throws(() => assertCanaryWorkerParent(null, {
    runId: "run_fixture", attempt: 3, nonce: "nonce-fixture",
  }), /worker parent binding/);
});
