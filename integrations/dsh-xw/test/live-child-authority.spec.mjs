import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createM6LivePipeBinding } from "../src/live-pipe-client.mjs";
import { createM6LiveChildEnvironment } from "../src/live-process-adapter.mjs";

const integrationRoot = resolve(new URL("../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ""));
const guard = join(integrationRoot, "src", "live-network-guard.mjs");
const fixture = join(integrationRoot, "test", "fixtures", "live-authority-child.mjs");

function binding() {
  return createM6LivePipeBinding({
    runId: "run:authority-test", workerId: "worker:authority-test", sessionId: "session:authority-test",
    alias: "01", processRef: "process:authority-test", gateEpochHash: "a".repeat(64), generation: 1,
    purpose: "M6_4_ACTION_SMOKE", scenarioManifestHash: "b".repeat(64), liveWindowAuthorizationHash: "c".repeat(64),
  });
}

test("production child environment replaces user roots and drops control/raw authority", () => {
  const persistenceRoot = resolve("C:/xw-test/persistence");
  const env = createM6LiveChildEnvironment({
    sourceEnv: {
      PATH: process.env.PATH,
      HOME: "C:/Users/operator",
      USERPROFILE: "C:/Users/operator",
      TEMP: "C:/Users/operator/AppData/Temp",
      CONTROL_PLANE_DB: "C:/secret/control.db",
      ANDROID_SERIAL: "raw-device",
    },
    binding: binding(),
    runtimeEnv: {
      XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.example.invalid",
      XW_M6_LIVE_MODEL_PROFILE_HASH: "d".repeat(64),
      XW_M6_LIVE_MODEL_PROFILE_ROOT: resolve("C:/xw-test/model"),
      XW_DSH_PERSISTENCE_ROOT: persistenceRoot,
    },
    credentialEnv: { DEEPSEEK_API_KEY: "test-only-key" },
    dependencyEnv: {
      XW_M6_LIVE_DEPENDENCY_ROOT: resolve("C:/xw-test/layer"),
      XW_M6_LIVE_DEPENDENCY_LAYER_HASH: "e".repeat(64),
    },
  });
  assert.equal(env.HOME, join(persistenceRoot, ".sandbox", "home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.TEMP, join(persistenceRoot, ".sandbox", "temp"));
  assert.equal(env.TMP, env.TEMP);
  assert.equal(Object.hasOwn(env, "CONTROL_PLANE_DB"), false);
  assert.equal(Object.hasOwn(env, "ANDROID_SERIAL"), false);
  assert.equal(Object.hasOwn(env, "XW_M6_BROKER_TOKEN"), false);
});

test("Node permission boundary and network guard deny filesystem, child-process, and local socket authority", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xw-m6-child-authority-"));
  const allowed = join(root, "allowed");
  const forbidden = join(root, "forbidden.txt");
  mkdirSync(allowed, { recursive: true });
  writeFileSync(join(allowed, "read.txt"), "allowed\n");
  writeFileSync(forbidden, "forbidden\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const output = execFileSync(process.execPath, [
    "--permission",
    `--allow-fs-read=${integrationRoot}`,
    `--allow-fs-read=${allowed}`,
    `--allow-fs-write=${allowed}`,
    "--import",
    pathToFileURL(guard).href,
    fixture,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      XW_M6_LIVE_PROVIDER_BASE_URL: "https://provider.example.invalid",
      XW_TEST_ALLOWED_ROOT: allowed,
      XW_TEST_FORBIDDEN_PATH: forbidden,
      CONTROL_PLANE_DB: "C:/secret/control.db",
      ANDROID_SERIAL: "raw-device",
    },
    windowsHide: true,
  });
  const result = JSON.parse(output);
  assert.equal(result.allowedRead, "allowed");
  assert.equal(result.allowedWriteCode, null);
  assert.equal(result.forbiddenReadCode, "ERR_ACCESS_DENIED");
  assert.equal(result.forbiddenWriteCode, "ERR_ACCESS_DENIED");
  assert.equal(result.childProcessCode, "ERR_ACCESS_DENIED");
  assert.equal(result.directSocketCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.socketPrototypeCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.serverListenCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dgramConstructorCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.http2ConnectCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.webSocketCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dnsSetServersCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dnsResolveCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dnsResolverCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dnsPromisesResolverCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.dnsPromisesResolveCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  assert.equal(result.forbiddenFetchCode, "M6_LIVE_CHILD_NETWORK_DENIED");
  // The permission probe deliberately injects these values to prove filesystem
  // and network denial. The production environment test above proves the real
  // launcher never forwards them in the first place.
  assert.equal(result.inheritedControlDb, true);
  assert.equal(result.inheritedRawDevice, true);
  assert.equal(dirname(fixture), join(integrationRoot, "test", "fixtures"));
});
