#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireExplorerSession,
  keepExplorerSessionAlive,
  readExplorerSessionContext,
  releaseExplorerSession,
  verifyExplorerSession,
} from "./_explore-lease.mjs";

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const sessionFile = opt("--session-file");

function usage() {
  console.log(`用法:
  node ops/xw-explore-session.mjs acquire --alias <01-04> --actor <id> [--session-file <absolute.json>] [--no-keepalive]
  node ops/xw-explore-session.mjs status --session-file <absolute.json>
  node ops/xw-explore-session.mjs heartbeat --session-file <absolute.json>
  node ops/xw-explore-session.mjs release --session-file <absolute.json>

acquire 会创建正式 canary session lease；token 只写入 mode=0600 context，不打印。
所有 Explorer 设备脚本必须传同一个 --session-file。`);
}

function publicResult(action, result) {
  const value = result?.context || result || {};
  return {
    ok: true,
    action,
    sessionFile: result?.path || sessionFile || null,
    sessionId: value.sessionId || value.session?.sessionId || result?.sessionId || null,
    leaseId: value.leaseId || value.lease?.leaseId || result?.leaseId || null,
    alias: value.alias || result?.alias || null,
    actorId: value.actorId || value.session?.actorId || result?.actorId || null,
    expiresAt: value.expiresAt || result?.session?.expiresAt || null,
    ...(result?.alreadyExpired ? { alreadyExpired: true } : {}),
  };
}

try {
  if (!command || flag("--help") || flag("-h")) {
    usage();
    process.exit(command ? 0 : 4);
  }
  if (command === "acquire") {
    const result = await acquireExplorerSession({
      alias: opt("--alias"),
      actor: opt("--actor"),
      contextPath: sessionFile,
    });
    if (!flag("--no-keepalive")) {
      const script = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [script, "keepalive", "--session-file", result.path], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
    console.log(JSON.stringify(publicResult("acquire", result)));
  } else if (["status", "heartbeat"].includes(command)) {
    if (!sessionFile) throw Object.assign(new Error("--session-file is required"), { code: "EXPLORER_SESSION_CONTEXT_REQUIRED" });
    const result = await verifyExplorerSession({ contextPath: resolve(sessionFile), alias: opt("--alias") });
    console.log(JSON.stringify(publicResult(command, result)));
  } else if (command === "release") {
    if (!sessionFile) throw Object.assign(new Error("--session-file is required"), { code: "EXPLORER_SESSION_CONTEXT_REQUIRED" });
    const result = await releaseExplorerSession({ contextPath: resolve(sessionFile) });
    console.log(JSON.stringify(publicResult("release", result)));
  } else if (command === "keepalive") {
    if (!sessionFile) throw Object.assign(new Error("--session-file is required"), { code: "EXPLORER_SESSION_CONTEXT_REQUIRED" });
    // Validate before entering the loop so a malformed context fails immediately.
    readExplorerSessionContext(resolve(sessionFile));
    await keepExplorerSessionAlive({ contextPath: resolve(sessionFile) });
  } else {
    usage();
    process.exit(4);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || "EXPLORER_SESSION_ERROR", error: error.message }));
  process.exit([400, 404].includes(error.status) ? 4 : 2);
}
