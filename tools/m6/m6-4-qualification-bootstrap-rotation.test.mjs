import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  deriveM64QualificationRotationFixedInput,
  main,
  operateM64QualificationBootstrapRotationFixed,
  parseM64QualificationRotationFixedArgs,
} from "./m6-4-qualification-bootstrap-rotation.mjs";

const RELEASE = "xw-fixed-qualification-rotation";
const SOURCE = "c".repeat(40);
const PACKAGE = "d".repeat(64);

test("fixed rotation derives all five generic-library paths from release/source/package only", async () => {
  const runtimeRoot = resolve("C:\\test-runtime-root");
  const snapshotBaseRoot = resolve("C:\\test-snapshot-root");
  const expected = {
    bootstrapPackagePath: join(
      runtimeRoot,
      "m6-audit",
      `m6-c1-qualification-bootstrap-${SOURCE.slice(0, 7)}`,
      "packages",
      `${PACKAGE}.package.json`,
    ),
    issuerAllowlistPath: join(runtimeRoot, "m6-gate", "issuer-keys.json"),
    releaseRoot: join(runtimeRoot, "releases", RELEASE),
    runtimeRoot,
    snapshotRoot: join(
      snapshotBaseRoot,
      `m6-c1-qualification-bootstrap-${SOURCE.slice(0, 7)}-${PACKAGE.slice(0, 16)}`,
    ),
  };
  assert.deepEqual(deriveM64QualificationRotationFixedInput({
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    packageHash: PACKAGE,
  }, { runtimeRoot, snapshotBaseRoot }), expected);

  const calls = [];
  const result = await operateM64QualificationBootstrapRotationFixed({
    releaseId: RELEASE,
    sourceCommit: SOURCE,
    packageHash: PACKAGE,
  }, {
    execute: false,
    runtimeRoot,
    snapshotBaseRoot,
    now: () => 1_893_456_000_000,
    operator: async (input, options) => {
      calls.push({ input, options });
      return { ok: true, executed: options.execute };
    },
    operatorDependencies: { sentinel: "fixed-test" },
  });
  assert.deepEqual(result, { ok: true, executed: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, expected);
  assert.equal(calls[0].options.execute, false);
  assert.equal(calls[0].options.dependencies.sentinel, "fixed-test");
  assert.equal(calls[0].options.dependencies.now(), 1_893_456_000_000);
});

test("fixed rotation CLI accepts only the positional fixed grammar and maps execute exactly", async () => {
  assert.deepEqual(
    parseM64QualificationRotationFixedArgs([
      "preflight-fixed", RELEASE, SOURCE, PACKAGE,
    ]),
    {
      command: "preflight-fixed",
      releaseId: RELEASE,
      sourceCommit: SOURCE,
      packageHash: PACKAGE,
    },
  );
  for (const argv of [
    ["preflight-fixed", RELEASE, SOURCE, PACKAGE, "--runtime-root=C:\\tmp"],
    ["execute-fixed", RELEASE, SOURCE, PACKAGE, "C:\\caller\\package.json"],
    ["execute-fixed", RELEASE, SOURCE, "--input"],
    ["preflight", "--bootstrap-package", "C:\\caller\\package.json"],
    ["execute-fixed", RELEASE, SOURCE, PACKAGE, "1234"],
  ]) {
    assert.throws(() => parseM64QualificationRotationFixedArgs(argv), {
      code: "M64_QUALIFICATION_ROTATION_ARGUMENT_INVALID",
    });
  }

  const calls = [];
  let stdout = "";
  const exitCode = await main(["execute-fixed", RELEASE, SOURCE, PACKAGE], {
    stdout: { write(value) { stdout += value; } },
    stderr: { write() {} },
    fixedDependencies: {
      runtimeRoot: resolve("C:\\test-runtime-root"),
      snapshotBaseRoot: resolve("C:\\test-snapshot-root"),
      operator: async (input, options) => {
        calls.push({ input, options });
        return { ok: true, executed: options.execute };
      },
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), { ok: true, executed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.execute, true);
});
