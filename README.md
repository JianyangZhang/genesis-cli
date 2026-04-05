# Genesis CLI

**An open-source coding CLI that combines a clean, layered pi-agent kernel with a Claude-Code-inspired product runtime.**

[中文版](README.zh.md)

---

## What It Is

Genesis is built for real repository work (not toy demos): plan, review, change, verify.

The architecture is the point:

- a **vendored kernel** (pi-agent lineage) that stays small, explicit, and interface-agnostic
- a **product runtime** that turns raw agent capability into a controllable user experience

Genesis is inspired by the best of Claude Code’s product layer, but it is not a code clone. The goal is a maintainable system with sharper boundaries and stronger governance.
The exact package layout is intentionally documented in the technical plan rather than overloaded into the project homepage.

---
## Why This Architecture Works

Genesis is structured so the kernel can stay clean while the product layer moves fast.

### 1) A Clean, Vendored pi-agent Kernel

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

## Documentation

- High-level package docs: `packages/*/README.md`
- ADRs and runbooks: `docs/` (work in progress)
