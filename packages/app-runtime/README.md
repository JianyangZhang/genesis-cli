# @genesis-cli/runtime

## 职责

产品层运行时。围绕 `pi-coding-agent` 构建 facade，管理会话（SessionFacade）、运行时上下文（RuntimeContext）、计划执行协议和事件标准化。所有 CLI 模式共享此 runtime。

## 导出

### 入口

- `createAppRuntime(config)` — 运行时工厂入口，返回 `AppRuntime`
- `AppRuntime` — 提供 `createSession()`、`recoverSession()`、`shutdown()` 和全局事件总线

### 会话管理

- `SessionFacade` — 会话外观接口，封装 prompt/continue/abort/close 生命周期
- `SessionFacadeImpl` — SessionFacade 的实现类
- `createInitialSessionState()` — 创建初始会话状态
- `recoverSessionState()` / `serializeForRecovery()` — 会话恢复与序列化

### 上下文

- `RuntimeContext` — 不可变执行上下文（sessionId, cwd, mode, model, toolSet, taskState）
- `createRuntimeContext()` — 上下文工厂

### 事件体系

- `EventBus` — 类型化事件总线（`on`/`onCategory`/`emit`/`off`/`removeAllListeners`）
- `RuntimeEvent` — 18 种标准化产品层事件的联合类型，6 个分类：
  - `session` — 会话生命周期（created/resumed/suspended/closing/closed）
  - `tool` — 工具执行（started/update/completed/denied）
  - `plan` — 计划进度（created/step_started/step_completed/completed）
  - `compaction` — 上下文压缩（started/completed）
  - `permission` — 权限判定（requested/resolved）
  - `text` — 文本流（text_delta/thinking_delta）

### 适配层

- `KernelSessionAdapter` — 上游 pi-mono 会话桥接接口
- `RawUpstreamEvent` — 上游原始事件信封
- `EventNormalizer` — raw event → RuntimeEvent 标准化翻译器

### 计划类型（P2 仅类型，引擎在 P4）

- `PlanSummary`、`PlanStep`、`PlanStatus`

## 依赖方向

- 依赖: 无（本项目叶子节点）
- 被依赖: `app-tools`, `app-ui`, `app-extensions`, `app-evaluation`, `app-cli`

## 禁止事项

- 不渲染 UI
- 不实现具体工具逻辑
- 不直接暴露上游零散事件，统一标准化后导出

## 内部结构

```
src/
├── index.ts                    # 主 barrel 导出
├── create-app-runtime.ts       # 工厂入口
├── runtime-context.ts          # RuntimeContext 工厂
├── types/index.ts              # 所有公共类型定义
├── domain/index.ts             # 领域类型重导出
├── events/
│   ├── index.ts                # 事件 barrel
│   ├── runtime-event.ts        # 18 种标准化事件定义
│   └── event-bus.ts            # 类型化事件总线
├── session/
│   ├── session-facade.ts       # SessionFacade 实现
│   ├── session-state.ts        # 状态管理纯函数
│   └── session-events.ts       # 会话事件工厂
├── planning/
│   ├── index.ts                # barrel
│   └── plan-types.ts           # 计划类型
├── adapters/
│   ├── index.ts                # barrel
│   └── kernel-session-adapter.ts # 上游适配器接口
├── services/
│   ├── index.ts                # barrel
│   └── event-normalizer.ts     # 事件标准化翻译器
└── test/                       # 测试
    ├── create-app-runtime.test.ts
    ├── session-facade.test.ts
    ├── session-state.test.ts
    ├── runtime-context.test.ts
    ├── event-bus.test.ts
    ├── event-normalizer.test.ts
    └── stubs/
        └── stub-kernel-session-adapter.ts
```

## 验证

- `npx tsc --noEmit` 类型检查通过
- `vitest run` 全部测试通过（51 tests, 6 files）
- `npm run check` lint + format + types 全部通过
