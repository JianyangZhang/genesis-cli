# @genesis-cli/extensions

## 职责

扩展系统。承载内建扩展、预留 Bridge 或 IDE 适配、暴露和管理扩展点。扩展点包括自定义工具注册、自定义 Provider 注册和自定义命令注册。

## 导出

- 扩展点注册接口
- 扩展生命周期类型
- Bridge/RPC 适配预留接口

## 依赖方向

- 依赖: `app-runtime`, `app-config`
- 被依赖: `app-cli`

## 禁止事项

- 不包含核心业务逻辑
- 不直接管理会话
- 不渲染 UI

## 内部结构

- `domain/` — 扩展模型、扩展点定义
- `services/` — 扩展加载与生命周期管理
- `adapters/` — Bridge/IDE 适配层
- `types/` — 包级公共类型定义

## 验证

- `npx tsc --noEmit` 类型检查通过
