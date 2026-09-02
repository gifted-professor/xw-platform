import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "ops", "xw-closeout.mjs");

function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("XW_CLOSEOUT_")) delete env[k];
  }
  return { ...env, ...extra };
}

function runCloseout(args, env) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: scrubbedEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Like runCloseout but, on failure, re-throws an Error whose message includes
// stderr so assert.throws regexes can match the real validation text.
function runCloseoutRaw(args, env) {
  try {
    return runCloseout(args, env);
  } catch (e) {
    const stdout = (e.stdout || "").toString().trim();
    const stderr = (e.stderr || "").toString().trim();
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    const msg = detail ? `${e.message}\n${detail}` : e.message;
    throw new Error(msg, { cause: e });
  }
}

function freshEnv() {
  const root = mkdtempSync(join(tmpdir(), "xw-closeout-adaptive-"));
  const stateRoot = join(root, "state", "orchestrator");
  const work = join(stateRoot, "outbox", "work");
  const harvest = join(stateRoot, "outbox", "harvest");
  mkdirSync(work, { recursive: true });
  mkdirSync(harvest, { recursive: true });
  const env = {
    XW_CLOSEOUT_WORK: work,
    XW_CLOSEOUT_OUTBOX: harvest,
    XW_CLOSEOUT_ROOTS_JSON: JSON.stringify({
      "windows:xw-outbox": join(stateRoot, "outbox"),
      "windows:xw-runtime-state": stateRoot,
    }),
  };
  return { root, env, work, harvest };
}

function beginRun(env, actor = "vitest") {
  return JSON.parse(
    runCloseout(["begin", "--mode", "engineering", "--actor", actor, "--goal", "adaptive test"], env),
  );
}

function writeStep(env, runId, stepObj) {
  const path = join(env ? mkdtempSync(join(tmpdir(), "step-")) : tmpdir(), "step.json");
  writeFileSync(path, JSON.stringify(stepObj));
  return path;
}

function readSteps(env, runId) {
  const text = readFileSync(join(env && join(freshEnvWork(env), runId, "steps.jsonl") || "", "steps.jsonl"), "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function freshEnvWork(env) {
  return env.XW_CLOSEOUT_WORK;
}

function stepInput(obj) {
  const path = join(mkdtempSync(join(tmpdir(), "step-")), "step.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test("adaptiveDecision accepted and written to steps.jsonl", () => {
  const { root, env, work } = freshEnv();
  try {
    const { runId } = beginRun(env);
    const input = stepInput({
      kind: "decision",
      title: "route=DUMP unique node",
      status: "ok",
      adaptiveDecision: {
        goalSignature: "xhs.search(keyword)@home",
        route: "DUMP",
        reasonCode: "UNIQUE_DUMP",
        profile: { alias: "04", package: "com.xingin.xhs", activity: "IndexActivityV2", width: 1080, height: 2400, orientation: "portrait", appVersion: "9.10.113" },
        targetFailureCount: 0,
        historyRefs: ["run_abc"],
        evidenceRefs: ["job_def"],
        blockId: null,
        assertion: { name: "packageEquals", pass: true },
      },
    });
    runCloseout(["step", "--run", runId, "--input", input], env);
    const steps = readFileSync(join(work, runId, "steps.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(steps.length, 1);
    assert.equal(steps[0].adaptiveDecision.route, "DUMP");
    assert.equal(steps[0].adaptiveDecision.profile.alias, "04");
    assert.equal(steps[0].adaptiveDecision.targetFailureCount, 0);
    assert.equal(steps[0].adaptiveDecision.assertion.pass, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adaptiveDecision rejected when route missing", () => {
  const { root, env, work } = freshEnv();
  try {
    const { runId } = beginRun(env);
    const input = stepInput({
      kind: "decision", title: "no route", status: "ok",
      adaptiveDecision: { goalSignature: "x", reasonCode: "UNIQUE_DUMP", profile: { alias: "04" }, targetFailureCount: 0 },
    });
    assert.throws(
      () => runCloseoutRaw(["step", "--run", runId, "--input", input], env),
      /route must be one of/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adaptiveDecision rejected on unknown field", () => {
  const { root, env } = freshEnv();
  try {
    const { runId } = beginRun(env);
    const input = stepInput({
      kind: "decision", title: "unknown", status: "ok",
      adaptiveDecision: { goalSignature: "x", route: "STOP", reasonCode: "REDLINE", profile: { alias: "04" }, targetFailureCount: 1, rogue: 1 },
    });
    assert.throws(
      () => runCloseoutRaw(["step", "--run", runId, "--input", input], env),
      /unknown field: rogue/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adaptiveDecision rejected when targetFailureCount out of range", () => {
  const { root, env } = freshEnv();
  try {
    const { runId } = beginRun(env);
    const input = stepInput({
      kind: "decision", title: "fc3", status: "ok",
      adaptiveDecision: { goalSignature: "x", route: "STOP", reasonCode: "SECOND_FAILURE", profile: { alias: "04" }, targetFailureCount: 3 },
    });
    assert.throws(
      () => runCloseoutRaw(["step", "--run", runId, "--input", input], env),
      /targetFailureCount must be integer 0\.\.2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("step without adaptiveDecision still works (backward compatible)", () => {
  const { root, env, work } = freshEnv();
  try {
    const { runId } = beginRun(env);
    const input = stepInput({ kind: "script", title: "plain", status: "ok" });
    runCloseout(["step", "--run", runId, "--input", input], env);
    const steps = readFileSync(join(work, runId, "steps.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(steps.length, 1);
    assert.equal(steps[0].adaptiveDecision, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});