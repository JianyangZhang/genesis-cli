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
- **Automatic initialization**
  - If the file does not exist yet, `genesis` creates the directory and a starter template automatically
  - If it already exists, the CLI leaves your current file untouched
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
  - `GENESIS_BOOTSTRAP_BASE_URL`: provider bootstrap base URL
  - `GENESIS_BOOTSTRAP_API`: bootstrap transport, typically `openai-completions`
  - `GENESIS_MODEL_PROVIDER` / `GENESIS_MODEL_ID`: default provider and model
- **Optional project-level overrides**
  - `.genesis/settings.json`
  - `.genesis/settings.local.json`
  - `.genesis-local/agent/models.json`
- **Current precedence (highest -> lowest)**
  1. CLI flags
  2. shell environment variables
  3. project `.genesis/settings.local.json`
  4. project `.genesis/settings.json`
  5. `env` from `~/.genesis-cli/settings.json`
  6. local agent config under `--agent-dir`

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
- `npm run test:live:pi-mono`: live integration check; requires a valid API key in `.env.local`

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
