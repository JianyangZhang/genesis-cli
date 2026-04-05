# Genesis CLI

**An open-source coding CLI that combines a layered pi-agent kernel with a Claude-Code-inspired product runtime.**

[中文版](README.zh.md)

---

## What It Is

Genesis is built for real repository work (not contrived examples): plan, review, change, verify.

The architecture is the point:

- a **vendored kernel** (pi-agent lineage) that stays small, explicit, and interface-agnostic
- a **product runtime** that turns raw agent capability into a controlled user experience

Genesis is inspired by Claude Code’s product-layer design, but it is not a code clone. The goal is a maintainable system with clearer boundaries and stronger governance.
The exact package layout is intentionally documented in the technical plan rather than overloaded into the project homepage.

---

## Quick Start

### For Users (Interactive TUI)

Clone and start the interactive TUI:

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
- `GENESIS_API_KEY` is set in `.env.local`

Startup success signal:

- A `Genesis CLI` welcome card is rendered and the prompt `genesis> ` is shown.

Quick verification:

- Type `/help` and confirm the command list is printed.
- Exit by typing `/exit` (or `/quit`).

Keyboard and scrolling:

- `↑` / `↓`: cycle local input history in the `genesis> ` prompt.
- `←` / `→` / `Home` / `End`: move the cursor inside the current input line.
- Mouse wheel / trackpad scroll: use your terminal's native scrollback to browse prior transcript output.
- `PageUp` / `PageDown`: follow your terminal's native scrollback behavior.
- Interactive mode stays on the primary terminal buffer, so the transcript remains visible after `/exit`.

Exit flow:

- `/exit`, `/quit`, or idle `Ctrl+C` closes the TUI, restores mouse/raw-mode terminal state, and returns control to the shell immediately.
- `Ctrl+C` aborts the active turn instead of exiting when a response is in progress.
- `Ctrl+C` denies the current permission prompt when approval is pending.

### For Developers

#### Tests / 测试

Unit tests:

```bash
npm test
```

Focused TUI regression suite:

```bash
npm run test:tui
```

Expected: Vitest prints a summary and exits with code 0.

Type checks:

```bash
npm run check:types
```

Expected: exit code 0.

Integration test (requires a valid API key in `.env.local`):

```bash
npm run test:live:pi-mono
```

Expected: Vitest prints a summary and exits with code 0.

Lint and formatting:

```bash
npm run check:lint
npm run check:format
```

Expected: exit code 0.

All checks:

```bash
npm run check
```

Expected: exit code 0.

Test reports and coverage:

- Report: Vitest prints the result summary to stdout.
- Coverage: TODO: add a Vitest coverage provider and a `test:coverage` script.

---
## Why This Architecture Works

Genesis is structured so the kernel can remain well-scoped while the product layer evolves quickly.

### 1) A Well-Scoped, Vendored pi-agent Kernel

The kernel is kept inside this repository (not hidden behind an external SDK boundary), and focuses on core primitives:

- agent session lifecycle, streaming, and event emission
- model/provider registries and auth storage
- built-in tools and a stable session surface

This makes the “agent core” reviewable, testable, and reusable across interfaces.

### 2) A Product Runtime That Doesn’t Leak Internals

The product runtime sits above the kernel and enforces a stable contract:

- **normalized runtime events** (raw upstream events are never exposed)
- **tool governance** as code: risk classification, permission decisions, audit logging, mutation queueing
- **planning and subagent contracts**: scoped file access, verification requirements, stop conditions

Different interfaces can render the same runtime semantics without re-implementing governance.

---

## What You Get Today

- one runtime powering multiple modes: `Interactive`, `Print`, `JSON`, `RPC`
- explicit permission gating and audit trails for tool execution
- OpenAI-compatible provider path for real model integration, plus a provider registry for expansion
- a product-layer event pipeline designed for “workbench” UIs (terminal today, hosts later)

---

## Extending Genesis

- add a tool: define the contract, classify risk, enforce permission + audit
- add a provider/model: register it once, consume it from any interface
- add an interface: consume normalized events and render a mode without forking semantics
- add product commands: keep UX logic out of the kernel

---

## Local Development

Useful commands:

```bash
npm run build --workspaces
npm test
npm run chat:live -- --mode print
npm run test:live:pi-mono
```

Local secrets are intentionally kept out of version control. Copy `.env.example` to `.env.local` and fill `GENESIS_API_KEY` (and optionally endpoint overrides).

---


- High-level package docs: `packages/*/README.md`
- ADRs and runbooks: `docs/` (work in progress)

---

## Configuration

Environment variables:

- `GENESIS_API_KEY`: API key used by OpenAI-compatible providers.
- `GENESIS_MODEL_PROVIDER`: provider key (e.g. `zai`). TODO: list supported providers.
- `GENESIS_MODEL_ID`: model id (e.g. `glm-5.1`). TODO: list supported models.

CLI flags:

- `--cwd <path>`: set the working directory.
- `--agent-dir <path>`: set the agent directory (models/auth/session storage).
- `--mode <interactive|print|json|rpc>`: select runtime mode.
- `--provider <id>` / `--model <id>`: override the model selection.
- `--tools <csv>`: override enabled tools.

TODO: document the complete configuration matrix (agent/project config files, env vars, CLI flags) and their precedence.
