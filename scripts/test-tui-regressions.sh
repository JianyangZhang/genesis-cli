#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

npm run build
node ./node_modules/vitest/vitest.mjs run \
  packages/app-cli/src/test/mode-dispatch.test.ts \
  packages/app-cli/src/test/terminal-display-width.test.ts \
  packages/app-ui/src/test/layout-accumulator.test.ts \
  packages/app-ui/src/test/tui-renderer.test.ts \
  packages/app-cli/src/test/input-loop-raw.test.ts \
  packages/app-cli/src/test/tty-session.test.ts
