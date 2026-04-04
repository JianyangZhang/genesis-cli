# @anthropic-ai/claude-code-pi-runtime

## 职责

产品层运行时。围绕 `pi-coding-agent` 构建 facade，管理会话（SessionFacade）、运行时上下文（RuntimeContext）、计划执行协议和事件标准化。所有 CLI 模式共享此 runtime。

## 导出

- `createAppRuntime()` — 运行时创建入口（P2 实现）
- `SessionFacade` — 会话管理外观
- `RuntimeContext` — 运行时上下文
- 标准化事件类型
- 计划执行协议类型

## 依赖方向

- 依赖: 无（本项目叶子节点）
- 被依赖: `app-tools`, `app-ui`, `app-extensions`, `app-evaluation`, `app-cli`

## 禁止事项

- 不渲染 UI
- 不实现具体工具逻辑
- 不直接暴露上游零散事件，统一标准化后导出

## 内部结构

- `domain/` — 领域模型（会话、计划、事件），不依赖 UI
- `services/` — 组合 domain 与 adapters 的业务服务
- `adapters/` — 连接上游 `pi-coding-agent` 的适配层
- `types/` — 包级公共类型定义

## 验证

- `npx tsc --noEmit` 类型检查通过
