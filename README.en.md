<p align="center">
  <img src="image/image.png" alt="Genesis CLI interactive workbench" width="1024">
</p>

# Genesis CLI

**An open-source coding CLI for engineering practice: organized around a layered `TTY / runtime / vendored kernel` architecture, with an ongoing focus on clearer module boundaries and long-term maintainability.**

[查看中文 README](README.md)

---

## Quick Start

Minimal path: configure, install, then run.

### 1. Configure

- **User settings file**
  - macOS / Linux: `~/.genesis-cli/settings.json`
  - Windows: `%USERPROFILE%/.genesis-cli/settings.json`
- **Minimal example**

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

- **Key fields**
  - `GENESIS_API_KEY`: model API key
  - `GENESIS_MODEL_PROVIDER`: optional; defaults to the built-in provider when omitted
  - `GENESIS_MODEL_ID`: model ID; interactive startup checks fail when it is empty
- **Optional project-level overrides**
  - `.genesis/settings.json`
  - `.genesis/settings.local.json`
- By default, Genesis reads your shell environment variables and `~/.genesis-cli/settings.json`; add project overrides only when you actually need them.

### 2. Install

```bash
npm install -g @pickle-pee/genesis-cli@latest
genesis --version
```

### 3. Run

```bash
genesis
```

- `genesis --version` prints the installed CLI version
- `genesis` starts the interactive workbench
- on first launch, start with `/help`; exit with `/exit` or `/quit`
- `/resume` opens the recent-session browser: type to filter, press `Enter` to open the selected session, and use `Ctrl+V` to toggle preview
- interaction rules:
  - `↑` / `↓` cycles local input history, and `Tab` accepts the first slash-command suggestion
  - mouse wheel / touchpad uses native terminal scrollback for transcript history
  - `Ctrl+C` exits when idle, aborts the active turn while streaming, and denies the current permission request when an approval menu is open

---

## Positioning

Genesis is built for real repository workflows, with one runtime for `Interactive / Print / JSON / RPC` and a steady focus on Claude-like TUI behavior, structured tool steps, and a provider flow that can be exercised in live integration.

---

## Top-Level Blueprint

Genesis follows a layered "terminal host / content semantics / runtime contracts / repository-owned kernel" structure. This section keeps only the four things contributors need most: layers, boundaries, entry points, and the current direction.

- Layers:
  - `packages/app-cli` owns process entrypoints, the TTY lifecycle, debug wiring, and the interactive mode host
  - `packages/app-tui-core` owns terminal capability detection, mode lifecycle, screen frames, patch diffs, and composer/layout rendering primitives
  - `packages/app-ui` owns slash commands, the resume browser, formatters, footer content preparation, and interaction semantics
  - `packages/app-runtime` owns the session facade, event normalization, recent sessions, governance, and planning
  - `packages/app-tools` owns the tool catalog, risk classification, permission policy, command classification, and audit support
  - `packages/kernel` owns the vendored kernel, provider integration, and upstream session plumbing
  - `packages/app-config`, `packages/app-extensions`, and `packages/app-evaluation` fill in configuration, extension, and evaluation support
- Boundaries:
  - `app-cli` hosts and wires the terminal, but does not own product copy or layout semantics
  - `app-tui-core` owns terminal materialization and rendering rules, but not slash-command or product semantics
  - `app-ui` decides what to show, but not TTY lifecycle or transcript persistence
  - `app-runtime` maps kernel/upstream semantics into stable product contracts
  - `app-tools` owns tool governance and permission decisions, but not UI rendering
  - `kernel` owns providers, models, and the low-level session pipeline, but not the CLI experience layer
- Where to start:
  - TTY host behavior, interactive lifecycle, debug banners: `app-cli`
  - frame/patch/cursor/footer/composer rendering: `app-tui-core`
  - slash commands, resume browser, formatters, footer content: `app-ui`
  - session facade, event normalization, recent sessions, planning: `app-runtime`
  - permissions, risk, command classification, audit: `app-tools`
  - provider, auth, low-level session plumbing: `kernel`
- Current direction:
  - keep moving interactive rendering rules into `app-tui-core`
  - keep moving content semantics out of `app-cli` and back into `app-ui`
  - keep refining `/resume` into a stable chain where `app-runtime` provides structured summaries, `app-ui` owns presentation semantics, and `app-cli` stays focused on TTY wiring
  - keep `app-runtime` and `app-tools` contracts stable, and add `--debug` observability alongside every complex workflow

---

## Development

The development section keeps four high-frequency topics together: local startup, debug feedback, pre-commit checks, and release entry points.

### Local Work

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

- Prerequisites: Node.js 20.0.0+ and a valid `GENESIS_API_KEY` in `.env.local`
- Default entry: `npm run chat:live` starts the interactive workbench
- Expected result: successful startup shows the `Genesis CLI` welcome card and the `❯ ` prompt
- If you add or change workspace package dependencies, run `npm install` once so local `node_modules` links stay in sync

### Local Debug Startup

```bash
npm run chat:live -- --debug
# or
GENESIS_DEBUG=1 npm run chat:live
```

- Both forms keep `.env.local` in effect and enable debug logging for local source runs

### Debugging And Logs

```bash
genesis --debug
genesis -d
```

- Entry: both the published `genesis` package and local source builds support `--debug / -d`
- Visibility: startup shows the `trace-id` for the current session
  - stderr prints the `trace-id` and log directory
  - interactive mode shows `Debug trace: ...` in the history buffer
- User-level recent history:
  - `~/.genesis-cli/sessions/recent.json`
  - `~/.genesis-cli/sessions/last.json`
  - `~/.genesis-cli/sessions/entries/<sessionId>.json`
- Extra logs from the new rendering core:
  - `tui.capabilities`: terminal host detection, downgraded capability decisions, and mode-plan summary
  - `tui.render`: frame size, footer rows, viewport rows, and patch counts
- Problem reports: include repro steps, the `trace-id`, and the relevant log files under `~/.genesis-cli/debug-logs/<trace-id>/`

### Common Checks

```bash
npm test
npm run test:tui
npm run check:types
npm run check
npm run test:live:pi-mono
```

- `npm test`: primary pre-commit verification entry
- `npm run test:tui`: TUI and interaction regressions
- `npm run test:live:pi-mono`: live integration check (defaults to the OpenAI-compatible config)
- `npm run test:live:pi-mono:openai`: uses the OpenAI-compatible config from `.env.openai.local`
- `npm run test:live:pi-mono:anthropic`: uses the Anthropic-compatible config from `.env.anthropic.local`

### Release

```bash
npm run version:bump:major
git add package-lock.json packages/*/package.json
git commit -m "release 1.0.0"
npm run publish:all
```

- Release entry: after bumping versions, publish through `npm run publish:all`
- Release verification: `publish:check` adds a runtime-adapter smoke test so startup cannot silently depend on the monorepo root
- After publish: verify the installed CLI again with `npm install -g @pickle-pee/genesis-cli@latest` and `genesis --version`

### Other Entry Points

```bash
npm run chat:live -- --mode print
npm run publish:check
npm run publish:packages
npm run publish:verify
```

---

## More

- package-level docs: `packages/*/README.md`
- source entry points: `packages/app-cli`, `packages/app-tui-core`, `packages/app-ui`, `packages/app-runtime`, `packages/app-tools`, `packages/kernel`
- verification entry points: `npm test`, `npm run test:tui`, `npm run build`

---

## Configuration Appendix

Only environment variables that are **actually supported and read by the current code** are listed below.

### Core Runtime Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GENESIS_API_KEY` | Yes (real requests / live tests) | empty | API key used for model authentication. |
| `GENESIS_BOOTSTRAP_BASE_URL` | No | `https://open.bigmodel.cn/api/coding/paas/v4/` | Base URL used when bootstrap writes `models.json`; live tests also reuse it. |
| `GENESIS_BOOTSTRAP_API` | No | `openai-completions` | Protocol used by bootstrap and live tests; currently supports `openai-completions` and `anthropic-messages`. |
| `GENESIS_MODEL_PROVIDER` | No | `zai` | Provider name for the selected model. If not explicitly configured, the internal default is used. |
| `GENESIS_MODEL_ID` | Yes (interactive startup requires a non-default source) | `glm-5.1` | Model ID. There is still an internal fallback, but interactive startup checks require it not to come only from the built-in default source. |
| `GENESIS_TOOL_SET` | No | `read,bash,edit,write` | Default enabled tool set, as a comma-separated list. |
| `GENESIS_THINKING_LEVEL` | No | empty | Thinking level; supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `GENESIS_DEBUG` | No | `false` | Enables debug logging; accepts boolean-like values such as `true` and `1`. |

### Advanced Bootstrap Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GENESIS_BOOTSTRAP_API_KEY_ENV` | No | `GENESIS_API_KEY` | Environment variable name written into `models.json` for API key lookup. |
| `GENESIS_BOOTSTRAP_AUTH_HEADER` | No | `true` (`false` for `anthropic-messages`) | Whether the provider uses the `Authorization` header. |
| `GENESIS_BOOTSTRAP_REASONING` | No | `true` when `thinking != off`, otherwise `false` | `reasoning` flag written during bootstrap model generation. |
| `GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE` | No | empty | Provider compatibility flag: whether developer role is supported. |
| `GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT` | No | empty | Provider compatibility flag: whether reasoning effort is supported. |

### Debug And Retention

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GENESIS_RECENT_SESSION_MAX_ENTRIES` | No | `10` | Number of recent sessions to retain. `sessionFile` retention is fixed to this value plus `5`. |
| `GENESIS_DEBUG_LOG_MAX_SESSIONS` | No | `10` | Maximum number of debug-log sessions to retain. |
| `GENESIS_DEBUG_LOG_RETENTION_DAYS` | No | `7` | Number of days to retain debug logs. |

### Legacy Compatibility

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GENESIS_OPENAI_BASE_URL` | No | empty | Legacy compatibility variable. It is still read as a fallback for `GENESIS_BOOTSTRAP_BASE_URL`. Prefer `GENESIS_BOOTSTRAP_BASE_URL` for new configs. |
