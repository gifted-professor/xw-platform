export class SupervisorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new SupervisorError(code, message, details);
}
