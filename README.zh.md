<p align="center">
  <img src="image/image.png" alt="Genesis CLI 交互式工作台" width="1024">
</p>

# Genesis CLI

**一个同时借鉴 `pi-mono` 与 Claude Code、并以 `pi-agent-core` 为中心收敛微内核边界的开源代码 CLI。**

[查看英文版](README.md)

---

## 快速开始

Genesis 的目标，是成为一个真正像软件搭档一样工作的开源代码 CLI：既有产品野心，也有工程纪律，同时足够务实，能直接进入你每天面对的真实仓库工作流。

### 1. 先配置

- 用户级配置文件：
  - macOS / Linux：`~/.genesis-cli/settings.json`
  - Windows：`%USERPROFILE%/.genesis-cli/settings.json`
- `genesis` 启动时若发现文件不存在，会自动创建目录与模板文件；若已存在，则完全不改

最小示例：

```json
{
  "env": {
    "GENESIS_API_KEY": "your_zhipu_api_key",
    "GENESIS_BOOTSTRAP_BASE_URL": "https://open.bigmodel.cn/api/coding/paas/v4/",
    "GENESIS_BOOTSTRAP_API": "openai-completions",
    "GENESIS_MODEL_PROVIDER": "zai",
    "GENESIS_MODEL_ID": "glm-5.1",
    "GENESIS_MODEL_DISPLAY_NAME": "GLM-5.1"
  }
}
```

常用字段：

- `GENESIS_API_KEY`：模型 API key
- `GENESIS_BOOTSTRAP_BASE_URL`：provider 初始化基地址
- `GENESIS_BOOTSTRAP_API`：初始化协议，通常为 `openai-completions`
- `GENESIS_MODEL_PROVIDER` / `GENESIS_MODEL_ID`：默认 provider 与模型

可选的项目级覆盖：

- `.genesis/settings.json`
- `.genesis/settings.local.json`
- `.genesis-local/pi-agent/models.json`

当前优先级：

- CLI flags
- shell 环境变量
- `~/.genesis-cli/settings.json` 的 `env`
- 项目级 `.genesis/settings.local.json`
- 项目级 `.genesis/settings.json`
- `--agent-dir` 下的本地 agent 配置

### 2. 全局安装

```bash
npm install -g @pickle-pee/genesis-cli@latest
genesis --version
```

如果你是在升级已全局安装过的版本，建议显式带上 `@latest`，避免 npm 继续沿用旧的已安装结果。

### 3. 启动

```bash
genesis
```

预期结果：

- `genesis --version` 输出当前安装的 CLI 版本
- `genesis` 启动交互式工作台
- 全局升级时，`npm install -g @pickle-pee/genesis-cli@latest` 与 `genesis --version` 应该对得上最新发布版本

首次进入后：

- 输入 `/help`，确认 slash 命令列表出现
- 输入 `/exit` 或 `/quit` 退出

交互要点：

- `↑` / `↓`：切换本地输入历史
- `Tab`：在有候选时接受第一个 slash 命令提示
- 鼠标滚轮 / 触摸板：使用终端原生 scrollback 浏览历史对话
- Interactive 模式始终运行在 terminal 主缓冲区中，执行 `/exit` 后仍可翻看历史 transcript
- `/exit`、`/quit` 或空闲时按 `Ctrl+C` 会关闭 TUI 并恢复终端状态
- 助手流式回复期间按 `Ctrl+C` 会先中断当前回合
- 权限确认菜单打开时按 `Ctrl+C` 会拒绝当前请求

---

## 项目定位

- 一套 runtime 同时支撑 `Interactive`、`Print`、`JSON`、`RPC`
- 对齐 Claude 风格的交互式 TUI 主缓冲区体验
- 明确的权限确认流程与结构化工具步骤展示
- 可用于真实联调的 OpenAI-compatible provider 主链
- 由仓库自己掌控、可持续演进的 vendored kernel 与产品层 runtime

---

## 开发

### 本地开发

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

- Node.js 20.0.0+
- `.env.local` 中已经配置可用的 `GENESIS_API_KEY`
- 启动成功后会看到 `Genesis CLI` 欢迎卡片与 `❯ ` 提示符

### 常用检查

```bash
npm test
npm run test:tui
npm run check:types
npm run check
npm run test:live:pi-mono
```

- `test:live:pi-mono` 需要 `.env.local` 中存在可用 API key

### 发布

```bash
npm run version:bump:patch
git add package-lock.json packages/*/package.json
git commit -m "release 0.0.2"
npm run publish:all
```

- 发布脚本位于 `scripts/bump-version.mjs` 与 `scripts/publish-all.sh`
- `publish:check` 会在临时目录里做 runtime adapter 冒烟，防止“离开 monorepo 根目录就启动失败”
- 若 npm 账号开启写操作 2FA，发布时仍可能需要浏览器确认
- 发布后建议用 `npm install -g @pickle-pee/genesis-cli@latest` 和 `genesis --version` 再做一次最终安装验证

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
- ADR 与 runbook：`docs/`
