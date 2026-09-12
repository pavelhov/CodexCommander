#!/usr/bin/env bash
set -euo pipefail
# Local asset preparation only. No upload, publishing, Keychain mutation, or key generation.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bun "$script_dir/macos-appcast.ts" "$@"
