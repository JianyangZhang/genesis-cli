# Session Source Of Truth 草案

## 1. 目标

本文件用于把 P0-2 落成一个可执行约束：

- `sessionFile` 是底层会话事实源
- `recent-session` 是面向产品体验的投影索引
- runtime 可以增量维护投影，但不能长期背离 `sessionFile`

## 2. 分层定义

### 2.1 底层事实源

`sessionFile` 负责承载会话事实，包括：

- session 标题
- transcript 顺序
- message 角色与内容
- compaction 相关记录
- 后续可扩展的 session 元数据

### 2.2 产品投影

`~/.genesis-cli/sessions/recent.json` 与 `entries/*.json` 负责承载：

- 最近访问排序
- UI 友好的 title / snippet / summary
- 搜索索引
- resume browser 展示优化字段

投影允许缓存，但不应成为新的事实源。

## 3. 当前执行约束

- [x] 当 `recordRecentSession()` 传入 `metadata: null` 且存在 `sessionFile` 时，必须重新从 `sessionFile` 刷新元数据
- [x] runtime recent entry 的 `summary` / `firstPrompt` / `recentMessages` 必须优先反映 `sessionFile`
- [x] `resumeSummary.source === "model"` 的模型摘要允许作为投影增强保留
- [ ] compaction / title rename / branch 等更丰富的 session 事件仍需回收到统一 session core

## 4. 当前已补护栏

- `packages/app-runtime/src/test/create-app-runtime.test.ts`
  - 覆盖“首次从 `sessionFile` 注入 metadata”
  - 覆盖“已有 recent entry 时，再次记录仍会从 `sessionFile` 刷新”

## 5. 下一步

- [ ] 抽离 `session metadata` 的稳定 schema
- [ ] 明确 recent entry 中哪些字段允许 runtime 增量写入
- [ ] 让 `/resume` 浏览与恢复链路只依赖一个清晰的 recovery contract
