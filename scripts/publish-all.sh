#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PACKAGES=(
  "@pickle-pee/pi-ai"
  "@pickle-pee/tools"
  "@pickle-pee/config"
  "@pickle-pee/kernel"
  "@pickle-pee/runtime"
  "@pickle-pee/tui-core"
  "@pickle-pee/ui"
  "@pickle-pee/extensions"
  "@pickle-pee/evaluation"
  "@pickle-pee/genesis-cli"
)

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-all.sh <command>

Commands:
  check    Run pre-publish checks and dry-run packs for all published packages
  publish  Publish all packages in dependency order
  verify   Install the published CLI globally and verify version commands
  all      Run check, publish, and verify in sequence
EOF
}

require_clean_worktree() {
  if [[ -n "$(git -C "$ROOT_DIR" status --short)" ]]; then
    echo "Working tree is not clean. Commit or stash changes before publishing." >&2
    exit 1
  fi
}

require_npm_login() {
  npm whoami >/dev/null
}

smoke_check_runtime_adapter() {
  local adapter_path="$1"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  (
    cd "$tmp_dir"
    node --input-type=module -e '
      import { pathToFileURL } from "node:url";

      const adapterPath = process.argv[1];
      const adapterModule = await import(pathToFileURL(adapterPath).href);
      const sdk = await adapterModule.loadPiMonoSdk();

      if (typeof sdk.createAgentSession !== "function") {
        throw new Error("Resolved kernel sdk is missing createAgentSession()");
      }

      const result = await sdk.createAgentSession({
        cwd: process.cwd(),
        model: {
          id: "smoke-model",
          name: "smoke-model",
          api: "openai-completions",
          provider: "smoke",
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
          headers: {},
          compat: {},
        },
      });

      result.session.dispose();

      console.log(`runtime adapter smoke passed: ${adapterPath}`);
    ' "$adapter_path"
  )
}

resolve_installed_runtime_adapter() {
  local global_root
  global_root="$(npm root -g)"

  local candidates=(
    "$global_root/@pickle-pee/runtime/dist/adapters/pi-mono-session-adapter.js"
    "$global_root/@pickle-pee/genesis-cli/node_modules/@pickle-pee/runtime/dist/adapters/pi-mono-session-adapter.js"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "Unable to locate the installed runtime adapter under $global_root" >&2
  exit 1
}

package_version() {
  local package_name="$1"
  npm pkg get version -w "$package_name" | tr -d '"'
}

assert_version_not_published() {
  local package_name="$1"
  local package_version_value
  package_version_value="$(package_version "$package_name")"

  if npm view "${package_name}@${package_version_value}" version >/dev/null 2>&1; then
    echo "Version already published: ${package_name}@${package_version_value}" >&2
    exit 1
  fi
}

run_check() {
  require_npm_login
  require_clean_worktree

  (
    cd "$ROOT_DIR"
    npm run check
    npm run build
  )

  smoke_check_runtime_adapter "$ROOT_DIR/packages/app-runtime/dist/adapters/pi-mono-session-adapter.js"

  for package_name in "${PACKAGES[@]}"; do
    (
      cd "$ROOT_DIR"
      npm pack --dry-run -w "$package_name" >/dev/null
    )
  done
}

run_publish() {
  require_npm_login
  require_clean_worktree

  for package_name in "${PACKAGES[@]}"; do
    assert_version_not_published "$package_name"
  done

  for package_name in "${PACKAGES[@]}"; do
    (
      cd "$ROOT_DIR"
      npm publish --access public -w "$package_name"
    )
  done
}

run_verify() {
  require_npm_login

  (
    cd "$ROOT_DIR"
    npm install -g @pickle-pee/genesis-cli
  )

  smoke_check_runtime_adapter "$(resolve_installed_runtime_adapter)"
  genesis -v
  genesis --version
}

main() {
  local command="${1:-}"

  case "$command" in
    check)
      run_check
      ;;
    publish)
      run_publish
      ;;
    verify)
      run_verify
      ;;
    all)
      run_check
      run_publish
      run_verify
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
