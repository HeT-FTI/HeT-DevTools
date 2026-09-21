#!/usr/bin/env bash
# Local MegaLinter runner for this template.
# Mirrors the `megalinter` job of .github/workflows/security-linters.yml:
# same config file (.github/misc/.mega-linter.yml), same full `all` image, and
# the SAME MegaLinter version as the pinned CI action.
#
# Usage:
#   .github/misc/run-megalinter.sh              # lint the whole codebase
#   .github/misc/run-megalinter.sh --fix        # lint and auto-apply fixes
#   .github/misc/run-megalinter.sh path/to/file # lint selected files only
#
# Prerequisites: Docker (or Podman) + Node.js >= 20.
#   Podman: CONTAINER_ENGINE=podman .github/misc/run-megalinter.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONTAINER_ENGINE="${CONTAINER_ENGINE:-docker}"

# MegaLinter version — MUST match the pinned CI action
# (oxsecurity/megalinter@e08c2b05e3dbc40af4c23f41172ef1e068a7d651 = v8.8.0)
# in .github/workflows/security-linters.yml. Local and CI must lint with the
# same image version so results are identical.
MEGALINTER_VERSION="v8.8.0"

for cmd in "$CONTAINER_ENGINE" npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found." >&2
    echo "       MegaLinter Runner needs a container engine (docker/podman) and Node.js >= 20." >&2
    exit 1
  fi
done

FIX_FLAG=""
FILES=()
for arg in "$@"; do
  case "$arg" in
    --fix) FIX_FLAG="--fix" ;;
    -h|--help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) FILES+=("$arg") ;;
  esac
done

echo "▶ Running MegaLinter locally (config: .github/misc/.mega-linter.yml, engine: $CONTAINER_ENGINE, version: $MEGALINTER_VERSION)"

exec npx --yes mega-linter-runner \
  --container-engine "$CONTAINER_ENGINE" \
  --release "$MEGALINTER_VERSION" \
  -e "MEGALINTER_CONFIG=.github/misc/.mega-linter.yml" \
  $FIX_FLAG \
  "${FILES[@]}"
