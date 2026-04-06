<p align="center">
  <img src="image/image.png" alt="Genesis CLI interactive workbench" width="1024">
</p>

# Genesis CLI

**An open-source coding CLI for engineering practice: organized around a layered `TTY / runtime / vendored kernel` architecture, with an ongoing focus on clearer module boundaries and long-term maintainability.**

[查看中文 README](README.md)

---

## Quick Start

Configure first, then install, then run.

### 1. Configure

- User settings file:
  - macOS / Linux: `~/.genesis-cli/settings.json`
  - Windows: `%USERPROFILE%/.genesis-cli/settings.json`
- If the file does not exist yet, `genesis` creates the directory and a starter template automatically; if it already exists, it is left untouched
- Minimal example:

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

- `GENESIS_API_KEY`: model API key
- `GENESIS_BOOTSTRAP_BASE_URL`: provider bootstrap base URL
- `GENESIS_BOOTSTRAP_API`: bootstrap transport, typically `openai-completions`
- `GENESIS_MODEL_PROVIDER` / `GENESIS_MODEL_ID`: default provider and model

- Optional project-level overrides:
- `.genesis/settings.json`
- `.genesis/settings.local.json`
- `.genesis-local/pi-agent/models.json`

- Current precedence:
- CLI flags
- shell environment variables
- `env` from `~/.genesis-cli/settings.json`
- project `.genesis/settings.local.json`
- project `.genesis/settings.json`
- local agent config under `--agent-dir`

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
- interaction rules:
  - `↑` / `↓` cycles local input history, and `Tab` accepts the first slash-command suggestion
  - mouse wheel / touchpad uses native terminal scrollback for transcript history
  - `Ctrl+C` exits when idle, aborts the active turn while streaming, and denies the current permission request when an approval menu is open

---

## Positioning

One coding CLI for real repository workflows: a unified runtime for `Interactive / Print / JSON / RPC`, Claude-like TUI behavior, structured tool steps, and a provider flow that can be exercised in live integration.

---

## Top-Level Blueprint

Genesis follows a "thin UI, rich contracts, repository-owned kernel" structure.

- Layers:
  - `packages/app-cli` owns process entrypoints, the TTY lifecycle, and the interactive mode host
  - `packages/app-ui` owns slash commands, pickers, formatters, and interaction presentation
  - `packages/app-runtime` owns the session facade, event normalization, governance, and planning
  - `packages/kernel` owns the vendored kernel and continues to separate `session core` from `provider/tools`
  - `pi-agent-core` owns the minimal agent loop and tool-call primitives
- Boundaries:
  - `app-cli` hosts the terminal, but does not own product semantics
  - `app-ui` consumes stable contracts, but does not handle transcript persistence details
  - `app-runtime` maps kernel semantics into product semantics
  - `kernel session core` owns transcript persistence, resume, compact, context rebuild, and session metadata
  - `kernel provider/tools` owns model auth, provider integration, and low-level tool wiring
- Where to start:
  - TTY behavior and interactive lifecycle: `app-cli`
  - slash commands, pickers, formatters: `app-ui`
  - session facade, event normalization, governance: `app-runtime`
  - transcript, resume, compact, recovery snapshot: `kernel session core`
  - provider, auth, tool wiring: `kernel provider/tools`
- Current direction:
  - stop adding commands first; keep tightening the `session core` boundary
  - already landed: `/resume` preview, a minimally working `/compact`, and `SessionRecoveryData.metadata`
  - still in progress: `session-manager`, recovery contracts, and removing cross-layer fallback logic

---

## Development

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
- Entry: this starts the interactive workbench by default; see "Other Entry Points" for print mode
- Expected result: successful startup shows the `Genesis CLI` welcome card and the `❯ ` prompt

### Debugging And Logs

```bash
genesis --debug
genesis -d
```

- Entry: both the published `genesis` package and local source builds support `--debug / -d`
- Visibility: startup shows the `trace-id` for the current session
  - stderr prints the `trace-id` and log directory
  - interactive mode shows `Debug trace: ...` in the history buffer
- When reporting a problem, include repro steps, the `trace-id`, and the relevant log files under `~/.genesis-cli/debug-logs/<trace-id>/`

### Common Checks

```bash
npm test
npm run test:tui
npm run check:types
npm run check
npm run test:live:pi-mono
```

- `npm test`: primary verification entry before a commit
- `npm run test:tui`: TUI and interaction regressions
- `npm run test:live:pi-mono`: live integration check; requires a valid API key in `.env.local`

### Release

```bash
npm run version:bump:patch
git add package-lock.json packages/*/package.json
git commit -m "release 0.0.2"
npm run publish:all
```

- Entry: after bumping versions, publish through `npm run publish:all`
- Verification: `publish:check` adds a runtime-adapter smoke test so startup cannot silently depend on the monorepo root
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
- top-level source entry points: `packages/app-cli`, `packages/app-ui`, `packages/app-runtime`, `packages/kernel`
- primary verification commands: `npm test`, `npm run test:tui`, `npm run build`
