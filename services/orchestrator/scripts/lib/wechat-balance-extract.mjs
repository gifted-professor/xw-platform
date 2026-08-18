import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WECHAT_BALANCE_OCR_PY = join(HERE, "wechat-balance-ocr.py");
export const DEFAULT_PADDLE_OCR_PYTHON = "C:\\Users\\Public\\xhs-registry-visual-tap\\experiments\\visual-tap-resolver\\.venv-ocr\\Scripts\\python.exe";

/**
 * Read-only amount extract from a Services-page screenshot.
 * Fail closed when OCR missing or amount not unique.
 */
export function extractWechatBalanceFromScreen(imagePath, {
  pythonPath = process.env.XHS_PADDLE_OCR_PYTHON || DEFAULT_PADDLE_OCR_PYTHON,
  scriptPath = DEFAULT_WECHAT_BALANCE_OCR_PY,
  timeoutMs = 120000,
} = {}) {
  if (!imagePath || !existsSync(imagePath)) {
    return { ok: false, code: "IMAGE_NOT_FOUND", message: `screenshot missing: ${imagePath || "<empty>"}` };
  }
  if (!existsSync(pythonPath)) {
    return { ok: false, code: "OCR_PYTHON_MISSING", message: `paddle ocr python missing: ${pythonPath}` };
  }
  if (!existsSync(scriptPath)) {
    return { ok: false, code: "OCR_SCRIPT_MISSING", message: `ocr script missing: ${scriptPath}` };
  }
  const result = spawnSync(pythonPath, [scriptPath, imagePath], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      FLAGS_use_mkldnn: "0",
      PADDLE_PDX_DISABLE_MKLDNN: "1",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  let payload = null;
  try {
    const line = stdout.split(/\r?\n/).filter(Boolean).at(-1);
    payload = line ? JSON.parse(line) : null;
  } catch {
    payload = null;
  }
  if (!payload) {
    return {
      ok: false,
      code: "OCR_OUTPUT_INVALID",
      message: stderr.slice(0, 300) || stdout.slice(0, 300) || `ocr exit ${result.status}`,
      exitCode: result.status,
    };
  }
  if (!payload.ok) {
    return {
      ok: false,
      code: payload.code || "OCR_FAILED",
      message: payload.message || payload.code || "ocr failed",
      amountCandidates: payload.amountCandidates || [],
      texts: payload.texts || [],
    };
  }
  return {
    ok: true,
    amountCny: String(payload.amountCny),
    currency: payload.currency || "CNY",
    amountCandidates: payload.amountCandidates || [payload.amountCny],
    display: payload.display || `¥${payload.amountCny}`,
    texts: payload.texts || [],
    crop: payload.crop || null,
    imagePath,
    privacy: { publicKnowledge: false },
  };
}
