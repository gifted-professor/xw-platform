import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM,
  WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
  XHS_V3_BLIND_REVIEWER_ACCOUNT,
  buildXhsV3BlindReviewAclPlan,
  createXhsV3BlindReviewAclController,
} from "../control-plane/lib/windows-xhs-blind-review-acl.mjs";
import {
  verifyFixedBlindReviewSourceIsolation,
} from "../ops/xhs-v3-blind-review-submit.mjs";

function currentWindowsSid() {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

const WINDOWS_SYSTEM_RUNTIME = currentWindowsSid() === "S-1-5-18";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "xhs-blind-review-acl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reviewRoot = join(root, "review");
  const workspaceRoot = join(reviewRoot, "release", "corpus");
  const inboxRoot = join(workspaceRoot, "inbox");
  const privateRoot = join(root, "runtime", "private", "xhs-v3");
  const releaseRoot = join(root, "runtime", "releases", "final");
  const providerRoot = join(root, "provider-output");
  const sourceRoot = join(root, "source");
  for (const path of [inboxRoot, privateRoot, providerRoot, releaseRoot, sourceRoot]) mkdirSync(path, { recursive: true });
  return {
    root,
    plan: buildXhsV3BlindReviewAclPlan({
      reviewRoot, workspaceRoot, inboxRoot, privateRoot, providerRoot, releaseRoot, sourceRoot,
    }),
  };
}

test("ACL plan fixes one isolated workspace and the offline reviewer account", (t) => {
  const f = fixture(t);
  assert.equal(f.plan.reviewerAccount, "CodexSandboxOffline");
  assert.equal(XHS_V3_BLIND_REVIEWER_ACCOUNT, "CodexSandboxOffline");
  assert.throws(
    () => buildXhsV3BlindReviewAclPlan({
      ...f.plan,
      workspaceRoot: f.plan.privateRoot,
      inboxRoot: join(f.plan.privateRoot, "inbox"),
    }),
    { code: "XHS_V3_BLIND_REVIEW_ACL_PATH_ESCAPE" },
  );
  assert.throws(
    () => createXhsV3BlindReviewAclController({ platform: "win32" }).verify({
      ...f.plan,
      reviewerAccount: "Administrators",
    }),
    { code: "XHS_V3_BLIND_REVIEW_ACL_PLAN_INVALID" },
  );
});

test("native program resolves one enabled local user and rejects Administrator ancestry", () => {
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /CodexSandboxOffline|XW_XHS_REVIEW_ACCOUNT/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /Get-LocalUser/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /Get-LocalGroupMember/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /REVIEWER_DISABLED/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /REVIEWER_IS_ADMIN/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /Assert-IsolatedTcb/u);
  assert.doesNotMatch(WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM, /Get-Credential|ConvertTo-SecureString|password/iu);
});

test("protect/verify use fixed PowerShell argv and pass paths only through a secret-free closed env", (t) => {
  const f = fixture(t);
  const calls = [];
  const execFileSyncFn = (executable, argv, options) => {
    calls.push({ executable, argv, options });
    return JSON.stringify({
      reviewerSid: "S-1-5-21-1-2-3-1001",
      workspaceAclHash: "a".repeat(64),
      isolationAclHash: "b".repeat(64),
      networkPolicyHash: "c".repeat(64),
    });
  };
  const controller = createXhsV3BlindReviewAclController({
    platform: "win32",
    execFileSyncFn,
    systemRoot: "C:\\Windows",
  });
  const protectedReceipt = controller.protect(f.plan);
  const verifiedReceipt = controller.verify(f.plan);
  assert.equal(protectedReceipt.operation, "protect-and-verify");
  assert.equal(verifiedReceipt.operation, "verify");
  assert.equal(verifiedReceipt.providerOutputAccess, "DENIED_BY_ACL");
  assert.equal(verifiedReceipt.implementationAnswerAccess, "DENIED_BY_ACL");
  assert.equal(verifiedReceipt.networkAccess, "DENIED_BY_FIXED_OFFLINE_ACCOUNT");
  assert.equal(verifiedReceipt.networkPolicyHash, "c".repeat(64));
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(call.argv.slice(0, 5), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    ]);
    assert.equal(call.argv.length, 7);
    assert.equal(call.options.env.XW_XHS_REVIEW_ACL_ACTION, index === 0 ? "Protect" : "Verify");
    assert.equal(call.options.env.XW_XHS_REVIEW_ACCOUNT, "CodexSandboxOffline");
    assert.equal(call.options.env.XW_XHS_REVIEW_WORKSPACE, f.plan.workspaceRoot);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(Object.keys(call.options.env).sort(), [
      "COMPUTERNAME", "SystemRoot", "WINDIR", "XW_XHS_REVIEW_ACCOUNT", "XW_XHS_REVIEW_ACL_ACTION",
      "XW_XHS_REVIEW_INBOX", "XW_XHS_REVIEW_PRIVATE",
      "XW_XHS_REVIEW_PROVIDER", "XW_XHS_REVIEW_RELEASE", "XW_XHS_REVIEW_ROOT", "XW_XHS_REVIEW_SOURCE",
      "XW_XHS_REVIEW_WORKSPACE",
    ]);
    const encoded = /FromBase64String\('([^']+)'\)/u.exec(call.options.input)?.[1];
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), WINDOWS_XHS_V3_BLIND_REVIEW_ACL_PROGRAM);
    assert.equal(JSON.stringify(call.options.env).includes("token"), false);
  }
});

test("native rejection exposes only a stable ACL code", (t) => {
  const f = fixture(t);
  const controller = createXhsV3BlindReviewAclController({
    platform: "win32",
    systemRoot: "C:\\Windows",
    execFileSyncFn() {
      const error = new Error("private native detail");
      error.stderr = "XHS_REVIEW_ACL_REVIEWER_IS_ADMIN";
      throw error;
    },
  });
  assert.throws(
    () => controller.verify(f.plan),
    (error) => error.code === "XHS_V3_BLIND_REVIEW_ACL_REVIEWER_IS_ADMIN"
      && !error.message.includes("private native detail"),
  );
});

test("real Windows verifier reads the fixed SID-scoped firewall policy before workspace ACLs", {
  skip: process.platform !== "win32",
}, (t) => {
  const f = fixture(t);
  assert.throws(
    () => createXhsV3BlindReviewAclController().verify(f.plan),
    (error) => [
      "XHS_V3_BLIND_REVIEW_ACL_ISOLATION_INVALID",
      "XHS_V3_BLIND_REVIEW_ACL_SOURCE_LEASE_MISSING",
      "XHS_V3_BLIND_REVIEW_ACL_WORKSPACE_INVALID",
    ].includes(error.code),
  );
});

test("a native firewall-rule drift fails closed without minting a receipt", (t) => {
  const f = fixture(t);
  const controller = createXhsV3BlindReviewAclController({
    platform: "win32",
    systemRoot: "C:\\Windows",
    execFileSyncFn() {
      const error = new Error("disabled or rebound rule detail");
      error.stderr = "XHS_REVIEW_ACL_NETWORK_POLICY_INVALID";
      throw error;
    },
  });
  assert.throws(
    () => controller.verify(f.plan),
    (error) => error.code === "XHS_V3_BLIND_REVIEW_ACL_NETWORK_POLICY_INVALID"
      && !error.message.includes("disabled or rebound rule detail"),
  );
});

test("fixed client accepts only actual access-denied source/private/provider probes", () => {
  const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  const digest = verifyFixedBlindReviewSourceIsolation({
    readFileSyncFn: denied,
    readdirSyncFn: denied,
  });
  assert.equal(Buffer.from(digest).length, 32);

  assert.throws(() => verifyFixedBlindReviewSourceIsolation({
    readFileSyncFn: () => Buffer.from("disclosed"),
    readdirSyncFn: denied,
  }), { code: "XHS_V3_BLIND_REVIEW_CLIENT_SOURCE_DISCLOSED" });
  assert.throws(() => verifyFixedBlindReviewSourceIsolation({
    readFileSyncFn: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    readdirSyncFn: denied,
  }), { code: "XHS_V3_BLIND_REVIEW_CLIENT_SOURCE_PROBE_INVALID" });
  assert.throws(() => verifyFixedBlindReviewSourceIsolation({
    readFileSyncFn: denied,
    readdirSyncFn: () => [],
  }), { code: "XHS_V3_BLIND_REVIEW_CLIENT_PRIVATE_MATERIAL_DISCLOSED" });
  assert.throws(() => verifyFixedBlindReviewSourceIsolation({
    readFileSyncFn: denied,
    readdirSyncFn: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), { code: "XHS_V3_BLIND_REVIEW_CLIENT_ISOLATION_PROBE_INVALID" });
});

test("real Windows protect grants only fixed-draft WriteData and seals source/provider/private/release", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = mkdtempSync(join("C:\\Program Files", "xhs-blind-acl-live-"));
  t.after(() => {
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync("icacls.exe", [root, "/setowner", account, "/T", "/C"], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("icacls.exe", [root, "/grant:r", `${account}:(F)`, "/T", "/C"], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    rmSync(root, { recursive: true, force: true });
  });
  const reviewRoot = join(root, "review");
  const workspaceRoot = join(reviewRoot, "workspace");
  const inboxRoot = join(workspaceRoot, "inbox");
  const privateRoot = join(root, "private");
  const providerRoot = join(root, "provider");
  const releaseRoot = join(root, "release");
  const sourceRoot = join(root, "source");
  const templatesRoot = join(workspaceRoot, "templates");
  for (const path of [inboxRoot, templatesRoot, privateRoot, providerRoot, releaseRoot, sourceRoot]) {
    mkdirSync(path, { recursive: true });
  }
  const binding = {
    sessionId: "1".repeat(64), challenge: "2".repeat(64), reviewRequestHash: "3".repeat(64),
    accessAttestationHash: "4".repeat(64),
  };
  const responseBytes = Buffer.from(JSON.stringify({
    schemaId: "xw.xhs.v3-fixed-blind-review-human-response.v1", schemaVersion: 1,
    corpusSetId: "corpus-live", ...binding, annotations: [{}],
  }), "utf8");
  binding.responseHash = createHash("sha256").update(responseBytes).digest("hex");
  writeFileSync(join(workspaceRoot, "human-response.draft.v1.json"), responseBytes);
  writeFileSync(join(workspaceRoot, "request-marker.json"), "{}\n");
  writeFileSync(join(sourceRoot, "implementation-marker.mjs"), "export default true;\n");
  const probeCanonical = [
    "file:C:\\Users\\Public\\xw-fusion\\xw-platform\\package.json:DENIED",
    "directory:C:\\Users\\Public\\xw-fusion\\xw-platform:DENIED",
    "directory:C:\\Users\\Public\\xw-runtime\\private\\xhs-v3:DENIED",
    "directory:C:\\Users\\Public\\xw-runtime\\releases:DENIED",
    "directory:C:\\Program Files\\XW Platform\\providers:DENIED",
  ].join("\n");
  const probeHash = createHash("sha256").update(probeCanonical).digest("hex");
  writeFileSync(join(templatesRoot, "xhs-v3-blind-review-submit.mjs"), [
    "import { readFileSync } from 'node:fs';",
    "import { connect } from 'node:net';",
    `const sessionId='${binding.sessionId}';`,
    `const probe=Buffer.from('${probeHash}','hex');`,
    "const body=readFileSync('human-response.draft.v1.json');",
    "const header=Buffer.alloc(4);header.writeUInt32BE(body.length);",
    "const socket=connect('\\\\\\\\.\\\\pipe\\\\xw-xhs-v3-review-'+sessionId);",
    "socket.once('connect',()=>socket.write(Buffer.concat([probe,header,body])));",
    "socket.on('data',(bytes)=>{if(Buffer.from(bytes).includes(1)){socket.end();}});",
    "socket.once('error',()=>{process.exitCode=23;});",
  ].join("\n"));
  execFileSync("icacls.exe", [root, "/inheritance:r", "/grant:r",
    "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/C"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("icacls.exe", [root, "/setowner", "*S-1-5-32-544", "/T", "/C"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const plan = buildXhsV3BlindReviewAclPlan({
    reviewRoot, workspaceRoot, inboxRoot, privateRoot, providerRoot, releaseRoot, sourceRoot,
  });
  const controller = createXhsV3BlindReviewAclController();
  let leased = false;
  try {
    assert.equal(controller.protect(plan).operation, "protect-and-verify");
    leased = true;
    assert.equal(controller.verify(plan).operation, "verify");
    if (WINDOWS_SYSTEM_RUNTIME) {
      const admission = controller.admitResponse(plan, binding);
      assert.equal(admission.responseHash, binding.responseHash);
      assert.equal(admission.isolationProbeHash, probeHash);
      const receiptPath = join(inboxRoot, `${binding.sessionId}.admission-receipt.v1.json`);
      unlinkSync(receiptPath);
      assert.equal(controller.admitResponse(plan, binding).responseHash, binding.responseHash,
        "an exact response orphan must be adopted after a response-before-receipt crash");
      assert.equal(controller.admitResponse(plan, binding).responseHash, binding.responseHash,
        "an exact admission receipt must replay without another task");
      const taskExists = execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$null -ne (Get-ScheduledTask -TaskName 'XW-XHS-V3-BlindReview-${binding.sessionId}' -ErrorAction SilentlyContinue)`,
      ], { encoding: "utf8", windowsHide: true }).trim();
      assert.equal(taskExists, "False");
    } else {
      t.diagnostic("SKIP_PENDING_P5_SYSTEM: S4U broker/client integration requires the fixed SYSTEM operator");
    }
    const closure = controller.close(plan);
    leased = false;
    assert.equal(closure.operation, "close-review-workspace");
    assert.match(closure.restoredSourceAclHash, /^[0-9a-f]{64}$/u);
    assert.match(closure.closedWorkspaceAclHash, /^[0-9a-f]{64}$/u);
  } finally {
    if (leased) assert.equal(controller.restore(plan).operation, "restore-source-acl");
  }
});

test("SYSTEM-only broker transport/adoption fixture uses a synthetic probe sender", {
  skip: process.platform !== "win32" || !WINDOWS_SYSTEM_RUNTIME
    ? "SKIP_PENDING_P5_SYSTEM"
    : false,
}, () => {
  // The live fixture above exercises caller-SID/pipe/adoption mechanics but
  // deliberately injects a precomputed probe digest. Actual denied reads are
  // evidence only from production verify-blind-review-runtime-fixed, whose
  // S4U task launches the tracked fixed client.
  assert.equal(WINDOWS_SYSTEM_RUNTIME, true);
});

test("broker is a fixed S4U one-shot client launcher with SID impersonation and mandatory cleanup", {
  skip: process.platform !== "win32",
}, () => {
  execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[void][scriptblock]::Create([Console]::In.ReadToEnd())",
  ], {
    input: WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /New-ScheduledTaskPrincipal[^\r\n]+-LogonType S4U -RunLevel Limited/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /-ProcessTokenSidType Default/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /Same-CimDefinition/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /RunAsClient/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /FileMode\]::CreateNew/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /Unregister-ScheduledTask/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /TASK_CLEANUP_FAILED/u);
  assert.doesNotMatch(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /Register-ScheduledTask[^\r\n]*-Force\b/u);
  assert.doesNotMatch(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /NATIVE_FAILURE\|/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
    /Test-Path -LiteralPath \$receiptPath[\s\S]+Set-ResponseAcl \$receiptPath[\s\S]+Assert-ResponseAcl \$receiptPath/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
    /Set-ResponseAcl \$finalPath[\s\S]+Remove-ExactTask[\s\S]+\[Console\]::Out\.Write/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
    /Stop-ScheduledTask[^\r\n]+-ErrorAction Stop[\s\S]+Unregister-ScheduledTask[^\r\n]+-ErrorAction Stop/u);
  const terminalResultCheck = WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM.indexOf(
    "$taskInfo.LastTaskResult -ne 0",
  );
  const terminalReceiptCommit = WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM.lastIndexOf(
    "New-Object IO.FileStream($receiptPath",
  );
  assert.ok(terminalResultCheck >= 0 && terminalReceiptCommit > terminalResultCheck,
    "terminal receipt must commit only after the fresh S4U result-0 check");
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /\$taskInfo\.LastRunTime -gt \$initialLastRunTime/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM, /taskExecutionHash/u);
  assert.match(WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM,
    /\$adoptOrphan[\s\S]+Hash-Bytes \$existing[\s\S]+Set-ResponseAcl \$finalPath[\s\S]+Assert-ResponseAcl \$finalPath/u);
});

test("broker invocation has fixed argv, stdin source, minimal bindings, and stable fail-closed markers", (t) => {
  const f = fixture(t);
  const binding = {
    sessionId: "1".repeat(64),
    challenge: "2".repeat(64),
    reviewRequestHash: "3".repeat(64),
    accessAttestationHash: "4".repeat(64),
    responseHash: "5".repeat(64),
  };
  const calls = [];
  const controller = createXhsV3BlindReviewAclController({
    platform: "win32",
    systemRoot: "C:\\Windows",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    execFileSyncFn(executable, argv, options) {
      calls.push({ executable, argv, options });
      return JSON.stringify({
        schemaId: "xw.xhs.v3-blind-review-admission.v1",
        schemaVersion: 1,
        ...binding,
        callerPrincipalHash: "6".repeat(64),
        isolationProbeHash: "7".repeat(64),
        taskExecutionHash: "8".repeat(64),
      });
    },
  });
  assert.equal(controller.admitResponse(f.plan, binding).callerPrincipalHash, "6".repeat(64));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(-2), ["-Command", "-"]);
  const encoded = /FromBase64String\('([^']+)'\)/u.exec(calls[0].options.input)?.[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), WINDOWS_XHS_V3_BLIND_REVIEW_RESPONSE_BROKER_PROGRAM);
  assert.equal(calls[0].options.env.XW_XHS_REVIEW_CLIENT,
    `${f.plan.workspaceRoot}\\templates\\xhs-v3-blind-review-submit.mjs`);
  assert.equal(calls[0].options.env.XW_XHS_REVIEW_NODE, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(JSON.stringify(calls[0].options.env).includes("token"), false);

  for (const marker of ["TIMEOUT", "CALLER_INVALID", "REPLAY_INVALID", "ORPHAN_RESPONSE_INVALID", "TASK_CLEANUP_FAILED"]) {
    const rejecting = createXhsV3BlindReviewAclController({
      platform: "win32",
      systemRoot: "C:\\Windows",
      execFileSyncFn() {
        const error = new Error("native detail");
        error.stderr = `XHS_REVIEW_BROKER_${marker}`;
        throw error;
      },
    });
    assert.throws(() => rejecting.admitResponse(f.plan, binding), {
      code: `XHS_V3_BLIND_REVIEW_BROKER_${marker}`,
    });
  }
});
