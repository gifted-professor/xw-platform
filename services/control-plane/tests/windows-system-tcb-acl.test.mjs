import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSystemTcbAclSnapshot,
  buildSystemTcbAclPlan,
  createSystemTcbAclController,
  SYSTEM_TCB_ACL_PLAN_SCHEMA_ID,
  WINDOWS_SYSTEM_TCB_ACL_PROGRAM,
} from "../control-plane/lib/windows-system-tcb-acl.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xw-system-tcb-acl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boundary = join(root, "runtime");
  const tree = join(boundary, "release");
  mkdirSync(join(tree, "lib"), { recursive: true });
  writeFileSync(join(tree, "entry.ps1"), "param()\n");
  writeFileSync(join(tree, "lib", "server.mjs"), "export default true;\n");
  return { root, boundary, tree };
}

function exactSnapshot(overrides = {}) {
  return {
    ownerSid: "S-1-5-32-544",
    protected: true,
    rules: [
      { sid: "S-1-5-18", type: "allow", rights: 2_032_127, inherited: false },
      { sid: "S-1-5-32-544", type: "allow", rights: 2_032_127, inherited: false },
    ],
    ...overrides,
  };
}

test("TCB plans seal the fixed SYSTEM/Administrators authority set and reject path escape", (t) => {
  const f = fixture(t);
  const plan = buildSystemTcbAclPlan({ boundaryPath: f.boundary, targetPath: f.tree, recursive: true });
  assert.equal(plan.schemaId, SYSTEM_TCB_ACL_PLAN_SCHEMA_ID);
  assert.deepEqual(plan.ownerSids, ["S-1-5-18", "S-1-5-32-544"]);
  assert.deepEqual(plan.writableSids, ["S-1-5-18", "S-1-5-32-544"]);
  assert.equal(plan.protectedDacl, true);
  assert.equal(plan.rejectReparse, true);
  assert.equal(plan.rejectLinkedFiles, true);
  assert.throws(() => buildSystemTcbAclPlan({
    boundaryPath: f.boundary,
    targetPath: join(f.root, "outside"),
  }), /SYSTEM_TCB_ACL_PATH_ESCAPE/u);
});

test("pure ACL oracle rejects weak target and ancestor write/delete authorities", () => {
  assert.equal(assertSystemTcbAclSnapshot(exactSnapshot()), true);
  for (const snapshot of [
    exactSnapshot({ protected: false }),
    exactSnapshot({ ownerSid: "S-1-5-21-untrusted" }),
    exactSnapshot({ rules: [
      ...exactSnapshot().rules,
      { sid: "S-1-5-4", type: "allow", rights: 197_055, inherited: false },
    ] }),
  ]) assert.throws(() => assertSystemTcbAclSnapshot(snapshot), /SYSTEM_TCB_ACL_TARGET_DACL_INVALID/u);

  assert.equal(assertSystemTcbAclSnapshot({
    ownerSid: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    protected: false,
    rules: [{ sid: "S-1-5-11", type: "allow", rights: 4, inherited: false }],
  }, { ancestor: true }), true, "create-directory alone cannot replace an existing protected child");
  for (const sid of ["S-1-5-4", "S-1-5-6", "S-1-5-3"]) {
    assert.throws(() => assertSystemTcbAclSnapshot({
      ownerSid: "S-1-5-18",
      protected: true,
      rules: [{ sid, type: "allow", rights: 64, inherited: false }],
    }, { ancestor: true }), /SYSTEM_TCB_ACL_ANCESTOR_WRITABLE/u);
  }
});

test("Windows controller uses only the native protected-DACL probe and a minimal environment", (t) => {
  const f = fixture(t);
  const calls = [];
  const controller = createSystemTcbAclController({
    platform: "win32",
    systemRoot: "C:\\Windows",
    execFileSyncFn: (...args) => {
      calls.push(args);
      return "TCB_ACL_OK";
    },
  });
  const plan = buildSystemTcbAclPlan({ boundaryPath: f.boundary, targetPath: f.tree, recursive: true });
  const receipt = controller.protect(plan);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.operation, "protect-and-verify");
  assert.equal(receipt.entryCount, 4);
  assert.equal(calls.length, 2, "protect is always followed by an independent verify");
  assert.match(calls[0][0], /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
  assert.deepEqual(Object.keys(calls[0][2].env).sort(), [
    "SystemRoot", "WINDIR", "XW_TCB_ACL_ACTION", "XW_TCB_ACL_BOUNDARY",
    "XW_TCB_ACL_RECURSIVE", "XW_TCB_ACL_TARGET",
  ]);
  assert.equal(calls[0][2].env.XW_TCB_ACL_ACTION, "Protect");
  assert.equal(calls[1][2].env.XW_TCB_ACL_ACTION, "Verify");
  assert.equal(calls[0][2].env.DEEPSEEK_API_KEY, undefined);
});

test("reparse directories and hard-linked executable bytes fail before the native probe", async (t) => {
  await t.test("junction", (st) => {
    const f = fixture(st);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.tree, "junction"), process.platform === "win32" ? "junction" : "dir");
    const controller = createSystemTcbAclController({
      platform: "win32",
      execFileSyncFn: () => { throw new Error("native probe must not run"); },
    });
    assert.throws(() => controller.verify(buildSystemTcbAclPlan({
      boundaryPath: f.boundary,
      targetPath: f.tree,
      recursive: true,
    })), /SYSTEM_TCB_ACL_(?:STRUCTURE_INVALID|REPARSE_FORBIDDEN)/u);
  });
  await t.test("hardlink", (st) => {
    const f = fixture(st);
    linkSync(join(f.tree, "entry.ps1"), join(f.tree, "replacement.ps1"));
    const controller = createSystemTcbAclController({
      platform: "win32",
      execFileSyncFn: () => { throw new Error("native probe must not run"); },
    });
    assert.throws(() => controller.verify(buildSystemTcbAclPlan({
      boundaryPath: f.boundary,
      targetPath: f.tree,
      recursive: true,
    })), /SYSTEM_TCB_ACL_STRUCTURE_INVALID/u);
  });
});

test("POSIX verification preserves existing modes and never invokes Windows ACL tooling", (t) => {
  const f = fixture(t);
  const entry = join(f.tree, "entry.ps1");
  chmodSync(entry, 0o640);
  const before = statSync(entry).mode & 0o777;
  const controller = createSystemTcbAclController({
    platform: "linux",
    execFileSyncFn: () => { throw new Error("Windows probe must not run on POSIX"); },
  });
  const receipt = controller.protect(buildSystemTcbAclPlan({
    boundaryPath: f.boundary,
    targetPath: f.tree,
    recursive: true,
  }));
  assert.equal(receipt.protectedDacl, "not-applicable");
  assert.equal(statSync(entry).mode & 0o777, before);
});

test("native program encodes protected owner/DACL, ancestor delete defense and PS5-compatible traversal", () => {
  for (const token of [
    "S-1-5-18", "S-1-5-32-544", "SetAccessRuleProtection($true, $false)",
    "ANCESTOR_WRITABLE", "FileAttributes]::ReparsePoint", "Get-ChildItem",
    "Assert-ElevatedWriter", "rules.Count -ne 2",
  ]) assert.equal(WINDOWS_SYSTEM_TCB_ACL_PROGRAM.includes(token), true, `missing native ACL token: ${token}`);
  assert.doesNotMatch(WINDOWS_SYSTEM_TCB_ACL_PROGRAM, /DEEPSEEK|M6_GATE|LIVE_ENTRY|keyBase64/iu);
});
