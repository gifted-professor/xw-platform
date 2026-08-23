import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replayLaunchSpec } from "../src/process-adapter.mjs";

test("a fatal upstream protocol violation closes the real DSH process tree", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-3-real-fatal-"));
  const closeReceiptPath = join(root, "close.json");
  const launch = replayLaunchSpec({
    persistenceRoot: join(root, "sessions"),
    replayRoot: join(root, "replay"),
    closeReceiptPath,
  });
  const supervisor = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  supervisor.stderr.setEncoding("utf8");
  supervisor.stderr.on("data", (chunk) => { stderr += chunk; });
  supervisor.stdin.end("{\"jsonrpc\":\n");
  const [code] = await new Promise((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.once("exit", (...args) => resolve(args));
  });
  assert.equal(code, 1);
  assert.match(stderr, /M6_DSH_PROTOCOL_INVALID/u);
  const receipt = JSON.parse(readFileSync(closeReceiptPath, "utf8"));
  assert.equal(receipt.schemaId, "xw.dsh.process-close-receipt.v1");
  assert.equal(receipt.verifiedClosed, true);
  assert.equal(receipt.adapterKind, "dsh_cordis_process");
  assert.equal(receipt.executionMode, "replay");
  assert.equal(Object.keys(receipt.hashLedger).length, 9);
  assert.ok(receipt.pid > 0);
});
