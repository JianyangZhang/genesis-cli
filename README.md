# Genesis CLI

**A coding CLI project built on `pi-mono`, with a product layer centered on plan execution, tool governance, and agent collaboration.**

[中文版](README.zh.md)

---

## Overview

`Genesis CLI` is an open-source project for a coding CLI that:

- uses [`pi-mono`](https://github.com/badlogic/pi-mono) as its sole runtime kernel
- draws product direction from the workflow quality demonstrated by `Claude Code`
- keeps runtime concerns and product concerns explicitly separated

The repository is currently in the design and setup phase. The main implementation is not available here yet, so this README documents the intended direction, scope, and architectural choices.

---

## Goals

The project is based on three working goals:

- reuse a mature runtime foundation instead of building a second agent loop
- design product-layer capabilities such as planning, permissions, and subagent coordination as explicit systems
- support multiple interfaces on top of one runtime backbone

The general motivation is straightforward: runtime stability and product workflow quality are both important, but they do not need to be implemented in the same layer. `Genesis CLI` uses `pi-mono` for runtime infrastructure and reserves this repository for product behavior and integration design.

---

## Scope

The planned scope of this repository includes:

- plan-driven task execution
- explicit permission and tool-governance policy
- structured subagent task contracts
- shared runtime support for Interactive, Print, JSON, and RPC modes

The project does not aim to clone any upstream tool feature-for-feature. The focus is on clear boundaries, reviewable behavior, and long-term maintainability.

---

## Architecture

### `pi-mono` is the only kernel

This project does not build a second agent loop. Core runtime concerns stay with `pi-mono`, including the agent runtime, model integration, session mechanics, and terminal primitives.

### Product logic lives above the kernel

Planning, permission policy, tool catalog design, subagent contracts, and mode-specific presentation belong to the product layer. This keeps upstream upgrades possible and reduces pressure to fork runtime internals.

### Plans and verification are first-class

For meaningful coding work, "understand -> plan -> modify -> verify -> report" should be a product feature, not an informal prompt habit.

### Permission policy is explicit

Tool execution should be governed by declared policy rather than hidden model behavior. The user should be able to understand what was requested, what was allowed, and what happened.

### One runtime can support multiple interfaces

Interactive TUI, plain-text output, structured JSON, and RPC embedding should reuse the same runtime backbone instead of reimplementing the same logic in parallel.

The current design uses three major layers:

```text
User / IDE / External Process
        |
CLI Modes: Interactive / Print / JSON / RPC
        |
Experience Layer: TUI / Formatter / RPC Adapter
        |
Product Layer: Plan Engine / Permission Policy / Tool Catalog / Subagent Orchestrator
        |
Facade Layer over pi-mono
        |
pi-agent-core / pi-ai / pi-coding-agent / pi-tui
        |
Filesystem / Shell / Git / MCP / LSP
```

The main rule is simple: each capability should have a clear layer boundary. Runtime infrastructure, product orchestration, and user-facing shells should not collapse into one another.

---

## Planned capabilities

### Plan-driven execution

Tasks are expected to move through a visible loop: understand, plan, modify, verify, and report. The intent is to make intermediate reasoning operationally useful rather than purely conversational.

### Tool governance

Each tool is expected to have four explicit parts:

| Dimension | Purpose |
|-----------|---------|
| `identity` | What the tool is |
| `contract` | How it is called and what it returns |
| `policy` | Risk level, confirmation rules, concurrency rules |
| `executor` | How it actually runs |

This makes permission and auditing behavior explicit instead of implicit.

### Subagent protocol

Complex work should be decomposable into structured tasks with fields such as:

- `goal`
- `allowed_paths`
- `verification`
- `stop_conditions`

The purpose is to make delegation reviewable and bounded, especially when multiple agents operate on the same repository.

### Multiple modes on one runtime

The planned interfaces are:

- `Interactive` for daily use
- `Print` for simple CLI output
- `JSON` for automation and CI
- `RPC` for IDEs or other host processes

These are intended to share one runtime and one event model.

---

## Relationship to upstream

[`pi-mono`](https://github.com/badlogic/pi-mono) is treated as an upstream dependency and runtime foundation.

The working assumptions are:

- runtime-level capability should stay upstream where possible
- product-specific behavior should live in this repository
- local integration should prefer facades and adapters over direct dependence on upstream internals

This approach aims to preserve upgradeability while still allowing product-specific iteration.

---

## Status

The repository is in an early stage of development.

- public implementation is not committed yet
- package layout and code skeleton are still being prepared
- current work is focused on repository setup and architecture consolidation

This README should be read as a project overview and architecture note, not as a feature-complete usage guide.
