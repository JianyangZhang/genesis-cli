# @pickle-pee/evaluation

## 职责

评测与验收。管理 smoke 场景、协议验证、回归基线和 subagent 交付验收测试。确保从 P1 到 P7 的每个阶段都能被端到端验证。

## 导出

- Smoke 场景定义接口
- 协议验证工具
- 回归基线类型
- Subagent 交付验收接口

## 依赖方向

- 依赖: `app-runtime`, `app-tools`
- 被依赖: `app-cli`（仅在测试/profile 模式下）

## 禁止事项

- 不包含生产运行时逻辑
- 不渲染 UI
- 不管理真实会话

## 内部结构

- `domain/` — 评测模型、验收标准定义
- `services/` — 场景执行、结果比对
- `types/` — 包级公共类型定义
- `test/smoke/` — Smoke 测试场景
- `test/regression/` — 回归测试基线

## 验证

- `npx tsc --noEmit` 类型检查通过
- `npx vitest run` 测试通过
