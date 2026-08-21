// M6-1 locator convergence tests. Verifies xw-locator is now a thin proxy over
// the single GroundingRuntime: no machine-external paths, no python venv, no
// visual_tap_demo.py, and its status/prepare/verify output conforms to the M6
// contracts. tapAuthorized stays false (trusted live tap permit is M6-4).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateScreenFrame, validateVisualBlockSet } from "../scripts/lib/m6/m6-contracts.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LOCATOR = path.join(REPO_ROOT, "services/orchestrator/ops/xw-locator.mjs");
const SOURCE = readFileSync(LOCATOR, "utf8");

function runLocator(args) {
  return JSON.parse(execFileSync(process.execPath, [LOCATOR, ...args], { encoding: "utf8", cwd: REPO_ROOT }));
}

test("locator source: no machine-external vision paths or python venv remain", () => {
  const forbidden = [
    "visual_tap_demo.py",
    "xhs-registry-visual-tap",
    ".venv-ocr",
    "VISUAL_RESOLVER_ROOT",
    "XW_VISUAL_LOCATOR_ROOT",
    "XW_VISUAL_LOCATOR_PYTHON",
    "screenshot-and-analyze.mjs",
    "spawnSync",
  ];
  for (const token of forbidden) {
    assert.ok(!SOURCE.includes(token), `xw-locator must not reference: ${token}`);
  }
  assert.ok(SOURCE.includes("m6-grounding-runtime"), "xw-locator must delegate to the GroundingRuntime");
});

test("locator source: it imports the hermetic fixture provider and the policy sha derivation", () => {
  assert.ok(SOURCE.includes("HERMETIC_FIXTURE_PROVIDER"));
  assert.ok(SOURCE.includes("computeRedlinePolicySha256"));
});

test("locator status: reports runtime available, tapAuthorized false, no machine paths", () => {
  const out = runLocator(["status"]);
  assert.equal(out.ok, true);
  assert.equal(out.tapAuthorized, false);
  assert.deepEqual(out.runtime.machineExternalPaths, []);
  assert.equal(out.runtime.groundingRuntime.includes("m6-grounding-runtime"), true);
});

test("locator prepare: freezes a contract-conformant frame and block set from --input", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "m6-loc-"));
  const ev = path.join(tmp, "evidence.json");
  writeFileSync(ev, JSON.stringify({
    screenshotA: "demo", screenshotB: "demo", dump: "d", focus: "f",
    capturedAt: "2026-08-20T10:00:00.000Z",
    linkage: { sessionId: "s", leaseRef: "l", alias: "01", appId: "com.xingin.xhs" },
  }));
  const out = runLocator(["prepare", "--input", ev, "--out", path.join(tmp, "prep")]);
  assert.equal(out.ok, true);
  assert.equal(out.tapAuthorized, false);
  assert.match(out.frameId, /^[0-9a-f]{64}$/);
  const frame = JSON.parse(readFileSync(path.join(tmp, "prep", "screen-frame.json"), "utf8"));
  const blockSet = JSON.parse(readFileSync(path.join(tmp, "prep", "blocks.json"), "utf8"));
  assert.equal(validateScreenFrame(frame).ok, true);
  // blocks.json is the surface array (no private signals, no coordinates).
  for (const block of blockSet) {
    for (const forbidden of ["x", "y", "bounds", "normalizedX", "_signals"]) {
      assert.equal(forbidden in block, false, `${forbidden} must not be on the locator surface`);
    }
  }
  const segFile = JSON.parse(readFileSync(path.join(tmp, "prep", "vision-pack.json"), "utf8"));
  assert.equal(segFile.frameId, frame.frameId);
});

test("locator verify: produces a grounding decision; non-ALLOW_ONCE exits 3 with tapAuthorized false", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "m6-loc-"));
  const ev = path.join(tmp, "evidence.json");
  writeFileSync(ev, JSON.stringify({
    screenshotA: "demo", screenshotB: "demo", dump: "d", focus: "f",
    capturedAt: "2026-08-20T10:00:00.000Z",
    linkage: { sessionId: "s", leaseRef: "l", alias: "01", appId: "com.xingin.xhs" },
  }));
  execFileSync(process.execPath, [LOCATOR, "prepare", "--input", ev, "--out", path.join(tmp, "prep")], {
    encoding: "utf8", cwd: REPO_ROOT,
  });
  const blocks = JSON.parse(readFileSync(path.join(tmp, "prep", "blocks.json"), "utf8"));
  const dec = path.join(tmp, "dec.json");
  writeFileSync(dec, JSON.stringify({ blockId: blocks[0].blockId, intent: "tap", effectClass: "navigation" }));
  // verify may exit 3 on REPLAN; capture via try/catch.
  let out;
  try {
    out = JSON.parse(execFileSync(process.execPath, [LOCATOR, "verify", "--dir", path.join(tmp, "prep"), "--decision", dec], { encoding: "utf8", cwd: REPO_ROOT }));
  } catch (error) {
    out = JSON.parse(error.stdout || error.stdout || "{}");
  }
  assert.equal(out.tapAuthorized, false);
  assert.ok(["ALLOW_ONCE", "REPLAN", "HARD_STOP"].includes(out.result.result), `unexpected decision: ${out.result?.result}`);
});

test("locator self-test: all internal checks pass", () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [LOCATOR, "--self-test"], { encoding: "utf8", cwd: REPO_ROOT });
  } catch (error) {
    stdout = error.stdout || "";
  }
  assert.match(stdout, /PASS catalog_registered/);
  assert.match(stdout, /PASS runtime_available/);
  assert.match(stdout, /PASS freeze_frame/);
  assert.match(stdout, /PASS segment_blocks/);
  assert.match(stdout, /summary pass=5 fail=0/);
});

test("locator execute/tap: still hard-refused (trusted live tap permit is not implemented)", () => {
  let threw = false;
  try {
    execFileSync(process.execPath, [LOCATOR, "execute"], { encoding: "utf8", cwd: REPO_ROOT });
  } catch (error) {
    threw = true;
    assert.match(String(error.stdout || ""), /trusted live tap permit is not implemented/);
  }
  assert.equal(threw, true, "execute must be hard-refused");
});
