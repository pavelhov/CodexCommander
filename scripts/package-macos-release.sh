#!/usr/bin/env bash
set -euo pipefail

# Wraps OpenCodex.app for distribution.
#
# Every step is an assertion rather than a hope: structurally valid ad-hoc archives may be
# retained as CI/test artifacts, but only a Developer ID-signed, Gatekeeper-accepted, stapled
# archive may be marked ready for public distribution.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
output_dir="${RELEASE_OUTPUT_DIR:-$repo_root/dist/release}"
universal="${UNIVERSAL:-1}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package:macos requires macOS." >&2
  exit 1
fi

package_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ ! "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid package version for the macOS release asset: '$package_version'" >&2
  exit 1
fi

# A release dispatched for one version must never package a different one.
if [[ -n "${RELEASE_VERSION:-}" && "$RELEASE_VERSION" != "$package_version" ]]; then
  echo "package.json ($package_version) does not match the requested release (${RELEASE_VERSION})" >&2
  exit 1
fi

if [[ "$universal" != "0" && "$universal" != "1" ]]; then
  echo "UNIVERSAL must be 0 or 1." >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

build_root="$(mktemp -d "${TMPDIR:-/tmp}/OpenCodex-release.XXXXXX")"
cleanup() { rm -rf "$build_root"; }
trap cleanup EXIT

OUTPUT_DIR="$build_root" UNIVERSAL="$universal" CONFIGURATION=release \
  bash "$script_dir/build-macos-app.sh" >&2

app_bundle="$build_root/OpenCodex.app"
executable="$app_bundle/Contents/MacOS/OpenCodexMenuBar"
runtime_root="$app_bundle/Contents/Resources/runtime"

for required_path in \
  "$runtime_root/package.json" \
  "$runtime_root/src/cli/index.ts" \
  "$runtime_root/gui/dist/index.html"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Packaged app is missing required runtime resource: $required_path" >&2
    exit 1
  fi
done
if [[ ! -e "$runtime_root/node_modules/bun/bin/bun.exe" \
   && ! -e "$runtime_root/node_modules/bun/bin/bun" ]]; then
  echo "Packaged app is missing the bundled Bun runtime." >&2
  exit 1
fi
runtime_bun="$runtime_root/node_modules/bun/bin/bun.exe"
[[ -e "$runtime_bun" ]] || runtime_bun="$runtime_root/node_modules/bun/bin/bun"
runtime_architectures="$(lipo -archs "$runtime_bun")"
if [[ "$universal" == "1" ]]; then
  for required_arch in arm64 x86_64; do
    if [[ " $runtime_architectures " != *" $required_arch "* ]]; then
      echo "Universal app is missing $required_arch in bundled Bun (got: $runtime_architectures)" >&2
      exit 1
    fi
  done
fi

codesign --verify --deep --strict --verbose=2 "$app_bundle"

# A public distribution attachment is ready only when a real Developer ID identity,
# Gatekeeper assessment, and stapled notarization ticket all pass. Ad-hoc archives remain
# useful Actions/test artifacts, but are never marked ready for public release attachment.
distribution_ready=false
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  signature_detail="$(codesign --display --verbose=4 "$app_bundle" 2>&1 || true)"
  if ! grep -Fq 'Authority=Developer ID Application:' <<< "$signature_detail"; then
    echo "==> Signature is not a Developer ID Application identity; archive is not distribution-ready." >&2
  elif spctl --assess --type execute "$app_bundle" >/dev/null 2>&1; then
    echo "==> Gatekeeper: accepted" >&2
    if xcrun stapler validate "$app_bundle" >/dev/null 2>&1; then
      distribution_ready=true
      echo "==> Stapler: validated" >&2
    else
      echo "==> Stapler: validation failed; archive is not distribution-ready." >&2
    fi
  else
    echo "==> Gatekeeper: rejected for $MACOS_SIGN_IDENTITY; archive is not distribution-ready." >&2
  fi
else
  echo "==> Gatekeeper: rejected (expected for an ad-hoc signature)." >&2
  echo "    Users must right-click > Open on first launch; archive is an Actions/test artifact only." >&2
fi

architectures="$(lipo -archs "$executable")"
if [[ "$universal" == "1" ]]; then
  for required_arch in arm64 x86_64; do
    if [[ " $architectures " != *" $required_arch "* ]]; then
      echo "Universal build is missing $required_arch (got: $architectures)" >&2
      exit 1
    fi
  done
  architecture_label="universal"
else
  architecture_label="${architectures// /-}"
fi

archive_name="OpenCodex-${package_version}-macos-${architecture_label}.zip"
checksum_name="${archive_name}.sha256"
archive_path="$output_dir/$archive_name"
checksum_path="$output_dir/$checksum_name"
rm -f "$archive_path" "$checksum_path"

# ditto rather than zip: it preserves extended attributes and symlinks, so the unpacked
# bundle stays launchable. Plain zip corrupts the code signature.
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$archive_path"

# An archive that exists but does not contain the executable is the failure mode this
# assertion exists to catch.
archive_entries="$(unzip -Z1 "$archive_path")"
if ! grep -Fqx 'OpenCodex.app/Contents/MacOS/OpenCodexMenuBar' <<< "$archive_entries"; then
  echo "Packaged archive does not contain the OpenCodex executable." >&2
  echo "Archive entries were:" >&2
  printf '%s\n' "$archive_entries" | head -20 >&2
  exit 1
fi
for required_entry in \
  'OpenCodex.app/Contents/Resources/runtime/package.json' \
  'OpenCodex.app/Contents/Resources/runtime/src/cli/index.ts' \
  'OpenCodex.app/Contents/Resources/runtime/gui/dist/index.html'; do
  if ! grep -Fqx "$required_entry" <<< "$archive_entries"; then
    echo "Packaged archive does not contain required runtime resource: $required_entry" >&2
    exit 1
  fi
done

(
  cd "$output_dir"
  shasum -a 256 "$archive_name" > "$checksum_name"
)

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "archive_name=$archive_name"
    echo "checksum_name=$checksum_name"
    echo "distribution_ready=$distribution_ready"
  } >> "$GITHUB_OUTPUT"
fi

echo "distribution_ready=$distribution_ready"
echo "$archive_path"
echo "$checksum_path"
