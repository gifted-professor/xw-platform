import { fileURLToPath } from "node:url";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";

import { StdioSupervisor, spawnOwnedProcess, terminateOwnedProcessTree } from "./stdio-supervisor.mjs";

export async function main(env = process.env) {
  const command = env.XW_DSH_CHILD_COMMAND;
  if (!command) throw new Error("XW_DSH_CHILD_COMMAND is required");
  const args = JSON.parse(env.XW_DSH_CHILD_ARGS_JSON ?? "[]");
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new Error("XW_DSH_CHILD_ARGS_JSON must be a string array");
  const hashLedger = JSON.parse(env.XW_DSH_HASH_LEDGER_JSON ?? "{}");
  if (!hashLedger || typeof hashLedger !== "object" || Array.isArray(hashLedger)
    || Object.values(hashLedger).some((value) => !/^[0-9a-f]{64}$/u.test(value))) throw new Error("XW_DSH_HASH_LEDGER_JSON must be a SHA-256 ledger");
  const childRef = spawnOwnedProcess(command, args, {
    cwd: env.XW_DSH_CHILD_CWD || process.cwd(),
    env,
  });
  let exitCode = 0;
  let forcedCleanup;
  const supervisor = new StdioSupervisor({
    upstreamInput: process.stdin,
    upstreamOutput: process.stdout,
    childRef,
    onFatal(error) {
      exitCode = 1;
      process.stderr.write(`${error.code ?? "SUPERVISOR_FATAL"}: ${error.message}\n`);
      forcedCleanup ??= terminateOwnedProcessTree(childRef).catch((cleanupError) => {
        process.stderr.write(`M6_DSH_PROCESS_TREE_LEAK: ${cleanupError.message}\n`);
        throw cleanupError;
      });
    },
  }).start();
  process.stdin.once("end", () => childRef.child.stdin.end());
  if (childRef.child.exitCode === null && childRef.child.signalCode === null) {
    await new Promise((resolve) => childRef.child.once("exit", resolve));
  }
  const receipt = forcedCleanup ? await forcedCleanup : await terminateOwnedProcessTree(childRef);
  const completeReceipt = {
    ...receipt,
    adapterKind: env.XW_DSH_ADAPTER_KIND,
    executionMode: env.XW_DSH_EXECUTION_MODE,
    hashLedger,
    stderrSha256: supervisor.stderrDigest(),
  };
  if (env.XW_DSH_CLOSE_RECEIPT_PATH) {
    const temporary = `${env.XW_DSH_CLOSE_RECEIPT_PATH}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(completeReceipt)}\n`, { flag: "w" });
    const fd = openSync(temporary, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, env.XW_DSH_CLOSE_RECEIPT_PATH);
  }
  process.stderr.write(`XW_PROCESS_CLOSE ${JSON.stringify(completeReceipt)}\n`);
  process.exitCode = exitCode;
  process.stdin.destroy();
  process.stdout.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
