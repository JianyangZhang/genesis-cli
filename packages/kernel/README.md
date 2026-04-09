# @pickle-pee/kernel

Vendored Genesis kernel for session lifecycle, provider dispatch, model/auth resolution, and built-in tools.

## Session Contract

`app-runtime` and adapter layers must depend on the exported kernel contract types:

- `KernelSessionContract`
- `KernelSessionSnapshot`
- `KernelCreateSessionOptions`

Contract source: `src/session-contract.ts`.

### Contract Guarantees

- `getSnapshot()` is the canonical way to read session identity and metadata.
- `compact()` is a kernel-owned operation; upper layers do not reimplement compaction semantics.
- `prompt()/followUp()/abort()` define the runtime interaction surface; adapters should not rely on private session internals.

### Integration Rule

- `app-runtime` treats kernel session as a typed contract and does not infer capabilities from ad-hoc object shapes.
- Any contract extension must be added in `src/session-contract.ts` and exported via `src/index.ts` before runtime consumption.
