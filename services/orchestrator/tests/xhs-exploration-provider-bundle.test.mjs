import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildExplorationVisionProviderBundle,
  enumeratePythonRuntimeClosure,
  readExplorationVisionProviderBundle,
  stageExplorationVisionProviderBundle,
  verifyExplorationVisionProviderBundle,
  verifyPythonRuntimeClosure,
} from "../scripts/lib/xhs-exploration-provider-bundle.mjs";
import { resolvePinnedVisionConfig } from "../scripts/lib/xhs-exploration-vision.mjs";
import {
  buildPinnedVisionConfig,
  EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST,
  EXPLORATION_VISION_RELEASE_MANIFEST_PATH,
  selectPinnedInterpreterFromCandidates,
  writePinnedVisionConfig,
} from "../ops/xw-xhs-vision-pin.mjs";
import { canonicalJson } from "../scripts/lib/xhs-exploration-mission.mjs";
import {
  provisionPrivateProviderClosure,
  verifyResolvedPrivateProviderConfig,
} from "../scripts/lib/xhs-exploration-private-runtime.mjs";

const PIN_CLI = fileURLToPath(new URL("../ops/xw-xhs-vision-pin.mjs", import.meta.url));

function inputs(root, prefix = "") {
  const runtime = join(root, `${prefix}runtime`);
  mkdirSync(runtime, { recursive: true });
  const python = join(runtime, "python.exe");
  const script = join(root, `${prefix}analyze.py`);
  const model = join(root, `${prefix}model.json`);
  const data = join(root, `${prefix}labels.dat`);
  writeFileSync(python, "exact-interpreter-bytes");
  writeFileSync(script, "exact-provider-entry-bytes");
  writeFileSync(model, "exact-model-bytes");
  writeFileSync(data, "exact-auxiliary-data-bytes");
  return {
    python,
    script,
    model,
    dataFiles: [
      ...enumeratePythonRuntimeClosure({ python }),
      { logicalPath: "data/labels.dat", path: data },
    ],
  };
}

test("canonical provider bundle reproduces across mutable installation paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-bundle-reproduce-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const left = inputs(root, "left-");
  const right = inputs(root, "right-");
  const first = buildExplorationVisionProviderBundle({
    ...left,
    maxBufferBytes: 64 * 1024,
    timeoutMs: 7_000,
  });
  const second = buildExplorationVisionProviderBundle({
    ...right,
    maxBufferBytes: 64 * 1024,
    timeoutMs: 7_000,
  });
  assert.equal(first.providerBundleDigest, second.providerBundleDigest);
  assert.deepEqual(first.bytes, second.bytes);
  const manifestText = first.bytes.toString("utf8");
  for (const path of [left.python, left.script, left.model, left.dataFiles[0].path]) {
    assert.equal(manifestText.includes(path), false, "mutable absolute path entered bundle identity");
  }
});

test("stage/pin/verify binds config and all provider bytes to providerBundleDigest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-bundle-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = inputs(root);
  const manifestPath = join(root, "provider-bundle.v1.json");
  const configPath = join(root, "provider-config.json");
  const staged = stageExplorationVisionProviderBundle({
    manifestPath,
    ...source,
    maxBufferBytes: 32 * 1024,
    timeoutMs: 6_000,
  });
  const config = buildPinnedVisionConfig({
    bundleManifest: manifestPath,
    ...source,
    maxBufferBytes: 32 * 1024,
    timeoutMs: 6_000,
  });
  writePinnedVisionConfig(config, configPath);
  const resolved = resolvePinnedVisionConfig(configPath);
  assert.equal(resolved.provider.providerBundleDigest, staged.providerBundleDigest);
  assert.deepEqual(resolved.allowedModes, ["shadow", "canary1"]);
  assert.equal(Object.hasOwn(resolved, "mode"), false, "provider config must not carry rollout authority");
  assert.equal(resolved.bundle.manifest.sha256, staged.providerBundleDigest);
  assert.equal(resolved.pin.data.length, 1);
  assert.equal(
    verifyExplorationVisionProviderBundle({ manifestPath, ...source }).providerBundleDigest,
    staged.providerBundleDigest,
  );

  const partial = structuredClone(config);
  delete partial.bundle;
  writeFileSync(configPath, JSON.stringify(partial));
  assert.throws(
    () => resolvePinnedVisionConfig(configPath),
    (error) => error.code === "EXPLORATION_VISION_CONFIG_INVALID",
    "legacy four-hash identity must not resolve without the bundle digest",
  );
  assert.throws(
    () => buildPinnedVisionConfig({ mode: "shadow", bundleManifest: manifestPath, ...source }),
    (error) => error.code === "VISION_PIN_MODE_OVERRIDE_FORBIDDEN",
  );
});

test("production pin CLI uses the fixed release and rejects every caller override", () => {
  const stage = spawnSync(process.execPath, [PIN_CLI, "stage"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stage.status, 0, stage.stdout || stage.stderr);
  const stageResult = JSON.parse(stage.stdout);
  assert.equal(stageResult.providerBundleDigest, EXPLORATION_VISION_FIXED_PROVIDER_BUNDLE_DIGEST);
  assert.equal(stageResult.manifestPath, EXPLORATION_VISION_RELEASE_MANIFEST_PATH);

  const overrideCases = [
    ["stage", "--manifest", "C:\\tmp\\manifest.json"],
    ["stage", "--python", "C:\\tmp\\python.exe"],
    ["pin", "--mode", "shadow"],
    ["pin", "--config", "C:\\tmp\\provider.json"],
    ["pin", "--runtime-root", "C:\\tmp"],
    ["pin", "--script", "C:\\tmp\\analyze.py"],
    ["pin", "--model", "C:\\tmp\\model.json"],
    ["pin", "--data", "data/x=C:\\tmp\\x"],
    ["pin", "--output", "C:\\tmp\\out.json"],
    ["verify", "--config", "C:\\tmp\\provider.json"],
    ["verify", "unexpected-positional"],
  ];
  for (const argv of overrideCases) {
    const result = spawnSync(process.execPath, [PIN_CLI, ...argv], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 2, `${argv.join(" ")}\n${result.stdout || result.stderr}`);
    assert.equal(JSON.parse(result.stdout).error.code, "VISION_PIN_OVERRIDES_FORBIDDEN");
  }
});

test("controlled interpreter discovery selects only exact manifest-bound bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-interpreter-select-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrong = join(root, "wrong-python.exe");
  const exact = join(root, "exact-python.exe");
  writeFileSync(wrong, "wrong-interpreter");
  writeFileSync(exact, "exact-interpreter");
  const exactBytes = readFileSync(exact);
  const expectedSha256 = createHash("sha256").update(exactBytes).digest("hex");
  assert.equal(selectPinnedInterpreterFromCandidates({
    expectedSha256,
    expectedSize: exactBytes.length,
    candidates: [wrong, exact],
  }), exact);
  assert.throws(
    () => selectPinnedInterpreterFromCandidates({
      expectedSha256,
      expectedSize: exactBytes.length,
      candidates: [wrong],
    }),
    (error) => error.code === "VISION_PIN_INTERPRETER_NOT_FOUND",
  );
});

test("Python stdlib, pyd, DLL and exact runtime file-set drift are transitively pinned", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-python-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "runtime");
  const libJson = join(runtime, "Lib", "json");
  const sitePackages = join(runtime, "Lib", "site-packages");
  const pycache = join(libJson, "__pycache__");
  const dlls = join(runtime, "DLLs");
  for (const directory of [runtime, libJson, sitePackages, pycache, dlls]) {
    mkdirSync(directory, { recursive: true });
  }
  const python = join(runtime, "python.exe");
  const runtimeDll = join(runtime, "python314.dll");
  const pyd = join(dlls, "_hashlib.pyd");
  const jsonModule = join(libJson, "__init__.py");
  writeFileSync(python, "python-launcher");
  writeFileSync(runtimeDll, "python-runtime-dll");
  writeFileSync(pyd, "hashlib-extension");
  writeFileSync(jsonModule, "json-stdlib");
  writeFileSync(join(sitePackages, "caller_plugin.py"), "must-be-unreachable");
  writeFileSync(join(pycache, "__init__.pyc"), "must-use-private-prefix");
  const script = join(root, "analyze.py");
  const model = join(root, "model.json");
  const manifestPath = join(root, "provider-bundle.v1.json");
  writeFileSync(script, "provider-entry");
  writeFileSync(model, "provider-model");
  const dataFiles = enumeratePythonRuntimeClosure({ python });
  assert.deepEqual(dataFiles.map((row) => row.logicalPath), [
    "data/python-runtime/DLLs/_hashlib.pyd",
    "data/python-runtime/Lib/json/__init__.py",
    "data/python-runtime/root/python314.dll",
  ]);
  stageExplorationVisionProviderBundle({ manifestPath, python, script, model, dataFiles });
  verifyExplorationVisionProviderBundle({ manifestPath, python, script, model, dataFiles });
  verifyPythonRuntimeClosure({ python, dataFiles });

  writeFileSync(jsonModule, "json-stdlib-drift");
  assert.throws(
    () => verifyExplorationVisionProviderBundle({ manifestPath, python, script, model, dataFiles }),
    (error) => error.code === "EXPLORATION_VISION_BUNDLE_DRIFT",
  );
  writeFileSync(jsonModule, "json-stdlib");
  writeFileSync(join(runtime, "Lib", "injected.py"), "new-import-shadow");
  assert.throws(
    () => verifyPythonRuntimeClosure({ python, dataFiles }),
    (error) => error.code === "EXPLORATION_VISION_RUNTIME_CLOSURE_DRIFT",
    "new unmanifested modules must fail the exact-set check",
  );
});

test("provision creates one protected content-addressed execution closure and never falls back to source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-private-provision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = inputs(root);
  const manifestPath = join(root, "provider-bundle.v1.json");
  const configPath = join(root, "provider-config.json");
  const staged = stageExplorationVisionProviderBundle({ manifestPath, ...source });
  const protectedAnchor = join(root, "protected");
  const providerRoot = join(protectedAnchor, "providers");
  const targetRoot = join(providerRoot, staged.providerBundleDigest);
  const hardened = new Set();
  const hardenTree = (path) => { hardened.add(path); return true; };
  const verifyAcl = (path) => {
    assert.equal(hardened.has(path) || path === targetRoot, true, `unhardened path verified: ${path}`);
    return true;
  };
  const installed = provisionPrivateProviderClosure({
    source: { manifestPath, ...source },
    providerBundleDigest: staged.providerBundleDigest,
    targetRoot,
    protectedAnchor,
    hardenTree,
    verifyAcl,
  });
  assert.equal(installed.targetRoot, targetRoot);
  assert.equal(installed.closure.providerBundleDigest, staged.providerBundleDigest);
  const config = buildPinnedVisionConfig({
    bundleManifest: installed.manifestPath,
    python: installed.python,
    script: installed.script,
    model: installed.model,
    dataFiles: installed.dataFiles,
  });
  writePinnedVisionConfig(config, configPath);
  const resolved = resolvePinnedVisionConfig(configPath);
  verifyResolvedPrivateProviderConfig(resolved, { providerRoot, verifyAcl });

  writeFileSync(source.script, "untrusted-source-drift");
  verifyResolvedPrivateProviderConfig(resolved, { providerRoot, verifyAcl });
  assert.throws(
    () => provisionPrivateProviderClosure({
      source: { manifestPath, ...source },
      providerBundleDigest: staged.providerBundleDigest,
      targetRoot,
      protectedAnchor,
      hardenTree,
      verifyAcl,
    }),
    (error) => error.code === "EXPLORATION_VISION_PRIVATE_CREATE_ONLY",
  );
});

test("interpreter/script/model/data/config/protocol/manifest drift all fail reproduction", (t) => {
  const root = mkdtempSync(join(tmpdir(), "xhs-provider-bundle-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = inputs(root);
  const manifestPath = join(root, "provider-bundle.v1.json");
  const staged = stageExplorationVisionProviderBundle({
    manifestPath,
    ...source,
    maxBufferBytes: 64 * 1024,
    timeoutMs: 7_000,
  });

  for (const [name, path] of [
    ["interpreter", source.python],
    ["entry", source.script],
    ["model", source.model],
    ["data", source.dataFiles[0].path],
  ]) {
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from(`-${name}-drift`)]));
    assert.throws(
      () => verifyExplorationVisionProviderBundle({ manifestPath, ...source }),
      (error) => error.code === "EXPLORATION_VISION_BUNDLE_DRIFT",
      name,
    );
    writeFileSync(path, original);
  }

  const retuned = buildExplorationVisionProviderBundle({
    ...source,
    maxBufferBytes: 64 * 1024,
    timeoutMs: 6_999,
  });
  assert.notEqual(retuned.providerBundleDigest, staged.providerBundleDigest, "retune must create a new bundle identity");

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  parsed.configuration.processProtocol = "xw.xhs.exploration-vision-process.v2";
  writeFileSync(manifestPath, `${canonicalJson(parsed)}\n`);
  assert.throws(
    () => readExplorationVisionProviderBundle(manifestPath),
    (error) => error.code === "EXPLORATION_VISION_BUNDLE_MANIFEST_INVALID",
    "protocol drift cannot retain the old bundle",
  );

  const canonical = buildExplorationVisionProviderBundle({
    ...source,
    maxBufferBytes: 64 * 1024,
    timeoutMs: 7_000,
  });
  writeFileSync(manifestPath, Buffer.concat([canonical.bytes, Buffer.from(" \n")]));
  assert.throws(
    () => readExplorationVisionProviderBundle(manifestPath),
    (error) => error.code === "EXPLORATION_VISION_BUNDLE_MANIFEST_NONCANONICAL",
    "even whitespace drift changes the exact manifest bytes",
  );
});
