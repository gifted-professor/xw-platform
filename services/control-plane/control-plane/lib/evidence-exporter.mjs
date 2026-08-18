// evidence-exporter.mjs — REX Phase 3 §5.2 item 3：sealed outbox exporter
//
// 把一次 run 的 evidence events 密封成一个不可半 adoption 的 bundle，写入跨机
// Review inbox。核心不变量（§5.4 GO「seal crash 不产生半 adoption」）：
//   - 先把 bundle 写进 inbox 下的 .staging-<runId> 临时目录；
//   - 计算 seal（sha256 over canonicalJsonL(events)）；
//   - seal 成功 + seal 文件落盘后，才 atomic rename staging → <runId>/ 正式进 inbox；
//   - 任何步骤失败（seal crash / write fail / rename fail）：rmSync 整个 staging，
//     inbox 保持原样（既无 <runId>/，也不触碰同目录其它 legacy 产物），再抛出。
//
// 只读源、只写 inbox 下自己的 staging/bundle；绝不改写历史或同级其它目录。

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
void createHash; // 保留供未来 per-event hash 用，当前用 canonical.sha256
import { join } from "node:path";

import { canonicalJson, sha256, nowIso } from "./canonical.mjs";

const DEFAULT_SEAL = (canonicalLined) => sha256(canonicalLined);

export async function exportSealedRun({
  outboxDir,
  runId,
  events = [],
  seal = DEFAULT_SEAL,
  writeEvent = defaultWriteEvent,
  now = () => Date.now(),
}) {
  if (!outboxDir || typeof outboxDir !== "string") throw new Error("exportSealedRun: outboxDir required");
  if (!runId || typeof runId !== "string") throw new Error("exportSealedRun: runId required");
  mkdirSync(outboxDir, { recursive: true });

  const stagingDir = join(outboxDir, `.staging-${runId}`);
  const bundleDir = join(outboxDir, runId);
  // 入口先清掉可能残留的同名 staging，绝不残留半 bundle。
  cleanStaging(stagingDir);
  mkdirSync(stagingDir, { recursive: true });

  let canonicalLined = "";
  try {
    const lines = [];
    for (const event of events) {
      const line = `${canonicalJson(event)}\n`;
      lines.push(line);
      await writeEvent({ dir: stagingDir, line, event });
    }
    canonicalLined = lines.join("");
    writeFileSync(join(stagingDir, "events.jsonl"), canonicalLined);
    writeFileSync(join(stagingDir, "manifest.json"), canonicalJson({
      runId,
      schemaVersion: "xhs.evidence-v1",
      eventCount: events.length,
      createdAt: nowIso(now),
    }) + "\n");

    const sealHash = await seal(canonicalLined);
    if (typeof sealHash !== "string" || !sealHash) throw new Error("exportSealedRun: seal returned no hash");
    writeFileSync(join(stagingDir, "bundle.seal"), sealHash);

    // seal 文件已落盘 → 原子提交进 inbox。目标已存在则先清（重跑同 runId 覆盖自己
    // 的 v1 bundle），但绝不动同目录其它 legacy 产物。
    if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
    renameSync(stagingDir, bundleDir);

    return { sealed: true, sealHash, runId, bundleDir };
  } catch (error) {
    // 任一步骤失败：清 staging，inbox 保持原样，向上抛。绝不留半 bundle。
    cleanStaging(stagingDir);
    throw error;
  }
}

export function verifySealedRun({ bundleDir }) {
  try {
    if (!existsSync(bundleDir)) return { ok: false, reason: "bundle missing" };
    const sealPath = join(bundleDir, "bundle.seal");
    const eventsPath = join(bundleDir, "events.jsonl");
    if (!existsSync(sealPath) || !existsSync(eventsPath)) return { ok: false, reason: "seal or events missing" };
    const storedSeal = readText(sealPath);
    const content = readText(eventsPath);
    const expected = DEFAULT_SEAL(content);
    if (storedSeal !== expected) return { ok: false, reason: "seal mismatch (bundle tampered)" };
    return { ok: true, sealHash: storedSeal };
  } catch (error) {
    return { ok: false, reason: `verify error: ${error.message}` };
  }
}

function cleanStaging(stagingDir) {
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
}

async function defaultWriteEvent({ dir, line }) {
  // 默认逐事件不落单文件——events.jsonl 一次性写。留作注入点供故障注入测试。
  void dir; void line;
}

function readText(path) {
  return readFileSync(path, "utf8");
}