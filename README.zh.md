# Genesis CLI

**一个以分层清晰的 pi-agent 内核为底座，并借鉴 Claude Code 产品层运行时设计的开源 coding CLI。**

[English version](README.md)

---

## 它是什么

Genesis 面向真实仓库工作（非演示性质示例）：计划、审阅、修改、验证。

这个项目的核心在于架构组合：

- 一个保持小而明确的 **vendored 内核**（pi-agent 血统），与界面形态解耦
- 一个能快速演进的 **产品层运行时**，把 agent 能力变成可控、可审阅的体验

Genesis 借鉴了 Claude Code 产品层的关键设计要点，但目标不是照抄代码，而是做成更可维护、边界更清晰、治理更强的版本。
更细的分层和包结构，放在技术方案文档中说明，而不在项目主页里展开实现细节。

---

## 快速开始

### 体验交互式 TUI

把项目下载到本地并启动交互式 TUI：

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

必需条件：

- Node.js 20.0.0+
- 你已在 `.env.local` 中设置 `GENESIS_API_KEY`

启动成功判定：

- 终端渲染 `Genesis CLI` 欢迎卡片，并出现 `genesis> ` 提示符。

快速验证：

- 输入 `/help`，确认命令列表被打印。
- 退出方式：输入 `/exit`（或 `/quit`）。

快捷键与滚动：

- `↑` / `↓`：切换 `genesis> ` 输入框的本地历史。
- `←` / `→` / `Home` / `End`：在当前输入行内移动光标。
- 鼠标滚轮 / 触摸板滚动：浏览上方对话缓冲区，不影响输入框内容。
- `PageUp` / `PageDown`：按页滚动对话历史。

退出流程：

- `/exit`、`/quit`，或空闲时按 `Ctrl+C`，都会关闭 TUI、恢复鼠标与 raw mode 终端状态，并立即把控制权还给 shell。
- 当助手正在回复时，`Ctrl+C` 会先中断当前回合，而不是直接退出。
- 当界面正在等待权限确认时，`Ctrl+C` 会直接拒绝当前权限请求。

### 开发者

#### 测试

单元测试：

```bash
npm test
```

TUI 定向回归：

```bash
npm run test:tui
```

预期：Vitest 输出汇总信息，且进程退出码为 0。

类型检查：

```bash
npm run check:types
```

预期：进程退出码为 0。

集成测试（需要在 `.env.local` 中配置可用 API key）：

```bash
npm run test:live:pi-mono
```

预期：Vitest 输出汇总信息，且进程退出码为 0。

代码检查与格式化：

```bash
npm run check:lint
npm run check:format
```

预期：进程退出码为 0。

全量检查：

```bash
npm run check
```

预期：进程退出码为 0。

测试报告与覆盖率：

- 报告：Vitest 将结果汇总输出到标准输出。
- 覆盖率：TODO: 增加 Vitest 覆盖率能力，并提供 `test:coverage` 脚本。

---
## 为什么这种架构有效

Genesis 的组织方式是：内核保持边界明确，产品层快速迭代。

### 1) 边界明确的 Vendored pi-agent 内核

内核能力被保留在本仓库内部（而不是隐藏在外部 SDK 边界后），专注少而关键的原语：

- agent session 生命周期、流式输出与事件发射
- model/provider registry 与鉴权存储
- 内建工具与稳定的 session 接口

这样“agent 核心”更可审阅、可测试，也能被多种界面复用。

### 2) 不泄露内核细节的产品层运行时

产品层运行时在内核之上提供稳定契约：

- **标准化 runtime events**（不会把上游/raw 事件直接暴露出去）
- **工具治理** 作为一等能力：风险分级、权限决策、审计记录、变更队列
- **计划与 subagent 契约**：路径范围、验证要求、停止条件

不同界面只需要渲染同一套语义，而不是各自重写一套治理逻辑。

---

## 你现在能得到什么

- 一条 runtime 主干支撑多种模式：`Interactive` / `Print` / `JSON` / `RPC`
- 工具执行有明确的权限 gate 与审计轨迹
- OpenAI-compatible 的主集成路径 + 可扩展的 provider registry
- 面向 “workbench” 体验的事件流水线（终端是现在，宿主/IDE 是后续形态）

---

## 如何扩展

- 新增工具：定义契约、风险分级、权限与审计策略
- 新增模型/Provider：注册一次，多种界面复用
- 新增界面：消费标准化事件即可，不需要分叉执行语义
- 新增产品命令：UX 逻辑留在产品层，不侵入内核

---

## 本地开发

常用命令：

```bash
npm run build --workspaces
npm test
npm run chat:live -- --mode print
npm run test:live:pi-mono
```

本地密钥默认不进入版本控制。把 `.env.example` 复制为 `.env.local`，并填入 `GENESIS_API_KEY`（端点配置按需覆盖）。

---

## 文档

- 包级高层说明：`packages/*/README.md`
- ADR 与 runbook：`docs/`（建设中）

---

## 配置

环境变量：

- `GENESIS_API_KEY`：OpenAI-compatible provider 使用的 API key。
- `GENESIS_MODEL_PROVIDER`：provider key（例如 `zai`）。TODO: 补充支持的 provider 列表。
- `GENESIS_MODEL_ID`：model id（例如 `glm-5.1`）。TODO: 补充支持的 model 列表。

CLI 参数：

- `--cwd <path>`：设置工作目录。
- `--agent-dir <path>`：设置 agent 目录（models/auth/session 存储）。
- `--mode <interactive|print|json|rpc>`：选择运行模式。
- `--provider <id>` / `--model <id>`：覆盖模型选择。
- `--tools <csv>`：覆盖启用的工具集合。

TODO: 补齐完整配置矩阵（agent/project 配置文件、环境变量、CLI 参数）及其优先级规则。
