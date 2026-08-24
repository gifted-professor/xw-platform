import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import { assertM64PrivateAuditRootAcl } from "./m6-4-private-audit-root-acl.mjs";

const CURRENT_SID = "S-1-5-21-1000-1001-1002-1003";
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const FULL_CONTROL = 2_032_127;
const ROOT_PATH = String.raw`C:\Users\Public\xw-runtime\m6-audit`;

function allow(sid, { inherited = false, rights = FULL_CONTROL } = {}) {
  return { sid, type: "Allow", rights, inherited };
}

function inspection() {
  return {
    schemaId: "xw.m6-4-private-audit-root-acl-inspection.v1",
    currentSid: CURRENT_SID,
    nodes: [
      {
        relativePath: ".",
        kind: "DIRECTORY",
        ownerSid: CURRENT_SID,
        areAccessRulesProtected: true,
        rules: [allow(CURRENT_SID), allow(SYSTEM_SID), allow(ADMINISTRATORS_SID)],
      },
      {
        relativePath: String.raw`m6-4-publication-journal\journal.json`,
        kind: "FILE",
        ownerSid: SYSTEM_SID,
        areAccessRulesProtected: false,
        rules: [
          allow(CURRENT_SID, { inherited: true }),
          allow(SYSTEM_SID, { inherited: true }),
          allow(ADMINISTRATORS_SID, { inherited: true }),
        ],
      },
    ],
  };
}

function runnerFor(value, inspect = () => {}) {
  return (executable, args, options) => {
    inspect(executable, args, options);
    return { status: 0, signal: null, stdout: JSON.stringify(value), stderr: "" };
  };
}

function clone(value) {
  return structuredClone(value);
}

test("Windows ACL inspection uses only absolute system PowerShell and a sanitized environment", () => {
  const value = inspection();
  const result = assertM64PrivateAuditRootAcl(ROOT_PATH, {
    platform: "win32",
    processRunner: runnerFor(value, (executable, args, options) => {
      assert.equal(executable, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
      assert.equal(win32.isAbsolute(executable), true);
      assert.deepEqual(args.slice(0, -1), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      ]);
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/u);
      assert.match(script, /GetAccessControl/u);
      assert.match(script, /AreAccessRulesProtected/u);
      assert.match(script, /GetAccessRules\(\$true, \$true, \[Security\.Principal\.SecurityIdentifier\]\)/u);
      assert.match(script, /FileAttributes\]::ReparsePoint/u);
      assert.doesNotMatch(script, /icacls/iu);
      assert.deepEqual(Object.keys(options.env).sort(), [
        "ComSpec", "M64_AUDIT_ROOT_PATH_B64", "SystemRoot", "WINDIR",
      ]);
      assert.equal(Buffer.from(options.env.M64_AUDIT_ROOT_PATH_B64, "base64").toString("utf8"), ROOT_PATH);
      assert.equal(options.cwd, String.raw`C:\Windows\System32`);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 60_000);
      for (const inheritedSecret of [
        "DEEPSEEK_API_KEY", "XW_M6_GATE_F_OPERATIONS_TOKEN", "XW_M6_LIVE_ENTRY_TOKEN",
        "XW_M6_LIVE_PROVIDER_BASE_URL", "XW_M6_LIVE_MODEL_PROFILE_HASH",
      ]) assert.equal(Object.hasOwn(options.env, inheritedSecret), false);
    }),
  });
  assert.deepEqual(result, {
    ok: true,
    platform: "win32",
    currentSid: CURRENT_SID,
    ownerSid: CURRENT_SID,
    entriesChecked: 2,
  });
  assert.equal(Object.isFrozen(result), true);
});

test("Windows ACL validation rejects every writable-tree ambiguity", async (t) => {
  const cases = [
    {
      name: "root DACL inherits",
      reason: /ROOT_DACL_NOT_PROTECTED/u,
      mutate(value) { value.nodes[0].areAccessRulesProtected = false; },
    },
    {
      name: "root has an inherited rule",
      reason: /ROOT_DACL_NOT_PROTECTED/u,
      mutate(value) { value.nodes[0].rules[0].inherited = true; },
    },
    {
      name: "untrusted SID can modify root",
      reason: /DANGEROUS_ALLOW_NOT_ALLOWED/u,
      mutate(value) { value.nodes[0].rules.push(allow("S-1-1-0")); },
    },
    {
      name: "untrusted SID can modify an existing artifact",
      reason: /DANGEROUS_ALLOW_NOT_ALLOWED/u,
      mutate(value) { value.nodes[1].rules.push(allow("S-1-5-11", { inherited: true })); },
    },
    {
      name: "owner is outside the trusted identities",
      reason: /OWNER_NOT_ALLOWED/u,
      mutate(value) { value.nodes[1].ownerSid = "S-1-1-0"; },
    },
    {
      name: "current identity cannot write an existing artifact",
      reason: /CURRENT_IDENTITY_NOT_WRITABLE/u,
      mutate(value) { value.nodes[1].rules = value.nodes[1].rules.filter((rule) => rule.sid !== CURRENT_SID); },
    },
    {
      name: "dangerous deny makes effective token access ambiguous",
      reason: /DANGEROUS_DENY_PRESENT/u,
      mutate(value) { value.nodes[1].rules.push({ sid: "S-1-1-0", type: "Deny", rights: 2, inherited: false }); },
    },
    {
      name: "relative path escapes",
      reason: /NODE_PATH_INVALID/u,
      mutate(value) { value.nodes[1].relativePath = String.raw`..\outside.json`; },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const value = clone(inspection());
      item.mutate(value);
      assert.throws(() => assertM64PrivateAuditRootAcl(ROOT_PATH, {
        platform: "win32", processRunner: runnerFor(value),
      }), item.reason);
    });
  }
});

test("Windows ACL validation hides process failures and malformed output behind a stable fail-closed code", () => {
  for (const processResult of [
    { status: 1, stdout: "", stderr: "sensitive error" },
    { status: null, signal: null, error: Object.assign(new Error("sensitive timeout"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" },
    { status: 0, stdout: "not-json", stderr: "" },
    { status: 0, stdout: JSON.stringify({ forged: true }), stderr: "" },
  ]) {
    assert.throws(() => assertM64PrivateAuditRootAcl(ROOT_PATH, {
      platform: "win32", processRunner: () => processResult,
    }), (error) => error.code === "M64_AUDIT_ROOT_ACL_INVALID" && !error.message.includes("sensitive"));
  }
});

test("Windows .NET inspector executes read-only against a temporary inherited directory", {
  skip: process.platform !== "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "m64-acl-inspection-"));
  let inspectedProcess = null;
  let observedError = null;
  const startedAt = Date.now();
  try {
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "artifact.json"), "{}\n");
    assert.throws(
      () => assertM64PrivateAuditRootAcl(root, {
        processRunner(...args) {
          inspectedProcess = spawnSync(...args);
          return inspectedProcess;
        },
      }),
      (error) => {
        observedError = error;
        return error.code === "M64_AUDIT_ROOT_ACL_INVALID";
      },
    );
    assert.equal(inspectedProcess?.status, 0, JSON.stringify({
      errorCode: inspectedProcess?.error?.code ?? null,
      elapsedMs: Date.now() - startedAt,
      signal: inspectedProcess?.signal ?? null,
      status: inspectedProcess?.status ?? null,
    }));
    assert.match(observedError.message, /(?:ROOT_DACL_NOT_PROTECTED|DANGEROUS_ALLOW_NOT_ALLOWED)/u);
    assert.doesNotMatch(observedError.message, /INSPECTION_PROCESS_FAILED/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX fallback recursively requires current ownership and private owner-write modes", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "m64-private-audit-"));
  try {
    const child = join(root, "journal");
    const file = join(child, "entry.json");
    mkdirSync(child);
    writeFileSync(file, "{}\n");
    chmodSync(root, 0o700);
    chmodSync(child, 0o700);
    chmodSync(file, 0o600);
    assert.equal(assertM64PrivateAuditRootAcl(root, { platform: process.platform }).entriesChecked, 3);
    chmodSync(file, 0o660);
    assert.throws(
      () => assertM64PrivateAuditRootAcl(root, { platform: process.platform }),
      /POSIX_MODE_INVALID/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime launcher hardens the fixed M6 audit tree with native ACL APIs before either server launch", () => {
  const launcherPath = new URL("../../services/control-plane/scripts/xw-control-plane-runtime.ps1", import.meta.url);
  const source = readFileSync(launcherPath, "utf8");
  assert.match(source, /function Initialize-M64PrivateAuditRoot/u);
  assert.match(source, /Join-Path \$RuntimeRoot "m6-audit"/u);
  assert.match(source, /DirectorySecurity/u);
  assert.match(source, /FileSecurity/u);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(source, /S-1-5-18/u);
  assert.match(source, /S-1-5-32-544/u);
  assert.match(source, /ContainerInherit/u);
  assert.match(source, /ObjectInherit/u);
  assert.match(source, /FullControl/u);
  assert.match(source, /GetFileSystemInfos/u);
  assert.match(source, /FileAttributes\]::ReparsePoint/u);
  assert.doesNotMatch(source, /icacls/iu);
  const hardeningCalls = [...source.matchAll(/Initialize-M64PrivateAuditRoot \$runtimeRootFull/gu)].map((match) => match.index);
  const serverCalls = [...source.matchAll(/& \$nodeExecutable \$serverPath serve/gu)].map((match) => match.index);
  assert.equal(hardeningCalls.length, 2);
  assert.equal(serverCalls.length, 2);
  assert.ok(hardeningCalls[0] < serverCalls[0]);
  assert.ok(hardeningCalls[1] < serverCalls[1]);
});
