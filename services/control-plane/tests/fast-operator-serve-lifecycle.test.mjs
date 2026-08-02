import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const task = readFileSync(new URL("../scripts/fast-operator-serve-task.ps1", import.meta.url), "utf8");
const worker = readFileSync(new URL("../scripts/fast-operator-serve-worker.ps1", import.meta.url), "utf8");
const operator = readFileSync(new URL("../scripts/fast-operator.mjs", import.meta.url), "utf8");
const operatorPath = fileURLToPath(new URL("../scripts/fast-operator.mjs", import.meta.url));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("timed out waiting for child process output");
}

test("serve lifecycle owns all four aliases and resolves private runtime data from local config", () => {
  assert.match(task, /ValidateSet\("Install", "Start", "Stop", "Restart", "Status"\)/);
  assert.match(task, /ValidateSet\("01", "02", "03", "04"\)/);
  assert.match(task, /config\\control-plane\.devices\.json/);
  assert.match(task, /\.runtimeId/);
  assert.match(task, /\.metadata\.xhsServePort/);
  assert.match(task, /XhsFastOperator\$\{Alias\}Live/);
});

test("install pins each worker launch and atomically generates the compatibility restart wrapper", () => {
  for (const key of ["repoRoot", "nodeExe", "gitCommit", "deviceConfig", "alias"]) {
    assert.match(task, new RegExp(`\\b${key}\\s*=`));
  }
  assert.match(task, /fast-operator-serve-worker\.ps1/);
  assert.match(task, /C:\\Users\\Public\\xhs-registry/);
  assert.match(task, /serve-restart-\$Alias\.ps1/);
  assert.match(task, /-Action Restart -Alias/);
  assert.match(task, /WriteAllText\(\$wrapperTemp/);
  assert.match(task, /Move-Item[^\n]+\$wrapperTemp[^\n]+\$wrapperPath[^\n]+-Force/);
  assert.match(task, /-DontStopOnIdleEnd/);
});

test("worker fails closed on revision drift and launches FastOperator from that same repository", () => {
  assert.match(worker, /git -C \$repoRoot rev-parse HEAD/);
  assert.match(worker, /\$actualCommit -ne \$expectedCommit/);
  assert.match(worker, /Repository commit mismatch/);
  assert.match(worker, /Join-Path \$repoRoot "scripts\\fast-operator\.mjs"/);
  assert.match(worker, /\.runtimeId/);
  assert.match(worker, /\.metadata\.xhsServePort/);
  assert.match(worker, /"--serial", \$runtimeId/);
  assert.match(worker, /"serve", "--port", \[string\]\$servePort/);
});

test("restart takes over only the exact FastOperator listener and refuses an unrelated process", () => {
  assert.match(task, /Get-CimInstance Win32_Process/);
  assert.match(task, /fast-operator\\\.mjs/);
  assert.match(task, /--port/);
  assert.match(task, /Refusing to stop unrelated listener/);
  assert.match(task, /Stop-Process -Id \$listener\.OwningProcess/);
  assert.match(task, /Port already occupied; use Restart/);
});

test("lifecycle metadata stays secret-free and Start or Status never probes a device action", () => {
  const lifecycle = `${task}\n${worker}`;
  assert.doesNotMatch(lifecycle, /control_Test|22222|cliproxy|--llm-key|--token/i);
  assert.doesNotMatch(task, /--serial|Invoke-WebRequest|Invoke-RestMethod|\/focus|x-control-token/i);
  assert.doesNotMatch(lifecycle, /XHS_ALLOW_BYPASS\s*=\s*["']1["']/i);
  assert.match(worker, /XHS_ALLOW_BYPASS[^\n]+"0"/);
});

test("worker pins the authoritative Xiaowei ADB server without exposing runtime data", () => {
  assert.match(worker, /ANDROID_ADB_SERVER_PORT\s*=\s*"5038"/);
  assert.match(worker, /Remove-Item Env:ADB_SERVER_SOCKET/);
  const environmentBlock = worker.match(/\$env:XHS_ALLOW_BYPASS[\s\S]*?\$arguments\s*=/)?.[0] ?? "";
  assert.doesNotMatch(environmentBlock, /Write-(?:Output|Host)|echo|runtimeId|serial/);
});

test("worker records a secret-free lifecycle event after the Node process exits", () => {
  assert.match(worker, /phase\s*=\s*"worker-start"/);
  assert.match(worker, /Add-Content\s+-LiteralPath\s+\$stderr[\s\S]*?\$arguments\s*=/);
  assert.match(worker, /try\s*\{[\s\S]*?& \$nodeExe @arguments[\s\S]*?finally\s*\{/);
  assert.match(worker, /\$nodeExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(worker, /phase\s*=\s*"worker-exit"/);
  assert.match(worker, /timestamp\s*=\s*\(Get-Date\)/);
  assert.match(worker, /alias\s*=\s*\$alias/);
  assert.match(worker, /workerPid\s*=\s*\$PID/);
  assert.match(worker, /exitCode\s*=\s*\$nodeExitCode/);
  assert.match(worker, /expectedCommit\s*=\s*\$expectedCommit/);
  assert.match(worker, /Add-Content\s+-LiteralPath\s+\$stderr/);
  assert.match(worker, /exit\s+\$nodeExitCode/);

  const record = worker.match(/\$lifecycleRecord\s*=\s*\[ordered\]@[\s\S]*?\n}/)?.[0] ?? "";
  assert.doesNotMatch(record, /arguments|runtimeId|serial|token|authorization|deviceConfig|repoRoot|nodeExe/i);
});

test("official task start stop and restart requests leave an external secret-free audit trail", () => {
  assert.match(task, /lifecycle-events\.jsonl/);
  assert.match(task, /function Write-LifecycleEvent/);
  for (const phase of ["task-start-request", "task-started", "task-stop-request", "task-stopped", "task-restart-request"]) {
    assert.match(task, new RegExp(`phase[^\\n]+${phase}|Write-LifecycleEvent[^\\n]+${phase}`));
  }
  const lifecycleFunction = task.match(/function Write-LifecycleEvent[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(lifecycleFunction, /callerPid\s*=\s*\$PID/);
  assert.doesNotMatch(lifecycleFunction, /runtimeId|serial|token|authorization|deviceConfig|repoRoot|nodeExe/i);
});

test("serve CLI records process lifecycle without changing imported test servers", () => {
  assert.match(operator, /function Install-?ServeProcessLifecycle|function installServeProcessLifecycle/i);
  assert.match(operator, /uncaughtExceptionMonitor/);
  assert.match(operator, /phase:\s*"node-start"/);
  assert.match(operator, /phase:\s*"node-exit"/);
  assert.match(operator, /writeSync\(1,/);
  assert.doesNotMatch(operator, /writeSync\(2,/);
  assert.match(operator, /if \(cmd === "serve"\)[\s\S]*?installServeProcessLifecycle\(\)/);
  assert.doesNotMatch(operator, /phase:\s*"serving"[^\n]+serial/);
});

test("serve CLI keeps lifecycle and request diagnostics off stderr and remains listening", { timeout: 10_000 }, async (t) => {
  const port = await reservePort();
  const child = spawn(process.execPath, [
    operatorPath,
    "--adb", "synthetic-adb",
    "--serial", "synthetic-runtime",
    "serve", "--port", String(port),
  ], {
    env: { ...process.env, XHS_ALLOW_BYPASS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  await waitFor(() => stdout.includes('"phase":"serving"'));
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "metrics" }),
  });
  assert.equal(response.status, 423);
  await waitFor(() => stdout.includes('"event":"fast-operator.request-error"'));

  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /synthetic-runtime/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});
