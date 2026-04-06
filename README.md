<p align="center">
  <img src="image/image.png" alt="Genesis CLI 交互式工作台" width="1024">
</p>

# Genesis CLI

**一个面向工程实践的开源代码 CLI：以分层架构组织 TTY、runtime 与 vendored kernel，并持续优化模块边界与可维护性。**

[View English README](README.en.md)

---

## 快速开始

先配置，再安装，最后启动。

### 1. 配置

- 用户级配置文件：
  - macOS / Linux：`~/.genesis-cli/settings.json`
  - Windows：`%USERPROFILE%/.genesis-cli/settings.json`
- 若文件不存在，`genesis` 会自动创建目录与模板；若已存在，则完全不改
- 最小示例：

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

- `GENESIS_API_KEY`：模型 API key
- `GENESIS_BOOTSTRAP_BASE_URL`：provider 初始化基地址
- `GENESIS_BOOTSTRAP_API`：初始化协议，通常为 `openai-completions`
- `GENESIS_MODEL_PROVIDER` / `GENESIS_MODEL_ID`：默认 provider 与模型

- 可选项目级覆盖：
- `.genesis/settings.json`
- `.genesis/settings.local.json`
- `.genesis-local/pi-agent/models.json`

- 当前优先级：
- CLI flags
- shell 环境变量
- `~/.genesis-cli/settings.json` 的 `env`
- 项目级 `.genesis/settings.local.json`
- 项目级 `.genesis/settings.json`
- `--agent-dir` 下的本地 agent 配置

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
- 交互规则：
  - `↑` / `↓` 切换本地输入历史，`Tab` 接受第一个 slash 命令提示
  - 鼠标滚轮 / 触摸板使用终端原生 scrollback 浏览历史 transcript
  - `Ctrl+C` 在空闲时退出、流式回复时中断当前回合、权限确认时拒绝当前请求

---

## 项目定位

一个面向真实仓库工作流的代码 CLI：统一支撑 `Interactive / Print / JSON / RPC`，提供 Claude 风格 TUI、结构化工具步骤与可真实联调的 provider 主链。

---

## 顶层蓝图

Genesis 采用“薄 UI、厚 contract、仓库自持内核”的结构。

- 分层：
  - `packages/app-cli` 负责进程入口、TTY 生命周期与 interactive mode 宿主
  - `packages/app-ui` 负责 slash commands、picker、formatter 与交互展示
  - `packages/app-runtime` 负责 session facade、事件归一化、governance 与 planning
  - `packages/kernel` 负责 vendored kernel，并继续收敛 `session core` 与 `provider/tools`
  - `pi-agent-core` 负责最小 agent loop 与工具执行原语
- 边界：
  - `app-cli` 只承载终端宿主语义，不承载产品语义
  - `app-ui` 只消费稳定 contract，不处理 transcript 持久化细节
  - `app-runtime` 负责把 kernel 语义映射成产品语义
  - `kernel session core` 负责 transcript persistence、resume、compact、context rebuild、session metadata
  - `kernel provider/tools` 负责模型、鉴权与底层工具接线
- 贡献入口：
  - 改 TTY / 主缓冲区 / interactive 生命周期：看 `app-cli`
  - 改 slash commands / picker / formatter：看 `app-ui`
  - 改 session facade / event normalization / governance：看 `app-runtime`
  - 改 transcript / resume / compact / recovery snapshot：看 `kernel session core`
  - 改 provider / auth / tool wiring：看 `kernel provider/tools`
- 当前主线：
  - 不继续堆命令，先拉直 `session core` 边界
  - 已完成 `/resume` 预览、`/compact` 最小主链、`SessionRecoveryData.metadata`
  - 后续继续收敛 `session-manager`、恢复协议与跨层兜底逻辑

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

### 调试与日志

```bash
genesis --debug
genesis -d
```

- 正式包与本地源码都支持 `--debug / -d`
- 启动后会在标准错误输出 `trace-id` 与日志目录；Interactive 模式也会在历史缓冲区显示 `Debug trace: ...`
- 日志目录固定为 `~/.genesis-cli/debug-logs/<trace-id>/`
- 反馈问题时请尽量附上：
  - 复现步骤
  - `trace-id`
  - 对应目录下的 `runtime.jsonl`、`error.jsonl`、`crash.jsonl`
- 日志格式为 JSONL，每行一条结构化记录，核心字段包括：
  - `timestamp`
  - `level`
  - `traceId`
  - `pid`
  - `scope`
  - `message`
  - `data`
- 日志级别策略：
  - 默认模式：`runtime.jsonl` 仅记录 `ERROR` 及以上
  - `--debug`：`runtime.jsonl` 记录 `DEBUG` 及以上
  - `error.jsonl` 始终记录错误与崩溃
  - `crash.jsonl` 仅记录未处理异常、未处理拒绝与致命故障
- 落盘采用异步写入；若日志目录无权限或写盘失败，会降级到标准错误输出，但不会额外打崩主程序

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
- 顶层源码入口：`packages/app-cli`、`packages/app-ui`、`packages/app-runtime`、`packages/kernel`
- 关键验证入口：`npm test`、`npm run test:tui`、`npm run build`
