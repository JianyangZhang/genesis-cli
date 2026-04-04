# Genesis CLI

**An open-source coding CLI for real repository work, with explicit planning, tool governance, and agent collaboration.**

[中文版](README.zh.md)

---

## Overview

`Genesis CLI` is an open-source coding CLI project built around a simple idea:

> a strong coding workflow needs both a reliable runtime backbone and a clear product layer.

The project focuses on:

- turning plan -> modify -> verify into a first-class product experience
- making tool use, permissions, and execution behavior explicit and reviewable
- supporting multiple interfaces on top of one shared runtime backbone

Rather than treating coding as a loose prompt loop, `Genesis CLI` aims to make real repository work more structured, inspectable, and repeatable.

---

## Design Direction

The project is guided by a few core principles:

- **One runtime backbone**: interactive, print, structured, and embedded experiences should share the same core execution model
- **Clear product boundaries**: planning, permissions, orchestration, and presentation should not collapse into one layer
- **Operational transparency**: users should be able to understand what was attempted, what was approved, and what actually happened
- **Long-term maintainability**: architecture should stay reviewable as the project grows

---

## What Genesis CLI Tries To Be

`Genesis CLI` is intended to be:

- a serious local coding companion for real repositories
- a foundation for plan-driven execution and controlled tool use
- a runtime that can power more than one interface
- a codebase where advanced workflows remain understandable instead of hidden in prompts

It is not trying to be a feature-for-feature clone of any single upstream tool.

---

## Current Status

The project is active and already has a runnable implementation.

Today, the repository includes:

- a working CLI entry for real conversations
- a shared runtime used across multiple modes
- live validation on the primary model integration path
- product-layer foundations for planning, permissions, and structured execution
- technical documents that describe both the current architecture and the next stage of evolution

The current focus is not a rewrite. It is steady functional progress on a working system, while keeping architectural boundaries sharp.

---

## Modes

The long-term goal is one runtime serving multiple interfaces:

- `Interactive` for day-to-day use
- `Print` for simple terminal output and scripting
- `JSON` for automation and CI
- `RPC` for IDEs and host processes

These modes are expected to differ in presentation, not in core execution semantics.

---

## Project Structure

At a high level, the repository separates:

- runtime foundations
- product orchestration
- tool governance
- interface and presentation layers
- evaluation and future extension boundaries

The exact package layout is intentionally documented in the technical plan rather than overloaded into the project homepage.

---

## Local Development

Useful commands:

```bash
npm run build --workspaces
npm test
npm run chat:live -- --mode print
npm run test:live:pi-mono
```

Local secrets are intentionally kept out of version control. Use `.env.local` for local API keys and endpoint configuration.

---

## Documentation

Detailed design and implementation notes live in `technical-plan/genesis-cli/`.

Those documents are meant to do two things:

- explain the architecture that is actually being built
- record the next steps for configuration, hardening, and agent evolution

---

## Near-Term Focus

The next stage is focused on:

- continuing delivery on the working runtime path
- strengthening configuration and hardening
- expanding verification and regression coverage
- evolving subagent orchestration without blurring system boundaries
