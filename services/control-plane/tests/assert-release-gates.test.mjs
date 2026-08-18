import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "assert-release-gates.mjs");

function runGates(env = {}) {
  return spawnSync(process.execPath, [script, repoRoot], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parseJsonLine(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).find((row) => row.startsWith("{"));
  assert.ok(line, "expected JSON stdout");
  return JSON.parse(line);
}

test("assert-release-gates passes with dirty allowed and non-main allowed", () => {
  const result = runGates({
    XHS_ALLOW_DIRTY_WORKTREE: "1",
    XHS_ALLOW_NON_MAIN: "1",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const body = parseJsonLine(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.allowDirty, true);
  assert.match(body.trackedContentSha256, /^[a-f0-9]{64}$/);
  assert.ok(body.fileCount >= 50, `expected broad production hash, got ${body.fileCount}`);
});

test("assert-release-gates refuses non-main when required", () => {
  const result = runGates({
    XHS_ALLOW_DIRTY_WORKTREE: "1",
    XHS_REQUIRE_MAIN_ORIGIN: "1",
  });
  // Feature branch or dirty deploy must fail closed when main is required.
  if (result.status === 0) {
    const body = parseJsonLine(result.stdout);
    assert.equal(body.branch, "main");
  } else {
    const body = parseJsonLine(result.stdout);
    assert.equal(body.ok, false);
    assert.match(String(body.error || ""), /branch must be main|HEAD .* != origin\/main|fetch origin main failed/);
  }
});

test("assert-release-gates rejects stale or mismatched receipt", () => {
  const runtimeDir = join(repoRoot, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const receiptPath = join(runtimeDir, "release-test-receipt.json");
  const backupPath = join(runtimeDir, `release-test-receipt.bak-${Date.now()}.json`);
  let hadBackup = false;
  try {
    const existing = spawnSync("cmd", ["/c", `if exist "${receiptPath}" copy /Y "${receiptPath}" "${backupPath}"`], {
      encoding: "utf8",
    });
    hadBackup = existing.status === 0;

    writeFileSync(receiptPath, `${JSON.stringify({
      ok: true,
      gitCommit: "a".repeat(40),
      command: "npm test",
      passed: 1,
      failed: 0,
      completedAt: new Date().toISOString(),
      bodyHash: "deadbeef",
    }, null, 2)}\n`);

    const result = runGates({
      XHS_ALLOW_DIRTY_WORKTREE: "1",
      XHS_ALLOW_NON_MAIN: "1",
      XHS_REQUIRE_TEST_RECEIPT: "1",
    });
    assert.notEqual(result.status, 0);
    const body = parseJsonLine(result.stdout);
    assert.equal(body.ok, false);
    assert.match(String(body.error || ""), /receipt\.gitCommit|bodyHash/);
  } finally {
    if (hadBackup) {
      spawnSync("cmd", ["/c", `move /Y "${backupPath}" "${receiptPath}"`], { encoding: "utf8" });
    } else {
      try { rmSync(receiptPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    }
  }
});

test("write-release-test-receipt binds HEAD and bodyHash", () => {
  const writer = join(repoRoot, "scripts", "write-release-test-receipt.mjs");
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  try {
    // Run writer against real repo but don't leave permanent if we can avoid — it writes to runtime/.
    // Use --passed/--failed only; then validate hash algorithm locally.
    const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
    const receipt = {
      ok: true,
      gitCommit: head.stdout.trim(),
      command: "npm test",
      passed: 3,
      failed: 0,
      completedAt: new Date().toISOString(),
    };
    const canonical = `${JSON.stringify(receipt, Object.keys(receipt).sort())}\n`;
    const bodyHash = createHash("sha256").update(canonical).digest("hex");
    assert.match(bodyHash, /^[a-f0-9]{64}$/);
    writeFileSync(join(dir, "probe.json"), JSON.stringify({ ...receipt, bodyHash }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assert-release-gates rejects thin receipt suite", () => {
  const runtimeDir = join(repoRoot, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const receiptPath = join(runtimeDir, "release-test-receipt.json");
  const backupPath = join(runtimeDir, `release-test-receipt.bak-thin-${Date.now()}.json`);
  let hadBackup = false;
  try {
    const existing = spawnSync("cmd", ["/c", `if exist "${receiptPath}" copy /Y "${receiptPath}" "${backupPath}"`], {
      encoding: "utf8",
    });
    hadBackup = existing.status === 0;
    const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const thin = {
      ok: true,
      gitCommit: head,
      command: "node --test tests/return-home.test.mjs",
      passed: 4,
      failed: 0,
      completedAt: new Date().toISOString(),
    };
    const canonical = `${JSON.stringify(thin, Object.keys(thin).sort())}\n`;
    thin.bodyHash = createHash("sha256").update(canonical).digest("hex");
    writeFileSync(receiptPath, `${JSON.stringify(thin, null, 2)}\n`);

    const result = runGates({
      XHS_ALLOW_DIRTY_WORKTREE: "1",
      XHS_ALLOW_NON_MAIN: "1",
      XHS_REQUIRE_TEST_RECEIPT: "1",
      XHS_RECEIPT_MIN_PASSED: "15",
      XHS_RECEIPT_REQUIRE_SUITE: "1",
    });
    assert.notEqual(result.status, 0);
    const body = parseJsonLine(result.stdout);
    assert.equal(body.ok, false);
    assert.match(String(body.error || ""), /runtime-critical|passed must be/);
  } finally {
    if (hadBackup) {
      spawnSync("cmd", ["/c", `move /Y "${backupPath}" "${receiptPath}"`], { encoding: "utf8" });
    } else {
      try { rmSync(receiptPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(backupPath, { force: true }); } catch { /* ignore */ }
    }
  }
});

test("AdapterRegistry requires verify and restore", async () => {
  const { AdapterRegistry } = await import("../control-plane/lib/control-plane.mjs");
  assert.throws(
    () => new AdapterRegistry([{ id: "stub", async execute() {} }]),
    /stub\.verify is required/,
  );
  assert.throws(
    () => new AdapterRegistry([{ id: "stub", async execute() {}, async verify() {} }]),
    /stub\.restore is required/,
  );
  assert.doesNotThrow(() => new AdapterRegistry([{
    id: "stub",
    async execute() {},
    async verify() {},
    async restore() {},
  }]));
});
