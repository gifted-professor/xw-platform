export class ControlPlaneError extends Error {
  constructor(code, message, { status = 400, details = {}, cause } = {}) {
    super(message, { cause });
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorBody(error) {
  if (error instanceof ControlPlaneError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "CONTROL_INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}

export function asControlError(error, fallbackCode = "CONTROL_INTERNAL_ERROR") {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError(
    error?.code || fallbackCode,
    error instanceof Error ? error.message : String(error),
    { status: 500, cause: error },
  );
}

// token/secret-ish field names never appear in structured logs, even redacted
const REDACT_KEY = /token|secret|password|authorization/i;

/**
 * Structured error line for the Windows deploy bridge. Red line: console.log
 * ONLY — the bridge treats stderr output as a fatal signal. Bodies are never
 * passed here (callers log method/path/ids, never payloads); string values
 * are length-capped.
 */
export function structuredErrorLog({ event, error, extra = {}, log = (line) => console.log(line) }) {
  const info = error instanceof ControlPlaneError
    ? {
      code: error.code,
      status: error.status,
      message: String(error.message ?? "").slice(0, 300),
      causeCode: error.cause?.code ?? null,
      causeMessage: error.cause?.message ? String(error.cause.message).slice(0, 300) : null,
    }
    : {
      code: error?.code ?? "CONTROL_INTERNAL_ERROR",
      status: error?.status ?? 500,
      message: String(error?.message ?? error ?? "").slice(0, 300),
      causeCode: error?.cause?.code ?? null,
      causeMessage: error?.cause?.message ? String(error.cause.message).slice(0, 300) : null,
    };
  const safeExtra = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value == null) continue;
    if (REDACT_KEY.test(key)) continue;
    safeExtra[key] = typeof value === "string"
      ? value.slice(0, 200)
      : (typeof value === "number" || typeof value === "boolean" ? value : String(value).slice(0, 200));
  }
  log(JSON.stringify({ event, at: new Date().toISOString(), ...info, ...safeExtra }));
}
