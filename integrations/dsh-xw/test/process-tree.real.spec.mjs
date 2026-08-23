import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { spawnOwnedProcess, terminateOwnedProcessTree } from "../src/stdio-supervisor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const peer = join(here, "fixtures", "fake-jsonrpc-peer.mjs");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

test("verified owned-process receipt closes parent and descendant", async () => {
  const ref = spawnOwnedProcess(process.execPath, [peer, "tree"]);
  ref.child.stderr.setEncoding("utf8");
  const grandchildPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("grandchild identity timed out")), 2000);
    ref.child.stderr.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(Number(/GRANDCHILD (\d+)/u.exec(chunk)?.[1]));
    });
  });
  assert.ok(Number.isSafeInteger(grandchildPid));
  const receipt = await terminateOwnedProcessTree(ref, { timeouts: { gracefulExitMs: 10, termExitMs: 3000, treeKillMs: 3000 } });
  assert.equal(receipt.verifiedClosed, true);
  assert.equal(receipt.spawnNonce, ref.spawnNonce);
  assert.equal(isAlive(ref.pid), false);
  assert.equal(isAlive(grandchildPid), false);
});

test("refuses PID-only and identity-drift termination", async () => {
  await assert.rejects(() => terminateOwnedProcessTree({ pid: process.pid }), { code: "UNOWNED_PROCESS" });
  await assert.rejects(() => terminateOwnedProcessTree({ schemaId: "xw.dsh.process-ref.v1", pid: process.pid, child: { pid: process.pid + 1 } }), { code: "PROCESS_IDENTITY_DRIFT" });
});
