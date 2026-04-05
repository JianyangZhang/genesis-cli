<p align="center">
  <img src="image/image.png" alt="Genesis CLI interactive workbench" width="1024">
</p>

# Genesis CLI

**An open-source coding CLI inspired by pi-mono and Claude Code, built around a vendored micro-kernel centered on `pi-agent-core`.**

[Chinese README](README.zh.md)

---

## Quick Start

Genesis is building toward an open-source coding CLI that feels like a real software teammate: ambitious in product vision, disciplined in execution, and practical enough for day-to-day repository work.

### 1. Configure First

- User settings file:
  - macOS / Linux: `~/.genesis-cli/settings.json`
  - Windows: `%USERPROFILE%/.genesis-cli/settings.json`
- When `genesis` starts and this file does not exist yet, it creates the directory and a starter template automatically; if the file already exists, it is left untouched

Minimal example:

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

Common fields:

- `GENESIS_API_KEY`: model API key
- `GENESIS_BOOTSTRAP_BASE_URL`: provider bootstrap base URL
- `GENESIS_BOOTSTRAP_API`: bootstrap transport, typically `openai-completions`
- `GENESIS_MODEL_PROVIDER` / `GENESIS_MODEL_ID`: default provider and model

Optional project-level overrides:

- `.genesis/settings.json`
- `.genesis/settings.local.json`
- `.genesis-local/pi-agent/models.json`

Current precedence:

- CLI flags
- shell environment variables
- `env` from `~/.genesis-cli/settings.json`
- project `.genesis/settings.local.json`
- project `.genesis/settings.json`
- local agent config under `--agent-dir`

### 2. Global Install

```bash
npm install -g @pickle-pee/genesis-cli
genesis --version
```

### 3. Run

```bash
genesis
```

Expected result:

- `genesis --version` prints the installed CLI version
- `genesis` starts the interactive workbench

On first launch:

- run `/help` and confirm slash commands are listed
- exit with `/exit` or `/quit`

Interaction basics:

- `↑` / `↓`: cycle local input history
- `Tab`: accept the first slash-command suggestion when available
- mouse wheel / touchpad: use native terminal scrollback for transcript history
- interactive mode stays on the primary terminal buffer, so the transcript remains visible after `/exit`
- `/exit`, `/quit`, or idle `Ctrl+C` closes the TUI and restores terminal state
- `Ctrl+C` aborts the active turn when a response is streaming
- `Ctrl+C` denies the current permission request when an approval menu is open

---

## Positioning

- one runtime powering `Interactive`, `Print`, `JSON`, and `RPC`
- Claude-like interactive TUI behavior on the primary terminal buffer
- explicit permission prompts and structured tool-step rendering
- OpenAI-compatible provider flow for live model integration
- a repository-owned vendored kernel and product runtime that can evolve together

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

- Node.js 20.0.0+
- a valid `GENESIS_API_KEY` in `.env.local`
- successful startup shows the `Genesis CLI` welcome card and the `❯ ` prompt

### Common Checks

```bash
npm test
npm run test:tui
npm run check:types
npm run check
npm run test:live:pi-mono
```

- `test:live:pi-mono` requires a valid API key in `.env.local`

### Release

```bash
npm run version:bump:patch
git add package-lock.json packages/*/package.json
git commit -m "release 0.0.1"
npm run publish:all
```

- release automation lives in `scripts/bump-version.mjs` and `scripts/publish-all.sh`
- `publish:check` includes a runtime-adapter smoke test from a temporary directory, so startup cannot silently depend on the monorepo root
- npm may still require browser confirmation when the account uses 2FA for writes

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
- ADRs and runbooks: `docs/`
