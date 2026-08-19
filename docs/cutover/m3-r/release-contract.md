# M3-R1 Release Contract（落地记录）

> 状态：**已实现（源码），未操作现场**（2026-08-19）。
> 范围：`plan.md` §四 R1 的离线部分。`runtimeCutoverAllowed` 恒为 `false`。
> 本文件记录 R1 实际落地的契约，字段与 `plan.md` §一 / §4.2 / §4.3 / §4.4 保持一致。

## 1. Runtime Profile

- 契约文件：`packages/kernel/contracts/runtime-profile.v1.json`（登记进 `packages/kernel/contracts/manifest.v1.json`）。
- 加载器：`packages/kernel/lib/runtime-profile.mjs`
  - `loadRuntimeProfile(name = "legacy_compat")`：校验字段齐全且为 boolean，返回冻结对象；未知名抛 `UNKNOWN_RUNTIME_PROFILE`。
  - `DEFAULT_RUNTIME_PROFILE = "legacy_compat"`。
- `legacy_compat` 字段与 `plan.md` §一完全一致（两个 legacy 开关开、五个新能力关、两个支付硬闸开）。

## 2. Release Manifest

- 实现：`packages/release/lib/release-manifest.mjs`（纯 Node，零第三方依赖）。
- `buildReleaseManifest({ root, releaseId? })`：
  - `sourceCommit` / `sourceTreeSha` 来自 `git rev-parse HEAD` / `HEAD^{tree}`；
  - `sourceRepo` 固定 `gifted-professor/xw-platform`；
  - `files` 为 `git ls-files`（排除 `.git`）逐文件 sha256；
  - `services.orchestrator` / `services.controlPlane` 各自子树 hash；
  - `nodeVersion` / `npmVersion` 记录构建机版本；
  - `runtimeCutoverAllowed: false` 永远成立。
  - 默认 `releaseId = xw-<yyyymmdd>-<shortsha>`（UTC 日期）。
- `writeRelease({ root, outDir, releaseId? })`：物化到 `outDir/releases/<releaseId>/`，已存在则拒绝（`RELEASE_IMMUTABLE`）；写入 `release-manifest.v1.json`；不写 `outDir` 之外任何路径。
- `verifyReleaseManifest({ manifestPath, root })`：重算全部文件 hash 与服务子树 hash，返回 `{ ok, mismatches[] }`；`runtimeCutoverAllowed !== false` 视为 mismatch。

Manifest 顶层字段（schemaId `xw.runtime.release-manifest.v1`）：

```json
{
  "schemaId": "xw.runtime.release-manifest.v1",
  "releaseId": "xw-20260819-<shortsha>",
  "sourceRepo": "gifted-professor/xw-platform",
  "sourceCommit": "<40位SHA>",
  "sourceTreeSha": "<tree SHA>",
  "runtimeProfile": "legacy_compat",
  "nodeVersion": "24.11.1",
  "npmVersion": "11.6.2",
  "services": {
    "orchestrator": { "path": "services/orchestrator", "treeSha256": "..." },
    "controlPlane": { "path": "services/control-plane", "treeSha256": "..." }
  },
  "files": [{ "path": "...", "sha256": "..." }],
  "runtimeCutoverAllowed": false
}
```

## 3. Release Identity（health 统一字段）

- 共享加载：`packages/release/lib/release-identity.mjs` 的 `loadReleaseIdentity({ startDir, env })`，优先级：
  1. env `XW_RELEASE_MANIFEST` 指向的 manifest 文件；
  2. 从 `startDir` 向上查找 `release-manifest.v1.json`；
  3. 旧行为兜底：env `CONTROL_PLANE_RELEASE_ID`（只填 `releaseId`）；
  4. 全部 `null`。
- 返回 `{ sourceRepo, sourceCommit, releaseId, runtimeProfile }`（缺项为 `null`）。
- Control Plane `GET /control/v1/health` 与 Orchestrator `GET /api/health`（浅/深）都新增这四个字段；Control Plane 的 `releaseId` 保持向后兼容（identity 优先，回落 `CONTROL_PLANE_RELEASE_ID`）。

## 4. Cutover CLI（`xw cutover`）

实现于 `packages/cli/xw.mjs`，全部离线：不访问网络、不读现场服务、不写 `--out` 之外路径。

```bash
xw cutover collect [--json]                     # node/npm 版本、平台、repo 根、HEAD commit/tree、git status 是否脏
xw cutover package --out DIR [--release-id ID]  # 物化不可变 release
xw cutover verify --release DIR [--json]        # 重算比对全部 hash + 目录结构检查（两服务 / packages / manifest）
xw cutover preflight [--release DIR] [--json]   # 离线预检，输出 { ok, checks:[{id,ok,detail?}] }，任一失败 exit 1
```

preflight 检查项：node 主版本 ≥ 20；`legacy_compat` 可加载；`runtimeCutoverAllowed === false`；给了 `--release` 时追加 manifest 校验 + 两个服务入口文件存在。

**明确不实现**（属于 M3-R3+）：`canary` / `promote` / `closeout` / `deploy`。R2 新增的 `collect --live` / `snapshot` / `rehearse` / `rollback` 见 `r2-rehearsal-rollback.md`。

## 5. 测试与门槛

- `npm run test:cutover`：`packages/release/test/` + `packages/cli/test/xw-cutover.test.mjs`（临时目录 + 临时 git 仓，不碰网络与现场）。
- 导入树改动（`services/orchestrator/registry.mjs`、`services/control-plane/control-plane/router.mjs` 的 health 字段）已登记 `docs/fusion/post-import-allowlist.v1.json`。
