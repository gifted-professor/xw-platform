# Target Layout

本文件定义**目标目录**。`services/orchestrator/` 与 `services/control-plane/` 已由 F1-C / F1-D 历史导入产生；`tools/fusion/` 由 F1-E 产生。`packages/`、`plugins/`、`integrations/` 在首个真实文件出现前仍不建空目录。

```
xw-platform/
├── services/
│   ├── orchestrator/       ← xhs-registry 全历史（F1-C）
│   ├── control-plane/      ← xhs-device-agent 全历史（F1-D）
│   └── agent-gateway/      ← Harness session → device session
├── packages/
│   ├── kernel/             ← 共享契约（含 Open Action 与 M4-A Skill contract）
│   ├── control-client/     ← 上层唯一 Control Plane HTTP 客户端
│   ├── replay/             ← fixture / recorded / fault backends
│   └── cli/                ← xw phone
├── plugins/                ← 后续 XW 插件
├── integrations/           ← 后续 DSH 等 Harness Adapter
├── docs/
└── tools/
    └── fusion/             ← F1-E 导入验证工具
```

## 阶段状态

| 阶段 | 内容 |
|---|---|
| F1-B | 骨架文档（本文件 + runtime-boundaries + 合同/source-lock 副本 + bootstrap receipt）— 完成 |
| F1-C | 导入 Orchestrator（xhs-registry 全历史 → `services/orchestrator/`）— 完成 |
| F1-D | 导入 Control Plane（xhs-device-agent 全历史 → `services/control-plane/`）— 完成 |
| F1-E | 增加导入验证工具（`tools/fusion/`）— 完成 |
| F1-F | 增加根命令转发和离线 CI（不启用 workspace hoisting）— 完成 |
| F1-G | 完成 Physical Fusion 验收 — 完成 |

## 不变量

- **F1-B 阶段不创建空 service 目录**：不放 `.gitkeep`。`services/orchestrator/` 与 `services/control-plane/` 由 F1-C/F1-D 历史导入自然产生。提前放 `.gitkeep` 会让导入后 prefix tree parity 出现 `extraFileCount > 0`。
- `packages/`、`plugins/`、`integrations/`、`tools/` 同理——在首个真实文件出现前不建空目录、不放 `.gitkeep`。
- 不启用 npm workspaces。