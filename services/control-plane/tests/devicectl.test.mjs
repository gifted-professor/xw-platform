import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REMOTE_REPO,
  decodeForwardedArgv,
  encodeForwardedArgv,
  remotePowerShell,
} from "../control-plane/devicectl.mjs";

test("remote devicectl defaults to the deployed Windows checkout", () => {
  assert.equal(DEFAULT_REMOTE_REPO, "C:\\Users\\Public\\xhs-routing-v1-1");
});

test("base64 forwarding preserves JSON params as one exact argument", () => {
  const argv = [
    "route",
    "plan",
    "--actor",
    "agent-a",
    "--capability",
    "xianyu.publish.full_dry_run",
    "--params",
    JSON.stringify({ description: "中文", nested: { saveDraft: false }, values: [1, 2] }),
  ];
  assert.deepEqual(decodeForwardedArgv(encodeForwardedArgv(argv)), argv);
});

test("PowerShell forwards opaque base64 instead of reparsing JSON", () => {
  const secretLikeValue = JSON.stringify({ token: "quote-sensitive-value" });
  const encoded = encodeForwardedArgv(["route", "plan", "--params", secretLikeValue]);
  const script = remotePowerShell(DEFAULT_REMOTE_REPO, encoded, "DESKTOP-3I1EVHE");
  assert.match(script, /--forwarded-argv-base64/);
  assert.match(script, new RegExp(encoded));
  assert.doesNotMatch(script, /ConvertFrom-Json|quote-sensitive-value/);
});

test("invalid forwarded argv fails closed", () => {
  assert.throws(() => decodeForwardedArgv("not-base64"), { code: "CLI_FORWARDED_ARGS_INVALID" });
  assert.throws(
    () => decodeForwardedArgv(Buffer.from(JSON.stringify({ nope: true })).toString("base64")),
    { code: "CLI_FORWARDED_ARGS_INVALID" },
  );
});
