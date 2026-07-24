import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireTransportLock, inspectTransportLock } from "../control-plane/lib/xiaowei-transport.mjs";

const tempBase = fileURLToPath(new URL("../control-plane/runtime", import.meta.url));
mkdirSync(tempBase, { recursive: true });

test("tokenized transport lock rejects overlap and preserves the owner", async () => {
  const root = mkdtempSync(join(tempBase, "transport-test-"));
  const path = join(root, "xw-ws-22222.lock");
  try {
    const release = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "busy");
    await assert.rejects(
      acquireTransportLock({ path, timeoutMs: 5, staleMs: 1000, retryMs: 1 }),
      { code: "TRANSPORT_LOCK_TIMEOUT" },
    );
    release();
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "free");
    const releaseAgain = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale transport lock is recovered before a request", async () => {
  const root = mkdtempSync(join(tempBase, "transport-stale-"));
  const path = join(root, "xw-ws-22222.lock");
  try {
    writeFileSync(path, JSON.stringify({ token: "stale" }));
    const old = new Date(Date.now() - 60000);
    utimesSync(path, old, old);
    assert.equal(inspectTransportLock({ path, staleMs: 1000 }).status, "stale");
    const release = await acquireTransportLock({ path, timeoutMs: 20, staleMs: 1000, retryMs: 2 });
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
