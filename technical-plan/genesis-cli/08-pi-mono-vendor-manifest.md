# `pi-mono` 内化 Manifest（第一版）

## 1. 目的

本文件作为 P1-4 的起步版本，用来明确：

- Genesis 当前内化了 `pi-mono` 的哪些部分
- 哪些部分没有内化
- 已知偏离是否是有意设计

## 2. 当前映射

| Genesis | `pi-mono` 参考来源 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| `packages/pi-ai` | `packages/ai` | 已内化并裁剪 | 保留统一消息、模型、流式事件等基础抽象，去掉大批 provider SDK 面 |
| `packages/kernel/src/agent-session.ts` | `packages/coding-agent/src/core/agent-session.ts` | 已内化并重组 | 以最小执行内核为目标，移除高层产品能力 |
| `packages/kernel/src/session-manager.ts` | `packages/coding-agent/src/core/session-manager.ts` | 已内化并显著简化 | 从树形 session 管理降为扁平 session file 管理 |
| `packages/kernel/src/provider-registry.ts` | `packages/coding-agent` / `packages/ai` 相关 provider 接线 | 已内化并收缩 | 以 OpenAI-compatible 主链为主，保留 Anthropic 最小兼容 |
| `packages/kernel/src/tools.ts` | `packages/coding-agent` 内建工具链 | 已内化并重组 | 保留 Genesis 当前主链所需工具能力 |

## 3. 未内化范围

- `pi-tui`
- 完整 `pi-coding-agent` 高层产品层
- tree session / branching / navigate tree
- extension runtime / skills / resources 全链
- HTML export 与更丰富的 session productization

## 4. 当前偏离点

- [x] 不直接复用上游完整 coding-agent，而是转为 `kernel + runtime + host` 三层
- [x] 不沿用树形 session manager，而是先使用简化版 `sessionFile`
- [x] 不维持全量 provider 面，先聚焦 OpenAI-compatible 主链
- [ ] 尚未建立逐文件 upstream sync 规则
- [ ] 尚未建立每次升级核查清单

## 5. 下一步

- [ ] 为每个内化文件补 `upstream source` 注记
- [ ] 明确哪些偏离是长期设计，哪些只是阶段性删减
- [ ] 建立升级 `pi-mono` 时的差异审查流程
