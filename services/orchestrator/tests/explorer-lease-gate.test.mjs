import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  acquireExplorerSession,
  keepExplorerSessionAlive,
  readExplorerSessionContext,
  releaseExplorerSession,
  resolveContextPath,
  verifyExplorerSession,
} from "../ops/_explore-lease.mjs";
import { runWinXiaowei } from "../ops/_explore-lib.mjs";

const ROOT = resolve(import.meta.dirname, "..");

async function fixture() {
  const state = {
    lease: null,
    session: null,
    token: "lease_token_fixture_secret",
    visible: true,
    quarantined: false,
    releaseConfirmed: true,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status, payload) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
      res.end(bytes);
    };
    if (req.method === "GET" && url.pathname === "/api/agent-entry") {
      return send(200, {
        devices: [{
          alias: "02",
          serial: "serial-02",
          control: { deviceId: "device-02" },
          state: {
            online: true,
            ready: !state.lease,
            quarantined: state.quarantined,
            leaseFree: !state.lease,
          },
        }],
      });
    }
    if (req.method === "POST" && url.pathname === "/control/v1/sessions") {
      if (state.lease) return send(423, { error: { code: "DEVICE_BUSY", message: "busy" } });
      if (body.actorId !== "agent:explorer-test" || body.capabilityId !== "xiaowei.lab.raw"
        || body.canary !== true || body.placement?.alias !== "02") {
        return send(400, { error: { code: "BAD_REQUEST", message: "bad binding" } });
      }
      state.lease = {
        leaseId: "lease-fixture",
        deviceId: "device-02",
        kind: "interactive",
        holderId: body.actorId,
        jobId: null,
        expiresAt: "2026-08-05T12:00:00.000Z",
        heartbeatAt: "2026-08-05T11:59:00.000Z",
      };
      state.session = {
        sessionId: "session-fixture",
        leaseId: state.lease.leaseId,
        token: state.token,
        actorId: body.actorId,
        deviceId: state.lease.deviceId,
        canary: true,
        scopeCapabilityId: "xiaowei.lab.raw",
        routeDecision: { selectedDevice: { alias: "02", deviceId: "device-02" } },
        expiresAt: state.lease.expiresAt,
      };
      return send(201, { session: state.session });
    }
    if (req.method === "POST" && url.pathname === "/control/v1/sessions/session-fixture/heartbeat") {
      if (!state.session) return send(404, { error: { code: "SESSION_NOT_FOUND", message: "missing" } });
      if (body.token !== state.token) return send(403, { error: { code: "SESSION_TOKEN_INVALID", message: "bad token" } });
      return send(200, { session: { ...state.session, token: undefined } });
    }
    if (req.method === "POST" && url.pathname === "/control/v1/sessions/session-fixture/release") {
      if (!state.session) return send(404, { error: { code: "SESSION_NOT_FOUND", message: "missing" } });
      if (body.token !== state.token) return send(403, { error: { code: "SESSION_TOKEN_INVALID", message: "bad token" } });
      if (state.releaseConfirmed) {
        state.lease = null;
        state.session = null;
      }
      return send(200, { released: state.releaseConfirmed, sessionId: "session-fixture" });
    }
    if (req.method === "GET" && url.pathname === "/control/v1/leases") {
      return send(200, { leases: state.lease && state.visible ? [state.lease] : [] });
    }
    return send(404, { error: { code: "NOT_FOUND", message: url.pathname } });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "explorer-lease-gate-"));
  return {
    state,
    base,
    dir,
    close: async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Explorer acquire creates a visible exclusive session and release removes it", async () => {
  const f = await fixture();
  try {
    const contextPath = join(f.dir, "session.json");
    const acquired = await acquireExplorerSession({
      alias: "02",
      actor: "agent:explorer-test",
      contextPath,
      controlBase: f.base,
      registryBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
      skipAclHardening: true,
    });
    assert.equal(acquired.context.token, undefined);
    assert.doesNotMatch(JSON.stringify(acquired), /fixture_secret/);
    assert.equal(f.state.lease.holderId, "agent:explorer-test");
    const stored = readExplorerSessionContext(contextPath, { contextRoot: f.dir }).context;
    assert.equal(stored.token, f.state.token);
    assert.equal(Object.hasOwn(stored, "controlBase"), false);
    assert.equal(Object.hasOwn(stored, "registryBase"), false);
    const verified = await verifyExplorerSession({
      contextPath,
      alias: "02",
      controlBase: f.base,
      registryBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
    });
    assert.equal(verified.lease.leaseId, "lease-fixture");
    assert.equal(verified.serial, "serial-02");
    await assert.rejects(
      acquireExplorerSession({
        alias: "02",
        actor: "agent:explorer-test",
        contextPath: join(f.dir, "second.json"),
        controlBase: f.base,
        registryBase: f.base,
        allowTestEndpoints: true,
        contextRoot: f.dir,
        skipAclHardening: true,
      }),
      (error) => error.code === "DEVICE_BUSY" && error.status === 423,
    );
    const released = await releaseExplorerSession({
      contextPath,
      controlBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
    });
    assert.equal(released.released, true);
    assert.equal(f.state.lease, null);
    assert.throws(
      () => readExplorerSessionContext(contextPath, { contextRoot: f.dir }),
      (error) => error.code === "EXPLORER_SESSION_CONTEXT_REQUIRED",
    );
  } finally { await f.close(); }
});

test("Explorer verification fails closed for alias mismatch and invisible lease", async () => {
  const f = await fixture();
  try {
    const contextPath = join(f.dir, "session.json");
    await acquireExplorerSession({
      alias: "02",
      actor: "agent:explorer-test",
      contextPath,
      controlBase: f.base,
      registryBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
      skipAclHardening: true,
    });
    await assert.rejects(
      verifyExplorerSession({
        contextPath,
        alias: "03",
        controlBase: f.base,
        registryBase: f.base,
        allowTestEndpoints: true,
        contextRoot: f.dir,
      }),
      (error) => error.code === "EXPLORER_SESSION_ALIAS_MISMATCH",
    );
    f.state.visible = false;
    await assert.rejects(
      verifyExplorerSession({
        contextPath,
        alias: "02",
        controlBase: f.base,
        registryBase: f.base,
        allowTestEndpoints: true,
        contextRoot: f.dir,
      }),
      (error) => error.code === "EXPLORER_LEASE_NOT_VISIBLE" && error.status === 423,
    );
    f.state.visible = true;
    f.state.quarantined = true;
    await assert.rejects(
      verifyExplorerSession({
        contextPath,
        alias: "02",
        controlBase: f.base,
        registryBase: f.base,
        allowTestEndpoints: true,
        contextRoot: f.dir,
      }),
      (error) => error.code === "EXPLORER_DEVICE_BINDING_CHANGED",
    );
  } finally { await f.close(); }
});

test("acquire requires post-create lease visibility and release retains context without confirmation", async () => {
  const invisible = await fixture();
  try {
    invisible.state.visible = false;
    await assert.rejects(
      acquireExplorerSession({
        alias: "02",
        actor: "agent:explorer-test",
        contextPath: join(invisible.dir, "session.json"),
        controlBase: invisible.base,
        registryBase: invisible.base,
        allowTestEndpoints: true,
        contextRoot: invisible.dir,
        skipAclHardening: true,
      }),
      (error) => error.code === "EXPLORER_LEASE_NOT_VISIBLE",
    );
    assert.equal(invisible.state.lease, null);
  } finally { await invisible.close(); }

  const release = await fixture();
  try {
    const contextPath = join(release.dir, "session.json");
    await acquireExplorerSession({
      alias: "02",
      actor: "agent:explorer-test",
      contextPath,
      controlBase: release.base,
      registryBase: release.base,
      allowTestEndpoints: true,
      contextRoot: release.dir,
      skipAclHardening: true,
    });
    release.state.releaseConfirmed = false;
    await assert.rejects(
      releaseExplorerSession({
        contextPath,
        controlBase: release.base,
        allowTestEndpoints: true,
        contextRoot: release.dir,
      }),
      (error) => error.code === "EXPLORER_RELEASE_NOT_CONFIRMED",
    );
    assert.equal(readExplorerSessionContext(contextPath, { contextRoot: release.dir }).context.sessionId, "session-fixture");
  } finally { await release.close(); }
});

test("keepalive is pinned to the acquired context identity", async () => {
  const f = await fixture();
  try {
    const contextPath = join(f.dir, "session.json");
    await acquireExplorerSession({
      alias: "02",
      actor: "agent:explorer-test",
      contextPath,
      controlBase: f.base,
      registryBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
      skipAclHardening: true,
    });
    const stored = readExplorerSessionContext(contextPath, { contextRoot: f.dir }).context;
    writeFileSync(contextPath, `${JSON.stringify({ ...stored, contextId: "replacement-context" })}\n`, "utf8");
    await assert.rejects(
      keepExplorerSessionAlive({
        contextPath,
        expectedContextId: stored.contextId,
        expectedSessionId: stored.sessionId,
        controlBase: f.base,
        registryBase: f.base,
        allowTestEndpoints: true,
        contextRoot: f.dir,
        intervalMs: 1,
        maxDurationMs: 1,
      }),
      (error) => error.code === "EXPLORER_KEEPALIVE_IDENTITY_CHANGED",
    );
  } finally { await f.close(); }
});

test("persisted contexts cannot redirect production verification to a forged loopback service", async () => {
  const f = await fixture();
  try {
    const contextPath = join(f.dir, "session.json");
    await acquireExplorerSession({
      alias: "02",
      actor: "agent:explorer-test",
      contextPath,
      controlBase: f.base,
      registryBase: f.base,
      allowTestEndpoints: true,
      contextRoot: f.dir,
      skipAclHardening: true,
    });
    const stored = JSON.parse(readFileSync(contextPath, "utf8"));
    stored.controlBase = f.base;
    writeFileSync(contextPath, `${JSON.stringify(stored)}\n`, "utf8");
    assert.throws(
      () => readExplorerSessionContext(contextPath, { contextRoot: f.dir }),
      (error) => error.code === "EXPLORER_SESSION_CONTEXT_INVALID",
    );
    await assert.rejects(
      acquireExplorerSession({
        alias: "02",
        actor: "agent:explorer-test",
        contextPath: join(f.dir, "another.json"),
        controlBase: f.base,
        registryBase: f.base,
        contextRoot: f.dir,
      }),
      (error) => error.code === "CONTROL_BASE_INVALID",
    );
  } finally { await f.close(); }
});

test("production session contexts are confined to the private profile root", () => {
  assert.throws(
    () => resolveContextPath(join(tmpdir(), "outside-explorer-root.json"), {
      alias: "02",
      actor: "agent:explorer-test",
    }),
    (error) => error.code === "EXPLORER_CONTEXT_PATH_INVALID",
  );
});

test("Xiaowei REPL revalidates the Explorer lease before every dispatch", () => {
  const source = readFileSync(join(ROOT, "ops", "_win-xiaowei.mjs"), "utf8");
  const repl = source.slice(source.indexOf("async function runRepl()"), source.indexOf("// ---- main ----"));
  assert.match(repl, /await assertActiveExplorerLease\(\);\s*\n\s*const r = await dispatch\(req\);/);
});

test("device transport and Explorer CLI primitive reject missing lease context before I/O", () => {
  assert.throws(
    () => runWinXiaowei("xhs-windows", "missing-helper.mjs", ["--serial", "serial-02", "--action", "tap"]),
    /CONTROL_LEASE_REQUIRED/,
  );
  const result = spawnSync(process.execPath, ["ops/tap.mjs", "--alias", "02", "--x", "1", "--y", "1"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, XHS_LOCAL: "1" },
  });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /session-file|CONTROL_LEASE_REQUIRED/i);
  for (const [helper, args] of [
    ["ops/_win-xiaowei.mjs", ["--serial", "serial-02", "--action", "tap", "--x", "1", "--y", "1"]],
    ["ops/_win-screencap.mjs", ["--serial", "serial-02", "--alias", "02", "--out", join(tmpdir(), "must-not-exist.png")]],
  ]) {
    const direct = spawnSync(process.execPath, [helper, ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(direct.status, 2, helper);
    assert.match(`${direct.stdout}${direct.stderr}`, /session-file|CONTROL_LEASE_REQUIRED/i, helper);
  }
});

test("every supported Explorer transport caller performs lease authorization", () => {
  const callers = [
    "back.mjs", "dump-ui.mjs", "focus.mjs", "input-text.mjs", "launch-app.mjs",
    "screenshot-and-analyze.mjs", "shell.mjs", "swipe.mjs", "tap.mjs",
    "xhs-follow-one.mjs", "xhs-like-one.mjs",
  ];
  for (const name of callers) {
    const source = readFileSync(join(ROOT, "ops", name), "utf8");
    assert.match(source, /authorizeExplorerLease/, name);
    assert.match(source, /await authorizeExplorerLease\(/, name);
  }
});

test("composite Explorer scripts propagate the same session context to child ops", () => {
  const composites = [
    "douyin-collect.mjs", "douyin-follow.mjs", "douyin-like.mjs", "douyin-search.mjs",
    "xhs-collect-one.mjs", "xhs-comment-one.mjs", "xhs-dm-open.mjs", "xhs-dm-user.mjs",
    "xhs-engage-one.mjs", "xhs-publish-draft.mjs", "xhs-publish-entry.mjs", "xhs-search.mjs",
  ];
  for (const name of composites) {
    const source = readFileSync(join(ROOT, "ops", name), "utf8");
    assert.match(source, /const sessionFile = opt\("--session-file"\)/, name);
    assert.match(source, /childArgs.*--session-file.*sessionFile/, name);
  }
  for (const name of ["douyin-collect-set.mjs", "douyin-follow-set.mjs", "douyin-like-set.mjs", "douyin-rail-set.mjs"]) {
    const source = readFileSync(join(ROOT, "ops", name), "utf8");
    assert.match(source, /--session-dir/, name);
    assert.match(source, /--session-file.*sessionDir/s, name);
  }

  const noContext = spawnSync(process.execPath, ["ops/douyin-search.mjs", "--alias", "02", "--keyword", "test"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(noContext.status, 4);
  assert.match(noContext.stdout, /session-file/);
});
