import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildExplorationVisionProcessArgs,
  createPinnedExplorationVisionAnalyzer,
  EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS,
  EXPLORATION_VISION_PROCESS_MAX_BUFFER_BYTES,
} from "../scripts/lib/xhs-exploration-vision-process.mjs";
import {
  enumeratePythonRuntimeClosure,
  stageExplorationVisionProviderBundle,
} from "../scripts/lib/xhs-exploration-provider-bundle.mjs";
import { buildPinnedVisionConfig } from "../ops/xw-xhs-vision-pin.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(t, scriptBody, {
  maxBufferBytes = 64 * 1024,
  spawnImpl = spawn,
  env = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "xhs-vision-process-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "analyze.mjs");
  const model = join(root, "model.bin");
  const stagingRoot = join(root, "private-staging");
  writeFileSync(script, scriptBody, "utf8");
  writeFileSync(model, Buffer.from("pinned-model-bytes"));
  const config = {
    pin: {
      python: { path: process.execPath, sha256: "a".repeat(64) },
      script: { path: script, sha256: "b".repeat(64) },
      model: { path: model, sha256: hash(Buffer.from("pinned-model-bytes")) },
    },
    analysis: {
      protocol: "xw.xhs.exploration-vision-process.v1",
      maxBufferBytes,
      timeoutMs: EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS,
    },
  };
  const analyzer = createPinnedExplorationVisionAnalyzer(config, { stagingRoot, spawnImpl, env });
  return { analyzer, root, stagingRoot };
}

function exactResultScript(mutation = "") {
  return `
    import { createHash } from "node:crypto";
    import { readFileSync, writeFileSync } from "node:fs";
    const input = process.argv[2];
    const output = process.argv[process.argv.indexOf("-o") + 1];
    const bytes = readFileSync(input);
    const result = {
      schemaId: "xw.xhs.exploration-vision-process-result.v1",
      schemaVersion: 1,
      frameHash: createHash("sha256").update(bytes).digest("hex"),
      modelHash: process.env.XW_VISION_MODEL_SHA256,
      page: process.env.XW_VISION_PAGE,
      role: process.env.XW_VISION_REQUESTED_ROLE,
      elements: [{ label: "暂停", bounds: { x: 100, y: 300, w: 200, h: 160 }, confidence: 0.91 }],
    };
    ${mutation}
    writeFileSync(output, JSON.stringify(result));
  `;
}

function request(bytes, extra = {}) {
  return {
    frame: {
      frameId: "frame-03-1",
      pngPath: "C:\\caller-path-must-not-be-used\\screen.png",
      bytes,
      frameHash: hash(bytes),
      capturedAt: 1_800_000_000_000,
    },
    page: "VIDEO_NOTE",
    requestedRole: "PAUSE_VIDEO_SAFE_ZONE",
    deadlineMs: 2_000,
    ...extra,
  };
}

test("Python provider args force isolated stdlib and a fresh private pycache prefix", () => {
  const args = buildExplorationVisionProcessArgs(
    { pin: { script: { path: "C:\\fixed-release\\analyze.py" } } },
    "C:\\private\\request-1",
    "C:\\private\\request-1\\frame.png",
    "C:\\private\\request-1\\elements.json",
  );
  assert.deepEqual(args.slice(0, 5), [
    "-I",
    "-S",
    "-B",
    "-X",
    `pycache_prefix=${join("C:\\private\\request-1", "pycache")}`,
  ]);
  assert.equal(args[5], "C:\\fixed-release\\analyze.py");
});

test("production bundle closure is verified before analyzer activation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-vision-pre-spawn-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  const source = join(root, "provider");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(source, { recursive: true });
  const interpreter = join(runtime, process.platform === "win32" ? "node.exe" : "node");
  const script = join(source, "analyze.mjs");
  const model = join(source, "model.bin");
  const manifestPath = join(source, "provider-bundle.v1.json");
  copyFileSync(process.execPath, interpreter);
  writeFileSync(script, exactResultScript(), "utf8");
  writeFileSync(model, "pinned-model-bytes");
  const dataFiles = enumeratePythonRuntimeClosure({ python: interpreter });
  assert.equal(dataFiles.length, 0);
  stageExplorationVisionProviderBundle({
    manifestPath,
    python: interpreter,
    script,
    model,
    dataFiles,
  });
  const config = buildPinnedVisionConfig({
    bundleManifest: manifestPath,
    python: interpreter,
    script,
    model,
    dataFiles,
  });
  const analyzer = createPinnedExplorationVisionAnalyzer(config, {
    stagingRoot: join(root, "private"),
  });
  const bytes = Buffer.from("closure-bound-frame");
  assert.equal((await analyzer.analyze(request(bytes))).length, 1);
  await analyzer.close();
  writeFileSync(join(runtime, "injected.js"), "new-runtime-module");
  assert.throws(
    () => createPinnedExplorationVisionAnalyzer(config, {
      stagingRoot: join(root, "private-drifted"),
    }),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_CLOSURE_DRIFT",
  );
});

test("pinned analyzer spawns without a shell and analyzes a private exact-byte staging copy", async (t) => {
  const calls = [];
  const wrappedSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return spawn(command, args, options);
  };
  const { analyzer, stagingRoot } = fixture(t, exactResultScript(`
    if (process.env.API_TOKEN || process.env.HTTPS_PROXY || process.env.OPENAI_API_KEY
      || process.env.XW_VISION_TOKEN || process.env.PYTHONPATH || process.env.PYTHONHOME
      || process.env.PYTHONSTARTUP || process.env.NODE_OPTIONS
      || process.env.PATH?.includes("poisoned-path")) {
      process.exit(9);
    }
  `), {
    spawnImpl: wrappedSpawn,
    env: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      PATH: "C:\\poisoned-path",
      HTTPS_PROXY: "http://secret-proxy",
      https_proxy: "http://lowercase-secret-proxy",
      API_TOKEN: "secret-token",
      OPENAI_API_KEY: "secret-api-key",
      XW_VISION_TOKEN: "secret-vision-token",
      PYTHONPATH: "C:\\attacker-module-path",
      PYTHONHOME: "C:\\attacker-python-home",
      PYTHONSTARTUP: "C:\\attacker-startup.py",
      NODE_OPTIONS: "--require=C:\\attacker.js",
    },
  });
  const bytes = Buffer.from("exact CP-owned PNG bytes");
  const blocks = await analyzer.analyze(request(bytes));
  assert.deepEqual(blocks, [{
    label: "暂停",
    bounds: { x: 100, y: 300, w: 200, h: 160 },
    confidence: 0.91,
    capturedAt: 1_800_000_000_000,
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.XW_VISION_PAGE, "VIDEO_NOTE");
  assert.equal(calls[0].options.env.XW_VISION_REQUESTED_ROLE, "PAUSE_VIDEO_SAFE_ZONE");
  assert.equal(calls[0].options.env.SystemRoot, "C:\\Windows");
  assert.equal(calls[0].options.env.TEMP, "C:\\Temp");
  assert.equal(calls[0].options.env.PYTHONNOUSERSITE, "1");
  assert.equal(calls[0].options.env.PATH.includes("poisoned-path"), false, "caller PATH leaked to provider child");
  for (const forbidden of [
    "HTTPS_PROXY", "https_proxy", "API_TOKEN", "OPENAI_API_KEY", "XW_VISION_TOKEN",
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "NODE_OPTIONS",
  ]) {
    assert.equal(Object.hasOwn(calls[0].options.env, forbidden), false, `${forbidden} leaked to provider child`);
  }
  assert.notEqual(calls[0].args[1], request(bytes).frame.pngPath, "provider receives private staging, not the CP/caller path");
  assert.equal(readdirSync(stagingRoot).length, 0, "request staging is removed after result binding");
  await analyzer.close();
});

test("process result requires exact schema and frame/model/page/role bindings", async (t) => {
  const bytes = Buffer.from("result-binding-frame");
  const cases = [
    ["missing schema", "delete result.schemaId;", "EXPLORATION_VISION_PROVIDER_RESULT_INVALID"],
    ["schema version drift", "result.schemaVersion = 2;", "EXPLORATION_VISION_PROVIDER_RESULT_INVALID"],
    ["extra field", "result.oracle = true;", "EXPLORATION_VISION_PROVIDER_RESULT_INVALID"],
    ["extra element field", "result.elements[0].oracle = true;", "EXPLORATION_VISION_PROVIDER_RESULT_INVALID"],
    ["frame drift", `result.frameHash = "${"f".repeat(64)}";`, "EXPLORATION_VISION_RESULT_FRAME_MISMATCH"],
    ["model drift", `result.modelHash = "${"e".repeat(64)}";`, "EXPLORATION_VISION_RESULT_MODEL_MISMATCH"],
    ["page drift", "result.page = 'IMAGE_NOTE';", "EXPLORATION_VISION_RESULT_ROUTE_MISMATCH"],
    ["role drift", "result.role = 'OPEN_COMMENT_PANEL';", "EXPLORATION_VISION_RESULT_ROUTE_MISMATCH"],
  ];
  for (const [name, mutation, code] of cases) {
    await t.test(name, async (subtest) => {
      const { analyzer } = fixture(subtest, exactResultScript(mutation));
      await assert.rejects(analyzer.analyze(request(bytes)), (error) => error.code === code);
      await analyzer.close();
    });
  }
});

test("deadline is hard-capped, asynchronous, and terminates the owned child", async (t) => {
  const { analyzer } = fixture(t, `
    import { writeFileSync } from "node:fs";
    const output = process.argv[process.argv.indexOf("-o") + 1];
    setTimeout(() => writeFileSync(output, JSON.stringify({ elements: [] })), 5_000);
  `);
  const bytes = Buffer.from("slow-frame");
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  const started = Date.now();
  await assert.rejects(
    analyzer.analyze(request(bytes, { deadlineMs: 80 })),
    (error) => error.code === "EXPLORATION_VISION_DEADLINE",
  );
  clearInterval(interval);
  assert.ok(Date.now() - started < 2_000, "deadline does not wait for the provider's five-second timer");
  assert.ok(ticks > 0, "provider work did not starve the event loop");
  assert.equal(analyzer.stats().active, 0);
  await assert.rejects(
    analyzer.analyze(request(bytes, { deadlineMs: EXPLORATION_VISION_PROCESS_DEADLINE_CAP_MS + 1 })),
    (error) => error.code === "EXPLORATION_VISION_DEADLINE_INVALID",
  );
});

test("each request exposes an owned cancel handle and AbortSignal cancellation is fail-closed", async (t) => {
  const { analyzer } = fixture(t, `setInterval(() => {}, 10_000);`);
  const bytes = Buffer.from("cancel-frame");
  const first = analyzer.start(request(bytes));
  const controller = new AbortController();
  const second = analyzer.analyze(request(bytes, { signal: controller.signal }));
  await first.cancel("test-owned-cancel");
  await assert.rejects(first.result, (error) => error.code === "EXPLORATION_VISION_CANCELLED");
  assert.equal(analyzer.stats().active, 1, "cancelling one request does not kill another request's child");

  controller.abort();
  await assert.rejects(second, (error) => error.code === "EXPLORATION_VISION_CANCELLED");
  assert.equal(analyzer.stats().active, 0);

  const closing = analyzer.start(request(bytes));
  await analyzer.close();
  await assert.rejects(closing.result, (error) => error.code === "EXPLORATION_VISION_CANCELLED");
  assert.equal(analyzer.stats().active, 0);
});

test("stdout, stderr, and result files are independently bounded", async (t) => {
  const bytes = Buffer.from("bounded-frame");
  const stdoutFixture = fixture(t, `
    process.stdout.write("x".repeat(8192));
    setInterval(() => {}, 10_000);
  `, { maxBufferBytes: 256 });
  await assert.rejects(
    stdoutFixture.analyzer.analyze(request(bytes)),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_OUTPUT_LIMIT",
  );

  const stderrFixture = fixture(t, `
    process.stderr.write("x".repeat(8192));
    setInterval(() => {}, 10_000);
  `, { maxBufferBytes: 256 });
  await assert.rejects(
    stderrFixture.analyzer.analyze(request(bytes)),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_OUTPUT_LIMIT",
  );

  const resultFixture = fixture(t, `
    import { writeFileSync } from "node:fs";
    const output = process.argv[process.argv.indexOf("-o") + 1];
    writeFileSync(output, JSON.stringify({ elements: [], padding: "x".repeat(8192) }));
  `, { maxBufferBytes: 256 });
  await assert.rejects(
    resultFixture.analyzer.analyze(request(bytes)),
    (error) => error.code === "EXPLORATION_VISION_PROVIDER_RESULT_LIMIT",
  );
});

test("frame hash mismatch is rejected before spawn or staging", async (t) => {
  let spawns = 0;
  const { analyzer, stagingRoot } = fixture(t, "process.exit(0);", {
    spawnImpl: (...args) => { spawns += 1; return spawn(...args); },
  });
  mkdirSync(stagingRoot, { recursive: true });
  const bad = request(Buffer.from("frame-a"));
  bad.frame.frameHash = hash(Buffer.from("frame-b"));
  assert.throws(
    () => analyzer.start(bad),
    (error) => error.code === "EXPLORATION_VISION_FRAME_HASH_MISMATCH",
  );
  assert.equal(spawns, 0);
  assert.equal(readdirSync(stagingRoot).length, 0);
});

test("offline process accepts only the closed page/role pairs before spawn", (t) => {
  let spawns = 0;
  const { analyzer } = fixture(t, "process.exit(0);", {
    spawnImpl: (...args) => { spawns += 1; return spawn(...args); },
  });
  const bytes = Buffer.from("route-bound-frame");
  assert.throws(
    () => analyzer.start(request(bytes, {
      page: "IMAGE_NOTE",
      requestedRole: "PAUSE_VIDEO_SAFE_ZONE",
    })),
    (error) => error.code === "EXPLORATION_VISION_REQUEST_ROUTE_INVALID",
  );
  assert.equal(spawns, 0);
});

test("process adapter has an absolute output cap independent of a forged config", (t) => {
  assert.throws(
    () => fixture(t, "process.exit(0);", {
      maxBufferBytes: EXPLORATION_VISION_PROCESS_MAX_BUFFER_BYTES + 1,
    }),
    (error) => error.code === "EXPLORATION_VISION_PROCESS_CONFIG_INVALID",
  );
});
