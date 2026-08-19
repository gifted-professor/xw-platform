// M3-R3 单设备 Canary 工具（plan.md §6.3/6.4）：profile 契约、执行序列骨架、
// 自动回滚触发器判定、--dry-run 计划产物。
// 本模块【不执行】canary：LIVE_CANARY_GATE 保持 CLOSED，dry-run 只输出将执行的步骤。
export const CANARY_PROFILE_SCHEMA_ID = "xw.cutover.canary-profile.v1";
export const CANARY_PLAN_SCHEMA_ID = "xw.cutover.canary-plan.v1";

// canary profile（plan.md §6.3「Canary 配置」）：单设备白名单 + 其余 quarantine +
// 指定 actor + 仅 legacy capability + Open Action/Agent Gateway live 关闭 + 支付硬闸开。
export function buildCanaryProfile({ deviceId, actorId }) {
  return Object.freeze({
    schemaId: CANARY_PROFILE_SCHEMA_ID,
    runtimeProfile: "legacy_compat",
    allowedDeviceIds: Object.freeze([deviceId ?? null]),
    quarantineOtherDevices: true,
    allowedActorIds: Object.freeze([actorId ?? null]),
    capabilities: "legacy-only",
    openActionLiveEnabled: false,
    agentGatewayLiveEnabled: false,
    dshEnabled: false,
    graphV2Enabled: false,
    multiAgentEnabled: false,
    paymentCredentialRequiresHuman: true,
    paymentFinalCommitRequiresHuman: true,
  });
}

// profile 校验：任何一项不满足都如实列出；绝不宽松放行。
export function validateCanaryProfile(profile) {
  const problems = [];
  if (profile?.schemaId !== CANARY_PROFILE_SCHEMA_ID) problems.push(`schemaId must be ${CANARY_PROFILE_SCHEMA_ID}`);
  const devices = profile?.allowedDeviceIds ?? [];
  if (devices.length !== 1 || !devices[0]) problems.push("exactly one canary device required (single-device whitelist)");
  if (profile?.quarantineOtherDevices !== true) problems.push("quarantineOtherDevices must be true");
  const actors = profile?.allowedActorIds ?? [];
  if (actors.length < 1 || !actors[0]) problems.push("at least one explicit actor required");
  if (profile?.capabilities !== "legacy-only") problems.push("capabilities must be legacy-only");
  for (const field of ["openActionLiveEnabled", "agentGatewayLiveEnabled", "dshEnabled", "graphV2Enabled", "multiAgentEnabled"]) {
    if (profile?.[field] !== false) problems.push(`${field} must be false`);
  }
  for (const field of ["paymentCredentialRequiresHuman", "paymentFinalCommitRequiresHuman"]) {
    if (profile?.[field] !== true) problems.push(`${field} must be true`);
  }
  return { ok: problems.length === 0, problems };
}

// 6.3 顺序编排骨架：切换序列 → canary 测试序列 → 支付红线验证。
// 每步带前置/后置检查；执行器（R3 canary 窗口/R4）按此顺序消费。
export function buildCanarySequence() {
  const cutover = [
    { id: "pause-new-job-submission", kind: "freeze", pre: ["control-plane reachable"], post: ["job submission paused"] },
    { id: "drain-active-jobs", kind: "freeze", pre: ["job submission paused"], post: ["runningJobs == 0"] },
    { id: "converge-leases-sessions", kind: "freeze", pre: ["runningJobs == 0"], post: ["activeLeases == 0", "activeSessions == 0"] },
    { id: "snapshot-both-dbs", kind: "freeze", pre: ["leases/sessions converged"], post: ["db-snapshot receipt ok (both DBs, integrity_check ok)"] },
    { id: "stop-legacy-orchestrator", kind: "cutover", pre: ["snapshots ok"], post: ["legacy orchestrator process gone"] },
    { id: "stop-legacy-control-plane", kind: "cutover", pre: ["legacy orchestrator stopped"], post: ["legacy control-plane process gone"] },
    { id: "verify-ports-released", kind: "cutover", pre: ["both legacy processes stopped"], post: ["no listener on 17920", "no listener on 17930"] },
    { id: "start-xw-control-plane", kind: "cutover", pre: ["ports released"], post: ["health ok", "authority == true", "release identity == locked", "runtimeProfile == legacy_compat", "DB user_version == expected"] },
    { id: "start-xw-orchestrator", kind: "cutover", pre: ["xw control-plane healthy"], post: ["health ok", "release identity == control-plane", "control API reachable", "no direct control.db writes"] },
  ];
  const tests = [
    { id: "health", kind: "canary-test", pre: ["xw stack up"], post: ["both health ok"] },
    { id: "inventory", kind: "canary-test", pre: ["health ok"], post: ["canary device visible", "other devices quarantined"] },
    { id: "observe", kind: "canary-test", pre: ["inventory ok", "device session (observation-only) attached by allowed actor"], post: ["observation recorded"] },
    { id: "existing-capability", kind: "canary-test", pre: ["observe ok"], post: ["legacy capability executes on canary device only"] },
    { id: "existing-session", kind: "canary-test", pre: ["capability ok"], post: ["session state consistent"] },
    { id: "existing-job", kind: "canary-test", pre: ["session ok"], post: ["single legacy job completes", "no new critical failure"] },
    { id: "evidence", kind: "canary-test", pre: ["job done"], post: ["evidence persisted"] },
    { id: "recovery", kind: "canary-test", pre: ["evidence ok"], post: ["recovery path verified"] },
    { id: "release", kind: "canary-test", pre: ["recovery ok"], post: ["session released", "lease freed"] },
  ];
  const payment = [
    { id: "payment-credential-requires-human", kind: "payment-redline", pre: ["canary stack up"], post: ["payment credential attempt => HUMAN_REQUIRED"] },
    { id: "payment-final-commit-requires-human", kind: "payment-redline", pre: ["credential gate verified"], post: ["payment final commit attempt => HUMAN_REQUIRED"] },
    { id: "unknown-payment-env-not-executed", kind: "payment-redline", pre: ["payment env classification"], post: ["unclassifiable payment env => not executed (fail-closed)"] },
  ];
  return [...cutover, ...tests, ...payment];
}

// 6.4 自动回滚触发器：checkId → 触发器。检查值 true=正常；false/"unknown" 均触发（fail-closed）。
export const ROLLBACK_TRIGGERS = Object.freeze([
  { id: "source-sha-mismatch", checkId: "sourceShaMatchesLocked", description: "运行 SHA 与锁定 SHA 不一致" },
  { id: "release-id-drift", checkId: "releaseIdMatchesLocked", description: "releaseId 漂移" },
  { id: "db-integrity-failure", checkId: "dbIntegrityOk", description: "DB integrity_check 失败" },
  { id: "schema-version-anomaly", checkId: "schemaVersionOk", description: "schema 版本异常" },
  { id: "device-count-mismatch", checkId: "deviceCountMatches", description: "设备数量不一致" },
  { id: "lease-session-authority-mismatch", checkId: "leaseSessionAuthorityConsistent", description: "lease/session 权威不一致" },
  { id: "new-critical-workflow-failure", checkId: "noNewCriticalWorkflowFailure", description: "已有 workflow 新关键失败" },
  { id: "evidence-write-failure", checkId: "evidenceWritable", description: "evidence 无法落盘" },
  { id: "payment-gate-failure", checkId: "paymentHardGateActive", description: "支付硬闸失败" },
  { id: "port-ownership-wrong", checkId: "portsOwnedByExpectedProcesses", description: "端口被错误进程占用" },
  { id: "unknown-process-legacy-checkout", checkId: "noUnknownProcessOnLegacyCheckout", description: "未知进程仍引用旧 checkout" },
]);

// 判定函数（纯）：checks = { [checkId]: true | false | "unknown" }。
// true = 该项正常；false/"unknown" = 触发回滚（fail-closed，无法判断视同触发）。
export function evaluateRollbackTriggers(checks = {}) {
  const triggered = [];
  for (const trigger of ROLLBACK_TRIGGERS) {
    const value = checks[trigger.checkId];
    if (value !== true) {
      triggered.push({
        id: trigger.id,
        description: trigger.description,
        checkId: trigger.checkId,
        observed: value === undefined ? "missing" : value,
      });
    }
  }
  return { ok: triggered.length === 0, triggered };
}

// dry-run：输出将执行的步骤序列 + 每步前置/后置检查 + 回滚触发器清单。绝不执行任何一步。
export function runCanaryDryRun({ profile, now = () => new Date().toISOString() } = {}) {
  const validation = validateCanaryProfile(profile);
  return {
    schemaId: CANARY_PLAN_SCHEMA_ID,
    generatedAt: now(),
    dryRun: true,
    executed: false,
    liveCanaryGate: "CLOSED",
    note: "dry-run 计划产物：未执行任何一步。真实执行需 LIVE_CANARY_GATE=OPEN 且人工在维护窗口启动；届时才生成 canary-receipt.v1.json。",
    profile,
    profileValidation: validation,
    steps: buildCanarySequence(),
    rollbackTriggers: ROLLBACK_TRIGGERS.map(({ id, description }) => ({ id, description })),
    rollbackPolicy: "任一触发器命中（含检查值 unknown）立即执行 rollback：旧代码 + 旧 DB snapshot + 旧 launch 配置（rollback-certification.v1 已证明可恢复）。",
    ok: validation.ok,
  };
}
