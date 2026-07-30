import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const task = readFileSync(new URL("../scripts/fast-operator-serve-task.ps1", import.meta.url), "utf8");
const worker = readFileSync(new URL("../scripts/fast-operator-serve-worker.ps1", import.meta.url), "utf8");

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
  assert.match(worker, /\$nodeExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(worker, /timestamp\s*=\s*\(Get-Date\)/);
  assert.match(worker, /alias\s*=\s*\$alias/);
  assert.match(worker, /exitCode\s*=\s*\$nodeExitCode/);
  assert.match(worker, /expectedCommit\s*=\s*\$expectedCommit/);
  assert.match(worker, /Add-Content\s+-LiteralPath\s+\$stderr/);
  assert.match(worker, /exit\s+\$nodeExitCode/);

  const record = worker.match(/\$lifecycleRecord\s*=\s*\[ordered\]@[\s\S]*?\n}/)?.[0] ?? "";
  assert.doesNotMatch(record, /arguments|runtimeId|serial|token|authorization|deviceConfig|repoRoot|nodeExe/i);
});
