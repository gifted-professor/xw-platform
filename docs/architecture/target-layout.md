# Target Layout

本文件只定义**目标目录**，不声称目录已经存在。F1-B 阶段只落地骨架文档；`services/` 两个目录由历史导入自然产生，Git 中不提前创建空目录。

```
xw-platform/
├── services/
│   ├── orchestrator/       ← 后续导入 xhs-registry（F1-C）
│   └── control-plane/      ← 后续导入 xhs-device-agent（F1-D）
├── packages/               ← 后续共享内核
├── plugins/                ← 后续 XW 插件
├── integrations/           ← 后续 DSH 等 Harness Adapter
├── docs/
└── tools/
```

## 阶段状态

| 阶段 | 内容 |
|---|---|
| F1-B | 只有骨架文档（本文件 + runtime-boundaries + 合同/source-lock 副本 + bootstrap receipt） |
| F1-C | 导入 Orchestrator（xhs-registry 全历史 → `services/orchestrator/`） |
| F1-D | 导入 Control Plane（xhs-device-agent 全历史 → `services/control-plane/`） |
| F1-E | 增加导入验证工具（`tools/fusion/`） |
| F1-F | 增加根命令转发和离线 CI（不启用 workspace hoisting） |
| F1-G | 完成 Physical Fusion 验收 |

## 不变量

- **F1-B 阶段不创建空 service 目录**：不放 `.gitkeep`。`services/orchestrator/` 与 `services/control-plane/` 由 F1-C/F1-D 历史导入自然产生。提前放 `.gitkeep` 会让导入后 prefix tree parity 出现 `extraFileCount > 0`。
- `packages/`、`plugins/`、`integrations/`、`tools/` 同理——在首个真实文件出现前不建空目录、不放 `.gitkeep`。
- 不启用 npm workspaces。