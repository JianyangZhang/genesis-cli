#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PACKAGES=(
  "@pickle-pee/pi-ai"
  "@pickle-pee/tools"
  "@pickle-pee/config"
  "@pickle-pee/kernel"
  "@pickle-pee/runtime"
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
