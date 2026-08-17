import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";

// Capture process.stdout.write while main() runs, return {objs, exitCode}.
async function runCli(argv) {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(c); return true; };
  const origExit = process.exitCode;
  let exitCode;
  try {
    await main(["node", "cli.mjs", ...argv]);
    exitCode = process.exitCode; // capture what the command set before we restore
  } finally {
    process.stdout.write = orig;
    process.exitCode = origExit;
  }
  const out = chunks.join("");
  const objs = out.split(/\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { objs, exitCode };
}

function makeDossier() {
  const d = mkdtempSync(join(tmpdir(), "clicli-"));
  writeFileSync(join(d, "known-debt.v1.json"), JSON.stringify({
    schemaId: "xhs.m0.known-debt.v1", schemaVersion: 1, baselineId: "xw-m0-20260817-r0",
    capturedAt: "2026-08-17T00:00:00Z",
    entries: [{ failureId: "debt_a", critical: false, owner: "ops", issue: "#1", expiresAt: "2027-01-01T00:00:00Z", blocksGates: [], allowsGates: ["m0"], waiverReason: "scope" }],
  }));
  return d;
}

test("cli validate emits versioned JSON with PASS for a valid dossier", async () => {
  const d = makeDossier();
  try {
    const { objs } = await runCli(["validate", d]);
    assert.equal(objs.length, 1);
    assert.equal(objs[0].subcommand, "validate");
    assert.equal(objs[0].status, "PASS");
    assert.equal(objs[0].validated, 1);
    assert.equal(objs[0].cliVersion, "xhs.m0.cli.v1");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("cli validate emits FAIL + errors for an invalid dossier", async () => {
  const d = mkdtempSync(join(tmpdir(), "clicli2-"));
  try {
    writeFileSync(join(d, "bad.v1.json"), JSON.stringify({
      schemaId: "xhs.m0.known-debt.v1", schemaVersion: 1, baselineId: "NOT-A-BASELINE", capturedAt: "2026-08-17T00:00:00Z", entries: [],
    }));
    const { objs } = await runCli(["validate", d]);
    assert.equal(objs[0].status, "FAIL");
    assert.ok(objs[0].errors.length >= 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("cli hash emits a 64-hex projection hash for a file list", async () => {
  const d = makeDossier();
  try {
    const { objs } = await runCli(["hash", d, "known-debt.v1.json"]);
    assert.equal(objs[0].status, "PASS");
    assert.match(objs[0].hash, /^[a-f0-9]{64}$/);
    assert.equal(objs[0].fileCount, 1);
    assert.ok(objs[0].totalBytes > 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("cli secret-scan reports CLEAN on a secret-free dossier", async () => {
  const d = makeDossier();
  try {
    const { objs } = await runCli(["secret-scan", d]);
    assert.equal(objs[0].subcommand, "secret-scan");
    assert.equal(objs[0].status, "CLEAN");
    assert.equal(objs[0].count, 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("cli unknown command emits BLOCK and sets exitCode", async () => {
  const { objs, exitCode } = await runCli(["nope"]);
  assert.equal(objs[0].status, "BLOCK");
  assert.equal(exitCode, 2);
});