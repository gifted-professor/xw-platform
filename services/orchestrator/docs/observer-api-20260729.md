# Observer / Fleet / cache-only Screen API 契约（跨工具 source of truth）

**日期**：2026-07-29
**分支**：`codex/observer-access-v1`（起点本地 `ee4135e`）
**目的**：为 abtop 的「只读手机状态面板」提供安全的只读接入层。控制面核心（`xhs-device-agent-control-v1`）不动；本文件是 Observer/Fleet/Screen 契约与 Operator 冻结状态的唯一跨工具依据。

> 配套方向文档：`docs/abtop-access-layer-20260729.md`（为什么只补接入层、不重做控制面）。

---

## 1. 角色与鉴权

四种 token：`--agent-token`、`--human-token`、`--observer-token`、`--operator-token`。

- **开放调试模式**：当且仅当**四种 token 全部为空**时，registry 进入开放调试模式（所有请求按 `human` 处理）。只要配了任意一个 token，就不再开放调试。安装脚本在四 token 全空且未显式 `-DebugMode` 时**拒绝安装**。
- **observer / operator 只认 header token**：`x-registry-token`，**不接受 URL `?token=`**。human/agent 仍保留 `?token=` 换 session 的既有流程（核心路由不动）。
- `readOnlyRole()` = observer || operator，作纵深防御。

### 命名空间闸门（`resolveAuth` 之后、路由匹配之前）

| 请求角色 | 命名空间 | 结果 |
|---|---|---|
| observer | `/api/observer/v1/*` | 放行 |
| observer | 其余任意 | **403** `observer is restricted to /api/observer/v1/*` |
| 非 observer | `/api/observer/v1/*` | **403** `observer namespace requires observer token` |
| operator | `/api/operator/*` | 鉴权通过后**仍 501 frozen**（见 §5） |
| operator | 其余任意 | **403** `operator is restricted to /api/operator/*` |
| 非 operator | `/api/operator/*` | **403** `operator namespace requires operator token` |

---

## 2. Fleet API

### `GET /api/observer/v1/fleet`（observer token，header）

`cache-control: no-store`。响应顶层：

```
ok, schemaVersion: "xhs.observer.fleet.v1", generatedAt, degraded, sources, devices[]
```

- `schemaVersion`：版本化契约，abtop 据此判断结构兼容。
- `degraded`：`Boolean(sources.controlPlane.stale || sources.controlDb.stale)`。abtop 一眼判断数据是否降级；**不假阳性**——控制面不可达时设备 `ready=null`（既不真也不假），不会把降级写成 Ready。

### 单设备 DTO（`redactFleetDevice`）

| 字段 | 说明 |
|---|---|
| `alias` | 设备别名 |
| `displayName` | `normalizeText(dev.label, 60)`，缺失回退 `设备 ${alias}` |
| `model` | `normalizeText(dev.model, 60)`，缺失 `null` |
| `online` / `ready` / `quarantined` | 设备状态；控制面不可达时为 `null` |
| `quarantineReason` | 隔离原因 |
| `lease` | `{ held, kind?, expiresAt? }` 或 `{ held:false }` |
| `currentTask` | `{ capabilityId, jobId, reportedActor, actorVerified:false, status }` 或 `null` |
| `streak` / `unresolvedFailure` | 连续成功数 / 是否有未解决失败 |
| `freshness` | `{ generatedAt, controlPlane:{reachable,stale}, controlDb:{reachable,stale}, identityAgeSeconds, identityStale }` |

**脱敏口径（不返回）**：serial、accounts、customer、notes、deviceId、runId、内部连接端点、ADB 句柄、control.db 路径、命令参数。

**字段语义说明**：
- `currentTask.reportedActor`：原 `actor`，明确为**任务自报身份**；`actorVerified:false` 表示 registry 未对其做独立校验。abtop 不得据此等同于「已确认操作者」。
- `displayName` / `model` 的 `normalizeText`：去控制字符（`\x00-\x1f\x7f`）、trim、限长 60。**JSON 层只做规范化，abtop 前端渲染层仍必须 HTML 转义。**

---

## 3. cache-only Screen API

只返回控制面**已经采集**的最近截图（`evidence` 表 `kind='screenshot'`，按 `created_at DESC LIMIT 1`）。**前端刷新命中进程内缓存 / 304，绝不触发设备 Screen、不触发 job、不动 lease**——registry 不 POST 控制面、不写 control.db，只读 evidence 表 + 磁盘字节。

### 路由（observer token，header）

- `GET /api/observer/v1/screen/:alias/meta` → JSON 元数据
- `GET /api/observer/v1/screen/:alias` → 图像字节

### 完整性校验（`loadScreenEntry`）

1. 查 evidence 最新截图行。
2. `bytes > SCREEN_MAX_BYTES` → `{ oversize:true }` → **413**。
3. **路径校验防 symlink 逃逸**：对 `RUNS_ROOT` 和目标 `<runsRoot>/<run_id>/<path>` 都做 `realpath`，再做 containment 校验（`targetReal === rootReal || startsWith(rootReal + sep)`），不符 → 丢弃 404。
4. 异步 `readFile`；读后重算 SHA-256 `safeEqual(row.sha256)`、`buf.length === row.bytes`、魔数判型（PNG `89 50 4E 47` / JPEG `FF D8 FF`），任一不符 → 丢弃 404。
5. `RUNS_ROOT` 为空 → 404。

### 缓存与 stale 语义（P0-4 拆分）

- `SCREEN_CACHE_TTL_MS`（默认 10000，`--screen-cache-ttl-ms`）：**多久重新查数据库**。命中且未过期 → 直接返回缓存，不查 DB、不读盘。
- `SCREEN_STALE_AFTER_MS`（默认 120000）：**截图年龄阈值**，`ageSeconds*1000 > 阈值` → `stale:true`。
- `SCREEN_MIN_INTERVAL_MS`（默认 1000，`--screen-min-interval-ms`）：同 alias 最小请求间隔，间隔内只返回缓存 / 304（限频，防刷）。
- `SCREEN_MAX_BYTES`：8 MiB，超限 413，不入缓存。

> 数值参数用 `Number.isFinite` 解析（**不**用 `Number(x) || default`，后者会把合法的 `0` 当假值回退到默认）。

**`stale=true` 的两种情形**：
1. **降级沿用旧缓存**：缓存未过期但本次重新加载失败（文件丢失 / 校验不符 / realpath 失败）且存在旧缓存 → 标记 `fallback:true` 沿用旧图，`stale:true`。
2. **截图年龄超阈值**：`ageSeconds*1000 > SCREEN_STALE_AFTER_MS` → `stale:true`。

正常新图 `stale:false`。

### 并发单飞（P1-6）

`screenInflight Map<alias, Promise>`：per-alias 单飞，并发请求共用一次 DB + 文件读取，防缓存穿透。测试已证明并发请求只发生一次磁盘加载。

### 响应头与缓存

- `cache-control: private, no-cache`（200 / meta / 304 一致）。
- ETag 带引号 `"<sha>"`；`If-None-Match` 比较前剥引号再 `safeEqual`；命中 → **304**（带引号 ETag）。
- 图像 200 额外头：`x-screen-stale: 0|1`、`x-screen-captured-at`、`last-modified`、`content-type`（按魔数，PNG/JPEG）。

### meta 响应体

```
ok, alias, sha256, bytes, capturedAt, jobId, contentType, ageSeconds, stale
```

**不含 `runId`**（避免泄露内部 run 标识）。`jobId` 保留作任务关联句柄，非敏感。

---

## 4. 安装与凭证（`install-registry-task.ps1`）

- **默认监听 `127.0.0.1`**（`--host 127.0.0.1`）；Observer API 不默认监听 `0.0.0.0`。对外通过 **abtop 后端或 Tailscale Serve** 暴露，浏览器不直连 registry。
- 已**移除源码内硬编码默认 AgentToken**；token 仅在非空时拼入 `--agent-token` 等参数。
- 四 token 全空且未显式 `-DebugMode` → **拒绝安装**。
- **凭证现状措辞（必须照此口径，不得宣称「凭证问题已解决」）**：
  > 已移除源码默认凭证；受保护的凭证注入（计划任务环境 / 密钥管理）仍是部署前置条件。
- 已知残留风险：CLI arg 在 Windows 计划任务配置 / 进程信息中仍可见。生产应以受保护的凭证注入替代明文 CLI arg。

---

## 5. Operator 全面冻结（本轮）

所有 `/api/operator/*`（`submit`、`session`、`job/:id`）在 operator 鉴权通过后统一返回：

```
501 { ok:false, error:"operator frozen; future hardening pending" }
```

**已删除** 旧的 `GET /api/operator/job/:id` 只读代理（避免返回未经专项脱敏的 job 数据）。

### 未来启用 Operator 前的加固清单

- 强制幂等键（防重复下发）
- capability manifest 动态风险校验
- 任务归属（actor 真实校验，`actorVerified` 升级路径）
- 响应脱敏（job 数据专项脱敏后再暴露）
- 审批闸接入
- 完整审计

命令仍走现有 job/session/lease/capability/审批/audited recovery 链路，**不另起执行通道**；abtop 后端把白名单命令转成正式 job/session，浏览器不直连 17920 / 22222 / ADB / control.db。

---

## 6. 回归与验证

- `node --test tests/registry.test.mjs`：33/33（含 13 项负向测试）。
- `npm test`：42/42；`npm run check`：通过；`git diff --check`：无空白错误。
- 手起验证用**临时空闲端口 + 临时 DB + 临时 runsRoot**（不固定 17930），observer token 走 header：
  - `GET /api/observer/v1/fleet` → 200，含 `schemaVersion` / `displayName` / `model` / `reportedActor` / `actorVerified:false` / `freshness` / `degraded`。
  - `GET /api/observer/v1/screen/01` → 200 真图，ETag 带引号；`If-None-Match: "<sha>"` → 304。
  - observer 调 `/api/agent-entry` → 403；`?token=<observer>` query → 拒绝。
  - `POST /api/operator/submit`、`GET /api/operator/job/x`（operator token）→ 501 frozen。
- 核心路由（`/api/agent-entry`、`/api/health?deep=1`、`/api/knowledge`、审批）未动，回归正常。

## 7. 本轮改动文件

- `registry.mjs`：开放调试条件、命名空间闸门、observer/operator header-only token、路由改名、Operator 全冻结、Fleet DTO 版本化与脱敏、Screen 完整性 / 缓存 / 单飞 / stale 语义。
- `tests/registry.test.mjs`：真图夹具（动态 SHA、真 PNG 魔数、实际 `Buffer.length`）、三测试更新到新契约、13 项负向测试。
- `install-registry-task.ps1`：移除硬编码默认 token、默认 `127.0.0.1`、四空拒绝 / `-DebugMode`。
- `docs/observer-api-20260729.md`：本文件。