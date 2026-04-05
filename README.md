<p align="center">
  <img src="image/image.png" alt="Genesis CLI interactive workbench" width="1024">
</p>

# Genesis CLI

**An open-source coding CLI inspired by pi-mono and Claude Code, built around a vendored micro-kernel centered on `pi-agent-core`.**

[Chinese README](README.zh.md)

---

## Overview

Genesis is built for real repository work: understand code, plan changes, execute safely, and verify results.

The project combines two ideas:

- learn from `pi-mono` for kernel shape, session primitives, and runtime discipline
- learn from Claude Code for product experience, command UX, permission flow, and interactive workbench behavior

The implementation boundary is intentionally narrower than either upstream reference:

- the repository owns its own vendored kernel and product runtime
- the kernel is centered on a minimal `pi-agent-core`-based boundary rather than a full external coding-agent stack
- product semantics such as permissions, tool governance, planning, and mode rendering stay in Genesis packages

---

## Quick Start

### Global Install

```bash
npm install -g @pickle-pee/genesis-cli
genesis --version
genesis
```

Expected result:

- `genesis --version` prints the installed CLI version
- `genesis` starts the interactive workbench

### Interactive CLI

```bash
git clone https://github.com/JianyangZhang/genesis-cli.git
cd genesis-cli
npm ci
npm run build
cp .env.example .env.local
npm run chat:live
```

Requirements:

- Node.js 20.0.0+
- a valid `GENESIS_API_KEY` in `.env.local`

Startup success signal:

- the `Genesis CLI` welcome card appears and the prompt `❯ ` is shown

Quick verification:

- run `/help` and confirm that slash commands are listed
- exit with `/exit` or `/quit`

Keyboard and scrolling:

- `↑` / `↓`: cycle local input history
- `←` / `→` / `Home` / `End`: move inside the current input line
- `Tab`: accept the first slash-command suggestion when available
- mouse wheel / touchpad: use native terminal scrollback for transcript history
- `PageUp` / `PageDown`: follow native terminal scrollback behavior
- interactive mode stays on the primary terminal buffer, so the transcript remains visible after `/exit`

Exit behavior:

- `/exit`, `/quit`, or idle `Ctrl+C` closes the TUI and restores terminal state
- `Ctrl+C` aborts the active turn when a response is streaming
- `Ctrl+C` denies the current permission request when an approval menu is open

---

## Architecture

Genesis is designed so the kernel stays small while the product layer evolves quickly.

### Kernel Boundary

The vendored kernel focuses on the execution surface Genesis must control directly:

- session lifecycle and streaming event flow
- provider and model registry boundaries
- auth storage and built-in tool wiring

### Product Runtime

The product runtime turns raw agent capability into a stable user-facing contract:

- normalized runtime events instead of leaking upstream wire formats
- tool governance with permission decisions, audit trails, and mutation control
- planning and subagent contracts with scoped execution rules
- shared semantics across `Interactive`, `Print`, `JSON`, and `RPC`

---

## Current Capabilities

- one runtime powering `Interactive`, `Print`, `JSON`, and `RPC` modes
- Claude-like interactive TUI behavior on the primary terminal buffer
- explicit permission prompts and structured tool-step rendering
- OpenAI-compatible provider flow for live model integration
- a repository-owned kernel boundary that can evolve without depending on a full upstream product stack

---

## Development

### Tests

Unit and workspace regression:

```bash
npm test
```

Focused TUI regression suite:

```bash
npm run test:tui
```

Type checks:

```bash
npm run check:types
```

Live integration test:

```bash
npm run test:live:pi-mono
```

Lint and format checks:

```bash
npm run check:lint
npm run check:format
```

All checks:

```bash
npm run check
```

Notes:

- `test:live:pi-mono` requires a valid API key in `.env.local`
- Vitest currently prints summaries to stdout; coverage reporting is still a TODO

### Local Work

Useful commands:

```bash
npm run build --workspaces
npm test
npm run chat:live -- --mode print
npm run test:live:pi-mono
```

Local secrets stay out of version control. Copy `.env.example` to `.env.local` and fill `GENESIS_API_KEY`.

---

## Documentation

- package-level docs: `packages/*/README.md`
- ADRs and runbooks: `docs/`

---

## Configuration

Environment variables:

- `GENESIS_API_KEY`: API key used by OpenAI-compatible providers
- `GENESIS_MODEL_PROVIDER`: provider key such as `zai`
- `GENESIS_MODEL_ID`: model id such as `glm-5.1`

CLI flags:

- `--cwd <path>`: set the working directory
- `--agent-dir <path>`: set the agent directory for model and auth assets
- `--mode <interactive|print|json|rpc>`: select the runtime mode
- `--provider <id>` / `--model <id>`: override the model selection
- `--tools <csv>`: override the enabled tool set

The full configuration matrix and precedence rules remain to be documented.
