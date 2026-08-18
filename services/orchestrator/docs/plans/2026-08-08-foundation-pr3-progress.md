# Foundation PR3 progress — Transport Boundary

分支：`foundation/pr3-transport-boundary`

## 已落地（routing）

- `transport-action-authorization.mjs`：issue/consume、purpose↔status、写源拒绝、bypass 写关闭、nonce 单次
- `state-store`：`transport_action_authorizations` 表，`user_version=15`，issue/get/consume
- `typed-transport.mjs`：`createAuthorizedTypedTransport` + fake
- CP `#runJob`：mint execute/verify/restore/return_home；注入 `typedTransport` + `transportToken`
- `return-home.mjs`：有 token 时先 consume 再 Gateway
- `operator-access.mjs`：写 purpose 生产 bypass 关闭（observe 仍可 lab 审计）
- Xiaowei adapter：禁 ambient 构造；bootstrap 注入 transport；执行前可选 consume
- `scripts/check-adapter-imports.mjs` + 离线测试

## 已落地（registry twin）

- `scripts/lib/transport-action-authorization.mjs`
- `scripts/lib/typed-transport.mjs`（authorized wrapper）
- 对应 unit tests

## Phase 1 边界（有意未做）

- TypedTransport underlying 仍可 stub / Adapter 自持注入 channel（真机 channel 全迁 = 后续）
- 0 Windows deploy · 0 ActivatePilot · 0 设备

## 合入顺序

routing → registry；合入后不部署。
