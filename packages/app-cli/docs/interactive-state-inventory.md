# Interactive State Inventory

## Scope

File: `packages/app-cli/src/mode-dispatch.ts`

Purpose: classify interactive states by ownership to reduce cross-layer backflow.

## State Classification

### Host Layer (`app-cli`)

- TTY lifecycle and raw input loop handles (`_inputLoop`, terminal mode toggles)
- Screen region ownership and frame patch flushing (`_screen`, `_renderedFrame`, scroll-region control)
- Signal handling and process-level fail-safe reset

### Experience Layer (`app-ui`)

- Transcript content blocks and rendering intent (`_transcriptBlocks`, message formatting intent)
- Resume browser interaction state (`_resumeBrowser*`, detail panel query/selection)
- Command interpretation state (`local command` parsing and slash behavior input semantics)

### Runtime Layer (`app-runtime`)

- Session lifecycle (`create/recover/close`, busy/idle)
- Permission governance lifecycle and tool execution decisions
- Recent-session persistence and searchable history index

### TUI Materialization Layer (`app-tui-core`)

- Footer composition model
- Cursor placement policy
- Viewport clipping and scroll window math
- Frame diff and patch encoding

## Immediate Migration Targets

- Move non-layout resume browser state transitions from `mode-dispatch` into `app-ui` helper modules.
- Keep `mode-dispatch` as orchestration glue: input routing + runtime calls + screen flush.
- Ensure cursor/footer/viewport calculations stay in `app-tui-core` APIs.

## Legacy ANSI/TUI Exit Plan

Current risk: `app-ui` still exports legacy ANSI/TUI adapters while the new frame/diff path is active.

Exit phases:

1. Freeze legacy adapter feature growth (no new behavior via old ANSI path).
2. Add a usage gate test: interactive mainline must not require legacy renderer imports.
3. Move legacy renderer exports behind an explicit compatibility namespace.
4. After two stable cycles with zero mainline dependency, remove legacy ANSI/TUI exports.
