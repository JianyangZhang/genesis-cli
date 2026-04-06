# @pickle-pee/tui-core

Terminal rendering core for Genesis CLI.

This package is the foundation for the next-generation interactive workbench.
It owns terminal capability detection, mode lifecycle, screen frame modeling,
and frame diff primitives.

Current scope:

- Detect terminal host families and capability defaults
- Centralize terminal mode enter/exit sequences
- Define screen frame and cursor primitives
- Provide a minimal line-based frame diff model

Non-goals:

- Session/runtime orchestration
- Slash command semantics
- Product-specific layout or copy
- CLI argument parsing
