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

## Quick Start / 快速开始

### Requirements / 环境要求

- 操作系统：macOS 13+ 或 Linux（x86_64/arm64）。Windows 需使用 WSL2。
- Node.js：20.0.0+（`node -v`）
- npm：9.0.0+（`npm -v`）
- Git：2.31.0+（`git --version`）

### Clone / 克隆

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
```

### Install Dependencies / 安装依赖

```bash
npm ci
```

预期：输出中包含形如 `added <number> packages` 的行，且进程退出码为 0。

### Build / 构建

```bash
npm run build
```

预期：进程退出码为 0，且无 TypeScript 诊断输出（不出现 `error TS` 行）。

### Run Locally / 本地运行

该项目是 CLI，不会启动 HTTP 服务。

- 默认端口：不适用
- 访问地址：不适用
- 启动成功判定：终端输出 `Genesis CLI — model:` 横幅，并出现 `genesis> ` 提示符。

配置密钥：

```bash
cp .env.example .env.local
```

预期：无输出，且生成 `.env.local` 文件。

启动交互模式：

```bash
npm run chat:live
```

### Tests / 测试

单元测试：

```bash
npm test
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

测试报告与覆盖率：

- 报告：Vitest 将结果汇总输出到 stdout。
- 覆盖率：TODO: 增加 Vitest 覆盖率 provider，并提供 `test:coverage` 脚本。

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
