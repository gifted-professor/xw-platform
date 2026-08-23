#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = resolve(process.cwd());
const sha = (value) => createHash("sha256").update(value).digest("hex");
const text = (path) => readFileSync(resolve(root, path), "utf8");
const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
const untracked = status.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).replaceAll("\\", "/"));
const allowedExtension = new Set([".mjs", ".json", ".yml", ".yaml", ".md"]);
const sourceFiles = untracked.filter((path) => allowedExtension.has(extname(path).toLowerCase())
  && !path.startsWith("artifacts/") && path !== "tools/m6/m6-4-freeze-execution-review-packet.mjs"
  && !path.includes("node_modules/") && !path.includes(".runtime/"));
const trackedDiff = execFileSync("git", ["diff", "--no-ext-diff", "--", ".github/workflows/source-fusion.yml", "package.json", "integrations/dsh-xw/package.json", "services/control-plane/apps/xiaowei/capabilities.json", "services/control-plane/control-plane/lib/m6-gate-loader.mjs", "services/control-plane/control-plane/lib/state-store.mjs", "services/control-plane/tests/control-plane-open-action-executor.test.mjs", "services/control-plane/tests/control-plane-placement.test.mjs", "services/control-plane/tests/discovery-session-state.test.mjs", "services/control-plane/tests/foundation-pr3-transport-boundary.test.mjs", "services/control-plane/tests/m6-gate-loader.test.mjs", "services/control-plane/tests/open-action-device-session.test.mjs"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const receipt = JSON.parse(text("artifacts/m6-4/m6-4-code-ready-receipt.json"));
const header = `# M6-4 integrated execution review packet\n\n- Mode: EXECUTION_REVIEW\n- Risk: CRITICAL\n- Authorization: close-accepted-blockers\n- Plan SHA-256: ${receipt.planSha256}\n- Candidate snapshot SHA-256: ${receipt.candidateSnapshotHash}\n- Gate: CLOSED and unchanged; resources/actionCount: zero\n- Gate F: not authorized, not executed; live model/profile remains UNQUALIFIED\n- Original request: complete approved M6-4 implementation through offline code-ready state, then hand off M6-5; do not perform real live action without separate exact authorization.\n\n## Review instructions\n\nInspect plan compliance and actual changed behavior. Return at most five evidence-backed findings. Only P0/P1 can block. Do not treat unresolved Gate F model/authorization as an implementation defect: the plan explicitly allows offline implementation to continue but forbids live canary. Treat the preserved byte-pinned replay v1 runtime plus separate shared-kernel live v2 runtime as the recorded compatibility deviation; flag it only if the live path can reach legacy resolveInternalPoint or creates an authority bypass.\n\n## Known evidence and limitations\n\n- M6-4 offline: 31/31; M6: 121/121; M6-2 offline: 108/108; epoch: 67 pass + exact Windows symlink skip; M6-3 Gate B/C/D/E: 21/8/22/2 pass.\n- Orchestrator: 530/531, sole exact Windows symlink EPERM fixture exception.\n- Targeted schema-v19/M6 boundary: 51/51.\n- Control Plane broad baseline: 924/959, 32 unrelated legacy Windows/path failures and 3 skips; not claimed green.\n- No deploy, merge, push, epoch activation or device action.\n\n## Approved plan V1\n\n${text("docs/plans/M6-4-single-alias-grounded-action-plan-v1.md")}\n\n## Normative Plan V2\n\n${text("docs/plans/M6-4-single-alias-grounded-action-plan-v2.md")}\n\n## Validated execution contract\n\n\`\`\`json\n${text("docs/plans/M6-4-execution-contract.json")}\n\`\`\`\n\n## Code-ready receipt\n\n\`\`\`json\n${text("artifacts/m6-4/m6-4-code-ready-receipt.json")}\n\`\`\`\n\n## Tracked diff\n\n\`\`\`diff\n${trackedDiff}\n\`\`\`\n`;
const appended = sourceFiles.map((path) => `\n## New file: ${path}\n\n\`\`\`${extname(path).slice(1)}\n${text(path)}\n\`\`\`\n`).join("");
const body = `${header}${appended}`;
const packetHash = sha(body);
const packet = `${body}\n## Packet seal\n\nSHA-256 over all preceding UTF-8 bytes: \`${packetHash}\`\n`;
const out = resolve(root, "artifacts/m6-4/m6-4-execution-review-packet.md");
writeFileSync(out, packet, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, out, packetSha256: sha(packet), sealedBodySha256: packetHash, bytes: Buffer.byteLength(packet), newSourceFiles: sourceFiles.length }, null, 2)}\n`);
