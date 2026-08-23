export const SUPERVISOR_LIMITS = Object.freeze({
  maxLineBytes: 1024 * 1024,
  maxStdoutBytes: 32 * 1024 * 1024,
  maxNotifications: 10_000,
  maxPendingRequests: 8,
  maxIncompleteBytes: 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  maxStderrLines: 400,
});

export const SUPERVISOR_TIMEOUTS = Object.freeze({
  initializeMs: 10_000,
  promptAckMs: 5_000,
  idleMs: 60_000,
  shutdownResponseMs: 5_000,
  gracefulExitMs: 5_000,
  termExitMs: 3_000,
  treeKillMs: 5_000,
});

export const SDK_METHODS = Object.freeze(new Set([
  "initialize",
  "session/prompt",
  "shutdown",
]));

export const ADAPTER_KIND = "dsh_cordis_process";
