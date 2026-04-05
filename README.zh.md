<p align="center">
  <img src="image/image.png" alt="Genesis CLI 交互式工作台" width="1024">
</p>

# Genesis CLI

**一个同时借鉴 `pi-mono` 与 Claude Code、并以 `pi-agent-core` 为中心收敛微内核边界的开源代码 CLI。**

[查看英文版](README.md)

---

## 项目简介

Genesis 的目标，是成为一个真正像软件搭档一样工作的开源代码 CLI: 既有产品野心，也有工程纪律，同时足够务实，能直接进入你每天面对的真实仓库工作流。

它组合了两类经验：

- 从 `pi-mono` 借鉴内核边界、会话原语和运行时纪律
- 从 Claude Code 借鉴产品体验、命令交互、权限确认和工作台式终端体验

但它的实现边界比两者都更克制：

- 仓库自己维护 vendored kernel 与产品层 runtime
- 内核围绕最小化的 `pi-agent-core` 微内核边界构建，而不是直接依赖整套外部 coding-agent 产品栈
- 权限、工具治理、计划执行、模式渲染等产品语义保留在 Genesis 自己的包内

---

## 快速开始

### 全局安装

```bash
npm install -g @pickle-pee/genesis-cli
genesis --version
genesis
```

预期结果：

- `genesis --version` 输出当前安装的 CLI 版本
- `genesis` 启动交互式工作台

首次运行验证：

- 输入 `/help`，确认 slash 命令列表出现
- 输入 `/exit` 或 `/quit` 退出

快捷键与滚动：

- `↑` / `↓`：切换本地输入历史
- `←` / `→` / `Home` / `End`：在当前输入行内移动光标
- `Tab`：在有候选时接受第一个 slash 命令提示
- 鼠标滚轮 / 触摸板：使用终端原生 scrollback 浏览历史对话
- `PageUp` / `PageDown`：遵循终端原生 scrollback 行为
- Interactive 模式始终运行在 terminal 主缓冲区中，执行 `/exit` 后仍可翻看历史 transcript

退出行为：

- `/exit`、`/quit` 或空闲时按 `Ctrl+C` 会关闭 TUI 并恢复终端状态
- 助手流式回复期间按 `Ctrl+C` 会先中断当前回合
- 权限确认菜单打开时按 `Ctrl+C` 会拒绝当前请求

---

## 架构说明

Genesis 的核心设计是让内核保持小而清晰，同时让产品层可以快速演进。

### 微内核边界

vendored kernel 只负责必须直接掌控的执行面：

- session 生命周期与流式事件主链
- provider 与 model registry 边界
- 鉴权存储与内建工具接线

### 产品层运行时

产品层运行时负责把原始 agent 能力整理成稳定的用户契约：

- 标准化 runtime event，而不是把上游 wire format 直接暴露给界面
- 工具治理，包括权限决策、审计轨迹和变更控制
- 计划与 subagent 契约，包括路径范围、验证要求和停止条件
- `Interactive`、`Print`、`JSON`、`RPC` 共享同一套语义主干

---

## 当前能力

- 一套 runtime 同时支撑 `Interactive`、`Print`、`JSON`、`RPC`
- 对齐 Claude 风格的交互式 TUI 主缓冲区体验
- 明确的权限确认流程与结构化工具步骤展示
- 可用于真实联调的 OpenAI-compatible provider 主链
- 由仓库自己掌控、可持续演进的内核边界

---

## 开发

### 测试

单元测试与 workspace 回归：

```bash
npm test
```

TUI 定向回归：

```bash
npm run test:tui
```

类型检查：

```bash
npm run check:types
```

在线集成测试：

```bash
npm run test:live:pi-mono
```

Lint 与格式检查：

```bash
npm run check:lint
npm run check:format
```

全量检查：

```bash
npm run check
```

说明：

- `test:live:pi-mono` 需要 `.env.local` 中存在可用 API key
- 当前 Vitest 仅输出结果汇总到标准输出，覆盖率脚本仍待补充

### 本地开发

本地跑仓库：

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

运行前提：

- Node.js 20.0.0+
- `.env.local` 中已经配置可用的 `GENESIS_API_KEY`

启动成功判定：

- 终端出现 `Genesis CLI` 欢迎卡片，并显示 `❯ ` 提示符

常用命令：

```bash
npm run build --workspaces
npm test
npm run chat:live -- --mode print
npm run test:live:pi-mono
```

本地密钥默认不进入版本控制。把 `.env.example` 复制为 `.env.local` 后，填入 `GENESIS_API_KEY` 即可。

### 发布

发布自动化脚本位于 `scripts/bump-version.mjs` 与 `scripts/publish-all.sh`。

版本升级：

```bash
npm run version:bump:patch
```

其他升级方式：

```bash
npm run version:bump:minor
npm run version:bump:major
npm run version:bump:prerelease
```

常用入口：

```bash
npm run publish:check
npm run publish:packages
npm run publish:verify
```

推荐发布流程：

```bash
npm run version:bump:patch
git add packages/*/package.json
git commit -m "release 0.0.1"
npm run publish:all
```

一键发布流程：

```bash
npm run publish:all
```

说明：

- `bump-version.mjs` 会按各包当前版本分别递增，并同步回写内部 `@pickle-pee/*` 依赖版本
- 脚本会在 `check` 和 `publish` 前强制要求 git 工作区干净
- 若任一包版本已经发布过，脚本会直接停止，避免 npm 拒绝覆盖版本
- 如果 npm 账号开启了写操作 2FA，发布时仍可能需要浏览器确认一次

---

## 文档

- 包级说明：`packages/*/README.md`
- ADR 与 runbook：`docs/`

---

## 配置

环境变量：

- `GENESIS_API_KEY`：OpenAI-compatible provider 使用的 API key
- `GENESIS_MODEL_PROVIDER`：provider 标识，例如 `zai`
- `GENESIS_MODEL_ID`：model 标识，例如 `glm-5.1`

命令行参数：

- `--cwd <path>`：设置工作目录
- `--agent-dir <path>`：设置模型与鉴权资产目录
- `--mode <interactive|print|json|rpc>`：选择运行模式
- `--provider <id>` / `--model <id>`：覆盖模型选择
- `--tools <csv>`：覆盖启用的工具集合

完整配置矩阵与优先级规则仍待补充。
