#!/usr/bin/env node
/**
 * LLM gate for Douyin comment copy-send (CPA OpenAI-compatible).
 *
 *   node ops/_llm-comment-gate.mjs --text "哈哈太真实了"
 * stdout: LLM_VERDICT=APPROVE|DENY|ERROR LLM_REASON=…
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "./_explore-lib.mjs";

const { opt, flag } = parseArgs(process.argv.slice(2));
if (flag("--help") || flag("-h")) {
  console.log(`用法: node ops/_llm-comment-gate.mjs --text <candidate> [--model claude-haiku-4-5]`);
  process.exit(0);
}

const text = opt("--text");
const model = opt("--model", "gemini-2.5-flash-lite");
if (!text) {
  console.log("LLM_VERDICT=ERROR");
  console.log("LLM_REASON=missing_text");
  process.exit(2);
}

const script = join(homedir(), ".codex", "skills", "remote-cpa", "scripts", "cpa_request.py");
const logDir = join(process.cwd(), "runtime", "douyin-comment");
mkdirSync(logDir, { recursive: true });

const system =
  'You gate whether a Douyin comment may be copy-sent verbatim. Reply ONLY one JSON object: {"verdict":"APPROVE"|"DENY","reason":"short"}. DENY ads/spam/politics/sexual/violence/attacks/phishing/promo/@引流/polluted UI text. APPROVE only short benign social remarks.';

const message = `Candidate comment to copy-send verbatim:\n"""${String(text).slice(0, 200)}"""`;

function runPython(bin) {
  return spawnSync(
    bin,
    [script, "chat", "--model", model, "--max-tokens", "120", "--system", system, "--message", message],
    { encoding: "utf8", timeout: 90000 },
  );
}

let r = existsSync(script) ? runPython("python") : null;
if (!r || r.error || (r.status !== 0 && /not recognized|ENOENT/i.test(String(r.error || r.stderr || "")))) {
  r = runPython("python3");
}

const out = String(r?.stdout || "").trim();
const err = String(r?.stderr || "").trim();
appendFileSync(
  join(logDir, "llm-gate.jsonl"),
  JSON.stringify({
    ts: new Date().toISOString(),
    model,
    text: String(text).slice(0, 200),
    status: r?.status,
    out: out.slice(0, 500),
    err: err.slice(0, 300),
  }) + "\n",
);

if (!existsSync(script)) {
  console.log("LLM_VERDICT=ERROR");
  console.log("LLM_REASON=cpa_script_missing");
  process.exit(2);
}

if (!r || r.status !== 0 || !out) {
  console.log("LLM_VERDICT=ERROR");
  console.log(`LLM_REASON=${(err || out || "cpa_chat_failed").slice(0, 160)}`);
  process.exit(2);
}

let verdict = "ERROR";
let reason = "parse_fail";
try {
  const m = out.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : out);
  const v = String(j.verdict || "").toUpperCase();
  if (v === "APPROVE" || v === "DENY") {
    verdict = v;
    reason = String(j.reason || "").slice(0, 160) || "ok";
  } else {
    reason = `bad_verdict:${v || "?"}`;
  }
} catch {
  // soft parse: look for bare word
  if (/\bAPPROVE\b/i.test(out) && !/\bDENY\b/i.test(out)) {
    verdict = "APPROVE";
    reason = "soft_parse";
  } else if (/\bDENY\b/i.test(out)) {
    verdict = "DENY";
    reason = "soft_parse";
  } else {
    reason = out.slice(0, 120);
  }
}

writeFileSync(
  join(logDir, "llm-gate-last.json"),
  JSON.stringify({ verdict, reason, model, text: String(text).slice(0, 200), raw: out.slice(0, 400) }, null, 2),
);

console.log(`LLM_VERDICT=${verdict}`);
console.log(`LLM_REASON=${reason}`);
console.log(`LLM_MODEL=${model}`);
process.exit(verdict === "APPROVE" ? 0 : verdict === "DENY" ? 1 : 2);
