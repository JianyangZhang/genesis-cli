<p align="center">
  <img src="image/image.png" alt="Genesis CLI 交互式工作台" width="1024">
</p>

# Genesis CLI

**一个面向工程实践的开源代码 CLI：以分层架构组织 TTY、runtime 与 vendored kernel，并持续优化模块边界与可维护性。**

[View English README](README.en.md)

---

## 快速开始

最小路径：先配置，再安装，再启动。

### 1. 配置

- **用户级配置文件**
  - macOS / Linux：`~/.genesis-cli/settings.json`
  - Windows：`%USERPROFILE%/.genesis-cli/settings.json`
- **最小示例**

```json
{
  "env": {
    "GENESIS_API_KEY": "your_zhipu_api_key",
    "GENESIS_BOOTSTRAP_BASE_URL": "https://open.bigmodel.cn/api/coding/paas/v4/",
    "GENESIS_BOOTSTRAP_API": "openai-completions",
    "GENESIS_MODEL_PROVIDER": "zai",
    "GENESIS_MODEL_ID": "glm-5.1"
  }
}
```

- **关键字段**
  - `GENESIS_API_KEY`：模型 API key
  - `GENESIS_MODEL_PROVIDER`：可选；未显式指定时使用默认 provider
  - `GENESIS_MODEL_ID`：模型 ID；interactive 模式下为空会在启动自检时报错
- **可选项目级覆盖**
  - `.genesis/settings.json`
  - `.genesis/settings.local.json`
- 默认情况下，Genesis 会优先读取你的 shell 环境变量和 `~/.genesis-cli/settings.json`；项目内覆盖仅在需要时再加。

### 2. 安装

```bash
npm install -g @pickle-pee/genesis-cli@latest
genesis --version
```

### 3. 启动

```bash
genesis
```

- `genesis --version` 输出当前安装的 CLI 版本
- `genesis` 启动交互式工作台
- 首次进入可先执行 `/help`，退出用 `/exit` 或 `/quit`
- `/resume` 会打开最近会话浏览器：输入关键字过滤，`Enter` 打开选中会话，`Ctrl+V` 切换 preview
- 交互规则：
  - `↑` / `↓` 切换本地输入历史，`Tab` 接受第一个 slash 命令提示
  - 鼠标滚轮 / 触摸板使用终端原生 scrollback 浏览历史 transcript
  - `Ctrl+C` 在空闲时退出、流式回复时中断当前回合、权限确认时拒绝当前请求

---

## 项目定位

Genesis 面向真实仓库工作流，统一支撑 `Interactive / Print / JSON / RPC`，并围绕 Claude 风格 TUI、结构化工具步骤与可真实联调的 provider 主链持续演进。

---

## 顶层蓝图

Genesis 采用“终端宿主 / 内容语义 / 运行时契约 / 仓库自持内核”分层，首页只保留贡献者最需要的四类信息：分层、边界、入口与当前主线。

- 分层：
  - `packages/app-cli` 负责进程入口、TTY 生命周期、debug 接线与 interactive mode 宿主
  - `packages/app-tui-core` 负责终端能力探测、mode lifecycle、screen frame、patch diff、composer/layout 等渲染内核
  - `packages/app-ui` 负责 slash commands、resume browser、formatter、interactive theme、footer 内容准备与交互展示语义
  - `packages/app-runtime` 负责 session facade、事件归一化、recent sessions、governance 与 planning
  - `packages/app-tools` 负责工具 catalog、风险分级、权限策略、命令分类与审计
  - `packages/kernel` 负责 vendored kernel、provider 接线与上游 session plumbing
  - `packages/app-config`、`packages/app-extensions`、`packages/app-evaluation` 作为配套包补齐配置、扩展与评估能力
- 边界：
  - `app-cli` 只承载宿主与接线，不承载产品文案、主题常量与布局语义
  - `app-tui-core` 只负责终端物化与渲染规则，不负责 slash command 或业务语义
  - `app-ui` 负责“显示什么”，不负责 TTY 生命周期或 transcript 持久化
  - `app-runtime` 负责把 kernel/upstream 语义映射成稳定产品契约
  - `app-tools` 负责工具治理与权限决策，不负责 UI 渲染
  - `kernel` 负责 provider、模型、底层会话主链，不直接承担 CLI 体验层
- 贡献入口：
  - 改 TTY 宿主、interactive 生命周期、debug banner：看 `app-cli`
  - 改终端 frame、patch、cursor、footer/composer 布局：看 `app-tui-core`
  - 改 slash commands、resume browser、formatter、footer 内容：看 `app-ui`
  - 改 session facade、event normalization、recent sessions、planning：看 `app-runtime`
  - 改权限、风险、命令分类、审计：看 `app-tools`
  - 改 provider、auth、底层 session plumbing：看 `kernel`
- 当前主线：
  - 继续把 interactive 渲染规则沉到 `app-tui-core`
  - 继续把内容语义从 `app-cli` 回收到 `app-ui`
  - 明确 `recent-session` 的 metadata 权威源：`kernel/session file` 优先，`app-runtime` 只负责 catalog 聚合与 fallback
  - 继续把 `/resume` 收敛为 `app-runtime` 提供结构化摘要、`app-ui` 负责展示语义、`app-cli` 只负责 TTY 接线的稳定主链
  - 旧 ANSI/TUI 导出已收口到兼容命名空间，仅用于过渡兼容，不再作为主链能力入口
  - 保持 `app-runtime` 与 `app-tools` 的稳定契约，并为复杂链路同步补齐 `--debug` 可观测性

---

## 开发

开发部分只保留四类高频信息：本地启动、调试反馈、提交前检查与发布入口。

### 本地开发

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

- 前提：Node.js 20.0.0+，且 `.env.local` 中已配置可用的 `GENESIS_API_KEY`
- 默认入口：`npm run chat:live` 会启动 interactive 工作台
- 启动成功：会看到 `Genesis CLI` 欢迎卡片与 `❯ ` 提示符
- 若新增或调整 workspace 包依赖，先执行一次 `npm install`，确保本地 `node_modules` 链接同步
- Debug 启动：

```bash
npm run chat:live -- --debug
# 或
GENESIS_DEBUG=1 npm run chat:live
```

- 说明：源码模式下推荐优先用上面两种方式；都会保留 `.env.local`，并启用 debug 日志

### 调试与日志

```bash
genesis --debug
genesis -d
```

- 入口：正式包与本地源码都支持 `--debug / -d`
- 可见性：启动后会显示本次会话的 `trace-id`
  - 标准错误输出会打印 `trace-id` 与日志目录
  - Interactive 模式会在历史缓冲区显示 `Debug trace: ...`
- 用户级 recent history：
  - `~/.genesis-cli/sessions/recent.json`
  - `~/.genesis-cli/sessions/last.json`
  - `~/.genesis-cli/sessions/entries/<sessionId>.json`
- 新渲染内核额外日志：
  - `tui.capabilities`：终端宿主识别、能力降级结果、mode plan 摘要
  - `tui.render`：frame 尺寸、footer 行数、viewport 行数、patch 统计
- 反馈问题：优先附上复现步骤、`trace-id` 与 `~/.genesis-cli/debug-logs/<trace-id>/` 下的相关日志文件

### 常用检查

```bash
npm test
npm run test:tui
npm run check:types
npm run check
npm run test:live:pi-mono
```

- `npm test`：提交前主测试入口
- `npm run test:tui`：TUI 与交互回归
- `npm run test:live:pi-mono`：真实联调检查（默认走 OpenAI 兼容配置）
- `npm run test:live:pi-mono:openai`：复用 `.env.openai.local` 的 OpenAI-compatible 配置
- `npm run test:live:pi-mono:anthropic`：复用 `.env.anthropic.local` 的 Anthropic-compatible 配置

### 发布

```bash
npm run version:bump:major
git add package-lock.json packages/*/package.json
git commit -m "release 1.0.0"
npm run publish:all
```

- 发布入口：版本号提升后统一通过 `npm run publish:all` 发布
- 发布校验：`publish:check` 会额外做 runtime adapter 冒烟，避免启动隐式依赖 monorepo 根目录
- 发布后验证：建议再用 `npm install -g @pickle-pee/genesis-cli@latest` 与 `genesis --version` 做一次安装验证

### 其他入口

```bash
npm run chat:live -- --mode print
npm run publish:check
npm run publish:packages
npm run publish:verify
```

---

## 更多说明

- 包级文档：`packages/*/README.md`
- 源码入口：`packages/app-cli`、`packages/app-tui-core`、`packages/app-ui`、`packages/app-runtime`、`packages/app-tools`、`packages/kernel`
- 验证入口：`npm test`、`npm run test:tui`、`npm run build`

---

## 配置附录

以下仅列出当前代码中**已经支持**、并且会被实际读取的环境变量。

### 核心运行配置

| 变量名 | 是否必填 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `GENESIS_API_KEY` | 是 | 空 | 模型鉴权使用的 API key。 |
| `GENESIS_BOOTSTRAP_BASE_URL` | 是 | 空 | 模型服务的 base URL。 |
| `GENESIS_BOOTSTRAP_API` | 是 | 空 | 请求协议；当前支持 `openai-completions`、`anthropic-messages`。 |
| `GENESIS_MODEL_PROVIDER` | 是 | 空 | 模型所属 provider 名称。 |
| `GENESIS_MODEL_ID` | 是 | 空 | 模型 ID。 |
| `GENESIS_TOOL_SET` | 否 | `read,bash,edit,write` | 默认启用的工具集合，逗号分隔。 |
| `GENESIS_THINKING_LEVEL` | 否 | 空 | 思考强度；支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`。 |
| `GENESIS_DEBUG` | 否 | `false` | 打开 debug 日志；支持布尔值语义，如 `true` / `1`。 |

### 高级 Bootstrap 配置

| 变量名 | 是否必填 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `GENESIS_BOOTSTRAP_API_KEY_ENV` | 否 | `GENESIS_API_KEY` | 读取 API key 时使用的环境变量名。 |
| `GENESIS_BOOTSTRAP_AUTH_HEADER` | 否 | `true`（`anthropic-messages` 时为 `false`） | provider 是否使用 `Authorization` 头。 |
| `GENESIS_BOOTSTRAP_REASONING` | 否 | `thinking != off` 时为 `true`，否则为 `false` | 是否启用 reasoning。 |
| `GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE` | 否 | 空 | provider 兼容性开关：是否支持 developer role。 |
| `GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT` | 否 | 空 | provider 兼容性开关：是否支持 reasoning effort。 |

### 调试与保留策略

| 变量名 | 是否必填 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `GENESIS_RECENT_SESSION_MAX_ENTRIES` | 否 | `10` | 最近对话历史保留数量。`sessionFile` 数量固定为该值加 `5`。 |
| `GENESIS_DEBUG_LOG_MAX_SESSIONS` | 否 | `10` | debug 日志最多保留的最近会话数。 |
| `GENESIS_DEBUG_LOG_RETENTION_DAYS` | 否 | `7` | debug 日志保留天数。 |
