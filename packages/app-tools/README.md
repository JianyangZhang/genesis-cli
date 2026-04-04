# @genesis-cli/tools

## 职责

工具治理。定义工具 catalog（identity / contract / policy / executor 四段式模型）、风险分级（L0-L4）、权限策略、命令分类、文件变更队列和审计日志。

## 导出

- **类型**: `ToolDefinition`, `ToolContract`, `ToolPolicy`, `ToolIdentity`, `ToolCategory`, `RiskLevel`, `ToolResultStatus`, `PermissionContext`, `PermissionDecision`, `CommandClass`, `CommandPolicy`, `AuditEntry`, `MutationTarget`, `McpServerDescriptor`, `McpToolEntry` 等
- **工厂**: `createToolCatalog()`, `createPermissionEngine()`, `createMutationQueue()`, `createAuditLog()`
- **工具函数**: `classifyRisk()`, `isDestructiveCommand()`, `classifyCommand()`, `createCommandPolicy()`

## 依赖方向

- 依赖: `app-runtime`
- 被依赖: `app-evaluation`, `app-cli`

## 禁止事项

- 不直接执行工具（编排由 runtime 负责）
- 不包含 UI 逻辑
- 不管理会话状态

## 内部结构

- `types/` — 包级公共类型定义（四段式模型、权限、命令、审计、变更、MCP）
- `catalog/` — 工具注册表（ToolCatalog）
- `policy/` — 权限引擎（PermissionEngine）、风险分级（classifyRisk）、命令分类（classifyCommand）
- `mutation-queue/` — 文件变更队列（MutationQueue）
- `audit/` — 审计日志（AuditLog）
- `domain/` — 领域类型 barrel
- `services/` — 服务工厂 barrel

## 验证

- `npx tsc --noEmit` 类型检查通过
- `npx vitest run` 全部测试通过
