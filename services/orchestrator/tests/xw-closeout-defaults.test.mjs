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

test("default closeout paths point at xw-runtime, not retired xhs-registry", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const outbox = src.match(/const DEFAULT_OUTBOX = "([^"]+)";/);
  const work = src.match(/const DEFAULT_WORK = "([^"]+)";/);
  assert.ok(outbox, "DEFAULT_OUTBOX found");
  assert.ok(work, "DEFAULT_WORK found");
  for (const [, value] of [outbox, work]) {
    assert.ok(value.includes("xw-runtime"), `default must live under xw-runtime: ${value}`);
    assert.ok(!value.includes("xhs-registry"), `default must not reference retired root: ${value}`);
    assert.ok(value.includes("state\\\\orchestrator\\\\outbox"), `default under state\\orchestrator\\outbox: ${value}`);
  }
  assert.ok(src.includes('"windows:xw-outbox"'), "DEFAULT_ROOTS provides windows:xw-outbox");
});

test("begin → step → close works without XW_CLOSEOUT_* inherited from caller (env override only)", () => {
  const root = mkdtempSync(join(tmpdir(), "xw-closeout-defaults-"));
  try {
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

    const beginOut = JSON.parse(runCloseout(
      ["begin", "--mode", "engineering", "--actor", "vitest", "--goal", "defaults regression"],
      env,
    ));
    const runId = beginOut.runId;
    assert.match(runId, /^run_/);
    assert.ok(existsSync(join(work, runId, "task.json")), "task.json written under env work root");
    // Env override must win over the (production) default path.
    assert.equal(beginOut.workDir.toLowerCase(), join(work, runId).toLowerCase());

    const stepPath = join(root, "step.json");
    writeFileSync(stepPath, JSON.stringify({ kind: "script", title: "noop", status: "ok" }));
    runCloseout(["step", "--run", runId, "--input", stepPath], env);

    const closeInputPath = join(root, "close.json");
    writeFileSync(closeInputPath, JSON.stringify({
      taskId: beginOut.taskId,
      actor: "vitest",
      machine: { id: "windows-test", platform: "windows" },
      mode: "engineering",
      startedAt: beginOut.startedAt,
      sources: [{ repo: "windows:test", branch: null, head: null, worktree: "unverified", changedFiles: [], commit: null, ahead: null, behind: null, pushed: null }],
      checks: [],
      runtime: {},
      deviceRefs: {},
      effects: [],
      artifacts: [],
      candidates: [],
      closure: { status: "completed", completed: ["noop"], remainingWork: [], blockers: [] },
      claims: [],
      evidenceDebt: [],
      acceptanceConditions: [],
    }));
    const closeOut = runCloseout(["close", "--run", runId, "--input", closeInputPath], env);
    assert.match(closeOut, /result=created/);
    assert.match(closeOut, /status=completed/);

    const bundlePath = join(harvest, runId, "closeout.v1.json");
    assert.ok(existsSync(bundlePath), "harvest bundle written under env outbox root");
    const closeout = JSON.parse(readFileSync(bundlePath, "utf8"));
    const ledgerArtifacts = closeout.artifacts.filter((a) => a.artifactId.startsWith("work_"));
    assert.equal(ledgerArtifacts.length, 2, "task.json + steps.jsonl attached");
    for (const a of ledgerArtifacts) {
      assert.equal(a.rootRef, "windows:xw-runtime-state");
      assert.equal(a.availability, "present");
      assert.ok(!a.path.includes("xhs-registry"), `no retired path in artifact: ${a.path}`);
    }
    assert.ok(
      !closeout.evidenceDebt.some((d) => d.code === "TASK_BRIEF_MISSING" || d.code === "STEPS_JOURNAL_MISSING"),
      "work ledger found without caller-provided XW_CLOSEOUT_WORK leakage",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
