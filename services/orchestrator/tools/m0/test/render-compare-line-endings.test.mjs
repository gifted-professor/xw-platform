import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";
import { renderDir } from "../render.mjs";

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
  const d = mkdtempSync(join(tmpdir(), "rendercl-"));
  writeFileSync(join(d, "known-debt.v1.json"), JSON.stringify({
    schemaId: "xhs.m0.known-debt.v1", schemaVersion: 1, baselineId: "xw-m0-20260817-r0",
    capturedAt: "2026-08-17T00:00:00Z",
    entries: [{ failureId: "debt_a", critical: false, owner: "ops", issue: "#1", expiresAt: "2027-01-01T00:00:00Z", blocksGates: [], allowsGates: ["m0"], waiverReason: "scope" }],
  }));
  return d;
}

test("render --compare MATCHes a CRLF copy of the LF renderer output", async () => {
  const d = makeDossier();
  const t = mkdtempSync(join(tmpdir(), "rendercl-crlf-"));
  try {
    const md = await renderDir(d);
    // autocrlf working trees commit the report as CRLF; the renderer emits LF.
    const crlf = md.replace(/\n/g, "\r\n");
    const report = join(t, "acceptance-report.md");
    writeFileSync(report, crlf);
    const { objs, exitCode } = await runCli(["render", d, "--compare", report]);
    assert.equal(objs[0].subcommand, "render");
    assert.equal(objs[0].compareResult, "MATCH");
    assert.equal(objs[0].status, "PASS");
    assert.equal(exitCode, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(t, { recursive: true, force: true });
  }
});

test("render --compare reports DIFF and sets exitCode 1 for a content-changed report", async () => {
  const d = makeDossier();
  const t = mkdtempSync(join(tmpdir(), "rendercl-diff-"));
  try {
    const md = await renderDir(d);
    // content change, CRLF line endings: normalization must NOT mask real diffs
    const altered = md.replace("Known Debt Register", "KNOWN DEBT REGISTER").replace(/\n/g, "\r\n");
    const report = join(t, "acceptance-report.md");
    writeFileSync(report, altered);
    const { objs, exitCode } = await runCli(["render", d, "--compare", report]);
    assert.equal(objs[0].compareResult, "DIFF");
    assert.equal(objs[0].status, "FAIL");
    assert.equal(exitCode, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(t, { recursive: true, force: true });
  }
});
