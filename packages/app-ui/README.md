# @genesis-cli/ui

## 职责

体验层。提供交互式 TUI 组件、文本输出格式器和 JSON/RPC 事件格式映射。将 runtime 的标准化事件转换为用户可感知的输出。

## 导出

- TUI 组件接口
- 文本格式化器接口
- JSON/RPC 事件映射器
- 输出模式类型

## 依赖方向

- 依赖: `app-runtime`
- 被依赖: `app-cli`

## 禁止事项

- 不包含业务逻辑
- 不实现工具
- 不管理会话状态
- 不泄漏 TUI 专属字段到 JSON/RPC 契约

## 内部结构

- `domain/` — 输出模型、交互状态
- `services/` — 格式化、事件映射
- `adapters/` — 连接上游 `pi-tui` 的适配层
- `types/` — 包级公共类型定义

## 验证

- `npx tsc --noEmit` 类型检查通过
