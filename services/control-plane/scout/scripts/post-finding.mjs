// REX Phase 5 B6a: scout finding → sealed candidate/knowledge proposal.
// 写入失败仅记 debt，不影响 Explorer（不把 409/网络错误当任务失败）。
// 用法：node scout/scripts/post-finding.mjs --finding ./finding.json [--endpoint http://127.0.0.1:17930]
import { readFileSync } from "node:fs";

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function buildSealedCandidate(finding = {}) {
  // 只放结构化字段；不带任何 device 标识/截图/明文。schemaVersion 固定，未来做
  // 精确 hash 复核时以它为锚。
  return {
    schemaVersion: "xhs.scout-finding.v1",
    id: finding.id,
    app: finding.app || "xhs",
    category: finding.category || "pitfall",
    title: finding.title,
    content: finding.content,
    scope: finding.scope || "global",
    verifiedBy: finding.verifiedBy || [],
    needsEngineer: finding.needsEngineer === true,
    ...(finding.runId ? { runId: finding.runId } : {}),
    ...(finding.effectId ? { effectId: finding.effectId } : {}),
    ...(finding.evidenceHash ? { evidenceHash: finding.evidenceHash } : {}),
  };
}

async function main(argv = process.argv.slice(2)) {
  const findingPath = option(argv, "--finding");
  const endpoint = option(argv, "--endpoint", "http://127.0.0.1:17930");
  const finding = findingPath ? JSON.parse(readFileSync(findingPath, "utf8")) : {};
  if (!finding.id || !finding.title || !finding.content) {
    process.stdout.write(JSON.stringify({ ok: false, debt: false, error: "finding requires id/title/content" }) + "\n");
    process.exitCode = 1;
    return;
  }
  const candidate = buildSealedCandidate(finding);
  try {
    const response = await fetch(`${endpoint}/api/knowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 409（已存在）与任何写失败都只记 debt，Explorer 继续。
      process.stdout.write(JSON.stringify({ ok: false, debt: true, status: response.status, code: data.error || data.reason || "KNOWLEDGE_WRITE_FAILED" }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ ok: true, debt: false, id: data.knowledge?.id || candidate.id }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, debt: true, error: error.message }) + "\n");
  }
}

main().catch(() => {});
