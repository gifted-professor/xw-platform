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
