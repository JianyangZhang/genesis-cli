# 04 - 教学导览路径

> 目标：把 `genesis-cli` 作为一个可运行、可验证、可讨论取舍的 `Node.js + TypeScript + 分层架构` 教学样板来阅读，而不是把它当成一组零散功能。

---

## 1. 先建立正确预期

这个仓库最适合教学的，不是“如何快速写一个 CLI”，而是以下四类能力：

- 如何把 `CLI 宿主`、`交互体验`、`产品 runtime`、`session kernel` 分层
- 如何在真实历史包袱下做增量重构，而不是从零假设一套完美架构
- 如何用测试保护契约、事实源和跨层边界，而不是只测局部函数
- 如何在 `Interactive / Print / JSON / RPC` 多模式下维持同一套 runtime 语义

因此，阅读方式应该是“先看主链，再看边界，再看演进”，不要一上来陷在某个 formatter 或某个 slash command 细节里。

---

## 2. 推荐阅读顺序

### 第 1 轮：先看定义与全景

1. `00-overview/01-product-definition.md`
2. `00-overview/02-architecture-panorama.md`
3. `00-overview/03-architecture-review-2026-04-09.md`

这一轮只回答三个问题：

- 这个项目到底在解决什么产品问题
- 真实主链现在经过哪些层
- 当前最需要防止的边界漂移是什么

### 第 2 轮：再看仓库分层

1. `01-foundation/02-repository-layout.md`
2. `02-runtime/01-runtime-and-tools.md`
3. `03-experience/02-tui-core-rearchitecture.md`

这一轮重点看：

- `app-cli` 为什么只能做宿主编排，不该长期背展示语义
- `app-ui` 为什么负责交互语义、formatter、resume browser、slash commands
- `app-runtime` 为什么是产品层事实源，而不是命令大杂烩
- `kernel` 为什么必须成为 session contract 的权威承载层

### 第 3 轮：最后看里程碑与演进

1. `04-milestones/README.md`
2. `04-milestones/M1-interactive-workbench.md`
3. `04-milestones/M2-commands-config-session.md`
4. `04-milestones/M3-review-permission-observability.md`

这一轮关注的不是“做了多少功能”，而是：

- 哪些能力是主链能力
- 哪些能力只是兼容层或过渡层
- 每次重构到底消灭了什么维护面

---

## 3. 代码导览主线

### 主线 1：从入口看到完整执行链

按这条链读代码：

1. `packages/app-cli/src/main.ts`
2. `packages/app-cli/src/mode-dispatch.ts`
3. `packages/app-ui/src/index.ts`
4. `packages/app-runtime/src/create-app-runtime.ts`
5. `packages/app-runtime/src/session/session-facade.ts`
6. `packages/app-runtime/src/adapters/pi-mono-session-adapter.ts`
7. `packages/kernel/src/agent-session.ts`
8. `packages/kernel/src/session-contract.ts`

这条链主要回答：

- 请求是如何从宿主层进入 runtime 的
- interactive 模式与其他模式共享了哪些 runtime 语义
- `SessionFacade` 为什么是 tool permission 与 session lifecycle 的收口点
- `kernel` 为什么是 session metadata / session file / transcript 的权威层

### 主线 2：从体验层看“为什么不该把 UI 写死在 CLI 里”

按这条链读代码：

1. `packages/app-ui/src/services/interactive-conversation.ts`
2. `packages/app-ui/src/services/interactive-footer.ts`
3. `packages/app-ui/src/services/interactive-display.ts`
4. `packages/app-tui-core/src/render/interactive-viewport.ts`
5. `packages/app-cli/src/mode-dispatch.ts`

这条链主要回答：

- 展示语义与终端物化为什么是两层
- 为什么 transcript / footer / slash suggestion 的表达应该从宿主层抽走
- 为什么 viewport / cursor / footer row 计算应该收敛到 `app-tui-core`

### 主线 3：从契约测试看“架构不是靠口头保证”

优先看这些测试：

1. `packages/app-runtime/src/test/create-app-runtime.test.ts`
2. `packages/app-runtime/src/test/session-facade.test.ts`
3. `packages/app-runtime/src/test/pi-mono-session-adapter.test.ts`
4. `packages/app-cli/src/test/mode-dispatch.test.ts`

这条链主要回答：

- `recent-session` 的权威 metadata 为什么不能漂
- `resume / compact / close / switch model` 为什么必须围绕同一 session contract 演进
- 为什么“边界不回流”也要写测试护栏

---

## 4. 推荐教学提问顺序

如果把这个仓库用于教学，建议不要直接问“这段代码是什么意思”，而是按下面顺序提问：

1. 这个问题属于哪一层的职责
2. 这条信息的事实源在哪里
3. 这个状态该不该跨层回流
4. 这个抽象是在减少维护面，还是只是在挪代码
5. 如果去掉某一层，系统会失去什么稳定性

只要持续这样追问，学生自然会从“会写函数”转向“会判断边界”。

---

## 5. 三个推荐练习

### 练习 1：追一条 interactive prompt

目标：从用户输入开始，一直追到 session 执行与事件回流。

建议路径：

- `main.ts` -> `mode-dispatch.ts` -> `SessionFacade` -> `PiMonoSessionAdapter` -> `kernel`

完成标准：

- 能说明每一层各自新增了什么语义
- 能说明哪一层绝不应该自己持有 transcript 权威状态

### 练习 2：解释 `/resume` 为什么不是单个命令问题

目标：把 `/resume` 拆成“展示、选择、恢复、元数据、session file”五部分。

完成标准：

- 能说明为什么 picker UI 不等于恢复语义
- 能说明 recent-session metadata 为什么必须有主次事实源

### 练习 3：解释为什么 `mode-dispatch.ts` 曾经会膨胀

目标：识别哪些逻辑原本不该留在 CLI 宿主层。

完成标准：

- 能指出哪些是体验语义
- 能指出哪些是 TTY 物化
- 能指出哪些是 runtime/session contract

---

## 6. 当前教学价值边界

当前仓库已经足够支撑“中大型 Node.js 架构教学”，但教学时应明确三点：

- 它是演进式样板，不是假设历史包袱不存在的洁净 demo
- 它最有价值的内容是边界收敛过程，而不是单个命令技巧
- 读者应以“事实源、职责、护栏测试”为主线，而不是以文件数量或目录层数判断架构优劣

如果按上述路径阅读，这个仓库最适合用来讲：

- 分层架构如何落地到真实 Node.js 工程
- 为什么 runtime contract 比“工具函数拆分”更重要
- 为什么教学样板不应只展示终态，还要展示如何从混乱逐步收口
