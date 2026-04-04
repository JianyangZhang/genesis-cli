# @genesis-cli/tools

## 职责

工具治理。定义工具 catalog（identity / contract / policy / executor 四段式模型）、风险分级（L0-L4）、权限策略和执行包装器。

## 导出

- 工具 catalog 类型与注册接口
- 风险分级枚举（L0-L4）
- 权限策略类型
- 工具调用结果类型（成功/失败/拒绝）

## 依赖方向

- 依赖: `app-runtime`
- 被依赖: `app-evaluation`, `app-cli`

## 禁止事项

- 不直接执行工具（编排由 runtime 负责）
- 不包含 UI 逻辑
- 不管理会话状态

## 内部结构

- `domain/` — 工具模型、风险分级、权限标签
- `services/` — catalog 查询、策略判定
- `types/` — 包级公共类型定义

## 验证

- `npx tsc --noEmit` 类型检查通过
