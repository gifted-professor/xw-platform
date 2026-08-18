# Foundation PR1 降门合并清单（2026-08-08）

> 目标：尽快合 PR1，不卡全绿；为 skill 链路 / PR2 并行让路。  
> 规格仍以 `silly-tumbling-raccoon.md` 为准；本文件只改 **merge bar**。

## 合并门（降门后）

**通过条件：** PR1 语义相关失败清零 + `foundation-pr1-core` / binder / xw-mission 绿。  
**不通过条件：** 不再要求 Windows 全量 npm test 0 fail（main 本身已有 ~32 环境债）。

推荐顺序不变：**routing #40 → registry #3**；中间 **禁止部署 / 重启 / 切 pilot**。

## 分类结果

### Routing（`foundation/pr1-core`）

| 类 | 数量 | 处置 |
|---|---:|---|
| 本 PR 必修（expect 对齐） | 10 | **已修** |
| 与 main 同债（Win symlink/path/scout 等） | ~31 | 记债，不挡 merge |

必修已对齐：

- publish/delete → 永远 `phc`（含 `allow_within_scope`）
- unknown / 未知交互 → `typed_capability_required`
- financial_commit admission → `wait_human_commit` / `PROTECTED_COMMIT_REQUIRED`
- auth envelope 多字段；`user_version` 14

### Registry（`foundation/pr1-core`）

| 失败 | 类 | 处置 |
|---|---|---|
| plan hash CRLF | 环境 | 哈希前 `\r\n`→`\n`（已修） |
| repair-scope exclusivity | 旧 repair PR 守卫 | foundation 分支跳过（已修） |
| `pinnedIdentity is not defined` | 真 bug | `resetExplorerActionPin` 清 Map（已修） |
| observer singleflight / repair symlink EPERM | 环境债 | 不挡 merge |

## 合完立刻做

1. 两仓 main 对齐后开 `foundation/pr2-runtime-integrity`（短）
2. **并行** skill 链路分支（`xw-mission` 唯一推荐入口 / binding / Skill 不本地判权）
3. PR3 传输边界、PR4 真机 canary **先别开**

## 明确不做

- 不再扩 INV / 再开架构评审
- 不合完就部署
- 不为 31 个 main 同债挡 merge
