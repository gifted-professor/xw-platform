import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireM6C1StoppedRuntimeGuard,
  acquireM6C1RuntimeOwnerLock,
  m6C1RuntimeOwnerLockPath,
} from "../control-plane/lib/m6-c1-runtime-owner-lock.mjs";
import {
  requiresM6C1RuntimeOwner,
  shutdownControlServer,
  startControlPlaneServer,
} from "../control-plane/server.mjs";

const OPTIONS = Object.freeze({ host: "127.0.0.1", port: 17920 });

function runtimeRoot() {
  const root = mkdtempSync(join(tmpdir(), "m6-c1-server-owner-"));
  mkdirSync(join(root, "state", "control-plane"), { recursive: true });
  return root;
}

function fakeRuntime(events) {
  return {
    m6LiveEntry: null,
    control: {
      start() { events.push("control-start"); },
      stop() { events.push("control-stop"); },
    },
    state: { close() { events.push("state-close"); } },
  };
}

function fakeServer(events, { listenError = null } = {}) {
  return {
    listening: false,
    once(event, callback) {
      assert.equal(event, "error");
      this.onError = callback;
    },
    listen(port, host, callback) {
      events.push("listen");
      assert.equal(port, OPTIONS.port);
      assert.equal(host, OPTIONS.host);
      if (listenError) {
        this.onError(listenError);
        return;
      }
      this.listening = true;
      callback();
    },
    close(callback) {
      events.push("http-close");
      this.listening = false;
      callback();
    },
  };
}

function startupOperations({ root, events, expectOwner, runtimeError = null, listenError = null, onOwner = null }) {
  return {
    acquireRuntimeOwner(input) {
      events.push("owner-acquire");
      const owner = acquireM6C1RuntimeOwnerLock({
        ...input,
        ownerNonce: "control-plane-server-owner-0001",
      });
      onOwner?.(owner);
      return owner;
    },
    createRuntime() {
      events.push("runtime-create");
      assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), expectOwner);
      writeFileSync(join(root, "state", "control-plane", "control.db"), "", { flag: "a" });
      if (runtimeError) {
        events.push("state-open");
        throw runtimeError;
      }
      return fakeRuntime(events);
    },
    createRouter() {
      events.push("router-create");
      return {};
    },
    createHttpServer() {
      events.push("server-create");
      return fakeServer(events, { listenError });
    },
    startScheduler(runtime) {
      events.push("scheduler-start");
      runtime.control.start();
      return Object.freeze({ started: true, recoveryOnly: false });
    },
  };
}

test("every server bound to the M6-C1 runtime root owns it before runtime creation", async (t) => {
  assert.equal(requiresM6C1RuntimeOwner("FINAL"), true);
  assert.equal(requiresM6C1RuntimeOwner("QUALIFICATION_ONLY"), true);
  assert.equal(requiresM6C1RuntimeOwner("STANDARD"), false);

  for (const runtimeMode of ["FINAL", "QUALIFICATION_ONLY", "STANDARD"]) {
    await t.test(runtimeMode, async () => {
      const root = runtimeRoot();
      const events = [];
      try {
        const started = await startControlPlaneServer({
          options: OPTIONS,
          nodeId: "M6-C1-TEST",
          runtimeMode,
          runtimeRoot: root,
          startupOperations: startupOperations({
            root,
            events,
            expectOwner: true,
          }),
        });
        assert.deepEqual(events.slice(0, 5), ["owner-acquire", "runtime-create", "router-create", "server-create", "listen"]);
        assert.equal(started.m6C1RuntimeOwner.assertOwned(), true);
        assert.equal(events.at(-2), "scheduler-start");
        assert.equal(events.at(-1), "control-start");
        await shutdownControlServer(started);
        assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("a cleanup failure retains the owner lock for audited recovery", async () => {
  const root = runtimeRoot();
  const events = [];
  const owner = acquireM6C1RuntimeOwnerLock({
    runtimeRoot: root,
    ownerKind: "CONTROL_PLANE_M6_C1",
    ownerNonce: "control-plane-server-owner-cleanup-failure",
  });
  const runtime = fakeRuntime(events);
  runtime.control.stop = () => {
    events.push("control-stop");
    throw Object.assign(new Error("cleanup failed"), { code: "TEST_CLEANUP_FAILED" });
  };
  try {
    await assert.rejects(() => shutdownControlServer({
      server: fakeServer(events),
      runtime,
      m6C1RuntimeOwner: owner,
    }), { code: "TEST_CLEANUP_FAILED" });
    assert.equal(owner.assertOwned(), true);
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), true);
  } finally {
    owner.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-root STANDARD server blocks a stopped-runtime mutation guard on another port", async () => {
  const root = runtimeRoot();
  const events = [];
  let started;
  try {
    started = await startControlPlaneServer({
      options: OPTIONS,
      nodeId: "M6-C1-TEST",
      runtimeMode: "STANDARD",
      runtimeRoot: root,
      startupOperations: startupOperations({ root, events, expectOwner: true }),
    });
    await assert.rejects(() => acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "STAGE_LIVE_WINDOW",
      host: "127.0.0.1",
      port: 0,
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
    assert.equal(started.m6C1RuntimeOwner.assertOwned(), true);
  } finally {
    if (started) await shutdownControlServer(started);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTROL_PLANE_DB-only STANDARD identity blocks a stopped-runtime guard", async () => {
  const root = runtimeRoot();
  const events = [];
  let started;
  try {
    const controlDbPath = join(root, "state", "control-plane", "control.db");
    assert.equal(requiresM6C1RuntimeOwner("STANDARD", null, controlDbPath), true);
    started = await startControlPlaneServer({
      options: OPTIONS,
      nodeId: "M6-C1-TEST",
      runtimeMode: "STANDARD",
      controlDbPath,
      startupOperations: startupOperations({ root, events, expectOwner: true }),
    });
    await assert.rejects(() => acquireM6C1StoppedRuntimeGuard({
      runtimeRoot: root,
      ownerKind: "STAGE_LIVE_WINDOW",
      host: "127.0.0.1",
      port: 0,
    }), { code: "M6_C1_RUNTIME_OWNER_LOCKED" });
  } finally {
    if (started) await shutdownControlServer(started);
    rmSync(root, { recursive: true, force: true });
  }
});

test("M6-C1 server rejects hardlink and symlink DB aliases before runtime creation", async (t) => {
  for (const linkKind of ["hardlink", "symlink"]) {
    await t.test(linkKind, async (child) => {
      const root = runtimeRoot();
      const outside = runtimeRoot();
      const events = [];
      try {
        const outsideDb = join(outside, "state", "control-plane", "control.db");
        const controlDbPath = join(root, "state", "control-plane", "control.db");
        writeFileSync(outsideDb, "aliased-db");
        try {
          if (linkKind === "hardlink") linkSync(outsideDb, controlDbPath);
          else symlinkSync(outsideDb, controlDbPath, "file");
        } catch (error) {
          if (process.platform === "win32" && linkKind === "symlink" && error?.code === "EPERM") {
            child.skip("Windows symlink privilege is unavailable");
            return;
          }
          throw error;
        }
        await assert.rejects(() => startControlPlaneServer({
          options: OPTIONS,
          nodeId: "M6-C1-TEST",
          runtimeMode: "STANDARD",
          runtimeRoot: root,
          controlDbPath,
          startupOperations: startupOperations({ root, events, expectOwner: true }),
        }), { code: "M6_C1_CONTROL_DB_IDENTITY_INVALID" });
        assert.deepEqual(events, []);
        assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test("runtime creation failure retains the M6-C1 owner after unproven StateStore work", async () => {
  const root = runtimeRoot();
  const events = [];
  const failure = Object.assign(new Error("runtime-open-failed"), { code: "TEST_RUNTIME_OPEN_FAILED" });
  let retainedOwner;
  try {
    await assert.rejects(() => startControlPlaneServer({
      options: OPTIONS,
      nodeId: "M6-C1-TEST",
      runtimeMode: "FINAL",
      runtimeRoot: root,
      startupOperations: startupOperations({
        root,
        events,
        expectOwner: true,
        runtimeError: failure,
        onOwner(owner) { retainedOwner = owner; },
      }),
    }), { code: "TEST_RUNTIME_OPEN_FAILED" });
    assert.deepEqual(events, ["owner-acquire", "runtime-create", "state-open"]);
    assert.equal(retainedOwner.assertOwned(), true);
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), true);
  } finally {
    retainedOwner?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("listen failure closes the opened runtime and releases the M6-C1 owner", async () => {
  const root = runtimeRoot();
  const events = [];
  const failure = Object.assign(new Error("listen-failed"), { code: "TEST_LISTEN_FAILED" });
  try {
    await assert.rejects(() => startControlPlaneServer({
      options: OPTIONS,
      nodeId: "M6-C1-TEST",
      runtimeMode: "QUALIFICATION_ONLY",
      runtimeRoot: root,
      startupOperations: startupOperations({ root, events, expectOwner: true, listenError: failure }),
    }), { code: "TEST_LISTEN_FAILED" });
    assert.deepEqual(events, [
      "owner-acquire", "runtime-create", "router-create", "server-create", "listen",
      "http-close", "control-stop", "state-close",
    ]);
    assert.equal(existsSync(m6C1RuntimeOwnerLockPath(root)), false);
    assert.equal(events.includes("scheduler-start"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
